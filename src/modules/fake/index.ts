import type { ProviderManifest } from '../../core/provider-manifest.js'
import type { Capabilities, Provider, StartInput, StartResult } from '../../core/provider.js'
import type { ExternalModel } from '../../core/types.js'
import { loadBundledManifest } from '../spawn/manifest.js'

const DELTAS = ['Hello', ' from', ' fake']
const DELAY_MS = 5
const FAKE_MODELS: ExternalModel[] = [{ id: 'fake-model', label: 'Fake', default: true }]

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve()
    const timer = setTimeout(done, ms)
    signal.addEventListener('abort', done, { once: true })
    function done() {
      clearTimeout(timer)
      signal.removeEventListener('abort', done)
      resolve()
    }
  })
}

function untilAborted(signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve()
    signal.addEventListener('abort', () => resolve(), { once: true })
  })
}

export function createFakeProvider(manifest: ProviderManifest = loadBundledManifest('fake')): Provider {
  return {
    capabilities(): Capabilities {
      return {
        family: 'fake',
        streaming: manifest.capabilities.streaming,
        resume: manifest.capabilities.resume,
        models: manifest.models.source,
        permissions: manifest.permissions ?? [],
        binary: undefined,
      }
    },
    listModels() {
      return Promise.resolve(FAKE_MODELS)
    },
    async health() {
      return { available: true }
    },
    async start(input: StartInput): Promise<StartResult> {
      const { run, signal, emit } = input
      const sessionRef = `fake-${run.id}`
      emit('system/init', { sessionRef, model: run.modelId ?? 'fake-model' })

      if (run.prompt === 'fail') {
        return { status: 'FAILED', error: { code: 'internal', message: 'fake failure' } }
      }
      if (run.prompt === 'hang') {
        await untilAborted(signal)
        return { status: 'CANCELLED' }
      }

      for (const text of DELTAS) {
        await sleep(DELAY_MS, signal)
        if (signal.aborted) return { status: 'CANCELLED' }
        emit('assistant/delta', { text })
      }
      emit('tool/call', { name: 'echo', args: {} })
      emit('tool/result', { name: 'echo', content: 'ok' })
      emit('assistant/message', { text: DELTAS.join('') })
      return { status: 'SUCCEEDED', sessionRef, usage: { inputTokens: 10, outputTokens: 20 } }
    },
  }
}
