import type { ChatMessage, HarnessSession } from '../types.js'
import { appendLog } from './session.js'
import { estimateMessage } from './token-meter.js'

export const DEFAULT_POLICY = {
  thresholdRatio: 0.8,
  retainRatio: 0.16,
}

export type CompactPolicy = {
  thresholdRatio: number
  retainRatio: number
}

export function compactIfNeeded(
  session: HarnessSession,
  measured: { totalTokens: number },
  policy: CompactPolicy = DEFAULT_POLICY,
) {
  const threshold = Math.floor(session.contextWindow * policy.thresholdRatio)
  if (measured.totalTokens < threshold) {
    return { didCompact: false, session }
  }
  return compactNow(session, policy)
}

export function compactNow(session: HarnessSession, policy: CompactPolicy = DEFAULT_POLICY) {
  appendLog(session, 'compaction/start', { turn: null })
  const retainTokens = Math.max(1, Math.floor(session.contextWindow * policy.retainRatio))
  const cut = selectBalancedCut(session.messages, retainTokens)
  if (cut <= 0) {
    appendLog(session, 'compaction/end', { turn: null, error: 'no-safe-cut' })
    return { didCompact: false, session }
  }
  const dropped = session.messages.slice(0, cut)
  const keep = session.messages.slice(cut)
  const system = session.messages.filter(message => message.role === 'system').slice(0, 1)
  const summary: ChatMessage = {
    role: 'user',
    content: `<compacted-summary>${dropped.length} messages compacted; shadowed log seq ${session.log.length}</compacted-summary>`,
  }
  appendLog(session, 'compaction/summary', {
    dropped: dropped.length,
    retained: keep.length,
    shadowedPreview: dropped
      .slice(0, 8)
      .map(message => `${message.role}:${String(message.content ?? '').slice(0, 80)}`),
  })
  const rest = keep.filter(message => message.role !== 'system')
  session.messages = system.length ? [...system, summary, ...rest] : [summary, ...keep]
  appendLog(session, 'compaction/end', { turn: null, dropped: dropped.length, messages: session.messages })
  return { didCompact: true, session }
}

export function selectBalancedCut(messages: ChatMessage[], retainTokens: number): number {
  let acc = 0
  let cut = 0
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    acc += estimateMessage(messages[i])
    if (acc >= retainTokens && toolPairingBalancedBefore(messages, i)) {
      cut = i
      break
    }
  }
  return cut
}

export function toolPairingBalancedBefore(messages: ChatMessage[], index: number): boolean {
  let inProgress = 0
  for (let i = 0; i < index; i += 1) {
    inProgress += pairingDelta(messages[i])
    if (inProgress < 0) return false
  }
  return inProgress === 0
}

function pairingDelta(message: ChatMessage): number {
  if (message.role === 'assistant') {
    return message.tool_calls?.length ?? 0
  }
  if (message.role === 'tool') {
    return -1
  }
  return 0
}
