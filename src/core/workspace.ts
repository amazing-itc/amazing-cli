import { realpath, stat } from 'node:fs/promises'
import path from 'node:path'
import { fail } from './errors.js'

/** Parses optional `AMAZING_CLI_WORKSPACE_ROOTS="<product>=<absolute path>,..."`. */
export function parseWorkspaceRoots(env: string | undefined): Map<string, string> {
  const roots = new Map<string, string>()
  if (env === undefined || env.trim() === '') return roots
  for (const rawEntry of env.split(',')) {
    const entry = rawEntry.trim()
    if (entry === '') continue
    const eq = entry.indexOf('=')
    const product = eq < 0 ? '' : entry.slice(0, eq).trim()
    const root = eq < 0 ? '' : entry.slice(eq + 1).trim()
    if (product === '' || root === '') throw fail('validation', `workspace root entry "${entry}" must be "<product>=<absolute path>"`)
    if (!path.isAbsolute(root)) throw fail('validation', `workspace root for "${product}" must be an absolute path`)
    if (roots.has(product)) throw fail('validation', `workspace root for "${product}" is defined twice`)
    roots.set(product, root)
  }
  return roots
}

export interface WorkspaceResolver {
  /**
   * Absolute `workspace.path`: use that directory if it exists (no product root required).
   * Relative path: resolve under the product root when one is configured.
   * Never creates anything.
   */
  resolve(product: string, relPath: string): Promise<string>
}

async function realDir(p: string): Promise<string | undefined> {
  try {
    const real = await realpath(p)
    return (await stat(real)).isDirectory() ? real : undefined
  } catch {
    return undefined
  }
}

/** Absolute parent, or unset. Relative `workspace.path` for an id not in `roots` uses `{parent}/{product}`. */
export function parseWorkspacesRoot(env: string | undefined): string | undefined {
  const parent = env?.trim() ?? ''
  if (parent === '') return undefined
  if (!path.isAbsolute(parent)) throw fail('validation', 'AMAZING_CLI_WORKSPACES_ROOT must be an absolute path')
  return parent
}

function isSafeProductFolder(product: string): boolean {
  return product !== '' && product !== '.' && product !== '..' && !/[\\/]/.test(product)
}

export function createWorkspaceResolver(roots: Map<string, string>, parentRoot?: string): WorkspaceResolver {
  const parent = parentRoot?.trim() ?? ''
  return {
    async resolve(product, relPath) {
      if (typeof relPath !== 'string' || relPath.trim() === '') {
        throw fail('validation', 'workspace.path must be a non-empty string')
      }
      const trimmed = relPath.trim()

      if (path.isAbsolute(trimmed)) {
        const target = await realDir(trimmed)
        if (target === undefined) {
          throw fail('workspace_out_of_root', `workspace path "${relPath}" is not an existing directory`)
        }
        return target
      }

      const mapped = roots.get(product)
      let root = mapped
      if (root === undefined && parent !== '') {
        if (!isSafeProductFolder(product)) {
          throw fail('validation', `product id "${product}" is not a safe workspace folder name`)
        }
        root = path.join(parent, product)
      }
      if (root === undefined) {
        throw fail('validation', `unknown product "${product}": no workspace root configured for relative paths`)
      }
      const outOfRoot = () =>
        fail(
          'workspace_out_of_root',
          `workspace path "${relPath}" is not an existing directory inside the root of "${product}"`,
        )
      const realRoot = await realDir(root)
      if (realRoot === undefined) throw outOfRoot()
      const target = await realDir(path.resolve(root, trimmed))
      if (target === undefined) throw outOfRoot()
      if (target !== realRoot && !target.startsWith(realRoot + path.sep)) throw outOfRoot()
      return target
    },
  }
}
