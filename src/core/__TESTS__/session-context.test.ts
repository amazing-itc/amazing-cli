import assert from 'node:assert/strict'
import { test } from 'node:test'
import { compactSessionEvents, conversationTokensFromEvents } from '../session-context.js'
import type { SessionEvent } from '../session-store.js'

function event(seq: number, type: string, data: unknown): SessionEvent {
  return { seq, type, at: new Date(0).toISOString(), data }
}

const log = [
  event(1, 'user/message', { role: 'user', content: 'a'.repeat(40) }),
  event(2, 'assistant/message', { text: 'b'.repeat(40) }),
  event(3, 'tool/result', { content: 'c'.repeat(40) }),
  event(4, 'user/message', { role: 'user', content: 'd'.repeat(40) }),
]

test('conversation tokens grow as the log grows, and a compaction event replaces the prefix', () => {
  const first = conversationTokensFromEvents(log.slice(0, 1))
  const all = conversationTokensFromEvents(log)
  assert.ok(all > first)
  const compacted = [
    ...log,
    event(5, 'compaction', { messages: [{ role: 'user', content: 'kept' }] }),
  ]
  assert.ok(conversationTokensFromEvents(compacted) < all)
})

test('compactSessionEvents drops a prefix and keeps a tail', () => {
  const result = compactSessionEvents(log, 0.16)
  assert.ok(result.dropped > 0)
  assert.equal(result.retained, result.messages.length)
  assert.ok(String(result.messages[0]?.content).includes('compacted-summary'))
  assert.ok(!result.messages.some((message) => String(message.content).includes('a'.repeat(40))))
})
