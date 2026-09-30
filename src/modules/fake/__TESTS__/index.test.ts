import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { StartInput } from '../../../core/provider.js'
import type { EventType, RunRecord } from '../../../core/types.js'
import { createFakeProvider } from '../index.js'

function makeRun(prompt: string): RunRecord {
  return {
    id: 'r1',
    product: 'aw',
    family: 'fake',
    status: 'RUNNING',
    workspaceDir: '/tmp/ws',
    prompt,
    createdAt: new Date().toISOString(),
    lastSeq: 0,
  }
}

function makeInput(prompt: string, signal: AbortSignal): { input: StartInput; events: Array<{ type: EventType; data: unknown }> } {
  const events: Array<{ type: EventType; data: unknown }> = []
  const input: StartInput = {
    run: makeRun(prompt),
    workspaceDir: '/tmp/ws',
    homeDir: '/tmp/home',
    signal,
    emit: (type, data) => events.push({ type, data }),
  }
  return { input, events }
}

test('capabilities and health', async () => {
  const p = createFakeProvider()
  assert.deepEqual(p.capabilities(), {
    family: 'fake',
    streaming: true,
    resume: true,
    models: 'static',
    permissions: [],
    binary: undefined,
  })
  assert.deepEqual(await p.health(), { available: true })
})

test('listModels returns the static fake-model id', async () => {
  const p = createFakeProvider()
  assert.ok(p.listModels)
  assert.deepEqual(await p.listModels(), [{ id: 'fake-model', label: 'Fake', default: true }])
})

test('happy path emits expected sequence and succeeds', async () => {
  const p = createFakeProvider()
  const { input, events } = makeInput('hello', new AbortController().signal)
  const result = await p.start(input)

  assert.deepEqual(result, {
    status: 'SUCCEEDED',
    sessionRef: 'fake-r1',
    usage: { inputTokens: 10, outputTokens: 20 },
  })
  assert.deepEqual(
    events.map((e) => e.type),
    ['system/init', 'assistant/delta', 'assistant/delta', 'assistant/delta', 'tool/call', 'tool/result', 'assistant/message'],
  )
  assert.deepEqual(events[0].data, { sessionRef: 'fake-r1', model: 'fake-model' })
  assert.deepEqual(events[4].data, { name: 'echo', args: {} })
  assert.deepEqual(events[5].data, { name: 'echo', content: 'ok' })
  const deltas = events.filter((e) => e.type === 'assistant/delta').map((e) => (e.data as { text: string }).text)
  assert.deepEqual(events[6].data, { text: deltas.join('') })
  assert.ok(!events.some((e) => e.type.startsWith('run/')), 'provider must not emit run/* events')
})

test('uses run.modelId in system/init when present', async () => {
  const p = createFakeProvider()
  const { input, events } = makeInput('hello', new AbortController().signal)
  input.run.modelId = 'custom'
  await p.start(input)
  assert.deepEqual(events[0].data, { sessionRef: 'fake-r1', model: 'custom' })
})

test('prompt "fail" returns FAILED after init', async () => {
  const p = createFakeProvider()
  const { input, events } = makeInput('fail', new AbortController().signal)
  const result = await p.start(input)
  assert.deepEqual(result, { status: 'FAILED', error: { code: 'internal', message: 'fake failure' } })
  assert.deepEqual(events.map((e) => e.type), ['system/init'])
})

test('prompt "hang" waits for abort and returns CANCELLED promptly', async () => {
  const p = createFakeProvider()
  const ac = new AbortController()
  const { input, events } = makeInput('hang', ac.signal)
  const started = p.start(input)
  await new Promise((r) => setTimeout(r, 20))
  assert.deepEqual(events.map((e) => e.type), ['system/init'])

  const t0 = Date.now()
  ac.abort()
  const result = await started
  assert.deepEqual(result, { status: 'CANCELLED' })
  assert.ok(Date.now() - t0 < 200, 'should resolve promptly after abort')
})

test('abort during deltas returns CANCELLED', async () => {
  const p = createFakeProvider()
  const ac = new AbortController()
  const { input } = makeInput('hello', ac.signal)
  const started = p.start(input)
  ac.abort()
  const result = await started
  assert.deepEqual(result, { status: 'CANCELLED' })
})
