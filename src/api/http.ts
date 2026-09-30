import type { IncomingMessage, ServerResponse } from 'node:http'
import { fail } from '../core/errors.js'

export const MAX_BODY_BYTES = 1024 * 1024

export function sendJson(res: ServerResponse, status: number, body: unknown): void {
  if (res.headersSent) {
    res.end()
    return
  }
  const payload = JSON.stringify(body)
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(payload) })
  res.end(payload)
}

/** Reads and parses a JSON body; empty body → `{}`; > `limit` bytes or malformed JSON → `validation`. */
export async function readJsonBody(req: IncomingMessage, limit = MAX_BODY_BYTES): Promise<unknown> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    const buf = chunk as Buffer
    size += buf.length
    if (size > limit) throw fail('validation', `body exceeds ${limit} bytes`)
    chunks.push(buf)
  }
  const text = Buffer.concat(chunks).toString('utf8')
  if (text.trim() === '') return {}
  try {
    return JSON.parse(text)
  } catch {
    throw fail('validation', 'body is not valid JSON')
  }
}
