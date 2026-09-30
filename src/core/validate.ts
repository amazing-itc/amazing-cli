import { fail } from './errors.js'
import { assertRunId, assertSessionId } from './ids.js'
import type { Provider } from './provider.js'
import type { AttachmentKind, Family, RunMode, RunRequest } from './types.js'

const isRecord = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v)
const isStringMap = (v: unknown): v is Record<string, string> => isRecord(v) && Object.values(v).every((x) => typeof x === 'string')

const RUN_MODES: ReadonlySet<string> = new Set<RunMode>(['ask', 'plan', 'agent'])
const ATTACHMENT_KINDS: ReadonlySet<string> = new Set<AttachmentKind>(['image', 'file', 'folder'])

function optionalString(body: Record<string, unknown>, key: string): void {
  if (body[key] !== undefined && typeof body[key] !== 'string') throw fail('validation', `${key} must be a string`)
}

function validateMcpServers(value: unknown): void {
  if (value === undefined) return
  if (!Array.isArray(value)) throw fail('validation', 'mcpServers must be an array')
  for (const [i, server] of value.entries()) {
    if (!isRecord(server) || typeof server.name !== 'string' || server.name === '' || typeof server.url !== 'string' || server.url === '') {
      throw fail('validation', `mcpServers[${i}] must be { name, url, headers? }`)
    }
    if (server.headers !== undefined && !isStringMap(server.headers)) throw fail('validation', `mcpServers[${i}].headers must map strings to strings`)
  }
}

function validateMode(value: unknown): void {
  if (value === undefined) return
  if (typeof value !== 'string' || !RUN_MODES.has(value)) throw fail('validation', 'mode must be ask, plan, or agent')
}

function validateAttachments(value: unknown): void {
  if (value === undefined) return
  if (!Array.isArray(value)) throw fail('validation', 'attachments must be an array')
  for (const [i, item] of value.entries()) {
    if (
      !isRecord(item) ||
      typeof item.kind !== 'string' ||
      !ATTACHMENT_KINDS.has(item.kind) ||
      typeof item.path !== 'string' ||
      typeof item.name !== 'string'
    ) {
      throw fail('validation', `attachments[${i}] must be { kind: image|file|folder, path, name }`)
    }
  }
}

/** Shape + semantic checks for `POST /v1/runs`; `product` is the authenticated caller, not the body. */
export function validateRunRequest(body: unknown, providers: ReadonlyMap<Family, Provider>, product: string): asserts body is RunRequest {
  if (!isRecord(body)) throw fail('validation', 'body must be a JSON object')
  assertRunId(body.runId)
  if (typeof body.family !== 'string' || !providers.has(body.family as Family)) {
    throw fail('unsupported', `family "${String(body.family)}" is not available; supported: ${[...providers.keys()].join(', ') || 'none'}`)
  }
  validateAttachments(body.attachments)
  const hasAttachments = Array.isArray(body.attachments) && body.attachments.length > 0
  if (typeof body.prompt !== 'string') throw fail('validation', 'prompt must be a string')
  if (body.prompt.trim() === '' && !hasAttachments) throw fail('validation', 'prompt must be a non-empty string')
  if (!isRecord(body.workspace) || typeof body.workspace.path !== 'string') throw fail('validation', 'workspace must be { product, path }')
  if (body.workspace.product !== product) throw fail('validation', `workspace.product must equal the authenticated product "${product}"`)
  if (body.credential !== undefined && (!isRecord(body.credential) || typeof body.credential.secret !== 'string')) {
    throw fail('validation', 'credential must be { secret }')
  }
  optionalString(body, 'modelId')
  optionalString(body, 'sessionRef')
  if (body.sessionId !== undefined) assertSessionId(body.sessionId)
  validateMode(body.mode)
  if (body.inheritProjectMcp !== undefined && typeof body.inheritProjectMcp !== 'boolean') {
    throw fail('validation', 'inheritProjectMcp must be a boolean')
  }
  validateMcpServers(body.mcpServers)
  if (body.timeoutSec !== undefined && !(Number.isInteger(body.timeoutSec) && (body.timeoutSec as number) >= 1)) {
    throw fail('validation', 'timeoutSec must be an integer >= 1')
  }
  if (body.meta !== undefined && !isStringMap(body.meta)) throw fail('validation', 'meta must map strings to strings')
}
