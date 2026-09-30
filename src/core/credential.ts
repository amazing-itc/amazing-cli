import path from 'node:path'
import { fail } from './errors.js'
import type { Family } from './types.js'

export type NativeFamily = Exclude<Family, 'external' | 'fake'>

/** Env var each native CLI reads its credential from. */
export const CREDENTIAL_ENV: Record<NativeFamily, string> = {
  cursor: 'CURSOR_API_KEY',
  claude: 'ANTHROPIC_API_KEY',
  codex: 'OPENAI_API_KEY',
  copilot: 'COPILOT_GITHUB_TOKEN',
  antigravity: 'GEMINI_API_KEY',
}

/** Never inherited by a child: only the run's own credential may reach the CLI, under its family's var. */
export const SENSITIVE_ENV: readonly string[] = [
  ...new Set([
    ...Object.values(CREDENTIAL_ENV),
    'GH_TOKEN',
    'GITHUB_TOKEN',
    'OPENAI_API_KEY',
    'ANTHROPIC_API_KEY',
    'GEMINI_API_KEY',
    'GOOGLE_API_KEY',
    'CURSOR_API_KEY',
    'LITELLM_MASTER_KEY',
    'AMAZING_CLI_API_KEY',
  ]),
]

/**
 * Catches secrets the explicit list does not know by name: any `_`-delimited segment that is a secret word
 * (`API_KEY`, `TOKEN`, `AWS_SECRET_ACCESS_KEY`, `PASSWD`). Over-stripping (`API_KEY_ROTATION_DAYS`) is preferred to leaking.
 */
export const SENSITIVE_ENV_PATTERN = /(^|_)(API_?KEY|TOKEN|SECRET|PASSWORD|PASSWD)(_|$)/i

/** Keys `childEnv` owns; `extra` may not override them or the per-run HOME isolation is void. */
const ISOLATION_ENV_PATTERN = /^(HOME|USERPROFILE|PATH|XDG_.*)$/

export function isSensitiveEnvKey(key: string): boolean {
  return SENSITIVE_ENV.includes(key) || SENSITIVE_ENV_PATTERN.test(key)
}

export function credentialEnvFor(family: Family): string | undefined {
  return (CREDENTIAL_ENV as Record<string, string | undefined>)[family]
}

export interface ChildEnvInput {
  /** Default `process.env`. */
  base?: NodeJS.ProcessEnv
  family: Family
  /** Manifest `credentialEnv`. Falls back to the built-in map for the five native families. */
  credentialEnv?: string
  secret?: string
  homeDir: string
  extra?: Record<string, string>
}

/**
 * Child env: inherited vars minus every sensitive key (explicit list + pattern), HOME/XDG pointed at
 * the run's isolated home, family credential injected. `extra` may not smuggle a sensitive key in,
 * except the family's own credential var.
 */
export function childEnv({ base = process.env, family, credentialEnv, secret, homeDir, extra = {} }: ChildEnvInput): Record<string, string> {
  const credentialVar = credentialEnv ?? credentialEnvFor(family)
  for (const key of Object.keys(extra)) {
    if (key !== credentialVar && isSensitiveEnvKey(key)) {
      throw fail('validation', `extra env key "${key}" is sensitive and may not be set for family "${family}"`)
    }
    if (ISOLATION_ENV_PATTERN.test(key)) {
      throw fail('validation', `extra env key "${key}" would defeat HOME isolation and may not be overridden`)
    }
  }
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(base)) {
    if (value !== undefined && !isSensitiveEnvKey(key)) env[key] = value
  }
  env.HOME = homeDir
  env.USERPROFILE = homeDir
  env.XDG_CONFIG_HOME = path.join(homeDir, '.config')
  env.XDG_STATE_HOME = path.join(homeDir, '.local', 'state')
  env.XDG_DATA_HOME = path.join(homeDir, '.local', 'share')
  env.XDG_CACHE_HOME = path.join(homeDir, '.cache')
  if (credentialVar !== undefined && secret) env[credentialVar] = secret
  return { ...env, ...extra }
}

/** Native families must carry a secret; `external`/`fake` never need one. */
export function requireSecret(family: Family, secret: string | undefined, credentialEnv?: string): void {
  const variable = credentialEnv ?? credentialEnvFor(family)
  if (variable !== undefined && !secret) {
    throw fail('credential_missing', `family "${family}" requires credential.secret (${variable})`)
  }
}
