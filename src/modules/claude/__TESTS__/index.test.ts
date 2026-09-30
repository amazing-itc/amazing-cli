import assert from 'node:assert/strict'
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, test } from 'node:test'
import type { StartInput } from '../../../core/provider.js'
import type { EventType, RunRecord } from '../../../core/types.js'
import { expandArgv } from '../../spawn/argv.js'
import { loadBundledManifest } from '../../spawn/manifest.js'
import { createClaudeProvider } from '../index.js'

function buildClaudeArgs(run: RunRecord, workspaceDir: string): string[] {
  return expandArgv(loadBundledManifest('claude'), {
    prompt: run.prompt,
    workspace: workspaceDir,
    model: run.modelId,
    resume: run.sessionRef,
    mode: run.mode,
  })
}

const ENV_KEYS = ['PATH', 'CURSOR_API_KEY', 'FAKE_SIDE', 'FAKE_FIXTURE', 'FAKE_HANG', 'AMAZING_CLI_CLAUDE_ALLOWED_TOOLS'] as const
const saved = new Map<string, string | undefined>()
for (const key of ENV_KEYS) saved.set(key, process.env[key])

const temps: string[] = []
afterEach(() => {
  for (const key of ENV_KEYS) {
    const v = saved.get(key)
    if (v === undefined) delete process.env[key]
    else process.env[key] = v
  }
  while (temps.length) rmSync(temps.pop()!, { recursive: true, force: true })
})

function tmp(prefix: string): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), prefix))
  temps.push(dir)
  return dir
}

const FAKE_SCRIPT = `#!/usr/bin/env node
const fs = require('fs')
const side = process.env.FAKE_SIDE
if (side) {
  fs.writeFileSync(side, JSON.stringify({
    argv: process.argv.slice(2),
    env: {
      ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY ?? null,
      HOME: process.env.HOME ?? null,
      CURSOR_API_KEY: process.env.CURSOR_API_KEY ?? null,
    },
  }))
}
if (process.env.FAKE_HANG) {
  console.log(JSON.stringify({ type: 'system', subtype: 'init', session_id: 'hang-sess' }))
  setInterval(() => {}, 1000)
} else if (process.env.FAKE_FIXTURE) {
  process.stdout.write(fs.readFileSync(process.env.FAKE_FIXTURE, 'utf8'))
}
`

const FIXTURE = [
  { type: 'system', subtype: 'init', session_id: 'sess-claude-1', model: 'claude-sonnet-4' },
  { type: 'assistant', message: { content: [{ type: 'text', text: 'Hello' }] } },
  { type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: ' world' } } },
  { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'tu1', name: 'Read', input: { path: 'a.txt' } }] } },
  { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'tu1', content: 'file contents' }] } },
  { type: 'result', usage: { input_tokens: 11, output_tokens: 22 }, total_cost_usd: 0.01 },
]
  .map((row) => JSON.stringify(row))
  .join('\n') + '\n'

const VERBOSE_PARTIALS = path.join(import.meta.dirname, '..', 'fixtures', 'verbose-partials.jsonl')

function installFakeClaude(fixturePath?: string): { binDir: string; side: string; fixture: string } {
  const binDir = tmp('claude-bin-')
  writeFileSync(path.join(binDir, 'claude'), FAKE_SCRIPT, { encoding: 'utf8' })
  chmodSync(path.join(binDir, 'claude'), 0o755)
  const work = tmp('claude-work-')
  const side = path.join(work, 'side.json')
  const fixture = fixturePath ?? path.join(work, 'fixture.jsonl')
  if (!fixturePath) writeFileSync(fixture, FIXTURE)
  process.env.PATH = `${binDir}${path.delimiter}${process.env.PATH ?? ''}`
  process.env.FAKE_SIDE = side
  process.env.FAKE_FIXTURE = fixture
  delete process.env.FAKE_HANG
  return { binDir, side, fixture }
}

function makeRun(partial: Partial<RunRecord> = {}): RunRecord {
  return {
    id: 'r1',
    product: 'aw',
    family: 'claude',
    status: 'RUNNING',
    workspaceDir: '/tmp/ws',
    prompt: 'hello claude',
    createdAt: new Date().toISOString(),
    lastSeq: 0,
    ...partial,
  }
}

function makeInput(
  workspaceDir: string,
  homeDir: string,
  signal: AbortSignal,
  run: RunRecord = makeRun({ workspaceDir }),
): { input: StartInput; events: Array<{ type: EventType; data: unknown }> } {
  const events: Array<{ type: EventType; data: unknown }> = []
  const input: StartInput = {
    run,
    workspaceDir,
    homeDir,
    credentialSecret: 'sk-ant-secret',
    signal,
    emit: (type, data) => events.push({ type, data }),
  }
  return { input, events }
}

function readSide(side: string): { argv: string[]; env: { ANTHROPIC_API_KEY: string | null; HOME: string | null; CURSOR_API_KEY: string | null } } {
  return JSON.parse(readFileSync(side, 'utf8'))
}

test('capabilities default allowedTools and health follows PATH existsSync', async () => {
  const p = createClaudeProvider()
  assert.deepEqual(p.capabilities(), {
    family: 'claude',
    streaming: true,
    resume: true,
    models: 'static',
    permissions: ['Read', 'Edit', 'Write', 'Bash', 'Grep', 'Glob'],
    binary: 'claude',
  })
  installFakeClaude()
  assert.deepEqual(await p.health(), { available: true })
  process.env.PATH = tmp('claude-empty-')
  assert.deepEqual(await p.health(), { available: false, detail: 'cli_not_found' })
})

test('buildClaudeArgs is exact; model and resume optional; prompt last', () => {
  const ws = '/data/ws'
  assert.deepEqual(buildClaudeArgs(makeRun({ prompt: 'p' }), ws), [
    '-p',
    '--output-format',
    'stream-json',
    '--verbose',
    '--include-partial-messages',
    '--add-dir',
    ws,
    '--allowedTools',
    'Read,Edit,Write,Bash,Grep,Glob',
    'p',
  ])
  assert.deepEqual(buildClaudeArgs(makeRun({ prompt: 'p', modelId: 'sonnet', sessionRef: 'sess-prev' }), ws), [
    '-p',
    '--output-format',
    'stream-json',
    '--verbose',
    '--include-partial-messages',
    '--add-dir',
    ws,
    '--allowedTools',
    'Read,Edit,Write,Bash,Grep,Glob',
    '--model',
    'sonnet',
    '--resume',
    'sess-prev',
    'p',
  ])
  process.env.AMAZING_CLI_CLAUDE_ALLOWED_TOOLS = 'Read,Bash'
  const overridden = buildClaudeArgs(makeRun({ prompt: 'p' }), ws)
  assert.equal(overridden[overridden.indexOf('--allowedTools') + 1], 'Read,Bash')
  assert.deepEqual(createClaudeProvider().capabilities().permissions, ['Read', 'Bash'])
})

test('buildClaudeArgs mode ask|plan → Read,Grep,Glob only; agent/omitted keep default tools', () => {
  const ws = '/data/ws'
  const ask = buildClaudeArgs(makeRun({ prompt: 'p', mode: 'ask' }), ws)
  assert.equal(ask[ask.indexOf('--allowedTools') + 1], 'Read,Grep,Glob')
  assert.equal(ask.at(-1), 'p')
  assert.ok(!ask.includes('Edit') && !ask.some((a) => a.includes('Edit')))
  assert.ok(!ask.some((a) => a.includes('Write') || a.includes('Bash')))

  const plan = buildClaudeArgs(makeRun({ prompt: 'p', mode: 'plan' }), ws)
  assert.equal(plan[plan.indexOf('--allowedTools') + 1], 'Read,Grep,Glob')
  const planPrompt = plan.at(-1)!
  assert.ok(planPrompt.includes('p'))
  assert.match(planPrompt, /plan/i)
  assert.match(planPrompt, /not (apply|make|perform).*(edit|change)/i)

  const agent = buildClaudeArgs(makeRun({ prompt: 'p', mode: 'agent' }), ws)
  assert.equal(agent[agent.indexOf('--allowedTools') + 1], 'Read,Edit,Write,Bash,Grep,Glob')
  assert.equal(agent.at(-1), 'p')

  const omitted = buildClaudeArgs(makeRun({ prompt: 'p' }), ws)
  assert.equal(omitted[omitted.indexOf('--allowedTools') + 1], 'Read,Edit,Write,Bash,Grep,Glob')
  assert.equal(omitted.at(-1), 'p')
})

test('start: flags exact, prompt last, ANTHROPIC_API_KEY=secret, CURSOR_API_KEY stripped, HOME=homeDir, events from fixture', async () => {
  const { side } = installFakeClaude()
  process.env.CURSOR_API_KEY = 'LEAK'
  const workspaceDir = tmp('claude-ws-')
  const homeDir = tmp('claude-home-')
  const p = createClaudeProvider()
  const { input, events } = makeInput(workspaceDir, homeDir, new AbortController().signal)
  const result = await p.start(input)

  const dumped = readSide(side)
  assert.deepEqual(dumped.argv, [
    '-p',
    '--output-format',
    'stream-json',
    '--verbose',
    '--include-partial-messages',
    '--add-dir',
    workspaceDir,
    '--allowedTools',
    'Read,Edit,Write,Bash,Grep,Glob',
    'hello claude',
  ])
  assert.equal(dumped.argv.at(-1), 'hello claude')
  assert.equal(dumped.env.ANTHROPIC_API_KEY, 'sk-ant-secret')
  assert.equal(dumped.env.CURSOR_API_KEY, null)
  assert.equal(dumped.env.HOME, homeDir)
  assert.equal(process.env.CURSOR_API_KEY, 'LEAK', 'parent env must keep the leak seed')

  assert.deepEqual(result, {
    status: 'SUCCEEDED',
    sessionRef: 'sess-claude-1',
    usage: { inputTokens: 11, outputTokens: 22, costUsd: 0.01 },
  })
  assert.deepEqual(
    events.map((e) => e.type),
    ['system/init', 'assistant/delta', 'assistant/delta', 'tool/call', 'tool/result'],
  )
  assert.deepEqual(events[0].data, { sessionRef: 'sess-claude-1', model: 'claude-sonnet-4' })
  assert.deepEqual(events[1].data, { text: 'Hello' })
  assert.deepEqual(events[2].data, { text: ' world' })
  assert.deepEqual(events[3].data, { name: 'Read', args: { path: 'a.txt' }, id: 'tu1' })
  assert.deepEqual(events[4].data, { content: 'file contents', id: 'tu1' })
  assert.ok(!events.some((e) => e.type.startsWith('run/')), 'provider must not emit run/* events')
})

test('start passes --model and --resume before the prompt', async () => {
  const { side } = installFakeClaude()
  const workspaceDir = tmp('claude-ws-')
  const homeDir = tmp('claude-home-')
  const run = makeRun({ workspaceDir, modelId: 'opus', sessionRef: 'sess-prev', prompt: 'continue' })
  const { input } = makeInput(workspaceDir, homeDir, new AbortController().signal, run)
  await createClaudeProvider().start(input)
  const dumped = readSide(side)
  assert.deepEqual(dumped.argv.slice(-5), ['--model', 'opus', '--resume', 'sess-prev', 'continue'])
})

test('missing binary → health unavailable and start FAILED cli_not_found', async () => {
  process.env.PATH = tmp('claude-empty-')
  const p = createClaudeProvider()
  assert.deepEqual(await p.health(), { available: false, detail: 'cli_not_found' })
  const workspaceDir = tmp('claude-ws-')
  const { input } = makeInput(workspaceDir, tmp('claude-home-'), new AbortController().signal)
  const result = await p.start(input)
  assert.equal(result.status, 'FAILED')
  assert.equal(result.error?.code, 'cli_not_found')
})

test('verbose+partials fixture: complete assistant text is emitted once, not twice', async () => {
  installFakeClaude(VERBOSE_PARTIALS)
  const { input, events } = makeInput(tmp('claude-ws-'), tmp('claude-home-'), new AbortController().signal)
  const result = await createClaudeProvider().start(input)
  const joined = events.filter((e) => e.type === 'assistant/delta').map((e) => (e.data as { text: string }).text).join('')
  assert.equal(joined, 'Hello world')
  assert.equal(joined.indexOf('Hello world'), joined.lastIndexOf('Hello world'))
  assert.equal(result.status, 'SUCCEEDED')
  assert.equal(result.sessionRef, 'sess-claude-1')
  assert.deepEqual(result.usage, { inputTokens: 11, outputTokens: 22, costUsd: 0.01 })
})

test('hang + abort → CANCELLED promptly', async () => {
  installFakeClaude()
  process.env.FAKE_HANG = '1'
  const ac = new AbortController()
  const { input, events } = makeInput(tmp('claude-ws-'), tmp('claude-home-'), ac.signal)
  const started = createClaudeProvider().start(input)
  const tWait = Date.now()
  while (!events.some((e) => e.type === 'system/init') && Date.now() - tWait < 2000) {
    await new Promise((r) => setTimeout(r, 10))
  }
  assert.deepEqual(events[0]?.data, { sessionRef: 'hang-sess' })
  const t0 = Date.now()
  ac.abort()
  const result = await started
  assert.deepEqual(result, { status: 'CANCELLED' })
  assert.ok(Date.now() - t0 < 1000, `took ${Date.now() - t0}ms`)
})
