import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const SCRIPT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../scripts/check-boundaries.mjs')

// Fixture sources are assembled with this token so the boundary check (which
// also scans this test file) does not mistake the fixture strings for real imports.
const IMPORT = 'import'

function fixture(files: Record<string, string>): string {
  const root = mkdtempSync(path.join(os.tmpdir(), 'boundaries-'))
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(root, 'src', rel)
    mkdirSync(path.dirname(abs), { recursive: true })
    writeFileSync(abs, content)
  }
  return root
}

function run(root: string) {
  const r = spawnSync(process.execPath, [SCRIPT, '--root', root], { encoding: 'utf8' })
  rmSync(root, { recursive: true, force: true })
  return r
}

test('clean fixture passes', () => {
  const r = run(
    fixture({
      'core/types.ts': 'export type A = 1\n',
      'core/provider.ts': `${IMPORT} type { A } from './types.js'\nexport type P = A\n`,
      'modules/a/x.ts': `${IMPORT} type { P } from '../../core/provider.js'\nexport const x: P = 1\n`,
      'modules/b/y.ts': "export * from '../../core/types.js'\n",
      'modules/index.ts': `${IMPORT} { x } from './a/x.js'\n${IMPORT} './b/y.js'\nexport { x }\n`,
      'api/server.ts': `${IMPORT} type { P } from '../core/provider.js'\nexport const s: P = 1\n`,
      'server.ts': `${IMPORT} { x } from './modules/index.js'\nexport const main = x\n`,
      'test-support/app.ts': `${IMPORT} { x } from '../modules/index.js'\nexport const testMain = x\n`,
    }),
  )
  assert.equal(r.status, 0, r.stderr)
  assert.match(r.stdout, /boundaries OK \(8 files\)/)
})

test('a file outside the composition roots importing modules/index.ts fails', () => {
  const r = run(
    fixture({
      'tools/wire.ts': `${IMPORT} { r } from '../modules/index.js'\nexport const w = r\n`,
      'modules/index.ts': 'export const r = 1\n',
    }),
  )
  assert.equal(r.status, 1)
  assert.match(r.stderr, /tools\/wire\.ts -> modules\/index\.ts: only composition roots/)
})

test('module importing another module fails and reports both paths', () => {
  const r = run(
    fixture({
      'modules/a/x.ts': `${IMPORT} { y } from '../b/y.js'\nexport const x = y\n`,
      'modules/b/y.ts': 'export const y = 1\n',
    }),
  )
  assert.equal(r.status, 1)
  assert.match(r.stderr, /modules\/a\/x\.ts/)
  assert.match(r.stderr, /modules\/b\/y\.ts/)
})

test('core importing a module fails', () => {
  const r = run(
    fixture({
      'core/z.ts': `${IMPORT} { x } from '../modules/a/x.js'\nexport const z = x\n`,
      'modules/a/x.ts': 'export const x = 1\n',
    }),
  )
  assert.equal(r.status, 1)
  assert.match(r.stderr, /core\/z\.ts -> modules\/a\/x\.ts/)
})

test('core importing modules/index.ts fails', () => {
  const r = run(
    fixture({
      'core/z.ts': `${IMPORT} { r } from '../modules/index.js'\nexport const z = r\n`,
      'modules/index.ts': 'export const r = 1\n',
    }),
  )
  assert.equal(r.status, 1)
  assert.match(r.stderr, /core\/z\.ts -> modules\/index\.ts/)
})

test('module importing modules/index.ts fails', () => {
  const r = run(
    fixture({
      'modules/a/x.ts': `${IMPORT} { r } from '../index.js'\nexport const x = r\n`,
      'modules/index.ts': 'export const r = 1\n',
    }),
  )
  assert.equal(r.status, 1)
  assert.match(r.stderr, /modules\/a\/x\.ts -> modules\/index\.ts/)
})

test('missing src/ under --root exits 2 with one-line error', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'boundaries-'))
  const r = run(root)
  assert.equal(r.status, 2)
  assert.match(r.stderr, /no src\/ directory/)
  assert.equal(r.stderr.trim().split('\n').length, 1)
})

test('api importing a module directly fails; dynamic import is detected', () => {
  const r = run(
    fixture({
      'api/server.ts': `export const load = () => ${IMPORT}('../modules/a/x.js')\n`,
      'modules/a/x.ts': 'export const x = 1\n',
    }),
  )
  assert.equal(r.status, 1)
  assert.match(r.stderr, /api\/server\.ts -> modules\/a\/x\.ts/)
})
