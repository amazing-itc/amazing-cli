import assert from 'node:assert/strict'
import { test } from 'node:test'
import { ingestCursorLine, type CursorStreamState } from '../events.js'

function ingest(lines: string[]): Array<{ type: string; data: unknown }> {
  const state: CursorStreamState = { fullText: '' }
  return lines.map((line) => ingestCursorLine(line, state)).filter((event): event is NonNullable<typeof event> => event != null)
}

test('emits thinking as a caption and drops user, unmapped JSON and Cursor tool-trace text', () => {
  const events = ingest([
    '{"type":"user","message":{"role":"user","content":[{"type":"text","text":"Demanda live"}]},"session_id":"s1"}',
    '{"type":"thinking","subtype":"delta","text":"planning","session_id":"s1"}',
    '{"type":"heartbeat","session_id":"s1"}',
    'tool readToolCall started',
    '{"type":"assistant","message":{"content":[{"type":"text","text":"Oi"}]}}',
  ])
  assert.deepEqual(
    events.map((event) => event.type),
    ['assistant/thinking', 'assistant/delta'],
  )
  assert.deepEqual(events[0]?.data, { text: 'planning' })
  assert.deepEqual(events[1]?.data, { text: 'Oi' })
})

test('keeps stderr-like non-JSON and short cursor errors', () => {
  const events = ingest(['not a json line from the cli', '{"type":"error","message":"boom"}'])
  assert.deepEqual(events, [
    { type: 'log/line', data: { level: 'info', text: 'not a json line from the cli' } },
    { type: 'log/line', data: { level: 'info', text: 'boom' } },
  ])
})
