import assert from 'node:assert/strict'
import { appendFileSync, existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, test } from 'node:test'
import { RunFailure } from '../errors.js'
import { assertFinishedData, createEventLog, isTerminalEvent } from '../events.js'
import { createRedactor } from '../redact.js'
import type { RunEvent } from '../types.js'

let dataRoot: string
beforeEach(() => {
  dataRoot = mkdtempSync(path.join(os.tmpdir(), 'events-'))
})
afterEach(() => {
  rmSync(dataRoot, { recursive: true, force: true })
})

const eventsFile = (runId: string) => path.join(dataRoot, 'runs', runId, 'events.jsonl')

function fileEvents(runId: string): RunEvent[] {
  return readFileSync(eventsFile(runId), 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l) as RunEvent)
}

function makeLog(redactor = createRedactor()) {
  return createEventLog({ dataRoot, redactor })
}

test('emit assigns monotonic seq from 1, id runId:seq, ISO at; file lines == emitted events', async () => {
  const log = makeLog()
  const e1 = await log.emit('r1', 'run/queued', { position: 0 })
  const e2 = await log.emit('r1', 'run/started', {})
  const e3 = await log.emit('r1', 'assistant/delta', { text: 'hi' })
  assert.deepEqual([e1.seq, e2.seq, e3.seq], [1, 2, 3])
  assert.deepEqual([e1.id, e2.id, e3.id], ['r1:1', 'r1:2', 'r1:3'])
  assert.equal(e1.runId, 'r1')
  assert.ok(!Number.isNaN(Date.parse(e1.at)))
  assert.deepEqual(fileEvents('r1'), [e1, e2, e3])
  assert.equal(await log.lastSeq('r1'), 3)

  // Independent runs have independent sequences.
  const other = await log.emit('r2', 'run/queued', {})
  assert.equal(other.id, 'r2:1')
  assert.equal(await log.lastSeq('unknown'), 0)
})

test('read(fromSeq) replays only events with seq > fromSeq; empty for unknown run', async () => {
  const log = makeLog()
  for (let i = 0; i < 5; i++) await log.emit('r1', 'log/line', { i })
  assert.deepEqual((await log.read('r1')).map((e) => e.seq), [1, 2, 3, 4, 5])
  assert.deepEqual((await log.read('r1', 3)).map((e) => e.seq), [4, 5])
  assert.deepEqual(await log.read('r1', 5), [])
  assert.deepEqual(await log.read('nope'), [])
})

test('subscribe receives live events; unsubscribe stops delivery', async () => {
  const log = makeLog()
  const seen: RunEvent[] = []
  const otherRun: RunEvent[] = []
  const unsub = log.subscribe('r1', (e) => seen.push(e))
  log.subscribe('r2', (e) => otherRun.push(e))

  const e1 = await log.emit('r1', 'assistant/delta', { text: 'a' })
  assert.deepEqual(seen, [e1])
  assert.deepEqual(otherRun, [])

  unsub()
  await log.emit('r1', 'assistant/delta', { text: 'b' })
  assert.deepEqual(seen, [e1])
  assert.equal((await log.read('r1')).length, 2)
})

test('a throwing listener does not reject the persisted emit and other listeners still receive the event', async () => {
  const log = makeLog()
  const seen: RunEvent[] = []
  log.subscribe('r1', () => {
    throw new Error('listener boom')
  })
  log.subscribe('r1', (e) => seen.push(e))
  const e = await log.emit('r1', 'log/line', { ok: true })
  assert.equal(e.seq, 1)
  assert.deepEqual(seen, [e])
  assert.deepEqual(fileEvents('r1'), [e])
})

test('negative/zero seq lines are ignored and seq continues from the max intact seq', async () => {
  const log = makeLog()
  await log.emit('r', 'run/queued', {})
  await log.emit('r', 'run/started', {})
  appendFileSync(eventsFile('r'), '{"id":"r:-5","runId":"r","seq":-5,"at":"x","type":"log/line","data":{}}\n')
  appendFileSync(eventsFile('r'), '{"id":"r:0","runId":"r","seq":0,"at":"x","type":"log/line","data":{}}\n')

  const log2 = makeLog()
  assert.deepEqual((await log2.read('r')).map((e) => e.seq), [1, 2])
  assert.equal(await log2.lastSeq('r'), 2)
  const e = await log2.emit('r', 'log/line', {})
  assert.equal(e.seq, 3)
  assert.equal(e.id, 'r:3')
})

test('redaction applies to nested data in both the file and the returned/live event', async () => {
  const redactor = createRedactor()
  redactor.add('sk-live-secret')
  const log = makeLog(redactor)
  const live: RunEvent[] = []
  log.subscribe('r1', (e) => live.push(e))

  const e = await log.emit('r1', 'tool/call', { name: 'http', args: { headers: ['Bearer sk-live-secret'], nested: { k: 'sk-live-secret' } } })
  const expected = { name: 'http', args: { headers: ['Bearer ***'], nested: { k: '***' } } }
  assert.deepEqual(e.data, expected)
  assert.deepEqual(live[0].data, expected)
  const raw = readFileSync(eventsFile('r1'), 'utf8')
  assert.ok(!raw.includes('sk-live-secret'), raw)
  assert.deepEqual(fileEvents('r1')[0].data, expected)
})

test('run/finished with invalid data throws validation and writes nothing', async () => {
  const log = makeLog()
  const bad: unknown[] = [
    undefined,
    null,
    'SUCCEEDED',
    {},
    { status: 'RUNNING' },
    { status: 'SUCCEEDED', sessionRef: 5 },
    { status: 'FAILED', error: { code: 'x' } },
    { status: 'FAILED', error: 'boom' },
    { status: 'CANCELLED', usage: 'lots' },
  ]
  for (const data of bad) {
    await assert.rejects(log.emit('r1', 'run/finished', data), (err: unknown) => err instanceof RunFailure && err.error.code === 'validation')
  }
  assert.ok(!existsSync(eventsFile('r1')))
  assert.equal(await log.lastSeq('r1'), 0)

  const ok = await log.emit('r1', 'run/finished', { status: 'SUCCEEDED', sessionRef: 's', error: { code: 'x', message: 'y' }, usage: { inputTokens: 1 } })
  assert.equal(ok.seq, 1)
  assert.ok(isTerminalEvent(ok))
  assert.ok(!isTerminalEvent({ ...ok, type: 'run/started' }))
  assert.doesNotThrow(() => assertFinishedData({ status: 'CANCELLED' }))
})

test('50 concurrent emits keep seq 1..50 in file order', async () => {
  const log = makeLog()
  const results = await Promise.all(Array.from({ length: 50 }, (_, i) => log.emit('r1', 'log/line', { i })))
  assert.deepEqual(results.map((e) => e.seq), Array.from({ length: 50 }, (_, i) => i + 1))
  const onDisk = fileEvents('r1')
  assert.deepEqual(onDisk.map((e) => e.seq), results.map((e) => e.seq))
  assert.deepEqual(onDisk.map((e) => (e.data as { i: number }).i), Array.from({ length: 50 }, (_, i) => i))
})

test('every method rejects an unsafe runId with RunFailure validation and writes nothing outside runs/', async () => {
  const log = makeLog()
  const isValidation = (err: unknown) => err instanceof RunFailure && err.error.code === 'validation'
  for (const bad of ['.', '..', '../x', '../../escape', 'a/b', '', 'has space', '.hidden', '-flag']) {
    await assert.rejects(log.emit(bad, 'log/line', {}), isValidation)
    await assert.rejects(log.read(bad), isValidation)
    await assert.rejects(log.lastSeq(bad), isValidation)
    assert.throws(() => log.subscribe(bad, () => {}), isValidation)
  }
  assert.ok(!existsSync(path.join(dataRoot, '..', 'x')))
  assert.ok(!existsSync(path.join(dataRoot, 'x')))
  assert.ok(!existsSync(path.join(dataRoot, '..', 'escape')))
  assert.ok(!existsSync(path.join(dataRoot, 'events.jsonl')))
  assert.ok(!existsSync(path.join(dataRoot, 'runs', 'events.jsonl')))
  assert.ok(!existsSync(path.join(dataRoot, 'runs', 'meta.json')))
  assert.ok(!existsSync(path.join(dataRoot, 'runs')), 'no run dir may be created for a rejected id')
})

test('non-event JSON lines (null, number, string, object without seq) are ignored; seq continues from last intact', async () => {
  const log = makeLog()
  await log.emit('r', 'run/queued', {})
  await log.emit('r', 'run/started', {})
  appendFileSync(eventsFile('r'), 'null\n42\n"str"\n{"no":"seq"}\n')

  const log2 = makeLog()
  const intact = await log2.read('r')
  assert.deepEqual(intact.map((e) => e.id), ['r:1', 'r:2'])
  assert.equal(await log2.lastSeq('r'), 2)
  const e = await log2.emit('r', 'log/line', {})
  assert.equal(e.seq, 3)
  assert.equal(e.id, 'r:3')
  assert.deepEqual((await makeLog().read('r')).map((x) => x.seq), [1, 2, 3])
})

test('truncated trailing line: read() skips it, emit() continues from last intact seq on a fresh line', async () => {
  const log = makeLog()
  await log.emit('r1', 'run/queued', {})
  await log.emit('r1', 'run/started', {})
  appendFileSync(eventsFile('r1'), '{"id":"r1:3","runId":"r1","seq":3,"at":"2026-01-01T00:00:00.000Z","type":"log/li')

  const log2 = makeLog()
  assert.deepEqual((await log2.read('r1')).map((e) => e.seq), [1, 2])
  assert.equal(await log2.lastSeq('r1'), 2)
  const e = await log2.emit('r1', 'log/line', { after: 'crash' })
  assert.equal(e.seq, 3)
  assert.equal(e.id, 'r1:3')

  // The new event must not be glued onto the partial line; a fresh reader sees 1,2,3 with the new data.
  const log3 = makeLog()
  const replayed = await log3.read('r1')
  assert.deepEqual(replayed.map((x) => x.seq), [1, 2, 3])
  assert.deepEqual(replayed[2].data, { after: 'crash' })
  assert.equal(await log3.lastSeq('r1'), 3)
})

test('after restart (new EventLog instance) seq continues from the last persisted seq', async () => {
  const log = makeLog()
  await log.emit('r1', 'run/queued', {})
  await log.emit('r1', 'run/started', {})

  const log2 = makeLog()
  assert.equal(await log2.lastSeq('r1'), 2)
  const e = await log2.emit('r1', 'assistant/message', { text: 'back' })
  assert.equal(e.seq, 3)
  assert.equal(e.id, 'r1:3')
  assert.deepEqual(fileEvents('r1').map((x) => x.seq), [1, 2, 3])
  assert.deepEqual((await log2.read('r1', 2)).map((x) => x.id), ['r1:3'])
})
