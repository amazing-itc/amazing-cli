import type { EventType, ExternalModel, Family, RunError, RunRecord, Usage } from './types.js'

export interface Capabilities {
  family: Family
  streaming: boolean
  resume: boolean
  models: 'static' | 'remote' | 'none'
  permissions: string[]
  binary?: string
}

export interface StartInput {
  run: RunRecord
  workspaceDir: string
  homeDir: string
  credentialSecret?: string
  /** In-memory only. Never persisted on RunRecord / meta.json. */
  mcpServers?: Array<{ name: string; url: string; headers?: Record<string, string> }>
  /** False hides workspace MCP files for this run. Omitted keeps them. Never persisted. */
  inheritProjectMcp?: boolean
  signal: AbortSignal
  emit: (type: EventType, data: unknown) => void
}

export interface StartResult {
  status: 'SUCCEEDED' | 'FAILED' | 'CANCELLED'
  sessionRef?: string
  error?: RunError
  usage?: Usage
}

export interface Provider {
  capabilities(): Capabilities
  health(): Promise<{ available: boolean; detail?: string }>
  /**
   * Runs one turn. Providers emit only provider-level events
   * (`system/init`, `assistant/*`, `tool/*`, `log/line`, `llm/retry`, `compaction`).
   * Lifecycle events (`run/queued`, `run/started`, `run/finished`) are emitted by the core dispatcher.
   * When `input.signal` aborts, resolve with `{ status: 'CANCELLED' }` promptly.
   */
  start(input: StartInput): Promise<StartResult>
  listModels?(secret?: string): Promise<ExternalModel[]>
  verify?(secret: string, homeDir: string): Promise<{ valid: boolean | null; detail?: string }>
}
