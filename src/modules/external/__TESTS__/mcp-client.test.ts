import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { mkdir, mkdtemp } from 'node:fs/promises'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js'
import { z } from 'zod'
import { createDispatcher } from '../../../core/dispatcher.js'
import { createEventLog } from '../../../core/events.js'
import { createHomeManager } from '../../../core/home.js'
import { createQueue } from '../../../core/queue.js'
import { createRedactor } from '../../../core/redact.js'
import { createRegistry } from '../../../core/registry.js'
import { createSessionRegistry } from '../../../core/session-registry.js'
import type { Family, RunRecord } from '../../../core/types.js'
import type { Provider } from '../../../core/provider.js'
import { createWorkspaceResolver } from '../../../core/workspace.js'
import { createExternalProvider } from '../index.js'
import { connectMcpServers, publicMcpName } from '../mcp-client.js'

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  for await (const chunk of req) chunks.push(chunk as Buffer)
  const text = Buffer.concat(chunks).toString('utf8').trim()
  return text ? JSON.parse(text) : undefined
}

async function startFakeMcpServer(onAddNote: (args: Record<string, unknown>) => void): Promise<{
  url: string
  close: () => Promise<void>
}> {
  const transports = new Map<string, StreamableHTTPServerTransport>()

  function createMcp(): McpServer {
    const mcp = new McpServer({ name: 'fixture', version: '1.0.0' })
    mcp.registerTool(
      'add_note',
      { description: 'Add a note', inputSchema: { text: z.string() } },
      async ({ text }) => {
        onAddNote({ text })
        return { content: [{ type: 'text', text: `noted:${text}` }] }
      },
    )
    mcp.registerTool(
      'wipe',
      { description: 'Wipe data', annotations: { destructiveHint: true } },
      async () => ({ content: [{ type: 'text', text: 'wiped' }] }),
    )
    return mcp
  }

  const httpServer = createServer((req, res) => {
    void handle(req, res)
  })

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const rawSid = req.headers['mcp-session-id']
    const sessionId = Array.isArray(rawSid) ? rawSid[0] : rawSid
    try {
      if (sessionId && transports.has(sessionId)) {
        const body = req.method === 'POST' ? await readBody(req) : undefined
        await transports.get(sessionId)!.handleRequest(req, res, body)
        return
      }
      if (req.method !== 'POST') {
        res.writeHead(400).end()
        return
      }
      const body = await readBody(req)
      if (!isInitializeRequest(body)) {
        res.writeHead(400, { 'content-type': 'application/json' }).end(
          JSON.stringify({ jsonrpc: '2.0', error: { code: -32000, message: 'no session' }, id: null }),
        )
        return
      }
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        enableJsonResponse: true,
        onsessioninitialized: (id) => {
          transports.set(id, transport)
        },
      })
      transport.onclose = () => {
        const id = transport.sessionId
        if (id) transports.delete(id)
      }
      await createMcp().connect(transport)
      await transport.handleRequest(req, res, body)
    } catch (err) {
      if (!res.headersSent) res.writeHead(500).end(String(err))
    }
  }

  await new Promise<void>((resolve) => httpServer.listen(0, '127.0.0.1', resolve))
  const addr = httpServer.address()
  if (!addr || typeof addr === 'string') throw new Error('expected TCP address')
  return {
    url: `http://127.0.0.1:${addr.port}/mcp`,
    close: () =>
      new Promise<void>((resolve, reject) => {
        for (const transport of transports.values()) void transport.close()
        httpServer.close((err) => (err ? reject(err) : resolve()))
      }),
  }
}

test('public names are mcp__{server}__{tool} from the server name, not a product tool list', () => {
  assert.equal(publicMcpName('aw', 'add_note'), 'mcp__aw__add_note')
  assert.equal(publicMcpName('vector', 'add_note'), 'mcp__vector__add_note')
})

test('connectMcpServers lists namespaced tools, calls add_note, and marks destructiveHint exclusive', async () => {
  const received: Array<Record<string, unknown>> = []
  const server = await startFakeMcpServer((args) => received.push(args))
  const mcp = await connectMcpServers([{ name: 'aw', url: server.url }])
  try {
    const names = mcp.schemas.map((schema) => schema.function.name)
    assert.ok(names.includes('mcp__aw__add_note'))
    assert.ok(names.includes('mcp__aw__wipe'))
    assert.ok(!names.includes('add_note'))
    assert.equal(mcp.exclusive.has('mcp__aw__wipe'), true)
    assert.equal(mcp.exclusive.has('mcp__aw__add_note'), false)
    const result = await mcp.callTool('mcp__aw__add_note', { text: 'from-client' })
    assert.equal(result, 'noted:from-client')
    assert.deepEqual(received, [{ text: 'from-client' }])
  } finally {
    await mcp.close()
    await server.close()
  }
})

test('model call mcp__aw__add_note reaches the in-process MCP server named aw', async () => {
  const received: Array<Record<string, unknown>> = []
  const server = await startFakeMcpServer((args) => received.push(args))
  const root = await mkdtemp(join(tmpdir(), 'ext-mcp-'))
  const homeDir = join(root, 'home')
  await mkdir(homeDir, { recursive: true })
  const bodies: Array<{ tools?: Array<{ function?: { name?: string } }> }> = []
  let turns = 0
  const sse = (payload: unknown) =>
    new Response(`data: ${JSON.stringify(payload)}\n\ndata: [DONE]\n\n`, {
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
    })
  try {
    const p = createExternalProvider({
      litellmBaseUrl: 'http://litellm.test',
      masterKey: 'sk',
      fetch: async (_url, init) => {
        turns += 1
        bodies.push(JSON.parse(String(init?.body ?? '{}')))
        if (turns === 1) {
          return sse({
            choices: [
              {
                delta: {
                  tool_calls: [
                    {
                      index: 0,
                      id: 'call_note',
                      function: { name: 'mcp__aw__add_note', arguments: JSON.stringify({ text: 'hello-note' }) },
                    },
                  ],
                },
              },
            ],
          })
        }
        return sse({ choices: [{ delta: { content: 'done' } }] })
      },
    })
    const run: RunRecord = {
      id: 'r1',
      product: 'demo',
      family: 'external',
      status: 'RUNNING',
      modelId: 'gpt-4o-mini',
      workspaceDir: homeDir,
      prompt: 'leave a note',
      createdAt: new Date().toISOString(),
      lastSeq: 0,
    }
    const result = await p.start({
      run,
      workspaceDir: homeDir,
      homeDir,
      mcpServers: [{ name: 'aw', url: server.url }],
      signal: new AbortController().signal,
      emit: () => {},
    })
    assert.equal(result.status, 'SUCCEEDED', JSON.stringify(result.error))
    assert.deepEqual(received, [{ text: 'hello-note' }])
    const names = (bodies[0]?.tools ?? []).map((tool) => tool.function?.name)
    assert.ok(names.includes('mcp__aw__add_note'))
    assert.ok(!names.includes('add_note'))
  } finally {
    await server.close()
  }
})

test('dispatcher.submit mcpServers reaches add_note and never lands in meta.json', async () => {
  const received: Array<Record<string, unknown>> = []
  const header = 'mcp-header-token-9f8e7d'
  const server = await startFakeMcpServer((args) => received.push(args))
  const dataRoot = await mkdtemp(join(tmpdir(), 'disp-mcp-e2e-'))
  const ws = await mkdtemp(join(tmpdir(), 'disp-mcp-ws-'))
  let turns = 0
  const sse = (payload: unknown) =>
    new Response(`data: ${JSON.stringify(payload)}\n\ndata: [DONE]\n\n`, {
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
    })
  const provider = createExternalProvider({
    litellmBaseUrl: 'http://litellm.test',
    masterKey: 'sk',
    fetch: async (_url, init) => {
      turns += 1
      if (turns === 1) {
        return sse({
          choices: [
            {
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    id: 'call_note',
                    function: { name: 'mcp__aw__add_note', arguments: JSON.stringify({ text: 'via-submit' }) },
                  },
                ],
              },
            },
          ],
        })
      }
      return sse({ choices: [{ delta: { content: 'done' } }] })
    },
  })
  const redactor = createRedactor()
  const registry = createRegistry({ dataRoot })
  const sessions = createSessionRegistry({ dataRoot })
  const events = createEventLog({ dataRoot, redactor })
  const providers = new Map<Family, Provider>([['external', provider]])
  const queue = createQueue({ maxConcurrent: 1, maxConcurrentPerProduct: 1, onStart: (run) => dispatcher.onStart(run) })
  const dispatcher = createDispatcher({
    registry,
    sessions,
    events,
    queue,
    workspaces: createWorkspaceResolver(new Map([['aw', ws]])),
    homes: createHomeManager({ dataRoot }),
    providers,
    redactor,
  })
  await registry.init()
  await sessions.init()
  try {
    await dispatcher.submit('aw', {
      runId: 'mcp-submit',
      family: 'external',
      prompt: 'leave a note',
      modelId: 'gpt-4o-mini',
      workspace: { product: 'aw', path: '.' },
      mcpServers: [{ name: 'aw', url: server.url, headers: { 'X-AW-Run-Token': header } }],
    })
    const t0 = Date.now()
    for (;;) {
      const record = registry.get('mcp-submit')
      if (record && record.status !== 'QUEUED' && record.status !== 'RUNNING') {
        assert.equal(record.status, 'SUCCEEDED', JSON.stringify(record.error))
        break
      }
      if (Date.now() - t0 > 5000) throw new Error(`mcp-submit still ${record?.status}`)
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    assert.deepEqual(received, [{ text: 'via-submit' }])
    const meta = readFileSync(join(dataRoot, 'runs', 'mcp-submit', 'meta.json'), 'utf8')
    assert.ok(!meta.includes('mcpServers'), meta)
    assert.ok(!meta.includes(header), meta)
    assert.ok(!meta.includes(server.url), meta)
    const log = readFileSync(join(dataRoot, 'runs', 'mcp-submit', 'events.jsonl'), 'utf8')
    assert.ok(!log.includes('mcpServers'), log)
    assert.ok(!log.includes(header), log)
  } finally {
    await server.close()
  }
})
