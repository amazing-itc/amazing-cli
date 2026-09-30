// Contract tests over real HTTP: SSE stream/replay, cancel, queue limits, timeout and restart recovery.
import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import type { RunEvent, RunRecord } from '../../core/types.js'
import { createTestApp, type TestApp } from '../../test-support/app.js'
import { call, collectSse, runRequest, waitFor, type SseMessage } from '../../test-support/client.js'
import { createOpenApiValidator } from '../../test-support/openapi-validator.js'

const validator = createOpenApiValidator()
let app: TestApp
before(async () => {
  app = await createTestApp()
})
after(() => app.destroy())

const FAKE_SEQUENCE = ['run/queued', 'run/started', 'context/usage', 'system/init', 'assistant/delta', 'assistant/delta', 'assistant/delta', 'tool/call', 'tool/result', 'assistant/message', 'run/finished']

/** Every message must be a RunEvent, `id` must equal `runId:seq`, `event` must equal `type`, and seq must strictly increase. */
function checkMessages(messages: SseMessage[], runId: string): RunEvent[] {
  const events: RunEvent[] = []
  let lastSeq = 0
  for (const m of messages) {
    const ev = JSON.parse(m.data) as RunEvent
    validator.assertValid('RunEvent', ev, `${runId} ${m.event}`)
    assert.equal(m.id, `${runId}:${ev.seq}`)
    assert.equal(m.event, ev.type)
    assert.equal(ev.runId, runId)
    assert.ok(ev.seq > lastSeq, `seq ${ev.seq} after ${lastSeq}`)
    lastSeq = ev.seq
    events.push(ev)
  }
  return events
}

const status = async (target: TestApp, product: 'aw' | 'vector', id: string) => ((await call(target, product, 'GET', `/v1/runs/${id}`)).body as RunRecord)

const untilStatus = (target: TestApp, product: 'aw' | 'vector', id: string, wanted: string, timeoutMs = 5000) =>
  waitFor(async () => {
    const r = await status(target, product, id)
    return r.status === wanted ? r : undefined
  }, `${id} → ${wanted}`, timeoutMs)

test('SSE full stream for fake: 10 events in order, ids runId:seq increasing, headers set, stream ends after run/finished', async () => {
  assert.equal((await call(app, 'aw', 'POST', '/v1/runs', runRequest('aw', 'sse-1'))).status, 202)
  const sse = await collectSse(app, 'aw', 'sse-1')
  assert.equal(sse.status, 200)
  assert.match(sse.contentType ?? '', /^text\/event-stream/)
  const events = checkMessages(sse.messages, 'sse-1')
  assert.deepEqual(events.map((e) => e.type), FAKE_SEQUENCE)
  assert.deepEqual(events.map((e) => e.seq), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11])
  assert.deepEqual(events[0].data, { position: 1 })
  assert.deepEqual((events[3].data as { sessionRef: string }).sessionRef, 'fake-sse-1')
  assert.deepEqual(events.at(-1)!.data, { status: 'SUCCEEDED', sessionRef: 'fake-sse-1', usage: { inputTokens: 10, outputTokens: 20 } })
  const record = await status(app, 'aw', 'sse-1')
  assert.equal(record.status, 'SUCCEEDED')
  assert.equal(record.lastSeq, 11)
})

test('SSE replay: Last-Event-ID runId:3 returns only seq > 3 and still ends after run/finished', async () => {
  assert.equal((await call(app, 'aw', 'POST', '/v1/runs', runRequest('aw', 'sse-replay'))).status, 202)
  await untilStatus(app, 'aw', 'sse-replay', 'SUCCEEDED')
  const sse = await collectSse(app, 'aw', 'sse-replay', { lastEventId: 'sse-replay:3' })
  const events = checkMessages(sse.messages, 'sse-replay')
  assert.deepEqual(events.map((e) => e.seq), [4, 5, 6, 7, 8, 9, 10, 11])
  assert.equal(events.at(-1)!.type, 'run/finished')
  const foreign = await collectSse(app, 'aw', 'sse-replay', { lastEventId: 'other-run:3' })
  assert.equal(foreign.messages.length, 11, 'an id of another run is ignored → full replay')
})

test('SSE on an already-finished run replays everything and ends immediately', async () => {
  assert.equal((await call(app, 'aw', 'POST', '/v1/runs', runRequest('aw', 'sse-done'))).status, 202)
  await untilStatus(app, 'aw', 'sse-done', 'SUCCEEDED')
  const t0 = Date.now()
  const sse = await collectSse(app, 'aw', 'sse-done')
  assert.ok(Date.now() - t0 < 1000, `took ${Date.now() - t0}ms`)
  assert.deepEqual(checkMessages(sse.messages, 'sse-done').map((e) => e.type), FAKE_SEQUENCE)
  const afterEnd = await collectSse(app, 'aw', 'sse-done', { lastEventId: 'sse-done:11' })
  assert.deepEqual(afterEnd.messages, [], 'nothing after the final event')
})

test('cancel of a hanging run → 200 CANCELLED record and run/finished {status: CANCELLED} on the stream within 5 s', async () => {
  assert.equal((await call(app, 'aw', 'POST', '/v1/runs', runRequest('aw', 'hang-1', { prompt: 'hang' }))).status, 202)
  await untilStatus(app, 'aw', 'hang-1', 'RUNNING')
  const stream = collectSse(app, 'aw', 'hang-1')
  await new Promise((r) => setTimeout(r, 30))
  const t0 = Date.now()
  const res = await call(app, 'aw', 'POST', '/v1/runs/hang-1/cancel')
  assert.equal(res.status, 200, JSON.stringify(res.body))
  validator.assertValid('RunRecord', res.body)
  assert.equal((res.body as RunRecord).status, 'CANCELLED')
  assert.equal((res.body as RunRecord).error?.code, 'cancelled')
  const sse = await stream
  assert.ok(Date.now() - t0 < 5000)
  const events = checkMessages(sse.messages, 'hang-1')
  assert.deepEqual(events.map((e) => e.type), ['run/queued', 'run/started', 'context/usage', 'system/init', 'run/finished'])
  assert.equal((events.at(-1)!.data as { status: string }).status, 'CANCELLED')
  const again = await call(app, 'aw', 'POST', '/v1/runs/hang-1/cancel')
  assert.equal(again.status, 409)
  validator.assertValid('Error', again.body)
})

test('queue: maxConcurrent 1 → RUNNING, QUEUED, QUEUED with run/queued positions 1..3; cancelling the first starts the second', async () => {
  const q = await createTestApp({ maxConcurrent: 1, maxConcurrentPerProduct: 1 })
  try {
    for (const id of ['q-1', 'q-2', 'q-3']) assert.equal((await call(q, 'aw', 'POST', '/v1/runs', runRequest('aw', id, { prompt: 'hang' }))).status, 202)
    await untilStatus(q, 'aw', 'q-1', 'RUNNING')
    assert.deepEqual(await Promise.all(['q-1', 'q-2', 'q-3'].map(async (id) => (await status(q, 'aw', id)).status)), ['RUNNING', 'QUEUED', 'QUEUED'])
    const queued = (await call(q, 'aw', 'GET', '/v1/runs?status=QUEUED')).body as RunRecord[]
    assert.deepEqual(queued.map((r) => r.id).sort(), ['q-2', 'q-3'])

    const firstEvents = await Promise.all(['q-1', 'q-2', 'q-3'].map(async (id) => (await q.events.read(id))[0]))
    assert.deepEqual(firstEvents.map((e) => e.type), ['run/queued', 'run/queued', 'run/queued'])
    // Position is 1-based among *queued* runs: q-1 was alone (1) and started at once; q-2 then heads the queue (1); q-3 is behind it (2).
    assert.deepEqual(firstEvents.map((e) => (e.data as { position: number }).position), [1, 1, 2])

    assert.equal((await call(q, 'aw', 'POST', '/v1/runs/q-1/cancel')).status, 200)
    await untilStatus(q, 'aw', 'q-2', 'RUNNING')
    assert.equal((await status(q, 'aw', 'q-3')).status, 'QUEUED')

    const cancelledQueued = await call(q, 'aw', 'POST', '/v1/runs/q-3/cancel')
    assert.equal(cancelledQueued.status, 200)
    assert.equal((cancelledQueued.body as RunRecord).status, 'CANCELLED')
    const q3 = await collectSse(q, 'aw', 'q-3')
    assert.deepEqual(checkMessages(q3.messages, 'q-3').map((e) => e.type), ['run/queued', 'run/finished'])
    assert.equal((await call(q, 'aw', 'POST', '/v1/runs/q-2/cancel')).status, 200)
  } finally {
    await q.destroy()
  }
})

test('timeout: timeoutSec 1 on a hanging run → FAILED timeout within ~2 s, run/finished carries error.code=timeout', async () => {
  assert.equal((await call(app, 'aw', 'POST', '/v1/runs', runRequest('aw', 'slow', { prompt: 'hang', timeoutSec: 1 }))).status, 202)
  const t0 = Date.now()
  const record = await untilStatus(app, 'aw', 'slow', 'FAILED', 3000)
  assert.ok(Date.now() - t0 < 2500, `took ${Date.now() - t0}ms`)
  assert.equal(record.error?.code, 'timeout')
  const sse = await collectSse(app, 'aw', 'slow')
  const last = checkMessages(sse.messages, 'slow').at(-1)!
  assert.equal(last.type, 'run/finished')
  assert.deepEqual(last.data, { status: 'FAILED', error: { code: 'timeout', message: 'run exceeded timeoutSec' } })
})

test('restart recovery: RUNNING at close → FAILED interrupted with run/finished after a new app boots on the same dataRoot', async () => {
  const first = await createTestApp()
  const { dataRoot, workspaceRoots } = first
  try {
    assert.equal((await call(first, 'aw', 'POST', '/v1/runs', runRequest('aw', 'lost', { prompt: 'hang' }))).status, 202)
    await untilStatus(first, 'aw', 'lost', 'RUNNING')
    await first.close() // no cancel: simulates a crash/restart

    const second = await createTestApp({ dataRoot, workspaceRoots })
    try {
      const record = await status(second, 'aw', 'lost')
      validator.assertValid('RunRecord', record)
      assert.equal(record.status, 'FAILED')
      assert.equal(record.error?.code, 'interrupted')
      const sse = await collectSse(second, 'aw', 'lost')
      const events = checkMessages(sse.messages, 'lost')
      assert.deepEqual(events.map((e) => e.type), ['run/queued', 'run/started', 'context/usage', 'system/init', 'run/finished'])
      assert.deepEqual(events.at(-1)!.data, { status: 'FAILED', error: record.error })
    } finally {
      await second.destroy()
    }
  } finally {
    await first.destroy()
  }
})
