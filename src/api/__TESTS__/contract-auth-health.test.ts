// Contract tests over real HTTP: auth, /health, /v1/providers, /v1/providers/external/models.
import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import { authHeaders, createTestApp, TEST_API_KEY, type TestApp } from '../../test-support/app.js'
import { call } from '../../test-support/client.js'
import { createOpenApiValidator } from '../../test-support/openapi-validator.js'

const validator = createOpenApiValidator()
let app: TestApp
before(async () => {
  app = await createTestApp()
})
after(() => app.destroy())

const expectError = (res: { status: number; body: unknown }, status: number, code: string) => {
  assert.equal(res.status, status, JSON.stringify(res.body))
  validator.assertValid('Error', res.body)
  assert.equal((res.body as { error: { code: string } }).error.code, code)
}

test('401 unauthorized: no headers, wrong bearer, missing product header; any id with the service key is accepted', async () => {
  expectError(await call(app, null, 'GET', '/v1/providers'), 401, 'unauthorized')
  expectError(await call(app, null, 'GET', '/v1/providers', undefined, { Authorization: 'Bearer nope-nope-nope-nope-nope', 'X-Amazing-Product': 'aw' }), 401, 'unauthorized')
  expectError(await call(app, null, 'GET', '/v1/providers', undefined, { Authorization: `Bearer ${TEST_API_KEY}` }), 401, 'unauthorized')
  expectError(await call(app, null, 'POST', '/v1/runs', { runId: 'r' }), 401, 'unauthorized')
  const ghost = await call(app, null, 'GET', '/v1/providers', undefined, { Authorization: `Bearer ${TEST_API_KEY}`, 'X-Amazing-Product': 'ghost' })
  assert.equal(ghost.status, 200, JSON.stringify(ghost.body))
})

test('unknown routes: 401 when unauthenticated, 404 not_found once authenticated; wrong method is 404 too', async () => {
  expectError(await call(app, null, 'GET', '/nope'), 401, 'unauthorized')
  expectError(await call(app, 'aw', 'GET', '/nope'), 404, 'not_found')
  expectError(await call(app, 'aw', 'DELETE', '/v1/runs'), 404, 'not_found')
  expectError(await call(app, 'aw', 'POST', '/health'), 404, 'not_found')
})

test('GET /health needs no auth → 200 UP with the fake provider available; validates against Health', async () => {
  const res = await call(app, null, 'GET', '/health')
  assert.equal(res.status, 200)
  validator.assertValid('Health', res.body)
  const body = res.body as { status: string; version: string; providers: Record<string, { available: boolean }>; litellm?: unknown }
  assert.equal(body.status, 'UP')
  assert.equal(body.version, '0.1.0')
  assert.deepEqual(body.providers, { fake: { available: true } })
  assert.equal(body.litellm, undefined, 'no litellm probe wired → no litellm key')
  assert.match(res.headers.get('content-type') ?? '', /application\/json/)
})

test('GET /health with composeApp litellm probe available → litellm.available true, still UP', async () => {
  const probed = await createTestApp({ health: async () => ({ available: true }) })
  try {
    const res = await call(probed, null, 'GET', '/health')
    assert.equal(res.status, 200)
    validator.assertValid('Health', res.body)
    const body = res.body as { status: string; providers: Record<string, { available: boolean }>; litellm?: { available: boolean } }
    assert.equal(body.status, 'UP', 'fake provider is available → UP regardless of litellm')
    assert.deepEqual(body.providers, { fake: { available: true } })
    assert.deepEqual(body.litellm, { available: true })
  } finally {
    await probed.destroy()
  }
})

test('GET /health with composeApp litellm probe unavailable → litellm.available false, still UP', async () => {
  const probed = await createTestApp({ health: async () => ({ available: false }) })
  try {
    const res = await call(probed, null, 'GET', '/health')
    assert.equal(res.status, 200)
    validator.assertValid('Health', res.body)
    const body = res.body as { status: string; litellm?: { available: boolean } }
    assert.equal(body.status, 'UP')
    assert.deepEqual(body.litellm, { available: false })
  } finally {
    await probed.destroy()
  }
})

test('GET /v1/providers → [ProviderInfo] with the fake family', async () => {
  const res = await call(app, 'aw', 'GET', '/v1/providers')
  assert.equal(res.status, 200)
  const list = res.body as Array<Record<string, unknown>>
  assert.equal(list.length, 1)
  for (const item of list) validator.assertValid('ProviderInfo', item)
  assert.deepEqual(list[0], {
    family: 'fake',
    kind: 'fake',
    capabilities: {
      streaming: true,
      resume: true,
      modes: ['ask', 'plan', 'agent'],
      attachments: ['image', 'file', 'folder'],
      compaction: 'controllable',
      contextUsage: 'exact',
      mcp: false,
    },
    streaming: true,
    resume: true,
    models: 'static',
    permissions: [],
    available: true,
  })
})

test('GET /v1/providers/external/models → 503 litellm_unavailable when the external provider is absent', async () => {
  expectError(await call(app, 'vector', 'GET', '/v1/providers/external/models'), 503, 'litellm_unavailable')
})

test('GET /v1/providers/{family}/models → 404 when that provider is not registered', async () => {
  expectError(await call(app, 'aw', 'GET', '/v1/providers/cursor/models'), 404, 'not_found')
})

test('every authenticated route works for two caller ids with the same service key', async () => {
  for (const product of ['aw', 'vector'] as const) {
    const res = await fetch(`${app.baseUrl}/v1/runs`, { headers: authHeaders(product) })
    assert.equal(res.status, 200, product)
    assert.deepEqual(await res.json(), [])
  }
})
