import assert from 'node:assert/strict'
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createSession } from '../session.js'
import { assertSubagentDepth, executeToolCalls, isExclusive, MAX_PARALLEL, TOOL_SCHEMAS, toolsForMode } from '../tools.js'
import { runFs } from '../tools/fs.js'
import { querySession } from '../tools/session-query.js'
import { maybeSpill, SPILL_THRESHOLD } from '../tools/spill.js'
import { resolveInsideWorkspace } from '../tools/paths.js'

function toolNames(schemas: typeof TOOL_SCHEMAS): string[] {
  return schemas.map((schema) => schema.function.name)
}

function fsActionEnum(schemas: typeof TOOL_SCHEMAS): string[] {
  const fs = schemas.find((schema) => schema.function.name === 'fs')
  assert.ok(fs)
  return fs.function.parameters.properties.action.enum
}

test('toolsForMode ask|plan omit shell and fs write; agent/omitted keep TOOL_SCHEMAS', () => {
  for (const mode of ['ask', 'plan'] as const) {
    const schemas = toolsForMode(mode)
    assert.ok(!toolNames(schemas).includes('shell'), `${mode} must omit shell`)
    assert.deepEqual(fsActionEnum(schemas), ['read', 'list', 'grep'])
    assert.ok(toolNames(schemas).includes('fs'))
    assert.ok(toolNames(schemas).includes('session_query'))
    assert.ok(toolNames(schemas).includes('spill'))
    assert.ok(toolNames(schemas).includes('subagent'))
  }

  assert.equal(toolsForMode('agent'), TOOL_SCHEMAS)
  assert.equal(toolsForMode(undefined), TOOL_SCHEMAS)
  assert.ok(toolNames(TOOL_SCHEMAS).includes('shell'))
  assert.deepEqual(fsActionEnum(TOOL_SCHEMAS), ['read', 'write', 'list', 'grep'])
})

test('parallel tools keep model order', async () => {
  const calls = [1, 2, 3, 4].map(i => ({ id: `c${i}`, name: `t${i}` }))
  const results = await executeToolCalls(calls, { maxParallel: 10 })
  assert.deepEqual(results.map(item => item.id), ['c1', 'c2', 'c3', 'c4'])
})

test('subagent depth limit is 3', () => {
  assert.doesNotThrow(() => assertSubagentDepth(3))
  assert.throws(() => assertSubagentDepth(4), /exceeds 3/)
})

test('exclusive classifier treats shell and write as barriers', () => {
  assert.equal(isExclusive('shell'), true)
  assert.equal(isExclusive('fs', { action: 'write' }), true)
  assert.equal(isExclusive('fs', { action: 'read' }), false)
  assert.equal(isExclusive('mcp__aw__wipe', {}, new Set(['mcp__aw__wipe'])), true)
  assert.equal(isExclusive('mcp__aw__add_note', {}, new Set(['mcp__aw__wipe'])), false)
})

test('fs writes and reads inside workspace and rejects escape', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ext-cli-'))
  await runFs({ action: 'write', path: 'notes.txt', content: 'hello' }, root)
  const text = await runFs({ action: 'read', path: 'notes.txt' }, root)
  assert.equal(text, 'hello')
  assert.throws(() => resolveInsideWorkspace(root, '../secret'), /escapes/)
})

test('spill stores large results under .harness/spill', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ext-cli-'))
  const spilled = await maybeSpill(root, 'z'.repeat(SPILL_THRESHOLD + 10), 'fs')
  assert.match(spilled, /\.harness\/spill/)
  const match = spilled.match(/→ (\S+)/)
  assert.ok(match)
  const body = await readFile(join(root, match[1]), 'utf8')
  assert.equal(body.length, SPILL_THRESHOLD + 10)
})

test('mixed exclusive batch runs barrier after parallel-safe calls', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ext-cli-'))
  const session = createSession({ prompt: 'x', workspacePath: root })
  const results = await executeToolCalls(
    [
      { id: 'a', name: 'unknown-read' },
      { id: 'b', name: 'unknown-read' },
      { id: 'sh', name: 'shell', function: { name: 'shell', arguments: JSON.stringify({ command: 'echo barrier' }) } },
      { id: 'c', name: 'unknown-read' },
    ],
    { ctx: { session, model: 'gpt-4o-mini' } },
  )
  assert.deepEqual(results.map(item => item.id), ['a', 'b', 'sh', 'c'])
  assert.match(results[2].content, /barrier/)
})

test('fs and shell fail closed without workspacePath', async () => {
  await assert.rejects(() => runFs({ action: 'write', path: 'x', content: 'z' }, ''), /workspacePath/)
  const { runShell } = await import('../tools/shell.js')
  await assert.rejects(() => runShell('echo hi', ''), /workspacePath/)
})

test('runFs rejects escaped write', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ext-cli-'))
  await assert.rejects(() => runFs({ action: 'write', path: '../x.txt', content: 'nope' }, root), /escapes/)
})

test('session_query reads the log not only the surface', () => {
  const session = createSession({ prompt: 'alpha', workspacePath: '' })
  session.log.push({ seq: 99, type: 'tool/result', at: new Date().toISOString(), data: { preview: 'hidden-beta' } })
  const hit = querySession(session, 'hidden-beta')
  assert.match(hit, /hidden-beta/)
})

test('pool of 25 parallel-safe tools preserves order at maxParallel 10', async () => {
  assert.equal(MAX_PARALLEL, 10)
  const calls = Array.from({ length: 25 }, (_, i) => ({ id: `p${i}`, name: 'unknown-read' }))
  const results = await executeToolCalls(calls, { maxParallel: 10 })
  assert.deepEqual(
    results.map((item) => item.id),
    calls.map((call) => call.id),
  )
})
