import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { mergeNativeModels, type NativeModelFamily } from '../native-models.js'
import { loadProviderManifests, ManifestError, parseProviderManifest } from '../provider-manifest.js'

const BUNDLED = fileURLToPath(new URL('../../../providers', import.meta.url))

const spawnYaml = `
family: cursor2
kind: spawn
binary: agent
parser: cursor
argv: ['--resume', '{resume}', '{prompt}']
models: { source: none }
capabilities:
  streaming: true
  resume: true
  modes: [ask, plan, agent]
  attachments: [file]
  compaction: internal
  contextUsage: estimate
  mcp: true
`

test('parseProviderManifest accepts a spawn manifest and records the file', () => {
  const manifest = parseProviderManifest(spawnYaml, 'providers/cursor2.yaml')
  assert.equal(manifest.family, 'cursor2')
  assert.equal(manifest.kind, 'spawn')
  assert.equal(manifest.parser, 'cursor')
  assert.deepEqual(manifest.argv, ['--resume', '{resume}', '{prompt}'])
  assert.equal(manifest.capabilities.compaction, 'internal')
  assert.equal(manifest.file, 'providers/cursor2.yaml')
})

test('kind acp fails with "kind reservado" and the file path', () => {
  assert.throws(
    () => parseProviderManifest(spawnYaml.replace('kind: spawn', 'kind: acp'), '/tmp/acp.yaml'),
    (err: unknown) => err instanceof ManifestError && err.message.includes('kind reservado') && err.message.includes('/tmp/acp.yaml'),
  )
})

test('an invalid field names the file and the field', () => {
  assert.throws(
    () => parseProviderManifest(spawnYaml.replace('compaction: internal', 'compaction: magic'), 'providers/bad.yaml'),
    (err: unknown) => err instanceof ManifestError && err.message.includes('providers/bad.yaml') && err.message.includes('capabilities.compaction'),
  )
})

test('loadProviderManifests rejects a repeated family and skips a missing directory', () => {
  const root = mkdtempSync(join(tmpdir(), 'manifests-'))
  writeFileSync(join(root, 'a.yaml'), spawnYaml)
  writeFileSync(join(root, 'b.yaml'), spawnYaml.replace('family: cursor2', 'family: cursor2'))
  assert.throws(
    () => loadProviderManifests([root, join(root, 'missing')]),
    (err: unknown) => err instanceof ManifestError && err.message.includes('duplicate family "cursor2"'),
  )
  writeFileSync(join(root, 'b.yaml'), spawnYaml.replace('family: cursor2', 'family: cursor3'))
  const loaded = loadProviderManifests([root, join(root, 'missing')])
  assert.deepEqual(loaded.map((manifest) => manifest.family).sort(), ['cursor2', 'cursor3'])
})

test('bundled providers mirror the seven families: kind, compaction, credential and static model ids', () => {
  const loaded = loadProviderManifests([BUNDLED])
  assert.deepEqual(
    loaded.map((manifest) => manifest.family).sort(),
    ['antigravity', 'claude', 'codex', 'copilot', 'cursor', 'external', 'fake'],
  )
  const byFamily = new Map(loaded.map((manifest) => [manifest.family, manifest]))
  for (const family of ['cursor', 'claude', 'codex', 'copilot', 'antigravity'] as const) {
    const manifest = byFamily.get(family)
    assert.equal(manifest?.kind, 'spawn', family)
    assert.equal(manifest?.capabilities.compaction, 'internal', family)
    assert.equal(manifest?.capabilities.contextUsage, 'exact', family)
    assert.ok(manifest?.argv?.includes('{prompt}'), family)
    assert.deepEqual(manifest?.models.static, mergeNativeModels(family as NativeModelFamily, []).map((m) => m.id), family)
  }
  assert.equal(byFamily.get('cursor')?.credentialEnv, 'CURSOR_API_KEY')
  assert.equal(byFamily.get('claude')?.credentialEnv, 'ANTHROPIC_API_KEY')
  assert.equal(byFamily.get('codex')?.credentialEnv, 'OPENAI_API_KEY')
  assert.equal(byFamily.get('copilot')?.credentialEnv, 'COPILOT_GITHUB_TOKEN')
  assert.equal(byFamily.get('antigravity')?.credentialEnv, 'GEMINI_API_KEY')
  assert.equal(byFamily.get('external')?.kind, 'harness')
  assert.equal(byFamily.get('external')?.capabilities.compaction, 'controllable')
  assert.equal(byFamily.get('external')?.models.source, 'remote')
  assert.equal(byFamily.get('fake')?.kind, 'fake')
  assert.equal(byFamily.get('fake')?.capabilities.compaction, 'controllable')
  assert.deepEqual(byFamily.get('fake')?.models.static, ['fake-model'])
})
