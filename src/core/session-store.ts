import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname } from 'node:path'

export type ToolCall = {
  id?: string
  type?: string
  name?: string
  index?: number
  function?: { name?: string; arguments?: string }
  arguments?: string | Record<string, unknown>
}

export type ChatMessage = {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content?: string
  tool_calls?: ToolCall[]
  tool_call_id?: string
}

export type SessionEvent = {
  seq: number
  type: string
  at: string
  data: unknown
}

export type SessionStore = {
  path: string
  append(event: SessionEvent): void
  read(): SessionEvent[]
  rebuild(): ChatMessage[]
}

export function sessionFileForHome(homeDir: string): string {
  return `${dirname(homeDir)}/session.jsonl`
}

export function createSessionStore(filePath: string): SessionStore {
  return {
    path: filePath,
    append(event) {
      mkdirSync(dirname(filePath), { recursive: true })
      appendFileSync(filePath, `${JSON.stringify(event)}\n`, 'utf8')
    },
    read() {
      return readEvents(filePath)
    },
    rebuild() {
      return rebuild(readEvents(filePath))
    },
  }
}

export function readEvents(filePath: string): SessionEvent[] {
  if (!existsSync(filePath)) return []
  const raw = readFileSync(filePath, 'utf8')
  const events: SessionEvent[] = []
  for (const line of raw.split('\n')) {
    if (line.length === 0) continue
    try {
      const parsed: unknown = JSON.parse(line)
      if (isEvent(parsed)) events.push(parsed)
    } catch {
      continue
    }
  }
  return events
}

export function rebuild(events: SessionEvent[]): ChatMessage[] {
  let messages: ChatMessage[] = []
  for (const event of events) {
    if (event.type === 'session/start') {
      const data = asRecord(event.data)
      messages = [
        { role: 'system', content: str(data.system) },
        { role: 'user', content: str(data.prompt) },
      ]
      continue
    }
    if (event.type === 'compaction/end' || (event.type === 'compaction' && Array.isArray(asRecord(event.data).messages))) {
      const data = asRecord(event.data)
      if (Array.isArray(data.messages)) messages = data.messages.filter(isMessage)
      continue
    }
    if (event.type === 'assistant/message' || event.type === 'tool/result' || event.type === 'tool/call' || event.type === 'user/message') {
      const message = toMessage(event.data, event.type)
      if (message) messages.push(message)
    }
  }
  return messages
}

function isEvent(value: unknown): value is SessionEvent {
  if (!isRecord(value)) return false
  return Number.isInteger(value.seq) && typeof value.type === 'string' && typeof value.at === 'string'
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function asRecord(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {}
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function isMessage(value: unknown): value is ChatMessage {
  if (!isRecord(value)) return false
  return value.role === 'system' || value.role === 'user' || value.role === 'assistant' || value.role === 'tool'
}

function toMessage(data: unknown, type: string): ChatMessage | undefined {
  if (!isRecord(data)) return undefined
  const role = data.role
  if (role === 'system' || role === 'user' || role === 'assistant' || role === 'tool') {
    const message: ChatMessage = { role }
    if (typeof data.content === 'string') message.content = data.content
    else if (typeof data.text === 'string') message.content = data.text
    if (Array.isArray(data.tool_calls)) message.tool_calls = data.tool_calls as ChatMessage['tool_calls']
    if (typeof data.tool_call_id === 'string') message.tool_call_id = data.tool_call_id
    return message
  }
  // Providers emit these without a `role` (cursor/codex/fake): `{ text }`, `{ content }`, `{ name, arguments }`.
  if (type === 'assistant/message' && typeof data.text === 'string') return { role: 'assistant', content: data.text }
  if (type === 'user/message') {
    const content = typeof data.content === 'string' ? data.content : typeof data.text === 'string' ? data.text : undefined
    if (content === undefined) return undefined
    return { role: 'user', content }
  }
  if (type === 'tool/result') {
    const content = typeof data.content === 'string' ? data.content : ''
    return { role: 'tool', content, ...(typeof data.id === 'string' ? { tool_call_id: data.id } : {}) }
  }
  if (type === 'tool/call') {
    const name = typeof data.name === 'string' ? data.name : 'tool'
    const args = data.arguments ?? data.input
    const argText = typeof args === 'string' ? args : args === undefined ? '{}' : JSON.stringify(args)
    const id = typeof data.id === 'string' ? data.id : `call_${name}`
    return {
      role: 'assistant',
      content: '',
      tool_calls: [{ id, type: 'function', function: { name, arguments: argText || '{}' } }],
    }
  }
  return undefined
}
