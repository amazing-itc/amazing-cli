import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { buildSystemPrompt } from '../system-prompt.js'

test('system prompt includes workspace rule titles', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ext-rules-'))
  await mkdir(join(root, '.cursor/rules'), { recursive: true })
  await writeFile(join(root, '.cursor/rules/flow.mdc'), '# Flow workflow\nPrefer tools over guessing.', 'utf8')
  const prompt = buildSystemPrompt(root)
  assert.match(prompt, /not Cursor, Claude/)
  assert.match(prompt, /flow\.mdc/)
  assert.match(prompt, /Flow workflow/)
  assert.doesNotMatch(prompt, /mcp /)
})

test('plan mode system prompt asks for a plan and not to apply edits', () => {
  const prompt = buildSystemPrompt('', 'plan')
  assert.match(prompt, /plan/i)
  assert.match(prompt, /not (apply|make|perform).*(edit|change)/i)
})

test('ask/agent/omitted system prompts do not add the plan-only instruction', () => {
  for (const mode of ['ask', 'agent', undefined] as const) {
    const prompt = buildSystemPrompt('', mode)
    assert.doesNotMatch(prompt, /not (apply|make|perform).*(edit|change)/i)
  }
})
