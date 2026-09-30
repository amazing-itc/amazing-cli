import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { resolveInsideWorkspace } from './paths.js'

export const SPILL_THRESHOLD = 8000

export async function spillText(workspacePath: string, content: string, suggested = 'tool.txt'): Promise<string> {
  const name = `${randomUUID().slice(0, 8)}-${suggested.replace(/[^a-zA-Z0-9._-]/g, '_')}`
  const rel = `.harness/spill/${name}`
  const target = resolveInsideWorkspace(workspacePath, rel)
  await mkdir(join(workspacePath, '.harness/spill'), { recursive: true })
  await writeFile(target, content, 'utf8')
  return `spilled ${content.length} bytes → ${rel} (session_query or fs read to retrieve)`
}

export async function maybeSpill(workspacePath: string, content: string, toolName: string): Promise<string> {
  if (!workspacePath || content.length < SPILL_THRESHOLD) {
    return content
  }
  return spillText(workspacePath, content, `${toolName}.txt`)
}
