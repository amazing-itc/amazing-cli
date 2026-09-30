import type { Provider } from '../../core/provider.js'
import { createSpawnProvider } from '../spawn/index.js'
import { loadBundledManifest } from '../spawn/manifest.js'
import '../spawn/parsers/copilot.js'

export function createCopilotProvider(): Provider {
  return createSpawnProvider(loadBundledManifest('copilot'))
}
