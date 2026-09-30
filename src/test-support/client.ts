// Minimal HTTP + SSE client helpers for contract tests (real sockets via global fetch).
import { authHeaders, type TestApp, type TestProduct } from './app.js'

export interface JsonResponse {
  status: number
  body: unknown
  headers: Headers
}

export async function call(app: TestApp, product: TestProduct | null, method: string, path: string, body?: unknown, extraHeaders: Record<string, string> = {}): Promise<JsonResponse> {
  const headers: Record<string, string> = { ...(product ? authHeaders(product) : {}), ...extraHeaders }
  let payload: string | undefined
  if (body !== undefined) {
    payload = typeof body === 'string' ? body : JSON.stringify(body)
    headers['Content-Type'] = 'application/json'
  }
  const res = await fetch(`${app.baseUrl}${path}`, { method, headers, body: payload })
  const text = await res.text()
  const ndjson = (res.headers.get('content-type') ?? '').includes('application/x-ndjson')
  return { status: res.status, body: text === '' ? undefined : ndjson ? text : JSON.parse(text), headers: res.headers }
}

export interface SseMessage {
  id?: string
  event?: string
  data: string
}

export interface SseResult {
  status: number
  contentType: string | null
  messages: SseMessage[]
  comments: string[]
}

/** Parses one SSE block (lines without the trailing blank line). */
function parseBlock(block: string, out: SseResult): void {
  const msg: SseMessage = { data: '' }
  let hasField = false
  for (const line of block.split('\n')) {
    if (line.startsWith(':')) {
      out.comments.push(line.slice(1).trim())
      continue
    }
    const colon = line.indexOf(':')
    if (colon < 0) continue
    const field = line.slice(0, colon)
    const value = line.slice(colon + 1).replace(/^ /, '')
    hasField = true
    if (field === 'id') msg.id = value
    else if (field === 'event') msg.event = value
    else if (field === 'data') msg.data += (msg.data ? '\n' : '') + value
  }
  if (hasField) out.messages.push(msg)
}

/** Reads `GET /v1/runs/{id}/events` until the server ends the stream (or `signal` aborts). */
export async function collectSse(app: TestApp, product: TestProduct, runId: string, opts: { lastEventId?: string; signal?: AbortSignal } = {}): Promise<SseResult> {
  const headers = authHeaders(product, { Accept: 'text/event-stream', ...(opts.lastEventId !== undefined && { 'Last-Event-ID': opts.lastEventId }) })
  const res = await fetch(`${app.baseUrl}/v1/runs/${runId}/events`, { headers, signal: opts.signal })
  const out: SseResult = { status: res.status, contentType: res.headers.get('content-type'), messages: [], comments: [] }
  if (!res.body) return out
  const decoder = new TextDecoder()
  let buffer = ''
  try {
    for await (const chunk of res.body) {
      buffer += decoder.decode(chunk, { stream: true })
      let sep: number
      while ((sep = buffer.indexOf('\n\n')) >= 0) {
        parseBlock(buffer.slice(0, sep), out)
        buffer = buffer.slice(sep + 2)
      }
    }
  } catch (err) {
    if (!opts.signal?.aborted) throw err
  }
  if (buffer.trim() !== '') parseBlock(buffer, out)
  return out
}

/** Polls `pred` every 10 ms until truthy or `timeoutMs` elapses (then throws with `label`). */
export async function waitFor<T>(pred: () => T | undefined | false | Promise<T | undefined | false>, label: string, timeoutMs = 5000): Promise<T> {
  const t0 = Date.now()
  for (;;) {
    const value = await pred()
    if (value) return value
    if (Date.now() - t0 > timeoutMs) throw new Error(`timed out after ${timeoutMs}ms waiting for ${label}`)
    await new Promise((r) => setTimeout(r, 10))
  }
}

export function runRequest(product: TestProduct, runId: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { runId, family: 'fake', prompt: 'hello', workspace: { product, path: '.' }, ...overrides }
}
