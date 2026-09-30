import type { RunMode } from '../../../core/types.js'
import type { ToolCall, ToolContext, ToolResult } from '../types.js'
import { runFs } from './tools/fs.js'
import { querySession } from './tools/session-query.js'
import { runShell } from './tools/shell.js'
import { maybeSpill, spillText } from './tools/spill.js'
import { assertSubagentDepth, spawnSubagent } from './subagent.js'

export { assertSubagentDepth }

export const TOOL_SCHEMAS = [
  {
    type: 'function',
    function: {
      name: 'fs',
      description: 'Read, write, list or grep files inside the workspace.',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['read', 'write', 'list', 'grep'] },
          path: { type: 'string' },
          content: { type: 'string' },
          pattern: { type: 'string' },
        },
        required: ['action'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'shell',
      description: 'Run a shell command in the workspace directory.',
      parameters: {
        type: 'object',
        properties: { command: { type: 'string' }, timeoutMs: { type: 'number' } },
        required: ['command'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'session_query',
      description: 'Search the append-only harness session log.',
      parameters: {
        type: 'object',
        properties: { query: { type: 'string' }, limit: { type: 'number' } },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'spill',
      description: 'Persist large text under .harness/spill and return a locator.',
      parameters: {
        type: 'object',
        properties: { content: { type: 'string' }, name: { type: 'string' } },
        required: ['content'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'subagent',
      description: 'Run an isolated child harness (max depth 3).',
      parameters: {
        type: 'object',
        properties: { prompt: { type: 'string' }, label: { type: 'string' } },
        required: ['prompt'],
      },
    },
  },
]

/** Ask/Plan: no `shell`, and `fs` without `write`. Agent/omitted: today's TOOL_SCHEMAS. */
export function toolsForMode(mode?: RunMode): typeof TOOL_SCHEMAS {
  if (mode !== 'ask' && mode !== 'plan') return TOOL_SCHEMAS
  return TOOL_SCHEMAS.filter((schema) => schema.function.name !== 'shell').map((schema) => {
    if (schema.function.name !== 'fs') return schema
    return {
      ...schema,
      function: {
        ...schema.function,
        description: 'Read, list or grep files inside the workspace.',
        parameters: {
          ...schema.function.parameters,
          properties: {
            ...schema.function.parameters.properties,
            action: { type: 'string', enum: ['read', 'list', 'grep'] },
          },
        },
      },
    }
  }) as typeof TOOL_SCHEMAS
}

export function isExclusive(
  name: string,
  args: Record<string, unknown> = {},
  exclusiveTools?: ReadonlySet<string>,
): boolean {
  if (name === 'shell' || name === 'subagent' || name === 'spill') return true
  if (name === 'fs' && (args.action === 'write' || args.action === 'edit')) return true
  return exclusiveTools?.has(name) === true
}

export const MAX_PARALLEL = 10

export async function executeToolCalls(
  calls: ToolCall[],
  options: { maxParallel?: number; ctx?: ToolContext } = {},
): Promise<ToolResult[]> {
  const maxParallel = options.maxParallel ?? MAX_PARALLEL
  const ctx = options.ctx
  const results: ToolResult[] = new Array(calls.length)
  let index = 0
  while (index < calls.length) {
    const parsed = parseCall(calls[index])
    if (isExclusive(parsed.name, parsed.args, ctx?.exclusiveTools)) {
      results[index] = await executeOne(calls[index], ctx)
      index += 1
      continue
    }
    const batch: number[] = []
    while (index < calls.length && batch.length < maxParallel) {
      const next = parseCall(calls[index])
      if (isExclusive(next.name, next.args, ctx?.exclusiveTools)) break
      batch.push(index)
      index += 1
    }
    const batchResults = await Promise.all(batch.map(i => executeOne(calls[i], ctx)))
    batch.forEach((i, offset) => {
      results[i] = batchResults[offset]
    })
  }
  return results
}

export async function executeOne(call: ToolCall, ctx?: ToolContext): Promise<ToolResult> {
  const parsed = parseCall(call)
  try {
    ctx?.signal?.throwIfAborted()
    const content = await dispatch(parsed.name, parsed.args, ctx)
    const spilled = ctx?.session.workspacePath
      ? await maybeSpill(ctx.session.workspacePath, content, parsed.name)
      : content
    return { id: parsed.id, content: spilled }
  } catch (error) {
    return { id: parsed.id, content: `tool ${parsed.name} error: ${error instanceof Error ? error.message : error}` }
  }
}

async function dispatch(name: string, args: Record<string, unknown>, ctx?: ToolContext): Promise<string> {
  const workspace = ctx?.session.workspacePath ?? ''
  if (name === 'fs') {
    return runFs(args, workspace)
  }
  if (name === 'shell') {
    return runShell(String(args.command ?? ''), workspace, {
      timeoutMs: typeof args.timeoutMs === 'number' ? args.timeoutMs : undefined,
      signal: ctx?.signal,
    })
  }
  if (name === 'session_query') {
    if (!ctx?.session) return 'session_query: no session'
    return querySession(ctx.session, String(args.query ?? ''), typeof args.limit === 'number' ? args.limit : 20)
  }
  if (name === 'spill') {
    return spillText(workspace, String(args.content ?? ''), String(args.name ?? 'note.txt'))
  }
  if (name === 'subagent') {
    if (!ctx) return 'subagent: no context'
    return spawnSubagent(String(args.prompt ?? ''), ctx)
  }
  if (name.startsWith('mcp__')) {
    if (!ctx?.callMcp) return `unknown tool ${name}`
    return ctx.callMcp(name, args)
  }
  return `unknown tool ${name}`
}

export function parseCall(call: ToolCall): { id: string; name: string; args: Record<string, unknown> } {
  const name = call.function?.name ?? call.name ?? 'unknown'
  const raw = call.function?.arguments ?? call.arguments ?? '{}'
  let args: Record<string, unknown> = {}
  if (typeof raw === 'string') {
    try {
      args = JSON.parse(raw || '{}') as Record<string, unknown>
    } catch {
      args = { raw }
    }
  } else if (raw && typeof raw === 'object') {
    args = raw
  }
  return { id: call.id ?? name, name, args }
}
