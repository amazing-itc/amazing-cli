import { existsSync, readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { findOnPath } from '../../core/spawn.js'

const VERSION_DIR = /^\d{4}\.\d{1,2}\.\d{1,2}-/

export interface CursorInvoke {
  command: string
  indexJs: string | null
  versionDir: string | null
}

/** HOME='' isolates lookup from the real install; unset HOME falls back to os.homedir(). */
function lookupHome(): string | undefined {
  if (Object.hasOwn(process.env, 'HOME')) return process.env.HOME || undefined
  return homedir()
}

function latestVersionDir(root: string): string | null {
  if (!root || !existsSync(root)) return null
  const entries = readdirSync(root)
    .filter((name) => VERSION_DIR.test(name))
    .map((name) => {
      const dir = join(root, name)
      try {
        return { dir, mtime: statSync(dir).mtimeMs }
      } catch {
        return null
      }
    })
    .filter((item): item is { dir: string; mtime: number } => item !== null)
    .sort((left, right) => right.mtime - left.mtime)
  return entries[0]?.dir ?? null
}

export function resolveCursorInvoke(): CursorInvoke {
  const home = lookupHome()
  const roots = [
    process.env.CURSOR_AGENT_VERSIONS_ROOT,
    home ? join(home, '.local/share/cursor-agent/versions') : undefined,
    home ? join(home, '.cursor-agent/versions') : undefined,
  ].filter((root): root is string => Boolean(root))
  for (const root of roots) {
    const latest = latestVersionDir(root)
    if (!latest) continue
    const node = existsSync(join(latest, 'node')) ? join(latest, 'node') : null
    const indexJs = existsSync(join(latest, 'index.js')) ? join(latest, 'index.js') : null
    if (node && indexJs) return { command: node, indexJs, versionDir: latest }
  }
  const pathBins = [
    ...(home ? [join(home, '.local/bin/agent'), join(home, '.local/bin/cursor-agent')] : []),
    '/usr/local/bin/agent',
    'agent',
  ]
  for (const command of pathBins) {
    if (command === 'agent' || existsSync(command)) return { command, indexJs: null, versionDir: null }
  }
  return { command: 'agent', indexJs: null, versionDir: null }
}

/** Absolute/relative file, or a PATH entry named `command` (which-style). */
export function cursorBinaryAvailable(command: string): boolean {
  if (!command) return false
  if (command.includes('/') || command.includes('\\')) return existsSync(command)
  return findOnPath(command) || existsSync(command)
}
