import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { assertTurn } from './capabilities.js'
import { applyPrecision, type ContextManifestBuilder, type ContextUsage } from './context-manifest.js'
import { compactSessionEvents, conversationTokensFromEvents } from './session-context.js'
import { credentialEnvFor, requireSecret } from './credential.js'
import { fail, RunFailure } from './errors.js'
import type { EventLog, FinishedData } from './events.js'
import type { HomeManager } from './home.js'
import { assertRunId, assertSessionId } from './ids.js'
import type { ProviderManifest } from './provider-manifest.js'
import type { Provider, StartResult } from './provider.js'
import type { Queue } from './queue.js'
import type { Redactor } from './redact.js'
import type { Registry } from './registry.js'
import type { SessionRegistry } from './session-registry.js'
import { createSessionStore, readEvents, sessionFileForHome } from './session-store.js'
import type { Family, RunRecord, RunRequest, RunStatus, Session } from './types.js'
import { validateRunRequest } from './validate.js'
import type { WorkspaceResolver } from './workspace.js'

export const TERMINAL_STATUSES: ReadonlySet<RunStatus> = new Set(['SUCCEEDED', 'FAILED', 'CANCELLED'])

export interface DispatcherDeps {
  registry: Registry
  /** Must be initialised (`sessions.init()`) before `recover()`. */
  sessions: SessionRegistry
  events: EventLog
  /** Must be created with `onStart: (run) => dispatcher.onStart(run)`. */
  queue: Queue
  workspaces: WorkspaceResolver
  homes: HomeManager
  providers: Map<Family, Provider>
  redactor: Redactor
  /** When set, emits `context/usage` after `run/started` using the same function as preview. */
  buildContextManifest?: ContextManifestBuilder
  /** Loaded manifests. When set, a turn that needs an undeclared capability is `unsupported`. */
  manifests?: Map<string, ProviderManifest>
  /** Default 3600. */
  defaultTimeoutSec?: number
  clock?: () => Date
}

export interface Dispatcher {
  /**
   * `req.sessionId` names an existing session of `product` (BUSY → `session_busy`, CLOSED → `session_closed`,
   * foreign/unknown → `not_found`); absent ⇒ an ephemeral session is created for this single turn.
   */
  submit(product: string, req: RunRequest): Promise<RunRecord>
  /** Queue callback: runs one turn end to end and always releases the slot. */
  onStart(run: RunRecord): Promise<void>
  /** Resolves with the terminal record (RUNNING runs: after the provider observed the abort). */
  cancel(runId: string): Promise<RunRecord>
  /** Cancels the session's live turn (if any), removes its `home/` and marks it CLOSED. Idempotent for CLOSED sessions. */
  closeSession(sessionId: string): Promise<Session>
  /**
   * Boot (after `registry.init()` and `sessions.init()`): repairs terminal records missing `run/finished`, re-queues or
   * fails QUEUED runs (taking their sessions BUSY again), then closes ephemeral sessions left without a live run.
   */
  recover(): Promise<void>
  get(runId: string): RunRecord | undefined
  list(filter?: { product?: string; status?: RunStatus }): RunRecord[]
}

/** Run events that make up the conversation and therefore belong in the session log (design: fluxo de um turno, passo 5). */
const CONVERSATION_EVENTS: ReadonlySet<string> = new Set(['assistant/message', 'tool/call', 'tool/result', 'compaction'])

/** Per-run state that must never touch the disk. */
interface Live {
  secret?: string
  timeoutSec?: number
  mcpServers?: RunRequest['mcpServers']
  inheritProjectMcp?: boolean
  controller: AbortController
  finished?: Promise<RunRecord>
  /** Next `seq` for the session log; only touched from this run's serialized event emits. */
  sessionSeq?: { next: number }
  /** `context/usage` measured at turn start, promoted to `exact` in `settleSession` when the provider reports tokens. */
  contextUsage?: ContextUsage
}

export function createDispatcher(deps: DispatcherDeps): Dispatcher {
  const { registry, sessions, events, queue, workspaces, homes, providers, redactor } = deps
  const defaultTimeoutSec = deps.defaultTimeoutSec ?? 3600
  const now = () => (deps.clock ?? (() => new Date()))().toISOString()
  const live = new Map<string, Live>()
  /** Many runs share one product token; the redactor may only forget it when the last of them is gone. */
  const secretUses = new Map<string, number>()

  function track(
    runId: string,
    secret: string | undefined,
    timeoutSec: number | undefined,
    mcpServers?: RunRequest['mcpServers'],
    inheritProjectMcp?: boolean,
  ): Live {
    if (secret) {
      secretUses.set(secret, (secretUses.get(secret) ?? 0) + 1)
      redactor.add(secret)
    }
    const state: Live = { secret, timeoutSec, mcpServers, inheritProjectMcp, controller: new AbortController() }
    live.set(runId, state)
    return state
  }

  function forget(runId: string): void {
    const secret = live.get(runId)?.secret
    live.delete(runId)
    if (!secret) return
    const uses = (secretUses.get(secret) ?? 1) - 1
    if (uses > 0) secretUses.set(secret, uses)
    else {
      secretUses.delete(secret)
      redactor.remove(secret)
    }
  }

  /**
   * Persists the terminal status first, then emits `run/finished`, so a client that sees the event and
   * fetches the snapshot never reads RUNNING. `lastSeq` is the seq the event will get: nothing else emits
   * for this run any more and emits are serialized per run. A crash in between is repaired by `recover()`.
   */
  async function finish(runId: string, rawData: FinishedData): Promise<RunRecord> {
    // Provider-derived strings (sessionRef, error.message) are redacted before they touch meta.json; the event log redacts on emit.
    const data = redactor.redact(rawData)
    const lastSeq = (await events.lastSeq(runId)) + 1
    const record = await registry.update(runId, {
      status: data.status,
      finishedAt: now(),
      lastSeq,
      ...(data.sessionRef !== undefined && { sessionRef: data.sessionRef }),
      ...(data.error !== undefined && { error: data.error as RunRecord['error'] }),
      ...(data.usage !== undefined && { usage: data.usage as RunRecord['usage'] }),
    })
    await events.emit(runId, 'run/finished', data)
    return record
  }

  /** The session this turn runs in, already marked BUSY (`sessionId` given) or freshly created as ephemeral. */
  async function claimSession(product: string, req: RunRequest, workspaceDir: string): Promise<Session> {
    if (req.sessionId !== undefined) {
      const existing = sessions.get(req.sessionId)
      // A foreign session must look exactly like an unknown one.
      if (!existing || existing.product !== product) throw fail('not_found', `session ${req.sessionId} not found`)
      return sessions.markBusy(existing.id, req.runId)
    }
    const created = await sessions.create(
      redactor.redact({
        id: randomUUID(),
        product,
        family: req.family,
        workspaceDir,
        policy: { window: 'ephemeral' as const },
        ...(req.modelId !== undefined && { modelId: req.modelId }),
        ...(req.mode !== undefined && { mode: req.mode }),
        // EPH-02: a legacy `sessionRef` is the product's best-effort resume hint for this one-turn session.
        ...(req.sessionRef !== undefined && { providerSessionRef: req.sessionRef }),
      }),
    )
    return sessions.markBusy(created.id, req.runId)
  }

  /** Undoes `claimSession` when the run record could not be created: the turn never existed. */
  async function unclaimSession(session: Session): Promise<void> {
    if (session.policy.window === 'ephemeral') await closeSession(session.id)
    else await sessions.markIdle(session.id, {})
  }

  /** Appends one conversation event to `sessions/{id}/session.jsonl`, numbered per run so parallel emits stay ordered. */
  function appendSessionEvent(sessionId: string, state: Live, type: string, data: unknown): void {
    const store = createSessionStore(sessionFileForHome(homes.path(sessionId)))
    const seq = (state.sessionSeq ??= { next: store.read().length + 1 }).next++
    store.append({ seq, type, at: now(), data })
  }

  /** Makes sure the session HOME exists. A persistent session that lost it has nothing for the CLI to resume: say so. */
  async function prepareHome(run: RunRecord, session: Session): Promise<string> {
    const existed = existsSync(homes.path(session.id))
    const homeDir = await homes.create(session.id)
    if (!existed && session.policy.window === 'persistent' && session.providerSessionRef !== undefined) {
      await events.emit(run.id, 'log/line', {
        level: 'warn',
        text: `session ${session.id}: home directory was missing and has been recreated; this turn continues without resume`,
      })
    }
    return homeDir
  }

  /**
   * Session bookkeeping after `run/finished`: keep the provider ref (logging a change), release the session, close
   * it when ephemeral. The run is already terminal, so a session closed concurrently is a race to accept, not an error.
   */
  async function settleSession(record: RunRecord, outcome: FinishedData): Promise<void> {
    if (record.sessionId === undefined) return
    const before = sessions.get(record.sessionId)
    if (!before || before.status === 'CLOSED') return
    // `finish` stored the provider's ref redacted; `record.sessionRef` is otherwise the ref the run was submitted with.
    const returnedRef = outcome.sessionRef !== undefined ? record.sessionRef : undefined
    try {
      const ref = returnedRef ?? before.providerSessionRef
      const measured = live.get(record.id)?.contextUsage
      const context = measured ? applyPrecision(measured, record.usage?.inputTokens) : undefined
      await sessions.markIdle(record.sessionId, {
        ...(ref !== undefined && { providerSessionRef: ref }),
        ...(record.usage !== undefined && { usage: record.usage }),
        ...(context !== undefined && { context }),
      })
      if (returnedRef !== undefined && before.providerSessionRef !== undefined && returnedRef !== before.providerSessionRef) {
        const state = live.get(record.id) ?? { controller: new AbortController() }
        appendSessionEvent(record.sessionId, state, 'session/ref-changed', { from: before.providerSessionRef, to: returnedRef })
      }
      if (before.policy.window === 'ephemeral') await closeSession(record.sessionId)
    } catch (err) {
      if (err instanceof RunFailure && (err.error.code === 'session_closed' || err.error.code === 'not_found')) return
      throw err
    }
  }

  async function finishAndSettle(runId: string, rawData: FinishedData): Promise<RunRecord> {
    const record = await finish(runId, rawData)
    await settleSession(record, rawData)
    return record
  }

  async function cancel(runId: string): Promise<RunRecord> {
    assertRunId(runId)
    const record = registry.get(runId)
    if (!record) throw fail('not_found', `run ${runId} not found`)
    if (TERMINAL_STATUSES.has(record.status)) throw fail('validation', 'run already finished')
    if (queue.remove(runId)) {
      forget(runId)
      return finishAndSettle(runId, { status: 'CANCELLED', error: { code: 'cancelled', message: 'run cancelled while queued' } })
    }
    const state = live.get(runId)
    if (!state) throw fail('validation', 'run already finished')
    state.controller.abort()
    // `finished` is unset only in the microtask between the queue taking the slot and `onStart`; the abort is still honoured.
    return state.finished ?? record
  }

  async function closeSession(sessionId: string): Promise<Session> {
    assertSessionId(sessionId)
    const session = sessions.get(sessionId)
    if (!session) throw fail('not_found', `session ${sessionId} not found`)
    if (session.status !== 'CLOSED') {
      for (const run of registry.list()) {
        if (run.sessionId !== sessionId || TERMINAL_STATUSES.has(run.status)) continue
        // The turn may finish on its own in between; then there is nothing left to cancel.
        await cancel(run.id).catch((err: unknown) => {
          if (!(err instanceof RunFailure && err.error.code === 'validation')) throw err
        })
      }
    }
    await homes.dispose(sessionId)
    return sessions.close(sessionId)
  }

  /**
   * Boot: a QUEUED run takes its session BUSY again before it is re-enqueued. A record from before sessions existed
   * (no `sessionId`) is adopted into a fresh ephemeral session so it still gets a HOME; a run whose session was
   * closed while it waited is failed instead. Returns the record to enqueue, or undefined when it was failed.
   */
  async function reclaimSession(record: RunRecord): Promise<RunRecord | undefined> {
    let run = record
    let session = run.sessionId !== undefined ? sessions.get(run.sessionId) : undefined
    if (!session) {
      session = await sessions.create({
        id: randomUUID(),
        product: run.product,
        family: run.family,
        workspaceDir: run.workspaceDir,
        policy: { window: 'ephemeral' },
        ...(run.modelId !== undefined && { modelId: run.modelId }),
        ...(run.mode !== undefined && { mode: run.mode }),
        ...(run.sessionRef !== undefined && { providerSessionRef: run.sessionRef }),
      })
      run = await registry.update(run.id, { sessionId: session.id })
    }
    try {
      await sessions.markBusy(session.id, run.id)
      return run
    } catch (err) {
      if (!(err instanceof RunFailure && (err.error.code === 'session_closed' || err.error.code === 'session_busy'))) throw err
      await finish(run.id, { status: 'FAILED', error: { code: err.error.code, message: `queued run lost its session on restart: ${err.error.message}` } })
      return undefined
    }
  }

  const finishedDataOf = (r: RunRecord): FinishedData => ({
    status: r.status as FinishedData['status'],
    ...(r.sessionRef !== undefined && { sessionRef: r.sessionRef }),
    ...(r.error !== undefined && { error: r.error }),
    ...(r.usage !== undefined && { usage: r.usage as Record<string, unknown> }),
  })

  function outcome(result: StartResult, timeout: AbortSignal, cancel: AbortSignal): FinishedData {
    if (timeout.aborted) return { status: 'FAILED', error: { code: 'timeout', message: 'run exceeded timeoutSec' } }
    if (cancel.aborted) return { status: 'CANCELLED', error: { code: 'cancelled', message: 'run cancelled by request' } }
    return { status: result.status, sessionRef: result.sessionRef, error: result.error, usage: result.usage as Record<string, unknown> | undefined }
  }

  async function resolveMaxInputTokens(family: Family, modelId: string | undefined, secret: string | undefined): Promise<number | undefined> {
    if (!modelId) return undefined
    const provider = providers.get(family)
    if (!provider?.listModels) return undefined
    try {
      const models = await provider.listModels(secret)
      return models.find((m) => m.id === modelId)?.maxInputTokens
    } catch {
      return undefined
    }
  }

  function sessionLog(sessionId: string) {
    return readEvents(sessionFileForHome(homes.path(sessionId)))
  }

  /** Controllable families only. Native CLIs compact themselves; declaring auto on them is a no-op. */
  async function maybeAutoCompact(run: RunRecord, session: Session, state: Live): Promise<void> {
    const policy = session.policy.compaction
    if (!policy?.auto || deps.manifests?.get(session.family)?.capabilities.compaction !== 'controllable') return
    const window = await resolveMaxInputTokens(run.family, run.modelId, state.secret)
    if (window === undefined) return
    const events = sessionLog(session.id)
    const prior = conversationTokensFromEvents(events)
    const threshold = policy.thresholdRatio ?? 0.8
    if (prior < Math.floor(window * threshold)) return
    const result = compactSessionEvents(events, policy.retainRatio ?? 0.16)
    if (result.dropped === 0) return
    appendSessionEvent(session.id, state, 'compaction', { dropped: result.dropped, retained: result.retained, messages: result.messages })
  }

  async function emitContextUsage(run: RunRecord, state: Live): Promise<void> {
    if (!deps.buildContextManifest) return
    const maxInputTokens = await resolveMaxInputTokens(run.family, run.modelId, state.secret)
    const priorConversationTokens = run.sessionId !== undefined ? conversationTokensFromEvents(sessionLog(run.sessionId)) : 0
    const usage = await deps.buildContextManifest({
      family: run.family,
      mode: run.mode,
      modelId: run.modelId,
      workspacePath: run.workspaceDir,
      prompt: run.prompt,
      attachments: run.attachments,
      mcpServers: state.mcpServers,
      maxInputTokens,
      priorConversationTokens,
    })
    state.contextUsage = usage
    await events.emit(run.id, 'context/usage', usage)
  }

  async function execute(run: RunRecord, state: Live): Promise<RunRecord> {
    let data: FinishedData
    try {
      await registry.update(run.id, { status: 'RUNNING', startedAt: now() })
      await events.emit(run.id, 'run/started', {})
      const provider = providers.get(run.family)
      if (!provider) throw fail('unsupported', `family "${run.family}" is not available`)
      const session = run.sessionId !== undefined ? sessions.get(run.sessionId) : undefined
      if (!session) throw fail('internal', `session ${run.sessionId} of run ${run.id} not found`)
      await maybeAutoCompact(run, session, state)
      await emitContextUsage(run, state)
      // After the measurement, so this turn's prompt is not counted twice. The next turn reads it from the log.
      appendSessionEvent(session.id, state, 'user/message', { role: 'user', content: run.prompt })
      const homeDir = await prepareHome(run, session)
      const timeout = AbortSignal.timeout((state.timeoutSec ?? defaultTimeoutSec) * 1000)
      const result = await provider.start({
        run,
        workspaceDir: run.workspaceDir,
        homeDir,
        credentialSecret: state.secret,
        mcpServers: state.mcpServers,
        inheritProjectMcp: state.inheritProjectMcp,
        signal: AbortSignal.any([state.controller.signal, timeout]),
        // Synchronous call order == seq order (the log serializes per run), so fire-and-forget is safe here.
        emit: (type, eventData) => {
          void events.emit(run.id, type, eventData).catch(() => {})
          if (CONVERSATION_EVENTS.has(type)) appendSessionEvent(session.id, state, type, eventData)
        },
      })
      data = outcome(result, timeout, state.controller.signal)
    } catch (err) {
      const code = err instanceof RunFailure ? err.error.code : 'internal'
      data = { status: 'FAILED', error: { code, message: err instanceof Error ? err.message : String(err) } }
    }
    try {
      // The session HOME is deliberately kept: it is what the next turn of the session resumes from.
      return await finishAndSettle(run.id, data)
    } finally {
      forget(run.id)
      queue.release(run.id)
    }
  }

  /** Before the session is claimed, so a rejected capability never marks it BUSY. */
  function assertRequestedTurn(product: string, req: RunRequest): void {
    const manifests = deps.manifests
    if (!manifests) return
    const manifest = manifests.get(req.family)
    if (!manifest) throw fail('unsupported', `family "${req.family}" has no manifest`)
    let sessionRef = req.sessionRef
    if (sessionRef === undefined && req.sessionId !== undefined) {
      const existing = sessions.get(req.sessionId)
      if (existing && existing.product === product) sessionRef = existing.providerSessionRef
    }
    assertTurn(manifest, { mode: req.mode, attachments: req.attachments, sessionRef, mcpServers: req.mcpServers })
  }

  return {
    async submit(product, req) {
      validateRunRequest(req, providers, product)
      assertRequestedTurn(product, req)
      const workspaceDir = await workspaces.resolve(product, req.workspace.path)
      requireSecret(req.family, req.credential?.secret)
      // Checked before the session is claimed, so a duplicate never marks a session BUSY nor leaves an ephemeral one behind.
      if (registry.get(req.runId)) throw fail('duplicate_run', `run ${req.runId} already exists`)

      track(req.runId, req.credential?.secret, req.timeoutSec, req.mcpServers, req.inheritProjectMcp)
      let session: Session
      try {
        // After `track` for the same reason as the record below: a session field that repeats the credential is redacted.
        session = await claimSession(product, req, workspaceDir)
      } catch (err) {
        forget(req.runId)
        throw err
      }
      // Legacy field the providers read for `--resume`: an explicit override wins over the ref stored on the session.
      const sessionRef = req.sessionRef ?? session.providerSessionRef
      let record: RunRecord
      try {
        // Redacted AFTER `track` registered the secret: a prompt/meta that repeats the credential never reaches meta.json.
        record = await registry.create(
          redactor.redact({
            id: req.runId,
            product,
            family: req.family,
            workspaceDir,
            prompt: req.prompt,
            sessionId: session.id,
            ...(req.modelId !== undefined && { modelId: req.modelId }),
            ...(req.mode !== undefined && { mode: req.mode }),
            ...(req.attachments !== undefined && { attachments: req.attachments }),
            ...(sessionRef !== undefined && { sessionRef }),
            ...(req.meta !== undefined && { meta: req.meta }),
          }),
        )
      } catch (err) {
        forget(req.runId)
        await unclaimSession(session).catch(() => {})
        throw err
      }
      // Both calls are synchronous here, so `run/queued` is serialized before the `run/started` that `onStart` emits later.
      const position = queue.enqueue(record)
      await events.emit(record.id, 'run/queued', { position })
      return registry.get(record.id) ?? record
    },

    async onStart(run) {
      const state = live.get(run.id) ?? track(run.id, undefined, undefined)
      state.finished = execute(run, state)
      await state.finished
    },

    cancel,

    closeSession,

    async recover() {
      // Terminal records without their `run/finished` on disk: RUNNING→FAILED flips done by `registry.init()`
      // and crashes between `registry.update` and `events.emit` inside `finish`. Restores `lastSeq == finished seq`.
      for (const record of registry.list()) {
        if (!TERMINAL_STATUSES.has(record.status)) continue
        const log = await events.read(record.id)
        if (log.at(-1)?.type === 'run/finished') continue
        const ev = await events.emit(record.id, 'run/finished', finishedDataOf(record))
        await registry.update(record.id, { lastSeq: ev.seq })
      }
      for (const record of registry.list({ status: 'QUEUED' })) {
        if (credentialEnvFor(record.family) !== undefined) {
          await finish(record.id, { status: 'FAILED', error: { code: 'interrupted', message: 'queued run lost credential on restart' } })
          continue
        }
        const run = await reclaimSession(record)
        if (!run) continue
        track(run.id, undefined, undefined)
        queue.enqueue(run)
      }
      // An ephemeral session lives exactly as long as its one run; whatever the restart left without one goes now.
      const withLiveRun = new Set(registry.list().filter((r) => !TERMINAL_STATUSES.has(r.status)).map((r) => r.sessionId))
      for (const session of sessions.list()) {
        if (session.status === 'CLOSED' || session.policy.window !== 'ephemeral' || withLiveRun.has(session.id)) continue
        await closeSession(session.id)
      }
    },

    get: (runId) => registry.get(runId),
    list: (filter) => registry.list(filter),
  }
}
