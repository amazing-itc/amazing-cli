import assert from 'node:assert/strict'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import type { StartInput } from '../../../core/provider.js'
import type { EventType, RunMode, RunRecord } from '../../../core/types.js'
import { expandArgv } from '../../spawn/argv.js'
import { loadBundledManifest } from '../../spawn/manifest.js'
import { createCursorProvider, resolveCursorInvoke } from '../index.js'

function buildCursorArgs(input: {
  workspaceDir: string
  prompt: string
  modelId?: string
  sessionRef?: string
  indexJs?: string | null
  mode?: RunMode
  approveMcps?: boolean
}): string[] {
  return expandArgv(loadBundledManifest('cursor'), {
    prompt: input.prompt,
    workspace: input.workspaceDir,
    model: input.modelId,
    resume: input.sessionRef,
    mode: input.mode,
    indexJs: input.indexJs,
    approveMcps: input.approveMcps,
  })
}

const FIXTURE = fileURLToPath(new URL('../fixtures/stream.ndjson', import.meta.url))
const HANG_FIXTURE_BODY = '{"type":"system","subtype":"init","session_id":"sess-hang","model":"gpt-5"}\n'

const FAKE_AGENT = `#!/usr/bin/env node
const { readFileSync, writeFileSync } = require('node:fs')
const side = process.env.FAKE_SIDE
if (side) {
  writeFileSync(side, JSON.stringify({
    argv: process.argv.slice(1),
    env: {
      CURSOR_API_KEY: process.env.CURSOR_API_KEY,
      HOME: process.env.HOME,
      ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
    },
  }))
}
const fixture = process.env.FAKE_FIXTURE
if (fixture) {
  for (const line of readFileSync(fixture, 'utf8').split('\\n')) {
    if (line.length) console.log(line)
  }
}
if (process.env.FAKE_HANG) setInterval(() => {}, 1000)
`

const tmpDirs: string[] = []
const envKeys = ['HOME', 'PATH', 'ANTHROPIC_API_KEY', 'CURSOR_API_KEY', 'FAKE_SIDE', 'FAKE_FIXTURE', 'FAKE_HANG', 'CURSOR_AGENT_VERSIONS_ROOT'] as const
const origEnv: Record<string, string | undefined> = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]))

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  for (const key of envKeys) {
    if (origEnv[key] === undefined) delete process.env[key]
    else process.env[key] = origEnv[key]
  }
})

function tmp(prefix: string): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), prefix))
  tmpDirs.push(dir)
  return dir
}

function setEnv(key: (typeof envKeys)[number], value: string | undefined): void {
  if (value === undefined) delete process.env[key]
  else process.env[key] = value
}

function isolateLookupHome(): string {
  const home = tmp('cursor-lookup-')
  setEnv('HOME', home)
  setEnv('CURSOR_AGENT_VERSIONS_ROOT', undefined)
  return home
}

function installFakeAgent(): { binDir: string; agentPath: string } {
  const binDir = tmp('cursor-bin-')
  const agentPath = path.join(binDir, 'agent')
  writeFileSync(agentPath, FAKE_AGENT)
  chmodSync(agentPath, 0o755)
  setEnv('PATH', `${binDir}${path.delimiter}${origEnv.PATH ?? ''}`)
  return { binDir, agentPath }
}

function makeRun(partial: Partial<RunRecord> = {}): RunRecord {
  return {
    id: 'r1',
    product: 'aw',
    family: 'cursor',
    status: 'RUNNING',
    workspaceDir: '/tmp/ws',
    prompt: 'do the thing',
    createdAt: '2026-01-01T00:00:00.000Z',
    lastSeq: 0,
    ...partial,
  }
}

function makeInput(
  partial: Partial<RunRecord> = {},
  dirs?: { workspaceDir?: string; homeDir?: string; mcpServers?: StartInput['mcpServers'] },
): { input: StartInput; events: Array<{ type: EventType; data: unknown }> } {
  const events: Array<{ type: EventType; data: unknown }> = []
  const workspaceDir = dirs?.workspaceDir ?? tmp('cursor-ws-')
  const homeDir = dirs?.homeDir ?? tmp('cursor-home-')
  const input: StartInput = {
    run: makeRun({ workspaceDir, ...partial }),
    workspaceDir,
    homeDir,
    credentialSecret: 'sk-cursor-test',
    mcpServers: dirs?.mcpServers,
    signal: new AbortController().signal,
    emit: (type, data) => events.push({ type, data }),
  }
  return { input, events }
}

function readSidecar(side: string): { argv: string[]; env: { CURSOR_API_KEY?: string; HOME?: string; ANTHROPIC_API_KEY?: string } } {
  return JSON.parse(readFileSync(side, 'utf8')) as {
    argv: string[]
    env: { CURSOR_API_KEY?: string; HOME?: string; ANTHROPIC_API_KEY?: string }
  }
}

test('buildCursorArgs: exact headless flags, model, resume, prompt last; indexJs prefixed', () => {
  assert.deepEqual(buildCursorArgs({ workspaceDir: '/ws', prompt: 'p' }), [
    '-p',
    '--trust',
    '--force',
    '--approve-mcps',
    '--workspace',
    '/ws',
    '--output-format',
    'stream-json',
    '--stream-partial-output',
    'p',
  ])
  assert.deepEqual(buildCursorArgs({ workspaceDir: '/ws', prompt: 'p', modelId: 'm', sessionRef: 's' }), [
    '-p',
    '--trust',
    '--force',
    '--approve-mcps',
    '--workspace',
    '/ws',
    '--output-format',
    'stream-json',
    '--stream-partial-output',
    '--model',
    'm',
    '--resume',
    's',
    'p',
  ])
  assert.deepEqual(buildCursorArgs({ workspaceDir: '/ws', prompt: 'p', indexJs: '/x/index.js' }), [
    '/x/index.js',
    '-p',
    '--trust',
    '--force',
    '--approve-mcps',
    '--workspace',
    '/ws',
    '--output-format',
    'stream-json',
    '--stream-partial-output',
    'p',
  ])
})

test('buildCursorArgs: ask --mode=ask without --force; plan --mode=plan without --force; agent/--force as today', () => {
  const baseTail = [
    '--approve-mcps',
    '--workspace',
    '/ws',
    '--output-format',
    'stream-json',
    '--stream-partial-output',
    'p',
  ]
  assert.deepEqual(buildCursorArgs({ workspaceDir: '/ws', prompt: 'p', mode: 'ask' }), [
    '-p',
    '--trust',
    '--mode=ask',
    ...baseTail,
  ])
  assert.ok(!buildCursorArgs({ workspaceDir: '/ws', prompt: 'p', mode: 'ask' }).includes('--force'))
  assert.deepEqual(buildCursorArgs({ workspaceDir: '/ws', prompt: 'p', mode: 'plan' }), [
    '-p',
    '--trust',
    '--mode=plan',
    ...baseTail,
  ])
  assert.ok(!buildCursorArgs({ workspaceDir: '/ws', prompt: 'p', mode: 'plan' }).includes('--force'))
  assert.deepEqual(buildCursorArgs({ workspaceDir: '/ws', prompt: 'p', mode: 'agent' }), [
    '-p',
    '--trust',
    '--force',
    ...baseTail,
  ])
  assert.ok(!buildCursorArgs({ workspaceDir: '/ws', prompt: 'p', mode: 'agent' }).includes('--mode=agent'))
  assert.deepEqual(buildCursorArgs({ workspaceDir: '/ws', prompt: 'p' }), [
    '-p',
    '--trust',
    '--force',
    ...baseTail,
  ])
})

test('capabilities, health, happy path flags/env/events/usage', async () => {
  isolateLookupHome()
  installFakeAgent()
  const side = path.join(tmp('cursor-side-'), 'side.json')
  setEnv('FAKE_SIDE', side)
  setEnv('FAKE_FIXTURE', FIXTURE)
  setEnv('ANTHROPIC_API_KEY', 'LEAK')
  setEnv('CURSOR_API_KEY', 'PARENT-CURSOR-KEY')

  const p = createCursorProvider()
  assert.deepEqual(p.capabilities(), {
    family: 'cursor',
    streaming: true,
    resume: true,
    models: 'static',
    permissions: ['--trust', '--force', '--approve-mcps'],
    binary: 'agent',
  })
  assert.deepEqual(await p.health(), { available: true })
  assert.equal(resolveCursorInvoke().command, 'agent')
  assert.equal(resolveCursorInvoke().indexJs, null)

  const { input, events } = makeInput({ prompt: 'do the thing' })
  const parentKeyBefore = process.env.CURSOR_API_KEY
  const result = await p.start(input)
  assert.equal(process.env.CURSOR_API_KEY, parentKeyBefore)
  assert.equal(process.env.CURSOR_API_KEY, 'PARENT-CURSOR-KEY')
  const sidecar = readSidecar(side)
  const argv = sidecar.argv
  const expectedHead = [
    '-p',
    '--trust',
    '--force',
    '--approve-mcps',
    '--workspace',
    input.workspaceDir,
    '--output-format',
    'stream-json',
    '--stream-partial-output',
  ]
  const flagStart = argv.indexOf('-p')
  assert.ok(flagStart >= 0)
  assert.deepEqual(argv.slice(flagStart, flagStart + expectedHead.length), expectedHead)
  assert.equal(argv.at(-1), 'do the thing')
  assert.equal(sidecar.env.CURSOR_API_KEY, 'sk-cursor-test')
  assert.equal(sidecar.env.ANTHROPIC_API_KEY, undefined)
  assert.equal(sidecar.env.HOME, input.homeDir)
  assert.deepEqual(
    events.map((e) => e.type),
    ['system/init', 'assistant/delta', 'assistant/delta', 'log/line', 'assistant/thinking', 'tool/call', 'tool/result'],
  )
  assert.ok(!events.some((e) => e.type.startsWith('run/')), 'provider must not emit run/*')
  assert.deepEqual(events[0].data, { sessionRef: 'sess-cursor-1', model: 'gpt-5' })
  const deltas = events.filter((e) => e.type === 'assistant/delta').map((e) => (e.data as { text: string }).text)
  assert.deepEqual(deltas, ['Hello', ' from cursor'])
  assert.equal(deltas.join(''), 'Hello from cursor')
  const logs = events.filter((e) => e.type === 'log/line').map((e) => e.data as { level: string; text: string })
  assert.deepEqual(logs, [{ level: 'info', text: 'not a json line from the cli' }])
  assert.deepEqual(events[4].data, { text: 'planning the next step' })
  assert.deepEqual(events[5].data, { name: 'readToolCall', args: { path: 'README.md' }, id: undefined })
  assert.deepEqual(events[6].data, { name: 'readToolCall', content: 'ok', id: undefined })
  assert.deepEqual(result, {
    status: 'SUCCEEDED',
    sessionRef: 'sess-cursor-1',
    usage: { inputTokens: 11, outputTokens: 22 },
  })
})

test('--resume when run.sessionRef set; --model when modelId set', async () => {
  isolateLookupHome()
  installFakeAgent()
  const side = path.join(tmp('cursor-side-'), 'side.json')
  setEnv('FAKE_SIDE', side)
  setEnv('FAKE_FIXTURE', FIXTURE)
  setEnv('ANTHROPIC_API_KEY', 'LEAK')

  const { input } = makeInput({ sessionRef: 'chat-9', modelId: 'gpt-5', prompt: 'continue' })
  const result = await createCursorProvider().start(input)
  assert.equal(result.status, 'SUCCEEDED')
  const argv = readSidecar(side).argv
  const resumeAt = argv.indexOf('--resume')
  const modelAt = argv.indexOf('--model')
  assert.ok(modelAt >= 0 && argv[modelAt + 1] === 'gpt-5')
  assert.ok(resumeAt >= 0 && argv[resumeAt + 1] === 'chat-9')
  assert.ok(modelAt < resumeAt)
  assert.equal(argv.at(-1), 'continue')
})

test('start ask mode: --mode=ask without --force; plan: --mode=plan without --force', async () => {
  isolateLookupHome()
  installFakeAgent()
  setEnv('FAKE_FIXTURE', FIXTURE)

  for (const mode of ['ask', 'plan'] as const) {
    const side = path.join(tmp('cursor-side-'), `side-${mode}.json`)
    setEnv('FAKE_SIDE', side)
    const { input } = makeInput({ mode, prompt: `${mode} turn` })
    const result = await createCursorProvider().start(input)
    assert.equal(result.status, 'SUCCEEDED')
    const argv = readSidecar(side).argv
    assert.ok(argv.includes(`--mode=${mode}`), `${mode} argv missing --mode=${mode}: ${argv.join(' ')}`)
    assert.ok(!argv.includes('--force'), `${mode} argv must not include --force: ${argv.join(' ')}`)
    assert.equal(argv.at(-1), `${mode} turn`)
  }
})

test('missing binary: health unavailable; start FAILED cli_not_found', async () => {
  setEnv('HOME', '')
  setEnv('PATH', '')
  setEnv('CURSOR_AGENT_VERSIONS_ROOT', undefined)
  const p = createCursorProvider()
  assert.equal(resolveCursorInvoke().command, 'agent')
  assert.deepEqual(await p.health(), { available: false, detail: 'cli_not_found' })
  const { input } = makeInput()
  const result = await p.start(input)
  assert.equal(result.status, 'FAILED')
  assert.equal(result.error?.code, 'cli_not_found')
})

test('start materializes mcpServers into isolated HOME and restores project mcp.json', async () => {
  isolateLookupHome()
  installFakeAgent()
  setEnv('FAKE_FIXTURE', FIXTURE)
  const ws = tmp('cursor-mcp-ws-')
  const home = tmp('cursor-mcp-home-')
  mkdirSync(path.join(ws, '.cursor'), { recursive: true })
  const project = path.join(ws, '.cursor', 'mcp.json')
  const original = `${JSON.stringify({ mcpServers: { board: { command: 'node', args: ['launcher.mjs'] } } })}\n`
  writeFileSync(project, original)
  const token = 'run-header-token-zz'
  const { input } = makeInput({}, {
    workspaceDir: ws,
    homeDir: home,
    mcpServers: [{ name: 'board', url: 'http://mcp.test/mcp', headers: { 'X-Run-Token': token } }],
  })
  const result = await createCursorProvider().start(input)
  assert.equal(result.status, 'SUCCEEDED')
  const homeCfg = JSON.parse(readFileSync(path.join(home, '.cursor', 'mcp.json'), 'utf8')) as {
    mcpServers: { board: { url: string; headers: { 'X-Run-Token': string } } }
  }
  assert.equal(homeCfg.mcpServers.board.url, 'http://mcp.test/mcp')
  assert.equal(homeCfg.mcpServers.board.headers['X-Run-Token'], token)
  assert.equal(readFileSync(project, 'utf8'), original)
  assert.ok(!readFileSync(project, 'utf8').includes(token))
})

test('abort after init returns CANCELLED promptly', async () => {
  isolateLookupHome()
  installFakeAgent()
  const hangFixture = path.join(tmp('cursor-hang-'), 'init.ndjson')
  writeFileSync(hangFixture, HANG_FIXTURE_BODY)
  setEnv('FAKE_FIXTURE', hangFixture)
  setEnv('FAKE_HANG', '1')
  setEnv('FAKE_SIDE', path.join(tmp('cursor-side-'), 'side.json'))

  const ac = new AbortController()
  const { input, events } = makeInput()
  input.signal = ac.signal
  const started = createCursorProvider().start(input)
  // Wait for the fake agent's init line instead of a fixed sleep: under full-suite load the spawn can take > 50 ms.
  const deadline = Date.now() + 5000
  while (events[0]?.type !== 'system/init' && Date.now() < deadline) await new Promise((r) => setTimeout(r, 10))
  const t0 = Date.now()
  ac.abort()
  const result = await started
  assert.deepEqual(result, { status: 'CANCELLED' })
  assert.ok(Date.now() - t0 < 1000, `took ${Date.now() - t0}ms`)
  assert.equal(events[0]?.type, 'system/init')
})
