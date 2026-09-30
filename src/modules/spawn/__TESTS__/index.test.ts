import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { ProviderManifest } from '../../../core/provider-manifest.js'
import { createSpawnProvider } from '../index.js'

test('createSpawnProvider rejects a parser that was not registered', () => {
  const manifest: ProviderManifest = {
    family: 'cursor',
    kind: 'spawn',
    parser: 'no-such-parser',
    binary: 'agent',
    argv: ['{prompt}'],
    file: 'missing.yaml',
    models: { source: 'static', static: [] },
    capabilities: {
      streaming: true,
      resume: false,
      modes: ['agent'],
      attachments: [],
      compaction: 'none',
      contextUsage: 'none',
      mcp: false,
    },
  }
  assert.throws(() => createSpawnProvider(manifest), /unknown parser "no-such-parser"/)
})
