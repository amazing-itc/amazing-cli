import { fail } from './errors.js'
import type { ProviderManifest } from './provider-manifest.js'

/** What a turn asks of the family. Absent fields are not a requirement. */
export interface TurnCapabilityInput {
  mode?: string
  attachments?: Array<{ kind: string }>
  sessionRef?: string
  mcpServers?: readonly unknown[]
}

/** What creating a session asks of the family. */
export interface SessionCapabilityInput {
  mode?: string
  policy?: { compaction?: unknown }
}

/**
 * Refuses a turn that needs a capability the manifest does not declare.
 * An omitted field is not a requirement: the provider keeps its own default.
 */
export function assertTurn(manifest: ProviderManifest, req: TurnCapabilityInput): void {
  const family = manifest.family
  const caps = manifest.capabilities
  if (req.mode !== undefined && !caps.modes.includes(req.mode)) {
    throw fail('unsupported', `mode "${req.mode}" is not in family "${family}" capabilities.modes`)
  }
  for (const attachment of req.attachments ?? []) {
    if (!caps.attachments.includes(attachment.kind as 'image' | 'file' | 'folder')) {
      throw fail('unsupported', `attachment "${attachment.kind}" is not in family "${family}" capabilities.attachments`)
    }
  }
  if (req.sessionRef !== undefined && !caps.resume) {
    throw fail('unsupported', `resume is not in family "${family}" capabilities`)
  }
  if ((req.mcpServers?.length ?? 0) > 0 && !caps.mcp) {
    throw fail('unsupported', `mcp is not in family "${family}" capabilities`)
  }
}

/** Refuses a session whose mode or compaction policy the manifest does not allow. */
export function assertSession(manifest: ProviderManifest, input: SessionCapabilityInput): void {
  const family = manifest.family
  const caps = manifest.capabilities
  if (input.mode !== undefined && !caps.modes.includes(input.mode)) {
    throw fail('unsupported', `mode "${input.mode}" is not in family "${family}" capabilities.modes`)
  }
  if (input.policy?.compaction !== undefined && caps.compaction !== 'controllable') {
    throw fail('unsupported', `compaction is not controllable for family "${family}"`)
  }
}

/** `POST /compact` is only for families that declare compaction controllable. */
export function assertCompact(manifest: ProviderManifest): void {
  if (manifest.capabilities.compaction !== 'controllable') {
    throw fail('unsupported', `compaction is not controllable for family "${manifest.family}"`)
  }
}
