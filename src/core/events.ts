import { appendFile, mkdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import { fail } from './errors.js'
import { assertRunId } from './ids.js'
import type { Redactor } from './redact.js'
import { createSerializer } from './serialize.js'
import type { EventType, RunEvent } from './types.js'

const FINISHED_STATUSES = new Set(['SUCCEEDED', 'FAILED', 'CANCELLED'])

export interface EventLog {
  emit(runId: string, type: EventType, data: unknown): Promise<RunEvent>
  read(runId: string, fromSeq?: number): Promise<RunEvent[]>
  subscribe(runId: string, listener: (e: RunEvent) => void): () => void
  lastSeq(runId: string): Promise<number>
}

export function isTerminalEvent(e: RunEvent): boolean {
  return e.type === 'run/finished'
}

export interface FinishedData {
  status: 'SUCCEEDED' | 'FAILED' | 'CANCELLED'
  sessionRef?: string
  error?: { code: string; message: string }
  usage?: Record<string, unknown>
}

const isRecord = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v)

export function assertFinishedData(data: unknown): asserts data is FinishedData {
  if (!isRecord(data)) throw fail('validation', 'run/finished data must be an object')
  if (typeof data.status !== 'string' || !FINISHED_STATUSES.has(data.status)) {
    throw fail('validation', 'run/finished data.status must be SUCCEEDED|FAILED|CANCELLED')
  }
  if (data.sessionRef !== undefined && typeof data.sessionRef !== 'string') {
    throw fail('validation', 'run/finished data.sessionRef must be a string')
  }
  if (data.error !== undefined) {
    if (!isRecord(data.error) || typeof data.error.code !== 'string' || typeof data.error.message !== 'string') {
      throw fail('validation', 'run/finished data.error must be {code,message}')
    }
  }
  if (data.usage !== undefined && !isRecord(data.usage)) {
    throw fail('validation', 'run/finished data.usage must be an object')
  }
}

export function createEventLog(opts: { dataRoot: string; redactor: Redactor }): EventLog {
  const runsDir = path.join(opts.dataRoot, 'runs')
  const seqs = new Map<string, number>()
  const serialized = createSerializer()
  const listeners = new Map<string, Set<(e: RunEvent) => void>>()

  /** Runs whose file ends without `\n` (truncated tail): the next append must start on a fresh line. */
  const openTail = new Set<string>()

  const file = (runId: string) => path.join(runsDir, runId, 'events.jsonl')

  async function readRaw(runId: string): Promise<string> {
    try {
      return await readFile(file(runId), 'utf8')
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return ''
      throw err
    }
  }

  function parseLines(raw: string): RunEvent[] {
    const events: RunEvent[] = []
    for (const line of raw.split('\n')) {
      if (line.length === 0) continue
      let parsed: unknown
      try {
        parsed = JSON.parse(line)
      } catch {
        continue // truncated/corrupt line (e.g. crash mid-append): keep the intact events, skip this one
      }
      // Only plain objects with an integer seq >= 1 count as events, so seq arithmetic never sees NaN/undefined/negatives.
      if (isRecord(parsed) && Number.isInteger(parsed.seq) && (parsed.seq as number) >= 1) events.push(parsed as unknown as RunEvent)
    }
    return events
  }

  const readAll = async (runId: string) => parseLines(await readRaw(runId))

  async function currentSeq(runId: string): Promise<number> {
    const known = seqs.get(runId)
    if (known !== undefined) return known
    const raw = await readRaw(runId)
    // Max (not last) so an out-of-order line appended by hand cannot make the next seq collide with an earlier one.
    const last = parseLines(raw).reduce((max, e) => Math.max(max, e.seq), 0)
    seqs.set(runId, last)
    if (raw.length > 0 && !raw.endsWith('\n')) openTail.add(runId)
    return last
  }

  return {
    async emit(runId, type, data) {
      assertRunId(runId)
      if (type === 'run/finished') assertFinishedData(data)
      // Appends are serialized per run so seq order == file order.
      return serialized(runId, async () => {
        const seq = (await currentSeq(runId)) + 1
        const event: RunEvent = {
          id: `${runId}:${seq}`,
          runId,
          seq,
          at: new Date().toISOString(),
          type,
          data: opts.redactor.redact(data),
        }
        await mkdir(path.dirname(file(runId)), { recursive: true })
        const prefix = openTail.delete(runId) ? '\n' : ''
        await appendFile(file(runId), `${prefix}${JSON.stringify(event)}\n`)
        seqs.set(runId, seq)
        // The event is already persisted; a misbehaving listener must not turn a successful emit into a rejection.
        for (const listener of listeners.get(runId) ?? []) {
          try {
            listener(event)
          } catch {
            // ignore: listener errors are the subscriber's problem, not the log's
          }
        }
        return event
      })
    },

    async read(runId, fromSeq = 0) {
      assertRunId(runId)
      return (await readAll(runId)).filter((e) => e.seq > fromSeq)
    },

    subscribe(runId, listener) {
      assertRunId(runId)
      let set = listeners.get(runId)
      if (!set) listeners.set(runId, (set = new Set()))
      set.add(listener)
      return () => {
        set.delete(listener)
        if (set.size === 0) listeners.delete(runId)
      }
    },

    async lastSeq(runId) {
      assertRunId(runId)
      return serialized(runId, () => currentSeq(runId))
    },
  }
}
