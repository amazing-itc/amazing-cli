import type { ExternalModel, Family } from './types.js'

export type NativeModelFamily = Exclude<Family, 'external' | 'fake'>

type CatalogEntry = { id: string; label: string; default?: boolean }

const CURSOR_CATALOG: CatalogEntry[] = [
  { id: 'auto', label: 'Auto' },
  { id: 'cursor-grok-4.6-high', label: 'Grok 4.6', default: true },
  { id: 'cursor-grok-4.6-high-fast', label: 'Grok 4.6 Fast' },
  { id: 'cursor-grok-4.6-xhigh', label: 'Grok 4.6 Extra High' },
  { id: 'cursor-grok-4.6-medium', label: 'Grok 4.6 Medium' },
  { id: 'cursor-grok-4.6-low', label: 'Grok 4.6 Low' },
  { id: 'cursor-grok-4.5-high', label: 'Grok 4.5' },
  { id: 'cursor-grok-4.5-high-fast', label: 'Grok 4.5 Fast' },
  { id: 'cursor-grok-4.5-medium', label: 'Grok 4.5 Medium' },
  { id: 'cursor-grok-4.5-low', label: 'Grok 4.5 Low' },
  { id: 'composer-2.5', label: 'Composer 2.5' },
  { id: 'composer-2.5-fast', label: 'Composer 2.5 Fast' },
  { id: 'gpt-5.6-sol-high', label: 'GPT-5.6 Sol High' },
  { id: 'gpt-5.5-high', label: 'GPT-5.5 High' },
  { id: 'claude-opus-5-thinking-high', label: 'Opus 5 Thinking' },
  { id: 'claude-opus-4-8-thinking-high', label: 'Opus 4.8 Thinking' },
]

const CLAUDE_CATALOG: CatalogEntry[] = [
  { id: 'sonnet', label: 'Sonnet', default: true },
  { id: 'opus', label: 'Opus' },
  { id: 'haiku', label: 'Haiku' },
  { id: 'fable', label: 'Fable' },
  { id: 'claude-sonnet-5', label: 'Claude Sonnet 5' },
  { id: 'claude-opus-5', label: 'Claude Opus 5' },
  { id: 'claude-sonnet-4-6', label: 'Claude Sonnet 4.6' },
  { id: 'claude-opus-4-6', label: 'Claude Opus 4.6' },
  { id: 'claude-sonnet-4-5-20250929', label: 'Claude Sonnet 4.5' },
  { id: 'claude-opus-4-5-20251101', label: 'Claude Opus 4.5' },
]

const COPILOT_CATALOG: CatalogEntry[] = [
  { id: 'auto', label: 'Auto' },
  { id: 'claude-sonnet-4.6', label: 'Claude Sonnet 4.6', default: true },
  { id: 'gpt-5.4', label: 'GPT-5.4' },
  { id: 'claude-haiku-4.5', label: 'Claude Haiku 4.5' },
  { id: 'gpt-5.3-codex', label: 'GPT-5.3 Codex' },
  { id: 'gemini-3.1-pro-preview', label: 'Gemini 3.1 Pro' },
  { id: 'gemini-3.5-flash', label: 'Gemini 3.5 Flash' },
]

const CODEX_CATALOG: CatalogEntry[] = [
  { id: 'gpt-5.6-sol', label: 'GPT-5.6 Sol', default: true },
  { id: 'gpt-5.6', label: 'GPT-5.6' },
  { id: 'gpt-5.6-terra', label: 'GPT-5.6 Terra' },
  { id: 'gpt-5.6-luna', label: 'GPT-5.6 Luna' },
  { id: 'gpt-5.5', label: 'GPT-5.5' },
]

const ANTIGRAVITY_CATALOG: CatalogEntry[] = [
  { id: 'gemini-2.5-pro', label: 'Gemini 2.5 Pro', default: true },
  { id: 'gemini-2.5-flash', label: 'Gemini 2.5 Flash' },
]

const CATALOGS: Record<NativeModelFamily, CatalogEntry[]> = {
  cursor: CURSOR_CATALOG,
  claude: CLAUDE_CATALOG,
  copilot: COPILOT_CATALOG,
  codex: CODEX_CATALOG,
  antigravity: ANTIGRAVITY_CATALOG,
}

/** Parse `agent --list-models` / similar CLI stdout into model ids. */
export function parseModelListOutput(stdout: string): string[] {
  const trimmed = stdout.trim()
  if (!trimmed) return []
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) return parseJsonModelIds(trimmed)
  return trimmed
    .split(/\r?\n/)
    .map((line) => line.replace(/^[-*•]\s*/, '').trim())
    .map((line) => line.split(/\s+/)[0] ?? '')
    .map((id) => id.replace(/[,:]$/, ''))
    .filter((id) => id.length > 0 && !id.includes(' ') && !looksLikeHeader(id))
}

export async function listNativeModels(
  family: NativeModelFamily,
  discover?: () => Promise<string[]>,
): Promise<ExternalModel[]> {
  const catalog = CATALOGS[family].map((model) => ({ ...model }))
  let live: string[] = []
  if (discover && process.env.AMAZING_CLI_LLM_DISCOVER !== '0') {
    try {
      live = await discover()
    } catch {
      live = []
    }
  }
  return mergeNativeModels(family, live, catalog)
}

export function mergeNativeModels(
  family: NativeModelFamily,
  liveIds: string[],
  catalog: CatalogEntry[] = CATALOGS[family].map((model) => ({ ...model })),
): ExternalModel[] {
  const byId = new Map<string, { id: string; label: string }>()
  for (const model of catalog) byId.set(model.id, { id: model.id, label: model.label })
  for (const id of liveIds) {
    const trimmed = id.trim()
    if (!trimmed || byId.has(trimmed)) continue
    byId.set(trimmed, { id: trimmed, label: humanizeModelId(trimmed) })
  }
  const preferred = pickDefaultModelId(family, [...byId.keys()])
  return [...byId.values()].map((model) => ({
    id: model.id,
    provider: family,
    label: model.label,
    default: model.id === preferred,
  }))
}

function parseJsonModelIds(raw: string): string[] {
  try {
    const parsed: unknown = JSON.parse(raw)
    if (Array.isArray(parsed)) {
      return parsed
        .map((item) => {
          if (typeof item === 'string') return item
          if (item && typeof item === 'object') {
            const record = item as { id?: unknown; model?: unknown; name?: unknown }
            const id = record.id ?? record.model ?? record.name
            return typeof id === 'string' ? id : ''
          }
          return ''
        })
        .filter((id) => id.length > 0)
    }
    if (parsed && typeof parsed === 'object') {
      const record = parsed as { models?: unknown; data?: unknown }
      const list = Array.isArray(record.models) ? record.models : Array.isArray(record.data) ? record.data : []
      return parseJsonModelIds(JSON.stringify(list))
    }
  } catch {
    return []
  }
  return []
}

function looksLikeHeader(value: string): boolean {
  return /^(available|models?|name|id|#)/i.test(value)
}

function pickDefaultModelId(family: NativeModelFamily, ids: string[]): string {
  const fallback = CATALOGS[family].find((model) => model.default)?.id ?? CATALOGS[family][0].id
  if (family === 'cursor') {
    const grok46 = ids.filter((id) => /grok[-_.]?4\.6/i.test(id))
    const preferred =
      grok46.find((id) => /high$/i.test(id) && !/fast/i.test(id)) ??
      grok46.find((id) => !/fast/i.test(id)) ??
      grok46[0]
    if (preferred) return preferred
  }
  if (family === 'claude') {
    if (ids.includes('sonnet')) return 'sonnet'
    const latestSonnet =
      ids.find((id) => /^claude-sonnet-5/i.test(id)) ?? ids.find((id) => /sonnet/i.test(id) && !/4-5|4\.5/i.test(id))
    if (latestSonnet) return latestSonnet
  }
  if (ids.includes(fallback)) return fallback
  return ids[0] ?? fallback
}

function humanizeModelId(id: string): string {
  return id
    .replace(/^cursor-/, '')
    .replace(/[-_]/g, ' ')
    .replace(/\b\w/g, (char) => char.toUpperCase())
}
