import { fail, RunFailure } from '../../core/errors.js'
import { isAbortError, isAuthStatus, isNetworkError, isRefused, isRetryableStatus, withRetry } from './retry.js'
import type { ChatMessage, ToolCall } from './types.js'

export type LiteLlmClientOpts = {
  baseUrl: string
  masterKey: string
  fetch?: typeof fetch
  onRetry?: (info: { attempt: number; delayMs: number; status?: number }) => void
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>
}

export type CompleteInput = {
  model: string
  messages: ChatMessage[]
  tools: unknown
  signal?: AbortSignal
  onDelta?: (text: string) => void
}

export type CompleteResult = {
  text: string
  toolCalls: ToolCall[]
  usage?: { inputTokens?: number; outputTokens?: number }
}

type HttpFailure = Error & { status?: number; body?: string }

export function createLiteLlmClient(opts: LiteLlmClientOpts) {
  const fetchFn = opts.fetch ?? fetch
  const base = opts.baseUrl.replace(/\/$/, '')

  async function complete(input: CompleteInput): Promise<CompleteResult> {
    return withRetry(() => attempt(input), {
      signal: input.signal,
      onRetry: opts.onRetry,
      sleep: opts.sleep,
    }).catch((err: unknown) => {
      throw mapFailure(err)
    })
  }

  async function attempt(input: CompleteInput): Promise<CompleteResult> {
    let response: Response
    try {
      response = await fetchFn(`${base}/v1/chat/completions`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${opts.masterKey}`,
        },
        signal: input.signal,
        body: JSON.stringify({
          model: input.model,
          messages: sanitizeMessagesForApi(input.messages),
          tools: input.tools,
          stream: true,
          stream_options: { include_usage: true },
        }),
      })
    } catch (err) {
      if (isAbortError(err) || input.signal?.aborted) throw abortError()
      const wrapped: HttpFailure = Object.assign(err instanceof Error ? err : new Error(String(err)), {})
      throw wrapped
    }

    if (!response.ok) {
      const body = await response.text().catch(() => '')
      if (body.toLowerCase().includes('context') && body.toLowerCase().includes('window')) {
        throw new Error('CONTEXT_WINDOW_EXCEEDED')
      }
      const err: HttpFailure = new Error(body || `litellm ${response.status}`)
      err.status = response.status
      err.body = body
      throw err
    }

    return parseCompletion(response, input.onDelta)
  }

  return { complete, baseUrl: base }
}

/** DashScope/Qwen require OpenAI-shaped tool_calls and reject empty arrays. */
export function sanitizeMessagesForApi(messages: ChatMessage[]): ChatMessage[] {
  return messages.map((message) => {
    const toolCalls = message.tool_calls
    if (!Array.isArray(toolCalls) || toolCalls.length === 0) {
      if (message.tool_calls === undefined) return message
      const { tool_calls: _drop, ...rest } = message
      return rest
    }
    return {
      ...message,
      tool_calls: toolCalls.map(normalizeToolCallForApi),
    }
  })
}

export function normalizeToolCallForApi(call: ToolCall): ToolCall {
  const name = call.function?.name ?? call.name ?? 'unknown'
  const raw = call.function?.arguments ?? call.arguments ?? '{}'
  const args = typeof raw === 'string' ? raw || '{}' : JSON.stringify(raw)
  return {
    id: call.id ?? `call_${name}`,
    type: 'function',
    function: { name, arguments: args },
  } as ToolCall
}

function mapFailure(err: unknown): Error {
  if (isAbortError(err)) return abortError()
  if (err instanceof RunFailure) return err
  if (err instanceof Error && err.message === 'CONTEXT_WINDOW_EXCEEDED') return err
  const status = (err as { status?: number }).status
  if (typeof status === 'number' && isAuthStatus(status)) {
    return fail('credential_invalid', 'LiteLLM rejected the master key')
  }
  if (isRefused(err)) {
    return fail('litellm_unavailable', 'LiteLLM connection refused')
  }
  if (typeof status === 'number' && (isRetryableStatus(status) || isAuthStatus(status))) {
    return fail('internal', err instanceof Error ? err.message : `litellm ${status}`)
  }
  if (isNetworkError(err)) {
    return fail('internal', err instanceof Error ? err.message : 'LiteLLM network error')
  }
  if (err instanceof Error) return err
  return fail('internal', String(err))
}

function abortError(): Error {
  const err = new Error('aborted')
  err.name = 'AbortError'
  return err
}

async function parseCompletion(response: Response, onDelta?: (text: string) => void): Promise<CompleteResult> {
  const ctype = response.headers.get('content-type') ?? ''
  if (ctype.includes('application/json') && !ctype.includes('event-stream')) {
    const json = (await response.json()) as {
      choices?: Array<{ message?: { content?: string; tool_calls?: ToolCall[] } }>
      usage?: { prompt_tokens?: number; completion_tokens?: number }
    }
    const message = json.choices?.[0]?.message ?? {}
    return {
      text: message.content ?? '',
      toolCalls: message.tool_calls ?? [],
      usage: usageFrom(json.usage),
    }
  }

  const acc = { text: '', toolCalls: [] as ToolCall[], usage: undefined as CompleteResult['usage'] }
  await parseSse(response.body, (payload) => applyChunk(payload, acc, onDelta))
  return acc
}

function applyChunk(
  payload: unknown,
  acc: { text: string; toolCalls: ToolCall[]; usage: CompleteResult['usage'] },
  onDelta?: (text: string) => void,
): void {
  if (!payload || typeof payload !== 'object') return
  const rec = payload as Record<string, unknown>
  if (rec.usage && typeof rec.usage === 'object') {
    acc.usage = usageFrom(rec.usage as { prompt_tokens?: number; completion_tokens?: number })
  }
  const choices = rec.choices
  if (!Array.isArray(choices) || !choices[0] || typeof choices[0] !== 'object') return
  const choice = choices[0] as Record<string, unknown>
  const delta = choice.delta
  const message = choice.message
  if (delta && typeof delta === 'object') {
    const d = delta as { content?: string; tool_calls?: unknown[] }
    if (typeof d.content === 'string' && d.content.length > 0) {
      acc.text += d.content
      onDelta?.(d.content)
    }
    if (Array.isArray(d.tool_calls)) {
      for (const fragment of d.tool_calls) mergeToolCall(acc.toolCalls, fragment)
    }
  }
  if (message && typeof message === 'object') {
    const m = message as { content?: string; tool_calls?: ToolCall[] }
    if (typeof m.content === 'string') acc.text = m.content
    if (Array.isArray(m.tool_calls)) acc.toolCalls = m.tool_calls
  }
}

function mergeToolCall(sink: ToolCall[], fragment: unknown): void {
  if (!fragment || typeof fragment !== 'object') return
  const f = fragment as ToolCall
  const index = typeof f.index === 'number' ? f.index : sink.length
  while (sink.length <= index) sink.push({ function: { name: '', arguments: '' } })
  const current = sink[index]
  if (typeof f.id === 'string') current.id = f.id
  if (typeof f.name === 'string') current.name = f.name
  const fn = f.function
  if (fn) {
    current.function ??= { name: '', arguments: '' }
    if (typeof fn.name === 'string') current.function.name = `${current.function.name ?? ''}${fn.name}`
    if (typeof fn.arguments === 'string') current.function.arguments = `${current.function.arguments ?? ''}${fn.arguments}`
  }
  if (typeof f.arguments === 'string') {
    current.function ??= { name: '', arguments: '' }
    current.function.arguments = `${current.function.arguments ?? ''}${f.arguments}`
  }
}

function usageFrom(usage?: { prompt_tokens?: number; completion_tokens?: number }): CompleteResult['usage'] {
  if (!usage) return undefined
  const out: { inputTokens?: number; outputTokens?: number } = {}
  if (typeof usage.prompt_tokens === 'number') out.inputTokens = usage.prompt_tokens
  if (typeof usage.completion_tokens === 'number') out.outputTokens = usage.completion_tokens
  return out
}

async function parseSse(body: ReadableStream<Uint8Array> | null, onEvent: (json: unknown) => void): Promise<void> {
  if (!body) return
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buf = ''
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    buf += decoder.decode(value, { stream: true })
    buf = buf.replace(/\r\n/g, '\n')
    const lines = buf.split('\n')
    buf = lines.pop() ?? ''
    for (const line of lines) {
      const trimmed = line.trim()
      if (!trimmed.startsWith('data:')) continue
      const payload = trimmed.slice(5).trim()
      if (!payload || payload === '[DONE]') continue
      try {
        onEvent(JSON.parse(payload))
      } catch {
        continue
      }
    }
  }
  const tail = buf.trim()
  if (tail.startsWith('data:')) {
    const payload = tail.slice(5).trim()
    if (payload && payload !== '[DONE]') {
      try {
        onEvent(JSON.parse(payload))
      } catch {
        /* truncated tail */
      }
    }
  }
}
