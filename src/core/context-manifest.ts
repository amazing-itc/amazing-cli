import { readFileSync, statSync } from 'node:fs'
import type { AttachmentKind, Family, RunAttachment, RunMode } from './types.js'

const CHARS_PER_TOKEN = 4

export const CONTEXT_CATEGORY_KEYS = [
  'systemPrompt',
  'toolDefinitions',
  'rules',
  'skills',
  'mcp',
  'subagentDefinitions',
  'conversation',
] as const

export type ContextCategoryKey = (typeof CONTEXT_CATEGORY_KEYS)[number]

export type ContextPrecision = 'exact' | 'estimate'

export interface ContextUsage {
  contextWindow: number | null
  usedTokens: number
  /** `exact` only when the provider reported `usage.inputTokens`; otherwise `estimate` (chars/4). */
  precision: ContextPrecision
  categories: Record<ContextCategoryKey, number>
}

export interface ContextManifestParts {
  systemPromptText?: string
  toolDefinitionsText?: string
  /** Raw lines from `loadHarnessCatalog` (same format). */
  catalogText?: string
  mcpServersJson?: string
  prompt: string
  attachments?: RunAttachment[]
  /** From the model catalog. Omitted / undefined → `contextWindow: null`. Never invent a default. */
  maxInputTokens?: number | null
  /**
   * Tokens already in the session log (user, assistant, tool), measured with `conversationTokensFromEvents`.
   * Added to `conversation` on top of this turn's prompt and attachments. Omitted ⇒ 0.
   */
  priorConversationTokens?: number
}

/** Request shape shared by preview and the run-start emitter (after parts are resolved). */
export interface ContextManifestRequest {
  family: Family
  mode?: RunMode
  modelId?: string
  workspacePath: string
  prompt: string
  attachments?: RunAttachment[]
  mcpServers?: Array<{ name: string; url: string; headers?: Record<string, string> }>
  maxInputTokens?: number | null
  /** Tokens already in the session log. The composition root forwards this into `buildContextManifest`. */
  priorConversationTokens?: number
}

export type ContextManifestBuilder = (input: ContextManifestRequest) => ContextUsage | Promise<ContextUsage>

/** Shared estimate with `token-meter.ts`: `chars/4`. */
export function tokensFromChars(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN)
}

/** Image estimate: `bytes/4`. */
export function tokensFromBytes(byteLength: number): number {
  return Math.ceil(byteLength / CHARS_PER_TOKEN)
}

type CatalogBucket = 'rules' | 'skills' | 'subagentDefinitions'

function bucketForCatalogLine(line: string): CatalogBucket | undefined {
  if (/\/skills(\/|:)/.test(line)) return 'skills'
  if (/\/agents(\/|:)/.test(line)) return 'subagentDefinitions'
  if (/\/rules(\/|:)/.test(line) || /\/instructions(\/|:)/.test(line)) return 'rules'
  return undefined
}

/** Split `loadHarnessCatalog` output into rules / skills / subagent token buckets. */
export function catalogTokensFromText(catalogText: string): Record<CatalogBucket, number> {
  const out: Record<CatalogBucket, number> = { rules: 0, skills: 0, subagentDefinitions: 0 }
  if (!catalogText) return out
  for (const line of catalogText.split('\n')) {
    if (!line) continue
    const bucket = bucketForCatalogLine(line)
    if (!bucket) continue
    out[bucket] += tokensFromChars(line)
  }
  return out
}

function attachmentConversationTokens(att: RunAttachment): number {
  if (att.kind === 'folder') {
    return tokensFromChars(att.path)
  }
  try {
    const st = statSync(att.path)
    if (!st.isFile()) return tokensFromChars(att.path)
    if (att.kind === 'image') {
      return tokensFromBytes(st.size)
    }
    return tokensFromChars(readFileSync(att.path, 'utf8'))
  } catch {
    return tokensFromChars(att.path)
  }
}

function conversationTokens(prompt: string, attachments?: RunAttachment[]): number {
  let tokens = tokensFromChars(prompt)
  for (const att of attachments ?? []) {
    tokens += attachmentConversationTokens(att)
  }
  return tokens
}

/**
 * One function for `POST /v1/context/preview` and the `context/usage` run event.
 * Callers supply harness/tool texts (composition root resolves `loadHarnessCatalog` / `toolsForMode`).
 * `usedTokens` is the sum of the seven category keys and `precision` is `estimate`.
 * `applyPrecision` is what promotes a finished turn when the provider reported `inputTokens`.
 */
export function buildContextManifest(parts: ContextManifestParts): ContextUsage {
  const catalog = catalogTokensFromText(parts.catalogText ?? '')
  const prior = finiteTokenCount(parts.priorConversationTokens)
  const categories: Record<ContextCategoryKey, number> = {
    systemPrompt: tokensFromChars(parts.systemPromptText ?? ''),
    toolDefinitions: tokensFromChars(parts.toolDefinitionsText ?? ''),
    rules: catalog.rules,
    skills: catalog.skills,
    mcp: tokensFromChars(parts.mcpServersJson ?? ''),
    subagentDefinitions: catalog.subagentDefinitions,
    conversation: conversationTokens(parts.prompt, parts.attachments) + prior,
  }
  const usedTokens = CONTEXT_CATEGORY_KEYS.reduce((sum, key) => sum + categories[key], 0)
  const contextWindow =
    typeof parts.maxInputTokens === 'number' && Number.isFinite(parts.maxInputTokens) ? parts.maxInputTokens : null
  return { contextWindow, usedTokens, precision: 'estimate', categories }
}

/**
 * `inputTokens` from the provider wins: `usedTokens` becomes that number and `precision` becomes `exact`.
 * Categories stay the estimate (they are a breakdown, not a second measurement). Anything else stays `estimate`.
 */
export function applyPrecision(usage: ContextUsage, inputTokens: number | undefined): ContextUsage {
  if (typeof inputTokens === 'number' && Number.isFinite(inputTokens) && inputTokens >= 0) {
    return { ...usage, usedTokens: Math.round(inputTokens), precision: 'exact' }
  }
  const usedTokens = CONTEXT_CATEGORY_KEYS.reduce((sum, key) => sum + usage.categories[key], 0)
  return { ...usage, usedTokens, precision: 'estimate' }
}

function finiteTokenCount(value: number | undefined): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return 0
  return Math.floor(value)
}

export function isAttachmentKind(value: unknown): value is AttachmentKind {
  return value === 'image' || value === 'file' || value === 'folder'
}
