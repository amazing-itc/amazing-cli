import type { ErrorCode, RunError } from './types.js'

/** Typed failure carrying a `RunError`; callers match on `err.error.code`. */
export class RunFailure extends Error {
  constructor(public readonly error: RunError) {
    super(error.message)
    this.name = 'RunFailure'
  }
}

export function fail(code: ErrorCode, message: string): RunFailure {
  return new RunFailure({ code, message })
}
