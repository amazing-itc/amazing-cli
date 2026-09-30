import { timingSafeEqual } from 'node:crypto'
import type { IncomingMessage } from 'node:http'
import { fail } from '../core/errors.js'

export const MIN_KEY_LENGTH = 16
export const PRODUCT_HEADER = 'x-amazing-product'

/** One service secret. The caller chooses `X-Amazing-Product`; this process does not list products. */
export function parseApiKey(env: string | undefined): string {
  const key = env?.trim() ?? ''
  if (key === '') throw fail('validation', 'AMAZING_CLI_API_KEY is required')
  if (key.length < MIN_KEY_LENGTH) throw fail('validation', `AMAZING_CLI_API_KEY must have at least ${MIN_KEY_LENGTH} characters`)
  return key
}

export interface Authenticator {
  /** Requires `Authorization: Bearer <AMAZING_CLI_API_KEY>` and a non-empty `X-Amazing-Product`. */
  authenticate(req: IncomingMessage): { product: string }
}

function header(req: IncomingMessage, name: string): string | undefined {
  const value = req.headers[name]
  return Array.isArray(value) ? value[0] : value
}

export function secretsEqual(given: string, expected: string): boolean {
  const a = Buffer.from(given, 'utf8')
  const b = Buffer.from(expected, 'utf8')
  return a.length === b.length && timingSafeEqual(a, b)
}

export function createAuthenticator(apiKey: string): Authenticator {
  return {
    authenticate(req) {
      const unauthorized = () => fail('unauthorized', 'missing or invalid credentials')
      const auth = header(req, 'authorization')
      const product = header(req, PRODUCT_HEADER)?.trim() ?? ''
      const match = auth === undefined ? null : /^Bearer\s+(\S+)$/i.exec(auth.trim())
      if (!match || product === '' || !secretsEqual(match[1], apiKey)) throw unauthorized()
      return { product }
    },
  }
}
