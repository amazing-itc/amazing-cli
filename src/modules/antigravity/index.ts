import type { Provider } from '../../core/provider.js'
import { createSpawnProvider } from '../spawn/index.js'
import { loadBundledManifest } from '../spawn/manifest.js'
import '../spawn/parsers/antigravity.js'

export function createAntigravityProvider(): Provider {
  return createSpawnProvider(loadBundledManifest('antigravity'))
}
