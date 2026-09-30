import assert from 'node:assert/strict'
import { test } from 'node:test'
import { backoffMs, isAuthStatus, isRetryableStatus, withRetry } from '../retry.js'

test('backoff is 500ms * 2^(attempt-1)', () => {
  assert.equal(backoffMs(1), 500)
  assert.equal(backoffMs(2), 1000)
  assert.equal(backoffMs(3), 2000)
})

test('401/403 are not retryable; 429/5xx are', () => {
  assert.equal(isAuthStatus(401), true)
  assert.equal(isAuthStatus(403), true)
  assert.equal(isRetryableStatus(429), true)
  assert.equal(isRetryableStatus(503), true)
  assert.equal(isRetryableStatus(400), false)
})

test('withRetry emits onRetry then succeeds; 401 never retries', async () => {
  const retries: Array<{ attempt: number; delayMs: number; status?: number }> = []
  let n = 0
  const ok = await withRetry(
    async () => {
      n += 1
      if (n === 1) {
        const err = Object.assign(new Error('busy'), { status: 429 })
        throw err
      }
      return 'yes'
    },
    { sleep: async () => undefined, onRetry: (info) => retries.push(info) },
  )
  assert.equal(ok, 'yes')
  assert.deepEqual(retries, [{ attempt: 1, delayMs: 500, status: 429 }])

  let authCalls = 0
  let authRetried = false
  await assert.rejects(
    () =>
      withRetry(
        async () => {
          authCalls += 1
          throw Object.assign(new Error('nope'), { status: 401 })
        },
        { sleep: async () => undefined, onRetry: () => { authRetried = true } },
      ),
    (err: unknown) => (err as { status?: number }).status === 401,
  )
  assert.equal(authCalls, 1)
  assert.equal(authRetried, false)
})
