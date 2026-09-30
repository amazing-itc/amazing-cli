import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { parse } from 'yaml'

export const FAMILY_RE = /^[a-z][a-z0-9-]{1,31}$/
const KINDS = new Set(['spawn', 'harness', 'fake', 'acp'])
const MODEL_SOURCES = new Set(['static', 'remote', 'none'])
const COMPACTION = new Set(['none', 'internal', 'controllable'])
const CONTEXT_USAGE = new Set(['none', 'estimate', 'exact'])
const ATTACHMENTS = new Set(['image', 'file', 'folder'])

export interface ProviderManifest {
  family: string
  kind: 'spawn' | 'harness' | 'fake' | 'acp'
  label?: string
  credentialEnv?: string
  binary?: string
  argv?: string[]
  /** Used instead of `argv` when the turn has a resume ref. Codex's resume shape is not a flag insertion. */
  resumeArgv?: string[]
  /** Prepended to `{prompt}` when mode is `plan`. */
  planPrompt?: string
  parser?: string
  permissions?: string[]
  models: { source: 'static' | 'remote' | 'none'; static?: string[] }
  capabilities: {
    streaming: boolean
    resume: boolean
    modes: string[]
    attachments: ('image' | 'file' | 'folder')[]
    compaction: 'none' | 'internal' | 'controllable'
    contextUsage: 'none' | 'estimate' | 'exact'
    mcp: boolean
  }
  file: string
}

export class ManifestError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ManifestError'
  }
}

/** Reads every `*.yaml` / `*.yml` in `dirs` (missing dirs are skipped). Duplicate `family` fails. */
export function loadProviderManifests(dirs: string[]): ProviderManifest[] {
  const found: ProviderManifest[] = []
  const seen = new Map<string, string>()
  for (const dir of dirs) {
    let names: string[]
    try {
      names = readdirSync(dir)
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') continue
      throw err
    }
    for (const name of names.filter((entry) => entry.endsWith('.yaml') || entry.endsWith('.yml')).sort()) {
      const file = path.join(dir, name)
      const manifest = parseProviderManifest(readFileSync(file, 'utf8'), file)
      const previous = seen.get(manifest.family)
      if (previous) throw new ManifestError(`duplicate family "${manifest.family}" in ${file} (already declared in ${previous})`)
      seen.set(manifest.family, file)
      found.push(manifest)
    }
  }
  return found
}

export function parseProviderManifest(text: string, file: string): ProviderManifest {
  let raw: unknown
  try {
    raw = parse(text)
  } catch (err) {
    throw new ManifestError(`${file}: invalid YAML (${err instanceof Error ? err.message : String(err)})`)
  }
  if (!isRecord(raw)) throw new ManifestError(`${file}: manifest must be a mapping`)
  const family = requiredString(raw, 'family', file)
  if (!FAMILY_RE.test(family)) throw new ManifestError(`${file}: field "family" must match ${FAMILY_RE}`)
  const kind = requiredString(raw, 'kind', file)
  if (!KINDS.has(kind)) throw new ManifestError(`${file}: field "kind" must be spawn, harness, fake or acp`)
  if (kind === 'acp') throw new ManifestError(`${file}: kind reservado (acp is not implemented)`)
  const models = parseModels(raw.models, file)
  const capabilities = parseCapabilities(raw.capabilities, file)
  if (kind === 'spawn') {
    if (!Array.isArray(raw.argv) || raw.argv.length === 0 || raw.argv.some((part) => typeof part !== 'string')) {
      throw new ManifestError(`${file}: field "argv" must be a non-empty string list when kind is spawn`)
    }
    if (typeof raw.parser !== 'string' || raw.parser.length === 0) throw new ManifestError(`${file}: field "parser" is required when kind is spawn`)
    if (typeof raw.binary !== 'string' || raw.binary.length === 0) throw new ManifestError(`${file}: field "binary" is required when kind is spawn`)
    if (raw.resumeArgv !== undefined && (!Array.isArray(raw.resumeArgv) || raw.resumeArgv.some((part) => typeof part !== 'string'))) {
      throw new ManifestError(`${file}: field "resumeArgv" must be a string list`)
    }
    if (raw.planPrompt !== undefined && typeof raw.planPrompt !== 'string') {
      throw new ManifestError(`${file}: field "planPrompt" must be a string`)
    }
  }
  return {
    family,
    kind: kind as ProviderManifest['kind'],
    ...(typeof raw.label === 'string' ? { label: raw.label } : {}),
    ...(typeof raw.credentialEnv === 'string' ? { credentialEnv: raw.credentialEnv } : {}),
    ...(typeof raw.binary === 'string' ? { binary: raw.binary } : {}),
    ...(Array.isArray(raw.argv) ? { argv: raw.argv as string[] } : {}),
    ...(Array.isArray(raw.resumeArgv) ? { resumeArgv: raw.resumeArgv as string[] } : {}),
    ...(typeof raw.planPrompt === 'string' ? { planPrompt: raw.planPrompt } : {}),
    ...(typeof raw.parser === 'string' ? { parser: raw.parser } : {}),
    ...(Array.isArray(raw.permissions) ? { permissions: raw.permissions.filter((item): item is string => typeof item === 'string') } : {}),
    models,
    capabilities,
    file,
  }
}

function parseModels(value: unknown, file: string): ProviderManifest['models'] {
  if (!isRecord(value)) throw new ManifestError(`${file}: field "models" must be a mapping`)
  const source = value.source
  if (typeof source !== 'string' || !MODEL_SOURCES.has(source)) {
    throw new ManifestError(`${file}: field "models.source" must be static, remote or none`)
  }
  const models: ProviderManifest['models'] = { source: source as ProviderManifest['models']['source'] }
  if (value.static !== undefined) {
    if (!Array.isArray(value.static) || value.static.some((item) => typeof item !== 'string')) {
      throw new ManifestError(`${file}: field "models.static" must be a string list`)
    }
    models.static = value.static as string[]
  }
  return models
}

function parseCapabilities(value: unknown, file: string): ProviderManifest['capabilities'] {
  if (!isRecord(value)) throw new ManifestError(`${file}: field "capabilities" must be a mapping`)
  const streaming = requiredBoolean(value, 'streaming', file, 'capabilities.streaming')
  const resume = requiredBoolean(value, 'resume', file, 'capabilities.resume')
  const mcp = requiredBoolean(value, 'mcp', file, 'capabilities.mcp')
  if (!Array.isArray(value.modes) || value.modes.some((item) => typeof item !== 'string')) {
    throw new ManifestError(`${file}: field "capabilities.modes" must be a string list`)
  }
  if (!Array.isArray(value.attachments) || value.attachments.some((item) => typeof item !== 'string' || !ATTACHMENTS.has(item))) {
    throw new ManifestError(`${file}: field "capabilities.attachments" must list image, file or folder`)
  }
  if (typeof value.compaction !== 'string' || !COMPACTION.has(value.compaction)) {
    throw new ManifestError(`${file}: field "capabilities.compaction" must be none, internal or controllable`)
  }
  if (typeof value.contextUsage !== 'string' || !CONTEXT_USAGE.has(value.contextUsage)) {
    throw new ManifestError(`${file}: field "capabilities.contextUsage" must be none, estimate or exact`)
  }
  return {
    streaming,
    resume,
    modes: value.modes as string[],
    attachments: value.attachments as ProviderManifest['capabilities']['attachments'],
    compaction: value.compaction as ProviderManifest['capabilities']['compaction'],
    contextUsage: value.contextUsage as ProviderManifest['capabilities']['contextUsage'],
    mcp,
  }
}

function requiredString(raw: Record<string, unknown>, field: string, file: string): string {
  const value = raw[field]
  if (typeof value !== 'string' || value.length === 0) throw new ManifestError(`${file}: field "${field}" must be a string`)
  return value
}

function requiredBoolean(raw: Record<string, unknown>, field: string, file: string, label: string): boolean {
  const value = raw[field]
  if (typeof value !== 'boolean') throw new ManifestError(`${file}: field "${label}" must be a boolean`)
  return value
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}
