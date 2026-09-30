import assert from 'node:assert/strict'
import { test } from 'node:test'
import { compactIfNeeded, toolPairingBalancedBefore } from '../compaction.js'
import { createSession } from '../session.js'
import { measureTokens } from '../token-meter.js'

test('compacts when over 80% of window', () => {
  const session = createSession({ prompt: 'seed', workspacePath: '', contextWindow: 80 })
  session.messages = Array.from({ length: 40 }, (_, i) => ({ role: 'user' as const, content: 'x'.repeat(20) + i }))
  const measured = measureTokens(session.messages)
  const result = compactIfNeeded(session, measured, { thresholdRatio: 0.8, retainRatio: 0.16 })
  assert.equal(result.didCompact, true)
  assert.ok(session.messages.some(message => String(message.content ?? '').includes('compacted-summary')))
  assert.ok(session.messages.length < 40)
  assert.ok(session.log.some(event => event.type === 'compaction/end'))
})

test('does not compact under threshold', () => {
  const session = createSession({ prompt: 'hi', workspacePath: '', contextWindow: 10_000 })
  const result = compactIfNeeded(session, measureTokens(session.messages))
  assert.equal(result.didCompact, false)
})

test('refuses a cut that splits tool_calls from results', () => {
  const messages = [
    { role: 'user' as const, content: 'go' },
    { role: 'assistant' as const, content: '', tool_calls: [{ id: 'c1', name: 'fs' }] },
    { role: 'tool' as const, content: 'ok', tool_call_id: 'c1' },
  ]
  assert.equal(toolPairingBalancedBefore(messages, 2), false)
  assert.equal(toolPairingBalancedBefore(messages, 3), true)
})

test('compactNow keeps a tail tool pair together', () => {
  const session = createSession({ prompt: 'seed', workspacePath: '', contextWindow: 80 })
  session.messages = [
    ...Array.from({ length: 30 }, (_, i) => ({ role: 'user' as const, content: 'y'.repeat(24) + i })),
    { role: 'assistant', content: '', tool_calls: [{ id: 'keep', name: 'fs' }] },
    { role: 'tool', content: 'pair-ok', tool_call_id: 'keep' },
  ]
  const result = compactIfNeeded(session, measureTokens(session.messages), {
    thresholdRatio: 0.8,
    retainRatio: 0.16,
  })
  assert.equal(result.didCompact, true)
  const assistantAt = session.messages.findIndex(message => message.tool_calls?.some(call => call.id === 'keep'))
  assert.ok(assistantAt >= 0)
  assert.equal(session.messages[assistantAt + 1]?.role, 'tool')
  assert.equal(session.messages[assistantAt + 1]?.tool_call_id, 'keep')
})
