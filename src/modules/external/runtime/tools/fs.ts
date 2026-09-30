import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises'
import { dirname, join, relative } from 'node:path'
import { resolveInsideWorkspace } from './paths.js'

export type FsArgs = {
  action?: 'read' | 'write' | 'list' | 'grep'
  path?: string
  content?: string
  pattern?: string
}

export async function runFs(args: FsArgs, workspacePath: string): Promise<string> {
  const action = args.action ?? 'read'
  const rel = args.path ?? '.'
  const target = resolveInsideWorkspace(workspacePath, rel)
  if (action === 'read') {
    return await readFile(target, 'utf8')
  }
  if (action === 'write') {
    await mkdir(dirname(target), { recursive: true })
    await writeFile(target, args.content ?? '', 'utf8')
    return `wrote ${rel} (${(args.content ?? '').length} bytes)`
  }
  if (action === 'list') {
    const entries = await readdir(target, { withFileTypes: true })
    return entries.map(entry => `${entry.isDirectory() ? 'd' : 'f'} ${entry.name}`).join('\n')
  }
  if (action === 'grep') {
    const pattern = args.pattern ?? ''
    if (!pattern) return 'grep: pattern required'
    const hits: string[] = []
    await walk(target, workspacePath, async file => {
      const text = await readFile(file, 'utf8').catch(() => '')
      if (text.includes(pattern)) {
        hits.push(relative(workspacePath, file))
      }
    })
    return hits.slice(0, 50).join('\n') || '(no matches)'
  }
  throw new Error(`fs: unknown action ${action}`)
}

async function walk(
  dir: string,
  workspacePath: string,
  visit: (file: string) => Promise<void>,
  depth = 0,
): Promise<void> {
  if (depth > 8) return
  const info = await stat(dir)
  if (info.isFile()) {
    await visit(dir)
    return
  }
  const names = await readdir(dir)
  for (const name of names) {
    if (name === 'node_modules' || name === '.git') continue
    await walk(join(dir, name), workspacePath, visit, depth + 1)
  }
}
