import { randomUUID } from 'node:crypto'
import { mkdir, readdir, readFile, rename, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fail } from './errors.js'
import { SESSION_ID_RE, assertSessionId } from './ids.js'
import { createSerializer } from './serialize.js'
import type { CreateSessionInput, Session, SessionStatus } from './types.js'

const META = 'meta.json'

export type SessionIdlePatch = Partial<Pick<Session, 'providerSessionRef' | 'context' | 'usage'>>

export interface SessionRegistry {
  /** `recovered`: BUSY sessions flipped to IDLE. `skipped`: session dirs whose meta.json was unreadable or tampered. */
  init(): Promise<{ recovered: string[]; skipped: string[] }>
  create(input: CreateSessionInput): Promise<Session>
  get(id: string): Session | undefined
  list(filter?: { product?: string; status?: SessionStatus }): Session[]
  markBusy(id: string, runId: string): Promise<Session>
  markIdle(id: string, patch: SessionIdlePatch): Promise<Session>
  /** Updates fields without changing status or `turnCount`. Rejects a CLOSED session. */
  patch(id: string, patch: SessionIdlePatch): Promise<Session>
  close(id: string): Promise<Session>
  sessionDir(id: string): string
  homeDir(id: string): string
}

/** meta.json must never hold a secret, whatever a caller passes. */
function stripCredential<T extends object>(value: T): T {
  const { credential: _credential, ...rest } = value as T & { credential?: unknown }
  return rest as T
}

/** Module-level so two registry instances in one process (or two processes) never collide on a tmp name. */
let tmpCounter = 0
const tmpName = (file: string) => `${file}.${process.pid}.${++tmpCounter}.${randomUUID().slice(0, 8)}.tmp`

const isRecord = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v)

/** Minimal shape guard so a hand-edited meta.json cannot put `undefined` into sort/filter paths. */
function isSession(v: unknown): v is Session {
  return (
    isRecord(v) &&
    typeof v.id === 'string' &&
    typeof v.product === 'string' &&
    typeof v.family === 'string' &&
    typeof v.status === 'string' &&
    typeof v.workspaceDir === 'string' &&
    isRecord(v.policy) &&
    typeof v.turnCount === 'number' &&
    typeof v.createdAt === 'string' &&
    typeof v.lastActivityAt === 'string'
  )
}

export function createSessionRegistry(opts: { dataRoot: string; clock?: () => Date }): SessionRegistry {
  const sessionsDir = path.join(opts.dataRoot, 'sessions')
  const now = () => (opts.clock ?? (() => new Date()))().toISOString()
  const index = new Map<string, Session>()
  const serialized = createSerializer()

  const sessionDir = (id: string) => path.join(sessionsDir, id)

  async function persist(record: Session): Promise<void> {
    const dir = sessionDir(record.id)
    await mkdir(dir, { recursive: true })
    const file = path.join(dir, META)
    const tmp = tmpName(file)
    await writeFile(tmp, JSON.stringify(record, null, 2))
    await rename(tmp, file)
  }

  /** Loads every readable meta.json; returns ids of session dirs whose meta.json is missing, corrupt or tampered. */
  async function load(): Promise<string[]> {
    const skipped: string[] = []
    const entries = await readdir(sessionsDir, { withFileTypes: true })
    for (const entry of entries) {
      if (!entry.isDirectory() || !SESSION_ID_RE.test(entry.name)) continue
      try {
        const record: unknown = JSON.parse(await readFile(path.join(sessionsDir, entry.name, META), 'utf8'))
        // The dir name is the trusted id; a tampered record.id must never enter the index (it becomes a path).
        if (!isSession(record) || record.id !== entry.name || !SESSION_ID_RE.test(record.id)) {
          throw new Error('invalid record')
        }
        index.set(record.id, record)
      } catch {
        skipped.push(entry.name) // missing, corrupt or tampered meta.json: do not brick boot
      }
    }
    return skipped
  }

  /** Serialized per id; `current` is read inside the task so concurrent transitions see each other's result. */
  function transition(id: string, step: (current: Session) => Session): Promise<Session> {
    return serialized(id, async () => {
      const current = index.get(id)
      if (!current) throw fail('not_found', `session ${id} not found`)
      const next = step(current)
      if (next === current) return current
      await persist(next)
      index.set(id, next)
      return next
    })
  }

  async function recoverOnBoot(): Promise<string[]> {
    const recovered: string[] = []
    for (const record of index.values()) {
      if (record.status !== 'BUSY') continue
      await transition(record.id, (current) => ({ ...current, status: 'IDLE', lastActivityAt: now() }))
      recovered.push(record.id)
    }
    return recovered
  }

  return {
    async init() {
      await mkdir(sessionsDir, { recursive: true })
      const skipped = await load()
      const recovered = await recoverOnBoot()
      return { recovered, skipped }
    },

    async create(input) {
      assertSessionId(input.id)
      return serialized(input.id, async () => {
        if (index.has(input.id)) throw fail('duplicate_session', `session ${input.id} already exists`)
        const at = now()
        const record: Session = { ...stripCredential(input), status: 'IDLE', turnCount: 0, createdAt: at, lastActivityAt: at }
        await persist(record)
        index.set(record.id, record)
        return record
      })
    },

    get: (id) => index.get(id),

    list(filter = {}) {
      return [...index.values()]
        .filter((s) => (filter.product === undefined || s.product === filter.product) && (filter.status === undefined || s.status === filter.status))
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    },

    markBusy(id, runId) {
      return transition(id, (current) => {
        if (current.status === 'CLOSED') throw fail('session_closed', `session ${id} is closed`)
        if (current.status === 'BUSY') throw fail('session_busy', `session ${id} is busy with turn ${current.lastTurnId}`)
        return { ...current, status: 'BUSY', lastTurnId: runId, lastActivityAt: now() }
      })
    },

    markIdle(id, patch) {
      return transition(id, (current) => {
        if (current.status === 'CLOSED') throw fail('session_closed', `session ${id} is closed`)
        return { ...current, ...stripCredential(patch), id, status: 'IDLE', turnCount: current.turnCount + 1, lastActivityAt: now() }
      })
    },

    patch(id, patch) {
      return transition(id, (current) => {
        if (current.status === 'CLOSED') throw fail('session_closed', `session ${id} is closed`)
        return { ...current, ...stripCredential(patch), id, lastActivityAt: now() }
      })
    },

    close(id) {
      return transition(id, (current) => (current.status === 'CLOSED' ? current : { ...current, status: 'CLOSED', closedAt: now() }))
    },

    sessionDir,
    homeDir: (id) => path.join(sessionDir(id), 'home'),
  }
}
