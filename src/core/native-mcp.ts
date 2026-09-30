import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { StartInput } from './provider.js'
import type { Family } from './types.js'

export type McpServerSpec = {
  name: string
  url: string
  headers?: Record<string, string>
}

export type NativeMcpHandle = {
  extraArgs: string[]
  restore(): Promise<void>
}

const EMPTY: NativeMcpHandle = { extraArgs: [], restore: async () => {} }

/**
 * Writes product-supplied HTTP MCP servers into the isolated HOME for a native CLI.
 * Never writes tokens into the workspace. If the project mcp file already defines
 * the same server name (e.g. leftover stdio), that name is hidden for the run and
 * restored afterwards so HOME config is what the CLI actually loads.
 */
export async function materializeNativeMcp(opts: {
  family: Family
  homeDir: string
  workspaceDir: string
  servers?: McpServerSpec[]
  /** Hide every MCP server declared in the workspace for this run, then restore. */
  hideProjectMcp?: boolean
}): Promise<NativeMcpHandle> {
  const servers = (opts.servers ?? []).filter((server) => server.name && server.url)
  if (servers.length === 0 && !opts.hideProjectMcp) return EMPTY

  const restores: Array<() => Promise<void>> = []
  const extraArgs: string[] = []
  const names = servers.map((server) => server.name)

  if (opts.hideProjectMcp) {
    if (opts.family === 'cursor') {
      restores.push(await hideAllProjectServers(path.join(opts.workspaceDir, '.cursor', 'mcp.json')))
      restores.push(await hideAllProjectServers(path.join(opts.workspaceDir, '.mcp.json')))
    } else if (opts.family === 'claude') {
      restores.push(await hideAllProjectServers(path.join(opts.workspaceDir, '.mcp.json')))
    } else if (opts.family === 'codex') {
      restores.push(await hideAllCodexProjectServers(path.join(opts.workspaceDir, '.codex', 'config.toml')))
    }
  }

  if (servers.length === 0) {
    return {
      extraArgs,
      async restore() {
        for (const undo of restores.reverse()) await undo()
      },
    }
  }

  if (opts.family === 'cursor') {
    restores.push(await hideProjectServers(path.join(opts.workspaceDir, '.cursor', 'mcp.json'), names))
    restores.push(await hideProjectServers(path.join(opts.workspaceDir, '.mcp.json'), names))
    await writeJsonFile(path.join(opts.homeDir, '.cursor', 'mcp.json'), { mcpServers: cursorServers(servers) })
  } else if (opts.family === 'claude') {
    restores.push(await hideProjectServers(path.join(opts.workspaceDir, '.mcp.json'), names))
    const payload = { mcpServers: claudeServers(servers) }
    await writeJsonFile(path.join(opts.homeDir, '.claude.json'), payload)
    await writeJsonFile(path.join(opts.homeDir, '.mcp.json'), payload)
  } else if (opts.family === 'codex') {
    restores.push(await hideCodexProjectServers(path.join(opts.workspaceDir, '.codex', 'config.toml'), names))
    await writeTextFile(path.join(opts.homeDir, '.codex', 'config.toml'), codexToml(servers))
  } else if (opts.family === 'copilot') {
    const payload = { mcpServers: cursorServers(servers) }
    const file = path.join(opts.homeDir, '.copilot', 'mcp-config.json')
    await writeJsonFile(file, payload)
    extraArgs.push('--additional-mcp-config', JSON.stringify(payload))
  } else if (opts.family === 'antigravity') {
    await writeJsonFile(path.join(opts.homeDir, '.gemini', 'settings.json'), { mcpServers: geminiServers(servers) })
  }

  return {
    extraArgs,
    async restore() {
      for (const undo of restores.reverse()) await undo()
    },
  }
}

export async function withNativeMcp<T>(
  family: Family,
  input: Pick<StartInput, 'homeDir' | 'workspaceDir' | 'mcpServers' | 'inheritProjectMcp'>,
  fn: (extraArgs: string[]) => Promise<T>,
): Promise<T> {
  const handle = await materializeNativeMcp({
    family,
    homeDir: input.homeDir,
    workspaceDir: input.workspaceDir,
    servers: input.mcpServers,
    hideProjectMcp: input.inheritProjectMcp === false,
  })
  try {
    return await fn(handle.extraArgs)
  } finally {
    await handle.restore()
  }
}

function cursorServers(servers: McpServerSpec[]): Record<string, unknown> {
  return Object.fromEntries(servers.map((server) => [server.name, httpServer(server)]))
}

function claudeServers(servers: McpServerSpec[]): Record<string, unknown> {
  return Object.fromEntries(servers.map((server) => [server.name, { type: 'http', ...httpServer(server) }]))
}

function geminiServers(servers: McpServerSpec[]): Record<string, unknown> {
  return Object.fromEntries(
    servers.map((server) => {
      const base = httpServer(server)
      return [server.name, { ...base, httpUrl: server.url }]
    }),
  )
}

function httpServer(server: McpServerSpec): Record<string, unknown> {
  const entry: Record<string, unknown> = { url: server.url }
  if (server.headers && Object.keys(server.headers).length > 0) entry.headers = { ...server.headers }
  return entry
}

function codexToml(servers: McpServerSpec[]): string {
  const blocks: string[] = []
  for (const server of servers) {
    const key = tomlKey(server.name)
    blocks.push(`[mcp_servers.${key}]`, `url = ${tomlString(server.url)}`)
    const headers = server.headers ? Object.entries(server.headers) : []
    if (headers.length > 0) {
      blocks.push(`[mcp_servers.${key}.http_headers]`)
      for (const [header, value] of headers) {
        blocks.push(`${tomlKey(header)} = ${tomlString(value)}`)
      }
    }
    blocks.push('')
  }
  return blocks.join('\n')
}

function tomlKey(name: string): string {
  return /^[A-Za-z0-9_-]+$/.test(name) ? name : JSON.stringify(name)
}

function tomlString(value: string): string {
  return JSON.stringify(value)
}

async function writeJsonFile(file: string, value: unknown): Promise<void> {
  await writeTextFile(file, `${JSON.stringify(value, null, 2)}\n`)
}

async function writeTextFile(file: string, body: string): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 })
  await writeFile(file, body, { encoding: 'utf8', mode: 0o600 })
  await chmod(file, 0o600)
}

async function hideAllProjectServers(file: string): Promise<() => Promise<void>> {
  let original: string
  try {
    original = await readFile(file, 'utf8')
  } catch {
    return async () => {}
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(original)
  } catch {
    return async () => {}
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return async () => {}
  const root = parsed as Record<string, unknown>
  const servers = root.mcpServers
  if (!servers || typeof servers !== 'object' || Array.isArray(servers)) return async () => {}
  if (Object.keys(servers as Record<string, unknown>).length === 0) return async () => {}
  await writeFile(file, `${JSON.stringify({ ...root, mcpServers: {} }, null, 2)}\n`, 'utf8')
  return async () => {
    await writeFile(file, original, 'utf8')
  }
}

async function hideAllCodexProjectServers(file: string): Promise<() => Promise<void>> {
  let original: string
  try {
    original = await readFile(file, 'utf8')
  } catch {
    return async () => {}
  }
  const names: string[] = []
  for (const line of original.split(/\r?\n/)) {
    const table = /^\[([^\]]+)\]\s*$/.exec(line)
    const serverName = table ? codexMcpServerName(table[1] ?? '') : null
    if (serverName) names.push(serverName)
  }
  if (names.length === 0) return async () => {}
  const next = stripCodexMcpServerTables(original, names)
  if (next === original) return async () => {}
  await writeFile(file, next, 'utf8')
  return async () => {
    await writeFile(file, original, 'utf8')
  }
}

async function hideProjectServers(file: string, names: string[]): Promise<() => Promise<void>> {
  let original: string
  try {
    original = await readFile(file, 'utf8')
  } catch {
    return async () => {}
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(original)
  } catch {
    return async () => {}
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return async () => {}
  const root = parsed as Record<string, unknown>
  const servers = root.mcpServers
  if (!servers || typeof servers !== 'object' || Array.isArray(servers)) return async () => {}
  const next = { ...(servers as Record<string, unknown>) }
  let changed = false
  for (const name of names) {
    if (Object.hasOwn(next, name)) {
      delete next[name]
      changed = true
    }
  }
  if (!changed) return async () => {}
  await writeFile(file, `${JSON.stringify({ ...root, mcpServers: next }, null, 2)}\n`, 'utf8')
  return async () => {
    await writeFile(file, original, 'utf8')
  }
}

/**
 * Codex merges project `.codex/config.toml` with HOME. A leftover stdio
 * `[mcp_servers.aw]` (command/args) plus HOME `url` yields
 * "url is not supported for stdio". Hide matching tables for the run.
 */
async function hideCodexProjectServers(file: string, names: string[]): Promise<() => Promise<void>> {
  let original: string
  try {
    original = await readFile(file, 'utf8')
  } catch {
    return async () => {}
  }
  const next = stripCodexMcpServerTables(original, names)
  if (next === original) return async () => {}
  await writeFile(file, next, 'utf8')
  return async () => {
    await writeFile(file, original, 'utf8')
  }
}

function stripCodexMcpServerTables(raw: string, names: string[]): string {
  if (names.length === 0) return raw
  const hide = new Set(names)
  const lines = raw.split(/\r?\n/)
  const out: string[] = []
  let skipping = false
  for (const line of lines) {
    const table = /^\[([^\]]+)\]\s*$/.exec(line)
    if (table) {
      const serverName = codexMcpServerName(table[1] ?? '')
      skipping = serverName != null && hide.has(serverName)
    }
    if (!skipping) out.push(line)
  }
  return out.join('\n')
}

function codexMcpServerName(tablePath: string): string | null {
  const match = /^mcp_servers\.([^.]+)(?:\.|$)/.exec(tablePath.trim())
  return match?.[1] ?? null
}
