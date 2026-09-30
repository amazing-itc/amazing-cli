import type { ChatMessage, SessionEvent, ToolCall } from '../../core/session-store.js'

export type { ChatMessage, SessionEvent, ToolCall }

export type HarnessSession = {
  id: string
  depth: number
  contextWindow: number
  workspacePath: string
  log: SessionEvent[]
  messages: ChatMessage[]
  persist?: (event: SessionEvent) => void
}

export type ToolResult = {
  id: string
  content: string
}

export type ToolContext = {
  session: HarnessSession
  signal?: AbortSignal
  onLog?: (line: string) => void
  model: string
  chat?: typeof fetch
  complete?: StreamChat
  exclusiveTools?: ReadonlySet<string>
  callMcp?: (name: string, args: Record<string, unknown>) => Promise<string>
  tools?: unknown
}

export type StreamChat = (
  model: string,
  messages: ChatMessage[],
  input: { signal?: AbortSignal; chat?: typeof fetch },
) => Promise<{
  text: string
  toolCalls: ToolCall[]
  usage?: { inputTokens?: number; outputTokens?: number }
  /** True when the caller already emitted incremental assistant/delta events. */
  streamed?: boolean
}>
