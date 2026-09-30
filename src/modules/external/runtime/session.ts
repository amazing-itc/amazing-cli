import { randomUUID } from 'node:crypto'
import type { RunMode } from '../../../core/types.js'
import type { ChatMessage, HarnessSession, SessionEvent } from '../types.js'
import { buildSystemPrompt } from './system-prompt.js'

export function createSession(input: {
  prompt?: string
  system?: string
  workspacePath?: string
  contextWindow?: number
  depth?: number
  id?: string
  mode?: RunMode
  persist?: (event: SessionEvent) => void
}): HarnessSession {
  const system = input.system ?? buildSystemPrompt(input.workspacePath ?? '', input.mode)
  const session: HarnessSession = {
    id: input.id ?? randomUUID(),
    depth: input.depth ?? 0,
    contextWindow: input.contextWindow ?? 128000,
    workspacePath: input.workspacePath ?? '',
    log: [],
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: input.prompt ?? '' },
    ],
    persist: input.persist,
  }
  appendLog(session, 'session/start', {
    depth: session.depth,
    workspacePath: session.workspacePath,
    contextWindow: session.contextWindow,
    id: session.id,
    system,
    prompt: input.prompt ?? '',
  })
  return session
}

export function restoreSession(input: {
  events: SessionEvent[]
  messages: ChatMessage[]
  workspacePath: string
  persist?: (event: SessionEvent) => void
}): HarnessSession {
  const start = input.events.find((event) => event.type === 'session/start')
  const data = start && typeof start.data === 'object' && start.data !== null ? (start.data as Record<string, unknown>) : {}
  const session: HarnessSession = {
    id: typeof data.id === 'string' ? data.id : randomUUID(),
    depth: typeof data.depth === 'number' ? data.depth : 0,
    contextWindow: typeof data.contextWindow === 'number' ? data.contextWindow : 128000,
    workspacePath: input.workspacePath,
    log: [...input.events],
    messages: [...input.messages],
    persist: input.persist,
  }
  return session
}

export function appendLog(session: HarnessSession, type: string, data: unknown = {}): SessionEvent {
  const event: SessionEvent = {
    seq: session.log.length + 1,
    type,
    at: new Date().toISOString(),
    data,
  }
  session.log.push(event)
  session.persist?.(event)
  return event
}

export function pushMessage(session: HarnessSession, message: ChatMessage, type: string): void {
  session.messages.push(message)
  appendLog(session, type, {
    role: message.role,
    content: message.content,
    tool_calls: message.tool_calls,
    tool_call_id: message.tool_call_id,
    preview: String(message.content ?? '').slice(0, 240),
  })
}
