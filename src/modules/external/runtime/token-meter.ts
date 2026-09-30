import type { ChatMessage } from '../types.js'

const CHARS_PER_TOKEN = 4
const ROLE_OVERHEAD = 4
const BLOCK_OVERHEAD = 4

export function estimateMessage(message: ChatMessage): number {
  let tokens = ROLE_OVERHEAD
  tokens += Math.ceil(String(message.content ?? '').length / CHARS_PER_TOKEN)
  if (message.tool_calls?.length) {
    tokens += BLOCK_OVERHEAD + Math.ceil(JSON.stringify(message.tool_calls).length / CHARS_PER_TOKEN)
  }
  if (message.tool_call_id) {
    tokens += BLOCK_OVERHEAD + Math.ceil(String(message.tool_call_id).length / CHARS_PER_TOKEN)
  }
  return tokens
}

export function measureTokens(messages: ChatMessage[]) {
  const nodes = messages.map(message => ({
    role: message.role,
    tokens: estimateMessage(message),
  }))
  const systemTokens = nodes.filter(node => node.role === 'system').reduce((sum, node) => sum + node.tokens, 0)
  const toolsTokens = nodes.filter(node => node.role === 'tool').reduce((sum, node) => sum + node.tokens, 0)
  const messageTokens = nodes.filter(node => node.role === 'user').reduce((sum, node) => sum + node.tokens, 0)
  const totalTokens = nodes.reduce((sum, node) => sum + node.tokens, 0)
  return {
    totalTokens,
    surfaceTokens: totalTokens,
    nodes,
    breakdown: { systemTokens, toolsTokens, messageTokens },
  }
}
