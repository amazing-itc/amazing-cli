import { randomUUID } from 'node:crypto'
import { mkdir, readdir, readFile, rename, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fail } from './errors.js'
import { RUN_ID_RE, assertRunId } from './ids.js'
import { createSerializer } from './serialize.js'
import type { RunRecord, RunStatus } from './types.js'

const META = 'meta.json'

export type CreateRunInput = Omit<RunRecord, 'createdAt' | 'lastSeq' | 'status'> & { status?: RunStatus }

export interface Registry {
  /** `recovered`: RUNNING runs flipped to FAILED/interrupted. `skipped`: run dirs whose meta.json was unreadable. */
  init(): Promise<{ recovered: string[]; skipped: string[] }>
  create(record: CreateRunInput): Promise<RunRecord>
  get(id: string): RunRecord | undefined
  list(filter?: { product?: string; status?: RunStatus }): RunRecord[]
  update(id: string, patch: Partial<RunRecord>): Promise<RunRecord>
  recoverOnBoot(): Promise<string[]>
  runDir(id: string): string
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
function isRunRecord(v: unknown): v is RunRecord {
  return (
    isRecord(v) &&
    typeof v.id === 'string' &&
    typeof v.product === 'string' &&
    typeof v.family === 'string' &&
    typeof v.status === 'string' &&
    typeof v.createdAt === 'string' &&
    typeof v.lastSeq === 'number'
  )
}

export function createRegistry(opts: { dataRoot: string }): Registry {
  const runsDir = path.join(opts.dataRoot, 'runs')
  const index = new Map<string, RunRecord>()
  const serialized = createSerializer()

  const runDir = (id: string) => path.join(runsDir, id)

  async function persist(record: RunRecord): Promise<void> {
    const dir = runDir(record.id)
    await mkdir(dir, { recursive: true })
    const file = path.join(dir, META)
    const tmp = tmpName(file)
    await writeFile(tmp, JSON.stringify(record, null, 2))
    await rename(tmp, file)
  }

  /** Loads every readable meta.json; returns ids of run dirs whose meta.json is missing or corrupt. */
  async function load(): Promise<string[]> {
    const skipped: string[] = []
    const entries = await readdir(runsDir, { withFileTypes: true })
    for (const entry of entries) {
      if (!entry.isDirectory() || !RUN_ID_RE.test(entry.name)) continue
      try {
        const record: unknown = JSON.parse(await readFile(path.join(runsDir, entry.name, META), 'utf8'))
        // The dir name is the trusted id; a tampered record.id must never enter the index (it becomes a path).
        if (!isRunRecord(record) || record.id !== entry.name || !RUN_ID_RE.test(record.id)) {
          throw new Error('invalid record')
        }
        index.set(record.id, record)
      } catch {
        skipped.push(entry.name) // missing, corrupt or tampered meta.json: do not brick boot
      }
    }
    return skipped
  }

  /** Serialized per id; `current` is read inside the task so concurrent patches compose instead of clobbering. */
  function update(id: string, patch: Partial<RunRecord>): Promise<RunRecord> {
    return serialized(id, async () => {
      const current = index.get(id)
      if (!current) throw fail('not_found', `run ${id} not found`)
      const next: RunRecord = { ...current, ...stripCredential(patch), id }
      await persist(next)
      index.set(id, next)
      return next
    })
  }

  async function recoverOnBoot(): Promise<string[]> {
    const recovered: string[] = []
    for (const record of index.values()) {
      if (record.status !== 'RUNNING') continue
      await update(record.id, {
        status: 'FAILED',
        error: { code: 'interrupted', message: 'amazing-cli restarted while run was RUNNING' },
        finishedAt: new Date().toISOString(),
      })
      recovered.push(record.id)
    }
    return recovered
  }

  return {
    async init() {
      await mkdir(runsDir, { recursive: true })
      const skipped = await load()
      const recovered = await recoverOnBoot()
      return { recovered, skipped }
    },

    async create(input) {
      assertRunId(input.id)
      return serialized(input.id, async () => {
        if (index.has(input.id)) throw fail('duplicate_run', `run ${input.id} already exists`)
        const record: RunRecord = {
          ...stripCredential(input),
          status: input.status ?? 'QUEUED',
          createdAt: new Date().toISOString(),
          lastSeq: 0,
        }
        await persist(record)
        index.set(record.id, record)
        return record
      })
    },

    get: (id) => index.get(id),

    list(filter = {}) {
      return [...index.values()]
        .filter((r) => (filter.product === undefined || r.product === filter.product) && (filter.status === undefined || r.status === filter.status))
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    },

    update,
    recoverOnBoot,
    runDir,
  }
}
