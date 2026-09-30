import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import path from 'node:path'

export interface SpawnCliInput {
  command: string
  args: string[]
  cwd: string
  env: Record<string, string>
  signal: AbortSignal
  onLine: (line: string) => void
  onStderr?: (line: string) => void
  /** SIGKILL delay after SIGTERM on abort. Default 5000. */
  killGraceMs?: number
  /** After `exit`, how long to wait for `close` (stdio drain) before resolving anyway. Default 1000. */
  drainMs?: number
}

export interface SpawnCliResult {
  code: number | null
  signal: NodeJS.Signals | null
  /** `cli_not_found`: binary missing (ENOENT). `spawn_failed`: any other spawn error (see `detail`). */
  error?: 'cli_not_found' | 'spawn_failed'
  detail?: string
}

/** True when `binary` resolves as a file on `PATH` (empty PATH segments skipped). */
export function findOnPath(binary: string): boolean {
  for (const dir of (process.env.PATH ?? '').split(path.delimiter)) {
    if (!dir) continue
    if (existsSync(path.join(dir, binary))) return true
  }
  return false
}

/** Splits a stream into `\n`-terminated lines across chunk boundaries; `flush()` emits the trailing partial line. */
function lineSplitter(onLine: (line: string) => void) {
  let buffer = ''
  return {
    push(chunk: string) {
      buffer += chunk
      let nl: number
      while ((nl = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, nl)
        buffer = buffer.slice(nl + 1)
        onLine(line.endsWith('\r') ? line.slice(0, -1) : line)
      }
    },
    flush() {
      if (buffer.length > 0) onLine(buffer)
      buffer = ''
    },
  }
}

const alive = (child: ChildProcess) => child.exitCode === null && child.signalCode === null

/**
 * Signals the whole process group (child is a group leader via `detached`), regardless of whether the
 * direct child is still alive: helpers that inherited our pipes may outlive it. ESRCH means the group is
 * already empty. Falls back to the child alone only when the group signal fails and the child is alive.
 */
function killGroup(child: ChildProcess, sig: NodeJS.Signals): void {
  try {
    if (child.pid === undefined) throw new Error('no pid')
    process.kill(-child.pid, sig)
  } catch {
    if (alive(child)) child.kill(sig)
  }
}

/**
 * Common spawn for native CLIs: no shell, own process group, stdout by line, stderr by line (kept
 * separate), SIGTERM to the group on abort then SIGKILL after `killGraceMs`. Resolves on `close`
 * (stdio drained) or, when a grandchild keeps the pipes open, `drainMs` after `exit`.
 * The env is never logged here.
 */
export function spawnCli(input: SpawnCliInput): Promise<SpawnCliResult> {
  const { command, args, cwd, env, signal, onLine, killGraceMs = 5000, drainMs = 1000 } = input
  const onStderr = input.onStderr ?? (() => {})

  return new Promise((resolve) => {
    const child = spawn(command, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, detached: process.platform !== 'win32' })
    const stdout = lineSplitter(onLine)
    const stderr = lineSplitter(onStderr)
    let killTimer: NodeJS.Timeout | undefined
    let drainTimer: NodeJS.Timeout | undefined
    let settled = false

    /** `pipesClosed`: `close` fired, so every pipe holder is gone and the SIGKILL escalation can be dropped. */
    const finish = (result: SpawnCliResult, pipesClosed: boolean) => {
      if (settled) return
      settled = true
      if (pipesClosed && killTimer) clearTimeout(killTimer)
      if (drainTimer) clearTimeout(drainTimer)
      signal.removeEventListener('abort', onAbort)
      stdout.flush()
      stderr.flush()
      resolve(result)
    }

    const onAbort = () => {
      if (!alive(child)) return
      killGroup(child, 'SIGTERM')
      killTimer = setTimeout(() => killGroup(child, 'SIGKILL'), killGraceMs)
    }

    child.stdout!.setEncoding('utf8').on('data', (chunk: string) => stdout.push(chunk))
    child.stderr!.setEncoding('utf8').on('data', (chunk: string) => stderr.push(chunk))

    child.on('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'ENOENT') finish({ code: null, signal: null, error: 'cli_not_found', detail: err.message }, true)
      else finish({ code: null, signal: null, error: 'spawn_failed', detail: err.message }, true)
    })
    child.on('exit', (code, sig) => {
      // A grandchild that inherited the pipes keeps `close` from firing; do not hang the dispatcher on it.
      drainTimer = setTimeout(() => {
        // Whatever still holds our pipes after the CLI exited is a straggler: kill the group, then let go.
        killGroup(child, 'SIGKILL')
        if (killTimer) clearTimeout(killTimer) // the group is dead; no escalation timer may outlive the promise
        child.stdout!.destroy()
        child.stderr!.destroy()
        finish({ code, signal: sig }, false)
      }, drainMs)
    })
    child.on('close', (code, sig) => finish({ code, signal: sig }, true))

    if (signal.aborted) onAbort()
    else signal.addEventListener('abort', onAbort, { once: true })
  })
}
