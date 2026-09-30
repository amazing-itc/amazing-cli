import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { EventType, Usage } from '../../../core/types.js'
import { defineSpawnParser } from '../index.js'

/** Soft-deny lines from stderr are warnings. AMAZING_CLI_ANTIGRAVITY_SKIP_PERMISSIONS=0|false omits the skip flag. */
const SOFT_DENY = /soft.?deny|denied|permission/i
const SETTINGS_JSON = '{"modelProvider":"gemini"}'

export function writeAntigravitySettings(homeDir: string): Promise<void> {
  const dir = path.join(homeDir, '.gemini', 'antigravity-cli')
  return mkdir(dir, { recursive: true }).then(() => writeFile(path.join(dir, 'settings.json'), SETTINGS_JSON, 'utf8'))
}

const isRecord = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v)

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined
}

function num(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined
}

function omitUndef<T extends Record<string, unknown>>(obj: T): T {
  const out = { ...obj }
  for (const key of Object.keys(out)) if (out[key] === undefined) delete out[key]
  return out
}

function parseUsage(raw: unknown): Usage | undefined {
  if (!isRecord(raw)) return undefined
  const inputTokens = num(raw.inputTokens) ?? num(raw.input_tokens)
  const outputTokens = num(raw.outputTokens) ?? num(raw.output_tokens)
  const costUsd = num(raw.costUsd) ?? num(raw.cost_usd)
  if (inputTokens === undefined && outputTokens === undefined && costUsd === undefined) return undefined
  return omitUndef({ inputTokens, outputTokens, costUsd })
}

function extractAssistantText(obj: Record<string, unknown>): string | undefined {
  if (typeof obj.text === 'string' && obj.text) return obj.text
  if (typeof obj.delta === 'string' && obj.delta) return obj.delta
  if (isRecord(obj.delta) && typeof obj.delta.text === 'string' && obj.delta.text) return obj.delta.text
  const message = obj.message
  if (!isRecord(message)) return undefined
  if (typeof message.content === 'string' && message.content) return message.content
  if (!Array.isArray(message.content)) return undefined
  const parts: string[] = []
  for (const part of message.content) {
    if (!isRecord(part)) continue
    if (part.type !== undefined && part.type !== 'text') continue
    if (typeof part.text === 'string' && part.text) parts.push(part.text)
  }
  return parts.length > 0 ? parts.join('') : undefined
}

function describeTool(obj: Record<string, unknown>): { name?: string; args?: unknown; id?: string; content?: unknown } {
  const nested = isRecord(obj.tool_call) ? obj.tool_call : obj
  const keys = Object.keys(nested).filter((k) => k !== 'id' && k !== 'name' && k !== 'args' && k !== 'arguments' && k !== 'content' && k !== 'result')
  const body = keys.length === 1 && isRecord(nested[keys[0]]) ? (nested[keys[0]] as Record<string, unknown>) : nested
  const name = str(obj.name) ?? str(nested.name) ?? keys[0]
  const id = str(obj.id) ?? str(nested.id) ?? str(body.id)
  const args = body.args ?? body.arguments ?? obj.args ?? obj.arguments
  const content = body.result ?? body.content ?? obj.result ?? obj.content
  return omitUndef({ name, args, id, content })
}

interface ParseState {
  sessionRef?: string
  usage?: Usage
}

function handleLine(line: string, emit: (type: EventType, data: unknown) => void, state: ParseState): void {
  const trimmed = line.trim()
  if (!trimmed) return
  if (!trimmed.startsWith('{')) {
    emit('log/line', { text: line })
    return
  }
  let obj: unknown
  try {
    obj = JSON.parse(trimmed)
  } catch {
    emit('log/line', { text: line })
    return
  }
  if (!isRecord(obj)) {
    emit('log/line', { text: line })
    return
  }
  const type = str(obj.type)
  const subtype = str(obj.subtype)
  if (type === 'system' && subtype === 'init') {
    const sessionRef = str(obj.session_id) ?? str(obj.sessionId) ?? (isRecord(obj.session) ? str(obj.session.id) : undefined)
    if (sessionRef) state.sessionRef = sessionRef
    emit('system/init', omitUndef({ sessionRef, model: str(obj.model) }))
    return
  }
  if (type === 'assistant') {
    const text = extractAssistantText(obj)
    if (text) emit('assistant/delta', { text })
    return
  }
  if (type === 'tool_result') {
    const info = describeTool(obj)
    emit('tool/result', omitUndef({ name: info.name, content: info.content ?? '', id: info.id }))
    return
  }
  if (type === 'tool_call' || type === 'tool_use') {
    const info = describeTool(obj)
    const completed = type === 'tool_call' && (subtype === 'completed' || subtype === 'result' || info.content !== undefined)
    if (completed) emit('tool/result', omitUndef({ name: info.name, content: info.content ?? '', id: info.id }))
    else emit('tool/call', omitUndef({ name: info.name, args: info.args, id: info.id }))
    return
  }
  if (type === 'result') {
    const usage = parseUsage(obj.usage)
    if (usage) state.usage = usage
    const sessionRef = str(obj.session_id) ?? str(obj.sessionId)
    if (sessionRef) state.sessionRef = sessionRef
    return
  }
  emit('log/line', { text: line })
}

defineSpawnParser('antigravity', {
  createState: (run): ParseState => ({ sessionRef: run.sessionRef }),
  onLine(line, emit, state) {
    handleLine(line, emit, state as ParseState)
  },
  sessionRef: (state) => (state as ParseState).sessionRef,
  usage: (state) => (state as ParseState).usage,
  beforeSpawn: (input) => writeAntigravitySettings(input.homeDir),
  onStderr(line, emit) {
    if (SOFT_DENY.test(line)) emit('log/line', { level: 'warn', text: line })
    else emit('log/line', { text: line })
  },
  exit: 'antigravity',
  notFoundMessage: 'agy not found',
  exitMessage: (spawned) => spawned.detail ?? `agy exited ${spawned.code}`,
  omitUndefined: true,
})

