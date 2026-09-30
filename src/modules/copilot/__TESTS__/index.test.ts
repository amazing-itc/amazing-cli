import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import type { StartInput } from '../../../core/provider.js'
import type { EventType, RunRecord } from '../../../core/types.js'
import { expandArgv } from '../../spawn/argv.js'
import { loadBundledManifest } from '../../spawn/manifest.js'
import { createCopilotProvider } from '../index.js'

function buildCopilotArgs(run: RunRecord): string[] {
  return expandArgv(loadBundledManifest('copilot'), {
    prompt: run.prompt,
    workspace: '',
    model: run.modelId,
    resume: run.sessionRef,
    mode: run.mode,
  })
}

const FIXTURE = readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'session.jsonl'), 'utf8')

const ENV_KEYS = ['PATH', 'AMAZING_CLI_COPILOT_ALLOW_TOOLS', 'GITHUB_TOKEN', 'GH_TOKEN', 'COPILOT_GITHUB_TOKEN'] as const
const saved: Record<string, string | undefined> = {}
const tmpDirs: string[] = []

beforeEach(() => {
  for (const key of ENV_KEYS) saved[key] = process.env[key]
  delete process.env.AMAZING_CLI_COPILOT_ALLOW_TOOLS
})

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (saved[key] === undefined) delete process.env[key]
    else process.env[key] = saved[key]
  }
  for (const dir of tmpDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

const tmp = (prefix: string) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), prefix))
  tmpDirs.push(dir)
  return dir
}

function installFake(opts: { hang?: boolean; fixture?: string } = {}): { binDir: string; sidecar: string; ws: string; home: string } {
  const binDir = tmp('copilot-bin-')
  const ws = tmp('copilot-ws-')
  const home = tmp('copilot-home-')
  const sidecar = path.join(tmp('copilot-side-'), 'sidecar.json')
  mkdirSync(path.dirname(sidecar), { recursive: true })
  const script = opts.hang
    ? `#!/usr/bin/env node
process.stdout.write('up\\n');
setInterval(() => {}, 1000);
`
    : `#!/usr/bin/env node
const fs = require('node:fs');
fs.writeFileSync(${JSON.stringify(sidecar)}, JSON.stringify({
  argv: process.argv.slice(2),
  COPILOT_GITHUB_TOKEN: process.env.COPILOT_GITHUB_TOKEN ?? null,
  HOME: process.env.HOME ?? null,
  GITHUB_TOKEN: process.env.GITHUB_TOKEN ?? null,
  GH_TOKEN: process.env.GH_TOKEN ?? null,
}));
process.stdout.write(${JSON.stringify(opts.fixture ?? FIXTURE)});
`
  writeFileSync(path.join(binDir, 'copilot'), script, { mode: 0o755 })
  process.env.PATH = `${binDir}${path.delimiter}${process.env.PATH ?? ''}`
  return { binDir, sidecar, ws, home }
}

function makeRun(over: Partial<RunRecord> = {}): RunRecord {
  return {
    id: 'r1',
    product: 'aw',
    family: 'copilot',
    status: 'RUNNING',
    workspaceDir: '/tmp/ws',
    prompt: 'hello',
    createdAt: new Date().toISOString(),
    lastSeq: 0,
    ...over,
  }
}

function makeInput(over: { run?: Partial<RunRecord>; workspaceDir: string; homeDir: string; secret?: string; signal?: AbortSignal }): {
  input: StartInput
  events: Array<{ type: EventType; data: unknown }>
} {
  const events: Array<{ type: EventType; data: unknown }> = []
  const input: StartInput = {
    run: makeRun({ workspaceDir: over.workspaceDir, ...over.run }),
    workspaceDir: over.workspaceDir,
    homeDir: over.homeDir,
    credentialSecret: over.secret ?? 'secret',
    signal: over.signal ?? new AbortController().signal,
    emit: (type, data) => events.push({ type, data }),
  }
  return { input, events }
}

function readSidecar(file: string): {
  argv: string[]
  COPILOT_GITHUB_TOKEN: string | null
  HOME: string | null
  GITHUB_TOKEN: string | null
  GH_TOKEN: string | null
} {
  return JSON.parse(readFileSync(file, 'utf8'))
}

const waitFor = (pred: () => boolean, timeoutMs = 3000) =>
  new Promise<void>((resolve, reject) => {
    const t0 = Date.now()
    const i = setInterval(() => {
      if (pred()) {
        clearInterval(i)
        resolve()
      } else if (Date.now() - t0 > timeoutMs) {
        clearInterval(i)
        reject(new Error('timeout waiting for condition'))
      }
    }, 5)
  })

test('capabilities: copilot, streaming, resume, models static, default allow-tools, binary copilot', () => {
  const p = createCopilotProvider()
  assert.deepEqual(p.capabilities(), {
    family: 'copilot',
    streaming: true,
    resume: true,
    models: 'static',
    permissions: ['shell', 'write'],
    binary: 'copilot',
  })
})

test('buildCopilotArgs: -p prompt, json, --no-ask-user, per-tool --allow-tool, optional --model, --resume=<ref>', () => {
  assert.deepEqual(buildCopilotArgs(makeRun()), ['-p', 'hello', '--output-format', 'json', '--no-ask-user', '--allow-tool', 'shell', '--allow-tool', 'write'])
  assert.deepEqual(buildCopilotArgs(makeRun({ modelId: 'gpt-4.1', sessionRef: 'sess-prev' })), [
    '-p',
    'hello',
    '--output-format',
    'json',
    '--no-ask-user',
    '--allow-tool',
    'shell',
    '--allow-tool',
    'write',
    '--model',
    'gpt-4.1',
    '--resume=sess-prev',
  ])
  process.env.AMAZING_CLI_COPILOT_ALLOW_TOOLS = 'read, shell'
  assert.deepEqual(buildCopilotArgs(makeRun()), ['-p', 'hello', '--output-format', 'json', '--no-ask-user', '--allow-tool', 'read', '--allow-tool', 'shell'])
})

test('buildCopilotArgs: ask and plan omit shell/write allow-tools; plan prepends plan-only instruction; agent/omitted keep defaults', () => {
  const ask = buildCopilotArgs(makeRun({ mode: 'ask' }))
  assert.deepEqual(ask, ['-p', 'hello', '--output-format', 'json', '--no-ask-user'])
  assert.ok(!ask.includes('--allow-tool'))
  assert.ok(!ask.includes('shell'))
  assert.ok(!ask.includes('write'))

  const plan = buildCopilotArgs(makeRun({ mode: 'plan', prompt: 'ship it' }))
  assert.equal(plan[0], '-p')
  assert.match(plan[1]!, /plan/i)
  assert.match(plan[1]!, /must not apply edits/i)
  assert.ok(plan[1]!.includes('ship it'))
  assert.deepEqual(plan.slice(2), ['--output-format', 'json', '--no-ask-user'])
  assert.ok(!plan.includes('--allow-tool'))
  assert.ok(!plan.includes('shell'))
  assert.ok(!plan.includes('write'))

  assert.deepEqual(buildCopilotArgs(makeRun({ mode: 'agent' })), [
    '-p',
    'hello',
    '--output-format',
    'json',
    '--no-ask-user',
    '--allow-tool',
    'shell',
    '--allow-tool',
    'write',
  ])
  assert.deepEqual(buildCopilotArgs(makeRun()), [
    '-p',
    'hello',
    '--output-format',
    'json',
    '--no-ask-user',
    '--allow-tool',
    'shell',
    '--allow-tool',
    'write',
  ])

  process.env.AMAZING_CLI_COPILOT_ALLOW_TOOLS = 'read, shell, write'
  assert.deepEqual(buildCopilotArgs(makeRun({ mode: 'ask' })), [
    '-p',
    'hello',
    '--output-format',
    'json',
    '--no-ask-user',
    '--allow-tool',
    'read',
  ])
})

test('health follows PATH for copilot', async () => {
  const p = createCopilotProvider()
  const empty = tmp('copilot-empty-')
  process.env.PATH = empty
  assert.deepEqual(await p.health(), { available: false, detail: 'cli_not_found' })
  installFake()
  assert.deepEqual(await p.health(), { available: true })
})

test('start: fake PATH binary, sidecar argv/env, JSONL assistant + late result.sessionId', async () => {
  const { sidecar, ws, home } = installFake()
  process.env.GITHUB_TOKEN = 'leaked-github'
  process.env.GH_TOKEN = 'leaked-gh'
  process.env.COPILOT_GITHUB_TOKEN = 'leaked-copilot'
  const p = createCopilotProvider()
  const { input, events } = makeInput({ workspaceDir: ws, homeDir: home })
  const result = await p.start(input)

  assert.equal(result.status, 'SUCCEEDED')
  assert.equal(result.sessionRef, 'copilot-sess-1')
  assert.deepEqual(result.usage, { inputTokens: 10, outputTokens: 20 })

  const side = readSidecar(sidecar)
  assert.equal(side.argv[0], '-p')
  assert.equal(side.argv[1], 'hello')
  const fmt = side.argv.indexOf('--output-format')
  assert.ok(fmt >= 0)
  assert.equal(side.argv[fmt + 1], 'json')
  assert.ok(side.argv.includes('--no-ask-user'))
  assert.deepEqual(side.argv, buildCopilotArgs(input.run))
  assert.equal(side.COPILOT_GITHUB_TOKEN, 'secret')
  assert.equal(side.GITHUB_TOKEN, null)
  assert.equal(side.GH_TOKEN, null)
  assert.equal(side.HOME, home)

  assert.deepEqual(
    events.map((e) => e.type),
    ['assistant/delta', 'assistant/delta', 'tool/call', 'tool/result', 'system/init'],
  )
  assert.deepEqual(events[0].data, { text: 'Hello' })
  assert.deepEqual(events[1].data, { text: ' from copilot' })
  assert.deepEqual(events[2].data, { name: 'shell', args: { command: 'echo hi' } })
  assert.deepEqual(events[3].data, { name: 'shell', content: 'hi' })
  assert.deepEqual(events[4].data, { sessionRef: 'copilot-sess-1' })
  assert.ok(!events.some((e) => e.type.startsWith('run/')))
})

test('start: resume uses equals form --resume=<ref>', async () => {
  const { sidecar, ws, home } = installFake()
  const p = createCopilotProvider()
  const { input } = makeInput({ workspaceDir: ws, homeDir: home, run: { sessionRef: 'sess-prev', modelId: 'gpt-4.1' } })
  const result = await p.start(input)
  assert.equal(result.status, 'SUCCEEDED')
  const { argv } = readSidecar(sidecar)
  assert.ok(argv.includes('--resume=sess-prev'))
  assert.ok(!argv.includes('--resume'))
  assert.ok(!argv.includes('sess-prev'))
  const mi = argv.indexOf('--model')
  assert.equal(argv[mi + 1], 'gpt-4.1')
})

test('missing binary → cli_not_found and health unavailable', async () => {
  const empty = tmp('copilot-none-')
  process.env.PATH = empty
  const p = createCopilotProvider()
  assert.deepEqual(await p.health(), { available: false, detail: 'cli_not_found' })
  const ws = tmp('copilot-ws-')
  const home = tmp('copilot-home-')
  const { input } = makeInput({ workspaceDir: ws, homeDir: home })
  const result = await p.start(input)
  assert.equal(result.status, 'FAILED')
  assert.equal(result.error?.code, 'cli_not_found')
})

test('abort of a hanging copilot returns CANCELLED promptly', async () => {
  const { ws, home } = installFake({ hang: true })
  const p = createCopilotProvider()
  const ac = new AbortController()
  const { input, events } = makeInput({ workspaceDir: ws, homeDir: home, signal: ac.signal })
  const started = p.start(input)
  await waitFor(() => events.some((e) => e.type === 'log/line' && (e.data as { text: string }).text === 'up'))
  const t0 = Date.now()
  ac.abort()
  const result = await started
  assert.equal(result.status, 'CANCELLED')
  assert.ok(Date.now() - t0 < 1000, `took ${Date.now() - t0}ms`)
})
