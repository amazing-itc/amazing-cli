import assert from 'node:assert/strict'
import { test } from 'node:test'
import { assertCompact, assertSession, assertTurn } from '../capabilities.js'
import { RunFailure } from '../errors.js'
import type { ProviderManifest } from '../provider-manifest.js'

function manifest(over: Partial<ProviderManifest['capabilities']> = {}): ProviderManifest {
  return {
    family: 'narrow',
    kind: 'spawn',
    file: 'narrow.yaml',
    models: { source: 'none' },
    capabilities: {
      streaming: true,
      resume: false,
      modes: ['ask'],
      attachments: ['file'],
      compaction: 'none',
      contextUsage: 'estimate',
      mcp: false,
      ...over,
    },
  }
}

const unsupported = (fn: () => void, field: string) => {
  assert.throws(fn, (err: unknown) => err instanceof RunFailure && err.error.code === 'unsupported' && err.error.message.includes(field))
}

test('assertTurn refuses mode, attachment, resume and mcp that the manifest does not declare', () => {
  const declared = manifest()
  unsupported(() => assertTurn(declared, { mode: 'plan' }), 'capabilities.modes')
  unsupported(() => assertTurn(declared, { attachments: [{ kind: 'image' }] }), 'capabilities.attachments')
  unsupported(() => assertTurn(declared, { sessionRef: 'thread-1' }), 'resume')
  unsupported(() => assertTurn(declared, { mcpServers: [{ name: 'a', url: 'http://x' }] }), 'mcp')
  assert.doesNotThrow(() => assertTurn(declared, { mode: 'ask', attachments: [{ kind: 'file' }] }))
  assert.doesNotThrow(() => assertTurn(declared, {}))
})

test('assertSession refuses a mode or a compaction policy the manifest does not allow', () => {
  unsupported(() => assertSession(manifest(), { mode: 'agent' }), 'capabilities.modes')
  unsupported(() => assertSession(manifest(), { policy: { compaction: { auto: true } } }), 'compaction')
  assert.doesNotThrow(() => assertSession(manifest({ compaction: 'controllable' }), { mode: 'ask', policy: { compaction: { auto: false } } }))
})

test('assertCompact allows only controllable', () => {
  unsupported(() => assertCompact(manifest({ compaction: 'internal' })), 'compaction')
  unsupported(() => assertCompact(manifest({ compaction: 'none' })), 'compaction')
  assert.doesNotThrow(() => assertCompact(manifest({ compaction: 'controllable' })))
})
