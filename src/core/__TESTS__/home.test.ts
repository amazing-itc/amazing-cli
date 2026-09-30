import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, test } from 'node:test'
import { RunFailure } from '../errors.js'
import { createHomeManager } from '../home.js'

let dataRoot: string
beforeEach(() => {
  dataRoot = mkdtempSync(path.join(os.tmpdir(), 'home-'))
})
afterEach(() => {
  rmSync(dataRoot, { recursive: true, force: true })
})

test('create makes {dataRoot}/sessions/{sessionId}/home with mode 0o700 and returns the path; idempotent', async () => {
  const homes = createHomeManager({ dataRoot })
  const dir = await homes.create('s1')
  assert.equal(dir, path.join(dataRoot, 'sessions', 's1', 'home'))
  assert.equal(homes.path('s1'), dir)
  assert.ok(statSync(dir).isDirectory())
  assert.equal(statSync(dir).mode & 0o777, 0o700)
  assert.equal(await homes.create('s1'), dir)
  assert.ok(!existsSync(path.join(dataRoot, 'runs')), 'homes never live under runs/ any more')
})

test('create keeps files already in the home (a second turn of the same session sees what the first left behind)', async () => {
  const homes = createHomeManager({ dataRoot })
  const dir = await homes.create('s1')
  writeFileSync(path.join(dir, 'chat.db'), 'turn-1')
  assert.equal(await homes.create('s1'), dir)
  assert.deepEqual(readdirSync(dir), ['chat.db'])
})

test('dispose removes only the home dir; meta.json and session.jsonl in the session dir remain', async () => {
  const homes = createHomeManager({ dataRoot })
  const dir = await homes.create('s1')
  writeFileSync(path.join(dir, '.credentials'), 'secret')
  const sessionDir = path.dirname(dir)
  assert.equal(sessionDir, path.join(dataRoot, 'sessions', 's1'))
  writeFileSync(path.join(sessionDir, 'meta.json'), '{}')
  writeFileSync(path.join(sessionDir, 'session.jsonl'), '')

  await homes.dispose('s1')
  assert.ok(!existsSync(dir))
  assert.ok(existsSync(path.join(sessionDir, 'meta.json')))
  assert.ok(existsSync(path.join(sessionDir, 'session.jsonl')))
  assert.deepEqual(readdirSync(sessionDir).sort(), ['meta.json', 'session.jsonl'])
  await homes.dispose('s1') // already gone: no throw
  await homes.dispose('never-created')
  assert.ok(!existsSync(path.join(dataRoot, 'sessions', 'never-created')), 'dispose never creates a session dir')
})

test('dispose of one session leaves the homes of other sessions untouched', async () => {
  const homes = createHomeManager({ dataRoot })
  const a = await homes.create('a')
  const b = await homes.create('b')
  writeFileSync(path.join(b, 'keep'), 'x')
  await homes.dispose('a')
  assert.ok(!existsSync(a))
  assert.ok(existsSync(path.join(b, 'keep')))
})

test('unsafe sessionId → validation and nothing is created outside sessions/', async () => {
  const homes = createHomeManager({ dataRoot })
  const isValidation = (e: unknown) => e instanceof RunFailure && e.error.code === 'validation' && /sessionId/.test(e.error.message)
  for (const bad of ['..', '../x', 'a/b', '', '.hidden']) {
    await assert.rejects(homes.create(bad), isValidation)
    await assert.rejects(homes.dispose(bad), isValidation)
  }
  assert.ok(!existsSync(path.join(dataRoot, 'sessions')))
  assert.ok(!existsSync(path.join(dataRoot, 'runs')))
  assert.ok(!existsSync(path.join(dataRoot, 'x')))
})
