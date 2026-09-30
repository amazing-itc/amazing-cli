import type { Provider } from '../../core/provider.js'
import { listNativeModels } from '../../core/native-models.js'
import { createSpawnProvider } from '../spawn/index.js'
import { loadBundledManifest } from '../spawn/manifest.js'
import { discoverCodexModelIds } from './discover-models.js'
import '../spawn/parsers/codex.js'

export function createCodexProvider(): Provider {
  const provider = createSpawnProvider(loadBundledManifest('codex'))
  return {
    ...provider,
    listModels(secret?: string) {
      return listNativeModels('codex', () => discoverCodexModelIds(secret))
    },
  }
}
