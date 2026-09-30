import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { parseModelListOutput } from '../../core/native-models.js'
import { cursorBinaryAvailable, resolveCursorInvoke } from './spawn.js'

const execFileAsync = promisify(execFile)

export async function discoverCursorModelIds(secret?: string): Promise<string[]> {
  const invoke = resolveCursorInvoke()
  if (!cursorBinaryAvailable(invoke.command)) return []
  try {
    const args = invoke.indexJs ? [invoke.indexJs, '--list-models'] : ['--list-models']
    const env: NodeJS.ProcessEnv = {}
    if (process.env.PATH) env.PATH = process.env.PATH
    if (process.env.HOME) env.HOME = process.env.HOME
    if (secret) env.CURSOR_API_KEY = secret
    const { stdout } = await execFileAsync(invoke.command, args, { timeout: 8000, encoding: 'utf8', env })
    return parseModelListOutput(typeof stdout === 'string' ? stdout : String(stdout))
  } catch {
    return []
  }
}
