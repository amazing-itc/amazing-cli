import assert from 'node:assert/strict'
import path from 'node:path'
import { test } from 'node:test'
import { CREDENTIAL_ENV, SENSITIVE_ENV, childEnv, credentialEnvFor, requireSecret } from '../credential.js'
import { RunFailure } from '../errors.js'
import type { Family } from '../types.js'

const HOME = '/data/amazing-cli/runs/r1/home'

function seededBase(): NodeJS.ProcessEnv {
  const base: NodeJS.ProcessEnv = { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8', HOME: '/root', USERPROFILE: 'C:\\root', XDG_CONFIG_HOME: '/root/.config', TERM: 'xterm' }
  for (const key of SENSITIVE_ENV) base[key] = `leaked-${key}`
  return base
}

test('CREDENTIAL_ENV maps each native family to its env var; SENSITIVE_ENV is deduped and covers all of them', () => {
  assert.deepEqual(CREDENTIAL_ENV, {
    cursor: 'CURSOR_API_KEY',
    claude: 'ANTHROPIC_API_KEY',
    codex: 'OPENAI_API_KEY',
    copilot: 'COPILOT_GITHUB_TOKEN',
    antigravity: 'GEMINI_API_KEY',
  })
  assert.equal(new Set(SENSITIVE_ENV).size, SENSITIVE_ENV.length, 'no duplicates')
  for (const v of Object.values(CREDENTIAL_ENV)) assert.ok(SENSITIVE_ENV.includes(v), v)
  for (const v of ['GH_TOKEN', 'GITHUB_TOKEN', 'GOOGLE_API_KEY', 'LITELLM_MASTER_KEY', 'AMAZING_CLI_API_KEY']) assert.ok(SENSITIVE_ENV.includes(v), v)
  assert.equal(credentialEnvFor('external'), undefined)
  assert.equal(credentialEnvFor('fake'), undefined)
  assert.equal(credentialEnvFor('claude'), 'ANTHROPIC_API_KEY')
})

test('childEnv strips every SENSITIVE_ENV key, sets HOME/USERPROFILE/XDG_*, keeps PATH, injects only the family var', () => {
  const env = childEnv({ base: seededBase(), family: 'claude', secret: 'sk-ant-1', homeDir: HOME })
  for (const key of SENSITIVE_ENV) {
    if (key === 'ANTHROPIC_API_KEY') continue
    assert.ok(!(key in env), `${key} must not be inherited`)
  }
  assert.equal(env.ANTHROPIC_API_KEY, 'sk-ant-1')
  assert.ok(!Object.values(env).some((v) => v.startsWith('leaked-')), 'no inherited secret value may survive')
  assert.equal(env.PATH, '/usr/bin:/bin')
  assert.equal(env.LANG, 'C.UTF-8')
  assert.equal(env.HOME, HOME)
  assert.equal(env.USERPROFILE, HOME)
  assert.equal(env.XDG_CONFIG_HOME, path.join(HOME, '.config'))
  assert.equal(env.XDG_STATE_HOME, path.join(HOME, '.local', 'state'))
  assert.equal(env.XDG_DATA_HOME, path.join(HOME, '.local', 'share'))
  assert.ok(Object.values(env).every((v) => typeof v === 'string'))
})

test('childEnv per family injects exactly one credential var; external/fake get none even with a secret', () => {
  for (const family of Object.keys(CREDENTIAL_ENV) as Array<keyof typeof CREDENTIAL_ENV>) {
    const env = childEnv({ base: seededBase(), family, secret: 's3cret', homeDir: HOME })
    const present = SENSITIVE_ENV.filter((k) => k in env)
    assert.deepEqual(present, [CREDENTIAL_ENV[family]], family)
  }
  for (const family of ['external', 'fake'] as Family[]) {
    const env = childEnv({ base: seededBase(), family, secret: 's3cret', homeDir: HOME })
    assert.deepEqual(SENSITIVE_ENV.filter((k) => k in env), [], family)
    assert.ok(!Object.values(env).includes('s3cret'))
  }
})

test('childEnv: empty/undefined secret injects nothing; extra merges last; base defaults to process.env', () => {
  assert.ok(!('CURSOR_API_KEY' in childEnv({ base: seededBase(), family: 'cursor', secret: '', homeDir: HOME })))
  assert.ok(!('CURSOR_API_KEY' in childEnv({ base: seededBase(), family: 'cursor', homeDir: HOME })))
  const env = childEnv({ base: { LANG: 'C' }, family: 'codex', secret: 'k', homeDir: HOME, extra: { FOO: 'bar', LANG: 'pt_BR.UTF-8' } })
  assert.equal(env.FOO, 'bar')
  assert.equal(env.LANG, 'pt_BR.UTF-8')
  assert.equal(env.OPENAI_API_KEY, 'k')
  const fromProcess = childEnv({ family: 'fake', homeDir: HOME })
  assert.equal(fromProcess.PATH, process.env.PATH)
  assert.equal(fromProcess.HOME, HOME)
})

test('childEnv repoints XDG_CACHE_HOME and strips pattern-matched secrets (FOO_API_KEY, BAR_TOKEN, DB_PASSWORD, ...)', () => {
  const base: NodeJS.ProcessEnv = {
    ...seededBase(),
    XDG_CACHE_HOME: '/root/.cache',
    FOO_API_KEY: 'leak',
    BAR_TOKEN: 'leak',
    DB_PASSWORD: 'leak',
    PASSWORD: 'leak',
    my_secret: 'leak',
    npm_config_token: 'leak',
    API_KEY: 'leak',
    TOKEN: 'leak',
    AWS_SECRET_ACCESS_KEY: 'leak',
    PASSWD: 'leak',
    // Over-stripping is preferred: a segment equal to a secret word is enough, even mid-name.
    API_KEY_ROTATION_DAYS: 'stripped-on-purpose',
    TOKENIZER: 'keep',
    TOKENS_PER_MINUTE: 'keep',
    SECRETARY: 'keep',
  }
  const env = childEnv({ base, family: 'codex', secret: 'k', homeDir: HOME })
  assert.equal(env.XDG_CACHE_HOME, path.join(HOME, '.cache'))
  const stripped = ['FOO_API_KEY', 'BAR_TOKEN', 'DB_PASSWORD', 'PASSWORD', 'my_secret', 'npm_config_token', 'API_KEY', 'TOKEN', 'AWS_SECRET_ACCESS_KEY', 'PASSWD', 'API_KEY_ROTATION_DAYS']
  for (const key of stripped) assert.ok(!(key in env), key)
  assert.equal(env.TOKENIZER, 'keep')
  assert.equal(env.TOKENS_PER_MINUTE, 'keep')
  assert.equal(env.SECRETARY, 'keep')
  assert.equal(env.OPENAI_API_KEY, 'k')
  assert.ok(!Object.values(env).includes('leak'))
})

test('childEnv extra: sensitive keys are rejected with validation unless it is the family credential var', () => {
  const isValidation = (e: unknown) => e instanceof RunFailure && e.error.code === 'validation'
  assert.throws(() => childEnv({ base: {}, family: 'fake', homeDir: HOME, extra: { OPENAI_API_KEY: 'x' } }), isValidation)
  assert.throws(() => childEnv({ base: {}, family: 'external', homeDir: HOME, extra: { GH_TOKEN: 'x' } }), isValidation)
  assert.throws(() => childEnv({ base: {}, family: 'cursor', homeDir: HOME, extra: { ANTHROPIC_API_KEY: 'x' } }), isValidation)
  assert.throws(() => childEnv({ base: {}, family: 'cursor', homeDir: HOME, extra: { MY_SERVICE_TOKEN: 'x' } }), isValidation)
  const env = childEnv({ base: {}, family: 'cursor', homeDir: HOME, extra: { CURSOR_API_KEY: 'x', CURSOR_MODEL: 'm' } })
  assert.equal(env.CURSOR_API_KEY, 'x')
  assert.equal(env.CURSOR_MODEL, 'm')
})

test('childEnv extra: HOME, USERPROFILE, PATH and XDG_* may not be overridden → validation (isolation stays intact)', () => {
  const isValidation = (e: unknown) => e instanceof RunFailure && e.error.code === 'validation'
  const overrides: Record<string, string>[] = [{ HOME: '/x' }, { USERPROFILE: '/x' }, { PATH: '/evil' }, { XDG_CONFIG_HOME: '/x' }, { XDG_CACHE_HOME: '/x' }, { XDG_DATA_HOME: '/x' }]
  for (const extra of overrides) {
    assert.throws(() => childEnv({ base: seededBase(), family: 'fake', homeDir: HOME, extra }), isValidation, JSON.stringify(extra))
  }
  const env = childEnv({ base: seededBase(), family: 'fake', homeDir: HOME, extra: { HOMEBREW_PREFIX: '/opt', PATH_INFO: 'x' } })
  assert.equal(env.HOME, HOME)
  assert.equal(env.HOMEBREW_PREFIX, '/opt')
  assert.equal(env.PATH_INFO, 'x')
})

test('requireSecret: credential_missing for native families with empty/undefined secret; never for external/fake', () => {
  const isMissing = (e: unknown) => e instanceof RunFailure && e.error.code === 'credential_missing'
  assert.throws(() => requireSecret('cursor', ''), isMissing)
  assert.throws(() => requireSecret('cursor', undefined), isMissing)
  assert.throws(() => requireSecret('antigravity', ''), isMissing)
  assert.doesNotThrow(() => requireSecret('cursor', 'key'))
  assert.doesNotThrow(() => requireSecret('external', ''))
  assert.doesNotThrow(() => requireSecret('external', undefined))
  assert.doesNotThrow(() => requireSecret('fake', undefined))
})
