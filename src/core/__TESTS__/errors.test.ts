import assert from 'node:assert/strict'
import { test } from 'node:test'
import { RunFailure, fail } from '../errors.js'

test('fail() returns a RunFailure carrying the typed RunError', () => {
  const err = fail('validation', 'bad input')
  assert.ok(err instanceof RunFailure)
  assert.deepEqual(err.error, { code: 'validation', message: 'bad input' })
})

test('RunFailure is an Error named RunFailure with the message mirrored', () => {
  const err = new RunFailure({ code: 'not_found', message: 'missing' })
  assert.ok(err instanceof Error)
  assert.equal(err.name, 'RunFailure')
  assert.equal(err.message, 'missing')
})
