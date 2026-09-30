import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { RunFailure } from '../core/errors.js'
import { ManifestError } from '../core/provider-manifest.js'
import { composeApp, configFromEnv, type AppConfig } from '../server.js'

const API_KEY = 'test-api-key-0123456789abcdef'
/** Retention is mandatory config; tests that are not about it just supply values. */
const TTL = { AMAZING_CLI_SESSION_IDLE_TTL_SEC: '3600', AMAZING_CLI_SESSION_SWEEP_SEC: '60' }
const isValidation = (re: RegExp) => (e: unknown) => e instanceof RunFailure && e.error.code === 'validation' && re.test(e.error.message)

test('configFromEnv: defaults are 3200 / 4 / 2 / 3600, dataRoot /data/amazing-cli, fake disabled, no workspace roots', () => {
  const cfg = configFromEnv({ AMAZING_CLI_API_KEY: API_KEY, ...TTL })
  assert.equal(cfg.port, 3200)
  assert.equal(cfg.maxConcurrent, 4)
  assert.equal(cfg.maxConcurrentPerProduct, 2)
  assert.equal(cfg.defaultTimeoutSec, 3600)
  assert.equal(cfg.dataRoot, '/data/amazing-cli')
  assert.equal(cfg.enableFake, false)
  assert.equal(cfg.registerFake, false)
  assert.equal(cfg.providersDir, undefined)
  assert.equal(cfg.workspaceRoots.size, 0)
  assert.equal(cfg.health, undefined, 'no LITELLM_BASE_URL → no health probe')
  assert.equal(cfg.apiKey, API_KEY)
  assert.equal(cfg.workspacesRoot, undefined)
})

test('configFromEnv: every variable is parsed; PORT=0 (ephemeral) is allowed; empty strings fall back to defaults', () => {
  const cfg = configFromEnv({
    AMAZING_CLI_API_KEY: API_KEY,
    ...TTL,
    PORT: '0',
    AMAZING_CLI_DATA_ROOT: '/tmp/amz',
    AMAZING_CLI_WORKSPACE_ROOTS: 'alpha=/srv/alpha,beta=/srv/beta',
    AMAZING_CLI_MAX_CONCURRENT_RUNS: '8',
    AMAZING_CLI_MAX_CONCURRENT_RUNS_PER_PRODUCT: '3',
    AMAZING_CLI_DEFAULT_TIMEOUT_SEC: '120',
    AMAZING_CLI_ENABLE_FAKE: 'true',
    AMAZING_CLI_PROVIDERS_DIR: '/opt/extra-providers',
    LITELLM_BASE_URL: 'http://litellm:4000',
    LITELLM_MASTER_KEY: 'sk-amazing-litellm-dev',
  })
  assert.equal(cfg.port, 0)
  assert.equal(cfg.dataRoot, '/tmp/amz')
  assert.deepEqual([...cfg.workspaceRoots], [['alpha', '/srv/alpha'], ['beta', '/srv/beta']])
  assert.equal(cfg.maxConcurrent, 8)
  assert.equal(cfg.maxConcurrentPerProduct, 3)
  assert.equal(cfg.defaultTimeoutSec, 120)
  assert.equal(cfg.enableFake, true)
  assert.equal(cfg.providersDir, '/opt/extra-providers')
  assert.equal(typeof cfg.health, 'function')
  assert.equal(configFromEnv({ ...TTL, AMAZING_CLI_API_KEY: API_KEY, AMAZING_CLI_DEFAULT_TIMEOUT_SEC: '  ' }).defaultTimeoutSec, 3600)
  assert.equal(configFromEnv({ ...TTL, AMAZING_CLI_API_KEY: API_KEY, AMAZING_CLI_ENABLE_FAKE: 'TRUE' }).enableFake, false, 'only the literal "true" enables the fake')
})

test('configFromEnv: negative, non-integer, zero limits and garbage → validation naming the variable', () => {
  const base = { AMAZING_CLI_API_KEY: API_KEY, ...TTL }
  assert.throws(() => configFromEnv({ ...base, AMAZING_CLI_DEFAULT_TIMEOUT_SEC: '-5' }), isValidation(/AMAZING_CLI_DEFAULT_TIMEOUT_SEC/))
  assert.throws(() => configFromEnv({ ...base, AMAZING_CLI_DEFAULT_TIMEOUT_SEC: '1.5' }), isValidation(/AMAZING_CLI_DEFAULT_TIMEOUT_SEC/))
  assert.throws(() => configFromEnv({ ...base, AMAZING_CLI_DEFAULT_TIMEOUT_SEC: '0' }), isValidation(/AMAZING_CLI_DEFAULT_TIMEOUT_SEC/))
  assert.throws(() => configFromEnv({ ...base, AMAZING_CLI_MAX_CONCURRENT_RUNS: '0' }), isValidation(/AMAZING_CLI_MAX_CONCURRENT_RUNS must/))
  assert.throws(() => configFromEnv({ ...base, AMAZING_CLI_MAX_CONCURRENT_RUNS_PER_PRODUCT: 'two' }), isValidation(/AMAZING_CLI_MAX_CONCURRENT_RUNS_PER_PRODUCT/))
  assert.throws(() => configFromEnv({ ...base, PORT: '-1' }), isValidation(/PORT/))
  assert.throws(() => configFromEnv({ ...base, PORT: '80.5' }), isValidation(/PORT/))
})

test('configFromEnv: session retention is mandatory — no default, and the error names the variable', () => {
  const base = { AMAZING_CLI_API_KEY: API_KEY }
  assert.throws(() => configFromEnv(base), isValidation(/AMAZING_CLI_SESSION_IDLE_TTL_SEC/))
  assert.throws(() => configFromEnv({ ...base, AMAZING_CLI_SESSION_IDLE_TTL_SEC: '3600' }), isValidation(/AMAZING_CLI_SESSION_SWEEP_SEC/))
  assert.throws(() => configFromEnv({ ...base, ...TTL, AMAZING_CLI_SESSION_IDLE_TTL_SEC: '0' }), isValidation(/AMAZING_CLI_SESSION_IDLE_TTL_SEC/))
  assert.throws(() => configFromEnv({ ...base, ...TTL, AMAZING_CLI_SESSION_SWEEP_SEC: 'often' }), isValidation(/AMAZING_CLI_SESSION_SWEEP_SEC/))
  const cfg = configFromEnv({ ...base, AMAZING_CLI_SESSION_IDLE_TTL_SEC: '900', AMAZING_CLI_SESSION_SWEEP_SEC: '30' })
  assert.equal(cfg.sessionIdleTtlSec, 900)
  assert.equal(cfg.sessionSweepSec, 30)
})

test('configFromEnv: API key is required and validated (missing, empty, weak key)', () => {
  assert.throws(() => configFromEnv({}), isValidation(/AMAZING_CLI_API_KEY/))
  assert.throws(() => configFromEnv({ ...TTL, AMAZING_CLI_API_KEY: '  ' }), isValidation(/AMAZING_CLI_API_KEY/))
  assert.throws(() => configFromEnv({ ...TTL, AMAZING_CLI_API_KEY: 'short' }), isValidation(/at least 16/))
  assert.throws(() => configFromEnv({ ...TTL, AMAZING_CLI_API_KEY: API_KEY, AMAZING_CLI_WORKSPACE_ROOTS: 'alpha=relative/path' }), isValidation(/absolute/))
})

test('configFromEnv: AMAZING_CLI_WORKSPACES_ROOT is a parent for any caller id, not a product list', () => {
  const cfg = configFromEnv({
    AMAZING_CLI_API_KEY: API_KEY,
    ...TTL,
    AMAZING_CLI_WORKSPACES_ROOT: '/data/products',
  })
  assert.equal(cfg.workspacesRoot, '/data/products')
  assert.equal(cfg.workspaceRoots.size, 0)
  assert.throws(
    () => configFromEnv({ ...TTL, AMAZING_CLI_API_KEY: API_KEY, AMAZING_CLI_WORKSPACES_ROOT: 'relative' }),
    isValidation(/AMAZING_CLI_WORKSPACES_ROOT/),
  )
})

const bootConfig = (providersDir: string): AppConfig => ({
  port: 0,
  dataRoot: providersDir,
  workspaceRoots: new Map(),
  apiKey: API_KEY,
  maxConcurrent: 1,
  maxConcurrentPerProduct: 1,
  defaultTimeoutSec: 60,
  sessionIdleTtlSec: 3600,
  sessionSweepSec: 60,
  enableFake: true,
  registerFake: false,
  providersDir,
  log: () => {},
})

test('composeApp fails before listen when an extra manifest repeats a bundled family or breaks a field', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'prov-boot-'))
  writeFileSync(
    join(dir, 'dup.yaml'),
    'family: cursor\nkind: fake\nmodels: { source: none }\ncapabilities: { streaming: true, resume: false, modes: [], attachments: [], compaction: none, contextUsage: none, mcp: false }\n',
  )
  await assert.rejects(
    () => composeApp(bootConfig(dir)),
    (err: unknown) => err instanceof ManifestError && err.message.includes('duplicate family "cursor"') && err.message.includes(dir),
  )
  writeFileSync(join(dir, 'dup.yaml'), 'family: cursor2\nkind: spawn\nmodels: { source: none }\ncapabilities: { streaming: true, resume: false, modes: [], attachments: [], compaction: magic, contextUsage: none, mcp: false }\n')
  await assert.rejects(
    () => composeApp(bootConfig(dir)),
    (err: unknown) => err instanceof ManifestError && err.message.includes('capabilities.compaction') && err.message.includes(join(dir, 'dup.yaml')),
  )
})
