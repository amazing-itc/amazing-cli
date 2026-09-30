import type { HomeManager } from './home.js'
import type { SessionRegistry } from './session-registry.js'

export interface SessionSweeper {
  /** One pass: close every persistent IDLE session idle longer than `idleTtlSec`. Returns the closed ids. */
  sweep(): Promise<string[]>
  /** Runs `sweep` every `sweepSec` until `stop`. */
  start(): void
  stop(): void
}

/**
 * Retention of persistent sessions: an IDLE session whose `lastActivityAt` is older than `idleTtlSec`
 * is closed — `home/` removed, `meta.json` and `session.jsonl` kept. BUSY sessions are skipped (a live turn is
 * never cut by the TTL) and CLOSED ones are left untouched. Ephemeral sessions close with their run, not here.
 */
export function createSessionSweeper(opts: {
  sessions: SessionRegistry
  homes: HomeManager
  idleTtlSec: number
  sweepSec: number
  clock?: () => Date
  /** Test seam for the timer; defaults to `setInterval` (unref'd, so it never holds the process open). */
  schedule?: (fn: () => void, periodMs: number) => NodeJS.Timeout
}): SessionSweeper {
  const now = () => (opts.clock ?? (() => new Date()))().getTime()
  let timer: NodeJS.Timeout | undefined

  async function sweep(): Promise<string[]> {
    const deadline = now() - opts.idleTtlSec * 1000
    const closed: string[] = []
    for (const session of opts.sessions.list()) {
      if (session.status !== 'IDLE' || session.policy.window !== 'persistent') continue
      if (Date.parse(session.lastActivityAt) >= deadline) continue
      await opts.homes.dispose(session.id)
      await opts.sessions.close(session.id)
      closed.push(session.id)
    }
    return closed
  }

  return {
    sweep,
    start() {
      if (timer) return
      const periodMs = Math.max(1, Math.round(opts.sweepSec * 1000))
      const run = () => void sweep().catch(() => {})
      timer = opts.schedule ? opts.schedule(run, periodMs) : setInterval(run, periodMs)
      timer.unref?.()
    },
    stop() {
      if (timer) clearInterval(timer)
      timer = undefined
    },
  }
}
