/** Per-key FIFO: `run(key, task)` starts `task` only after every earlier task for the same key settled. */
export function createSerializer() {
  const chains = new Map<string, Promise<unknown>>()
  return function run<T>(key: string, task: () => Promise<T>): Promise<T> {
    const prev = chains.get(key) ?? Promise.resolve()
    const next = prev.then(task, task)
    chains.set(key, next)
    return next
  }
}
