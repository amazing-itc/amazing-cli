// Provider registry. This is the ONLY file allowed to import from multiple
// `src/modules/<family>/` directories (enforced by scripts/check-boundaries.mjs).
import type { ProviderManifest } from '../core/provider-manifest.js'
import type { Provider } from '../core/provider.js'
import type { Family } from '../core/types.js'
import { createAntigravityProvider } from './antigravity/index.js'
import { createClaudeProvider } from './claude/index.js'
import { createCodexProvider } from './codex/index.js'
import { createCopilotProvider } from './copilot/index.js'
import { createCursorProvider } from './cursor/index.js'
import { createExternalProvider } from './external/index.js'
import { createFakeProvider } from './fake/index.js'
import { createSpawnProvider } from './spawn/index.js'

const SPAWN_FACTORIES: Record<string, () => Provider> = {
  cursor: createCursorProvider,
  claude: createClaudeProvider,
  codex: createCodexProvider,
  copilot: createCopilotProvider,
  antigravity: createAntigravityProvider,
}

export function createProviderRegistry(opts: {
  manifests: readonly ProviderManifest[]
  enableFake: boolean
  /** Adds fake beside the real families. Ignored when enableFake replaces the registry. */
  registerFake?: boolean
  litellmBaseUrl?: string
  litellmMasterKey?: string
}): Map<Family, Provider> {
  const registry = new Map<Family, Provider>()
  if (opts.enableFake) {
    const fake = opts.manifests.find((manifest) => manifest.kind === 'fake')
    if (!fake) throw new Error('AMAZING_CLI_ENABLE_FAKE requires a manifest with kind: fake')
    registry.set(fake.family as Family, createFakeProvider(fake))
    return registry
  }
  for (const manifest of opts.manifests) {
    if (manifest.kind === 'spawn') {
      const factory = SPAWN_FACTORIES[manifest.family]
      registry.set(manifest.family as Family, factory ? factory() : createSpawnProvider(manifest))
    } else if (manifest.kind === 'harness') {
      if (manifest.family !== 'external') {
        throw new Error(`kind harness is only implemented for family "external" (${manifest.file})`)
      }
      registry.set('external', createExternalProvider({
        litellmBaseUrl: opts.litellmBaseUrl,
        masterKey: opts.litellmMasterKey,
        manifest,
      }))
    } else if (manifest.kind === 'fake' && opts.registerFake) {
      registry.set(manifest.family as Family, createFakeProvider(manifest))
    }
  }
  return registry
}
