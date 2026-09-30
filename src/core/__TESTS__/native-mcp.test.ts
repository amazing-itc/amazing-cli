import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, test } from 'node:test'
import { materializeNativeMcp, withNativeMcp } from '../native-mcp.js'

const tmpDirs: string[] = []
afterEach(() => {
  for (const dir of tmpDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function tmp(prefix: string): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), prefix))
  tmpDirs.push(dir)
  return dir
}

const servers = [
  {
    name: 'product',
    url: 'http://mcp.example/mcp',
    headers: { 'X-Run-Token': 'tok-secret-9f', 'X-Scope': 'card-1' },
  },
]

test('inheritProjectMcp false hides every workspace MCP server and restores it', async () => {
  const home = tmp('mcp-home-')
  const ws = tmp('mcp-ws-')
  await mkdir(path.join(ws, '.cursor'), { recursive: true })
  const project = path.join(ws, '.cursor', 'mcp.json')
  const original = JSON.stringify({ mcpServers: { aw: { url: 'http://board.example/mcp' }, other: { command: 'local' } } })
  writeFileSync(project, original)
  const handle = await materializeNativeMcp({
    family: 'cursor',
    homeDir: home,
    workspaceDir: ws,
    hideProjectMcp: true,
  })
  const hidden = JSON.parse(readFileSync(project, 'utf8')) as { mcpServers: Record<string, unknown> }
  assert.deepEqual(hidden.mcpServers, {})
  assert.ok(!existsSync(path.join(home, '.cursor', 'mcp.json')))
  await handle.restore()
  assert.equal(readFileSync(project, 'utf8'), original)
})

test('empty or missing servers is a no-op', async () => {
  const home = tmp('mcp-home-')
  const ws = tmp('mcp-ws-')
  const none = await materializeNativeMcp({ family: 'cursor', homeDir: home, workspaceDir: ws })
  assert.deepEqual(none.extraArgs, [])
  assert.ok(!existsSync(path.join(home, '.cursor', 'mcp.json')))
  await none.restore()
})

test('cursor writes isolated HOME mcp.json (0o600) and hides same-name project stdio, then restores', async () => {
  const home = tmp('mcp-home-')
  const ws = tmp('mcp-ws-')
  const project = path.join(ws, '.cursor', 'mcp.json')
  await mkdir(path.dirname(project), { recursive: true })
  const original = `${JSON.stringify({
    mcpServers: {
      product: { command: 'node', args: ['launcher.mjs'] },
      other: { command: 'npx', args: ['keep-me'] },
    },
  })}\n`
  writeFileSync(project, original)

  const handle = await materializeNativeMcp({ family: 'cursor', homeDir: home, workspaceDir: ws, servers })
  const homeFile = path.join(home, '.cursor', 'mcp.json')
  const written = JSON.parse(readFileSync(homeFile, 'utf8')) as {
    mcpServers: { product: { url: string; headers: Record<string, string> } }
  }
  assert.equal(written.mcpServers.product.url, 'http://mcp.example/mcp')
  assert.deepEqual(written.mcpServers.product.headers, { 'X-Run-Token': 'tok-secret-9f', 'X-Scope': 'card-1' })
  assert.equal(statSync(homeFile).mode & 0o777, 0o600)
  const during = JSON.parse(readFileSync(project, 'utf8')) as { mcpServers: Record<string, unknown> }
  assert.equal(during.mcpServers.product, undefined)
  assert.deepEqual(during.mcpServers.other, { command: 'npx', args: ['keep-me'] })
  await handle.restore()
  assert.equal(readFileSync(project, 'utf8'), original)
})

test('cursor also hides leftover stdio in workspace root .mcp.json', async () => {
  const home = tmp('mcp-home-')
  const ws = tmp('mcp-ws-')
  const rootMcp = path.join(ws, '.mcp.json')
  const original = `${JSON.stringify({ mcpServers: { product: { command: 'node' } } })}\n`
  writeFileSync(rootMcp, original)
  const handle = await materializeNativeMcp({ family: 'cursor', homeDir: home, workspaceDir: ws, servers })
  assert.equal(JSON.parse(readFileSync(rootMcp, 'utf8')).mcpServers.product, undefined)
  await handle.restore()
  assert.equal(readFileSync(rootMcp, 'utf8'), original)
})

test('claude writes type=http in HOME and hides project .mcp.json names', async () => {
  const home = tmp('mcp-home-')
  const ws = tmp('mcp-ws-')
  const project = path.join(ws, '.mcp.json')
  writeFileSync(project, JSON.stringify({ mcpServers: { product: { command: 'node' } } }))
  const handle = await materializeNativeMcp({ family: 'claude', homeDir: home, workspaceDir: ws, servers })
  const body = JSON.parse(readFileSync(path.join(home, '.claude.json'), 'utf8')) as {
    mcpServers: { product: { type: string; url: string } }
  }
  assert.equal(body.mcpServers.product.type, 'http')
  assert.equal(body.mcpServers.product.url, servers[0].url)
  assert.deepEqual(JSON.parse(readFileSync(path.join(home, '.mcp.json'), 'utf8')), body)
  assert.equal(JSON.parse(readFileSync(project, 'utf8')).mcpServers.product, undefined)
  await handle.restore()
  assert.equal(JSON.parse(readFileSync(project, 'utf8')).mcpServers.product.command, 'node')
})

test('codex writes HOME config.toml with url + http_headers', async () => {
  const home = tmp('mcp-home-')
  const ws = tmp('mcp-ws-')
  await materializeNativeMcp({ family: 'codex', homeDir: home, workspaceDir: ws, servers })
  const toml = readFileSync(path.join(home, '.codex', 'config.toml'), 'utf8')
  assert.match(toml, /\[mcp_servers\.product\]/)
  assert.match(toml, /url = "http:\/\/mcp.example\/mcp"/)
  assert.match(toml, /\[mcp_servers\.product\.http_headers\]/)
  assert.match(toml, /X-Run-Token = "tok-secret-9f"/)
  assert.ok(!existsSync(path.join(ws, '.codex')))
})

test('codex hides same-name project stdio mcp_servers then restores', async () => {
  const home = tmp('mcp-home-')
  const ws = tmp('mcp-ws-')
  const project = path.join(ws, '.codex', 'config.toml')
  await mkdir(path.dirname(project), { recursive: true })
  const original = [
    '# MCP servers (Codex)',
    '',
    '[mcp_servers.product]',
    'command = "node"',
    'args = ["scripts/aw-mcp-launcher.mjs"]',
    '',
    '[mcp_servers.product.env]',
    'AW_API_BASE_URL = "http://localhost:8080/api"',
    '',
    '[mcp_servers.other]',
    'command = "npx"',
    '',
  ].join('\n')
  writeFileSync(project, original)

  const handle = await materializeNativeMcp({ family: 'codex', homeDir: home, workspaceDir: ws, servers })
  const during = readFileSync(project, 'utf8')
  assert.equal(during.includes('[mcp_servers.product]'), false)
  assert.equal(during.includes('[mcp_servers.product.env]'), false)
  assert.match(during, /\[mcp_servers\.other\]/)
  assert.match(readFileSync(path.join(home, '.codex', 'config.toml'), 'utf8'), /url = "http:\/\/mcp.example\/mcp"/)

  await handle.restore()
  assert.equal(readFileSync(project, 'utf8'), original)
})

test('copilot writes HOME file and extraArgs JSON; withNativeMcp restores', async () => {
  const home = tmp('mcp-home-')
  const ws = tmp('mcp-ws-')
  let seen: string[] = []
  const result = await withNativeMcp('copilot', { homeDir: home, workspaceDir: ws, mcpServers: servers }, async (extra) => {
    seen = extra
    return 'ok'
  })
  assert.equal(result, 'ok')
  assert.equal(seen[0], '--additional-mcp-config')
  const payload = JSON.parse(seen[1] ?? '') as { mcpServers: { product: { url: string } } }
  assert.equal(payload.mcpServers.product.url, servers[0].url)
  assert.ok(existsSync(path.join(home, '.copilot', 'mcp-config.json')))
})

test('antigravity writes .gemini/settings.json mcpServers without touching workspace', async () => {
  const home = tmp('mcp-home-')
  const ws = tmp('mcp-ws-')
  await materializeNativeMcp({ family: 'antigravity', homeDir: home, workspaceDir: ws, servers })
  const settings = JSON.parse(readFileSync(path.join(home, '.gemini', 'settings.json'), 'utf8')) as {
    mcpServers: { product: { url: string; httpUrl: string } }
  }
  assert.equal(settings.mcpServers.product.url, servers[0].url)
  assert.equal(settings.mcpServers.product.httpUrl, servers[0].url)
  assert.ok(!existsSync(path.join(ws, '.gemini')))
})

test('external/fake families do not write CLI config', async () => {
  const home = tmp('mcp-home-')
  const ws = tmp('mcp-ws-')
  await materializeNativeMcp({ family: 'external', homeDir: home, workspaceDir: ws, servers })
  await materializeNativeMcp({ family: 'fake', homeDir: home, workspaceDir: ws, servers })
  assert.deepEqual(readdirSync(home), [])
})

test('never writes headers into the workspace tree', async () => {
  const home = tmp('mcp-home-')
  const ws = tmp('mcp-ws-')
  await mkdir(path.join(ws, '.cursor'), { recursive: true })
  writeFileSync(path.join(ws, '.cursor', 'mcp.json'), JSON.stringify({ mcpServers: { product: { command: 'x' } } }))
  const handle = await materializeNativeMcp({ family: 'cursor', homeDir: home, workspaceDir: ws, servers })
  const walk = (dir: string): string[] => {
    const out: string[] = []
    for (const name of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, name.name)
      if (name.isDirectory()) out.push(...walk(full))
      else out.push(readFileSync(full, 'utf8'))
    }
    return out
  }
  assert.ok(!walk(ws).some((text) => text.includes('tok-secret-9f')))
  await handle.restore()
})
