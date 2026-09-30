import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, test } from 'node:test'
import { buildContextManifest } from '../context-manifest.js'
import { createDispatcher, type Dispatcher } from '../dispatcher.js'
import { RunFailure } from '../errors.js'
import { createEventLog, type EventLog } from '../events.js'
import { createHomeManager } from '../home.js'
import type { Provider, StartInput, StartResult } from '../provider.js'
import { createQueue } from '../queue.js'
import { createRedactor } from '../redact.js'
import { createRegistry, type Registry } from '../registry.js'
import { createSessionRegistry, type SessionRegistry } from '../session-registry.js'
import { readEvents } from '../session-store.js'
import type { CreateSessionInput, Family, RunRequest, Session } from '../types.js'
import { createWorkspaceResolver } from '../workspace.js'

const tmpDirs: string[] = []
afterEach(() => {
  for (const dir of tmpDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})
const tmp = (prefix: string) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), prefix))
  tmpDirs.push(dir)
  return dir
}

/** What the provider saw at `start`, so tests can check the HOME and the resume ref handed to it. */
interface Seen {
  runId: string
  homeDir: string
  homeExisted: boolean
  sessionRef: string | undefined
}

/** Emits `system/init` carrying the secret it received (so redaction is observable); `hang` waits for abort. */
function stubProvider(family: Family, seen: Seen[] = []): Provider {
  return {
    capabilities: () => ({ family, streaming: true, resume: false, models: 'none', permissions: [] }),
    health: async () => ({ available: true }),
    async start({ run, signal, emit, credentialSecret, homeDir }: StartInput): Promise<StartResult> {
      seen.push({ runId: run.id, homeDir, homeExisted: existsSync(homeDir), sessionRef: run.sessionRef })
      emit('system/init', { sessionRef: `s-${run.id}`, echo: `secret=${credentialSecret ?? 'none'}` })
      if (run.prompt === 'throw') throw new Error('boom')
      if (run.prompt === 'hang') {
        await new Promise<void>((r) => (signal.aborted ? r() : signal.addEventListener('abort', () => r(), { once: true })))
        return { status: 'CANCELLED' }
      }
      emit('assistant/message', { text: 'done' })
      if (run.prompt === 'no-usage') return { status: 'SUCCEEDED', sessionRef: `s-${run.id}` }
      return { status: 'SUCCEEDED', sessionRef: `s-${run.id}`, usage: { inputTokens: 1, outputTokens: 2 } }
    },
  }
}

interface Harness {
  dispatcher: Dispatcher
  registry: Registry
  sessions: SessionRegistry
  events: EventLog
  dataRoot: string
  ws: string
  seen: Seen[]
  /** `registry.init()` + `sessions.init()`, in the order `composeApp` uses; returns the run ids the registry recovered. */
  boot(): Promise<string[]>
}

function harness(opts: { families?: Family[]; dataRoot?: string; ws?: string; maxConcurrent?: number; defaultTimeoutSec?: number; manifest?: boolean } = {}): Harness {
  const dataRoot = opts.dataRoot ?? tmp('disp-data-')
  const ws = opts.ws ?? tmp('disp-ws-')
  const redactor = createRedactor()
  const registry = createRegistry({ dataRoot })
  const sessions = createSessionRegistry({ dataRoot })
  const events = createEventLog({ dataRoot, redactor })
  const seen: Seen[] = []
  const providers = new Map<Family, Provider>((opts.families ?? ['fake', 'cursor']).map((f) => [f, stubProvider(f, seen)]))
  const queue = createQueue({ maxConcurrent: opts.maxConcurrent ?? 4, maxConcurrentPerProduct: 4, onStart: (run) => dispatcher.onStart(run) })
  const dispatcher = createDispatcher({
    registry,
    sessions,
    events,
    queue,
    workspaces: createWorkspaceResolver(new Map([['aw', ws]])),
    homes: createHomeManager({ dataRoot }),
    providers,
    redactor,
    defaultTimeoutSec: opts.defaultTimeoutSec,
    ...(opts.manifest
      ? {
          buildContextManifest: (input) =>
            buildContextManifest({
              prompt: input.prompt,
              priorConversationTokens: input.priorConversationTokens,
              maxInputTokens: input.maxInputTokens,
            }),
        }
      : {}),
  })
  return {
    dispatcher,
    registry,
    sessions,
    events,
    dataRoot,
    ws,
    seen,
    boot: async () => {
      const { recovered } = await registry.init()
      await sessions.init()
      return recovered
    },
  }
}

const req = (runId: string, over: Partial<RunRequest> = {}): RunRequest => ({ runId, family: 'fake', prompt: 'hi', workspace: { product: 'aw', path: '.' }, ...over })

const sessionDir = (h: Harness, id: string) => path.join(h.dataRoot, 'sessions', id)
const homeOf = (h: Harness, id: string) => path.join(sessionDir(h, id), 'home')
const readSessionMeta = (h: Harness, id: string): Session => JSON.parse(readFileSync(path.join(sessionDir(h, id), 'meta.json'), 'utf8')) as Session

/** Session bookkeeping happens right after `run/finished`; poll until the session reaches `status`. */
async function untilSession(h: Harness, id: string, status: Session['status'], timeoutMs = 3000): Promise<Session> {
  const t0 = Date.now()
  for (;;) {
    const s = h.sessions.get(id)
    if (s?.status === status) return s
    if (Date.now() - t0 > timeoutMs) throw new Error(`session ${id} still ${s?.status}`)
    await new Promise((r) => setTimeout(r, 5))
  }
}

const persistent = (h: Harness, id: string, over: Partial<CreateSessionInput> = {}) =>
  h.sessions.create({ id, product: 'aw', family: 'fake', workspaceDir: realpathSync(h.ws), policy: { window: 'persistent' }, ...over })

/** `finish` writes the record first and `run/finished` right after; "done" means both are on disk. */
async function untilTerminal(h: Harness, id: string, timeoutMs = 3000) {
  const t0 = Date.now()
  for (;;) {
    const r = h.registry.get(id)
    if (r && r.status !== 'QUEUED' && r.status !== 'RUNNING' && (await h.events.read(id)).at(-1)?.type === 'run/finished') return r
    if (Date.now() - t0 > timeoutMs) throw new Error(`run ${id} still ${r?.status}`)
    await new Promise((r) => setTimeout(r, 5))
  }
}

test('submit → queued/started/provider events/finished in order; record carries status, sessionRef, usage, lastSeq; secret never persisted', async () => {
  const h = harness()
  await h.boot()
  const record = await h.dispatcher.submit('aw', req('r1', { family: 'cursor', credential: { secret: 'sk-very-secret' }, modelId: 'm1', meta: { cardId: '7' } }))
  assert.ok(record.status === 'QUEUED' || record.status === 'RUNNING')
  assert.ok(!('credential' in record))
  assert.equal(record.workspaceDir, realpathSync(h.ws))
  assert.equal(typeof record.sessionId, 'string', 'every new run belongs to a session (ephemeral when none was given)')

  const done = await untilTerminal(h, 'r1')
  assert.equal(done.status, 'SUCCEEDED')
  assert.equal(done.sessionRef, 's-r1')
  assert.deepEqual(done.usage, { inputTokens: 1, outputTokens: 2 })
  assert.equal(done.modelId, 'm1')
  assert.deepEqual(done.meta, { cardId: '7' })
  assert.ok(done.startedAt && done.finishedAt)

  const evs = await h.events.read('r1')
  assert.deepEqual(evs.map((e) => e.type), ['run/queued', 'run/started', 'system/init', 'assistant/message', 'run/finished'])
  assert.deepEqual(evs[0].data, { position: 1 })
  assert.equal(done.lastSeq, evs.at(-1)!.seq)
  assert.deepEqual(evs.at(-1)!.data, { status: 'SUCCEEDED', sessionRef: 's-r1', usage: { inputTokens: 1, outputTokens: 2 } })
  assert.equal((evs[2].data as { echo: string }).echo, 'secret=***', 'provider output is redacted before it hits the log')
  const raw = JSON.stringify({ evs, done })
  assert.ok(!raw.includes('sk-very-secret'))
})

test('two runs sharing one secret: redaction stays active for the second after the first finished (refcount)', async () => {
  const h = harness({ maxConcurrent: 1 })
  await h.boot()
  await h.dispatcher.submit('aw', req('a', { family: 'cursor', credential: { secret: 'shared-token-1' } }))
  await h.dispatcher.submit('aw', req('b', { family: 'cursor', credential: { secret: 'shared-token-1' } }))
  await untilTerminal(h, 'a')
  await untilTerminal(h, 'b')
  const b = await h.events.read('b')
  assert.equal((b.find((e) => e.type === 'system/init')!.data as { echo: string }).echo, 'secret=***')
})

test('validation: unsupported family, workspace.product ≠ auth product, missing prompt, bad runId, out-of-root path, credential_missing, duplicate_run', async () => {
  const h = harness()
  await h.boot()
  const code = async (p: Promise<unknown>) => p.then(() => 'ok', (e: unknown) => (e instanceof RunFailure ? e.error.code : 'other'))
  assert.equal(await code(h.dispatcher.submit('aw', req('x', { family: 'claude' }))), 'unsupported')
  assert.equal(await code(h.dispatcher.submit('aw', req('x', { workspace: { product: 'vector', path: '.' } }))), 'validation')
  assert.equal(await code(h.dispatcher.submit('aw', req('x', { prompt: '  ' }))), 'validation')
  assert.equal(await code(h.dispatcher.submit('aw', req('../x'))), 'validation')
  assert.equal(await code(h.dispatcher.submit('aw', req('x', { workspace: { product: 'aw', path: '../' } }))), 'workspace_out_of_root')
  assert.equal(await code(h.dispatcher.submit('aw', req('x', { family: 'cursor' }))), 'credential_missing')
  assert.equal(await code(h.dispatcher.submit('aw', req('x', { mcpServers: [{ name: 'a' }] as never }))), 'validation')
  assert.equal(await code(h.dispatcher.submit('aw', req('x', { timeoutSec: 0 }))), 'validation')
  assert.equal(await code(h.dispatcher.submit('aw', req('dup'))), 'ok')
  assert.equal(await code(h.dispatcher.submit('aw', req('dup'))), 'duplicate_run')
  assert.equal(h.registry.list().length, 1, 'rejected requests leave no record behind')
  assert.equal(h.sessions.list().length, 1, 'rejected requests leave no ephemeral session behind either')
})

test('cancel: queued run → CANCELLED with run/finished; running run → CANCELLED once the provider observed the abort; terminal → validation; unknown → not_found', async () => {
  const h = harness({ maxConcurrent: 1 })
  await h.boot()
  await h.dispatcher.submit('aw', req('run', { prompt: 'hang' }))
  await h.dispatcher.submit('aw', req('waiting'))
  await new Promise((r) => setTimeout(r, 20))
  assert.equal(h.registry.get('run')!.status, 'RUNNING')
  assert.equal(h.registry.get('waiting')!.status, 'QUEUED')

  const cancelledQueued = await h.dispatcher.cancel('waiting')
  assert.equal(cancelledQueued.status, 'CANCELLED')
  assert.deepEqual((await h.events.read('waiting')).map((e) => e.type), ['run/queued', 'run/finished'])
  assert.equal(cancelledQueued.error?.code, 'cancelled')

  const cancelledRunning = await h.dispatcher.cancel('run')
  assert.equal(cancelledRunning.status, 'CANCELLED')
  assert.equal(cancelledRunning.error?.code, 'cancelled')
  assert.equal((await h.events.read('run')).at(-1)!.type, 'run/finished')

  await assert.rejects(h.dispatcher.cancel('run'), (e: unknown) => e instanceof RunFailure && e.error.code === 'validation')
  await assert.rejects(h.dispatcher.cancel('ghost'), (e: unknown) => e instanceof RunFailure && e.error.code === 'not_found')
})

test('timeout: run exceeding timeoutSec → FAILED with error.code=timeout', async () => {
  const h = harness()
  await h.boot()
  await h.dispatcher.submit('aw', req('slow', { prompt: 'hang', timeoutSec: 1 }))
  const t0 = Date.now()
  const done = await untilTerminal(h, 'slow', 3000)
  assert.equal(done.status, 'FAILED')
  assert.equal(done.error?.code, 'timeout')
  assert.ok(Date.now() - t0 < 2500)
  assert.deepEqual((await h.events.read('slow')).at(-1)!.data, { status: 'FAILED', error: { code: 'timeout', message: 'run exceeded timeoutSec' } })
})

test('submit passes mcpServers into Provider.start and never writes them or their headers to meta.json', async () => {
  const seen: Array<StartInput['mcpServers']> = []
  const header = 'mcp-header-token-9f8e7d'
  const dataRoot = tmp('disp-mcp-')
  const ws = tmp('disp-ws-')
  const redactor = createRedactor()
  const registry = createRegistry({ dataRoot })
  const sessions = createSessionRegistry({ dataRoot })
  const events = createEventLog({ dataRoot, redactor })
  const providers = new Map<Family, Provider>([
    [
      'fake',
      {
        capabilities: () => ({ family: 'fake', streaming: true, resume: false, models: 'none', permissions: [] }),
        health: async () => ({ available: true }),
        async start(input: StartInput) {
          seen.push(input.mcpServers)
          input.emit('system/init', { sessionRef: `s-${input.run.id}` })
          return { status: 'SUCCEEDED', sessionRef: `s-${input.run.id}` }
        },
      },
    ],
  ])
  const queue = createQueue({ maxConcurrent: 4, maxConcurrentPerProduct: 4, onStart: (run) => dispatcher.onStart(run) })
  const dispatcher = createDispatcher({
    registry,
    sessions,
    events,
    queue,
    workspaces: createWorkspaceResolver(new Map([['aw', ws]])),
    homes: createHomeManager({ dataRoot }),
    providers,
    redactor,
  })
  await registry.init()
  await sessions.init()
  const servers = [{ name: 'aw', url: 'http://127.0.0.1:9/mcp', headers: { 'X-AW-Run-Token': header } }]
  await dispatcher.submit('aw', req('mcp-run', { mcpServers: servers }))
  const t0 = Date.now()
  for (;;) {
    const r = registry.get('mcp-run')
    if (r && r.status !== 'QUEUED' && r.status !== 'RUNNING') break
    if (Date.now() - t0 > 3000) throw new Error('mcp-run did not finish')
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  assert.deepEqual(seen, [servers])
  const meta = readFileSync(path.join(dataRoot, 'runs', 'mcp-run', 'meta.json'), 'utf8')
  assert.ok(!meta.includes('mcpServers'), meta)
  assert.ok(!meta.includes(header), meta)
  const log = readFileSync(path.join(dataRoot, 'runs', 'mcp-run', 'events.jsonl'), 'utf8')
  assert.ok(!log.includes('mcpServers'), log)
  assert.ok(!log.includes(header), log)
})

test('provider throwing → FAILED internal; the slot is released so the next run starts', async () => {
  const h = harness({ maxConcurrent: 1 })
  await h.boot()
  await h.dispatcher.submit('aw', req('bad', { prompt: 'throw' }))
  await h.dispatcher.submit('aw', req('next'))
  assert.equal((await untilTerminal(h, 'bad')).error?.code, 'internal')
  assert.equal((await untilTerminal(h, 'next')).status, 'SUCCEEDED')
})

test('recover: RUNNING at crash → run/finished interrupted emitted; QUEUED native → FAILED interrupted; QUEUED fake → re-enqueued and completes', async () => {
  const dataRoot = tmp('disp-data-')
  const ws = tmp('disp-ws-')
  // Simulate the state a crash leaves behind: records without their terminal event.
  const first = harness({ dataRoot, ws })
  await first.boot()
  await first.registry.create({ id: 'was-running', product: 'aw', family: 'fake', workspaceDir: ws, prompt: 'x', status: 'RUNNING' })
  await first.events.emit('was-running', 'run/started', {})
  await first.registry.create({ id: 'queued-native', product: 'aw', family: 'cursor', workspaceDir: ws, prompt: 'x' })
  await first.events.emit('queued-native', 'run/queued', { position: 1 })
  await first.registry.create({ id: 'queued-fake', product: 'aw', family: 'fake', workspaceDir: ws, prompt: 'x' })
  await first.events.emit('queued-fake', 'run/queued', { position: 2 })
  // Crash between the terminal registry write and the `run/finished` emit inside `finish`.
  await first.registry.create({ id: 'half-finished', product: 'aw', family: 'fake', workspaceDir: ws, prompt: 'x', status: 'SUCCEEDED', sessionRef: 's', usage: { inputTokens: 3 } })
  await first.events.emit('half-finished', 'run/started', {})
  // Healthy terminal run: must NOT get a second `run/finished`.
  await first.registry.create({ id: 'complete', product: 'aw', family: 'fake', workspaceDir: ws, prompt: 'x', status: 'SUCCEEDED' })
  await first.events.emit('complete', 'run/finished', { status: 'SUCCEEDED' })

  const second = harness({ dataRoot, ws })
  const recovered = await second.boot()
  assert.deepEqual(recovered, ['was-running'])
  await second.dispatcher.recover()

  const half = await second.events.read('half-finished')
  assert.deepEqual(half.map((e) => e.type), ['run/started', 'run/finished'])
  assert.deepEqual(half.at(-1)!.data, { status: 'SUCCEEDED', sessionRef: 's', usage: { inputTokens: 3 } })
  assert.equal((await second.events.read('complete')).length, 1)

  const wasRunning = second.registry.get('was-running')!
  assert.equal(wasRunning.status, 'FAILED')
  assert.equal(wasRunning.error?.code, 'interrupted')
  const wrEvents = await second.events.read('was-running')
  assert.equal(wrEvents.at(-1)!.type, 'run/finished')
  assert.equal(wasRunning.lastSeq, wrEvents.at(-1)!.seq, 'repair restores lastSeq == seq of run/finished')
  assert.deepEqual(wrEvents.at(-1)!.data, { status: 'FAILED', error: wasRunning.error })

  const native = second.registry.get('queued-native')!
  assert.equal(native.status, 'FAILED')
  assert.deepEqual(native.error, { code: 'interrupted', message: 'queued run lost credential on restart' })
  assert.equal((await second.events.read('queued-native')).at(-1)!.type, 'run/finished')

  const fake = await untilTerminal(second, 'queued-fake')
  assert.equal(fake.status, 'SUCCEEDED')
  assert.deepEqual((await second.events.read('queued-fake')).map((e) => e.type), ['run/queued', 'run/started', 'system/init', 'assistant/message', 'run/finished'])
  assert.equal(typeof fake.sessionId, 'string', 'a legacy queued run (meta.json without sessionId) is adopted into an ephemeral session so it still gets a HOME')
  assert.equal((await untilSession(second, fake.sessionId!, 'CLOSED')).policy.window, 'ephemeral')
  assert.equal(wasRunning.sessionId, undefined, 'legacy terminal records are left alone')
})


test('session.context is estimate when the provider omits inputTokens and exact when it reports them; conversation grows on the second turn', async () => {
  const h = harness({ manifest: true })
  await h.boot()
  await persistent(h, 'ctx-1')

  await h.dispatcher.submit('aw', req('c1', { sessionId: 'ctx-1', prompt: 'no-usage' }))
  const estimate = await untilSession(h, 'ctx-1', 'IDLE')
  assert.equal(estimate.context?.precision, 'estimate')
  assert.equal(estimate.context?.usedTokens, Object.values(estimate.context!.categories).reduce((a, b) => a + b, 0))
  const firstConversation = estimate.context!.categories.conversation
  assert.ok(firstConversation > 0)

  await h.dispatcher.submit('aw', req('c2', { sessionId: 'ctx-1', prompt: 'second turn text' }))
  const exact = await untilSession(h, 'ctx-1', 'IDLE')
  assert.equal(exact.context?.precision, 'exact')
  assert.equal(exact.context?.usedTokens, 1)
  assert.ok(exact.context!.categories.conversation > firstConversation)
})

test('two turns with the same sessionId share one HOME under sessions/{id}/home that survives between them; the second turn receives the session providerSessionRef', async () => {
  const h = harness()
  await h.boot()
  await persistent(h, 'chat-1')

  const first = await h.dispatcher.submit('aw', req('t1', { sessionId: 'chat-1' }))
  assert.equal(first.sessionId, 'chat-1')
  assert.equal(first.sessionRef, undefined, 'first turn: nothing to resume yet')
  assert.equal(h.sessions.get('chat-1')!.status, 'BUSY')
  assert.equal(h.sessions.get('chat-1')!.lastTurnId, 't1')
  await untilTerminal(h, 't1')
  const idle = await untilSession(h, 'chat-1', 'IDLE')
  assert.equal(idle.providerSessionRef, 's-t1', 'the ref the provider returned is stored on the session')
  assert.equal(idle.turnCount, 1)
  assert.deepEqual(idle.usage, { inputTokens: 1, outputTokens: 2 })
  assert.ok(existsSync(homeOf(h, 'chat-1')), 'home/ survives the end of the turn')
  assert.ok(!existsSync(path.join(h.dataRoot, 'runs', 't1', 'home')), 'no per-run home any more')

  const second = await h.dispatcher.submit('aw', req('t2', { sessionId: 'chat-1' }))
  assert.equal(second.sessionRef, 's-t1', 'run.sessionRef (legacy field the providers read) = session.providerSessionRef')
  await untilTerminal(h, 't2')
  await untilSession(h, 'chat-1', 'IDLE')

  assert.deepEqual(h.seen.map((s) => s.runId), ['t1', 't2'])
  assert.equal(h.seen[0].homeDir, homeOf(h, 'chat-1'))
  assert.equal(h.seen[1].homeDir, h.seen[0].homeDir, 'same homeDir handed to the provider on both turns')
  assert.equal(h.seen[1].homeExisted, true)
  assert.equal(h.seen[1].sessionRef, 's-t1')
  assert.equal(h.sessions.get('chat-1')!.turnCount, 2)
  assert.equal(h.sessions.get('chat-1')!.providerSessionRef, 's-t2')
  assert.equal(readSessionMeta(h, 'chat-1').providerSessionRef, 's-t2')
})

test('provider returning a new sessionRef replaces providerSessionRef and appends session/ref-changed to sessions/{id}/session.jsonl', async () => {
  const h = harness()
  await h.boot()
  await persistent(h, 'chat-2')
  await h.dispatcher.submit('aw', req('a1', { sessionId: 'chat-2' }))
  await untilTerminal(h, 'a1')
  await untilSession(h, 'chat-2', 'IDLE')
  const logFile = path.join(sessionDir(h, 'chat-2'), 'session.jsonl')
  // The first ref is not a change, but the turn's conversation events are already in the log.
  assert.ok(!readEvents(logFile).some((e) => e.type === 'session/ref-changed'), 'first ref is not a change')

  await h.dispatcher.submit('aw', req('a2', { sessionId: 'chat-2' }))
  await untilTerminal(h, 'a2')
  const s = await untilSession(h, 'chat-2', 'IDLE')
  assert.equal(s.providerSessionRef, 's-a2')
  const changes = readEvents(logFile).filter((e) => e.type === 'session/ref-changed')
  assert.equal(changes.length, 1)
  assert.deepEqual(changes[0].data, { from: 's-a1', to: 's-a2' })
  assert.ok(!Number.isNaN(Date.parse(changes[0].at)))

  // A cancelled turn returns no sessionRef: the stored ref and the log stay as they were.
  await h.dispatcher.submit('aw', req('a3', { sessionId: 'chat-2', prompt: 'hang' }))
  await new Promise((r) => setTimeout(r, 20))
  await h.dispatcher.cancel('a3')
  const after = await untilSession(h, 'chat-2', 'IDLE')
  assert.equal(after.providerSessionRef, 's-a2')
  assert.equal(after.turnCount, 3)
  assert.equal(readEvents(logFile).filter((e) => e.type === 'session/ref-changed').length, 1, 'a cancelled turn adds no ref change')
})

test('no sessionId → ephemeral session: home/ removed after run/finished, sessions/{id}/meta.json and runs/{id}/events.jsonl remain, session CLOSED', async () => {
  const h = harness()
  await h.boot()
  const record = await h.dispatcher.submit('aw', req('eph', { modelId: 'm9', mode: 'plan' }))
  const sid = record.sessionId!
  assert.match(sid, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/, 'ephemeral ids are UUIDs')
  const busy = h.sessions.get(sid)!
  assert.equal(busy.status, 'BUSY')
  assert.deepEqual(busy.policy, { window: 'ephemeral' })
  assert.equal(busy.product, 'aw')
  assert.equal(busy.family, 'fake')
  assert.equal(busy.workspaceDir, realpathSync(h.ws))
  assert.equal(busy.modelId, 'm9')
  assert.equal(busy.mode, 'plan')
  assert.equal(busy.providerSessionRef, undefined)

  await untilTerminal(h, 'eph')
  const closed = await untilSession(h, sid, 'CLOSED')
  assert.ok(closed.closedAt)
  assert.equal(closed.turnCount, 1)
  assert.equal(closed.providerSessionRef, 's-eph')
  assert.equal(h.seen[0].homeDir, homeOf(h, sid))
  assert.ok(!existsSync(homeOf(h, sid)), 'ephemeral home is disposed at close')
  assert.ok(existsSync(path.join(sessionDir(h, sid), 'meta.json')))
  assert.equal(readSessionMeta(h, sid).status, 'CLOSED')
  assert.ok(existsSync(path.join(h.dataRoot, 'runs', 'eph', 'events.jsonl')))
  assert.ok(existsSync(path.join(h.dataRoot, 'runs', 'eph', 'meta.json')))
  assert.equal((await h.events.read('eph')).at(-1)!.type, 'run/finished')
})

test('EPH-02: legacy sessionRef on an ephemeral run seeds providerSessionRef and reaches the provider as run.sessionRef', async () => {
  const h = harness()
  await h.boot()
  const record = await h.dispatcher.submit('aw', req('legacy', { sessionRef: 'old-ref' }))
  assert.equal(record.sessionRef, 'old-ref')
  assert.equal(h.sessions.get(record.sessionId!)!.providerSessionRef, 'old-ref')
  await untilTerminal(h, 'legacy')
  await untilSession(h, record.sessionId!, 'CLOSED')
  assert.equal(h.seen[0].sessionRef, 'old-ref')
  const changes = readEvents(path.join(sessionDir(h, record.sessionId!), 'session.jsonl')).filter((e) => e.type === 'session/ref-changed')
  assert.deepEqual(changes.map((e) => e.data), [{ from: 'old-ref', to: 's-legacy' }])
})

test('home/ deleted by hand between two turns of a persistent session with a providerSessionRef → recreated + log/line warn before the provider starts', async () => {
  const h = harness()
  await h.boot()
  await persistent(h, 'chat-3')
  await h.dispatcher.submit('aw', req('w1', { sessionId: 'chat-3' }))
  await untilTerminal(h, 'w1')
  await untilSession(h, 'chat-3', 'IDLE')
  assert.ok(!(await h.events.read('w1')).some((e) => e.type === 'log/line'), 'first turn of a fresh session is not a missing home')

  rmSync(homeOf(h, 'chat-3'), { recursive: true, force: true })
  await h.dispatcher.submit('aw', req('w2', { sessionId: 'chat-3' }))
  await untilTerminal(h, 'w2')
  await untilSession(h, 'chat-3', 'IDLE')
  assert.equal(h.seen[1].homeExisted, true, 'recreated before provider.start')
  assert.equal(h.seen[1].homeDir, homeOf(h, 'chat-3'))
  const evs = await h.events.read('w2')
  assert.deepEqual(evs.map((e) => e.type), ['run/queued', 'run/started', 'log/line', 'system/init', 'assistant/message', 'run/finished'])
  const warn = evs[2].data as { level: string; text: string }
  assert.equal(warn.level, 'warn')
  assert.match(warn.text, /chat-3/)
  assert.match(warn.text, /home/i)
  assert.match(warn.text, /resume/i)
})

test('submit with sessionId: BUSY → session_busy; CLOSED → session_closed; another product or unknown → not_found; bad id → validation; no run record is left behind', async () => {
  const h = harness({ maxConcurrent: 1 })
  await h.boot()
  const code = async (p: Promise<unknown>) => p.then(() => 'ok', (e: unknown) => (e instanceof RunFailure ? e.error.code : 'other'))
  await persistent(h, 'busy')
  await h.sessions.create({ id: 'foreign', product: 'vector', family: 'fake', workspaceDir: '/x', policy: { window: 'persistent' } })
  await persistent(h, 'gone')
  await h.sessions.close('gone')

  assert.equal(await code(h.dispatcher.submit('aw', req('b1', { sessionId: 'busy', prompt: 'hang' }))), 'ok')
  assert.equal(await code(h.dispatcher.submit('aw', req('b2', { sessionId: 'busy' }))), 'session_busy')
  assert.equal(await code(h.dispatcher.submit('aw', req('b3', { sessionId: 'gone' }))), 'session_closed')
  assert.equal(await code(h.dispatcher.submit('aw', req('b4', { sessionId: 'foreign' }))), 'not_found')
  assert.equal(await code(h.dispatcher.submit('aw', req('b5', { sessionId: 'never' }))), 'not_found')
  assert.equal(await code(h.dispatcher.submit('aw', req('b6', { sessionId: '../x' }))), 'validation')
  assert.deepEqual(h.registry.list().map((r) => r.id), ['b1'])
  assert.equal(h.sessions.get('foreign')!.status, 'IDLE', 'a foreign session is never touched')

  await h.dispatcher.cancel('b1')
  await untilSession(h, 'busy', 'IDLE')
  assert.equal(await code(h.dispatcher.submit('aw', req('b7', { sessionId: 'busy' }))), 'ok', 'IDLE again after the turn')
  await untilTerminal(h, 'b7')
})

test('closeSession: cancels a live turn, removes home/, marks CLOSED; idempotent; unknown → not_found', async () => {
  const h = harness()
  await h.boot()
  await persistent(h, 'to-close')
  await h.dispatcher.submit('aw', req('c1', { sessionId: 'to-close', prompt: 'hang' }))
  await new Promise((r) => setTimeout(r, 20))
  assert.equal(h.registry.get('c1')!.status, 'RUNNING')
  assert.ok(existsSync(homeOf(h, 'to-close')))

  const closed = await h.dispatcher.closeSession('to-close')
  assert.equal(closed.status, 'CLOSED')
  assert.ok(closed.closedAt)
  const run = h.registry.get('c1')!
  assert.equal(run.status, 'CANCELLED')
  assert.equal((await h.events.read('c1')).at(-1)!.type, 'run/finished')
  assert.ok(!existsSync(homeOf(h, 'to-close')))
  assert.ok(existsSync(path.join(sessionDir(h, 'to-close'), 'meta.json')))
  assert.equal(readSessionMeta(h, 'to-close').status, 'CLOSED')

  assert.equal((await h.dispatcher.closeSession('to-close')).status, 'CLOSED', 'idempotent')
  await assert.rejects(h.dispatcher.closeSession('nope'), (e: unknown) => e instanceof RunFailure && e.error.code === 'not_found')
  await assert.rejects(h.dispatcher.closeSession('../x'), (e: unknown) => e instanceof RunFailure && e.error.code === 'validation')
  await assert.rejects(h.dispatcher.submit('aw', req('c2', { sessionId: 'to-close' })), (e: unknown) => e instanceof RunFailure && e.error.code === 'session_closed')
})

test('closeSession while a turn is QUEUED cancels it before it ever starts', async () => {
  const h = harness({ maxConcurrent: 1 })
  await h.boot()
  await persistent(h, 'queued-s')
  await h.dispatcher.submit('aw', req('blocker', { prompt: 'hang' }))
  await h.dispatcher.submit('aw', req('q1', { sessionId: 'queued-s' }))
  await new Promise((r) => setTimeout(r, 20))
  assert.equal(h.registry.get('q1')!.status, 'QUEUED')
  await h.dispatcher.closeSession('queued-s')
  assert.equal(h.registry.get('q1')!.status, 'CANCELLED')
  assert.equal(h.sessions.get('queued-s')!.status, 'CLOSED')
  await h.dispatcher.cancel('blocker')
  assert.equal(h.seen.length, 1, 'q1 never reached the provider')
})

test('recover: RUNNING at crash → persistent session ends IDLE, ephemeral session ends CLOSED with home/ gone; QUEUED with a session is re-enqueued and marks it BUSY again', async () => {
  const dataRoot = tmp('disp-data-')
  const ws = tmp('disp-ws-')
  const first = harness({ dataRoot, ws })
  await first.boot()
  await persistent(first, 'p-run')
  await first.sessions.markBusy('p-run', 'p1')
  await first.registry.create({ id: 'p1', product: 'aw', family: 'fake', workspaceDir: ws, prompt: 'x', status: 'RUNNING', sessionId: 'p-run' })
  await first.events.emit('p1', 'run/started', {})
  await first.sessions.create({ id: 'e-run', product: 'aw', family: 'fake', workspaceDir: ws, policy: { window: 'ephemeral' } })
  await first.sessions.markBusy('e-run', 'e1')
  await first.registry.create({ id: 'e1', product: 'aw', family: 'fake', workspaceDir: ws, prompt: 'x', status: 'RUNNING', sessionId: 'e-run' })
  await first.events.emit('e1', 'run/started', {})
  const homes = createHomeManager({ dataRoot })
  await homes.create('p-run')
  await homes.create('e-run')
  await persistent(first, 'p-queued')
  await first.sessions.markBusy('p-queued', 'q1')
  await first.registry.create({ id: 'q1', product: 'aw', family: 'fake', workspaceDir: ws, prompt: 'x', sessionId: 'p-queued' })
  await first.events.emit('q1', 'run/queued', { position: 1 })
  // Ephemeral session left IDLE without any run (crash between create and markBusy): also swept at boot.
  await first.sessions.create({ id: 'e-orphan', product: 'aw', family: 'fake', workspaceDir: ws, policy: { window: 'ephemeral' } })
  await homes.create('e-orphan')

  const second = harness({ dataRoot, ws })
  assert.deepEqual((await second.boot()).sort(), ['e1', 'p1'])
  // sessions.init() flipped every BUSY to IDLE; recover() must settle them by policy.
  assert.equal(second.sessions.get('p-queued')!.status, 'IDLE')
  await second.dispatcher.recover()

  assert.equal(second.sessions.get('p-run')!.status, 'IDLE')
  assert.ok(existsSync(homes.path('p-run')), 'persistent home survives a crash')
  assert.equal(second.sessions.get('e-run')!.status, 'CLOSED')
  assert.ok(!existsSync(homes.path('e-run')))
  assert.equal(second.sessions.get('e-orphan')!.status, 'CLOSED')
  assert.ok(!existsSync(homes.path('e-orphan')))
  assert.equal(second.registry.get('e1')!.status, 'FAILED')

  assert.ok(['BUSY', 'IDLE'].includes(second.sessions.get('p-queued')!.status), 'BUSY while q1 runs, IDLE once it finished')
  const q1 = await untilTerminal(second, 'q1')
  assert.equal(q1.status, 'SUCCEEDED')
  const settled = await untilSession(second, 'p-queued', 'IDLE')
  assert.equal(settled.turnCount, 1)
  assert.equal(settled.providerSessionRef, 's-q1')
  assert.equal(second.seen[0].homeDir, homes.path('p-queued'))
})
