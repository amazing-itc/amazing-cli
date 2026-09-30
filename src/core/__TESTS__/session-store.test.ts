import assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createSessionStore, rebuild, sessionFileForHome } from '../session-store.js'
import type { SessionEvent } from '../session-store.js'

function event(seq: number, type: string, data: unknown): SessionEvent {
  return { seq, type, at: new Date(0).toISOString(), data }
}

test('sessionFileForHome writes session.jsonl beside the home dir', () => {
  assert.equal(sessionFileForHome('/runs/r1/home'), '/runs/r1/session.jsonl')
})

test('JSONL rebuild honours compaction/end messages', async () => {
  const root = await mkdtemp(join(tmpdir(), 'core-store-'))
  const store = createSessionStore(join(root, 'session.jsonl'))
  store.append(event(1, 'session/start', { system: 'sys', prompt: 'seed' }))
  store.append(event(2, 'user/message', { role: 'user', content: 'dropped-by-compaction' }))
  const compacted = [
    { role: 'system', content: 'sys' },
    { role: 'user', content: 'compacted-summary' },
  ]
  store.append(event(3, 'compaction/end', { messages: compacted }))
  store.append(event(4, 'assistant/message', { role: 'assistant', content: 'after' }))

  assert.equal(store.read().length, 4)
  const rebuilt = store.rebuild()
  assert.ok(rebuilt.some((message) => String(message.content ?? '').includes('compacted-summary')))
  assert.deepEqual(
    rebuilt.map((m) => m.content),
    ['sys', 'compacted-summary', 'after'],
  )
})

test('rebuild reads provider-shaped assistant and tool events that have no role', () => {
  const rebuilt = rebuild([
    event(1, 'user/message', { role: 'user', content: 'remember 42' }),
    event(2, 'assistant/message', { text: '42' }),
    event(3, 'tool/call', { name: 'echo', arguments: '{"n":1}' }),
    event(4, 'tool/result', { content: 'ok' }),
    event(5, 'compaction', { dropped: 1, messages: [{ role: 'user', content: 'kept' }] }),
    event(6, 'assistant/message', { text: 'after' }),
  ])
  assert.deepEqual(
    rebuilt.map((m) => m.content),
    ['kept', 'after'],
  )
})

test('C8: rebuild yields only the logged messages, never rules/skills content', () => {
  const rebuilt = rebuild([
    event(1, 'session/start', { system: 'you are a harness', prompt: 'hello' }),
    event(2, 'user/message', { role: 'user', content: 'do the thing' }),
    event(3, 'assistant/message', { role: 'assistant', content: 'done' }),
  ])
  assert.deepEqual(rebuilt, [
    { role: 'system', content: 'you are a harness' },
    { role: 'user', content: 'hello' },
    { role: 'user', content: 'do the thing' },
    { role: 'assistant', content: 'done' },
  ])
  assert.ok(rebuilt.every((m) => !String(m.content ?? '').includes('.cursor/')))
})
