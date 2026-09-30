// Composition root: the only place (besides test-support) that may import modules/index.ts.
import { readFileSync } from 'node:fs'
import type http from 'node:http'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createAuthenticator, parseApiKey } from './api/auth.js'
import { createLiteLlmHealth, type HealthProbe } from './api/health.js'
import { createApp } from './api/server.js'
import { createDispatcher, type Dispatcher } from './core/dispatcher.js'
import { fail } from './core/errors.js'
import { createEventLog, type EventLog } from './core/events.js'
import { createHomeManager } from './core/home.js'
import { createQueue } from './core/queue.js'
import { createRedactor } from './core/redact.js'
import { loadProviderManifests } from './core/provider-manifest.js'
import { createRegistry } from './core/registry.js'
import { createSessionRegistry, type SessionRegistry } from './core/session-registry.js'
import { createSessionSweeper, type SessionSweeper } from './core/session-sweeper.js'
import { createWorkspaceResolver, parseWorkspaceRoots, parseWorkspacesRoot } from './core/workspace.js'
import { createContextManifestBuilder } from './modules/external/context-manifest-builder.js'
import { createProviderRegistry } from './modules/index.js'

export interface AppConfig {
  port: number
  dataRoot: string
  workspaceRoots: Map<string, string>
  /** Parent for relative `workspace.path` of any caller id. Unset → only `workspaceRoots` and absolute paths. */
  workspacesRoot?: string
  /** Bearer every caller sends. Not a list of products. */
  apiKey: string
  maxConcurrent: number
  maxConcurrentPerProduct: number
  defaultTimeoutSec: number
  /** Idle time after which a persistent session is closed. Mandatory — no default. */
  sessionIdleTtlSec: number
  /** How often the sweeper runs. Mandatory — no default. */
  sessionSweepSec: number
  enableFake: boolean
  /** Register fake next to the real families. Does not replace them. */
  registerFake: boolean
  /** Extra manifest directory, loaded after the bundled `providers/`. Duplicate family fails boot. */
  providersDir?: string
  /** SSE heartbeat; default 15 s. */
  heartbeatMs?: number
  log?: (line: string) => void
  /** LiteLLM probe for `GET /health`; omit → no `litellm` key (dev without compose). */
  health?: HealthProbe
  /** Override LiteLLM origin for `family=external` (e2e stub / tests). Else `LITELLM_BASE_URL`. */
  litellmBaseUrl?: string
  litellmMasterKey?: string
}

export interface RunningApp {
  server: http.Server
  dispatcher: Dispatcher
  sessions: SessionRegistry
  sweeper: SessionSweeper
  events: EventLog
  port: number
  /** Stops accepting and drops open connections (SSE included). Running runs are left to boot recovery. */
  close(): Promise<void>
}

function intEnv(env: NodeJS.ProcessEnv, name: string, fallback: number, min: number): number {
  const raw = env[name]
  if (raw === undefined || raw.trim() === '') return fallback
  const value = Number(raw)
  if (!Number.isInteger(value) || value < min) throw fail('validation', `${name} must be an integer >= ${min}, got "${raw}"`)
  return value
}

/** Like `intEnv` but without a fallback: the variable must be set (retention is operator policy, not a hardcoded default). */
function requiredIntEnv(env: NodeJS.ProcessEnv, name: string, min: number): number {
  const raw = env[name]
  if (raw === undefined || raw.trim() === '') throw fail('validation', `${name} is required (integer >= ${min})`)
  const value = Number(raw)
  if (!Number.isInteger(value) || value < min) throw fail('validation', `${name} must be an integer >= ${min}, got "${raw}"`)
  return value
}

export function configFromEnv(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const workspacesRoot = parseWorkspacesRoot(env.AMAZING_CLI_WORKSPACES_ROOT)
  return {
    port: intEnv(env, 'PORT', 3200, 0),
    dataRoot: env.AMAZING_CLI_DATA_ROOT || '/data/amazing-cli',
    workspaceRoots: parseWorkspaceRoots(env.AMAZING_CLI_WORKSPACE_ROOTS),
    ...(workspacesRoot !== undefined ? { workspacesRoot } : {}),
    apiKey: parseApiKey(env.AMAZING_CLI_API_KEY),
    maxConcurrent: intEnv(env, 'AMAZING_CLI_MAX_CONCURRENT_RUNS', 4, 1),
    maxConcurrentPerProduct: intEnv(env, 'AMAZING_CLI_MAX_CONCURRENT_RUNS_PER_PRODUCT', 2, 1),
    defaultTimeoutSec: intEnv(env, 'AMAZING_CLI_DEFAULT_TIMEOUT_SEC', 3600, 1),
    sessionIdleTtlSec: requiredIntEnv(env, 'AMAZING_CLI_SESSION_IDLE_TTL_SEC', 1),
    sessionSweepSec: requiredIntEnv(env, 'AMAZING_CLI_SESSION_SWEEP_SEC', 1),
    enableFake: env.AMAZING_CLI_ENABLE_FAKE === 'true',
    registerFake: env.AMAZING_CLI_REGISTER_FAKE === 'true',
    ...(env.AMAZING_CLI_PROVIDERS_DIR !== undefined && env.AMAZING_CLI_PROVIDERS_DIR.trim() !== ''
      ? { providersDir: env.AMAZING_CLI_PROVIDERS_DIR.trim() }
      : {}),
    health: createLiteLlmHealth(env),
  }
}

/** Repo `providers/` next to `src/` in dev (tsx) and next to `dist/` in the image. */
export function bundledProvidersDir(): string {
  return fileURLToPath(new URL('../providers', import.meta.url))
}

export function providerManifestDirs(extra?: string): string[] {
  const dirs = [bundledProvidersDir()]
  if (extra !== undefined && extra.trim() !== '') dirs.push(extra.trim())
  return dirs
}

function packageVersion(): string {
  try {
    return (JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version?: string }).version ?? '0.0.0'
  } catch {
    return '0.0.0'
  }
}

/** Wires core + modules + api, recovers state from `dataRoot`, and listens. */
export async function composeApp(config: AppConfig): Promise<RunningApp> {
  // Fail before listen: a bad or duplicate manifest names the file and the field (PROV-01, PROV-06).
  const manifests = new Map(loadProviderManifests(providerManifestDirs(config.providersDir)).map((manifest) => [manifest.family, manifest]))
  const redactor = createRedactor()
  const registry = createRegistry({ dataRoot: config.dataRoot })
  const sessions = createSessionRegistry({ dataRoot: config.dataRoot })
  const events = createEventLog({ dataRoot: config.dataRoot, redactor })
  const homes = createHomeManager({ dataRoot: config.dataRoot })
  const providers = createProviderRegistry({
    manifests: [...manifests.values()],
    enableFake: config.enableFake,
    registerFake: config.registerFake,
    litellmBaseUrl: config.litellmBaseUrl,
    litellmMasterKey: config.litellmMasterKey,
  })
  const workspaces = createWorkspaceResolver(config.workspaceRoots, config.workspacesRoot)
  const buildContextManifest = createContextManifestBuilder()
  const queue = createQueue({
    maxConcurrent: config.maxConcurrent,
    maxConcurrentPerProduct: config.maxConcurrentPerProduct,
    onStart: (run) => dispatcher.onStart(run),
  })
  const dispatcher = createDispatcher({
    registry,
    sessions,
    events,
    queue,
    workspaces,
    homes,
    providers,
    redactor,
    buildContextManifest,
    manifests,
    defaultTimeoutSec: config.defaultTimeoutSec,
  })
  const server = createApp({
    dispatcher,
    sessions,
    homes,
    events,
    redactor,
    providers,
    manifests,
    workspaces,
    buildContextManifest,
    auth: createAuthenticator(config.apiKey),
    version: packageVersion(),
    heartbeatMs: config.heartbeatMs,
    log: config.log,
    ...(config.health && { health: config.health }),
  })

  await registry.init()
  await sessions.init()
  await dispatcher.recover()
  const sweeper = createSessionSweeper({ sessions, homes, idleTtlSec: config.sessionIdleTtlSec, sweepSec: config.sessionSweepSec })
  sweeper.start()

  await new Promise<void>((resolve, reject) => server.once('error', reject).listen(config.port, resolve))
  const address = server.address()
  const port = typeof address === 'object' && address ? address.port : config.port

  let closing: Promise<void> | undefined
  return {
    server,
    dispatcher,
    sessions,
    sweeper,
    events,
    port,
    close: () =>
      (closing ??= new Promise<void>((resolve, reject) => {
        sweeper.stop()
        server.close((err) => (err ? reject(err) : resolve()))
        server.closeAllConnections()
      })),
  }
}

async function main(): Promise<void> {
  const config = configFromEnv()
  const app = await composeApp(config)
  console.log(JSON.stringify({ at: new Date().toISOString(), msg: 'listening', port: app.port, dataRoot: config.dataRoot }))
  const shutdown = () => {
    console.log(JSON.stringify({ at: new Date().toISOString(), msg: 'shutting down' }))
    app.close().finally(() => process.exit(0))
  }
  process.once('SIGTERM', shutdown)
  process.once('SIGINT', shutdown)
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : String(err))
    process.exit(1)
  })
}
