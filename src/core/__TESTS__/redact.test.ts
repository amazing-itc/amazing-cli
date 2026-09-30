import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createRedactor, redactString } from '../redact.js'

test('redacts registered secrets inside nested objects and arrays', () => {
  const r = createRedactor()
  r.add('sk-live-123')
  r.add('hunter2')
  const out = r.redact({
    text: 'token sk-live-123 used',
    list: ['hunter2', { deep: 'sk-live-123/hunter2' }, 42, null],
    n: 7,
    ok: true,
  })
  assert.deepEqual(out, {
    text: 'token *** used',
    list: ['***', { deep: '***/***' }, 42, null],
    n: 7,
    ok: true,
  })
})

test('no secrets registered → returns the same reference (identity)', () => {
  const r = createRedactor()
  const value = { a: ['x', { b: 'y' }] }
  assert.equal(r.redact(value), value)
  assert.equal(r.redact('plain'), 'plain')
})

test('secrets shorter than 4 chars are ignored', () => {
  const r = createRedactor()
  r.add('abc')
  assert.equal(r.redact('abcabc abc'), 'abcabc abc')
  assert.equal(redactString('abc', ['abc']), 'abc')
  assert.equal(redactString('abcd', ['abcd']), '***')
})

test('remove stops redaction of that secret only', () => {
  const r = createRedactor()
  r.add('first-secret')
  r.add('second-secret')
  r.remove('first-secret')
  assert.equal(r.redact('first-secret second-secret'), 'first-secret ***')
})

test('primitives and non-string leaves pass through unchanged', () => {
  const r = createRedactor()
  r.add('secret')
  assert.equal(r.redact(5), 5)
  assert.equal(r.redact(undefined), undefined)
  assert.deepEqual(r.redact([1, false, 'secret']), [1, false, '***'])
})
