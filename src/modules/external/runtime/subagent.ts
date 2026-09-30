import type { ToolContext } from '../types.js'

export function assertSubagentDepth(depth: number, maxDepth = 3): void {
  if (depth > maxDepth) {
    throw new Error(`subagent depth ${depth} exceeds ${maxDepth}`)
  }
}

export async function spawnSubagent(prompt: string, ctx: ToolContext): Promise<string> {
  const nextDepth = (ctx.session.depth ?? 0) + 1
  assertSubagentDepth(nextDepth)
  ctx.onLog?.(`subagent: start depth=${nextDepth}`)
  const { runHarness } = await import('./loop.js')
  const result = await runHarness({
    model: ctx.model,
    prompt,
    workspacePath: ctx.session.workspacePath,
    depth: nextDepth,
    maxSteps: 8,
    signal: ctx.signal,
    chat: ctx.chat,
    complete: ctx.complete,
    tools: ctx.tools,
    exclusiveTools: ctx.exclusiveTools,
    callMcp: ctx.callMcp,
    onLog: line => ctx.onLog?.(`subagent[${nextDepth}]: ${line}`),
  })
  return result.text || (result.ok ? 'subagent completed' : 'subagent failed')
}
