import assert from 'node:assert/strict'
import { test } from 'node:test'
import { RunFailure } from '../errors.js'
import { createQueue } from '../queue.js'
import type { RunRecord } from '../types.js'

function run(id: string, product = 'aw'): RunRecord {
  return { id, product, family: 'fake', status: 'QUEUED', workspaceDir: '/ws', prompt: 'hi', createdAt: new Date().toISOString(), lastSeq: 0 }
}

/** Lets the scheduling microtasks settle. */
const tick = () => new Promise<void>((r) => setImmediate(r))

test('6 runs with limit 2: exactly 2 start, 4 stay queued in FIFO order, positions are 1-based', async () => {
  const started: string[] = []
  const q = createQueue({ maxConcurrent: 2, maxConcurrentPerProduct: 2, onStart: (r) => void started.push(r.id) })
  const positions = ['r1', 'r2', 'r3', 'r4', 'r5', 'r6'].map((id) => q.enqueue(run(id)))
  assert.deepEqual(positions, [1, 2, 3, 4, 5, 6])
  assert.deepEqual(started, [], 'onStart must not run synchronously inside enqueue')

  await tick()
  assert.deepEqual(started, ['r1', 'r2'])
  assert.deepEqual(q.snapshot(), { running: ['r1', 'r2'], queued: ['r3', 'r4', 'r5', 'r6'] })
  assert.equal(q.position('r3'), 1)
  assert.equal(q.position('r6'), 4)
  assert.equal(q.position('r1'), undefined, 'running runs have no queue position')
  assert.equal(q.position('ghost'), undefined)
})

test('release frees the slot and starts the next queued run; release of unknown id is a no-op', async () => {
  const started: string[] = []
  const q = createQueue({ maxConcurrent: 1, onStart: (r) => void started.push(r.id) })
  q.enqueue(run('a'))
  q.enqueue(run('b'))
  q.enqueue(run('c'))
  await tick()
  assert.deepEqual(started, ['a'])

  q.release('a')
  await tick()
  assert.deepEqual(started, ['a', 'b'])
  assert.deepEqual(q.snapshot(), { running: ['b'], queued: ['c'] })

  q.release('nope')
  await tick()
  assert.deepEqual(q.snapshot(), { running: ['b'], queued: ['c'] })

  q.release('b')
  await tick()
  q.release('c')
  await tick()
  assert.deepEqual(started, ['a', 'b', 'c'])
  assert.deepEqual(q.snapshot(), { running: [], queued: [] })
})

test('per-product limit: a1 and b1 start, a2 waits even though global slots are free; a2 starts when a1 releases', async () => {
  const started: string[] = []
  const q = createQueue({ maxConcurrent: 4, maxConcurrentPerProduct: 1, onStart: (r) => void started.push(r.id) })
  q.enqueue(run('a1', 'a'))
  q.enqueue(run('a2', 'a'))
  q.enqueue(run('b1', 'b'))
  await tick()
  assert.deepEqual(started.sort(), ['a1', 'b1'])
  assert.deepEqual(q.snapshot().queued, ['a2'])
  assert.equal(q.position('a2'), 1)

  q.release('b1')
  await tick()
  assert.deepEqual(q.snapshot().queued, ['a2'], 'a2 is still blocked by its own product limit')

  q.release('a1')
  await tick()
  assert.ok(started.includes('a2'))
  assert.deepEqual(q.snapshot(), { running: ['a2'], queued: [] })
})

test('remove cancels a queued run, shifts positions and reports them; remove of running/unknown returns false', async () => {
  const changes: Array<[string, number]> = []
  const q = createQueue({ maxConcurrent: 1, onStart: () => {}, onPositionChange: (id, pos) => void changes.push([id, pos]) })
  q.enqueue(run('a'))
  q.enqueue(run('b'))
  q.enqueue(run('c'))
  q.enqueue(run('d'))
  await tick()
  assert.deepEqual(q.snapshot().queued, ['b', 'c', 'd'])
  changes.length = 0

  assert.equal(q.remove('c'), true)
  assert.deepEqual(q.snapshot().queued, ['b', 'd'])
  assert.equal(q.position('d'), 2)
  assert.equal(q.position('c'), undefined)
  assert.deepEqual(changes, [['b', 1], ['d', 2]])

  assert.equal(q.remove('a'), false, 'running run is not queued')
  assert.equal(q.remove('zzz'), false)
})

test('onPositionChange fires with updated positions when runs start', async () => {
  const changes: Array<[string, number]> = []
  const q = createQueue({ maxConcurrent: 1, onStart: () => {}, onPositionChange: (id, pos) => void changes.push([id, pos]) })
  q.enqueue(run('a'))
  q.enqueue(run('b'))
  q.enqueue(run('c'))
  await tick()
  assert.deepEqual(changes, [['b', 1], ['c', 2]])
  changes.length = 0
  q.release('a')
  await tick()
  assert.deepEqual(changes, [['c', 1]])
})

test('onStart rejection: no unhandledRejection, slot released so the next run starts, onStartError gets run + error', async () => {
  const unhandled: unknown[] = []
  const onUnhandled = (reason: unknown) => void unhandled.push(reason)
  process.on('unhandledRejection', onUnhandled)
  try {
    const started: string[] = []
    const errors: Array<[string, unknown]> = []
    const boom = new Error('boom')
    const q = createQueue({
      maxConcurrent: 1,
      onStart: async (r) => {
        started.push(r.id)
        if (r.id === 'bad') throw boom
      },
      onStartError: (r, err) => void errors.push([r.id, err]),
    })
    q.enqueue(run('bad'))
    q.enqueue(run('good'))
    await tick()
    await tick()
    assert.deepEqual(started, ['bad', 'good'])
    assert.deepEqual(errors, [['bad', boom]])
    assert.deepEqual(q.snapshot(), { running: ['good'], queued: [] })
    assert.deepEqual(unhandled, [])

    // Synchronous throw and no onStartError handler: still no unhandled rejection, slot still released.
    const q2 = createQueue({
      maxConcurrent: 1,
      onStart: (r) => {
        if (r.id === 'x') throw new Error('sync boom')
      },
    })
    q2.enqueue(run('x'))
    q2.enqueue(run('y'))
    await tick()
    await tick()
    assert.deepEqual(q2.snapshot(), { running: ['y'], queued: [] })
    assert.deepEqual(unhandled, [])
  } finally {
    process.off('unhandledRejection', onUnhandled)
  }
})

test('defaults are 4 global / 2 per product; invalid limits and duplicate ids are rejected', async () => {
  const started: string[] = []
  const q = createQueue({ onStart: (r) => void started.push(r.id) })
  for (let i = 0; i < 3; i++) q.enqueue(run(`a${i}`, 'a'))
  for (let i = 0; i < 3; i++) q.enqueue(run(`b${i}`, 'b'))
  await tick()
  assert.deepEqual(started.sort(), ['a0', 'a1', 'b0', 'b1'])
  assert.deepEqual(q.snapshot().queued, ['a2', 'b2'])
  assert.throws(() => q.enqueue(run('a0', 'a')), (e: unknown) => e instanceof RunFailure && e.error.code === 'duplicate_run')
  assert.throws(() => q.enqueue(run('a2', 'a')), (e: unknown) => e instanceof RunFailure && e.error.code === 'duplicate_run')

  const isValidation = (e: unknown) => e instanceof RunFailure && e.error.code === 'validation'
  assert.throws(() => createQueue({ maxConcurrent: 0, onStart: () => {} }), isValidation)
  assert.throws(() => createQueue({ maxConcurrentPerProduct: 1.5, onStart: () => {} }), isValidation)
  assert.throws(() => createQueue({ maxConcurrent: -1, onStart: () => {} }), isValidation)
})
