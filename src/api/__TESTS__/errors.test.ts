import assert from 'node:assert/strict'
import type { ServerResponse } from 'node:http'
import { test } from 'node:test'
import { fail } from '../../core/errors.js'
import type { ErrorCode } from '../../core/types.js'
import { httpStatusFor, sendError } from '../errors.js'

function fakeRes() {
  const state = { status: 0, headers: {} as Record<string, unknown>, body: '', headersSent: false, ended: false }
  const res = {
    get headersSent() {
      return state.headersSent
    },
    writeHead(status: number, headers: Record<string, unknown>) {
      state.status = status
      state.headers = headers
      state.headersSent = true
      return res
    },
    end(chunk?: string) {
      if (chunk) state.body += chunk
      state.ended = true
    },
  }
  return { res: res as unknown as ServerResponse, state }
}

test('httpStatusFor maps every ErrorCode to the documented HTTP status', () => {
  const expected: Record<ErrorCode, number> = {
    unauthorized: 401,
    validation: 400,
    workspace_out_of_root: 400,
    credential_missing: 400,
    unsupported: 400,
    not_found: 404,
    duplicate_run: 409,
    duplicate_session: 409,
    session_busy: 409,
    session_closed: 409,
    litellm_unavailable: 503,
    credential_invalid: 500,
    cli_not_found: 500,
    model_not_found: 500,
    timeout: 500,
    interrupted: 500,
    cancelled: 500,
    internal: 500,
  }
  for (const [code, status] of Object.entries(expected)) assert.equal(httpStatusFor(code as ErrorCode), status, code)
})

test('sendError: RunFailure → mapped status and { error: { code, message } } JSON', () => {
  const { res, state } = fakeRes()
  sendError(res, fail('workspace_out_of_root', 'nope'))
  assert.equal(state.status, 400)
  assert.equal(state.headers['Content-Type'], 'application/json; charset=utf-8')
  assert.deepEqual(JSON.parse(state.body), { error: { code: 'workspace_out_of_root', message: 'nope' } })
  assert.ok(state.ended)
})

test('sendError: unknown errors → 500 internal with a generic message (no stack, no original message)', () => {
  const { res, state } = fakeRes()
  sendError(res, new Error('ENOENT /secret/path leaked'))
  assert.equal(state.status, 500)
  assert.deepEqual(JSON.parse(state.body), { error: { code: 'internal', message: 'internal error' } })
  assert.ok(!state.body.includes('leaked'))
  const other = fakeRes()
  sendError(other.res, 'a string')
  assert.equal(other.state.status, 500)
})

test('sendError after headers were sent (mid-SSE) only ends the response', () => {
  const { res, state } = fakeRes()
  res.writeHead(200, {})
  sendError(res, fail('validation', 'late'))
  assert.equal(state.status, 200)
  assert.equal(state.body, '')
  assert.ok(state.ended)
})
