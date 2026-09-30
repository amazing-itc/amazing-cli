import type { EventType, RunRecord, Usage } from '../../../core/types.js'
import { copilotPermissions } from '../argv.js'
import { defineSpawnParser } from '../index.js'

const isRecord = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v)

function str(...vals: unknown[]): string | undefined {
  for (const v of vals) if (typeof v === 'string' && v.length > 0) return v
}

function sessionIdOf(obj: Record<string, unknown>): string | undefined {
  const data = isRecord(obj.data) ? obj.data : undefined
  const result = isRecord(obj.result) ? obj.result : undefined
  return str(obj.sessionId, obj.session_id, data?.sessionId, data?.session_id, result?.sessionId, result?.session_id)
}

function assistantText(obj: Record<string, unknown>): string | undefined {
  const data = isRecord(obj.data) ? obj.data : undefined
  const message = isRecord(obj.message) ? obj.message : undefined
  return str(obj.text, obj.content, obj.delta, data?.text, data?.content, data?.deltaContent, data?.delta, typeof message?.content === 'string' ? message.content : undefined)
}

function toolName(obj: Record<string, unknown>): string {
  const data = isRecord(obj.data) ? obj.data : undefined
  return str(obj.name, obj.tool, data?.toolName, data?.name) ?? 'unknown'
}

function toolArgs(obj: Record<string, unknown>): Record<string, unknown> {
  const data = isRecord(obj.data) ? obj.data : undefined
  if (isRecord(obj.args)) return obj.args
  if (isRecord(obj.arguments)) return obj.arguments
  if (data && isRecord(data.arguments)) return data.arguments
  if (data && isRecord(data.args)) return data.args
  return {}
}

function toolContent(obj: Record<string, unknown>): string {
  const data = isRecord(obj.data) ? obj.data : undefined
  return str(obj.content, typeof obj.result === 'string' ? obj.result : undefined, typeof data?.result === 'string' ? data.result : undefined, data?.content, typeof data?.error === 'string' ? data.error : undefined) ?? ''
}

function usageOf(obj: Record<string, unknown>): Usage | undefined {
  const nested = isRecord(obj.usage) ? obj.usage : isRecord(obj.data) && isRecord(obj.data.usage) ? obj.data.usage : undefined
  if (!nested) return undefined
  const usage: Usage = {}
  if (typeof nested.inputTokens === 'number') usage.inputTokens = nested.inputTokens
  else if (typeof nested.input_tokens === 'number') usage.inputTokens = nested.input_tokens
  if (typeof nested.outputTokens === 'number') usage.outputTokens = nested.outputTokens
  else if (typeof nested.output_tokens === 'number') usage.outputTokens = nested.output_tokens
  const cost = nested.costUsd ?? nested.total_cost_usd ?? obj.total_cost_usd
  if (typeof cost === 'number') usage.costUsd = cost
  return Object.keys(usage).length > 0 ? usage : undefined
}

interface ParseState {
  sessionRef?: string
  usage?: Usage
}

function ingest(line: string, emit: (type: EventType, data: unknown) => void, run: RunRecord, state: ParseState): void {
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

  const sid = sessionIdOf(obj)
  if (sid && !state.sessionRef) {
    state.sessionRef = sid
    emit('system/init', { sessionRef: sid, ...(run.modelId ? { model: run.modelId } : {}) })
  }

  const type = typeof obj.type === 'string' ? obj.type : ''
  if (type === 'assistant' || type.startsWith('assistant.')) {
    const text = assistantText(obj)
    if (text) emit('assistant/delta', { text })
    return
  }
  if (type === 'tool' || type === 'tool_call' || type === 'tool.execution_start' || type === 'tool_use') {
    emit('tool/call', { name: toolName(obj), args: toolArgs(obj) })
    return
  }
  if (type === 'tool_result' || type === 'tool.execution_complete' || type === 'tool.result') {
    emit('tool/result', { name: toolName(obj), content: toolContent(obj) })
    return
  }
  if (type === 'result') {
    const usage = usageOf(obj)
    if (usage) state.usage = usage
    return
  }
  if (type === 'session.start' || type === 'system') return
  emit('log/line', { text: line })
}

defineSpawnParser('copilot', {
  createState: (): ParseState => ({}),
  onLine(line, emit, state, run) {
    ingest(line, emit, run, state as ParseState)
  },
  sessionRef: (state) => (state as ParseState).sessionRef,
  usage: (state) => (state as ParseState).usage,
  permissions: () => copilotPermissions(),
  exit: 'strict',
  notFoundMessage: 'copilot not found',
  exitMessage: (spawned) => spawned.detail ?? `copilot exited with code ${spawned.code}`,
})

