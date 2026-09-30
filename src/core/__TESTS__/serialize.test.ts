import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createSerializer } from '../serialize.js'

const tick = () => new Promise((r) => setTimeout(r, 1))

test('tasks with the same key run strictly one after another, in call order', async () => {
  const run = createSerializer()
  const order: string[] = []
  await Promise.all([
    run('k', async () => {
      order.push('a:start')
      await tick()
      order.push('a:end')
    }),
    run('k', async () => {
      order.push('b:start')
      await tick()
      order.push('b:end')
    }),
  ])
  assert.deepEqual(order, ['a:start', 'a:end', 'b:start', 'b:end'])
})

test('a rejected task does not block later tasks on the same key; different keys interleave', async () => {
  const run = createSerializer()
  await assert.rejects(run('k', async () => { throw new Error('boom') }), /boom/)
  assert.equal(await run('k', async () => 'after'), 'after')

  const order: string[] = []
  await Promise.all([
    run('x', async () => {
      await tick()
      order.push('x')
    }),
    run('y', async () => {
      order.push('y')
    }),
  ])
  assert.deepEqual(order, ['y', 'x'])
})
