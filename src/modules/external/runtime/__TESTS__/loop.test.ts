import assert from 'node:assert/strict'
import { test } from 'node:test'
import { runHarness } from '../loop.js'

test('loop sends tools to LiteLLM and stops without native spawn', async () => {
  const bodies: unknown[] = []
  const chat: typeof fetch = async (_url, init) => {
    bodies.push(JSON.parse(String(init?.body ?? '{}')))
    return new Response(
      JSON.stringify({ choices: [{ message: { content: 'done without tools', tool_calls: [] } }] }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    )
  }
  const result = await runHarness({
    model: 'gpt-4o-mini',
    prompt: 'say hi',
    workspacePath: '',
    chat,
  })
  assert.equal(result.ok, true)
  assert.equal(result.text, 'done without tools')
  const sent = bodies[0] as { tools?: unknown[]; stream?: boolean }
  assert.ok(Array.isArray(sent.tools))
  assert.ok(sent.tools.length >= 5)
  assert.equal(sent.stream, true)
})

test('overflow retries after CONTEXT_WINDOW_EXCEEDED', async () => {
  let calls = 0
  const chat: typeof fetch = async () => {
    calls += 1
    if (calls === 1) {
      return new Response('context window exceeded', { status: 400 })
    }
    return new Response(JSON.stringify({ choices: [{ message: { content: 'after compact' } }] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  }
  const result = await runHarness({
    model: 'gpt-4o-mini',
    prompt: 'x'.repeat(200),
    contextWindow: 40,
    chat,
  })
  assert.equal(result.ok, true)
  assert.equal(result.text, 'after compact')
  assert.equal(calls, 2)
})
