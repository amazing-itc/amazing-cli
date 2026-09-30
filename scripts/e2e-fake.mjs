#!/usr/bin/env node
// In-process e2e against family=fake + a LiteLLM stub. No Docker.
import http from 'node:http'
import { createTestApp } from '../src/test-support/app.js'
import { call, collectSse, runRequest, waitFor } from '../src/test-support/client.js'

function fail(message) {
  console.error(`FAIL ${message}`)
  process.exitCode = 1
  throw new Error(message)
}

function ok(line) {
  console.log(`OK ${line}`)
}

function finishedStatus(messages) {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i]
    if (msg.event !== 'run/finished') continue
    const ev = JSON.parse(msg.data)
    return ev?.data?.status
  }
  return undefined
}

async function postRun(app, product, runId, overrides = {}) {
  const body = runRequest(product, runId, { prompt: 'hello', workspace: { product, path: '.' }, ...overrides })
  const res = await call(app, product, 'POST', '/v1/runs', body)
  if (res.status !== 202) fail(`POST /v1/runs ${product}/${runId} → ${res.status} ${JSON.stringify(res.body)}`)
  return res.body
}

async function followUntilFinished(app, product, runId, timeoutMs = 10_000) {
  const sse = await collectSse(app, product, runId, { signal: AbortSignal.timeout(timeoutMs) })
  if (sse.status !== 200) fail(`SSE ${product}/${runId} → ${sse.status}`)
  const status = finishedStatus(sse.messages)
  if (!status) fail(`SSE ${product}/${runId} never emitted run/finished`)
  return status
}

function startLiteLlmStub() {
  const server = http.createServer((req, res) => {
    const path = req.url?.split('?')[0] ?? ''
    if (path === '/v1/models') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ object: 'list', data: [{ id: 'gpt-4o-mini', object: 'model', owned_by: 'openai' }] }))
      return
    }
    if (path === '/model/info') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ data: [{ model_name: 'gpt-4o-mini', model_info: { mode: 'chat', max_input_tokens: 128000 } }] }))
      return
    }
    res.writeHead(404).end()
  })
  return new Promise((resolve, reject) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address()
      if (!addr || typeof addr === 'string') {
        reject(new Error('LiteLLM stub did not bind'))
        return
      }
      resolve({ server, url: `http://127.0.0.1:${addr.port}` })
    })
    server.once('error', reject)
  })
}

async function main() {
  process.env.AMAZING_CLI_ENABLE_FAKE = 'true'
  const fakeApp = await createTestApp({ enableFake: true })
  let stub
  let modelsApp
  try {
    await postRun(fakeApp, 'aw', 'e2e-aw')
    const awStatus = await followUntilFinished(fakeApp, 'aw', 'e2e-aw')
    if (awStatus !== 'SUCCEEDED') fail(`aw run finished ${awStatus}`)
    ok('aw run SUCCEEDED')

    await postRun(fakeApp, 'vector', 'e2e-vector')
    const vectorStatus = await followUntilFinished(fakeApp, 'vector', 'e2e-vector')
    if (vectorStatus !== 'SUCCEEDED') fail(`vector run finished ${vectorStatus}`)
    ok('vector run SUCCEEDED')

    await postRun(fakeApp, 'aw', 'e2e-hang', { prompt: 'hang' })
    const sseHang = collectSse(fakeApp, 'aw', 'e2e-hang', { signal: AbortSignal.timeout(10_000) })
    await waitFor(async () => {
      const snap = await call(fakeApp, 'aw', 'GET', '/v1/runs/e2e-hang')
      return snap.body && typeof snap.body === 'object' && snap.body.status === 'RUNNING' ? snap.body : undefined
    }, 'hang RUNNING')
    const cancelled = await call(fakeApp, 'aw', 'POST', '/v1/runs/e2e-hang/cancel')
    if (cancelled.status !== 200) fail(`POST cancel → ${cancelled.status} ${JSON.stringify(cancelled.body)}`)
    const hangSseStatus = finishedStatus((await sseHang).messages)
    const hangSnap = await call(fakeApp, 'aw', 'GET', '/v1/runs/e2e-hang')
    const hangStatus = hangSnap.body && typeof hangSnap.body === 'object' ? hangSnap.body.status : undefined
    if (hangSseStatus !== 'CANCELLED' && hangStatus !== 'CANCELLED') {
      fail(`hang expected CANCELLED, sse=${hangSseStatus} status=${hangStatus}`)
    }
    ok('hang CANCELLED')

    const awList = await call(fakeApp, 'aw', 'GET', '/v1/runs')
    const vectorList = await call(fakeApp, 'vector', 'GET', '/v1/runs')
    const awIds = Array.isArray(awList.body) ? awList.body.map((r) => r.id) : []
    const vectorIds = Array.isArray(vectorList.body) ? vectorList.body.map((r) => r.id) : []
    if (!awIds.includes('e2e-aw') || !awIds.includes('e2e-hang')) fail(`GET /v1/runs aw missing runs: ${awIds.join(',')}`)
    if (!vectorIds.includes('e2e-vector')) fail(`GET /v1/runs vector missing runs: ${vectorIds.join(',')}`)
    ok('runs listed')

    stub = await startLiteLlmStub()
    // enableFake registry is fake-only; second app with LiteLLM stub (no real container).
    modelsApp = await createTestApp({ enableFake: false, litellmBaseUrl: stub.url, litellmMasterKey: 'sk-e2e-stub' })
    const modelsRes = await call(modelsApp, 'vector', 'GET', '/v1/providers/external/models')
    if (modelsRes.status !== 200) fail(`GET models → ${modelsRes.status} ${JSON.stringify(modelsRes.body)}`)
    const models = modelsRes.body && typeof modelsRes.body === 'object' ? modelsRes.body.models : undefined
    if (!Array.isArray(models) || models.length < 1 || typeof models[0]?.id !== 'string') {
      fail(`models listed expected { models: [{ id }] }, got ${JSON.stringify(modelsRes.body)}`)
    }
    ok('models listed')

    // Session resource: create → two turns → turnCount 2 → 409 session_busy while a turn hangs → DELETE.
    const created = await call(fakeApp, 'aw', 'POST', '/v1/sessions', { family: 'fake', workspace: { path: '.' }, sessionId: 'e2e-sess' })
    if (created.status !== 202) fail(`POST /v1/sessions → ${created.status} ${JSON.stringify(created.body)}`)
    const turn = async (runId, prompt) => {
      const res = await call(fakeApp, 'aw', 'POST', '/v1/sessions/e2e-sess/turns', { runId, prompt })
      if (res.status !== 202) fail(`POST turn ${runId} → ${res.status} ${JSON.stringify(res.body)}`)
      return res.body
    }
    const turn1 = await turn('e2e-sess-t1', 'hello')
    if (turn1.sessionId !== 'e2e-sess') fail(`turn 1 sessionId = ${turn1.sessionId}`)
    if ((await followUntilFinished(fakeApp, 'aw', 'e2e-sess-t1')) !== 'SUCCEEDED') fail('session turn 1 did not succeed')
    // Session bookkeeping lands just after run/finished; wait until it is idle before the next turn.
    await waitFor(async () => {
      const snap = await call(fakeApp, 'aw', 'GET', '/v1/sessions/e2e-sess')
      return snap.body?.status === 'IDLE' ? snap.body : undefined
    }, 'session idle after turn 1')
    const turn2 = await turn('e2e-sess-t2', 'hello again')
    if (turn2.sessionId !== 'e2e-sess') fail(`turn 2 sessionId = ${turn2.sessionId}`)
    if (turn2.sessionRef !== 'fake-e2e-sess-t1') fail(`turn 2 did not resume turn 1 (sessionRef=${turn2.sessionRef})`)
    if ((await followUntilFinished(fakeApp, 'aw', 'e2e-sess-t2')) !== 'SUCCEEDED') fail('session turn 2 did not succeed')
    const sessionAfter = await waitFor(async () => {
      const snap = await call(fakeApp, 'aw', 'GET', '/v1/sessions/e2e-sess')
      return snap.body?.status === 'IDLE' ? snap : undefined
    }, 'session idle after turn 2')
    if (sessionAfter.body?.turnCount !== 2 || sessionAfter.body?.lastTurnId !== 'e2e-sess-t2') {
      fail(`session after two turns: ${JSON.stringify(sessionAfter.body)}`)
    }
    await turn('e2e-sess-hang', 'hang')
    await waitFor(() => (fakeApp.dispatcher.get('e2e-sess-hang')?.status === 'RUNNING' ? true : undefined), 'session hang RUNNING')
    const busy = await call(fakeApp, 'aw', 'POST', '/v1/sessions/e2e-sess/turns', { runId: 'e2e-sess-busy', prompt: 'hello' })
    if (busy.status !== 409 || busy.body?.error?.code !== 'session_busy') fail(`expected 409 session_busy, got ${busy.status} ${JSON.stringify(busy.body)}`)
    const deleted = await call(fakeApp, 'aw', 'DELETE', '/v1/sessions/e2e-sess')
    if (deleted.status !== 200 || deleted.body?.status !== 'CLOSED') fail(`DELETE session → ${deleted.status} ${JSON.stringify(deleted.body)}`)
    if (fakeApp.dispatcher.get('e2e-sess-hang')?.status !== 'CANCELLED') fail('DELETE did not cancel the hanging turn')
    ok('session: 2 turns, resume, busy, delete')
  } finally {
    await modelsApp?.destroy()
    await fakeApp.destroy()
    await new Promise((resolve) => (stub ? stub.server.close(() => resolve()) : resolve()))
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err)
  process.exit(1)
})
