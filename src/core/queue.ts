import { fail } from './errors.js'
import type { RunRecord } from './types.js'

export interface QueueOptions {
  /** Default 4. */
  maxConcurrent?: number
  /** Default 2. */
  maxConcurrentPerProduct?: number
  onStart: (run: RunRecord) => Promise<void> | void
  /** Called when `onStart` throws/rejects; the slot is released first. Never leaks an unhandled rejection. */
  onStartError?: (run: RunRecord, err: unknown) => void
  onPositionChange?: (runId: string, position: number) => void
}

export interface Queue {
  /** Adds to the FIFO tail and returns the 1-based queue position; `onStart` may fire on a later microtask. */
  enqueue(run: RunRecord): number
  /** Frees the slot held by `runId` (no-op if it is not running) and starts the next eligible run(s). */
  release(runId: string): void
  /** 1-based position among queued runs, or undefined when not queued (running or unknown). */
  position(runId: string): number | undefined
  /** Cancels a still-queued run. Returns false when it was not queued. */
  remove(runId: string): boolean
  snapshot(): { running: string[]; queued: string[] }
}

function assertLimit(name: string, value: number): void {
  if (!Number.isInteger(value) || value < 1) throw fail('validation', `${name} must be an integer >= 1`)
}

/**
 * FIFO with a global limit and a per-product limit.
 *
 * Scheduling rule: the next run to start is the FIRST queued run whose product is under its
 * per-product limit. If the head is blocked by its product's limit, later runs of *other*
 * products may start ahead of it (no head-of-line blocking across products). Within one product
 * order is always FIFO. The blocked head stays at position 1 and starts as soon as a slot of its
 * product frees, so it is never skipped forever.
 */
export function createQueue(opts: QueueOptions): Queue {
  const maxConcurrent = opts.maxConcurrent ?? 4
  const maxPerProduct = opts.maxConcurrentPerProduct ?? 2
  assertLimit('maxConcurrent', maxConcurrent)
  assertLimit('maxConcurrentPerProduct', maxPerProduct)

  const queued: RunRecord[] = []
  const running = new Map<string, string>() // runId -> product
  let scheduled = false

  const runningForProduct = (product: string) => [...running.values()].filter((p) => p === product).length

  function notifyPositions(): void {
    if (!opts.onPositionChange) return
    queued.forEach((run, i) => opts.onPositionChange!(run.id, i + 1))
  }

  function startEligible(): void {
    let started = false
    while (running.size < maxConcurrent) {
      const idx = queued.findIndex((run) => runningForProduct(run.product) < maxPerProduct)
      if (idx < 0) break
      const [run] = queued.splice(idx, 1)
      running.set(run.id, run.product)
      started = true
      Promise.resolve()
        .then(() => opts.onStart(run))
        .catch((err: unknown) => {
          release(run.id)
          opts.onStartError?.(run, err)
        })
    }
    if (started) notifyPositions()
  }

  /** Coalesces scheduling into one microtask so `enqueue` always returns before `onStart` runs. */
  function schedule(): void {
    if (scheduled) return
    scheduled = true
    queueMicrotask(() => {
      scheduled = false
      startEligible()
    })
  }

  function release(runId: string): void {
    if (!running.delete(runId)) return
    schedule()
  }

  return {
    enqueue(run) {
      if (running.has(run.id) || queued.some((r) => r.id === run.id)) {
        throw fail('duplicate_run', `run ${run.id} is already queued or running`)
      }
      queued.push(run)
      schedule()
      return queued.length
    },

    release,

    position(runId) {
      const idx = queued.findIndex((r) => r.id === runId)
      return idx < 0 ? undefined : idx + 1
    },

    remove(runId) {
      const idx = queued.findIndex((r) => r.id === runId)
      if (idx < 0) return false
      queued.splice(idx, 1)
      notifyPositions()
      return true
    },

    snapshot() {
      return { running: [...running.keys()], queued: queued.map((r) => r.id) }
    },
  }
}
