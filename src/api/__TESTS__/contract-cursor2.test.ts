// PROV-07: a family that exists only as a copied YAML is listed and runs. No new module.
import assert from 'node:assert/strict'
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { after, before, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import type { RunRecord } from '../../core/types.js'
import { createTestApp, type TestApp } from '../../test-support/app.js'
import { call, runRequest, waitFor } from '../../test-support/client.js'
import { createOpenApiValidator } from '../../test-support/openapi-validator.js'

const FIXTURE = fileURLToPath(new URL('../../modules/cursor/fixtures/stream.ndjson', import.meta.url))
const CURSOR_YAML = fileURLToPath(new URL('../../../providers/cursor.yaml', import.meta.url))
const validator = createOpenApiValidator()

const FAKE_AGENT = `#!/usr/bin/env node
const { readFileSync, writeFileSync } = require('node:fs')
const side = process.env.FAKE_SIDE
if (side) writeFileSync(side, JSON.stringify({ argv: process.argv.slice(1) }))
const fixture = process.env.FAKE_FIXTURE
if (fixture) {
  for (const line of readFileSync(fixture, 'utf8').split('\\n')) {
    if (line.length) console.log(line)
  }
}
`

const tmpDirs: string[] = []
const envKeys = ['HOME', 'PATH', 'CURSOR_API_KEY', 'FAKE_SIDE', 'FAKE_FIXTURE', 'CURSOR_AGENT_VERSIONS_ROOT'] as const
const origEnv: Record<string, string | undefined> = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]))

let app: TestApp
let sideFile: string

before(async () => {
  const binDir = mkdtempSync(path.join(os.tmpdir(), 'cursor2-bin-'))
  const home = mkdtempSync(path.join(os.tmpdir(), 'cursor2-home-'))
  const providersDir = mkdtempSync(path.join(os.tmpdir(), 'cursor2-providers-'))
  tmpDirs.push(binDir, home, providersDir)
  const agentPath = path.join(binDir, 'agent')
  writeFileSync(agentPath, FAKE_AGENT)
  chmodSync(agentPath, 0o755)
  sideFile = path.join(home, 'side.json')
  const yaml = readFileSync(CURSOR_YAML, 'utf8')
    .replace(/^family: cursor$/m, 'family: cursor2')
    .replace('modes: [ask, plan, agent]', 'modes: [ask, agent]')
  writeFileSync(path.join(providersDir, 'cursor2.yaml'), yaml)
  process.env.HOME = home
  process.env.PATH = `${binDir}${path.delimiter}${origEnv.PATH ?? ''}`
  process.env.FAKE_SIDE = sideFile
  process.env.FAKE_FIXTURE = FIXTURE
  delete process.env.CURSOR_API_KEY
  delete process.env.CURSOR_AGENT_VERSIONS_ROOT
  app = await createTestApp({ enableFake: false, providersDir })
})

after(async () => {
  await app?.destroy()
  for (const dir of tmpDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  for (const key of envKeys) {
    if (origEnv[key] === undefined) delete process.env[key]
    else process.env[key] = origEnv[key]
  }
})

const expectError = (res: { status: number; body: unknown }, status: number, code: string) => {
  assert.equal(res.status, status, JSON.stringify(res.body))
  validator.assertValid('Error', res.body)
  assert.equal((res.body as { error: { code: string } }).error.code, code)
}

test('GET /v1/providers lists cursor2 from the extra dir, kind spawn, without plan', async () => {
  const res = await call(app, 'aw', 'GET', '/v1/providers')
  assert.equal(res.status, 200, JSON.stringify(res.body))
  const providers = res.body as Array<{ family: string; kind: string; available: boolean; capabilities: { modes: string[] } }>
  for (const item of providers) validator.assertValid('ProviderInfo', item)
  const cursor2 = providers.find((item) => item.family === 'cursor2')
  assert.ok(cursor2, 'cursor2 is registered from the copied yaml')
  assert.equal(cursor2.kind, 'spawn')
  assert.equal(cursor2.available, true)
  assert.deepEqual(cursor2.capabilities.modes, ['ask', 'agent'])
  assert.ok(providers.some((item) => item.family === 'cursor'), 'the bundled cursor family is still there')
})

test('POST /v1/runs mode plan on cursor2 → 400 unsupported and no run is stored', async () => {
  const body = runRequest('aw', 'cursor2-plan', { family: 'cursor2', mode: 'plan', credential: { secret: 'sk-cursor2' } })
  validator.assertValid('RunRequest', body)
  expectError(await call(app, 'aw', 'POST', '/v1/runs', body), 400, 'unsupported')
  assert.equal(app.dispatcher.get('cursor2-plan'), undefined)
})

test('POST /v1/runs family cursor2 runs the copied argv through the fake agent', async () => {
  const body = runRequest('aw', 'cursor2-run', { family: 'cursor2', prompt: 'cite forty two', credential: { secret: 'sk-cursor2' } })
  validator.assertValid('RunRequest', body)
  const res = await call(app, 'aw', 'POST', '/v1/runs', body)
  assert.equal(res.status, 202, JSON.stringify(res.body))
  validator.assertValid('RunRecord', res.body)
  assert.equal((res.body as RunRecord).family, 'cursor2')
  const done = await waitFor(() => {
    const record = app.dispatcher.get('cursor2-run')
    return record && record.status !== 'QUEUED' && record.status !== 'RUNNING' ? record : undefined
  }, 'cursor2-run terminal')
  assert.equal(done.status, 'SUCCEEDED', JSON.stringify(done.error))
  const side = JSON.parse(readFileSync(sideFile, 'utf8')) as { argv: string[] }
  assert.ok(side.argv.includes('cite forty two'), JSON.stringify(side.argv))
  assert.ok(side.argv.includes('--force'), JSON.stringify(side.argv))
})
