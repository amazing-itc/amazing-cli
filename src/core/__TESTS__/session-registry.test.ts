import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, test } from 'node:test'
import { RunFailure } from '../errors.js'
import { createSessionRegistry } from '../session-registry.js'
import type { CreateSessionInput } from '../types.js'

let dataRoot: string
beforeEach(() => {
  dataRoot = mkdtempSync(path.join(os.tmpdir(), 'session-registry-'))
})
afterEach(() => {
  rmSync(dataRoot, { recursive: true, force: true })
})

function spec(id: string, extra: Partial<CreateSessionInput> = {}): CreateSessionInput {
  return { id, product: 'p1', family: 'fake', workspaceDir: '/ws', policy: { window: 'persistent' }, ...extra }
}

/** Deterministic clock: every call advances by one second. */
function ticking(start = Date.parse('2026-01-01T00:00:00.000Z')) {
  let t = start
  return () => new Date((t += 1000))
}

async function boot(clock?: () => Date) {
  const reg = createSessionRegistry({ dataRoot, clock })
  await reg.init()
  return reg
}

async function rejectsWith(p: Promise<unknown>, code: string) {
  await assert.rejects(p, (err: unknown) => err instanceof RunFailure && err.error.code === code)
}

const readMeta = (dir: string) => JSON.parse(readFileSync(path.join(dir, 'meta.json'), 'utf8'))

test('create defaults status IDLE, turnCount 0, createdAt = lastActivityAt, persists meta.json; get returns it', async () => {
  const reg = await boot(ticking())
  const s = await reg.create(spec('s1', { modelId: 'm', mode: 'agent', meta: { note: 'x' } }))
  assert.equal(s.status, 'IDLE')
  assert.equal(s.turnCount, 0)
  assert.equal(s.createdAt, '2026-01-01T00:00:01.000Z')
  assert.equal(s.lastActivityAt, s.createdAt)
  assert.equal(s.closedAt, undefined)
  assert.equal(s.modelId, 'm')
  assert.equal(s.mode, 'agent')
  assert.deepEqual(s.policy, { window: 'persistent' })
  assert.deepEqual(s.meta, { note: 'x' })
  assert.equal(reg.sessionDir('s1'), path.join(dataRoot, 'sessions', 's1'))
  assert.deepEqual(readMeta(reg.sessionDir('s1')), s)
  assert.deepEqual(readdirSync(reg.sessionDir('s1')), ['meta.json'], 'no *.tmp may remain')
  assert.equal(reg.get('s1'), s)
  assert.equal(reg.get('nope'), undefined)
})

test('list filters by product and by status, sorted by createdAt desc', async () => {
  const reg = await boot(ticking())
  await reg.create(spec('a', { product: 'p1' }))
  await reg.create(spec('b', { product: 'p2' }))
  await reg.create(spec('c', { product: 'p1' }))
  await reg.close('b')

  assert.deepEqual(reg.list().map((s) => s.id), ['c', 'b', 'a'])
  assert.deepEqual(reg.list({ product: 'p1' }).map((s) => s.id), ['c', 'a'])
  assert.deepEqual(reg.list({ status: 'CLOSED' }).map((s) => s.id), ['b'])
  assert.deepEqual(reg.list({ status: 'IDLE' }).map((s) => s.id), ['c', 'a'])
  assert.deepEqual(reg.list({ product: 'p2', status: 'IDLE' }).map((s) => s.id), [])
})

test('duplicate id → duplicate_session (also under concurrent create)', async () => {
  const reg = await boot()
  await reg.create(spec('dup'))
  await rejectsWith(reg.create(spec('dup')), 'duplicate_session')

  const results = await Promise.allSettled([reg.create(spec('same')), reg.create(spec('same'))])
  assert.deepEqual(results.map((r) => r.status), ['fulfilled', 'rejected'])
  const rejected = results[1] as PromiseRejectedResult
  assert.ok(rejected.reason instanceof RunFailure && rejected.reason.error.code === 'duplicate_session')
})

test('markBusy sets BUSY, lastTurnId and lastActivityAt; markBusy on BUSY → session_busy', async () => {
  const reg = await boot(ticking())
  await reg.create(spec('s'))
  const busy = await reg.markBusy('s', 'run-1')
  assert.equal(busy.status, 'BUSY')
  assert.equal(busy.lastTurnId, 'run-1')
  assert.equal(busy.lastActivityAt, '2026-01-01T00:00:02.000Z')
  assert.equal(busy.turnCount, 0)
  assert.deepEqual(readMeta(reg.sessionDir('s')), busy)

  await rejectsWith(reg.markBusy('s', 'run-2'), 'session_busy')
  assert.equal(reg.get('s')!.lastTurnId, 'run-1')
})

test('markBusy / markIdle on CLOSED → session_closed; on unknown id → not_found', async () => {
  const reg = await boot()
  await reg.create(spec('s'))
  await reg.close('s')
  await rejectsWith(reg.markBusy('s', 'run-1'), 'session_closed')
  await rejectsWith(reg.markIdle('s', {}), 'session_closed')
  assert.equal(reg.get('s')!.status, 'CLOSED')

  await rejectsWith(reg.markBusy('ghost', 'run-1'), 'not_found')
  await rejectsWith(reg.markIdle('ghost', {}), 'not_found')
  await rejectsWith(reg.close('ghost'), 'not_found')
})

test('markIdle increments turnCount, applies providerSessionRef/context/usage and persists', async () => {
  const reg = await boot(ticking())
  await reg.create(spec('s'))
  await reg.markBusy('s', 'run-1')
  const idle = await reg.markIdle('s', {
    providerSessionRef: 'thread-9',
    usage: { inputTokens: 10, outputTokens: 5 },
    context: { contextWindow: 1000, usedTokens: 15, precision: 'estimate', categories: { systemPrompt: 15, toolDefinitions: 0, rules: 0, skills: 0, mcp: 0, subagentDefinitions: 0, conversation: 0 } },
  })
  assert.equal(idle.status, 'IDLE')
  assert.equal(idle.turnCount, 1)
  assert.equal(idle.providerSessionRef, 'thread-9')
  assert.deepEqual(idle.usage, { inputTokens: 10, outputTokens: 5 })
  assert.equal(idle.context?.usedTokens, 15)
  assert.equal(idle.lastTurnId, 'run-1')
  assert.equal(idle.lastActivityAt, '2026-01-01T00:00:03.000Z')
  assert.deepEqual(readMeta(reg.sessionDir('s')), idle)

  // A second turn keeps the previous ref when the patch does not mention it.
  await reg.markBusy('s', 'run-2')
  const idle2 = await reg.markIdle('s', {})
  assert.equal(idle2.turnCount, 2)
  assert.equal(idle2.providerSessionRef, 'thread-9')
  assert.equal(idle2.lastTurnId, 'run-2')
})

test('patch updates context without incrementing turnCount and rejects a closed session', async () => {
  const reg = await boot(ticking())
  await reg.create(spec('s'))
  const patched = await reg.patch('s', {
    context: { contextWindow: null, usedTokens: 4, precision: 'estimate', categories: { systemPrompt: 0, toolDefinitions: 0, rules: 0, skills: 0, mcp: 0, subagentDefinitions: 0, conversation: 4 } },
  })
  assert.equal(patched.turnCount, 0)
  assert.equal(patched.status, 'IDLE')
  assert.equal(patched.context?.usedTokens, 4)
  assert.equal(patched.context?.precision, 'estimate')
  await reg.close('s')
  await rejectsWith(reg.patch('s', {}), 'session_closed')
})

test('close sets CLOSED + closedAt, persists, and is idempotent', async () => {
  const reg = await boot(ticking())
  await reg.create(spec('s'))
  const closed = await reg.close('s')
  assert.equal(closed.status, 'CLOSED')
  assert.equal(closed.closedAt, '2026-01-01T00:00:02.000Z')
  assert.deepEqual(readMeta(reg.sessionDir('s')), closed)

  const again = await reg.close('s')
  assert.deepEqual(again, closed, 'closing a CLOSED session returns it unchanged')
  assert.equal(again.closedAt, closed.closedAt)
})

test('reboot: BUSY sessions become IDLE and are listed in recovered; IDLE/CLOSED untouched', async () => {
  const reg = await boot()
  await reg.create(spec('busy'))
  await reg.markBusy('busy', 'run-1')
  await reg.create(spec('idle'))
  await reg.create(spec('closed'))
  await reg.close('closed')

  const reg2 = createSessionRegistry({ dataRoot })
  assert.deepEqual(await reg2.init(), { recovered: ['busy'], skipped: [] })
  const recovered = reg2.get('busy')!
  assert.equal(recovered.status, 'IDLE')
  assert.equal(recovered.lastTurnId, 'run-1', 'the interrupted turn stays referenced')
  assert.equal(recovered.turnCount, 0, 'an interrupted turn does not count')
  assert.equal(readMeta(reg2.sessionDir('busy')).status, 'IDLE', 'recovery is persisted')
  assert.deepEqual(reg2.get('idle'), reg.get('idle'))
  assert.deepEqual(reg2.get('closed'), reg.get('closed'))

  const reg3 = createSessionRegistry({ dataRoot })
  assert.deepEqual(await reg3.init(), { recovered: [], skipped: [] })
})

test('tampered meta.json (id ≠ dir name, or id escaping sessions/) is skipped and never becomes a path', async () => {
  const sandbox = mkdtempSync(path.join(os.tmpdir(), 'session-registry-sandbox-'))
  const nestedRoot = path.join(sandbox, 'data')
  try {
    const reg = createSessionRegistry({ dataRoot: nestedRoot })
    await reg.init()
    await reg.create(spec('good'))

    const tamperedDir = path.join(nestedRoot, 'sessions', 'tampered')
    mkdirSync(tamperedDir)
    writeFileSync(path.join(tamperedDir, 'meta.json'), JSON.stringify({ ...reg.get('good'), id: '../../evil', status: 'BUSY' }))
    const renamedDir = path.join(nestedRoot, 'sessions', 'renamed')
    mkdirSync(renamedDir)
    writeFileSync(path.join(renamedDir, 'meta.json'), readFileSync(path.join(reg.sessionDir('good'), 'meta.json')))

    const reg2 = createSessionRegistry({ dataRoot: nestedRoot })
    const result = await reg2.init()
    assert.deepEqual(result.recovered, [])
    assert.deepEqual(result.skipped.sort(), ['renamed', 'tampered'])
    assert.deepEqual(reg2.list().map((s) => s.id), ['good'])
    assert.equal(reg2.get('../../evil'), undefined)
    assert.deepEqual(readdirSync(sandbox), ['data'], 'nothing may be created outside dataRoot')
    assert.ok(!existsSync(path.join(sandbox, 'evil')))
  } finally {
    rmSync(sandbox, { recursive: true, force: true })
  }
})

test('corrupt or partial meta.json is skipped (reported) and the others still load', async () => {
  const reg = await boot()
  await reg.create(spec('ok'))
  await reg.create(spec('broken'))
  writeFileSync(path.join(reg.sessionDir('broken'), 'meta.json'), '{"id":"broken","status":"BU')
  mkdirSync(path.join(dataRoot, 'sessions', 'partial'))
  writeFileSync(path.join(dataRoot, 'sessions', 'partial', 'meta.json'), JSON.stringify({ id: 'partial' }))
  mkdirSync(path.join(dataRoot, 'sessions', 'empty-dir'))
  writeFileSync(path.join(dataRoot, 'sessions', 'stray.txt'), 'x')

  const reg2 = createSessionRegistry({ dataRoot })
  const result = await reg2.init()
  assert.deepEqual(result.recovered, [])
  assert.deepEqual(result.skipped.sort(), ['broken', 'empty-dir', 'partial'])
  assert.deepEqual(reg2.list().map((s) => s.id), ['ok'])
  assert.doesNotThrow(() => reg2.list({ product: 'p1', status: 'IDLE' }))
})

test('smuggled credential key is never persisted (create and markIdle)', async () => {
  const reg = await boot()
  const smuggled = { ...spec('s', { meta: { note: 'sk-live-abc' } }), credential: { secret: 'sk-live-abc' } }
  const s = await reg.create(smuggled as unknown as CreateSessionInput)
  assert.ok(!('credential' in s))
  await reg.markBusy('s', 'run-1')
  await reg.markIdle('s', { providerSessionRef: 'r', credential: { secret: 'another' } } as unknown as Parameters<typeof reg.markIdle>[1])

  const raw = readFileSync(path.join(reg.sessionDir('s'), 'meta.json'), 'utf8')
  assert.ok(!raw.includes('credential'), raw)
  assert.ok(!raw.includes('secret'), raw)
  // The registry does not redact content — meta is stored as-is.
  assert.equal(JSON.parse(raw).meta.note, 'sk-live-abc')
})

test('homeDir(id) = {dataRoot}/sessions/{id}/home', async () => {
  const reg = await boot()
  assert.equal(reg.homeDir('s1'), path.join(dataRoot, 'sessions', 's1', 'home'))
  assert.equal(reg.homeDir('s1'), path.join(reg.sessionDir('s1'), 'home'))
})

test('invalid id → validation (path traversal and bad chars rejected) and nothing is created', async () => {
  const reg = await boot()
  for (const bad of ['.', '..', '../escape', 'a/b', 'has space', '', 'x'.repeat(129), 'ünïcode', '.hidden', '-flag']) {
    await rejectsWith(reg.create(spec(bad)), 'validation')
  }
  await reg.create(spec('ok.id_1-A'))
  await reg.create(spec('x'.repeat(128)))
  assert.ok(!existsSync(path.join(dataRoot, 'escape')))
  assert.ok(!existsSync(path.join(dataRoot, 'sessions', 'meta.json')))
  assert.deepEqual(readdirSync(path.join(dataRoot, 'sessions')).sort(), ['ok.id_1-A', 'x'.repeat(128)])
})

test('concurrent transitions on one session compose and leave a consistent meta.json with no tmp files', async () => {
  const reg = await boot()
  await reg.create(spec('s'))
  for (let i = 0; i < 10; i++) {
    const results = await Promise.allSettled([reg.markBusy('s', `run-${i}`), reg.markBusy('s', `other-${i}`)])
    assert.deepEqual(results.map((r) => r.status), ['fulfilled', 'rejected'])
    await reg.markIdle('s', { providerSessionRef: `ref-${i}` })
    const s = reg.get('s')!
    assert.equal(s.status, 'IDLE')
    assert.equal(s.turnCount, i + 1)
    assert.equal(s.lastTurnId, `run-${i}`)
    assert.deepEqual(readMeta(reg.sessionDir('s')), s)
  }
  assert.deepEqual(readdirSync(reg.sessionDir('s')), ['meta.json'])
})
