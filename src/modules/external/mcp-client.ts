import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'

export type McpServerRef = { name: string; url: string; headers?: Record<string, string> }

export type OpenAiToolSchema = {
  type: 'function'
  function: { name: string; description: string; parameters: Record<string, unknown> }
}

export type McpSession = {
  schemas: OpenAiToolSchema[]
  exclusive: ReadonlySet<string>
  callTool(name: string, args: Record<string, unknown>): Promise<string>
  close(): Promise<void>
}

export function publicMcpName(server: string, tool: string): string {
  return `mcp__${server}__${tool}`
}

export async function connectMcpServers(servers: McpServerRef[]): Promise<McpSession> {
  const clients: Client[] = []
  const schemas: OpenAiToolSchema[] = []
  const exclusive = new Set<string>()
  const owners = new Map<string, { client: Client; tool: string }>()

  try {
    for (const server of servers) {
      const transport = new StreamableHTTPClientTransport(new URL(server.url), {
        requestInit: { headers: server.headers },
      })
      const client = new Client({ name: 'amazing-cli', version: '0.1.0' })
      await client.connect(transport)
      clients.push(client)

      let cursor: string | undefined
      do {
        const page = await client.listTools(cursor ? { cursor } : undefined)
        for (const tool of page.tools) {
          const name = publicMcpName(server.name, tool.name)
          const parameters =
            tool.inputSchema && typeof tool.inputSchema === 'object'
              ? (tool.inputSchema as Record<string, unknown>)
              : { type: 'object', properties: {} }
          schemas.push({
            type: 'function',
            function: { name, description: tool.description ?? '', parameters },
          })
          if (tool.annotations?.destructiveHint) exclusive.add(name)
          owners.set(name, { client, tool: tool.name })
        }
        cursor = page.nextCursor
      } while (cursor)
    }
  } catch (err) {
    await closeAll(clients)
    throw err
  }

  return {
    schemas,
    exclusive,
    async callTool(name, args) {
      const owner = owners.get(name)
      if (!owner) throw new Error(`unknown tool ${name}`)
      const result = await owner.client.callTool({ name: owner.tool, arguments: args })
      return formatToolResult(result)
    },
    async close() {
      await closeAll(clients)
    },
  }
}

async function closeAll(clients: Client[]): Promise<void> {
  await Promise.all(clients.map((client) => client.close().catch(() => undefined)))
}

function formatToolResult(result: unknown): string {
  if (!result || typeof result !== 'object') return String(result)
  const rec = result as { content?: unknown; structuredContent?: unknown; isError?: boolean }
  const parts: string[] = []
  if (Array.isArray(rec.content)) {
    for (const block of rec.content) {
      if (block && typeof block === 'object' && 'type' in block && (block as { type: unknown }).type === 'text') {
        const text = (block as { text?: unknown }).text
        if (typeof text === 'string') parts.push(text)
      } else {
        parts.push(JSON.stringify(block))
      }
    }
  }
  if (parts.length === 0 && rec.structuredContent !== undefined) {
    parts.push(typeof rec.structuredContent === 'string' ? rec.structuredContent : JSON.stringify(rec.structuredContent))
  }
  const text = parts.join('\n')
  if (rec.isError) return text || 'mcp tool error'
  return text
}
