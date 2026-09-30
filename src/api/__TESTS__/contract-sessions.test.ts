// Contract tests over real HTTP: POST/GET/DELETE /v1/sessions (SESS-01, SESS-05, SESS-06, SESS-08).
import assert from 'node:assert/strict'
import { existsSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { after, before, test } from 'node:test'
import type { ContextUsage } from '../../core/context-manifest.js'
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

const createBody = (overrides: Record<string, unknown> = {}) => ({ family: 'fake', workspace: { path: '.' }, ...overrides })

const sessionOnDisk = (id: string): Session => JSON.parse(readFileSync(path.join(app.dataRoot, 'sessions', id, 'meta.json'), 'utf8')) as Session

test('POST /v1/sessions → 202 Session; home/ and meta.json exist under sessions/{id}; the body validates against CreateSessionRequest', async () => {
  const body = createBody({ sessionId: 'sess-1', modelId: 'fake-model', mode: 'ask', meta: { topic: 'gate' } })
  validator.assertValid('CreateSessionRequest', body)
  const res = await call(app, 'aw', 'POST', '/v1/sessions', body)
  assert.equal(res.status, 202, JSON.stringify(res.body))
  validator.assertValid('Session', res.body)
  const session = res.body as Session
  assert.equal(session.id, 'sess-1')
  assert.equal(session.product, 'aw')
  assert.equal(session.family, 'fake')
  assert.equal(session.status, 'IDLE')
  assert.equal(session.modelId, 'fake-model')
  assert.equal(session.mode, 'ask')
  assert.deepEqual(session.policy, { window: 'persistent' })
  assert.equal(session.turnCount, 0)
  assert.equal(session.providerSessionRef, undefined)
  assert.equal(session.lastTurnId, undefined)
  assert.deepEqual(session.meta, { topic: 'gate' })
  assert.equal(session.workspaceDir, app.workspaceRoots.get('aw'))
  assert.ok(existsSync(path.join(app.dataRoot, 'sessions', 'sess-1', 'meta.json')))
  assert.ok(existsSync(path.join(app.dataRoot, 'sessions', 'sess-1', 'home')))
  assert.equal(statSync(path.join(app.dataRoot, 'sessions', 'sess-1', 'home')).mode & 0o777, 0o700)
  assert.deepEqual(sessionOnDisk('sess-1').meta, { topic: 'gate' })
})

test('POST /v1/sessions without sessionId → the server generates one; without policy → persistent window', async () => {
  const res = await call(app, 'aw', 'POST', '/v1/sessions', createBody())
  assert.equal(res.status, 202, JSON.stringify(res.body))
  validator.assertValid('Session', res.body)
  const session = res.body as Session
  assert.match(session.id, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)
  assert.deepEqual(session.policy, { window: 'persistent' })
})

test('POST /v1/sessions twice with the same sessionId → 409 duplicate_session; the first session is untouched', async () => {
  const first = await call(app, 'aw', 'POST', '/v1/sessions', createBody({ sessionId: 'dup-1' }))
  assert.equal(first.status, 202)
  const second = await call(app, 'aw', 'POST', '/v1/sessions', createBody({ sessionId: 'dup-1', modelId: 'other' }))
  expectError(second, 409, 'duplicate_session')
  assert.equal(sessionOnDisk('dup-1').modelId, undefined)
})

test('POST /v1/sessions → 400 validation for a bad body, an unknown family, a bad mode and a bad sessionId; 400 workspace_out_of_root for ".."', async () => {
  expectError(await call(app, 'aw', 'POST', '/v1/sessions', { family: 'fake' }), 400, 'validation')
  expectError(await call(app, 'aw', 'POST', '/v1/sessions', createBody({ family: 'nope' })), 400, 'validation')
  expectError(await call(app, 'aw', 'POST', '/v1/sessions', createBody({ mode: 'yolo' })), 400, 'validation')
  expectError(await call(app, 'aw', 'POST', '/v1/sessions', createBody({ sessionId: '../x' })), 400, 'validation')
  expectError(await call(app, 'aw', 'POST', '/v1/sessions', createBody({ policy: { window: 'sideways' } })), 400, 'validation')
  expectError(await call(app, 'aw', 'POST', '/v1/sessions', createBody({ workspace: { path: '..' } })), 400, 'workspace_out_of_root')
  assert.equal(app.sessions.list().filter((s) => s.id === '../x').length, 0)
})

test('GET /v1/sessions lists only the authenticated product, newest first; ?status filters; bad ?status → 400', async () => {
  await call(app, 'vector', 'POST', '/v1/sessions', createBody({ sessionId: 'vec-1' }))
  await call(app, 'aw', 'POST', '/v1/sessions', createBody({ sessionId: 'list-a' }))
  await call(app, 'aw', 'POST', '/v1/sessions', createBody({ sessionId: 'list-b' }))

  const all = await call(app, 'aw', 'GET', '/v1/sessions')
  assert.equal(all.status, 200)
  validator.assertValid('Session', (all.body as unknown[])[0])
  const ids = (all.body as Session[]).map((s) => s.id)
  assert.ok(!ids.includes('vec-1'), 'another product is invisible')
  assert.ok(ids.indexOf('list-b') < ids.indexOf('list-a'), 'newest first')

  const closed = await call(app, 'aw', 'GET', '/v1/sessions?status=CLOSED')
  assert.equal(closed.status, 200)
  assert.deepEqual(closed.body, [])
  expectError(await call(app, 'aw', 'GET', '/v1/sessions?status=NOPE'), 400, 'validation')
})

test('GET /v1/sessions/{id} → 200 with status, providerSessionRef, lastTurnId, turnCount, context and policy; 404 for another product and for unknown ids; 400 for a bad id', async () => {
  await call(app, 'aw', 'POST', '/v1/sessions', createBody({ sessionId: 'get-1', mode: 'plan' }))
  const res = await call(app, 'aw', 'GET', '/v1/sessions/get-1')
  assert.equal(res.status, 200, JSON.stringify(res.body))
  validator.assertValid('Session', res.body)
  const session = res.body as Session
  assert.equal(session.status, 'IDLE')
  assert.equal(session.providerSessionRef, undefined)
  assert.equal(session.lastTurnId, undefined)
  assert.equal(session.turnCount, 0)
  assert.equal(session.context, undefined)
  assert.deepEqual(session.policy, { window: 'persistent' })
  assert.equal(session.mode, 'plan')

  expectError(await call(app, 'vector', 'GET', '/v1/sessions/get-1'), 404, 'not_found')
  expectError(await call(app, 'aw', 'GET', '/v1/sessions/never-created'), 404, 'not_found')
  // A slash-free id that still fails the session-id rule (a space survives `URL` parsing).
  expectError(await call(app, 'aw', 'GET', '/v1/sessions/bad%20id'), 400, 'validation')
})

test('DELETE /v1/sessions/{id} while a turn is RUNNING (fake "hang") → run CANCELLED within 5 s, home/ gone, meta.json kept, 200 Session CLOSED; a second DELETE is idempotent', async () => {
  await call(app, 'aw', 'POST', '/v1/sessions', createBody({ sessionId: 'del-1' }))
  const submitted = await call(app, 'aw', 'POST', '/v1/runs', runRequest('aw', 'del-run', { sessionId: 'del-1', prompt: 'hang' }))
  assert.equal(submitted.status, 202, JSON.stringify(submitted.body))
  await waitFor(() => (app.dispatcher.get('del-run')?.status === 'RUNNING' ? true : undefined), 'del-run RUNNING')
  assert.ok(existsSync(path.join(app.dataRoot, 'sessions', 'del-1', 'home')))

  const t0 = Date.now()
  const res = await call(app, 'aw', 'DELETE', '/v1/sessions/del-1')
  assert.ok(Date.now() - t0 < 5000, `close took ${Date.now() - t0}ms`)
  assert.equal(res.status, 200, JSON.stringify(res.body))
  validator.assertValid('Session', res.body)
  const session = res.body as Session
  assert.equal(session.status, 'CLOSED')
  assert.ok(session.closedAt)
  assert.equal(app.dispatcher.get('del-run')!.status, 'CANCELLED')
  assert.ok(!existsSync(path.join(app.dataRoot, 'sessions', 'del-1', 'home')), 'home/ removed on close')
  assert.equal(sessionOnDisk('del-1').status, 'CLOSED')

  const again = await call(app, 'aw', 'DELETE', '/v1/sessions/del-1')
  assert.equal(again.status, 200)
  assert.equal((again.body as Session).status, 'CLOSED')
})

const terminal = (id: string) =>
  waitFor(() => {
    const r = app.dispatcher.get(id)
    return r && r.status !== 'QUEUED' && r.status !== 'RUNNING' ? (r as RunRecord) : undefined
  }, `${id} terminal`)

const turnBody = (runId: string, overrides: Record<string, unknown> = {}) => ({ runId, prompt: 'hello', ...overrides })

const sessionSettled = (id: string) =>
  waitFor(() => {
    const s = sessionOnDisk(id)
    return s.status === 'IDLE' || s.status === 'CLOSED' ? s : undefined
  }, `session ${id} settled`)

test('POST /v1/sessions/{id}/turns: two turns share the session; the second resumes the first ref; turnCount ends at 2; the conversation log records both turns', async () => {
  await call(app, 'aw', 'POST', '/v1/sessions', createBody({ sessionId: 'turn-1' }))

  const first = await call(app, 'aw', 'POST', '/v1/sessions/turn-1/turns', turnBody('turn-1a'))
  assert.equal(first.status, 202, JSON.stringify(first.body))
  validator.assertValid('RunRecord', first.body)
  const firstRecord = first.body as { id: string; sessionId: string; sessionRef?: string }
  assert.equal(firstRecord.sessionId, 'turn-1')
  assert.equal(firstRecord.sessionRef, undefined, 'nothing to resume on the first turn')
  await terminal('turn-1a')
  const after = await sessionSettled('turn-1')
  assert.equal(after.turnCount, 1)
  assert.equal(after.lastTurnId, 'turn-1a')
  assert.equal(after.providerSessionRef, 'fake-turn-1a')

  const second = await call(app, 'aw', 'POST', '/v1/sessions/turn-1/turns', turnBody('turn-1b'))
  assert.equal(second.status, 202, JSON.stringify(second.body))
  const secondRecord = second.body as { sessionId: string; sessionRef?: string }
  assert.equal(secondRecord.sessionId, 'turn-1')
  assert.equal(secondRecord.sessionRef, 'fake-turn-1a', 'the second turn is handed the first turn’s provider ref')
  await terminal('turn-1b')
  const done = await sessionSettled('turn-1')
  assert.equal(done.turnCount, 2)
  assert.equal(done.lastTurnId, 'turn-1b')

  const log = await call(app, 'aw', 'GET', '/v1/sessions/turn-1/events')
  assert.equal(log.status, 200)
  assert.match(log.headers.get('content-type') ?? '', /application\/x-ndjson/)
  const events = (log.body as string).trim().split('\n').map((line) => JSON.parse(line) as { type: string; data: unknown })
  assert.ok(events.length >= 2, 'both turns contributed conversation events')
  assert.ok(events.every((e) => ['user/message', 'assistant/message', 'tool/call', 'tool/result', 'session/ref-changed'].includes(e.type)))
  assert.ok(events.some((e) => e.type === 'session/ref-changed'), 'the fake returns a new ref per run, so the change is logged')
})

test('POST /v1/sessions/{id}/turns → 409 session_busy while a turn is RUNNING, 409 session_closed after DELETE, 400 when the body restates family/workspace/sessionRef', async () => {
  await call(app, 'aw', 'POST', '/v1/sessions', createBody({ sessionId: 'turn-2' }))
  const hanging = await call(app, 'aw', 'POST', '/v1/sessions/turn-2/turns', turnBody('turn-2a', { prompt: 'hang' }))
  assert.equal(hanging.status, 202, JSON.stringify(hanging.body))
  await waitFor(() => (app.dispatcher.get('turn-2a')?.status === 'RUNNING' ? true : undefined), 'turn-2a RUNNING')
  expectError(await call(app, 'aw', 'POST', '/v1/sessions/turn-2/turns', turnBody('turn-2b')), 409, 'session_busy')

  await call(app, 'aw', 'DELETE', '/v1/sessions/turn-2')
  expectError(await call(app, 'aw', 'POST', '/v1/sessions/turn-2/turns', turnBody('turn-2c')), 409, 'session_closed')

  await call(app, 'aw', 'POST', '/v1/sessions', createBody({ sessionId: 'turn-3' }))
  expectError(await call(app, 'aw', 'POST', '/v1/sessions/turn-3/turns', turnBody('turn-3a', { family: 'fake' })), 400, 'validation')
  expectError(await call(app, 'aw', 'POST', '/v1/sessions/turn-3/turns', turnBody('turn-3b', { workspace: { path: '.' } })), 400, 'validation')
  expectError(await call(app, 'aw', 'POST', '/v1/sessions/turn-3/turns', turnBody('turn-3c', { sessionRef: 'x' })), 400, 'validation')
  expectError(await call(app, 'vector', 'POST', '/v1/sessions/turn-3/turns', turnBody('turn-3d')), 404, 'not_found')
})

test('GET /v1/sessions/{id}/events → 200 empty log before any turn; 404 for another product', async () => {
  await call(app, 'aw', 'POST', '/v1/sessions', createBody({ sessionId: 'log-1' }))
  const empty = await call(app, 'aw', 'GET', '/v1/sessions/log-1/events')
  assert.equal(empty.status, 200)
  assert.equal(empty.body, undefined, 'no conversation yet means an empty body')
  expectError(await call(app, 'vector', 'GET', '/v1/sessions/log-1/events'), 404, 'not_found')
})

test('POST /v1/sessions with policy.compaction on a family that declares compaction internal → 400 unsupported', async () => {
  const body = createBody({
    sessionId: 'cap-cursor',
    family: 'cursor',
    policy: { window: 'persistent', compaction: { auto: false } },
  })
  expectError(await call(app, 'aw', 'POST', '/v1/sessions', body), 400, 'unsupported')
  assert.equal(app.sessions.get('cap-cursor'), undefined, 'a rejected capability does not create the session')
})

test('POST /v1/sessions persists policy.compaction; a bad compaction object is 400', async () => {
  const body = createBody({
    sessionId: 'pol-1',
    policy: { window: 'persistent', compaction: { auto: false, retainRatio: 0.2 } },
  })
  validator.assertValid('CreateSessionRequest', body)
  const res = await call(app, 'aw', 'POST', '/v1/sessions', body)
  assert.equal(res.status, 202, JSON.stringify(res.body))
  validator.assertValid('Session', res.body)
  assert.deepEqual((res.body as Session).policy, { window: 'persistent', compaction: { auto: false, retainRatio: 0.2 } })
  expectError(
    await call(app, 'aw', 'POST', '/v1/sessions', createBody({ sessionId: 'pol-2', policy: { window: 'persistent', compaction: { auto: 'yes' } } })),
    400,
    'validation',
  )
})

test('three fake turns grow conversation; precision is exact; preview with sessionId includes the log; /compact drops a prefix; cursor is unsupported', async () => {
  await call(app, 'aw', 'POST', '/v1/sessions', createBody({ sessionId: 'ctx-1' }))
  const prompts = ['alpha alpha alpha alpha', 'beta beta beta beta beta', 'gamma gamma gamma gamma gamma']
  const conversations: number[] = []
  for (const [i, prompt] of prompts.entries()) {
    const turn = await call(app, 'aw', 'POST', '/v1/sessions/ctx-1/turns', turnBody(`ctx-1-${i}`, { prompt }))
    assert.equal(turn.status, 202, JSON.stringify(turn.body))
    await terminal(`ctx-1-${i}`)
    const settled = await sessionSettled('ctx-1')
    assert.equal(settled.context?.precision, 'exact', 'fake reports inputTokens')
    assert.equal(settled.context?.usedTokens, 10)
    conversations.push(settled.context!.categories.conversation)
  }
  assert.ok(conversations[1] > conversations[0], `conversation should grow: ${conversations.join(',')}`)
  assert.ok(conversations[2] > conversations[1], `conversation should keep growing: ${conversations.join(',')}`)

  const ws = app.workspaceRoots.get('aw')
  const draft = await call(app, 'aw', 'POST', '/v1/context/preview', { family: 'fake', prompt: 'next', workspacePath: ws })
  const withSession = await call(app, 'aw', 'POST', '/v1/context/preview', { family: 'fake', prompt: 'next', workspacePath: ws, sessionId: 'ctx-1' })
  assert.equal(draft.status, 200, JSON.stringify(draft.body))
  assert.equal(withSession.status, 200, JSON.stringify(withSession.body))
  validator.assertValid('ContextUsage', draft.body)
  validator.assertValid('ContextUsage', withSession.body)
  const draftUsage = draft.body as ContextUsage
  const sessionUsage = withSession.body as ContextUsage
  assert.equal(draftUsage.precision, 'estimate')
  assert.ok(sessionUsage.categories.conversation > draftUsage.categories.conversation)

  const compacted = await call(app, 'aw', 'POST', '/v1/sessions/ctx-1/compact')
  assert.equal(compacted.status, 200, JSON.stringify(compacted.body))
  validator.assertValid('CompactResult', compacted.body)
  const result = compacted.body as { dropped: number; retained: number; usage: ContextUsage }
  assert.ok(result.dropped > 0)
  assert.ok(result.retained >= 1)
  assert.equal(result.usage.precision, 'estimate')
  const log = await call(app, 'aw', 'GET', '/v1/sessions/ctx-1/events')
  const events = (log.body as string).trim().split('\n').map((line) => JSON.parse(line) as { type: string; data: { messages?: unknown } })
  const compaction = events.filter((e) => e.type === 'compaction' && Array.isArray(e.data.messages)).at(-1)
  assert.ok(compaction, 'the log records the compaction with the retained messages')
  assert.ok(!JSON.stringify(compaction.data.messages).includes(prompts[0]), 'the first prompt is in the dropped prefix')

  await call(app, 'aw', 'POST', '/v1/sessions', createBody({ sessionId: 'ctx-cursor', family: 'cursor' }))
  expectError(await call(app, 'aw', 'POST', '/v1/sessions/ctx-cursor/compact'), 400, 'unsupported')
})

test('POST /v1/sessions/{id}/compact → 409 while BUSY and after CLOSE', async () => {
  await call(app, 'aw', 'POST', '/v1/sessions', createBody({ sessionId: 'ctx-busy' }))
  const hanging = await call(app, 'aw', 'POST', '/v1/sessions/ctx-busy/turns', turnBody('ctx-busy-a', { prompt: 'hang' }))
  assert.equal(hanging.status, 202, JSON.stringify(hanging.body))
  await waitFor(() => (app.dispatcher.get('ctx-busy-a')?.status === 'RUNNING' ? true : undefined), 'ctx-busy-a RUNNING')
  expectError(await call(app, 'aw', 'POST', '/v1/sessions/ctx-busy/compact'), 409, 'session_busy')
  await call(app, 'aw', 'DELETE', '/v1/sessions/ctx-busy')
  expectError(await call(app, 'aw', 'POST', '/v1/sessions/ctx-busy/compact'), 409, 'session_closed')
})

test('DELETE /v1/sessions/{id} → 404 for another product and for an unknown id; the foreign session stays open', async () => {
  await call(app, 'vector', 'POST', '/v1/sessions', createBody({ sessionId: 'vec-del' }))
  expectError(await call(app, 'aw', 'DELETE', '/v1/sessions/vec-del'), 404, 'not_found')
  assert.equal(sessionOnDisk('vec-del').status, 'IDLE')
  expectError(await call(app, 'aw', 'DELETE', '/v1/sessions/no-such'), 404, 'not_found')
})
