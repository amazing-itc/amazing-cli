import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { loadProviderManifests, parseProviderManifest } from '../../core/provider-manifest.js'
import { createProviderRegistry } from '../../modules/index.js'
import { bundledProvidersDir } from '../../server.js'

const bundled = () => loadProviderManifests([bundledProvidersDir()])

test('registry instantiates spawn, harness and fake from the bundled manifests', () => {
  const manifests = bundled()
  const providers = createProviderRegistry({ manifests, enableFake: false })
  assert.deepEqual(
    [...providers.keys()].sort(),
    ['antigravity', 'claude', 'codex', 'copilot', 'cursor', 'external'],
  )
  assert.equal(providers.get('external')!.capabilities().models, 'remote')
  assert.equal(providers.get('cursor')!.capabilities().family, 'cursor')

  const withFake = createProviderRegistry({ manifests, enableFake: false, registerFake: true })
  assert.equal(withFake.get('fake')!.capabilities().family, 'fake')
  assert.equal(withFake.get('fake')!.capabilities().models, 'static')
})

test('enableFake keeps only the kind: fake manifest', () => {
  const providers = createProviderRegistry({ manifests: bundled(), enableFake: true })
  assert.deepEqual([...providers.keys()], ['fake'])
})

test('enableFake without a fake manifest fails before any provider is built', () => {
  const manifests = bundled().filter((manifest) => manifest.kind !== 'fake')
  assert.throws(() => createProviderRegistry({ manifests, enableFake: true }), /kind: fake/)
})

test('a spawn family that only exists as YAML uses the named parser', () => {
  const cursor = bundled().find((manifest) => manifest.family === 'cursor')!
  const copy = parseProviderManifest(
    `family: cursor2\nkind: spawn\nbinary: agent\nparser: cursor\nargv: ['{prompt}']\nmodels: { source: static, static: [auto] }\ncapabilities:\n  streaming: true\n  resume: true\n  modes: [ask, plan, agent]\n  attachments: [image, file, folder]\n  compaction: internal\n  contextUsage: exact\n  mcp: true\n`,
    'cursor2.yaml',
  )
  const providers = createProviderRegistry({ manifests: [cursor, copy], enableFake: false })
  assert.equal(providers.get('cursor2' as 'cursor')!.capabilities().family, 'cursor2')
  assert.equal(providers.get('cursor')!.capabilities().family, 'cursor')
})

test('kind harness is only the external module', () => {
  const dir = mkdtempSync(join(tmpdir(), 'harness-other-'))
  const file = join(dir, 'other.yaml')
  writeFileSync(
    file,
    `family: other\nkind: harness\nmodels: { source: remote }\ncapabilities:\n  streaming: true\n  resume: false\n  modes: [agent]\n  attachments: []\n  compaction: controllable\n  contextUsage: none\n  mcp: false\n`,
  )
  const manifests = loadProviderManifests([dir])
  assert.throws(() => createProviderRegistry({ manifests, enableFake: false }), /kind harness is only implemented for family "external"/)
})
