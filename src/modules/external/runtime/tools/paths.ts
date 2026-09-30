import { realpathSync } from 'node:fs'
import { dirname, resolve } from 'node:path'

export function resolveInsideWorkspace(workspacePath: string, relative: string): string {
  if (!workspacePath?.trim()) {
    throw new Error('fs: workspacePath is required')
  }
  const root = resolve(workspacePath)
  const target = resolve(root, relative ?? '')
  let rootReal = root
  try {
    rootReal = realpathSync(root)
  } catch {
    rootReal = root
  }
  let check = target
  try {
    check = realpathSync(target)
  } catch {
    check = resolve(dirname(target))
    try {
      check = realpathSync(check)
    } catch {
      check = dirname(target)
    }
    const next = resolve(check, target.slice(dirname(target).length).replace(/^[/\\]/, '') || '')
    if (!isInside(rootReal, dirname(next)) && dirname(next) !== rootReal) {
      throw new Error(`fs: path escapes workspace (${relative})`)
    }
    return target
  }
  if (!isInside(rootReal, check) && check !== rootReal) {
    throw new Error(`fs: path escapes workspace (${relative})`)
  }
  return target
}

function isInside(root: string, candidate: string): boolean {
  const prefix = root.endsWith('/') || root.endsWith('\\') ? root : `${root}/`
  return candidate === root || candidate.startsWith(prefix) || candidate.startsWith(`${root}\\`)
}
