import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createSession } from '../session.js'
import { assertSubagentDepth, spawnSubagent } from '../subagent.js'

test('child session does not share parent messages', async () => {
  const parent = createSession({ prompt: 'parent-secret', workspacePath: '', depth: 0 })
  const chat: typeof fetch = async () =>
    new Response(JSON.stringify({ choices: [{ message: { content: 'child-done', tool_calls: [] } }] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  const text = await spawnSubagent('child work', {
    session: parent,
    model: 'gpt-4o-mini',
    chat,
  })
  assert.equal(text, 'child-done')
  assert.ok(parent.messages.every(message => message.content !== 'child-done'))
  assert.equal(parent.depth, 0)
})

test('depth 4 is rejected before spawn', () => {
  assert.throws(() => assertSubagentDepth(4), /exceeds 3/)
})

test('spawnSubagent from depth 3 fails', async () => {
  const parent = createSession({ prompt: 'p', workspacePath: '', depth: 3 })
  await assert.rejects(
    () => spawnSubagent('nope', { session: parent, model: 'gpt-4o-mini' }),
    /exceeds 3/,
  )
})
