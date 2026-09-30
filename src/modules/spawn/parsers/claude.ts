import type { EventType, Usage } from '../../../core/types.js'
import { claudePermissions } from '../argv.js'
import { defineSpawnParser } from '../index.js'

interface ClaudeState extends ParseState {
  sessionRef?: string
  usage?: Usage
}

defineSpawnParser('claude', {
  createState: (): ClaudeState => ({ emittedText: '', toolKeys: new Set() }),
  onLine(line, emit, state) {
    const parsed = state as ClaudeState
    handleStdout(line, emit, parsed, (ref) => {
      parsed.sessionRef = ref
    }, (next) => {
      parsed.usage = next
    })
  },
  sessionRef: (state) => (state as ClaudeState).sessionRef,
  usage: (state) => (state as ClaudeState).usage,
  permissions: () => claudePermissions(),
  exit: 'strict',
  notFoundMessage: 'claude CLI not found',
  exitMessage: (spawned) => spawned.detail ?? `claude exited with code ${spawned.code}`,
})

interface ParseState {
  emittedText: string
  toolKeys: Set<string>
}

function handleStdout(
  line: string,
  emit: (type: EventType, data: unknown) => void,
  state: ParseState,
  onSession: (ref: string) => void,
  onUsage: (usage: Usage | undefined) => void,
): void {
  const trimmed = line.trim()
  if (!trimmed) return
  let parsed: unknown
  try {
    parsed = JSON.parse(trimmed)
  } catch {
    emit('log/line', { level: 'info', text: line })
    return
  }
  const obj = rec(parsed)
  if (!obj) return
  const type = str(obj.type)

  if (type === 'system' && (obj.subtype === 'init' || str(obj.session_id))) {
    const sessionRef = str(obj.session_id)
    if (!sessionRef) return
    const model = str(obj.model)
    emit('system/init', model ? { sessionRef, model } : { sessionRef })
    onSession(sessionRef)
    return
  }

  if (type === 'result') {
    const sid = str(obj.session_id)
    if (sid) onSession(sid)
    onUsage(usageFrom(obj))
    return
  }

  if (type === 'tool_use') {
    emitTool(state, emit, 'tool/call', toolCallData(obj))
    return
  }
  if (type === 'tool_result') {
    emitTool(state, emit, 'tool/result', toolResultData(obj))
    return
  }

  emitTextAndTools(obj, emit, state)
}

function emitTextAndTools(obj: Record<string, unknown>, emit: (type: EventType, data: unknown) => void, state: ParseState): void {
  if (obj.type === 'stream_event') {
    const event = rec(obj.event)
    if (!event) return
    const delta = rec(event.delta)
    if (event.type === 'content_block_delta' && delta && (delta.type === 'text_delta' || str(delta.text))) {
      const text = str(delta.text)
      if (text) {
        emit('assistant/delta', { text })
        state.emittedText += text
      }
    }
    const block = rec(event.content_block)
    if (event.type === 'content_block_start' && block?.type === 'tool_use') emitTool(state, emit, 'tool/call', toolCallData(block))
    if (block?.type === 'tool_result') emitTool(state, emit, 'tool/result', toolResultData(block))
    return
  }

  if (obj.type === 'assistant') {
    const blocks = contentBlocks(obj)
    emitCompleteText(state, emit, blocks.filter((b) => b.type === 'text').map((b) => str(b.text) ?? '').join(''))
    for (const item of blocks) {
      if (item.type === 'tool_use') emitTool(state, emit, 'tool/call', toolCallData(item))
      if (item.type === 'tool_result') emitTool(state, emit, 'tool/result', toolResultData(item))
    }
    return
  }

  if (obj.type === 'user') {
    for (const item of contentBlocks(obj)) {
      if (item.type === 'tool_use') emitTool(state, emit, 'tool/call', toolCallData(item))
      if (item.type === 'tool_result') emitTool(state, emit, 'tool/result', toolResultData(item))
    }
    return
  }

  const topDelta = rec(obj.delta)
  const topText = str(obj.text) ?? str(topDelta?.text)
  if (topText && obj.type !== 'tool_use' && obj.type !== 'tool_result') emitCompleteText(state, emit, topText)

  for (const item of contentBlocks(obj)) {
    if (item.type === 'text') emitCompleteText(state, emit, str(item.text) ?? '')
    else if (item.type === 'tool_use') emitTool(state, emit, 'tool/call', toolCallData(item))
    else if (item.type === 'tool_result') emitTool(state, emit, 'tool/result', toolResultData(item))
  }
}

function emitCompleteText(state: ParseState, emit: (type: EventType, data: unknown) => void, complete: string): void {
  if (!complete) return
  const already = state.emittedText
  if (complete === already || already.startsWith(complete)) return
  const text = complete.startsWith(already) ? complete.slice(already.length) : complete
  if (!text) return
  emit('assistant/delta', { text })
  state.emittedText += text
}

function emitTool(
  state: ParseState,
  emit: (type: EventType, data: unknown) => void,
  type: 'tool/call' | 'tool/result',
  data: Record<string, unknown>,
): void {
  const id = str(data.id)
  const key = id ? `${type}:${id}` : undefined
  if (key && state.toolKeys.has(key)) return
  if (key) state.toolKeys.add(key)
  emit(type, data)
}

function contentBlocks(obj: Record<string, unknown>): Record<string, unknown>[] {
  const message = rec(obj.message)
  const content = message?.content ?? obj.content
  if (!Array.isArray(content)) return []
  return content.map(rec).filter((b): b is Record<string, unknown> => b !== undefined)
}

function toolCallData(block: Record<string, unknown>): Record<string, unknown> {
  const data: Record<string, unknown> = { name: str(block.name) ?? 'unknown' }
  const args = block.input ?? block.args
  if (args !== undefined) data.args = args
  const id = str(block.id)
  if (id) data.id = id
  return data
}

function toolResultData(block: Record<string, unknown>): Record<string, unknown> {
  const data: Record<string, unknown> = { content: toolResultContent(block.content ?? block.result) }
  const name = str(block.name)
  if (name) data.name = name
  const id = str(block.tool_use_id) ?? str(block.id)
  if (id) data.id = id
  return data
}

function toolResultContent(value: unknown): string {
  if (typeof value === 'string') return value
  if (Array.isArray(value)) {
    return value
      .map((item) => {
        const b = rec(item)
        return b ? str(b.text) ?? '' : typeof item === 'string' ? item : ''
      })
      .join('')
  }
  if (value === undefined || value === null) return ''
  return typeof value === 'object' ? JSON.stringify(value) : String(value)
}

function usageFrom(obj: Record<string, unknown>): Usage | undefined {
  const u = rec(obj.usage) ?? {}
  const inputTokens = num(u.input_tokens) ?? num(u.inputTokens)
  const outputTokens = num(u.output_tokens) ?? num(u.outputTokens)
  const costUsd = num(obj.total_cost_usd) ?? num(obj.costUsd) ?? num(u.cost_usd) ?? num(u.costUsd)
  if (inputTokens === undefined && outputTokens === undefined && costUsd === undefined) return undefined
  const usage: Usage = {}
  if (inputTokens !== undefined) usage.inputTokens = inputTokens
  if (outputTokens !== undefined) usage.outputTokens = outputTokens
  if (costUsd !== undefined) usage.costUsd = costUsd
  return usage
}

function rec(v: unknown): Record<string, unknown> | undefined {
  return v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v !== '' ? v : undefined
}

function num(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined
}
