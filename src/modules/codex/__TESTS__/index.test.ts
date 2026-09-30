import assert from 'node:assert/strict'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { RunFailure } from '../../../core/errors.js'
import type { StartInput } from '../../../core/provider.js'
import type { EventType, RunRecord } from '../../../core/types.js'
import { expandArgv } from '../../spawn/argv.js'
import { loadBundledManifest } from '../../spawn/manifest.js'
import { writeCodexApiKeyAuth } from '../../spawn/parsers/codex.js'
import { createCodexProvider } from '../index.js'

function buildCodexArgs(run: RunRecord, workspaceDir: string): string[] {
  return expandArgv(loadBundledManifest('codex'), {
    prompt: run.prompt,
    workspace: workspaceDir,
    model: run.modelId,
    resume: run.sessionRef,
    mode: run.mode,
  })
}

const FIXTURE = fileURLToPath(new URL('../fixtures/session.ndjson', import.meta.url))
const FAILED_FIXTURE = fileURLToPath(new URL('../fixtures/turn-failed.ndjson', import.meta.url))
const SECRET = 'sk-codex-secret'
const FAKE_SCRIPT = `#!/usr/bin/env node
const fs = require('node:fs')
const side = process.env.FAKE_SIDE
if (side) {
  fs.writeFileSync(side, JSON.stringify({
    argv: process.argv.slice(2),
    env: {
      OPENAI_API_KEY: process.env.OPENAI_API_KEY,
      HOME: process.env.HOME,
      CURSOR_API_KEY: process.env.CURSOR_API_KEY,
    },
  }))
}
process.stderr.write('codex-warn\\n')
if (process.env.FAKE_HANG) {
  process.stdout.write(JSON.stringify({ type: 'thread.started', thread_id: 'hang-thread' }) + '\\n')
  setInterval(() => {}, 1000)
} else if (process.env.FAKE_FIXTURE) {
  process.stdout.write(fs.readFileSync(process.env.FAKE_FIXTURE))
}
`

const orig = {
  PATH: process.env.PATH,
  CURSOR_API_KEY: process.env.CURSOR_API_KEY,
  FAKE_SIDE: process.env.FAKE_SIDE,
  FAKE_FIXTURE: process.env.FAKE_FIXTURE,
  FAKE_HANG: process.env.FAKE_HANG,
}

function restoreEnv() {
  for (const [key, value] of Object.entries(orig)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
}

let tmp: string
let binDir: string
let workspaceDir: string
let homeDir: string
let sideFile: string
const tmpDirs: string[] = []

beforeEach(() => {
  tmp = mkdtempSync(path.join(os.tmpdir(), 'codex-mod-'))
  tmpDirs.push(tmp)
  binDir = path.join(tmp, 'bin')
  workspaceDir = path.join(tmp, 'ws')
  homeDir = path.join(tmp, 'home')
  sideFile = path.join(tmp, 'side.json')
  mkdirSync(binDir, { recursive: true })
  mkdirSync(workspaceDir, { recursive: true })
  mkdirSync(homeDir, { recursive: true })
  const bin = path.join(binDir, 'codex')
  writeFileSync(bin, FAKE_SCRIPT, { mode: 0o755 })
  chmodSync(bin, 0o755)
  process.env.PATH = `${binDir}${path.delimiter}${orig.PATH ?? ''}`
  process.env.CURSOR_API_KEY = 'LEAK'
  process.env.FAKE_SIDE = sideFile
  process.env.FAKE_FIXTURE = FIXTURE
  delete process.env.FAKE_HANG
})

afterEach(() => {
  restoreEnv()
  for (const dir of tmpDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function makeRun(over: Partial<RunRecord> = {}): RunRecord {
  return {
    id: 'r-codex',
    product: 'aw',
    family: 'codex',
    status: 'RUNNING',
    workspaceDir,
    prompt: 'do the thing',
    createdAt: new Date().toISOString(),
    lastSeq: 0,
    ...over,
  }
}

function makeInput(over: Partial<RunRecord> = {}, signal = new AbortController().signal): { input: StartInput; events: Array<{ type: EventType; data: unknown }> } {
  const events: Array<{ type: EventType; data: unknown }> = []
  const input: StartInput = {
    run: makeRun(over),
    workspaceDir,
    homeDir,
    credentialSecret: SECRET,
    signal,
    emit: (type, data) => events.push({ type, data }),
  }
  return { input, events }
}

function readSide(): { argv: string[]; env: { OPENAI_API_KEY?: string; HOME?: string; CURSOR_API_KEY?: string } } {
  return JSON.parse(readFileSync(sideFile, 'utf8')) as { argv: string[]; env: { OPENAI_API_KEY?: string; HOME?: string; CURSOR_API_KEY?: string } }
}

test('writeCodexApiKeyAuth mirrors codex login --with-api-key', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'codex-auth-'))
  try {
    await writeCodexApiKeyAuth(dir, 'sk-proj-test')
    const auth = JSON.parse(readFileSync(path.join(dir, '.codex', 'auth.json'), 'utf8')) as {
      auth_mode: string
      OPENAI_API_KEY: string
    }
    assert.deepEqual(auth, { auth_mode: 'apikey', OPENAI_API_KEY: 'sk-proj-test' })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('capabilities and health PATH lookup', async () => {
  const p = createCodexProvider()
  assert.deepEqual(p.capabilities(), {
    family: 'codex',
    streaming: true,
    resume: true,
    models: 'static',
    permissions: ['workspace-write'],
    binary: 'codex',
  })
  assert.deepEqual(await p.health(), { available: true })

  process.env.PATH = path.join(tmp, 'empty')
  assert.deepEqual(await p.health(), { available: false, detail: 'cli_not_found' })
})

test('new session flags, env injection/strip, fixture events and usage', async () => {
  const p = createCodexProvider()
  const { input, events } = makeInput()
  const result = await p.start(input)

  assert.deepEqual(result, {
    status: 'SUCCEEDED',
    sessionRef: '0199a213-81c0-7800-8aa1-bbab2a035a53',
    usage: { inputTokens: 24763, outputTokens: 122 },
  })

  const side = readSide()
  assert.deepEqual(side.argv, [
    'exec',
    '--json',
    '-C',
    workspaceDir,
    '--sandbox',
    'workspace-write',
    '--skip-git-repo-check',
    'do the thing',
  ])
  assert.deepEqual(buildCodexArgs(input.run, workspaceDir), side.argv)
  assert.equal(side.env.OPENAI_API_KEY, SECRET)
  assert.equal(side.env.HOME, homeDir)
  assert.equal(side.env.CURSOR_API_KEY, undefined)
  const auth = JSON.parse(readFileSync(path.join(homeDir, '.codex', 'auth.json'), 'utf8')) as {
    auth_mode: string
    OPENAI_API_KEY: string
  }
  assert.deepEqual(auth, { auth_mode: 'apikey', OPENAI_API_KEY: SECRET })

  const typed = events.filter((e) => e.type !== 'log/line')
  assert.deepEqual(
    typed.map((e) => e.type),
    ['system/init', 'tool/call', 'tool/result', 'tool/call', 'tool/result', 'assistant/delta', 'assistant/delta', 'tool/call', 'tool/result'],
  )
  assert.deepEqual(typed[0].data, { sessionRef: '0199a213-81c0-7800-8aa1-bbab2a035a53' })
  assert.deepEqual(typed[1].data, { name: 'command_execution', args: { command: 'bash -lc ls' }, id: 'item_1' })
  assert.deepEqual(typed[2].data, { name: 'command_execution', content: 'docs\nsrc\n', id: 'item_1' })
  assert.deepEqual(typed[3].data, { name: 'mcp_tool_call', args: { server: 'docs', tool: 'search', arguments: { q: 'exec --json' } }, id: 'item_5' })
  assert.deepEqual(typed[4].data, { name: 'mcp_tool_call', content: 'Found 3 matches.', id: 'item_5' })
  assert.deepEqual(typed[5].data, { text: 'Hello' })
  assert.deepEqual(typed[6].data, { text: ' from Codex' })
  assert.deepEqual(typed[7].data, { name: 'file_change', args: { changes: [{ path: 'docs/exec.md', kind: 'update' }] }, id: 'item_4' })
  assert.deepEqual(typed[8].data, { name: 'file_change', content: '[{"path":"docs/exec.md","kind":"update"}]', id: 'item_4' })
  assert.ok(
    events.some((e) => e.type === 'log/line' && (e.data as { level?: string; text?: string }).level === 'info' && (e.data as { text?: string }).text === '{"type":"turn.started"}'),
  )
  assert.ok(
    events.some((e) => e.type === 'log/line' && (e.data as { level?: string; text?: string }).level === 'info' && (e.data as { text?: string }).text === '{"type":"unknown"}'),
  )
  assert.ok(
    events.some((e) => e.type === 'log/line' && (e.data as { level?: string; text?: string }).level === 'warn' && (e.data as { text?: string }).text === 'codex-warn'),
  )
  assert.ok(!events.some((e) => e.type.startsWith('run/')), 'provider must not emit run/* events')
  assert.ok(!JSON.stringify({ events, result, side }).includes('LEAK'))
})

test('resume: exec resume <ref> --json, no -C, optional --model then prompt', async () => {
  const p = createCodexProvider()
  const { input } = makeInput({ sessionRef: 'thread-resume-1', modelId: 'gpt-5' })
  const expected = ['exec', 'resume', 'thread-resume-1', '--json', '--model', 'gpt-5', 'do the thing']
  assert.deepEqual(buildCodexArgs(input.run, workspaceDir), expected)
  assert.ok(!expected.includes('-C'))

  const result = await p.start(input)
  assert.equal(result.status, 'SUCCEEDED')
  const side = readSide()
  assert.deepEqual(side.argv, expected)
  assert.ok(!side.argv.includes('-C'))
  assert.ok(!side.argv.includes('--sandbox'))
  assert.ok(!side.argv.includes('workspace-write'))
  assert.ok(!side.argv.includes('--skip-git-repo-check'))
  assert.equal(side.env.OPENAI_API_KEY, SECRET)
  assert.equal(side.env.CURSOR_API_KEY, undefined)
})

test('mode ask/plan omit --sandbox workspace-write; plan prepends plan-only instruction; agent keeps write', () => {
  const ask = buildCodexArgs(makeRun({ mode: 'ask' }), workspaceDir)
  assert.deepEqual(ask, ['exec', '--json', '-C', workspaceDir, '--skip-git-repo-check', 'do the thing'])
  assert.ok(!ask.includes('--sandbox'))
  assert.ok(!ask.includes('workspace-write'))

  const plan = buildCodexArgs(makeRun({ mode: 'plan' }), workspaceDir)
  assert.equal(plan.at(-1), 'Reply with a plan only. Do not apply any edits.\n\ndo the thing')
  assert.deepEqual(plan.slice(0, -1), ['exec', '--json', '-C', workspaceDir, '--skip-git-repo-check'])
  assert.ok(!plan.includes('--sandbox'))
  assert.ok(!plan.includes('workspace-write'))

  const agent = buildCodexArgs(makeRun({ mode: 'agent' }), workspaceDir)
  assert.deepEqual(agent, [
    'exec',
    '--json',
    '-C',
    workspaceDir,
    '--sandbox',
    'workspace-write',
    '--skip-git-repo-check',
    'do the thing',
  ])
  assert.deepEqual(buildCodexArgs(makeRun(), workspaceDir), agent)
})

test('missing binary → health unavailable and start FAILED cli_not_found', async () => {
  process.env.PATH = path.join(tmp, 'no-codex')
  delete process.env.FAKE_SIDE
  const p = createCodexProvider()
  assert.deepEqual(await p.health(), { available: false, detail: 'cli_not_found' })
  const { input } = makeInput()
  const result = await p.start(input)
  assert.equal(result.status, 'FAILED')
  assert.equal(result.error?.code, 'cli_not_found')
  assert.equal(typeof result.error?.message, 'string')
})

test('abort hang → CANCELLED promptly', async () => {
  process.env.FAKE_HANG = '1'
  delete process.env.FAKE_FIXTURE
  const p = createCodexProvider()
  const ac = new AbortController()
  const { input, events } = makeInput({}, ac.signal)
  const started = p.start(input)
  await new Promise<void>((resolve) => {
    const i = setInterval(() => {
      if (events.some((e) => e.type === 'system/init')) {
        clearInterval(i)
        resolve()
      }
    }, 5)
  })
  const t0 = Date.now()
  ac.abort()
  const result = await started
  assert.deepEqual(result, { status: 'CANCELLED' })
  assert.ok(Date.now() - t0 < 1000, `took ${Date.now() - t0}ms`)
})

test('turn.failed → FAILED internal even when the CLI exits 0', async () => {
  process.env.FAKE_FIXTURE = FAILED_FIXTURE
  const p = createCodexProvider()
  const { input, events } = makeInput()
  const result = await p.start(input)
  assert.deepEqual(result, {
    status: 'FAILED',
    error: { code: 'internal', message: 'model response stream ended unexpectedly' },
    sessionRef: '0199a213-81c0-7800-8aa1-bbab2a035a53',
  })
  assert.deepEqual(
    events.filter((e) => e.type !== 'log/line').map((e) => e.type),
    ['system/init'],
  )
})

test('missing secret throws credential_missing before spawn', async () => {
  const p = createCodexProvider()
  const { input } = makeInput()
  delete (input as { credentialSecret?: string }).credentialSecret
  await assert.rejects(() => p.start(input), (err: unknown) => {
    assert.ok(err instanceof RunFailure)
    assert.equal(err.error.code, 'credential_missing')
    return true
  })
})
