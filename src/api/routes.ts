import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { assertCompact, assertSession } from '../core/capabilities.js'
import type { ContextManifestBuilder, ContextUsage } from '../core/context-manifest.js'
import { isAttachmentKind } from '../core/context-manifest.js'
import { compactSessionEvents, conversationTokensFromEvents } from '../core/session-context.js'
import { createSessionStore, readEvents, sessionFileForHome } from '../core/session-store.js'
import { TERMINAL_STATUSES, type Dispatcher } from '../core/dispatcher.js'
import { fail } from '../core/errors.js'
import type { EventLog } from '../core/events.js'
import { assertSessionId } from '../core/ids.js'
import type { HomeManager } from '../core/home.js'
import { FAMILY_RE, type ProviderManifest } from '../core/provider-manifest.js'
import type { Provider } from '../core/provider.js'
import type { Redactor } from '../core/redact.js'
import type { SessionRegistry } from '../core/session-registry.js'
import type { Family, RunAttachment, RunMode, RunRecord, RunRequest, RunStatus, Session, SessionStatus } from '../core/types.js'
import type { WorkspaceResolver } from '../core/workspace.js'
import { readJsonBody, sendJson } from './http.js'
import { streamRun } from './sse.js'

/** Every implemented route, in OpenAPI path-template form; `scripts/check-openapi.mjs` diffs this against `openapi.yaml`. */
export const ROUTES = [
  { method: 'GET', pattern: '/health' },
  { method: 'GET', pattern: '/v1/providers' },
  { method: 'GET', pattern: '/v1/providers/{family}/models' },
  { method: 'POST', pattern: '/v1/context/preview' },
  { method: 'POST', pattern: '/v1/runs' },
  { method: 'POST', pattern: '/v1/sessions' },
  { method: 'GET', pattern: '/v1/sessions' },
  { method: 'GET', pattern: '/v1/sessions/{id}' },
  { method: 'DELETE', pattern: '/v1/sessions/{id}' },
  { method: 'POST', pattern: '/v1/sessions/{id}/turns' },
  { method: 'POST', pattern: '/v1/sessions/{id}/compact' },
  { method: 'GET', pattern: '/v1/sessions/{id}/events' },
  { method: 'GET', pattern: '/v1/runs' },
  { method: 'GET', pattern: '/v1/runs/{id}' },
  { method: 'GET', pattern: '/v1/runs/{id}/events' },
  { method: 'POST', pattern: '/v1/runs/{id}/cancel' },
] as const

type KeyOf<R> = R extends { method: infer M extends string; pattern: infer P extends string } ? `${M} ${P}` : never
export type RouteKey = KeyOf<(typeof ROUTES)[number]>

export interface RouteDeps {
  dispatcher: Dispatcher
  sessions: SessionRegistry
  homes: HomeManager
  events: EventLog
  /** Defense in depth: every RunRecord leaves through `redactor.redact` even though the dispatcher persists redacted. */
  redactor: Redactor
  providers: Map<Family, Provider>
  /** Family → manifest loaded at boot. A request that needs an undeclared capability is `unsupported`. */
  manifests: Map<string, ProviderManifest>
  workspaces: WorkspaceResolver
  buildContextManifest: ContextManifestBuilder
  /** LiteLLM reachability for `/health`; omitted → no `litellm` key. */
  health?: () => Promise<{ available: boolean; detail?: string }>
  version: string
  heartbeatMs?: number
}

export interface RouteContext {
  req: IncomingMessage
  res: ServerResponse
  url: URL
  params: Record<string, string>
  /** Authenticated product; undefined only for `/health`. */
  product: string | undefined
  deps: RouteDeps
}

type Handler = (ctx: RouteContext) => Promise<void>

const RUN_STATUSES: ReadonlySet<string> = new Set<RunStatus>(['QUEUED', 'RUNNING', 'SUCCEEDED', 'FAILED', 'CANCELLED'])
const SESSION_STATUSES: ReadonlySet<string> = new Set<SessionStatus>(['IDLE', 'BUSY', 'CLOSED'])
const RUN_MODES: ReadonlySet<string> = new Set<RunMode>(['ask', 'plan', 'agent'])

function credentialHeader(value: string | string[] | undefined): string | undefined {
  const raw = Array.isArray(value) ? value[0] : value
  const trimmed = raw?.trim()
  return trimmed ? trimmed : undefined
}

const providerHealth = (p: Provider) => p.health().catch((err: unknown) => ({ available: false, detail: err instanceof Error ? err.message : String(err) }))

/** Id shape first, then the manifests loaded at boot. The seven-name enum is gone. */
function assertDeclaredFamily(family: unknown, manifests: Map<string, ProviderManifest>): asserts family is string {
  if (typeof family !== 'string' || !FAMILY_RE.test(family)) {
    throw fail('validation', 'family must match ^[a-z][a-z0-9-]{1,31}$')
  }
  if (!manifests.has(family)) throw fail('validation', `family "${family}" is not declared`)
}

const isRecord = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v)

async function resolveMaxInputTokens(
  providers: Map<Family, Provider>,
  family: Family,
  modelId: string | undefined,
  secret: string | undefined,
): Promise<number | undefined> {
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

function parsePreviewBody(
  body: unknown,
  product: string,
  manifests: Map<string, ProviderManifest>,
): {
  family: Family
  mode?: RunMode
  modelId?: string
  workspacePath: string
  prompt: string
  attachments?: RunAttachment[]
  sessionId?: string
} {
  if (!isRecord(body)) throw fail('validation', 'body must be a JSON object')
  assertDeclaredFamily(body.family, manifests)
  if (typeof body.prompt !== 'string') throw fail('validation', 'prompt must be a string')
  if (body.mode !== undefined && (typeof body.mode !== 'string' || !RUN_MODES.has(body.mode))) {
    throw fail('validation', 'mode must be ask, plan, or agent')
  }
  if (body.modelId !== undefined && typeof body.modelId !== 'string') throw fail('validation', 'modelId must be a string')
  if (body.sessionId !== undefined) {
    if (typeof body.sessionId !== 'string') throw fail('validation', 'sessionId must be a string')
    assertSessionId(body.sessionId)
  }

  let workspacePath: string
  if (typeof body.workspacePath === 'string' && body.workspacePath.trim() !== '') {
    workspacePath = body.workspacePath.trim()
  } else if (isRecord(body.workspace) && typeof body.workspace.path === 'string') {
    if (body.workspace.product !== undefined && body.workspace.product !== product) {
      throw fail('validation', `workspace.product must equal the authenticated product "${product}"`)
    }
    workspacePath = body.workspace.path
  } else {
    throw fail('validation', 'workspacePath or workspace.path is required')
  }

  let attachments: RunAttachment[] | undefined
  if (body.attachments !== undefined) {
    if (!Array.isArray(body.attachments)) throw fail('validation', 'attachments must be an array')
    attachments = body.attachments.map((item, i) => {
      if (!isRecord(item) || !isAttachmentKind(item.kind) || typeof item.path !== 'string' || typeof item.name !== 'string') {
        throw fail('validation', `attachments[${i}] must be { kind: image|file|folder, path, name }`)
      }
      return { kind: item.kind, path: item.path, name: item.name }
    })
  }

  return {
    family: body.family as Family,
    prompt: body.prompt,
    workspacePath,
    ...(body.mode !== undefined && { mode: body.mode as RunMode }),
    ...(body.modelId !== undefined && { modelId: body.modelId }),
    ...(attachments !== undefined && { attachments }),
    ...(body.sessionId !== undefined && { sessionId: body.sessionId as string }),
  }
}

function parseCompaction(value: unknown): { compaction?: Session['policy']['compaction'] } {
  if (value === undefined) return {}
  if (!isRecord(value) || typeof value.auto !== 'boolean') throw fail('validation', 'policy.compaction.auto must be a boolean')
  const compaction: NonNullable<Session['policy']['compaction']> = { auto: value.auto }
  if (value.thresholdRatio !== undefined) {
    if (typeof value.thresholdRatio !== 'number' || !Number.isFinite(value.thresholdRatio) || value.thresholdRatio <= 0 || value.thresholdRatio > 1) {
      throw fail('validation', 'policy.compaction.thresholdRatio must be a number in (0, 1]')
    }
    compaction.thresholdRatio = value.thresholdRatio
  }
  if (value.retainRatio !== undefined) {
    if (typeof value.retainRatio !== 'number' || !Number.isFinite(value.retainRatio) || value.retainRatio <= 0 || value.retainRatio >= 1) {
      throw fail('validation', 'policy.compaction.retainRatio must be a number in (0, 1)')
    }
    compaction.retainRatio = value.retainRatio
  }
  return { compaction }
}

/**
 * Body of `POST /v1/sessions`: family must be registered, workspace jailed like a run's, mode validated.
 * `sessionId` absent ⇒ a fresh id. `policy` absent ⇒ persistent window.
 */
async function parseCreateSession(
  body: unknown,
  product: string,
  deps: RouteDeps,
): Promise<{ id: string; family: Family; workspaceDir: string; modelId?: string; mode?: RunMode; policy: Session['policy']; meta?: Record<string, string> }> {
  if (!isRecord(body)) throw fail('validation', 'body must be a JSON object')
  if (body.sessionId !== undefined) assertSessionId(body.sessionId)
  assertDeclaredFamily(body.family, deps.manifests)
  if (!isRecord(body.workspace) || typeof body.workspace.path !== 'string') throw fail('validation', 'workspace must be { path }')
  if (body.modelId !== undefined && typeof body.modelId !== 'string') throw fail('validation', 'modelId must be a string')
  if (body.mode !== undefined && (typeof body.mode !== 'string' || !RUN_MODES.has(body.mode))) {
    throw fail('validation', 'mode must be ask, plan, or agent')
  }
  let policy: Session['policy'] = { window: 'persistent' }
  if (body.policy !== undefined) {
    if (!isRecord(body.policy) || (body.policy.window !== 'persistent' && body.policy.window !== 'ephemeral')) {
      throw fail('validation', 'policy.window must be persistent or ephemeral')
    }
    policy = { window: body.policy.window, ...parseCompaction(body.policy.compaction) }
  }
  if (body.meta !== undefined && !(isRecord(body.meta) && Object.values(body.meta).every((v) => typeof v === 'string'))) {
    throw fail('validation', 'meta must map strings to strings')
  }
  const workspaceDir = await deps.workspaces.resolve(product, body.workspace.path)
  return {
    id: (body.sessionId as string | undefined) ?? randomUUID(),
    family: body.family as Family,
    workspaceDir,
    ...(body.modelId !== undefined && { modelId: body.modelId }),
    ...(body.mode !== undefined && { mode: body.mode as RunMode }),
    policy,
    ...(body.meta !== undefined && { meta: body.meta as Record<string, string> }),
  }
}

/** A product can only ever see its own sessions; foreign ids look exactly like unknown ids. */
function ownedSession(sessions: SessionRegistry, product: string, id: string): Session {
  assertSessionId(id)
  const session = sessions.get(id)
  if (!session || session.product !== product) throw fail('not_found', `session ${id} not found`)
  return session
}

/** A product can only ever see its own runs; foreign ids look exactly like unknown ids. */
function ownedRun(dispatcher: Dispatcher, product: string, id: string): RunRecord {
  const record = dispatcher.get(id)
  if (!record || record.product !== product) throw fail('not_found', `run ${id} not found`)
  return record
}

/**
 * What a client may see: redacted, and with `lastSeq` live for QUEUED/RUNNING runs (the dispatcher only
 * persists it at finish) so the snapshot is a valid `Last-Event-ID` anchor for reconnection.
 */
async function snapshot(deps: RouteDeps, record: RunRecord): Promise<RunRecord> {
  const lastSeq = TERMINAL_STATUSES.has(record.status) ? record.lastSeq : await deps.events.lastSeq(record.id)
  return deps.redactor.redact({ ...record, lastSeq })
}

const snapshots = (deps: RouteDeps, records: RunRecord[]) => Promise.all(records.map((r) => snapshot(deps, r)))

const handlers: Record<RouteKey, Handler> = {
  'GET /health': async ({ res, deps }) => {
    const entries = await Promise.all([...deps.providers].map(async ([family, p]) => [family, await providerHealth(p)] as const))
    const litellm = deps.health ? await deps.health().catch(() => ({ available: false })) : undefined
    sendJson(res, 200, {
      status: entries.some(([, h]) => h.available) ? 'UP' : 'DEGRADED',
      version: deps.version,
      providers: Object.fromEntries(entries),
      ...(litellm && { litellm: { available: litellm.available } }),
    })
  },

  'GET /v1/providers': async ({ res, deps }) => {
    const list = await Promise.all(
      [...deps.providers.values()].map(async (provider) => {
        const { family, streaming, resume, models, permissions } = provider.capabilities()
        const manifest = deps.manifests.get(family)
        if (!manifest) throw fail('internal', `provider "${family}" has no manifest`)
        return {
          family,
          kind: manifest.kind,
          capabilities: manifest.capabilities,
          streaming,
          resume,
          models,
          permissions,
          available: (await providerHealth(provider)).available,
        }
      }),
    )
    sendJson(res, 200, list)
  },

  'GET /v1/providers/{family}/models': async ({ req, res, params, deps }) => {
    const family = params.family
    if (!FAMILY_RE.test(family)) throw fail('not_found', `provider ${family} not found`)
    const provider = deps.providers.get(family as Family)
    if (family === 'external' && !provider?.listModels) {
      throw fail('litellm_unavailable', 'external provider is not configured')
    }
    if (!provider?.listModels) throw fail('not_found', `provider ${family} does not list models`)
    sendJson(res, 200, { models: await provider.listModels(credentialHeader(req.headers['x-amazing-credential'])) })
  },

  'POST /v1/context/preview': async ({ req, res, product, deps }) => {
    const parsed = parsePreviewBody(await readJsonBody(req), product!, deps.manifests)
    const workspacePath = await deps.workspaces.resolve(product!, parsed.workspacePath)
    const maxInputTokens = await resolveMaxInputTokens(
      deps.providers,
      parsed.family,
      parsed.modelId,
      credentialHeader(req.headers['x-amazing-credential']),
    )
    const priorConversationTokens = parsed.sessionId
      ? conversationTokensFromEvents(readEvents(sessionFileForHome(deps.homes.path(ownedSession(deps.sessions, product!, parsed.sessionId).id))))
      : 0
    const usage: ContextUsage = await deps.buildContextManifest({
      family: parsed.family,
      mode: parsed.mode,
      modelId: parsed.modelId,
      workspacePath,
      prompt: parsed.prompt,
      attachments: parsed.attachments,
      maxInputTokens,
      priorConversationTokens,
    })
    sendJson(res, 200, usage)
  },

  'POST /v1/sessions': async ({ req, res, product, deps }) => {
    const input = await parseCreateSession(await readJsonBody(req), product!, deps)
    const manifest = deps.manifests.get(input.family)
    if (!manifest) throw fail('unsupported', `family "${input.family}" has no manifest`)
    assertSession(manifest, input)
    // The home is created up front so a session is resumable from its first turn (SESS-01).
    await deps.homes.create(input.id)
    sendJson(res, 202, await deps.sessions.create({ product: product!, ...input }))
  },

  'GET /v1/sessions': async ({ res, url, product, deps }) => {
    const status = url.searchParams.get('status') ?? undefined
    if (status !== undefined && !SESSION_STATUSES.has(status)) throw fail('validation', `status must be one of ${[...SESSION_STATUSES].join('|')}`)
    sendJson(res, 200, deps.sessions.list({ product, status: status as SessionStatus | undefined }))
  },

  'GET /v1/sessions/{id}': async ({ res, params, product, deps }) => {
    sendJson(res, 200, ownedSession(deps.sessions, product!, params.id))
  },

  'DELETE /v1/sessions/{id}': async ({ res, params, product, deps }) => {
    ownedSession(deps.sessions, product!, params.id)
    sendJson(res, 200, await deps.dispatcher.closeSession(params.id))
  },

  'POST /v1/sessions/{id}/turns': async ({ req, res, params, product, deps }) => {
    const session = ownedSession(deps.sessions, product!, params.id)
    if (session.status === 'BUSY') throw fail('session_busy', `session ${session.id} already has a turn in progress`)
    if (session.status === 'CLOSED') throw fail('session_closed', `session ${session.id} is closed`)
    const body = await readJsonBody(req)
    if (!isRecord(body)) throw fail('validation', 'body must be a JSON object')
    // The session already fixed family, workspace and the provider ref; a turn must not restate them (SESS-02).
    for (const forbidden of ['family', 'workspace', 'sessionRef', 'sessionId'] as const) {
      if (body[forbidden] !== undefined) throw fail('validation', `turns must not carry ${forbidden}; it belongs to the session`)
    }
    sendJson(
      res,
      202,
      await snapshot(
        deps,
        await deps.dispatcher.submit(product!, {
          ...body,
          family: session.family,
          workspace: { product: product!, path: session.workspaceDir },
          sessionId: session.id,
        } as RunRequest),
      ),
    )
  },

  'POST /v1/sessions/{id}/compact': async ({ res, params, product, deps }) => {
    const session = ownedSession(deps.sessions, product!, params.id)
    if (session.status === 'BUSY') throw fail('session_busy', `session ${session.id} already has a turn in progress`)
    if (session.status === 'CLOSED') throw fail('session_closed', `session ${session.id} is closed`)
    const manifest = deps.manifests.get(session.family)
    if (!manifest) throw fail('unsupported', `family "${session.family}" has no manifest`)
    assertCompact(manifest)
    const file = sessionFileForHome(deps.homes.path(session.id))
    const result = compactSessionEvents(readEvents(file), session.policy.compaction?.retainRatio ?? 0.16)
    if (result.dropped > 0) {
      const store = createSessionStore(file)
      const seq = store.read().length + 1
      store.append({
        seq,
        type: 'compaction',
        at: new Date().toISOString(),
        data: { dropped: result.dropped, retained: result.retained, messages: result.messages },
      })
    }
    const usage = await deps.buildContextManifest({
      family: session.family,
      mode: session.mode,
      modelId: session.modelId,
      workspacePath: session.workspaceDir,
      prompt: '',
      priorConversationTokens: conversationTokensFromEvents(readEvents(file)),
    })
    await deps.sessions.patch(session.id, { context: usage })
    sendJson(res, 200, { dropped: result.dropped, retained: result.retained, usage })
  },

  'GET /v1/sessions/{id}/events': async ({ res, params, product, deps }) => {
    const session = ownedSession(deps.sessions, product!, params.id)
    const file = sessionFileForHome(deps.homes.path(session.id))
    const body = await readFile(file, 'utf8').catch((err: NodeJS.ErrnoException) => (err.code === 'ENOENT' ? '' : Promise.reject(err)))
    res.writeHead(200, { 'content-type': 'application/x-ndjson' }).end(body)
  },

  'POST /v1/runs': async ({ req, res, product, deps }) => {
    // Body shape (including the optional `sessionId`) is checked by `validateRunRequest` inside `submit`.
    const body = await readJsonBody(req)
    sendJson(res, 202, await snapshot(deps, await deps.dispatcher.submit(product!, body as RunRequest)))
  },

  'GET /v1/runs': async ({ res, url, product, deps }) => {
    const queryProduct = url.searchParams.get('product')
    if (queryProduct !== null && queryProduct !== product) throw fail('validation', `product query must equal the authenticated product "${product}"`)
    const status = url.searchParams.get('status') ?? undefined
    if (status !== undefined && !RUN_STATUSES.has(status)) throw fail('validation', `status must be one of ${[...RUN_STATUSES].join('|')}`)
    sendJson(res, 200, await snapshots(deps, deps.dispatcher.list({ product, status: status as RunStatus | undefined })))
  },

  'GET /v1/runs/{id}': async ({ res, params, product, deps }) => {
    sendJson(res, 200, await snapshot(deps, ownedRun(deps.dispatcher, product!, params.id)))
  },

  'GET /v1/runs/{id}/events': async ({ req, res, params, product, deps }) => {
    const { id } = ownedRun(deps.dispatcher, product!, params.id)
    await streamRun({ res, runId: id, events: deps.events, record: () => deps.dispatcher.get(id), lastEventId: req.headers['last-event-id'], heartbeatMs: deps.heartbeatMs })
  },

  'POST /v1/runs/{id}/cancel': async ({ res, params, product, deps }) => {
    const record = ownedRun(deps.dispatcher, product!, params.id)
    if (TERMINAL_STATUSES.has(record.status)) {
      sendJson(res, 409, { error: { code: 'validation', message: `run ${record.id} already finished (${record.status})` } })
      return
    }
    sendJson(res, 200, await snapshot(deps, await deps.dispatcher.cancel(record.id)))
  },
}

const compiled = ROUTES.map((route) => ({
  ...route,
  key: `${route.method} ${route.pattern}` as RouteKey,
  regex: new RegExp(`^${route.pattern.replace(/\{(\w+)\}/g, '(?<$1>[^/]+)')}$`),
}))

export function matchRoute(method: string | undefined, pathname: string): { key: RouteKey; params: Record<string, string>; handler: Handler } | undefined {
  for (const route of compiled) {
    if (route.method !== method) continue
    const m = route.regex.exec(pathname)
    if (m) return { key: route.key, params: { ...m.groups }, handler: handlers[route.key] }
  }
  return undefined
}
