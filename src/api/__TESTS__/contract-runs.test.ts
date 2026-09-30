// Contract tests over real HTTP: POST /v1/runs, GET /v1/runs, GET /v1/runs/{id}, POST /v1/runs/{id}/cancel (non-streaming paths).
import assert from 'node:assert/strict'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { after, before, test } from 'node:test'
import { readEvents } from '../../core/session-store.js'
import type { RunRecord, Session } from '../../core/types.js'
import { createTestApp, type TestApp } from '../../test-support/app.js'
import { call, runRequest, waitFor } from '../../test-support/client.js'
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

const terminal = (id: string) => waitFor(() => {
  const r = app.dispatcher.get(id)
  return r && r.status !== 'QUEUED' && r.status !== 'RUNNING' ? r : undefined
}, `${id} terminal`)

test('POST /v1/runs (fake) → 202 RunRecord without credential; the request body validates against RunRequest', async () => {
  const body = runRequest('aw', 'post-1', { credential: { secret: 'super-secret-value' }, meta: { cardId: '42' }, modelId: 'fake-model' })
  validator.assertValid('RunRequest', body)
  const res = await call(app, 'aw', 'POST', '/v1/runs', body)
  assert.equal(res.status, 202, JSON.stringify(res.body))
  validator.assertValid('RunRecord', res.body)
  const record = res.body as RunRecord
  assert.equal(record.id, 'post-1')
  assert.equal(record.product, 'aw')
  assert.equal(record.family, 'fake')
  assert.ok(record.status === 'QUEUED' || record.status === 'RUNNING')
  assert.ok(!('credential' in record))
  assert.ok(!JSON.stringify(res.body).includes('super-secret-value'))
  assert.equal(record.workspaceDir, app.workspaceRoots.get('aw'))

  const done = await terminal('post-1')
  assert.equal(done.status, 'SUCCEEDED')
  const meta = JSON.parse(readFileSync(path.join(app.dataRoot, 'runs', 'post-1', 'meta.json'), 'utf8'))
  assert.ok(!JSON.stringify(meta).includes('super-secret-value'), 'meta.json never holds the secret')
  assert.ok(!readFileSync(path.join(app.dataRoot, 'runs', 'post-1', 'events.jsonl'), 'utf8').includes('super-secret-value'))
})

const sessionMeta = (id: string): Session => JSON.parse(readFileSync(path.join(app.dataRoot, 'sessions', id, 'meta.json'), 'utf8')) as Session
const sessionWithStatus = (id: string, status: Session['status']) =>
  waitFor(() => {
    const s = sessionMeta(id)
    return s.status === status ? s : undefined
  }, `session ${id} ${status}`)

test('EPH-01: POST /v1/runs without sessionId → 202 with sessionId set; after the run the ephemeral session is CLOSED and its home/ is gone', async () => {
  const body = runRequest('aw', 'eph-1')
  validator.assertValid('RunRequest', body)
  const res = await call(app, 'aw', 'POST', '/v1/runs', body)
  assert.equal(res.status, 202, JSON.stringify(res.body))
  validator.assertValid('RunRecord', res.body)
  const sid = (res.body as RunRecord).sessionId
  assert.equal(typeof sid, 'string')
  assert.equal(((await call(app, 'aw', 'GET', '/v1/runs/eph-1')).body as RunRecord).sessionId, sid)
  assert.ok(!('sessionRef' in (res.body as object)), 'no legacy ref was sent, none is invented')

  await terminal('eph-1')
  const closed = await sessionWithStatus(sid!, 'CLOSED')
  assert.equal(closed.product, 'aw')
  assert.equal(closed.family, 'fake')
  assert.deepEqual(closed.policy, { window: 'ephemeral' })
  assert.equal(closed.lastTurnId, 'eph-1')
  assert.equal(closed.turnCount, 1)
  assert.equal(closed.providerSessionRef, 'fake-eph-1', 'the ref the fake returned at run/finished')
  assert.deepEqual(closed.usage, { inputTokens: 10, outputTokens: 20 })
  assert.ok(closed.closedAt)
  assert.ok(!existsSync(path.join(app.dataRoot, 'sessions', sid!, 'home')), 'ephemeral home/ is removed at close')
  assert.ok(existsSync(path.join(app.dataRoot, 'runs', 'eph-1', 'events.jsonl')), 'the run log stays')
  assert.equal(JSON.parse(readFileSync(path.join(app.dataRoot, 'runs', 'eph-1', 'meta.json'), 'utf8')).sessionId, sid)
})

test('EPH-02: legacy body with sessionRef → 202; the record echoes it, the ephemeral session is seeded with it and logs the ref the fake handed back', async () => {
  const body = runRequest('aw', 'legacy-ref', { sessionRef: 'fake-previous-turn' })
  validator.assertValid('RunRequest', body)
  const res = await call(app, 'aw', 'POST', '/v1/runs', body)
  assert.equal(res.status, 202, JSON.stringify(res.body))
  validator.assertValid('RunRecord', res.body)
  const record = res.body as RunRecord
  assert.equal(record.sessionRef, 'fake-previous-turn', 'run.sessionRef is what the provider reads for --resume')
  const sid = record.sessionId!
  assert.equal(sessionMeta(sid).providerSessionRef, 'fake-previous-turn', 'seeded before the turn starts')

  const done = await terminal('legacy-ref')
  assert.equal(done.sessionRef, 'fake-legacy-ref', 'as before: run/finished overwrites the record ref with what the provider returned')
  const init = (await app.events.read('legacy-ref')).find((e) => e.type === 'system/init')!.data as { sessionRef: string }
  assert.equal(init.sessionRef, 'fake-legacy-ref', 'the fake always reports fake-<runId>; the seed is visible on the session, not here')
  const closed = await sessionWithStatus(sid, 'CLOSED')
  assert.equal(closed.providerSessionRef, 'fake-legacy-ref')
  const changes = readEvents(path.join(app.dataRoot, 'sessions', sid, 'session.jsonl')).filter((e) => e.type === 'session/ref-changed')
  assert.deepEqual(changes.map((e) => e.data), [{ from: 'fake-previous-turn', to: 'fake-legacy-ref' }])
})

test('POST /v1/runs with sessionId → 400 validation when it is not an id; 404 not_found for an unknown session; nothing is created', async () => {
  expectError(await call(app, 'aw', 'POST', '/v1/runs', runRequest('aw', 'sid-bad', { sessionId: '../x' })), 400, 'validation')
  expectError(await call(app, 'aw', 'POST', '/v1/runs', runRequest('aw', 'sid-num', { sessionId: 7 })), 400, 'validation')
  expectError(await call(app, 'aw', 'POST', '/v1/runs', runRequest('aw', 'sid-unknown', { sessionId: 'no-such-session' })), 404, 'not_found')
  assert.equal(app.dispatcher.get('sid-bad'), undefined)
  assert.equal(app.dispatcher.get('sid-num'), undefined)
  assert.equal(app.dispatcher.get('sid-unknown'), undefined)
  assert.ok(!existsSync(path.join(app.dataRoot, 'sessions', 'no-such-session')))
})

test('POST /v1/runs with the sessionId of an existing session → 202 and the record points at it; a second turn while BUSY → 409 session_busy', async () => {
  const session = await app.sessions.create({ id: 'http-chat', product: 'aw', family: 'fake', workspaceDir: app.workspaceRoots.get('aw')!, policy: { window: 'persistent' } })
  assert.equal(session.status, 'IDLE')
  const body = runRequest('aw', 'turn-1', { sessionId: 'http-chat', prompt: 'hang' })
  validator.assertValid('RunRequest', body)
  const res = await call(app, 'aw', 'POST', '/v1/runs', body)
  assert.equal(res.status, 202, JSON.stringify(res.body))
  validator.assertValid('RunRecord', res.body)
  assert.equal((res.body as RunRecord).sessionId, 'http-chat')
  expectError(await call(app, 'aw', 'POST', '/v1/runs', runRequest('aw', 'turn-2', { sessionId: 'http-chat' })), 409, 'session_busy')
  expectError(await call(app, 'vector', 'POST', '/v1/runs', runRequest('vector', 'turn-3', { sessionId: 'http-chat' })), 404, 'not_found')
  assert.equal((await call(app, 'aw', 'POST', '/v1/runs/turn-1/cancel')).status, 200)
  const idle = await sessionWithStatus('http-chat', 'IDLE')
  assert.equal(idle.turnCount, 1)
  assert.ok(existsSync(path.join(app.dataRoot, 'sessions', 'http-chat', 'home')), 'persistent home/ survives the turn')
})

/** Every file under `dir`, recursively. */
function filesUnder(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? filesUnder(path.join(dir, e.name)) : [path.join(dir, e.name)]))
}

test('a credential repeated in prompt/meta is *** in the 202 body, GET /v1/runs/{id}, GET /v1/runs, meta.json and every file under dataRoot', async () => {
  const S = 'sk-live-REPEATED-in-prompt-9f8e7d'
  const body = runRequest('aw', 'leaky', { credential: { secret: S }, prompt: `use token ${S} to deploy`, meta: { note: `key=${S}`, plain: 'ok' } })
  const created = await call(app, 'aw', 'POST', '/v1/runs', body)
  assert.equal(created.status, 202, JSON.stringify(created.body))
  validator.assertValid('RunRecord', created.body)
  assert.equal((created.body as RunRecord).prompt, 'use token *** to deploy')
  assert.deepEqual((created.body as RunRecord).meta, { note: 'key=***', plain: 'ok' })
  assert.ok(!JSON.stringify(created.body).includes(S))

  await terminal('leaky')
  const single = await call(app, 'aw', 'GET', '/v1/runs/leaky')
  assert.equal(single.status, 200)
  assert.equal((single.body as RunRecord).prompt, 'use token *** to deploy')
  assert.ok(!JSON.stringify(single.body).includes(S))
  const list = await call(app, 'aw', 'GET', '/v1/runs')
  assert.ok((list.body as RunRecord[]).some((r) => r.id === 'leaky'))
  assert.ok(!JSON.stringify(list.body).includes(S))

  const meta = JSON.parse(readFileSync(path.join(app.dataRoot, 'runs', 'leaky', 'meta.json'), 'utf8')) as RunRecord
  assert.equal(meta.prompt, 'use token *** to deploy')
  assert.deepEqual(meta.meta, { note: 'key=***', plain: 'ok' })
  const leaking = filesUnder(app.dataRoot).filter((f) => readFileSync(f, 'utf8').includes(S))
  assert.deepEqual(leaking, [], 'no file under dataRoot may contain the secret')
})

test('GET /v1/runs/{id} on a RUNNING run reports the live lastSeq (events persisted so far), not the stale persisted 0', async () => {
  assert.equal((await call(app, 'aw', 'POST', '/v1/runs', runRequest('aw', 'live-seq', { prompt: 'hang' }))).status, 202)
  await waitFor(async () => (await app.events.read('live-seq')).length === 4, 'run/queued, run/started, context/usage, system/init on disk')
  const res = await call(app, 'aw', 'GET', '/v1/runs/live-seq')
  assert.equal(res.status, 200)
  validator.assertValid('RunRecord', res.body)
  assert.equal((res.body as RunRecord).status, 'RUNNING')
  assert.equal((res.body as RunRecord).lastSeq, 4)
  const listed = ((await call(app, 'aw', 'GET', '/v1/runs?status=RUNNING')).body as RunRecord[]).find((r) => r.id === 'live-seq')
  assert.equal(listed?.lastSeq, 4, 'the list uses the same live snapshot')
  assert.equal(JSON.parse(readFileSync(path.join(app.dataRoot, 'runs', 'live-seq', 'meta.json'), 'utf8')).lastSeq, 0, 'persisted lastSeq is only written at finish')
  const cancelled = await call(app, 'aw', 'POST', '/v1/runs/live-seq/cancel')
  assert.equal(cancelled.status, 200)
  assert.equal((cancelled.body as RunRecord).lastSeq, 5, 'run/finished is seq 5')
})

test('POST /v1/runs → 400 validation for invalid JSON and for a missing prompt', async () => {
  expectError(await call(app, 'aw', 'POST', '/v1/runs', '{ not json'), 400, 'validation')
  const { prompt: _prompt, ...noPrompt } = runRequest('aw', 'no-prompt')
  expectError(await call(app, 'aw', 'POST', '/v1/runs', noPrompt), 400, 'validation')
  expectError(await call(app, 'aw', 'POST', '/v1/runs', runRequest('aw', 'bad id!')), 400, 'validation')
  expectError(await call(app, 'aw', 'POST', '/v1/runs', '[1,2]'), 400, 'validation')
})

test('POST /v1/runs → 400 workspace_out_of_root for "../"; 400 validation when workspace.product ≠ authenticated product', async () => {
  expectError(await call(app, 'aw', 'POST', '/v1/runs', runRequest('aw', 'escape', { workspace: { product: 'aw', path: '../' } })), 400, 'workspace_out_of_root')
  expectError(await call(app, 'aw', 'POST', '/v1/runs', runRequest('aw', 'escape2', { workspace: { product: 'aw', path: 'does-not-exist' } })), 400, 'workspace_out_of_root')
  expectError(await call(app, 'aw', 'POST', '/v1/runs', runRequest('vector', 'cross')), 400, 'validation')
  assert.equal(app.dispatcher.get('escape'), undefined)
  assert.equal(app.dispatcher.get('cross'), undefined)
})

test('POST /v1/runs → 400 unsupported for an unregistered family; 400 credential_missing is not reachable for fake (no secret needed)', async () => {
  expectError(await call(app, 'aw', 'POST', '/v1/runs', runRequest('aw', 'no-claude', { family: 'claude', credential: { secret: 'x' } })), 400, 'unsupported')
  expectError(await call(app, 'aw', 'POST', '/v1/runs', runRequest('aw', 'no-family', { family: 'nope' })), 400, 'unsupported')
})

test('POST /v1/runs twice with the same runId → 409 duplicate_run', async () => {
  assert.equal((await call(app, 'aw', 'POST', '/v1/runs', runRequest('aw', 'dup-1'))).status, 202)
  expectError(await call(app, 'aw', 'POST', '/v1/runs', runRequest('aw', 'dup-1')), 409, 'duplicate_run')
  await terminal('dup-1')
  expectError(await call(app, 'aw', 'POST', '/v1/runs', runRequest('aw', 'dup-1')), 409, 'duplicate_run')
})

test('GET /v1/runs/{id} → 200 own run (RunRecord); 404 not_found for another product’s run and for unknown ids', async () => {
  assert.equal((await call(app, 'aw', 'POST', '/v1/runs', runRequest('aw', 'mine'))).status, 202)
  await terminal('mine')
  const res = await call(app, 'aw', 'GET', '/v1/runs/mine')
  assert.equal(res.status, 200)
  validator.assertValid('RunRecord', res.body)
  assert.equal((res.body as RunRecord).status, 'SUCCEEDED')
  assert.equal((res.body as RunRecord).lastSeq, 11, 'run/queued, run/started, context/usage, 7 fake events, run/finished')
  expectError(await call(app, 'vector', 'GET', '/v1/runs/mine'), 404, 'not_found')
  expectError(await call(app, 'aw', 'GET', '/v1/runs/never-existed'), 404, 'not_found')
  expectError(await call(app, 'vector', 'GET', '/v1/runs/mine/events'), 404, 'not_found')
  expectError(await call(app, 'vector', 'POST', '/v1/runs/mine/cancel'), 404, 'not_found')
})

test('GET /v1/runs lists only the authenticated product; ?status filters; foreign ?product → 400; bad ?status → 400', async () => {
  assert.equal((await call(app, 'vector', 'POST', '/v1/runs', runRequest('vector', 'v-1'))).status, 202)
  await terminal('v-1')
  const aw = await call(app, 'aw', 'GET', '/v1/runs')
  assert.equal(aw.status, 200)
  const awRuns = aw.body as RunRecord[]
  assert.ok(awRuns.length >= 1)
  for (const r of awRuns) {
    validator.assertValid('RunRecord', r)
    assert.equal(r.product, 'aw')
  }
  const vector = await call(app, 'vector', 'GET', '/v1/runs?product=vector&status=SUCCEEDED')
  assert.deepEqual((vector.body as RunRecord[]).map((r) => r.id), ['v-1'])
  expectError(await call(app, 'vector', 'GET', '/v1/runs?product=aw'), 400, 'validation')
  expectError(await call(app, 'aw', 'GET', '/v1/runs?status=DONE'), 400, 'validation')
  assert.deepEqual((await call(app, 'aw', 'GET', '/v1/runs?status=QUEUED')).body, [])
})

test('POST /v1/runs/{id}/cancel on a finished run → 409 with an Error body', async () => {
  assert.equal((await call(app, 'aw', 'POST', '/v1/runs', runRequest('aw', 'finished'))).status, 202)
  await terminal('finished')
  const res = await call(app, 'aw', 'POST', '/v1/runs/finished/cancel')
  expectError(res, 409, 'validation')
})

test('body over 1 MiB → 400 validation (no crash, connection still usable)', async () => {
  const huge = runRequest('aw', 'huge', { prompt: 'x'.repeat(1024 * 1024 + 10) })
  expectError(await call(app, 'aw', 'POST', '/v1/runs', huge), 400, 'validation')
  assert.equal((await call(app, null, 'GET', '/health')).status, 200)
})

test('POST /v1/runs accepts optional mode ask|plan|agent and copies it onto the RunRecord; omitted mode stays valid', async () => {
  const omitted = runRequest('aw', 'mode-omit')
  validator.assertValid('RunRequest', omitted)
  const omittedRes = await call(app, 'aw', 'POST', '/v1/runs', omitted)
  assert.equal(omittedRes.status, 202, JSON.stringify(omittedRes.body))
  validator.assertValid('RunRecord', omittedRes.body)
  assert.ok(!('mode' in (omittedRes.body as object)))
  await terminal('mode-omit')

  for (const mode of ['ask', 'plan', 'agent'] as const) {
    const body = runRequest('aw', `mode-${mode}`, { mode })
    validator.assertValid('RunRequest', body)
    const res = await call(app, 'aw', 'POST', '/v1/runs', body)
    assert.equal(res.status, 202, JSON.stringify(res.body))
    validator.assertValid('RunRecord', res.body)
    assert.equal((res.body as RunRecord).mode, mode)
    await terminal(`mode-${mode}`)
  }
})

test('POST /v1/runs → 400 validation when mode is not ask|plan|agent', async () => {
  expectError(await call(app, 'aw', 'POST', '/v1/runs', runRequest('aw', 'mode-bad', { mode: 'debug' })), 400, 'validation')
  expectError(await call(app, 'aw', 'POST', '/v1/runs', runRequest('aw', 'mode-num', { mode: 1 })), 400, 'validation')
})

test('POST /v1/runs accepts attachments and copies them onto the RunRecord', async () => {
  const attachments = [
    { kind: 'image', path: '/tmp/a.png', name: 'a.png' },
    { kind: 'file', path: '/tmp/b.txt', name: 'b.txt' },
    { kind: 'folder', path: '/tmp/c', name: 'c' },
  ]
  const body = runRequest('aw', 'attach-ok', { attachments })
  validator.assertValid('RunRequest', body)
  const res = await call(app, 'aw', 'POST', '/v1/runs', body)
  assert.equal(res.status, 202, JSON.stringify(res.body))
  validator.assertValid('RunRecord', res.body)
  assert.deepEqual((res.body as RunRecord).attachments, attachments)
  await terminal('attach-ok')
})

test('POST /v1/runs → 400 validation for invalid attachments shape or kind', async () => {
  expectError(
    await call(app, 'aw', 'POST', '/v1/runs', runRequest('aw', 'attach-kind', { attachments: [{ kind: 'url', path: '/x', name: 'x' }] })),
    400,
    'validation',
  )
  expectError(
    await call(app, 'aw', 'POST', '/v1/runs', runRequest('aw', 'attach-path', { attachments: [{ kind: 'file', path: 1, name: 'x' }] })),
    400,
    'validation',
  )
  expectError(
    await call(app, 'aw', 'POST', '/v1/runs', runRequest('aw', 'attach-name', { attachments: [{ kind: 'file', path: '/x', name: 1 }] })),
    400,
    'validation',
  )
  expectError(await call(app, 'aw', 'POST', '/v1/runs', runRequest('aw', 'attach-arr', { attachments: 'nope' })), 400, 'validation')
})

test('POST /v1/runs empty prompt fails without attachments and succeeds with at least one attachment', async () => {
  expectError(await call(app, 'aw', 'POST', '/v1/runs', runRequest('aw', 'empty-no', { prompt: '' })), 400, 'validation')
  expectError(await call(app, 'aw', 'POST', '/v1/runs', runRequest('aw', 'blank-no', { prompt: '   ' })), 400, 'validation')

  const body = runRequest('aw', 'empty-yes', {
    prompt: '',
    attachments: [{ kind: 'file', path: '/tmp/note.txt', name: 'note.txt' }],
  })
  validator.assertValid('RunRequest', body)
  const res = await call(app, 'aw', 'POST', '/v1/runs', body)
  assert.equal(res.status, 202, JSON.stringify(res.body))
  validator.assertValid('RunRecord', res.body)
  assert.equal((res.body as RunRecord).prompt, '')
  assert.equal((res.body as RunRecord).attachments?.length, 1)
  await terminal('empty-yes')
})
