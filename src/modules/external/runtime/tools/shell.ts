import { spawn } from 'node:child_process'
import { resolve } from 'node:path'

export function runShell(
  command: string,
  workspacePath: string,
  options: { timeoutMs?: number; signal?: AbortSignal } = {},
): Promise<string> {
  if (!workspacePath?.trim()) {
    return Promise.reject(new Error('shell: workspacePath is required'))
  }
  if (options.signal?.aborted) {
    return Promise.reject(new Error('shell: aborted'))
  }
  if (!command?.trim()) {
    return Promise.reject(new Error('shell: command is required'))
  }
  const cwd = resolve(workspacePath)
  const timeoutMs = options.timeoutMs ?? 30_000
  return new Promise((ok, fail) => {
    const child = spawn(command, {
      cwd,
      shell: true,
      env: { ...process.env, PWD: cwd },
    })
    let stdout = ''
    let stderr = ''
    const timer = setTimeout(() => {
      child.kill('SIGTERM')
      fail(new Error(`shell: timeout ${timeoutMs}ms`))
    }, timeoutMs)
    const onAbort = () => {
      child.kill('SIGTERM')
      fail(new Error('shell: aborted'))
    }
    options.signal?.addEventListener('abort', onAbort, { once: true })
    child.stdout?.on('data', chunk => {
      stdout += String(chunk)
    })
    child.stderr?.on('data', chunk => {
      stderr += String(chunk)
    })
    child.on('error', error => {
      clearTimeout(timer)
      fail(error)
    })
    child.on('close', code => {
      clearTimeout(timer)
      options.signal?.removeEventListener('abort', onAbort)
      ok(`exit ${code}\n${stdout}${stderr}`.trim())
    })
  })
}
