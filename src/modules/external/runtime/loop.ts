import type { EventType, RunMode } from '../../../core/types.js'
import { RunFailure } from '../../../core/errors.js'
import { sanitizeMessagesForApi } from '../litellm-client.js'
import type { ChatMessage, HarnessSession, StreamChat, ToolCall } from '../types.js'
import { compactIfNeeded, compactNow, DEFAULT_POLICY } from './compaction.js'
import { createSession, pushMessage } from './session.js'
import { executeToolCalls, parseCall, toolsForMode } from './tools.js'
import { measureTokens } from './token-meter.js'

export type HarnessInput = {
  model: string
  prompt: string
  workspacePath?: string
  contextWindow?: number
  depth?: number
  maxSteps?: number
  mode?: RunMode
  signal?: AbortSignal
  onLog?: (line: string) => void
  chat?: typeof fetch
  complete?: StreamChat
  session?: HarnessSession
  persist?: HarnessSession['persist']
  emit?: (type: EventType, data: unknown) => void
  tools?: unknown
  exclusiveTools?: ReadonlySet<string>
  callMcp?: (name: string, args: Record<string, unknown>) => Promise<string>
}

export async function runHarness(input: HarnessInput): Promise<{
  ok: boolean
  text: string
  session: HarnessSession
  usage?: { inputTokens?: number; outputTokens?: number }
}> {
  const session =
    input.session ??
    createSession({
      prompt: input.prompt,
      workspacePath: input.workspacePath,
      contextWindow: input.contextWindow,
      depth: input.depth,
      mode: input.mode,
      persist: input.persist,
    })
  if (input.session) {
    const lastUser = [...session.messages].reverse().find((message) => message.role === 'user')
    if (lastUser?.content !== input.prompt) {
      pushMessage(session, { role: 'user', content: input.prompt }, 'user/message')
    }
  }
  input.onLog?.(`harness: start family=external depth=${session.depth}`)
  let lastText = ''
  let usage: { inputTokens?: number; outputTokens?: number } | undefined
  const maxSteps = input.maxSteps ?? 24
  for (let step = 0; step < maxSteps; step += 1) {
    input.signal?.throwIfAborted()
    const measured = measureTokens(session.messages)
    const compacted = compactIfNeeded(session, measured, DEFAULT_POLICY)
    if (compacted.didCompact) {
      input.onLog?.('harness: compacted context')
      input.emit?.('compaction', { dropped: true })
    }
    let completion
    try {
      completion = await streamChat(input.model, session.messages, input)
    } catch (error) {
      if (error instanceof RunFailure) throw error
      const message = error instanceof Error ? error.message : String(error)
      if (error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError')) throw error
      if (input.signal?.aborted) throw abortErr()
      if (message.includes('CONTEXT_WINDOW_EXCEEDED')) {
        let overflow = 0
        const maxOverflow = 2
        while (overflow < maxOverflow) {
          overflow += 1
          compactNow(session, { ...DEFAULT_POLICY, retainRatio: overflow === maxOverflow ? 0 : 0.08 })
          input.onLog?.(`harness: overflow compact retry ${overflow}/${maxOverflow}`)
          input.emit?.('compaction', { overflow })
          try {
            completion = await streamChat(input.model, session.messages, input)
            break
          } catch (retryError) {
            if (retryError instanceof RunFailure) throw retryError
            if (retryError instanceof Error && (retryError.name === 'AbortError' || retryError.name === 'TimeoutError')) {
              throw retryError
            }
            const retryMessage = retryError instanceof Error ? retryError.message : String(retryError)
            if (!retryMessage.includes('CONTEXT_WINDOW_EXCEEDED') || overflow >= maxOverflow) {
              input.onLog?.(`harness error: ${retryMessage}`)
              return { ok: false, text: retryMessage, session }
            }
          }
        }
        if (!completion) {
          return { ok: false, text: message, session }
        }
      } else {
        input.onLog?.(`harness error: ${message}`)
        return { ok: false, text: message, session }
      }
    }
    lastText = completion.text
    if (completion.usage) usage = completion.usage
    pushMessage(
      session,
      completion.toolCalls?.length
        ? { role: 'assistant', content: completion.text, tool_calls: completion.toolCalls }
        : { role: 'assistant', content: completion.text },
      'assistant/message',
    )
    if (!completion.streamed) {
      input.emit?.('assistant/message', { text: completion.text })
    }
    input.onLog?.(completion.text || `harness: model step ${step + 1}`)
    if (!completion.toolCalls?.length) {
      return { ok: true, text: lastText, session, usage }
    }
    for (const call of completion.toolCalls) {
      const parsed = parseCall(call)
      input.emit?.('tool/call', { name: parsed.name, args: parsed.args, id: parsed.id })
    }
    const results = await executeToolCalls(completion.toolCalls, {
      maxParallel: 10,
      ctx: {
        session,
        signal: input.signal,
        onLog: input.onLog,
        model: input.model,
        chat: input.chat,
        complete: input.complete,
        exclusiveTools: input.exclusiveTools,
        callMcp: input.callMcp,
        tools: input.tools,
      },
    })
    for (const result of results) {
      pushMessage(
        session,
        { role: 'tool', content: result.content, tool_call_id: result.id },
        'tool/result',
      )
      input.emit?.('tool/result', { id: result.id, content: result.content })
      input.onLog?.(`tool ${result.id}: ${result.content.slice(0, 200)}`)
    }
  }
  return { ok: true, text: lastText, session, usage }
}

async function streamChat(
  model: string,
  messages: ChatMessage[],
  input: HarnessInput,
): Promise<{
  text: string
  toolCalls: ToolCall[]
  usage?: { inputTokens?: number; outputTokens?: number }
  streamed?: boolean
}> {
  if (input.complete) {
    return input.complete(model, messages, { signal: input.signal, chat: input.chat })
  }
  const fetchFn = input.chat ?? fetch
  const response = await fetchFn('http://litellm:4000/v1/chat/completions', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    signal: input.signal,
    body: JSON.stringify({
      model,
      messages: sanitizeMessagesForApi(messages),
      tools: input.tools ?? toolsForMode(input.mode),
      stream: true,
    }),
  })
  if (!response.ok) {
    const text = await response.text()
    if (text.toLowerCase().includes('context') && text.toLowerCase().includes('window')) {
      throw new Error('CONTEXT_WINDOW_EXCEEDED')
    }
    throw new Error(text || `litellm ${response.status}`)
  }
  const json = (await response.json()) as {
    choices?: Array<{ message?: { content?: string; tool_calls?: ToolCall[] } }>
  }
  const message = json.choices?.[0]?.message ?? {}
  return { text: message.content ?? '', toolCalls: message.tool_calls ?? [] }
}

function abortErr(): Error {
  const err = new Error('aborted')
  err.name = 'AbortError'
  return err
}
