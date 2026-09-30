import assert from 'node:assert/strict'
import test from 'node:test'

import { normalizeToolCallForApi, sanitizeMessagesForApi } from '../litellm-client.js'

test('sanitizeMessagesForApi drops empty tool_calls arrays', () => {
  const cleaned = sanitizeMessagesForApi([
    { role: 'user', content: 'hi' },
    { role: 'assistant', content: 'ok', tool_calls: [] },
    {
      role: 'assistant',
      content: '',
      tool_calls: [{ id: '1', function: { name: 'fs', arguments: '{}' } }],
    },
  ])
  assert.deepEqual(cleaned[0], { role: 'user', content: 'hi' })
  assert.deepEqual(cleaned[1], { role: 'assistant', content: 'ok' })
  assert.equal(cleaned[1].tool_calls, undefined)
  assert.equal(cleaned[2].tool_calls?.length, 1)
})

test('sanitizeMessagesForApi normalizes flat tool_calls to OpenAI shape', () => {
  const cleaned = sanitizeMessagesForApi([
    {
      role: 'assistant',
      content: '',
      tool_calls: [{ name: 'fs', arguments: '' }],
    },
  ])
  assert.deepEqual(cleaned[0].tool_calls, [
    { id: 'call_fs', type: 'function', function: { name: 'fs', arguments: '{}' } },
  ])
})

test('normalizeToolCallForApi keeps nested function fields', () => {
  assert.deepEqual(
    normalizeToolCallForApi({
      id: 'c1',
      function: { name: 'shell', arguments: '{"command":"ls"}' },
    }),
    { id: 'c1', type: 'function', function: { name: 'shell', arguments: '{"command":"ls"}' } },
  )
})
