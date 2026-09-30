import type { ContextUsage } from './context-manifest.js'

export type Family = 'cursor' | 'claude' | 'codex' | 'copilot' | 'antigravity' | 'external' | 'fake'

export type RunStatus = 'QUEUED' | 'RUNNING' | 'SUCCEEDED' | 'FAILED' | 'CANCELLED'

export type SessionStatus = 'IDLE' | 'BUSY' | 'CLOSED'

export type WindowPolicy = 'persistent' | 'ephemeral'

export type ErrorCode =
  | 'unauthorized'
  | 'validation'
  | 'workspace_out_of_root'
  | 'credential_missing'
  | 'credential_invalid'
  | 'cli_not_found'
  | 'model_not_found'
  | 'litellm_unavailable'
  | 'timeout'
  | 'interrupted'
  | 'cancelled'
  | 'duplicate_run'
  | 'session_busy'
  | 'duplicate_session'
  | 'session_closed'
  | 'unsupported'
  | 'not_found'
  | 'internal'

export interface RunError {
  code: ErrorCode
  message: string
}

export interface Usage {
  inputTokens?: number
  outputTokens?: number
  costUsd?: number
}

export type RunMode = 'ask' | 'plan' | 'agent'

export type AttachmentKind = 'image' | 'file' | 'folder'

export interface RunAttachment {
  kind: AttachmentKind
  path: string
  name: string
}

/** Body of `POST /v1/runs`. */
export interface RunRequest {
  runId: string
  family: Family
  prompt: string
  modelId?: string
  mode?: RunMode
  attachments?: RunAttachment[]
  workspace: { product: string; path: string }
  /** Never persisted. */
  credential?: { secret: string }
  sessionRef?: string
  /** Turn of an existing session. Absent ⇒ the dispatcher creates an ephemeral session for this run. */
  sessionId?: string
  /**
   * When false, native CLIs do not load MCP servers from the workspace for this run.
   * Omitted means the workspace MCP config stays visible. Never persisted.
   */
  inheritProjectMcp?: boolean
  mcpServers?: Array<{ name: string; url: string; headers?: Record<string, string> }>
  timeoutSec?: number
  meta?: Record<string, string>
}

/** Persisted as `meta.json` per run. */
export interface RunRecord {
  id: string
  product: string
  family: Family
  status: RunStatus
  modelId?: string
  mode?: RunMode
  attachments?: RunAttachment[]
  workspaceDir: string
  prompt: string
  createdAt: string
  startedAt?: string
  finishedAt?: string
  sessionRef?: string
  sessionId?: string
  lastSeq: number
  error?: RunError
  usage?: Usage
  meta?: Record<string, string>
}

export interface SessionPolicy {
  window: WindowPolicy
  compaction?: { auto: boolean; thresholdRatio?: number; retainRatio?: number }
}

/** Persisted as `sessions/{id}/meta.json`. */
export interface Session {
  id: string
  product: string
  family: Family
  status: SessionStatus
  workspaceDir: string
  modelId?: string
  mode?: RunMode
  policy: SessionPolicy
  /** Ref the CLI/harness hands back for resuming (`--resume`, thread id, ...). */
  providerSessionRef?: string
  lastTurnId?: string
  turnCount: number
  context?: ContextUsage
  usage?: Usage
  createdAt: string
  lastActivityAt: string
  closedAt?: string
  meta?: Record<string, string>
}

export type CreateSessionInput = Pick<Session, 'id' | 'product' | 'family' | 'workspaceDir' | 'modelId' | 'mode' | 'policy' | 'providerSessionRef' | 'meta'>

export type EventType =
  | 'run/queued'
  | 'run/started'
  | 'context/usage'
  | 'system/init'
  | 'assistant/delta'
  | 'assistant/message'
  | 'assistant/thinking'
  | 'tool/call'
  | 'tool/result'
  | 'log/line'
  | 'llm/retry'
  | 'compaction'
  /** Provider handed back a ref different from the one stored on the session. Lives in the session log, not the run log. */
  | 'session/ref-changed'
  | 'run/finished'

export interface RunEvent {
  /** `${runId}:${seq}` */
  id: string
  runId: string
  seq: number
  at: string
  type: EventType
  data: unknown
}

export interface ExternalModel {
  id: string
  provider?: string
  label?: string
  default?: boolean
  mode?: string
  maxInputTokens?: number
  pricing?: { input?: number; output?: number }
}
