import { mkdir, rm } from 'node:fs/promises'
import path from 'node:path'
import { assertSessionId } from './ids.js'

export interface HomeManager {
  /** `mkdir -p {dataRoot}/sessions/{sessionId}/home` (0o700); returns the path. Idempotent: an existing home is kept as is. */
  create(sessionId: string): Promise<string>
  /** Removes only the `home` dir; `meta.json`/`session.jsonl` in the session dir are kept. */
  dispose(sessionId: string): Promise<void>
  path(sessionId: string): string
}

/**
 * One isolated HOME per session: CLIs keep their conversation state under HOME, so it must survive between the
 * turns of a session (that is what makes `--resume` work) and must never be shared across sessions or products.
 */
export function createHomeManager(opts: { dataRoot: string }): HomeManager {
  const homePath = (sessionId: string) => path.join(opts.dataRoot, 'sessions', sessionId, 'home')
  return {
    path: homePath,
    async create(sessionId) {
      assertSessionId(sessionId)
      const dir = homePath(sessionId)
      await mkdir(dir, { recursive: true, mode: 0o700 })
      return dir
    },
    async dispose(sessionId) {
      assertSessionId(sessionId)
      await rm(homePath(sessionId), { recursive: true, force: true })
    },
  }
}
