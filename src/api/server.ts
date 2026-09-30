import http from 'node:http'
import { fail } from '../core/errors.js'
import type { Authenticator } from './auth.js'
import { sendError } from './errors.js'
import { matchRoute, type RouteDeps } from './routes.js'

export interface AppDeps extends Omit<RouteDeps, 'version'> {
  auth: Authenticator
  version?: string
  /** One JSON line per request; default stdout. Never receives headers or bodies. */
  log?: (line: string) => void
}

const isHealth = (method: string | undefined, pathname: string) => method === 'GET' && pathname === '/health'

/** `/v1` carrier over `node:http`: auth (except `/health`) → route → `{ error: { code, message } }` on failure. */
export function createApp(deps: AppDeps): http.Server {
  const log = deps.log ?? ((line: string) => console.log(line))
  const routeDeps: RouteDeps = { ...deps, version: deps.version ?? '0.0.0' }

  return http.createServer(async (req, res) => {
    const startedAt = Date.now()
    const url = new URL(req.url ?? '/', 'http://localhost')
    let product: string | undefined
    res.once('close', () => {
      log(JSON.stringify({ at: new Date(startedAt).toISOString(), method: req.method, path: url.pathname, status: res.statusCode, ms: Date.now() - startedAt, ...(product && { product }) }))
    })
    try {
      if (!isHealth(req.method, url.pathname)) product = deps.auth.authenticate(req).product
      const match = matchRoute(req.method, url.pathname)
      if (!match) throw fail('not_found', `no route for ${req.method} ${url.pathname}`)
      await match.handler({ req, res, url, params: match.params, product, deps: routeDeps })
    } catch (err) {
      sendError(res, err)
    }
  })
}
