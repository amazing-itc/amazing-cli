import assert from 'node:assert/strict'
import type { ServerResponse } from 'node:http'
import { test } from 'node:test'
import type { RunEvent } from '../../core/types.js'
import { parseLastEventId, writeEvent } from '../sse.js'

test('parseLastEventId: "<runId>:<seq>" → seq; missing/foreign run/non-integer/negative → 0; array header uses first value', () => {
  assert.equal(parseLastEventId('r1:3', 'r1'), 3)
  assert.equal(parseLastEventId('r1:0', 'r1'), 0)
  assert.equal(parseLastEventId(undefined, 'r1'), 0)
  assert.equal(parseLastEventId('', 'r1'), 0)
  assert.equal(parseLastEventId('other:3', 'r1'), 0)
  assert.equal(parseLastEventId('r1:abc', 'r1'), 0)
  assert.equal(parseLastEventId('r1:1.5', 'r1'), 0)
  assert.equal(parseLastEventId('r1:-2', 'r1'), 0)
  assert.equal(parseLastEventId('3', 'r1'), 0, 'bare seq is not accepted: the id must name the run')
  assert.equal(parseLastEventId(['r1:7', 'r1:2'], 'r1'), 7)
})

test('parseLastEventId: run ids containing dots/dashes split on the LAST colon', () => {
  assert.equal(parseLastEventId('card-12.v2:41', 'card-12.v2'), 41)
})

test('writeEvent frames id/event/data per the SSE spec with the whole RunEvent as JSON data', () => {
  let written = ''
  const res = { write: (s: string) => ((written += s), true) } as unknown as ServerResponse
  const ev: RunEvent = { id: 'r1:2', runId: 'r1', seq: 2, at: '2026-01-01T00:00:00.000Z', type: 'assistant/delta', data: { text: 'hi' } }
  writeEvent(res, ev)
  assert.equal(written, `id: r1:2\nevent: assistant/delta\ndata: ${JSON.stringify(ev)}\n\n`)
})
