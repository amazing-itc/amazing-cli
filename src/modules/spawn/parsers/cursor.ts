import type { EventType, Usage } from '../../../core/types.js'

export interface CursorStreamState {
  fullText: string
  sessionRef?: string
  usage?: Usage
}

export interface CursorEmit {
  type: EventType
  data: unknown
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

function toNum(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function toUsage(raw: unknown): Usage | undefined {
  const rec = asRecord(raw)
  if (!rec) return undefined
  const usage: Usage = {}
  const inputTokens = toNum(rec.inputTokens ?? rec.input_tokens)
  const outputTokens = toNum(rec.outputTokens ?? rec.output_tokens)
  const costUsd = toNum(rec.costUsd ?? rec.cost_usd)
  if (inputTokens !== undefined) usage.inputTokens = inputTokens
  if (outputTokens !== undefined) usage.outputTokens = outputTokens
  if (costUsd !== undefined) usage.costUsd = costUsd
  return Object.keys(usage).length > 0 ? usage : undefined
}

function assistantText(obj: Record<string, unknown>): string | undefined {
  const message = asRecord(obj.message)
  const content = message?.content
  if (Array.isArray(content)) {
    const parts = content
      .map((part) => {
        const rec = asRecord(part)
        return rec ? str(rec.text) : undefined
      })
      .filter((part): part is string => part !== undefined)
    if (parts.length > 0) return parts.join('')
  }
  if (typeof content === 'string' && content.length > 0) return content
  return str(obj.delta) ?? str(obj.text)
}

function assistantDelta(text: string, state: CursorStreamState): string | undefined {
  if (text.startsWith(state.fullText)) {
    const delta = text.slice(state.fullText.length)
    state.fullText = text
    return delta || undefined
  }
  state.fullText = text
  return text
}

function toolFields(obj: Record<string, unknown>): { name?: string; args?: unknown; id?: string; content?: unknown } {
  const nested = asRecord(obj.tool_call) ?? asRecord(obj.tool_use)
  let name = str(obj.name)
  let args: unknown = obj.args ?? obj.arguments
  let id = str(obj.id) ?? str(obj.tool_call_id) ?? str(obj.tool_use_id)
  let content: unknown = obj.content ?? obj.result
  if (nested) {
    const key = Object.keys(nested)[0]
    const body = (key ? asRecord(nested[key]) : undefined) ?? nested
    if (!name) name = key ?? str(nested.name)
    args = args ?? body?.args ?? body?.arguments ?? nested.args
    id = id ?? str(body?.id) ?? str(nested.id)
    content = content ?? body?.result ?? body?.content ?? nested.result
  }
  return { name, args, id, content }
}

function isToolResult(obj: Record<string, unknown>, content: unknown): boolean {
  if (obj.type === 'tool_result') return true
  const subtype = str(obj.subtype)
  if (subtype === 'completed' || subtype === 'success' || subtype === 'result') return true
  return obj.type === 'tool_call' && content !== undefined && subtype !== 'started'
}

function infoLine(text: string): CursorEmit {
  return { type: 'log/line', data: { level: 'info', text } }
}

/** Maps one stdout line. User/unmapped JSON and Cursor tool-trace text are dropped. Thinking becomes `assistant/thinking`. Non-JSON stderr → log/line. `result` updates state only. */
export function ingestCursorLine(line: string, state: CursorStreamState): CursorEmit | undefined {
  const trimmed = line.trim()
  if (!trimmed) return
  let obj: Record<string, unknown> | undefined
  try {
    const parsed: unknown = JSON.parse(trimmed)
    obj = asRecord(parsed)
    if (!obj) return infoLine(line)
  } catch {
    if (/^tool \S+ToolCall\b/.test(trimmed)) return
    return infoLine(line)
  }

  const type = obj.type
  if (type === 'user') return
  if (type === 'thinking') {
    const text = str(obj.text) ?? str(obj.delta)
    if (!text) return
    return { type: 'assistant/thinking', data: { text } }
  }
  if (type === 'system' && obj.subtype === 'init') {
    const sessionRef = str(obj.session_id) ?? str(obj.sessionId) ?? str(asRecord(obj.session)?.id)
    if (sessionRef) state.sessionRef = sessionRef
    return { type: 'system/init', data: { sessionRef, model: obj.model } }
  }

  if (type === 'assistant') {
    const text = assistantText(obj)
    if (text === undefined) return
    const delta = assistantDelta(text, state)
    if (delta === undefined) return
    return { type: 'assistant/delta', data: { text: delta } }
  }

  if (type === 'tool_call' || type === 'tool_use' || type === 'tool_result') {
    const fields = toolFields(obj)
    if (isToolResult(obj, fields.content)) {
      return { type: 'tool/result', data: { name: fields.name, content: fields.content ?? '', id: fields.id } }
    }
    return { type: 'tool/call', data: { name: fields.name ?? 'tool', args: fields.args, id: fields.id } }
  }

  if (type === 'result') {
    const usage = toUsage(obj.usage)
    if (usage) state.usage = usage
    const sessionRef = str(obj.session_id) ?? str(obj.sessionId)
    if (sessionRef && !state.sessionRef) state.sessionRef = sessionRef
    return
  }

  if (type === 'error') {
    return infoLine(str(obj.message) ?? str(obj.error) ?? 'cursor error')
  }

  return
}
