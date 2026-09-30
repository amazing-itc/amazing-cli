import type { Provider } from '../../core/provider.js'
import { createSpawnProvider } from '../spawn/index.js'
import { loadBundledManifest } from '../spawn/manifest.js'
import '../spawn/parsers/claude.js'

export function createClaudeProvider(): Provider {
  return createSpawnProvider(loadBundledManifest('claude'))
}
