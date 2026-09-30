import type { Family, RunMode } from '../../core/types.js'
import {
  buildContextManifest,
  type ContextManifestBuilder,
  type ContextManifestRequest,
  type ContextUsage,
} from '../../core/context-manifest.js'
import { defaultSystemPromptCore, loadHarnessCatalog } from './runtime/system-prompt.js'
import { toolsForMode } from './runtime/tools.js'

function isExternalFamily(family: Family): boolean {
  return family === 'external'
}

function systemPromptText(family: Family, mode?: RunMode): string {
  if (!isExternalFamily(family)) return ''
  let core = defaultSystemPromptCore()
  if (mode === 'plan') {
    core = `${core} Return a plan only; do not apply edits.`
  }
  return core
}

function toolDefinitionsText(family: Family, mode?: RunMode): string {
  if (!isExternalFamily(family)) return ''
  return JSON.stringify(toolsForMode(mode))
}

/** Composition-root helper: fills harness/tool parts then calls `buildContextManifest`. */
export function resolveContextManifest(input: ContextManifestRequest): ContextUsage {
  return buildContextManifest({
    systemPromptText: systemPromptText(input.family, input.mode),
    toolDefinitionsText: toolDefinitionsText(input.family, input.mode),
    catalogText: input.workspacePath ? loadHarnessCatalog(input.workspacePath) : '',
    mcpServersJson: input.mcpServers?.length ? JSON.stringify(input.mcpServers) : '',
    prompt: input.prompt,
    attachments: input.attachments,
    maxInputTokens: input.maxInputTokens,
    priorConversationTokens: input.priorConversationTokens,
  })
}

export function createContextManifestBuilder(): ContextManifestBuilder {
  return (input) => resolveContextManifest(input)
}
