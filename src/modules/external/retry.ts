export const INITIAL_DELAY_MS = 500
export const MAX_RETRIES = 3

export type RetryInfo = {
  attempt: number
  delayMs: number
  status?: number
}

export type RetryOptions = {
  maxRetries?: number
  signal?: AbortSignal
  onRetry?: (info: RetryInfo) => void
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>
}

export function backoffMs(attempt: number): number {
  return INITIAL_DELAY_MS * 2 ** (attempt - 1)
}

export function isAbortError(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false
  const name = (err as { name?: string }).name
  return name === 'AbortError' || name === 'TimeoutError'
}

export function isRefused(err: unknown): boolean {
  const code = causeCode(err)
  if (code === 'ECONNREFUSED') return true
  const message = err instanceof Error ? err.message : String(err)
  return message.includes('ECONNREFUSED')
}

export function isRetryableStatus(status: number): boolean {
  return status === 429 || status >= 500
}

export function isAuthStatus(status: number): boolean {
  return status === 401 || status === 403
}

export function isNetworkError(err: unknown): boolean {
  if (isAbortError(err)) return false
  if (err instanceof TypeError) return true
  const code = causeCode(err)
  return code === 'ECONNREFUSED' || code === 'ECONNRESET' || code === 'ETIMEDOUT' || code === 'ENOTFOUND'
}

function causeCode(err: unknown): string | undefined {
  if (typeof err !== 'object' || err === null) return undefined
  const cause = (err as { cause?: unknown }).cause
  if (typeof cause === 'object' && cause !== null && 'code' in cause) {
    const code = (cause as { code?: unknown }).code
    return typeof code === 'string' ? code : undefined
  }
  if ('code' in err && typeof (err as { code?: unknown }).code === 'string') {
    return (err as { code: string }).code
  }
  return undefined
}

export async function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return
  if (signal?.aborted) {
    const err = new Error('aborted')
    err.name = 'AbortError'
    throw err
  }
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(done, ms)
    const onAbort = () => {
      clearTimeout(timer)
      const err = new Error('aborted')
      err.name = 'AbortError'
      reject(err)
    }
    signal?.addEventListener('abort', onAbort, { once: true })
    function done() {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }
  })
}

export async function withRetry<T>(fn: () => Promise<T>, options: RetryOptions = {}): Promise<T> {
  const maxRetries = options.maxRetries ?? MAX_RETRIES
  const sleep = options.sleep ?? defaultSleep
  for (let attempt = 0; ; attempt += 1) {
    if (options.signal?.aborted) {
      const err = new Error('aborted')
      err.name = 'AbortError'
      throw err
    }
    try {
      return await fn()
    } catch (err) {
      if (isAbortError(err) || options.signal?.aborted) throw err
      const status = (err as { status?: number }).status
      if (typeof status === 'number' && isAuthStatus(status)) throw err
      const retryable =
        (typeof status === 'number' && isRetryableStatus(status)) ||
        (status === undefined && isNetworkError(err))
      if (!retryable || attempt >= maxRetries) throw err
      const next = attempt + 1
      const delayMs = backoffMs(next)
      const info: RetryInfo = { attempt: next, delayMs }
      if (typeof status === 'number') info.status = status
      options.onRetry?.(info)
      await sleep(delayMs, options.signal)
    }
  }
}
