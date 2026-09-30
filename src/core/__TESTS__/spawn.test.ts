import assert from 'node:assert/strict'
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, test } from 'node:test'
import { spawnCli } from '../spawn.js'

let cwd: string
beforeEach(() => {
  cwd = mkdtempSync(path.join(os.tmpdir(), 'spawn-'))
})
afterEach(() => {
  rmSync(cwd, { recursive: true, force: true })
})

const node = (script: string) => ({ command: process.execPath, args: ['-e', script] })
const baseEnv = { PATH: process.env.PATH ?? '' }

test('stdout is split into lines across chunk boundaries and the trailing partial line is flushed at exit', async () => {
  const lines: string[] = []
  const stderr: string[] = []
  const script = `
    process.stdout.write('first\\n');
    process.stdout.write('sec');
    setTimeout(() => { process.stdout.write('ond\\nthird'); process.stderr.write('warn 1\\nwarn 2\\n'); }, 30);
  `
  const result = await spawnCli({ ...node(script), cwd, env: baseEnv, signal: new AbortController().signal, onLine: (l) => lines.push(l), onStderr: (l) => stderr.push(l) })
  assert.deepEqual(result, { code: 0, signal: null })
  assert.deepEqual(lines, ['first', 'second', 'third'])
  assert.deepEqual(stderr, ['warn 1', 'warn 2'])
})

test('stderr is not mixed into onLine when onStderr is omitted; CRLF is normalized; cwd and env are honoured', async () => {
  const lines: string[] = []
  const script = `process.stderr.write('noise\\n'); process.stdout.write(process.cwd() + '\\r\\n' + (process.env.PROBE ?? 'no') + '\\n');`
  const result = await spawnCli({ ...node(script), cwd, env: { ...baseEnv, PROBE: 'yes' }, signal: new AbortController().signal, onLine: (l) => lines.push(l) })
  assert.equal(result.code, 0)
  assert.deepEqual(lines, [realpathSync(cwd), 'yes'])
})

test('non-zero exit code is reported', async () => {
  const result = await spawnCli({ ...node('process.exit(3)'), cwd, env: baseEnv, signal: new AbortController().signal, onLine: () => {} })
  assert.deepEqual(result, { code: 3, signal: null })
})

test('abort → SIGTERM terminates a cooperative child within <1s', async () => {
  const ac = new AbortController()
  const lines: string[] = []
  const p = spawnCli({ ...node(`console.log('up'); setInterval(() => {}, 1000);`), cwd, env: baseEnv, signal: ac.signal, onLine: (l) => lines.push(l) })
  await new Promise<void>((r) => {
    const i = setInterval(() => {
      if (lines.includes('up')) {
        clearInterval(i)
        r()
      }
    }, 5)
  })
  const t0 = Date.now()
  ac.abort()
  const result = await p
  assert.ok(Date.now() - t0 < 1000, `took ${Date.now() - t0}ms`)
  assert.equal(result.signal, 'SIGTERM')
  assert.equal(result.code, null)
})

test('abort → child trapping SIGTERM is SIGKILLed after killGraceMs', async () => {
  const ac = new AbortController()
  const lines: string[] = []
  const script = `process.on('SIGTERM', () => console.log('ignoring')); console.log('up'); setInterval(() => {}, 1000);`
  const p = spawnCli({ ...node(script), cwd, env: baseEnv, signal: ac.signal, onLine: (l) => lines.push(l), killGraceMs: 200 })
  await new Promise<void>((r) => {
    const i = setInterval(() => {
      if (lines.includes('up')) {
        clearInterval(i)
        r()
      }
    }, 5)
  })
  const t0 = Date.now()
  ac.abort()
  const result = await p
  const elapsed = Date.now() - t0
  assert.ok(elapsed >= 150 && elapsed < 2000, `took ${elapsed}ms`)
  assert.equal(result.signal, 'SIGKILL')
  assert.ok(lines.includes('ignoring'), 'the child saw SIGTERM first')
})

test('already-aborted signal terminates the child immediately', async () => {
  const ac = new AbortController()
  ac.abort()
  const result = await spawnCli({ ...node(`setInterval(() => {}, 1000);`), cwd, env: baseEnv, signal: ac.signal, onLine: () => {} })
  assert.ok(result.signal === 'SIGTERM' || result.signal === 'SIGKILL')
})

/** Polls until `process.kill(pid, 0)` throws ESRCH, or fails after `timeoutMs`. */
async function assertGone(pid: number, timeoutMs = 500) {
  const t0 = Date.now()
  for (;;) {
    try {
      process.kill(pid, 0)
    } catch (err) {
      assert.equal((err as NodeJS.ErrnoException).code, 'ESRCH')
      return
    }
    if (Date.now() - t0 > timeoutMs) {
      try {
        process.kill(pid, 'SIGKILL')
      } catch {}
      assert.fail(`pid ${pid} still alive after ${timeoutMs}ms`)
    }
    await new Promise((r) => setTimeout(r, 10))
  }
}

const activeTimeouts = () => process.getActiveResourcesInfo().filter((r) => r === 'Timeout').length

const waitFor = (pred: () => boolean) =>
  new Promise<void>((r) => {
    const i = setInterval(() => {
      if (pred()) {
        clearInterval(i)
        r()
      }
    }, 5)
  })

/** Grandchild sharing the child's stdio: installs its SIGTERM trap FIRST, then announces `gup <pid>`, then idles. */
const TRAPPING_GRANDCHILD = `process.on('SIGTERM', () => {}); console.log('gup ' + process.pid); setInterval(() => {}, 1e3)`

/** Child that spawns TRAPPING_GRANDCHILD with inherited stdio and idles; `trapSelf` makes the child ignore SIGTERM too. */
const childWithGrandchild = (trapSelf: boolean) => `
  const { spawn } = require('node:child_process');
  spawn(process.execPath, ['-e', ${JSON.stringify(TRAPPING_GRANDCHILD)}], { stdio: 'inherit' });
  ${trapSelf ? "process.on('SIGTERM', () => {});" : ''}
  setInterval(() => {}, 1e3);
`

const grandchildPidFrom = (lines: string[]) => {
  const pid = Number(lines.find((l) => l.startsWith('gup '))!.slice(4))
  assert.ok(Number.isInteger(pid) && pid > 0, `bad grandchild pid in ${JSON.stringify(lines)}`)
  return pid
}

test('abort: child AND grandchild trap SIGTERM → group SIGKILL after grace; grandchild gone, resolves promptly', async () => {
  const ac = new AbortController()
  const lines: string[] = []
  const p = spawnCli({ ...node(childWithGrandchild(true)), cwd, env: baseEnv, signal: ac.signal, onLine: (l) => lines.push(l), killGraceMs: 200 })
  await waitFor(() => lines.some((l) => l.startsWith('gup ')))
  const grandchildPid = grandchildPidFrom(lines)

  const t0 = Date.now()
  ac.abort()
  const result = await p
  const elapsed = Date.now() - t0
  assert.ok(elapsed < 1500, `took ${elapsed}ms`)
  assert.equal(result.signal, 'SIGKILL', 'the trapping child can only die from the escalated group SIGKILL')
  assert.equal(result.error, undefined)
  await assertGone(grandchildPid)
})

test('abort: child dies on SIGTERM but trapping grandchild holds the pipes → still SIGKILLed after grace; resolves < 1.5s', async () => {
  const ac = new AbortController()
  const lines: string[] = []
  const p = spawnCli({ ...node(childWithGrandchild(false)), cwd, env: baseEnv, signal: ac.signal, onLine: (l) => lines.push(l), killGraceMs: 200, drainMs: 1000 })
  await waitFor(() => lines.some((l) => l.startsWith('gup ')))
  const grandchildPid = grandchildPidFrom(lines)

  const t0 = Date.now()
  ac.abort()
  const result = await p
  const elapsed = Date.now() - t0
  assert.ok(elapsed < 1500, `took ${elapsed}ms`)
  assert.equal(result.signal, 'SIGTERM', 'the cooperative child itself died on the first signal')
  assert.equal(result.error, undefined)
  await assertGone(grandchildPid)
})

test('child exits on its own while a grandchild keeps the pipes open: resolves after drainMs and the straggler is SIGKILLed', async () => {
  const script = `
    const { spawn } = require('node:child_process');
    spawn(process.execPath, ['-e', ${JSON.stringify(TRAPPING_GRANDCHILD)}], { stdio: 'inherit' });
    setTimeout(() => process.exit(7), 300); // long enough for the grandchild to boot and announce itself
  `
  const lines: string[] = []
  const timeoutsBefore = activeTimeouts()
  const t0 = Date.now()
  const result = await spawnCli({ ...node(script), cwd, env: baseEnv, signal: new AbortController().signal, onLine: (l) => lines.push(l), drainMs: 200 })
  const elapsed = Date.now() - t0
  const grandchildPid = grandchildPidFrom(lines)
  try {
    assert.deepEqual(result, { code: 7, signal: null })
    assert.ok(elapsed < 1500, `took ${elapsed}ms`)
    assert.equal(activeTimeouts(), timeoutsBefore, 'no timer may linger after the drain path resolved')
    await assertGone(grandchildPid)
  } finally {
    try {
      process.kill(grandchildPid, 'SIGKILL')
    } catch {}
  }
})

test('abort: drain path fires before killGraceMs → straggler SIGKILLed and the pending escalation timer is cleared', async () => {
  const ac = new AbortController()
  const lines: string[] = []
  const timeoutsBefore = activeTimeouts()
  const p = spawnCli({ ...node(childWithGrandchild(false)), cwd, env: baseEnv, signal: ac.signal, onLine: (l) => lines.push(l), killGraceMs: 5000, drainMs: 200 })
  await waitFor(() => lines.some((l) => l.startsWith('gup ')))
  const grandchildPid = grandchildPidFrom(lines)

  const t0 = Date.now()
  ac.abort()
  const result = await p
  const elapsed = Date.now() - t0
  assert.ok(elapsed < 1500, `took ${elapsed}ms`)
  assert.equal(result.signal, 'SIGTERM')
  assert.equal(activeTimeouts(), timeoutsBefore, 'the 5s SIGKILL timer must not outlive the resolved promise')
  await assertGone(grandchildPid)
})

test('non-executable file → resolves with error spawn_failed and a detail message (no throw)', async () => {
  const file = path.join(cwd, 'not-executable.sh')
  writeFileSync(file, '#!/bin/sh\necho hi\n', { mode: 0o644 })
  const result = await spawnCli({ command: file, args: [], cwd, env: baseEnv, signal: new AbortController().signal, onLine: () => {} })
  assert.equal(result.error, 'spawn_failed')
  assert.equal(result.code, null)
  assert.ok(typeof result.detail === 'string' && result.detail.includes('EACCES'), result.detail)
})

test('nonexistent command → resolves with error cli_not_found and code null (no throw)', async () => {
  const result = await spawnCli({ command: path.join(cwd, 'definitely-not-a-binary'), args: ['-p'], cwd, env: baseEnv, signal: new AbortController().signal, onLine: () => {} })
  assert.equal(result.error, 'cli_not_found')
  assert.equal(result.code, null)
})
