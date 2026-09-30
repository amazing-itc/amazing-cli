import assert from 'node:assert/strict'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import type { StartInput } from '../../../core/provider.js'
import type { EventType, RunRecord } from '../../../core/types.js'
import { expandArgv } from '../../spawn/argv.js'
import { loadBundledManifest } from '../../spawn/manifest.js'
import { writeAntigravitySettings } from '../../spawn/parsers/antigravity.js'
import { createAntigravityProvider } from '../index.js'

function buildAntigravityArgs(run: RunRecord): string[] {
  return expandArgv(loadBundledManifest('antigravity'), {
    prompt: run.prompt,
    workspace: '',
    model: run.modelId,
    resume: run.sessionRef,
    mode: run.mode,
  })
}

const FIXTURE = fileURLToPath(new URL('../fixtures/stream-json.ndjson', import.meta.url))
const SECRET = 'gemini-secret-t9'
const tmpDirs: string[] = []

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

const tmp = (prefix: string) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), prefix))
  tmpDirs.push(dir)
  return dir
}

const FAKE_AGY = `#!/usr/bin/env node
const fs = require('node:fs')
const path = require('node:path')
const sidecar = process.env.FAKE_SIDECAR
const settingsFile = path.join(process.env.HOME || '', '.gemini', 'antigravity-cli', 'settings.json')
let settings = null
try { settings = fs.readFileSync(settingsFile, 'utf8') } catch {}
if (sidecar) {
  fs.writeFileSync(sidecar, JSON.stringify({
    argv: process.argv.slice(2),
    env: {
      GEMINI_API_KEY: process.env.GEMINI_API_KEY,
      HOME: process.env.HOME,
      CURSOR_API_KEY: process.env.CURSOR_API_KEY,
    },
    settings,
    settingsExists: fs.existsSync(settingsFile),
  }))
}
if (process.env.FAKE_STDERR) process.stderr.write(process.env.FAKE_STDERR + '\\n')
if (process.env.FAKE_HANG === '1') {
  setInterval(() => {}, 1000)
} else if (process.env.FAKE_FIXTURE) {
  const body = fs.readFileSync(process.env.FAKE_FIXTURE, 'utf8')
  process.stdout.write(body.endsWith('\\n') ? body : body + '\\n')
}
`

function installFakeAgy(binDir: string): string {
  mkdirSync(binDir, { recursive: true })
  const agy = path.join(binDir, 'agy')
  writeFileSync(agy, FAKE_AGY, { mode: 0o755 })
  chmodSync(agy, 0o755)
  return agy
}

async function withEnv<T>(overrides: Record<string, string | undefined>, fn: () => Promise<T>): Promise<T> {
  const prev: Record<string, string | undefined> = {}
  for (const key of Object.keys(overrides)) {
    prev[key] = process.env[key]
    const value = overrides[key]
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  try {
    return await fn()
  } finally {
    for (const key of Object.keys(prev)) {
      if (prev[key] === undefined) delete process.env[key]
      else process.env[key] = prev[key]
    }
  }
}

function makeRun(over: Partial<RunRecord> = {}): RunRecord {
  return {
    id: 'r-agy-1',
    product: 'aw',
    family: 'antigravity',
    status: 'RUNNING',
    workspaceDir: '/tmp/ws',
    prompt: 'list the files',
    createdAt: new Date().toISOString(),
    lastSeq: 0,
    ...over,
  }
}

function makeInput(
  dirs: { workspaceDir: string; homeDir: string },
  over: Partial<RunRecord> = {},
  signal: AbortSignal = new AbortController().signal,
): { input: StartInput; events: Array<{ type: EventType; data: unknown }> } {
  const events: Array<{ type: EventType; data: unknown }> = []
  const input: StartInput = {
    run: makeRun({ workspaceDir: dirs.workspaceDir, ...over }),
    workspaceDir: dirs.workspaceDir,
    homeDir: dirs.homeDir,
    credentialSecret: SECRET,
    signal,
    emit: (type, data) => events.push({ type, data }),
  }
  return { input, events }
}

interface Sidecar {
  argv: string[]
  env: { GEMINI_API_KEY?: string; HOME?: string; CURSOR_API_KEY?: string }
  settings: string | null
  settingsExists: boolean
}

function readSidecar(file: string): Sidecar {
  return JSON.parse(readFileSync(file, 'utf8')) as Sidecar
}

describe('antigravity', { concurrency: 1 }, () => {
  test('capabilities and health follow PATH agy', async () => {
    const p = createAntigravityProvider()
    assert.deepEqual(p.capabilities(), {
      family: 'antigravity',
      streaming: true,
      resume: true,
      models: 'static',
      permissions: ['--dangerously-skip-permissions'],
      binary: 'agy',
    })
    const binDir = tmp('agy-bin-health-')
    installFakeAgy(binDir)
    await withEnv({ PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ''}` }, async () => {
      assert.deepEqual(await p.health(), { available: true })
    })
    const withoutAgy = (process.env.PATH ?? '')
      .split(path.delimiter)
      .filter((dir) => dir && !existsSync(path.join(dir, 'agy')))
      .join(path.delimiter)
    await withEnv({ PATH: withoutAgy }, async () => {
      assert.deepEqual(await p.health(), { available: false, detail: 'cli_not_found' })
    })
  })

  test('writeAntigravitySettings materializes modelProvider gemini', async () => {
    const homeDir = tmp('agy-home-settings-')
    await writeAntigravitySettings(homeDir)
    const file = path.join(homeDir, '.gemini', 'antigravity-cli', 'settings.json')
    assert.equal(readFileSync(file, 'utf8'), '{"modelProvider":"gemini"}')
  })

  test('buildAntigravityArgs: skip-permissions on by default; omitted when 0/false; conversation and model optional', () => {
    const run = makeRun({ modelId: 'gemini-2.5-pro', sessionRef: 'conv-9' })
    assert.deepEqual(buildAntigravityArgs(makeRun()), [
      '-p',
      'list the files',
      '--output-format',
      'stream-json',
      '--dangerously-skip-permissions',
      '--print-timeout',
      '600',
    ])
    const prevSkip = process.env.AMAZING_CLI_ANTIGRAVITY_SKIP_PERMISSIONS
    const prevTimeout = process.env.AMAZING_CLI_ANTIGRAVITY_PRINT_TIMEOUT
    try {
      process.env.AMAZING_CLI_ANTIGRAVITY_SKIP_PERMISSIONS = '0'
      assert.equal(buildAntigravityArgs(makeRun()).includes('--dangerously-skip-permissions'), false)
      process.env.AMAZING_CLI_ANTIGRAVITY_SKIP_PERMISSIONS = 'false'
      process.env.AMAZING_CLI_ANTIGRAVITY_PRINT_TIMEOUT = '90'
      assert.deepEqual(buildAntigravityArgs(run), [
        '-p',
        'list the files',
        '--output-format',
        'stream-json',
        '--print-timeout',
        '90',
        '--model',
        'gemini-2.5-pro',
        '--conversation',
        'conv-9',
      ])
    } finally {
      if (prevSkip === undefined) delete process.env.AMAZING_CLI_ANTIGRAVITY_SKIP_PERMISSIONS
      else process.env.AMAZING_CLI_ANTIGRAVITY_SKIP_PERMISSIONS = prevSkip
      if (prevTimeout === undefined) delete process.env.AMAZING_CLI_ANTIGRAVITY_PRINT_TIMEOUT
      else process.env.AMAZING_CLI_ANTIGRAVITY_PRINT_TIMEOUT = prevTimeout
    }
  })

  test('buildAntigravityArgs: ask/plan omit skip-permissions; plan adds plan-only instruction; agent/omitted keep flag', () => {
    const prevSkip = process.env.AMAZING_CLI_ANTIGRAVITY_SKIP_PERMISSIONS
    try {
      delete process.env.AMAZING_CLI_ANTIGRAVITY_SKIP_PERMISSIONS
      const ask = buildAntigravityArgs(makeRun({ mode: 'ask' }))
      assert.equal(ask.includes('--dangerously-skip-permissions'), false)
      assert.equal(ask[1], 'list the files')

      const plan = buildAntigravityArgs(makeRun({ mode: 'plan', prompt: 'ship it' }))
      assert.equal(plan.includes('--dangerously-skip-permissions'), false)
      assert.match(plan[1]!, /plan/i)
      assert.match(plan[1]!, /must not apply|do not apply/i)
      assert.match(plan[1]!, /ship it/)

      assert.ok(buildAntigravityArgs(makeRun({ mode: 'agent' })).includes('--dangerously-skip-permissions'))
      assert.ok(buildAntigravityArgs(makeRun()).includes('--dangerously-skip-permissions'))

      process.env.AMAZING_CLI_ANTIGRAVITY_SKIP_PERMISSIONS = '0'
      assert.equal(buildAntigravityArgs(makeRun({ mode: 'agent' })).includes('--dangerously-skip-permissions'), false)
      assert.equal(buildAntigravityArgs(makeRun({ mode: 'ask' })).includes('--dangerously-skip-permissions'), false)
    } finally {
      if (prevSkip === undefined) delete process.env.AMAZING_CLI_ANTIGRAVITY_SKIP_PERMISSIONS
      else process.env.AMAZING_CLI_ANTIGRAVITY_SKIP_PERMISSIONS = prevSkip
    }
  })

  test('start: settings.json present at spawn; default args; GEMINI_API_KEY and HOME; stream-json events', async () => {
    const binDir = tmp('agy-bin-ok-')
    const workspaceDir = tmp('agy-ws-ok-')
    const homeDir = tmp('agy-home-ok-')
    const sidecar = path.join(tmp('agy-side-ok-'), 'sidecar.json')
    installFakeAgy(binDir)
    const p = createAntigravityProvider()
    const { input, events } = makeInput({ workspaceDir, homeDir })
    const result = await withEnv(
      {
        PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ''}`,
        FAKE_SIDECAR: sidecar,
        FAKE_FIXTURE: FIXTURE,
        CURSOR_API_KEY: 'LEAK',
        AMAZING_CLI_ANTIGRAVITY_SKIP_PERMISSIONS: undefined,
        AMAZING_CLI_ANTIGRAVITY_PRINT_TIMEOUT: undefined,
      },
      () => p.start(input),
    )
    const side = readSidecar(sidecar)
    assert.equal(side.settingsExists, true)
    assert.equal(side.settings, '{"modelProvider":"gemini"}')
    const settingsFile = path.join(homeDir, '.gemini', 'antigravity-cli', 'settings.json')
    assert.equal(existsSync(settingsFile), true)
    assert.equal(readFileSync(settingsFile, 'utf8'), '{"modelProvider":"gemini"}')
    assert.deepEqual(side.argv, [
      '-p',
      'list the files',
      '--output-format',
      'stream-json',
      '--dangerously-skip-permissions',
      '--print-timeout',
      '600',
    ])
    assert.equal(side.env.GEMINI_API_KEY, SECRET)
    assert.equal(side.env.HOME, homeDir)
    assert.equal(side.env.CURSOR_API_KEY, undefined)
    assert.deepEqual(result, {
      status: 'SUCCEEDED',
      sessionRef: 'agy-sess-1',
      usage: { inputTokens: 11, outputTokens: 7 },
    })
    assert.deepEqual(
      events.map((e) => e.type),
      ['system/init', 'assistant/delta', 'tool/call', 'tool/result'],
    )
    assert.deepEqual(events[0].data, { sessionRef: 'agy-sess-1', model: 'gemini-2.5-pro' })
    assert.deepEqual(events[1].data, { text: 'Hello' })
    assert.deepEqual(events[2].data, { name: 'shellToolCall', args: { command: 'ls' } })
    assert.deepEqual(events[3].data, { name: 'shellToolCall', content: 'ok' })
    assert.ok(!events.some((e) => e.type.startsWith('run/')), 'provider must not emit run/* events')
  })

  test('start: AMAZING_CLI_ANTIGRAVITY_SKIP_PERMISSIONS=0 omits the flag', async () => {
    const binDir = tmp('agy-bin-skip-')
    const workspaceDir = tmp('agy-ws-skip-')
    const homeDir = tmp('agy-home-skip-')
    const sidecar = path.join(tmp('agy-side-skip-'), 'sidecar.json')
    installFakeAgy(binDir)
    const p = createAntigravityProvider()
    const { input } = makeInput({ workspaceDir, homeDir })
    await withEnv(
      {
        PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ''}`,
        FAKE_SIDECAR: sidecar,
        FAKE_FIXTURE: FIXTURE,
        AMAZING_CLI_ANTIGRAVITY_SKIP_PERMISSIONS: '0',
      },
      () => p.start(input),
    )
    const argv = readSidecar(sidecar).argv
    assert.equal(argv.includes('--dangerously-skip-permissions'), false)
    assert.ok(argv.includes('-p'))
    assert.ok(argv.includes('--output-format'))
    assert.ok(argv.includes('stream-json'))
  })

  test('start: --conversation when sessionRef', async () => {
    const binDir = tmp('agy-bin-conv-')
    const workspaceDir = tmp('agy-ws-conv-')
    const homeDir = tmp('agy-home-conv-')
    const sidecar = path.join(tmp('agy-side-conv-'), 'sidecar.json')
    installFakeAgy(binDir)
    const p = createAntigravityProvider()
    const { input } = makeInput({ workspaceDir, homeDir }, { sessionRef: 'conv-abc', modelId: 'gemini-2.5-flash' })
    await withEnv(
      {
        PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ''}`,
        FAKE_SIDECAR: sidecar,
        FAKE_FIXTURE: FIXTURE,
      },
      () => p.start(input),
    )
    const argv = readSidecar(sidecar).argv
    const convAt = argv.indexOf('--conversation')
    assert.ok(convAt >= 0)
    assert.equal(argv[convAt + 1], 'conv-abc')
    const modelAt = argv.indexOf('--model')
    assert.ok(modelAt >= 0)
    assert.equal(argv[modelAt + 1], 'gemini-2.5-flash')
  })

  test('stderr soft-deny line → log/line warn', async () => {
    const binDir = tmp('agy-bin-err-')
    const workspaceDir = tmp('agy-ws-err-')
    const homeDir = tmp('agy-home-err-')
    const sidecar = path.join(tmp('agy-side-err-'), 'sidecar.json')
    installFakeAgy(binDir)
    const p = createAntigravityProvider()
    const { input, events } = makeInput({ workspaceDir, homeDir })
    await withEnv(
      {
        PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ''}`,
        FAKE_SIDECAR: sidecar,
        FAKE_FIXTURE: FIXTURE,
        FAKE_STDERR: 'soft deny: shell permission blocked',
      },
      () => p.start(input),
    )
    const warns = events.filter((e) => e.type === 'log/line')
    assert.ok(warns.some((e) => {
      const data = e.data as { level?: string; text?: string }
      return data.level === 'warn' && data.text === 'soft deny: shell permission blocked'
    }))
  })

  test('missing binary → health unavailable and start FAILED cli_not_found', async () => {
    const p = createAntigravityProvider()
    const workspaceDir = tmp('agy-ws-miss-')
    const homeDir = tmp('agy-home-miss-')
    const withoutAgy = (process.env.PATH ?? '')
      .split(path.delimiter)
      .filter((dir) => dir && !existsSync(path.join(dir, 'agy')))
      .join(path.delimiter)
    const { input } = makeInput({ workspaceDir, homeDir })
    await withEnv({ PATH: withoutAgy, FAKE_SIDECAR: undefined, FAKE_FIXTURE: undefined, FAKE_HANG: undefined }, async () => {
      assert.deepEqual(await p.health(), { available: false, detail: 'cli_not_found' })
      const result = await p.start(input)
      assert.equal(result.status, 'FAILED')
      assert.equal(result.error?.code, 'cli_not_found')
    })
  })

  test('abort hang → CANCELLED promptly', async () => {
    const binDir = tmp('agy-bin-hang-')
    const workspaceDir = tmp('agy-ws-hang-')
    const homeDir = tmp('agy-home-hang-')
    const sidecar = path.join(tmp('agy-side-hang-'), 'sidecar.json')
    installFakeAgy(binDir)
    const p = createAntigravityProvider()
    const ac = new AbortController()
    const { input } = makeInput({ workspaceDir, homeDir }, {}, ac.signal)
    const started = withEnv(
      {
        PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ''}`,
        FAKE_SIDECAR: sidecar,
        FAKE_HANG: '1',
        FAKE_FIXTURE: undefined,
      },
      () => p.start(input),
    )
    await new Promise((r) => setTimeout(r, 50))
    const t0 = Date.now()
    ac.abort()
    const result = await started
    assert.deepEqual(result, { status: 'CANCELLED' })
    assert.ok(Date.now() - t0 < 1000, `took ${Date.now() - t0}ms`)
  })
})
