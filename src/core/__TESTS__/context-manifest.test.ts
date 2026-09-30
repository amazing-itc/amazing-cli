import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import {
  applyPrecision,
  buildContextManifest,
  catalogTokensFromText,
  tokensFromBytes,
  tokensFromChars,
  type ContextUsage,
} from '../context-manifest.js'

const CATEGORY_KEYS = [
  'systemPrompt',
  'toolDefinitions',
  'rules',
  'skills',
  'mcp',
  'subagentDefinitions',
  'conversation',
] as const

function sumCategories(usage: ContextUsage): number {
  return CATEGORY_KEYS.reduce((n, key) => n + usage.categories[key], 0)
}

test('tokensFromChars matches chars/4; tokensFromBytes matches bytes/4', () => {
  assert.equal(tokensFromChars('abcd'), 1)
  assert.equal(tokensFromChars('abcde'), 2)
  assert.equal(tokensFromBytes(8), 2)
})

test('seven category keys sum to usedTokens', () => {
  const usage = buildContextManifest({
    systemPromptText: 'sys',
    toolDefinitionsText: 'tools',
    catalogText: '- .cursor/rules/a.md: rule body\n- .cursor/skills/s/SKILL.md: skill\n- .cursor/agents/x.md: agent',
    mcpServersJson: '[{"name":"a","url":"http://x"}]',
    prompt: 'hello world',
  })
  assert.deepEqual(Object.keys(usage.categories).sort(), [...CATEGORY_KEYS].sort())
  assert.equal(usage.precision, 'estimate')
  assert.equal(usage.usedTokens, sumCategories(usage))
  assert.ok(usage.categories.systemPrompt > 0)
  assert.ok(usage.categories.toolDefinitions > 0)
  assert.ok(usage.categories.rules > 0)
  assert.ok(usage.categories.skills > 0)
  assert.ok(usage.categories.mcp > 0)
  assert.ok(usage.categories.subagentDefinitions > 0)
  assert.ok(usage.categories.conversation > 0)
})

test('folder attachment counts only the path, not children bytes', () => {
  const root = mkdtempSync(join(tmpdir(), 'ctx-manifest-folder-'))
  const folder = join(root, 'docs')
  mkdirSync(folder)
  const fat = 'x'.repeat(40_000)
  writeFileSync(join(folder, 'big.txt'), fat)

  const without = buildContextManifest({ prompt: 'see folder' })
  const withFolder = buildContextManifest({
    prompt: 'see folder',
    attachments: [{ kind: 'folder', path: folder, name: 'docs' }],
  })

  const delta = withFolder.categories.conversation - without.categories.conversation
  assert.equal(delta, tokensFromChars(folder))
  assert.ok(delta < tokensFromChars(fat) / 2, 'must not bill child file bytes into conversation')
})

test('file attachment uses chars/4; image uses bytes/4', () => {
  const root = mkdtempSync(join(tmpdir(), 'ctx-manifest-attach-'))
  const textPath = join(root, 'note.txt')
  const imagePath = join(root, 'pic.png')
  writeFileSync(textPath, 'abcd')
  writeFileSync(imagePath, Buffer.alloc(8, 0xff))

  const base = buildContextManifest({ prompt: '' })
  const withFile = buildContextManifest({
    prompt: '',
    attachments: [{ kind: 'file', path: textPath, name: 'note.txt' }],
  })
  const withImage = buildContextManifest({
    prompt: '',
    attachments: [{ kind: 'image', path: imagePath, name: 'pic.png' }],
  })

  assert.equal(withFile.categories.conversation - base.categories.conversation, 1)
  assert.equal(withImage.categories.conversation - base.categories.conversation, 2)
})

test('contextWindow is null when maxInputTokens is omitted; never invents 256000', () => {
  const usage = buildContextManifest({ prompt: 'hi' })
  assert.equal(usage.contextWindow, null)
  assert.notEqual(usage.contextWindow, 256000)
  assert.equal(JSON.stringify(usage).includes('256000'), false)

  const withWindow = buildContextManifest({ prompt: 'hi', maxInputTokens: 128000 })
  assert.equal(withWindow.contextWindow, 128000)
})

test('priorConversationTokens adds to conversation and still sums to usedTokens', () => {
  const alone = buildContextManifest({ prompt: 'hi' })
  const withLog = buildContextManifest({ prompt: 'hi', priorConversationTokens: 40 })
  assert.equal(withLog.categories.conversation - alone.categories.conversation, 40)
  assert.equal(withLog.precision, 'estimate')
  assert.equal(withLog.usedTokens, sumCategories(withLog))
})

test('applyPrecision uses inputTokens only when the provider reported a finite count', () => {
  const estimate = buildContextManifest({ prompt: 'hello world' })
  const exact = applyPrecision(estimate, 128)
  assert.equal(exact.precision, 'exact')
  assert.equal(exact.usedTokens, 128)
  assert.equal(exact.categories.conversation, estimate.categories.conversation)

  const still = applyPrecision(estimate, undefined)
  assert.equal(still.precision, 'estimate')
  assert.equal(still.usedTokens, sumCategories(estimate))
})

test('catalogTokensFromText buckets rules skills and agents', () => {
  const tokens = catalogTokensFromText(
    ['- .cursor/rules/style.mdc: Use concise prose.', '- .cursor/skills/demo/SKILL.md: Do the demo.', '- .cursor/agents/researcher.md: Find facts.'].join(
      '\n',
    ),
  )
  assert.ok(tokens.rules > 0)
  assert.ok(tokens.skills > 0)
  assert.ok(tokens.subagentDefinitions > 0)
})
