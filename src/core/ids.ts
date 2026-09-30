import { fail } from './errors.js'

/** Safe as a single path segment under `{dataRoot}/runs/`: leading alphanumeric rejects `.`/`..`; no separators. */
export const RUN_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/

export function assertRunId(id: unknown): asserts id is string {
  if (typeof id !== 'string' || !RUN_ID_RE.test(id)) {
    throw fail('validation', `invalid runId: must match ${RUN_ID_RE.source}`)
  }
}

/** Session ids share the run-id rule: they are also a single path segment, under `{dataRoot}/sessions/`. */
export const SESSION_ID_RE = RUN_ID_RE

export function assertSessionId(id: unknown): asserts id is string {
  if (typeof id !== 'string' || !SESSION_ID_RE.test(id)) {
    throw fail('validation', `invalid sessionId: must match ${SESSION_ID_RE.source}`)
  }
}
