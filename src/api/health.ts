/** LiteLLM reachability probe for `GET /health`. Omitted when `LITELLM_BASE_URL` is unset (dev without compose). */

export type HealthStatus = { available: boolean; detail?: string }
export type HealthProbe = () => Promise<HealthStatus>

export const HEALTH_TIMEOUT_MS = 2000

export function createLiteLlmHealth(env: NodeJS.ProcessEnv = process.env, fetchFn: typeof fetch = fetch): HealthProbe | undefined {
  const baseUrl = env.LITELLM_BASE_URL?.trim()
  if (!baseUrl) return undefined
  const masterKey = env.LITELLM_MASTER_KEY?.trim() ?? ''
  const base = baseUrl.replace(/\/$/, '')
  return () => probeLiteLlm(base, masterKey, fetchFn)
}

export async function probeLiteLlm(baseUrl: string, masterKey: string, fetchFn: typeof fetch = fetch): Promise<HealthStatus> {
  const headers: Record<string, string> = {}
  if (masterKey) headers.authorization = `Bearer ${masterKey}`
  for (const path of ['/health', '/v1/models'] as const) {
    try {
      const res = await fetchFn(`${baseUrl}${path}`, { method: 'GET', headers, signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS) })
      if (res.ok) return { available: true }
    } catch {
      /* try the next probe */
    }
  }
  return { available: false }
}
