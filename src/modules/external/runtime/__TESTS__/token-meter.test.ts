import assert from 'node:assert/strict'
import { test } from 'node:test'
import { measureTokens } from '../token-meter.js'

test('meter counts system tools and user breakdown', () => {
  const measured = measureTokens([
    { role: 'system', content: 'abc' },
    { role: 'user', content: 'hello world' },
    { role: 'assistant', content: 'ok', tool_calls: [{ id: '1', name: 'fs' }] },
  ])
  assert.ok(measured.totalTokens > 0)
  assert.ok(measured.breakdown.systemTokens > 0)
  assert.ok(measured.breakdown.messageTokens > 0)
})
