import type { ServerResponse } from 'node:http'
import { RunFailure } from '../core/errors.js'
import type { ErrorCode } from '../core/types.js'
import { sendJson } from './http.js'

const STATUS: Partial<Record<ErrorCode, number>> = {
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
}

export function httpStatusFor(code: ErrorCode): number {
  return STATUS[code] ?? 500
}

/** `{ error: { code, message } }`; anything that is not a `RunFailure` becomes an opaque 500 (no stack, no message leak). */
export function sendError(res: ServerResponse, err: unknown): void {
  if (err instanceof RunFailure) {
    sendJson(res, httpStatusFor(err.error.code), { error: err.error })
    return
  }
  sendJson(res, 500, { error: { code: 'internal', message: 'internal error' } })
}
