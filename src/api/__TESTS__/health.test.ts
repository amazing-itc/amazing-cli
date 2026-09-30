import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createAuthenticator } from '../auth.js'
import { createLiteLlmHealth, probeLiteLlm } from '../health.js'
import { createApp } from '../server.js'
import type { HomeManager } from '../../core/home.js'
import type { SessionRegistry } from '../../core/session-registry.js'
import { buildContextManifest } from '../../core/context-manifest.js'
import type { Dispatcher } from '../../core/dispatcher.js'
import type { EventLog } from '../../core/events.js'
import type { Provider } from '../../core/provider.js'
import { createRedactor } from '../../core/redact.js'
import type { Family } from '../../core/types.js'
import type { WorkspaceResolver } from '../../core/workspace.js'
import { createOpenApiValidator } from '../../test-support/openapi-validator.js'

const validator = createOpenApiValidator()

test('createLiteLlmHealth: unset or blank LITELLM_BASE_URL → undefined', () => {
  assert.equal(createLiteLlmHealth({}), undefined)
  assert.equal(createLiteLlmHealth({ LITELLM_BASE_URL: '  ' }), undefined)
  assert.equal(createLiteLlmHealth({ LITELLM_MASTER_KEY: 'sk-amazing-litellm-dev' }), undefined)
})

test('probe: GET /health 2xx with Bearer master key → available true; /v1/models not called', async () => {
  const seen: Array<{ url: string; auth: string | null }> = []
  const fetchFn: typeof fetch = async (url, init) => {
    seen.push({ url: String(url), auth: new Headers(init?.headers).get('authorization') })
    assert.ok(init?.signal, '2s abort signal')
    return new Response('ok', { status: 200 })
  }
  const health = createLiteLlmHealth({ LITELLM_BASE_URL: 'http://litellm:4000/', LITELLM_MASTER_KEY: 'sk-master-key-16xx' }, fetchFn)
  assert.ok(health)
  assert.deepEqual(await health(), { available: true })
  assert.deepEqual(seen, [{ url: 'http://litellm:4000/health', auth: 'Bearer sk-master-key-16xx' }])
})

test('probe: /health fails then GET /v1/models 2xx → available true', async () => {
  const urls: string[] = []
  const fetchFn: typeof fetch = async (url) => {
    urls.push(String(url))
    if (String(url).endsWith('/health')) return new Response('nope', { status: 404 })
    return new Response('{}', { status: 200 })
  }
  assert.deepEqual(await probeLiteLlm('http://litellm:4000', 'sk-x', fetchFn), { available: true })
  assert.deepEqual(urls, ['http://litellm:4000/health', 'http://litellm:4000/v1/models'])
})

test('probe: both endpoints fail or throw → available false', async () => {
  const fetchFn: typeof fetch = async (url) => {
    if (String(url).endsWith('/health')) throw new Error('ECONNREFUSED')
    return new Response('down', { status: 503 })
  }
  assert.deepEqual(await probeLiteLlm('http://litellm:4000', '', fetchFn), { available: false })
})

const unused = (): never => {
  throw new Error('unused')
}

const deadCursor: Provider = {
  capabilities: () => ({ family: 'cursor', streaming: true, resume: true, models: 'none', permissions: [], binary: 'agent' }),
  health: async () => ({ available: false, detail: 'cli_not_found' }),
  start: unused,
}

const dispatcher: Dispatcher = {
  submit: unused,
  onStart: async () => {},
  cancel: unused,
  closeSession: unused,
  recover: async () => {},
  get: () => undefined,
  list: () => [],
}

const events: EventLog = {
  emit: unused,
  read: async () => [],
  subscribe: () => () => {},
  lastSeq: async () => 0,
}

const workspaces: WorkspaceResolver = {
  resolve: async (_product, path) => path,
}

async function serve(health: () => Promise<{ available: boolean }>): Promise<{ baseUrl: string; close: () => Promise<void> }> {
  const server = createApp({
    dispatcher,
    sessions: {} as SessionRegistry,
    homes: {} as HomeManager,
    events,
    redactor: createRedactor(),
    providers: new Map<Family, Provider>([['cursor', deadCursor]]),
    manifests: new Map(),
    workspaces,
    buildContextManifest: (input) => buildContextManifest({ prompt: input.prompt, maxInputTokens: input.maxInputTokens }),
    auth: createAuthenticator(new Map([['aw', 'aw-test-key-0123456789abcdef']])),
    version: '0.1.0',
    health,
    log: () => {},
  })
  await new Promise<void>((resolve, reject) => server.once('error', reject).listen(0, '127.0.0.1', resolve))
  const addr = server.address()
  const port = typeof addr === 'object' && addr ? addr.port : 0
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()))
        server.closeAllConnections()
      }),
  }
}

test('createApp GET /health: unavailable providers + litellm down → DEGRADED and litellm.available false', async () => {
  const app = await serve(async () => ({ available: false }))
  try {
    const res = await fetch(`${app.baseUrl}/health`)
    assert.equal(res.status, 200)
    const body = await res.json()
    validator.assertValid('Health', body)
    assert.deepEqual(body, {
      status: 'DEGRADED',
      version: '0.1.0',
      providers: { cursor: { available: false, detail: 'cli_not_found' } },
      litellm: { available: false },
    })
  } finally {
    await app.close()
  }
})

test('createApp GET /health: unavailable providers + litellm up → still DEGRADED (status ignores litellm)', async () => {
  const app = await serve(async () => ({ available: true }))
  try {
    const res = await fetch(`${app.baseUrl}/health`)
    const body = (await res.json()) as { status: string; litellm: { available: boolean } }
    validator.assertValid('Health', body)
    assert.equal(body.status, 'DEGRADED')
    assert.deepEqual(body.litellm, { available: true })
  } finally {
    await app.close()
  }
})
