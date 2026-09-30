import assert from 'node:assert/strict'
import type { IncomingMessage } from 'node:http'
import { test } from 'node:test'
import { RunFailure } from '../../core/errors.js'
import { createAuthenticator, parseApiKey, secretsEqual } from '../auth.js'

const KEY = 'aw-test-key-0123456789abcdef'
const req = (headers: Record<string, string | string[]>) => ({ headers } as unknown as IncomingMessage)
const isUnauthorized = (e: unknown) => e instanceof RunFailure && e.error.code === 'unauthorized'
const isValidation = (e: unknown) => e instanceof RunFailure && e.error.code === 'validation'

test('parseApiKey: trims; missing, blank and short keys fail boot', () => {
  assert.equal(parseApiKey(`  ${KEY}  `), KEY)
  assert.throws(() => parseApiKey(undefined), isValidation)
  assert.throws(() => parseApiKey('   '), isValidation)
  assert.throws(() => parseApiKey('short'), isValidation)
})

test('secretsEqual: equal → true; same length different → false; different length → false without throwing', () => {
  assert.equal(secretsEqual(KEY, KEY), true)
  assert.equal(secretsEqual(KEY, KEY.slice(0, -1) + 'X'), false)
  assert.equal(secretsEqual(KEY, KEY + 'x'), false)
  assert.equal(secretsEqual('', ''), true)
  assert.equal(secretsEqual('', 'a'), false)
})

test('authenticate: valid bearer + any product header → that id; scheme is case-insensitive', () => {
  const auth = createAuthenticator(KEY)
  assert.deepEqual(auth.authenticate(req({ authorization: `Bearer ${KEY}`, 'x-amazing-product': 'aw' })), { product: 'aw' })
  assert.deepEqual(auth.authenticate(req({ authorization: `bearer   ${KEY}`, 'x-amazing-product': 'vector' })), { product: 'vector' })
  assert.deepEqual(auth.authenticate(req({ authorization: `Bearer ${KEY}`, 'x-amazing-product': '  other  ' })), { product: 'other' })
})

test('authenticate: missing header, blank product, wrong key, non-bearer scheme → unauthorized', () => {
  const auth = createAuthenticator(KEY)
  assert.throws(() => auth.authenticate(req({})), isUnauthorized)
  assert.throws(() => auth.authenticate(req({ authorization: `Bearer ${KEY}` })), isUnauthorized, 'product header required')
  assert.throws(() => auth.authenticate(req({ authorization: `Bearer ${KEY}`, 'x-amazing-product': '   ' })), isUnauthorized)
  assert.throws(() => auth.authenticate(req({ 'x-amazing-product': 'aw' })), isUnauthorized, 'bearer required')
  assert.throws(() => auth.authenticate(req({ authorization: `Bearer ${KEY}x`, 'x-amazing-product': 'aw' })), isUnauthorized)
  assert.throws(() => auth.authenticate(req({ authorization: `Basic ${KEY}`, 'x-amazing-product': 'aw' })), isUnauthorized)
})

test('authenticate: a repeated product header is read as its first value only', () => {
  const auth = createAuthenticator(KEY)
  assert.deepEqual(auth.authenticate(req({ authorization: `Bearer ${KEY}`, 'x-amazing-product': ['aw', 'vector'] })), { product: 'aw' })
  assert.deepEqual(auth.authenticate(req({ authorization: `Bearer ${KEY}`, 'x-amazing-product': ['vector', 'aw'] })), { product: 'vector' })
})
