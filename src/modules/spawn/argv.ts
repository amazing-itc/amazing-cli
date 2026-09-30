import type { ProviderManifest } from '../../core/provider-manifest.js'
import type { RunMode } from '../../core/types.js'

const DEFAULT_CLAUDE_TOOLS = 'Read,Edit,Write,Bash,Grep,Glob'
const ASK_PLAN_CLAUDE_TOOLS = 'Read,Grep,Glob'
const DEFAULT_COPILOT_TOOLS = 'shell,write'
const MUTATING_COPILOT_TOOLS = new Set(['shell', 'write'])
const SKIP_PERMISSIONS_FLAG = '--dangerously-skip-permissions'

/** Placeholders whose absence also drops the flag that introduced them (`--model`, `--resume`, `--conversation`). */
const DROPS_PREVIOUS_FLAG = new Set(['{model}', '{resume}', '{workspace}', '{prompt}'])

export interface ArgvContext {
  prompt: string
  workspace: string
  model?: string
  resume?: string
  /** Omitted mode is `agent`. */
  mode?: RunMode
  indexJs?: string | null
  /** Absent keeps `--approve-mcps`. False omits it. */
  approveMcps?: boolean
}

interface ResolvedArgv {
  prompt: string
  workspace: string
  model?: string
  resume?: string
  mode: RunMode
  indexJs?: string | null
  approveMcps?: boolean
}

/**
 * Expands a spawn manifest argv template.
 * Empty `{model}` / `{resume}` drop themselves and the preceding flag.
 * `{mode.ask:A|plan:B|agent:C}` picks one alternative. Omitted mode is `agent`.
 * A non-empty `resumeArgv` replaces `argv` when the turn has a resume ref.
 */
export function expandArgv(manifest: Pick<ProviderManifest, 'argv' | 'resumeArgv' | 'planPrompt'>, ctx: ArgvContext): string[] {
  const mode: RunMode = ctx.mode ?? 'agent'
  const template = ctx.resume && manifest.resumeArgv && manifest.resumeArgv.length > 0 ? manifest.resumeArgv : manifest.argv ?? []
  const prompt = mode === 'plan' && manifest.planPrompt ? `${manifest.planPrompt}${ctx.prompt}` : ctx.prompt
  const resolved: ResolvedArgv = { ...ctx, mode, prompt }
  const out: string[] = []
  for (const token of template) {
    const expanded = expandToken(token, resolved)
    if (expanded === undefined) {
      if (DROPS_PREVIOUS_FLAG.has(token) && out.length > 0 && out[out.length - 1]!.startsWith('-')) out.pop()
      continue
    }
    out.push(...expanded)
  }
  return out
}

export function claudePermissions(): string[] {
  return claudeTools('agent').split(',').map((item) => item.trim()).filter(Boolean)
}

export function copilotPermissions(): string[] {
  return copilotAllowList()
}

function expandToken(token: string, ctx: ResolvedArgv): string[] | undefined {
  if (token === '{prompt}') return [ctx.prompt]
  if (token === '{workspace}') return [ctx.workspace]
  if (token === '{model}') return ctx.model ? [ctx.model] : undefined
  if (token === '{resume}') return ctx.resume ? [ctx.resume] : undefined
  if (token === '{index}') return ctx.indexJs ? [ctx.indexJs] : undefined
  if (token === '{approve-mcps}') return ctx.approveMcps === false ? undefined : ['--approve-mcps']
  if (token === '{claude-tools}') return [claudeTools(ctx.mode)]
  if (token === '{copilot-tools}') return copilotToolArgs(ctx.mode)
  if (token === '{antigravity-skip}') return antigravitySkip(ctx.mode)
  if (token === '{print-timeout}') return [process.env.AMAZING_CLI_ANTIGRAVITY_PRINT_TIMEOUT ?? '600']
  if (token.startsWith('{mode.') && token.endsWith('}')) {
    const value = modeValue(token, ctx.mode)
    return value ? [value] : undefined
  }
  if (token.includes('{')) {
    if ((token.includes('{resume}') && !ctx.resume) || (token.includes('{model}') && !ctx.model)) return undefined
    return [
      token
        .replaceAll('{resume}', ctx.resume ?? '')
        .replaceAll('{model}', ctx.model ?? '')
        .replaceAll('{prompt}', ctx.prompt)
        .replaceAll('{workspace}', ctx.workspace),
    ]
  }
  return [token]
}

function modeValue(token: string, mode: RunMode): string | undefined {
  const body = token.slice('{mode.'.length, -1)
  const parts = body.split(/\|(?=(?:ask|plan|agent):)/)
  for (const part of parts) {
    const splitAt = part.indexOf(':')
    if (splitAt < 0) continue
    const names = part.slice(0, splitAt).split(',')
    if (names.includes(mode)) return part.slice(splitAt + 1)
  }
  return undefined
}

function claudeTools(mode: RunMode): string {
  if (mode === 'ask' || mode === 'plan') return ASK_PLAN_CLAUDE_TOOLS
  const fromEnv = process.env.AMAZING_CLI_CLAUDE_ALLOWED_TOOLS
  return fromEnv && fromEnv.trim() !== '' ? fromEnv.trim() : DEFAULT_CLAUDE_TOOLS
}

function copilotAllowList(): string[] {
  const raw = process.env.AMAZING_CLI_COPILOT_ALLOW_TOOLS
  const source = raw === undefined || raw.trim() === '' ? DEFAULT_COPILOT_TOOLS : raw
  return source.split(',').map((tool) => tool.trim()).filter((tool) => tool.length > 0)
}

function copilotToolArgs(mode: RunMode): string[] {
  const tools = mode === 'agent' ? copilotAllowList() : copilotAllowList().filter((tool) => !MUTATING_COPILOT_TOOLS.has(tool))
  return tools.flatMap((tool) => ['--allow-tool', tool])
}

function antigravitySkip(mode: RunMode): string[] | undefined {
  if (mode !== 'agent') return undefined
  const skip = process.env.AMAZING_CLI_ANTIGRAVITY_SKIP_PERMISSIONS
  if (skip === '0' || skip === 'false') return undefined
  return [SKIP_PERMISSIONS_FLAG]
}
