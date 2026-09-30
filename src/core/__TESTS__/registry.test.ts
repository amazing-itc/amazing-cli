import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, test } from 'node:test'
import { RunFailure } from '../errors.js'
import { createRegistry, type CreateRunInput } from '../registry.js'
import type { RunRecord } from '../types.js'

let dataRoot: string
beforeEach(() => {
  dataRoot = mkdtempSync(path.join(os.tmpdir(), 'registry-'))
})
afterEach(() => {
  rmSync(dataRoot, { recursive: true, force: true })
})

function spec(id: string, extra: Partial<CreateRunInput> = {}): CreateRunInput {
  return { id, product: 'aw', family: 'fake', workspaceDir: '/ws', prompt: 'hi', ...extra }
}

async function boot() {
  const reg = createRegistry({ dataRoot })
  await reg.init()
  return reg
}

async function rejectsWith(p: Promise<unknown>, code: string) {
  await assert.rejects(p, (err: unknown) => err instanceof RunFailure && err.error.code === code)
}

test('create defaults status QUEUED, createdAt, lastSeq 0 and persists meta.json', async () => {
  const reg = await boot()
  const rec = await reg.create(spec('r1', { modelId: 'm', meta: { cardId: '7' } }))
  assert.equal(rec.status, 'QUEUED')
  assert.equal(rec.lastSeq, 0)
  assert.ok(!Number.isNaN(Date.parse(rec.createdAt)))
  assert.equal(reg.runDir('r1'), path.join(dataRoot, 'runs', 'r1'))
  const onDisk = JSON.parse(readFileSync(path.join(reg.runDir('r1'), 'meta.json'), 'utf8'))
  assert.deepEqual(onDisk, rec)
  assert.equal(reg.get('r1'), rec)
  assert.equal(reg.get('nope'), undefined)
})

test('list filters by product/status and sorts by createdAt desc', async () => {
  const reg = await boot()
  await reg.create(spec('a', { product: 'aw' }))
  await new Promise((r) => setTimeout(r, 5))
  await reg.create(spec('b', { product: 'vector', status: 'RUNNING' }))
  await new Promise((r) => setTimeout(r, 5))
  await reg.create(spec('c', { product: 'aw', status: 'SUCCEEDED' }))

  assert.deepEqual(reg.list().map((r) => r.id), ['c', 'b', 'a'])
  assert.deepEqual(reg.list({ product: 'aw' }).map((r) => r.id), ['c', 'a'])
  assert.deepEqual(reg.list({ status: 'RUNNING' }).map((r) => r.id), ['b'])
  assert.deepEqual(reg.list({ product: 'aw', status: 'QUEUED' }).map((r) => r.id), ['a'])
})

test('update merges, persists atomically and survives reload in a second instance', async () => {
  const reg = await boot()
  await reg.create(spec('r1'))
  const updated = await reg.update('r1', { status: 'RUNNING', startedAt: '2026-01-01T00:00:00.000Z', lastSeq: 3 })
  assert.equal(updated.status, 'RUNNING')
  assert.equal(updated.lastSeq, 3)
  assert.equal(updated.prompt, 'hi')
  assert.ok(!existsSync(path.join(reg.runDir('r1'), 'meta.json.tmp')), 'tmp file must be renamed away')

  // recoverOnBoot will flip RUNNING; use SUCCEEDED to check plain reload fidelity.
  await reg.update('r1', { status: 'SUCCEEDED', finishedAt: '2026-01-01T00:01:00.000Z', usage: { inputTokens: 1 } })
  const reg2 = await boot()
  assert.deepEqual(reg2.get('r1'), reg.get('r1'))
  assert.deepEqual(reg2.list().map((r) => r.id), ['r1'])
})

test('update of unknown id → not_found', async () => {
  const reg = await boot()
  await rejectsWith(reg.update('ghost', { status: 'FAILED' }), 'not_found')
})

test('duplicate id → duplicate_run', async () => {
  const reg = await boot()
  await reg.create(spec('dup'))
  await rejectsWith(reg.create(spec('dup')), 'duplicate_run')
})

test('bad runId → validation (path traversal and bad chars rejected)', async () => {
  const reg = await boot()
  for (const bad of ['.', '..', '../escape', 'a/b', 'has space', '', 'x'.repeat(129), 'ünïcode', '.hidden', '-flag']) {
    await rejectsWith(reg.create(spec(bad)), 'validation')
  }
  await reg.create(spec('ok.id_1-A'))
  await reg.create(spec('x'.repeat(128)))
  assert.ok(!existsSync(path.join(dataRoot, 'escape')))
  assert.ok(!existsSync(path.join(dataRoot, 'meta.json')))
  assert.ok(!existsSync(path.join(dataRoot, 'runs', 'meta.json')))
  assert.ok(!existsSync(path.join(dataRoot, 'events.jsonl')))
  assert.ok(!existsSync(path.join(dataRoot, 'runs', 'events.jsonl')))
})

test('concurrent updates on one run compose, persist a consistent meta.json and leave no tmp files', async () => {
  const reg = await boot()
  await reg.create(spec('r'))
  for (let i = 0; i < 20; i++) {
    await Promise.all([reg.update('r', { status: 'RUNNING' }), reg.update('r', { lastSeq: i }), reg.update('r', { sessionRef: `s${i}` })])
    const rec = reg.get('r')!
    assert.equal(rec.status, 'RUNNING')
    assert.equal(rec.lastSeq, i)
    assert.equal(rec.sessionRef, `s${i}`)
    assert.deepEqual(JSON.parse(readFileSync(path.join(reg.runDir('r'), 'meta.json'), 'utf8')), rec)
  }
  assert.deepEqual(readdirSync(reg.runDir('r')), ['meta.json'], 'no *.tmp may remain')
})

test('concurrent create with the same id: exactly one wins, the other → duplicate_run', async () => {
  const reg = await boot()
  const results = await Promise.allSettled([reg.create(spec('same')), reg.create(spec('same'))])
  assert.deepEqual(results.map((r) => r.status), ['fulfilled', 'rejected'])
  const rejected = results[1] as PromiseRejectedResult
  assert.ok(rejected.reason instanceof RunFailure && rejected.reason.error.code === 'duplicate_run')
})

test('tampered meta.json (id pointing outside runs/) is skipped and never becomes a path', async () => {
  const sandbox = mkdtempSync(path.join(os.tmpdir(), 'registry-sandbox-'))
  const nestedRoot = path.join(sandbox, 'data')
  try {
    const reg = createRegistry({ dataRoot: nestedRoot })
    await reg.init()
    await reg.create(spec('good'))
    const tamperedDir = path.join(nestedRoot, 'runs', 'tampered')
    mkdirSync(tamperedDir)
    writeFileSync(
      path.join(tamperedDir, 'meta.json'),
      JSON.stringify({ ...spec('../../evil'), status: 'RUNNING', createdAt: new Date().toISOString(), lastSeq: 0 }),
    )
    // Also: a valid-looking id that does not match its directory name.
    const renamedDir = path.join(nestedRoot, 'runs', 'renamed')
    mkdirSync(renamedDir)
    writeFileSync(path.join(renamedDir, 'meta.json'), readFileSync(path.join(reg.runDir('good'), 'meta.json')))

    const reg2 = createRegistry({ dataRoot: nestedRoot })
    const result = await reg2.init()
    assert.deepEqual(result.recovered, [])
    assert.deepEqual(result.skipped.sort(), ['renamed', 'tampered'])
    assert.deepEqual(reg2.list().map((r) => r.id), ['good'])
    assert.equal(reg2.get('../../evil'), undefined)
    assert.deepEqual(readdirSync(sandbox), ['data'], 'nothing may be created outside dataRoot')
    assert.ok(!existsSync(path.join(sandbox, 'evil')))
    assert.ok(!existsSync(path.join(sandbox, 'data', 'evil')))
  } finally {
    rmSync(sandbox, { recursive: true, force: true })
  }
})

test('recoverOnBoot: RUNNING→FAILED interrupted, QUEUED stays, SUCCEEDED untouched, returns ids', async () => {
  const reg = await boot()
  await reg.create(spec('running', { status: 'RUNNING' }))
  await reg.create(spec('queued'))
  await reg.create(spec('done', { status: 'SUCCEEDED' }))

  const reg2 = createRegistry({ dataRoot })
  assert.deepEqual(await reg2.init(), { recovered: ['running'], skipped: [] })

  const running = reg2.get('running')!
  assert.equal(running.status, 'FAILED')
  assert.deepEqual(running.error, { code: 'interrupted', message: 'amazing-cli restarted while run was RUNNING' })
  assert.ok(running.finishedAt && !Number.isNaN(Date.parse(running.finishedAt)))
  assert.equal(reg2.get('queued')!.status, 'QUEUED')
  assert.deepEqual(reg2.get('done'), reg.get('done'))

  // Recovery is persisted, so a third boot sees FAILED and recovers nothing.
  const raw = JSON.parse(readFileSync(path.join(reg2.runDir('running'), 'meta.json'), 'utf8'))
  assert.equal(raw.status, 'FAILED')
  const reg3 = createRegistry({ dataRoot })
  await reg3.init()
  assert.deepEqual(await reg3.recoverOnBoot(), [])

  // Direct call returns the recovered ids.
  const reg4 = await boot()
  await reg4.create(spec('again', { status: 'RUNNING' }))
  assert.deepEqual(await reg4.recoverOnBoot(), ['again'])
})

test('credential key is stripped from meta.json; prompt/meta content is stored as-is', async () => {
  const reg = await boot()
  const withCredential = { ...spec('r1', { prompt: 'use sk-live-abc', meta: { note: 'sk-live-abc' } }), credential: { secret: 'sk-live-abc' } }
  const rec = await reg.create(withCredential as unknown as CreateRunInput)
  assert.ok(!('credential' in rec))
  await reg.update('r1', { status: 'RUNNING', credential: { secret: 'another' } } as unknown as Partial<RunRecord>)

  const raw = readFileSync(path.join(reg.runDir('r1'), 'meta.json'), 'utf8')
  assert.ok(!raw.includes('credential'), raw)
  assert.ok(!raw.includes('secret'), raw)
  // Registry does not redact content — that is the events layer's job.
  assert.ok(raw.includes('use sk-live-abc'))
  assert.equal(JSON.parse(raw).meta.note, 'sk-live-abc')
})

test('init skips run dirs without meta.json (reported) and ignores non-run entries', async () => {
  const reg = await boot()
  await reg.create(spec('good'))
  mkdirSync(path.join(dataRoot, 'runs', 'empty-dir'))
  writeFileSync(path.join(dataRoot, 'runs', 'stray.txt'), 'x')
  const reg2 = createRegistry({ dataRoot })
  assert.deepEqual(await reg2.init(), { recovered: [], skipped: ['empty-dir'] })
  assert.deepEqual(reg2.list().map((r) => r.id), ['good'])
})

test('meta.json missing required fields is skipped (reported) and list() does not throw', async () => {
  const reg = await boot()
  await reg.create(spec('good'))
  mkdirSync(path.join(dataRoot, 'runs', 'partial'))
  writeFileSync(path.join(dataRoot, 'runs', 'partial', 'meta.json'), JSON.stringify({ id: 'partial' }))

  const reg2 = createRegistry({ dataRoot })
  assert.deepEqual(await reg2.init(), { recovered: [], skipped: ['partial'] })
  assert.doesNotThrow(() => reg2.list())
  assert.doesNotThrow(() => reg2.list({ product: 'aw', status: 'QUEUED' }))
  assert.deepEqual(reg2.list().map((r) => r.id), ['good'])
  assert.equal(reg2.get('partial'), undefined)
})

test('two registry instances on one dataRoot: concurrent updates on one id never collide on tmp names', async () => {
  const regA = await boot()
  await regA.create(spec('shared'))
  const regB = await boot()
  await Promise.all([
    regA.update('shared', { lastSeq: 1 }),
    regB.update('shared', { lastSeq: 2 }),
    regA.update('shared', { sessionRef: 'a' }),
    regB.update('shared', { sessionRef: 'b' }),
  ])
  assert.deepEqual(readdirSync(regA.runDir('shared')), ['meta.json'])
  assert.doesNotThrow(() => JSON.parse(readFileSync(path.join(regA.runDir('shared'), 'meta.json'), 'utf8')))
})

test('corrupt meta.json for one run: boot still loads the others and reports the id in skipped', async () => {
  const reg = await boot()
  await reg.create(spec('ok1'))
  await reg.create(spec('broken'))
  await reg.create(spec('ok2', { status: 'RUNNING' }))
  writeFileSync(path.join(reg.runDir('broken'), 'meta.json'), '{"id":"broken","status":"RUNN')

  const reg2 = createRegistry({ dataRoot })
  const result = await reg2.init()
  assert.deepEqual(result, { recovered: ['ok2'], skipped: ['broken'] })
  assert.deepEqual(reg2.list().map((r) => r.id).sort(), ['ok1', 'ok2'])
  assert.equal(reg2.get('broken'), undefined)
  assert.equal(reg2.get('ok2')!.status, 'FAILED')
})
