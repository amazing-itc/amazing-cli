import { tokensFromChars } from './context-manifest.js'
import { rebuild, type ChatMessage, type SessionEvent } from './session-store.js'

export function messageText(message: ChatMessage): string {
  const calls = (message.tool_calls ?? [])
    .map((call) => {
      const args = call.arguments ?? call.function?.arguments
      const argText = typeof args === 'string' ? args : args === undefined ? '' : JSON.stringify(args)
      return `${call.name ?? call.function?.name ?? ''} ${argText}`.trim()
    })
    .join('\n')
  return [message.content ?? '', calls].filter((part) => part.length > 0).join('\n')
}

/** Chars/4 of the rebuilt session log. A `compaction` event with `messages` replaces everything before it. */
export function conversationTokensFromEvents(events: SessionEvent[]): number {
  return tokensFromChars(rebuild(events).map(messageText).join('\n'))
}

/**
 * Drops a prefix of the rebuilt log so the tail stays near `retainRatio` of the total estimate.
 * Always drops at least one message when the log has two or more, so an explicit `/compact` is observable.
 */
export function compactSessionEvents(
  events: SessionEvent[],
  retainRatio = 0.16,
): { dropped: number; retained: number; messages: ChatMessage[] } {
  const messages = rebuild(events)
  if (messages.length < 2) return { dropped: 0, retained: messages.length, messages }
  const weights = messages.map((message) => Math.max(1, tokensFromChars(messageText(message))))
  const total = weights.reduce((sum, weight) => sum + weight, 0)
  const ratio = retainRatio > 0 && retainRatio < 1 ? retainRatio : 0.16
  const retainTokens = Math.max(1, Math.floor(total * ratio))
  let acc = 0
  let cut = 0
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    acc += weights[i]
    if (acc >= retainTokens) {
      cut = i
      break
    }
  }
  if (cut <= 0) cut = 1
  const dropped = messages.slice(0, cut)
  const keep = messages.slice(cut)
  const summary: ChatMessage = {
    role: 'user',
    content: `<compacted-summary>${dropped.length} messages compacted</compacted-summary>`,
  }
  const next = [summary, ...keep]
  return { dropped: dropped.length, retained: next.length, messages: next }
}
