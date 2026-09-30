import type { Provider } from '../../core/provider.js'
import { listNativeModels } from '../../core/native-models.js'
import { createSpawnProvider, defineSpawnParser } from '../spawn/index.js'
import { loadBundledManifest } from '../spawn/manifest.js'
import { ingestCursorLine, type CursorStreamState } from './events.js'
import { discoverCursorModelIds } from './discover-models.js'
import { cursorBinaryAvailable, resolveCursorInvoke } from './spawn.js'

export { resolveCursorInvoke } from './spawn.js'

defineSpawnParser('cursor', {
  createState: () => ({ fullText: '' }),
  onLine(line, emit, state) {
    const event = ingestCursorLine(line, state as CursorStreamState)
    if (event) emit(event.type, event.data)
  },
  sessionRef: (state) => (state as CursorStreamState).sessionRef,
  usage: (state) => (state as CursorStreamState).usage,
  resolveCommand: () => {
    const invoke = resolveCursorInvoke()
    return { command: invoke.command, indexJs: invoke.indexJs }
  },
  argvContext: (input, command) => ({
    indexJs: command.indexJs,
    approveMcps: input.inheritProjectMcp !== false,
  }),
  binary: () => resolveCursorInvoke().command,
  health: async () => {
    const command = resolveCursorInvoke().command
    return cursorBinaryAvailable(command) ? { available: true } : { available: false, detail: 'cli_not_found' }
  },
  exit: 'cursor',
  notFoundMessage: 'cursor CLI not found',
  exitMessage: (spawned) => spawned.detail ?? `cursor CLI exited ${spawned.code ?? spawned.signal ?? 'unknown'}`,
})

export function createCursorProvider(): Provider {
  const provider = createSpawnProvider(loadBundledManifest('cursor'))
  return {
    ...provider,
    listModels(secret?: string) {
      return listNativeModels('cursor', () => discoverCursorModelIds(secret))
    },
  }
}
