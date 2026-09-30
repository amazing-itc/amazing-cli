import { copyFileSync, existsSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { RunFailure } from '../../core/errors.js'
import { assertRunId } from '../../core/ids.js'
import type { ProviderManifest } from '../../core/provider-manifest.js'
import type { Capabilities, Provider, StartInput, StartResult } from '../../core/provider.js'
import { loadBundledManifest } from '../spawn/manifest.js'
import { createSessionStore, sessionFileForHome } from '../../core/session-store.js'
import type { SessionEvent } from '../../core/session-store.js'
import { isAbortError } from './retry.js'
import { createLiteLlmClient } from './litellm-client.js'
import { runHarness } from './runtime/loop.js'
import { restoreSession } from './runtime/session.js'
import { toolsForMode } from './runtime/tools.js'
import { connectMcpServers } from './mcp-client.js'
import { createModelCatalog } from './models.js'

const DEFAULT_BASE = 'http://litellm:4000'
const HEALTH_TIMEOUT_MS = 2000

export type ExternalProviderOpts = {
  litellmBaseUrl?: string
  masterKey?: string
  fetch?: typeof fetch
  runDirFor?: (runId: string) => string
  now?: () => number
  /** Defaults to the bundled `providers/external.yaml`. */
  manifest?: ProviderManifest
}

export function createExternalProvider(opts: ExternalProviderOpts = {}): Provider {
  const fetchFn = opts.fetch ?? fetch
  const baseUrl = (opts.litellmBaseUrl ?? process.env.LITELLM_BASE_URL ?? DEFAULT_BASE).replace(/\/$/, '')
  const masterKey = opts.masterKey ?? process.env.LITELLM_MASTER_KEY ?? ''
  const models = createModelCatalog({ baseUrl, masterKey, fetch: fetchFn, now: opts.now })
  const manifest = opts.manifest ?? loadBundledManifest('external')

  return {
    capabilities(): Capabilities {
      return {
        family: 'external',
        streaming: manifest.capabilities.streaming,
        resume: manifest.capabilities.resume,
        models: manifest.models.source,
        permissions: manifest.permissions ?? [],
      }
    },

    async health() {
      const headers: Record<string, string> = {}
      if (masterKey) headers.authorization = `Bearer ${masterKey}`
      for (const path of ['/health', '/v1/models'] as const) {
        const ac = new AbortController()
        const timer = setTimeout(() => ac.abort(), HEALTH_TIMEOUT_MS)
        try {
          const res = await fetchFn(`${baseUrl}${path}`, { method: 'GET', headers, signal: ac.signal })
          if (res.ok) return { available: true }
        } catch {
          /* try the next probe */
        } finally {
          clearTimeout(timer)
        }
      }
      return { available: false }
    },

    listModels: () => models.listModels(),

    async start(input: StartInput): Promise<StartResult> {
      const { run, workspaceDir, homeDir, signal, emit } = input
      if (signal.aborted) return { status: 'CANCELLED' }
      if (!run.modelId) {
        return { status: 'FAILED', error: { code: 'model_not_found', message: 'modelId is required for family external' } }
      }

      const sessionRef = run.sessionRef ?? run.id
      if (run.sessionRef !== undefined) assertRunId(run.sessionRef)
      const store = createSessionStore(resolveSessionFile(homeDir, sessionRef, run.id, opts.runDirFor))
      emit('system/init', { sessionRef, model: run.modelId })

      const client = createLiteLlmClient({
        baseUrl,
        masterKey,
        fetch: fetchFn,
        onRetry: (info) => emit('llm/retry', info),
      })

      const existing = store.read()
      const persist = (event: SessionEvent) => store.append(event)
      const session = existing.length
        ? restoreSession({
            events: existing,
            messages: store.rebuild(),
            workspacePath: workspaceDir,
            persist,
          })
        : undefined

      const servers = input.mcpServers?.length ? input.mcpServers : undefined
      let mcp: Awaited<ReturnType<typeof connectMcpServers>> | undefined
      try {
        mcp = servers ? await connectMcpServers(servers) : undefined
        const baseTools = toolsForMode(run.mode)
        const tools = mcp ? [...baseTools, ...mcp.schemas] : baseTools
        const mcpSession = mcp
        const result = await runHarness({
          model: run.modelId,
          prompt: run.prompt,
          workspacePath: workspaceDir,
          mode: run.mode,
          signal,
          session,
          persist: session ? undefined : persist,
          emit,
          tools,
          exclusiveTools: mcpSession?.exclusive,
          callMcp: mcpSession ? (name, args) => mcpSession.callTool(name, args) : undefined,
          complete: async (model, messages, extra) => {
            let streamed = false
            const result = await client.complete({
              model,
              messages,
              tools,
              signal: extra.signal ?? signal,
              onDelta: (text) => {
                if (text) streamed = true
                emit('assistant/delta', { text })
              },
            })
            return { ...result, streamed }
          },
        })
        if (signal.aborted) return { status: 'CANCELLED', sessionRef }
        if (!result.ok) {
          return { status: 'FAILED', sessionRef, error: { code: 'internal', message: result.text } }
        }
        return { status: 'SUCCEEDED', sessionRef, usage: result.usage }
      } catch (err) {
        if (isAbortError(err) || signal.aborted) return { status: 'CANCELLED', sessionRef }
        if (err instanceof RunFailure) return { status: 'FAILED', sessionRef, error: err.error }
        return {
          status: 'FAILED',
          sessionRef,
          error: { code: 'internal', message: err instanceof Error ? err.message : String(err) },
        }
      } finally {
        await mcp?.close()
      }
    },
  }
}

function resolveSessionFile(
  homeDir: string,
  sessionRef: string,
  runId: string,
  runDirFor?: (runId: string) => string,
): string {
  const current = sessionFileForHome(homeDir)
  if (existsSync(current)) return current
  if (sessionRef !== runId) {
    const other = runDirFor
      ? join(runDirFor(sessionRef), 'session.jsonl')
      : join(dirname(dirname(homeDir)), sessionRef, 'session.jsonl')
    if (existsSync(other)) {
      mkdirSync(dirname(current), { recursive: true })
      copyFileSync(other, current)
    }
  }
  return current
}
