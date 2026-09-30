import assert from 'node:assert/strict'
import { existsSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { createHomeManager } from '../home.js'
import { createSessionRegistry } from '../session-registry.js'
import { createSessionSweeper } from '../session-sweeper.js'

const tmp = (prefix: string) => mkdtempSync(path.join(tmpdir(), prefix))

const base = { product: 'p1', family: 'fake' as const, workspaceDir: '/ws', policy: { window: 'persistent' as const } }

async function setup() {
  const dataRoot = tmp('sweep-')
  let t = Date.parse('2026-09-23T18:00:00.000Z')
  const clock = () => new Date(t)
  const sessions = createSessionRegistry({ dataRoot, clock })
  const homes = createHomeManager({ dataRoot })
  await sessions.init()
  const sweeper = createSessionSweeper({ sessions, homes, idleTtlSec: 60, sweepSec: 30, clock })
  return {
    sessions,
    homes,
    sweeper,
    advance: (ms: number) => {
      t += ms
    },
  }
}

test('an IDLE persistent session idle past the TTL is CLOSED, its home/ removed, and meta.json plus session.jsonl kept', async () => {
  const { sessions, homes, sweeper, advance } = await setup()
  await sessions.create({ ...base, id: 'old' })
  await homes.create('old')
  await sessions.create({ ...base, id: 'fresh' })
  await homes.create('fresh')
  advance(61_000)

  // `fresh` had activity inside the window; only `old` expires.
  await sessions.markBusy('fresh', 'r1')
  await sessions.markIdle('fresh', {})
  const closed = await sweeper.sweep()

  assert.deepEqual(closed, ['old'])
  assert.equal(sessions.get('old')!.status, 'CLOSED')
  assert.ok(sessions.get('old')!.closedAt)
  assert.ok(!existsSync(homes.path('old')), 'home/ removed')
  assert.ok(existsSync(sessions.sessionDir('old') + '/meta.json'), 'meta.json kept')
  assert.equal(sessions.get('fresh')!.status, 'IDLE', 'activity inside the TTL keeps the session')
  assert.ok(existsSync(homes.path('fresh')))
})

test('a BUSY session past the TTL is skipped, and closed on the next pass once it is IDLE again', async () => {
  const { sessions, homes, sweeper, advance } = await setup()
  await sessions.create({ ...base, id: 'busy' })
  await homes.create('busy')
  await sessions.markBusy('busy', 'r1')
  advance(120_000)

  assert.deepEqual(await sweeper.sweep(), [], 'a live turn is never cut by the TTL')
  assert.equal(sessions.get('busy')!.status, 'BUSY')
  assert.ok(existsSync(homes.path('busy')))

  await sessions.markIdle('busy', {})
  // `markIdle` stamps `lastActivityAt` at the current clock, so the session only expires once it goes idle again.
  advance(61_000)
  assert.deepEqual(await sweeper.sweep(), ['busy'])
  assert.equal(sessions.get('busy')!.status, 'CLOSED')
  assert.ok(!existsSync(homes.path('busy')))
})

test('ephemeral sessions and already CLOSED sessions are never swept', async () => {
  const { sessions, homes, sweeper, advance } = await setup()
  await sessions.create({ ...base, id: 'eph', policy: { window: 'ephemeral' } })
  await homes.create('eph')
  await sessions.create({ ...base, id: 'done' })
  await sessions.close('done')
  advance(120_000)

  assert.deepEqual(await sweeper.sweep(), [])
  assert.equal(sessions.get('eph')!.status, 'IDLE', 'ephemeral sessions close with their run, not by the sweeper')
  assert.ok(existsSync(homes.path('eph')))
  assert.equal(sessions.get('done')!.status, 'CLOSED')
})

test('start/stop: the interval fires sweep and stop ends it', async () => {
  const dataRoot = tmp('sweep-')
  const sessions = createSessionRegistry({ dataRoot })
  await sessions.init()
  await sessions.create({ ...base, id: 's' })
  let now = 0
  let runs = 0
  const sweeper = createSessionSweeper({
    sessions,
    homes: createHomeManager({ dataRoot }),
    idleTtlSec: 3600,
    sweepSec: 10,
    clock: () => new Date(now),
    schedule: (fn, ms) => {
      assert.equal(ms, 10_000)
      const t = setInterval(() => {
        runs += 1
        now += ms
        void fn()
      }, 15)
      return t
    },
  })
  sweeper.start()
  sweeper.start()
  await new Promise((r) => setTimeout(r, 60))
  sweeper.stop()
  const after = runs
  await new Promise((r) => setTimeout(r, 40))
  assert.ok(after >= 2, `expected several sweeps, got ${after}`)
  assert.equal(runs, after, 'stop ends the interval')
  assert.equal(sessions.get('s')!.status, 'IDLE', 'nothing expired')
})
