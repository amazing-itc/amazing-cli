import type { ServerResponse } from 'node:http'
import { TERMINAL_STATUSES } from '../core/dispatcher.js'
import { isTerminalEvent, type EventLog } from '../core/events.js'
import type { RunEvent, RunRecord } from '../core/types.js'

export const DEFAULT_HEARTBEAT_MS = 15_000

/** `Last-Event-ID: <runId>:<seq>` → seq; anything else (missing, other run, non-integer) → 0 (full replay). */
export function parseLastEventId(value: string | string[] | undefined, runId: string): number {
  const raw = Array.isArray(value) ? value[0] : value
  if (raw === undefined) return 0
  const sep = raw.lastIndexOf(':')
  if (sep < 0 || raw.slice(0, sep) !== runId) return 0
  const seq = Number(raw.slice(sep + 1))
  return Number.isInteger(seq) && seq >= 0 ? seq : 0
}

export function openSse(res: ServerResponse): void {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  })
  res.flushHeaders()
}

export function writeEvent(res: ServerResponse, ev: RunEvent): void {
  res.write(`id: ${ev.id}\nevent: ${ev.type}\ndata: ${JSON.stringify(ev)}\n\n`)
}

export interface StreamRunInput {
  res: ServerResponse
  runId: string
  events: EventLog
  record: () => RunRecord | undefined
  lastEventId: string | string[] | undefined
  heartbeatMs?: number
}

/**
 * Replays `events.jsonl` after `Last-Event-ID`, then streams live events until `run/finished`.
 * Subscribes before reading so nothing emitted during the read is lost; `lastSent` dedupes the overlap.
 */
export async function streamRun({ res, runId, events, record, lastEventId, heartbeatMs = DEFAULT_HEARTBEAT_MS }: StreamRunInput): Promise<void> {
  openSse(res)
  let lastSent = parseLastEventId(lastEventId, runId)
  let ended = false
  const buffered: RunEvent[] = []
  let replaying = true

  const heartbeat = setInterval(() => res.write(': ping\n\n'), heartbeatMs)
  heartbeat.unref()

  const end = () => {
    if (ended) return
    ended = true
    clearInterval(heartbeat)
    unsubscribe()
    res.end()
  }
  const send = (ev: RunEvent) => {
    if (ended || ev.seq <= lastSent) return
    lastSent = ev.seq
    writeEvent(res, ev)
    if (isTerminalEvent(ev)) end()
  }
  const unsubscribe = events.subscribe(runId, (ev) => (replaying ? buffered.push(ev) : send(ev)))
  res.on('close', end)

  for (const ev of await events.read(runId, lastSent)) send(ev)
  replaying = false
  for (const ev of buffered) send(ev)
  buffered.length = 0

  // Still open: the run is alive, or it just turned terminal and its `run/finished` (emitted right after the
  // registry write, seq == record.lastSeq) is about to arrive through the subscription opened above. End now only
  // when the run vanished or the client already holds everything up to `lastSeq`.
  const current = record()
  if (!ended && (current === undefined || (TERMINAL_STATUSES.has(current.status) && current.lastSeq <= lastSent))) end()
}
