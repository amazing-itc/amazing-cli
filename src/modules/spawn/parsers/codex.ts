import { chmod, mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { EventType, Usage } from '../../../core/types.js'
import { defineSpawnParser } from '../index.js'

const isRecord = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v)

/**
 * Codex's built-in OpenAI provider reads `$CODEX_HOME/auth.json`, not `OPENAI_API_KEY`.
 * Env alone yields 401 "Missing bearer …". Mirror `codex login --with-api-key`.
 */
export async function writeCodexApiKeyAuth(homeDir: string, secret: string): Promise<void> {
  const dir = path.join(homeDir, '.codex')
  await mkdir(dir, { recursive: true, mode: 0o700 })
  const file = path.join(dir, 'auth.json')
  const body = `${JSON.stringify({ auth_mode: 'apikey', OPENAI_API_KEY: secret }, null, 2)}\n`
  await writeFile(file, body, { encoding: 'utf8', mode: 0o600 })
  await chmod(file, 0o600)
}

function mapUsage(raw: unknown): Usage | undefined {
  if (!isRecord(raw)) return undefined
  const usage: Usage = {}
  const input = raw.inputTokens ?? raw.input_tokens
  const output = raw.outputTokens ?? raw.output_tokens
  const cost = raw.costUsd ?? raw.cost_usd
  if (typeof input === 'number') usage.inputTokens = input
  if (typeof output === 'number') usage.outputTokens = output
  if (typeof cost === 'number') usage.costUsd = cost
  return Object.keys(usage).length > 0 ? usage : undefined
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined
}

function itemText(item: Record<string, unknown>): string | undefined {
  return str(item.text) ?? str(item.message) ?? str(item.content)
}

function toolArgs(item: Record<string, unknown>): unknown {
  if (item.args !== undefined) return item.args
  if (typeof item.arguments === 'string') {
    try {
      return JSON.parse(item.arguments) as unknown
    } catch {
      return item.arguments
    }
  }
  return item.arguments
}

function itemId(item: Record<string, unknown>): string | undefined {
  return str(item.id) ?? str(item.call_id)
}

function withId(data: Record<string, unknown>, id: string | undefined): Record<string, unknown> {
  return id ? { ...data, id } : data
}

function assistantDelta(text: string, state: ParseState): string | undefined {
  if (text.startsWith(state.fullText)) {
    const delta = text.slice(state.fullText.length)
    state.fullText = text
    return delta || undefined
  }
  state.fullText += text
  return text
}

function itemPhase(eventType: unknown, item: Record<string, unknown>): 'started' | 'updated' | 'completed' {
  if (eventType === 'item.started') return 'started'
  if (eventType === 'item.updated') return 'updated'
  if (eventType === 'item.completed') return 'completed'
  if (item.status === 'in_progress') return 'started'
  if (item.status === 'completed' || item.status === 'failed') return 'completed'
  return 'completed'
}

function errorMessage(obj: Record<string, unknown>): string {
  if (isRecord(obj.error) && typeof obj.error.message === 'string') return obj.error.message
  return str(obj.message) ?? 'codex error'
}

function mcpResultContent(item: Record<string, unknown>): string {
  if (typeof item.output === 'string') return item.output
  if (isRecord(item.error) && typeof item.error.message === 'string') return item.error.message
  const result = item.result
  if (typeof result === 'string') return result
  if (isRecord(result)) {
    if (typeof result.content === 'string') return result.content
    if (Array.isArray(result.content)) {
      return result.content
        .map((block) => (isRecord(block) ? str(block.text) ?? '' : ''))
        .join('')
    }
    return JSON.stringify(result)
  }
  return ''
}

function commandOutput(item: Record<string, unknown>): string {
  if (typeof item.aggregated_output === 'string') return item.aggregated_output
  if (typeof item.output === 'string') return item.output
  return ''
}

interface ParseState {
  sessionRef?: string
  usage?: Usage
  error?: { code: 'internal'; message: string }
  fullText: string
}

function handleLine(line: string, emit: (type: EventType, data: unknown) => void, state: ParseState): void {
  if (line.length === 0) return
  let parsed: unknown
  try {
    parsed = JSON.parse(line)
  } catch {
    emit('log/line', { text: line })
    return
  }
  if (!isRecord(parsed)) {
    emit('log/line', { level: 'info', text: line })
    return
  }

  const threadId = typeof parsed.thread_id === 'string' ? parsed.thread_id : undefined
  if (parsed.type === 'thread.started' || (parsed.type === 'started' && threadId)) {
    if (threadId) {
      state.sessionRef = threadId
      emit('system/init', { sessionRef: threadId })
    }
    return
  }
  if (parsed.type === 'turn.completed') {
    state.usage = mapUsage(parsed.usage)
    return
  }
  if (parsed.type === 'turn.failed' || parsed.type === 'error') {
    state.error = { code: 'internal', message: errorMessage(parsed) }
    return
  }

  const item = isRecord(parsed.item) ? parsed.item : parsed
  const itemType = item.type
  const phase = itemPhase(parsed.type, item)
  const id = itemId(item)

  if (itemType === 'agent_message' || itemType === 'assistant') {
    if (phase === 'started') return
    const text = itemText(item)
    if (!text) return
    const delta = assistantDelta(text, state)
    if (delta) emit('assistant/delta', { text: delta })
    return
  }
  if (itemType === 'command_execution') {
    if (phase === 'started') {
      emit('tool/call', withId({ name: 'command_execution', args: { command: item.command } }, id))
    } else if (phase === 'completed') {
      emit('tool/result', withId({ name: 'command_execution', content: commandOutput(item) }, id))
    }
    return
  }
  if (itemType === 'mcp_tool_call') {
    if (phase === 'started') {
      emit('tool/call', withId({ name: 'mcp_tool_call', args: { server: item.server, tool: item.tool, arguments: item.arguments } }, id))
    } else if (phase === 'completed') {
      emit('tool/result', withId({ name: 'mcp_tool_call', content: mcpResultContent(item) }, id))
    }
    return
  }
  if (itemType === 'file_change') {
    emit('tool/call', withId({ name: 'file_change', args: { changes: item.changes } }, id))
    if (phase === 'completed') {
      emit('tool/result', withId({ name: 'file_change', content: typeof item.aggregated_output === 'string' ? item.aggregated_output : JSON.stringify(item.changes ?? []) }, id))
    }
    return
  }
  if (itemType === 'function_call' || itemType === 'tool') {
    emit('tool/call', withId({ name: str(item.name) ?? 'tool', ...(item.args !== undefined || item.arguments !== undefined ? { args: toolArgs(item) } : {}) }, id))
    return
  }
  if (itemType === 'function_call_output') {
    const content = typeof item.output === 'string' ? item.output : typeof item.content === 'string' ? item.content : ''
    emit('tool/result', withId({ content, ...(str(item.name) ? { name: item.name } : {}) }, id))
    return
  }
  emit('log/line', { level: 'info', text: line })
}

defineSpawnParser('codex', {
  createState: (): ParseState => ({ fullText: '' }),
  onLine(line, emit, state) {
    handleLine(line, emit, state as ParseState)
  },
  sessionRef: (state) => (state as ParseState).sessionRef,
  usage: (state) => (state as ParseState).usage,
  failure: (state) => (state as ParseState).error,
  beforeSpawn: async (input) => {
    const secret = input.credentialSecret
    if (secret) await writeCodexApiKeyAuth(input.homeDir, secret)
  },
  exit: 'strict',
  notFoundMessage: 'codex not found',
  exitMessage: (spawned) => spawned.detail ?? `codex exited with code ${spawned.code}`,
})

