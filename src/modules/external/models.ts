import { fail } from '../../core/errors.js'
import type { ExternalModel } from '../../core/types.js'

export const MODEL_CACHE_MS = 60_000

export type ModelCatalogOpts = {
  baseUrl: string
  masterKey: string
  fetch?: typeof fetch
  now?: () => number
  ttlMs?: number
}

export function createModelCatalog(opts: ModelCatalogOpts) {
  const fetchFn = opts.fetch ?? fetch
  const base = opts.baseUrl.replace(/\/$/, '')
  const ttlMs = opts.ttlMs ?? MODEL_CACHE_MS
  let cache: { at: number; models: ExternalModel[] } | undefined

  async function listModels(): Promise<ExternalModel[]> {
    const now = opts.now?.() ?? Date.now()
    if (cache && now - cache.at < ttlMs) return cache.models
    const models = await load()
    cache = { at: now, models }
    return models
  }

  async function load(): Promise<ExternalModel[]> {
    const headers: Record<string, string> = {}
    if (opts.masterKey) headers.authorization = `Bearer ${opts.masterKey}`
    let modelsRes: Response
    try {
      modelsRes = await fetchFn(`${base}/v1/models`, { method: 'GET', headers })
    } catch (err) {
      throw fail('litellm_unavailable', err instanceof Error ? err.message : 'LiteLLM unreachable')
    }
    if (!modelsRes.ok) {
      throw fail('litellm_unavailable', `LiteLLM /v1/models returned ${modelsRes.status}`)
    }
    const modelsJson: unknown = await modelsRes.json().catch(() => {
      throw fail('litellm_unavailable', 'LiteLLM /v1/models returned invalid JSON')
    })

    let infoJson: unknown
    try {
      const infoRes = await fetchFn(`${base}/model/info`, { method: 'GET', headers })
      if (infoRes.ok) infoJson = await infoRes.json().catch(() => undefined)
    } catch {
      /* /model/info is best-effort */
    }

    return normalizeModels(modelsJson, infoJson)
  }

  return { listModels }
}

export function normalizeModels(modelsJson: unknown, infoJson: unknown): ExternalModel[] {
  const listed = rowsOf(modelsJson)
  const infos = rowsOf(infoJson)
  const infoByName = new Map<string, Record<string, unknown>>()
  for (const row of infos) {
    const name = str(row.model_name) ?? str(row.id)
    if (name) infoByName.set(name, row)
  }

  const source = listed.length > 0 ? listed : infos
  const seen = new Set<string>()
  const out: ExternalModel[] = []
  for (const row of source) {
    const id = str(row.id) ?? str(row.model_name)
    if (!id || seen.has(id)) continue
    seen.add(id)
    out.push(toExternalModel(id, row, infoByName.get(id)))
  }
  return out
}

function toExternalModel(
  id: string,
  listed: Record<string, unknown>,
  infoRow: Record<string, unknown> | undefined,
): ExternalModel {
  const params = record(infoRow?.litellm_params) ?? record(listed.litellm_params)
  const info = record(infoRow?.model_info) ?? record(listed.model_info) ?? {}
  const model: ExternalModel = { id }
  const provider = str(listed.owned_by) ?? str(params?.custom_llm_provider) ?? str(info.provider)
  if (provider) model.provider = provider
  const mode = str(info.mode) ?? str(listed.mode)
  if (mode) model.mode = mode
  const maxInputTokens = num(info.max_input_tokens) ?? num(info.max_tokens)
  if (maxInputTokens !== undefined) model.maxInputTokens = maxInputTokens
  const input = num(info.input_cost_per_token)
  const output = num(info.output_cost_per_token)
  if (input !== undefined || output !== undefined) {
    model.pricing = { ...(input !== undefined && { input }), ...(output !== undefined && { output }) }
  }
  return model
}

function rowsOf(json: unknown): Record<string, unknown>[] {
  if (Array.isArray(json)) return json.filter(isRecord)
  if (isRecord(json) && Array.isArray(json.data)) return json.data.filter(isRecord)
  return []
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v)
}

function record(v: unknown): Record<string, unknown> | undefined {
  return isRecord(v) ? v : undefined
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined
}

function num(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined
}
