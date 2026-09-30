import { childEnv, requireSecret } from '../../core/credential.js'
import { withNativeMcp } from '../../core/native-mcp.js'
import { listNativeModels, type NativeModelFamily } from '../../core/native-models.js'
import type { ProviderManifest } from '../../core/provider-manifest.js'
import type { Capabilities, Provider, StartInput, StartResult } from '../../core/provider.js'
import { findOnPath, spawnCli, type SpawnCliResult } from '../../core/spawn.js'
import type { EventType, Family, RunRecord, Usage } from '../../core/types.js'
import { expandArgv, type ArgvContext } from './argv.js'

export interface SpawnCommand {
  command: string
  indexJs?: string | null
}

export interface SpawnParser {
  createState(run: RunRecord): object
  onLine(line: string, emit: (type: EventType, data: unknown) => void, state: object, run: RunRecord): void
  sessionRef(state: object): string | undefined
  usage(state: object): Usage | undefined
  failure?(state: object): { code: 'internal'; message: string } | undefined
  beforeSpawn?(input: StartInput): Promise<void>
  resolveCommand?(manifest: ProviderManifest): SpawnCommand
  argvContext?(input: StartInput, command: SpawnCommand): Partial<ArgvContext>
  permissions?(manifest: ProviderManifest): string[]
  binary?(manifest: ProviderManifest): string
  health?(): Promise<{ available: boolean; detail?: string }>
  onStderr?(line: string, emit: (type: EventType, data: unknown) => void): void
  /** `cursor` fails only on a non-zero exit. `antigravity` also fails on `spawn_failed`. `strict` fails on any spawn error or non-zero exit. */
  exit?: 'cursor' | 'strict' | 'antigravity'
  notFoundMessage?: string
  exitMessage?(spawned: SpawnCliResult): string
  omitUndefined?: boolean
}

const parsers = new Map<string, SpawnParser>()

/** Registers the stdout parser and the few family hooks a template cannot express. */
export function defineSpawnParser(name: string, parser: SpawnParser): void {
  parsers.set(name, parser)
}

/**
 * One provider for every `kind: spawn` manifest.
 * Argv comes from the template. The parser is the one registered under `manifest.parser`.
 */
export function createSpawnProvider(manifest: ProviderManifest): Provider {
  const parserName = manifest.parser
  if (!parserName) throw new Error(`spawn manifest ${manifest.file} has no parser`)
  const parser = parsers.get(parserName)
  if (!parser) throw new Error(`unknown parser "${parserName}" (${manifest.file})`)
  const family = manifest.family as Family

  return {
    capabilities(): Capabilities {
      return {
        family,
        streaming: manifest.capabilities.streaming,
        resume: manifest.capabilities.resume,
        models: manifest.models.source,
        permissions: parser.permissions?.(manifest) ?? manifest.permissions ?? [],
        binary: parser.binary?.(manifest) ?? manifest.binary,
      }
    },
    listModels() {
      return listNativeModels(family as NativeModelFamily)
    },
    async health() {
      if (parser.health) return parser.health()
      return findOnPath(manifest.binary ?? '') ? { available: true } : { available: false, detail: 'cli_not_found' }
    },
    async start(input: StartInput): Promise<StartResult> {
      requireSecret(family, input.credentialSecret, manifest.credentialEnv)
      const runTurn = async (extraArgs: string[]): Promise<StartResult> => {
        if (parser.beforeSpawn) await parser.beforeSpawn(input)
        const env = childEnv({
          family,
          credentialEnv: manifest.credentialEnv,
          secret: input.credentialSecret,
          homeDir: input.homeDir,
        })
        const command = parser.resolveCommand?.(manifest) ?? { command: manifest.binary ?? '' }
        const args = [
          ...expandArgv(manifest, {
            prompt: input.run.prompt,
            workspace: input.workspaceDir,
            model: input.run.modelId,
            resume: input.run.sessionRef,
            mode: input.run.mode,
            ...parser.argvContext?.(input, command),
          }),
          ...extraArgs,
        ]
        const state = parser.createState(input.run)
        const spawned = await spawnCli({
          command: command.command,
          args,
          cwd: input.workspaceDir,
          env,
          signal: input.signal,
          onLine: (line) => parser.onLine(line, input.emit, state, input.run),
          onStderr: (line) => {
            if (parser.onStderr) parser.onStderr(line, input.emit)
            else input.emit('log/line', { level: 'warn', text: line })
          },
        })
        return mapResult(parser, input, spawned, state)
      }
      if (manifest.capabilities.mcp) return withNativeMcp(family, input, runTurn)
      return runTurn([])
    },
  }
}

function mapResult(parser: SpawnParser, input: StartInput, spawned: SpawnCliResult, state: object): StartResult {
  if (spawned.error === 'cli_not_found') {
    return { status: 'FAILED', error: { code: 'cli_not_found', message: spawned.detail ?? parser.notFoundMessage ?? 'CLI not found' } }
  }
  if (input.signal.aborted) return { status: 'CANCELLED' }
  const failure = parser.failure?.(state)
  if (failure) return { status: 'FAILED', error: failure, sessionRef: parser.sessionRef(state) }
  if (exitFailed(parser.exit ?? 'strict', spawned)) {
    return {
      status: 'FAILED',
      error: { code: 'internal', message: parser.exitMessage?.(spawned) ?? spawned.detail ?? `exited ${spawned.code}` },
    }
  }
  const sessionRef = parser.sessionRef(state)
  const usage = parser.usage(state)
  if (parser.omitUndefined) {
    const result: StartResult = { status: 'SUCCEEDED' }
    if (sessionRef !== undefined) result.sessionRef = sessionRef
    if (usage !== undefined) result.usage = usage
    return result
  }
  return { status: 'SUCCEEDED', sessionRef, usage }
}

function exitFailed(exit: NonNullable<SpawnParser['exit']>, spawned: SpawnCliResult): boolean {
  if (exit === 'cursor') return spawned.code !== 0
  if (exit === 'antigravity') return spawned.error === 'spawn_failed' || (spawned.code !== 0 && spawned.code !== null)
  return Boolean(spawned.error) || spawned.code !== 0
}
