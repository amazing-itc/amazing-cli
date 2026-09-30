import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { toolsForMode } from '../runtime/tools.js'
import { resolveContextManifest } from '../context-manifest-builder.js'

test('external toolDefinitions come from toolsForMode; ask is smaller than agent', () => {
  const root = mkdtempSync(join(tmpdir(), 'ctx-builder-tools-'))
  const agent = resolveContextManifest({ family: 'external', mode: 'agent', workspacePath: root, prompt: 'x' })
  const ask = resolveContextManifest({ family: 'external', mode: 'ask', workspacePath: root, prompt: 'x' })
  assert.ok(agent.categories.toolDefinitions > 0)
  assert.ok(ask.categories.toolDefinitions > 0)
  assert.ok(ask.categories.toolDefinitions < agent.categories.toolDefinitions)
  assert.equal(agent.categories.toolDefinitions, Math.ceil(JSON.stringify(toolsForMode('agent')).length / 4))
})

test('native families do not invent CLI tools; mcpServers land in mcp', () => {
  const root = mkdtempSync(join(tmpdir(), 'ctx-builder-native-'))
  const mcp = [{ name: 'board', url: 'http://mcp.test/mcp' }]
  const native = resolveContextManifest({
    family: 'cursor',
    mode: 'agent',
    workspacePath: root,
    prompt: 'x',
    mcpServers: mcp,
  })
  assert.equal(native.categories.toolDefinitions, 0)
  assert.ok(native.categories.mcp > 0)
  assert.equal(native.categories.systemPrompt, 0)

  const noMcp = resolveContextManifest({ family: 'claude', workspacePath: root, prompt: 'x' })
  assert.equal(noMcp.categories.toolDefinitions, 0)
  assert.equal(noMcp.categories.mcp, 0)
})

test('builder loads harness catalog into rules skills and subagentDefinitions', () => {
  const root = mkdtempSync(join(tmpdir(), 'ctx-builder-catalog-'))
  mkdirSync(join(root, '.cursor/rules'), { recursive: true })
  mkdirSync(join(root, '.cursor/skills/demo'), { recursive: true })
  mkdirSync(join(root, '.cursor/agents'), { recursive: true })
  writeFileSync(join(root, '.cursor/rules/style.mdc'), '# Style\nUse concise prose.', 'utf8')
  writeFileSync(join(root, '.cursor/skills/demo/SKILL.md'), '# Demo skill\nDo the demo.', 'utf8')
  writeFileSync(join(root, '.cursor/agents/researcher.md'), '# Researcher\nFind facts.', 'utf8')

  const usage = resolveContextManifest({ family: 'external', workspacePath: root, prompt: 'go' })
  assert.ok(usage.categories.rules > 0)
  assert.ok(usage.categories.skills > 0)
  assert.ok(usage.categories.subagentDefinitions > 0)
  assert.ok(usage.categories.systemPrompt > 0)
})
