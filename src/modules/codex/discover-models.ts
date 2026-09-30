import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { parseModelListOutput } from '../../core/native-models.js'
import { findOnPath } from '../../core/spawn.js'

const execFileAsync = promisify(execFile)

export async function discoverCodexModelIds(secret?: string): Promise<string[]> {
  if (!findOnPath('codex')) return []
  try {
    const env: NodeJS.ProcessEnv = {}
    if (process.env.PATH) env.PATH = process.env.PATH
    if (process.env.HOME) env.HOME = process.env.HOME
    if (secret) env.OPENAI_API_KEY = secret
    const { stdout } = await execFileAsync('codex', ['debug', 'models'], { timeout: 8000, encoding: 'utf8', env })
    return parseModelListOutput(typeof stdout === 'string' ? stdout : String(stdout))
  } catch {
    return []
  }
}
