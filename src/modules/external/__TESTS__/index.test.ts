import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import type { StartInput } from '../../../core/provider.js'
import { RunFailure } from '../../../core/errors.js'
import { sessionFileForHome } from '../../../core/session-store.js'
import type { EventType, RunRecord } from '../../../core/types.js'
import { createExternalProvider } from '../index.js'
import { MODEL_CACHE_MS } from '../models.js'

function sseResponse(text: string, status = 200): Response {
  const body = `data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\ndata: [DONE]\n\n`
  return new Response(body, { status, headers: { 'content-type': 'text/event-stream' } })
}

function makeRun(prompt: string, id = 'r1'): RunRecord {
  return {
    id,
    product: 'demo',
    family: 'external',
    status: 'RUNNING',
    modelId: 'gpt-4o-mini',
    workspaceDir: '/tmp/ws',
    prompt,
    createdAt: new Date().toISOString(),
    lastSeq: 0,
  }
}

async function makeInput(
  prompt: string,
  signal: AbortSignal,
  homeDir: string,
): Promise<{ input: StartInput; events: Array<{ type: EventType; data: unknown }> }> {
  await mkdir(homeDir, { recursive: true })
  const events: Array<{ type: EventType; data: unknown }> = []
  const input: StartInput = {
    run: makeRun(prompt),
    workspaceDir: homeDir,
    homeDir,
    signal,
    emit: (type, data) => events.push({ type, data }),
  }
  return { input, events }
}

test('capabilities omit binary and health is 2xx via /health', async () => {
  const p = createExternalProvider({
    litellmBaseUrl: 'http://litellm.test',
    masterKey: 'sk-test',
    fetch: async (url) => {
      assert.match(String(url), /\/health$/)
      return new Response('ok', { status: 200 })
    },
  })
  assert.deepEqual(p.capabilities(), {
    family: 'external',
    streaming: true,
    resume: true,
    models: 'remote',
    permissions: [],
  })
  assert.equal('binary' in p.capabilities(), false)
  assert.deepEqual(await p.health(), { available: true })
})

test('stream emits assistant/delta and succeeds', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ext-delta-'))
  const homeDir = join(root, 'home')
  let posted: {
    url: string
    auth: string | null
    body: { stream?: boolean; model?: string; tools?: Array<{ function?: { name?: string } }> }
  } | undefined
  const p = createExternalProvider({
    litellmBaseUrl: 'http://litellm.test',
    masterKey: 'sk-test',
    fetch: async (url, init) => {
      posted = {
        url: String(url),
        auth: new Headers(init?.headers).get('authorization'),
        body: JSON.parse(String(init?.body ?? '{}')),
      }
      return sseResponse('hello')
    },
  })
  const { input, events } = await makeInput('hi', new AbortController().signal, homeDir)
  const result = await p.start(input)
  assert.equal(result.status, 'SUCCEEDED')
  assert.equal(result.sessionRef, 'r1')
  assert.match(posted?.url ?? '', /\/v1\/chat\/completions$/)
  assert.equal(posted?.auth, 'Bearer sk-test')
  assert.equal(posted?.body.stream, true)
  assert.equal(posted?.body.model, 'gpt-4o-mini')
  assert.ok(!(posted?.body.tools ?? []).some((tool) => tool.function?.name === 'mcp'))
  const deltas = events.filter((e) => e.type === 'assistant/delta')
  assert.ok(deltas.length >= 1)
  assert.equal((deltas[0].data as { text: string }).text, 'hello')
  assert.ok(!events.some((e) => e.type.startsWith('run/')))
})

test('sessionRef resume across isolated HOMEs without runDirFor', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ext-resume-'))
  const home1 = join(root, 'runs', 'r1', 'home')
  const home2 = join(root, 'runs', 'r2', 'home')
  await mkdir(home1, { recursive: true })
  await mkdir(home2, { recursive: true })
  const bodies: Array<{ messages?: Array<{ role: string; content?: string }> }> = []
  let starts = 0
  const fetchFn: typeof fetch = async (_url, init) => {
    starts += 1
    bodies.push(JSON.parse(String(init?.body ?? '{}')) as { messages?: Array<{ role: string; content?: string }> })
    return sseResponse(starts === 1 ? 'first-turn' : 'second-turn')
  }
  const p = createExternalProvider({ litellmBaseUrl: 'http://litellm.test', masterKey: 'sk', fetch: fetchFn })

  const first = await p.start({
    run: makeRun('hello', 'r1'),
    workspaceDir: home1,
    homeDir: home1,
    signal: new AbortController().signal,
    emit: () => {},
  })
  assert.equal(first.status, 'SUCCEEDED')

  const secondRun = makeRun('continue', 'r2')
  secondRun.sessionRef = 'r1'
  const second = await p.start({
    run: secondRun,
    workspaceDir: home2,
    homeDir: home2,
    signal: new AbortController().signal,
    emit: () => {},
  })
  assert.equal(second.status, 'SUCCEEDED')
  assert.equal(second.sessionRef, 'r1')
  const messages = bodies[1]?.messages ?? []
  assert.ok(
    messages.some((m) => m.role === 'assistant' && m.content === 'first-turn'),
    'second request must include the first assistant turn',
  )
  const lastUser = [...messages].reverse().find((m) => m.role === 'user')
  assert.equal(lastUser?.content, 'continue')
})

test('JSONL session survives a second Provider.start on the same homeDir', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ext-jsonl-'))
  const homeDir = join(root, 'home')
  const bodies: Array<{ messages?: Array<{ role: string; content?: string }> }> = []
  let starts = 0
  const fetchFn: typeof fetch = async (_url, init) => {
    starts += 1
    const body = JSON.parse(String(init?.body ?? '{}')) as { messages?: Array<{ role: string; content?: string }> }
    bodies.push(body)
    return sseResponse(starts === 1 ? 'first-turn' : 'second-turn')
  }
  const p1 = createExternalProvider({ litellmBaseUrl: 'http://litellm.test', masterKey: 'sk', fetch: fetchFn })
  const first = await makeInput('hello', new AbortController().signal, homeDir)
  const r1 = await p1.start(first.input)
  assert.equal(r1.status, 'SUCCEEDED')
  const sessionPath = sessionFileForHome(homeDir)
  assert.equal(existsSync(sessionPath), true)

  const p2 = createExternalProvider({ litellmBaseUrl: 'http://litellm.test', masterKey: 'sk', fetch: fetchFn })
  const second = await makeInput('hello', new AbortController().signal, homeDir)
  const r2 = await p2.start(second.input)
  assert.equal(r2.status, 'SUCCEEDED')
  const secondMessages = bodies[1]?.messages ?? []
  assert.ok(
    secondMessages.some((m) => m.role === 'assistant' && m.content === 'first-turn'),
    'rebuild must include the first assistant turn',
  )
})

test('429 then 200 emits llm/retry and SUCCEEDED', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ext-429-'))
  const homeDir = join(root, 'home')
  let n = 0
  const p = createExternalProvider({
    litellmBaseUrl: 'http://litellm.test',
    masterKey: 'sk',
    fetch: async () => {
      n += 1
      if (n === 1) return new Response('slow down', { status: 429 })
      return sseResponse('recovered')
    },
  })
  const { input, events } = await makeInput('go', new AbortController().signal, homeDir)
  const result = await p.start(input)
  assert.equal(result.status, 'SUCCEEDED')
  const retry = events.find((e) => e.type === 'llm/retry')
  assert.ok(retry)
  assert.deepEqual(retry.data, { attempt: 1, delayMs: 500, status: 429 })
})

test('401 → FAILED credential_invalid, no retry', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ext-401-'))
  const homeDir = join(root, 'home')
  let n = 0
  const p = createExternalProvider({
    litellmBaseUrl: 'http://litellm.test',
    masterKey: 'sk',
    fetch: async () => {
      n += 1
      return new Response('nope', { status: 401 })
    },
  })
  const { input, events } = await makeInput('go', new AbortController().signal, homeDir)
  const result = await p.start(input)
  assert.equal(result.status, 'FAILED')
  assert.equal(result.error?.code, 'credential_invalid')
  assert.equal(n, 1)
  assert.ok(!events.some((e) => e.type === 'llm/retry'))
})

test('abort during a hanging fetch → CANCELLED', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ext-abort-'))
  const homeDir = join(root, 'home')
  const ac = new AbortController()
  const p = createExternalProvider({
    litellmBaseUrl: 'http://litellm.test',
    masterKey: 'sk',
    fetch: (_url, init) =>
      new Promise((_, reject) => {
        init?.signal?.addEventListener(
          'abort',
          () => {
            const err = new Error('aborted')
            err.name = 'AbortError'
            reject(err)
          },
          { once: true },
        )
      }),
  })
  const { input } = await makeInput('hang', ac.signal, homeDir)
  const started = p.start(input)
  await new Promise((r) => setTimeout(r, 20))
  ac.abort()
  const result = await started
  assert.equal(result.status, 'CANCELLED')
})

test('listModels normalizes LiteLLM payloads, caches 60s, and throws litellm_unavailable when down', async () => {
  let now = 0
  const hits: string[] = []
  const p = createExternalProvider({
    litellmBaseUrl: 'http://litellm.test',
    masterKey: 'sk',
    now: () => now,
    fetch: async (url) => {
      hits.push(String(url))
      if (String(url).endsWith('/v1/models')) {
        return Response.json({ data: [{ id: 'gpt-4o-mini', owned_by: 'openai' }] })
      }
      if (String(url).endsWith('/model/info')) {
        return Response.json({
          data: [
            {
              model_name: 'gpt-4o-mini',
              model_info: { mode: 'chat', max_input_tokens: 128000, input_cost_per_token: 1, output_cost_per_token: 2 },
            },
          ],
        })
      }
      return new Response('no', { status: 404 })
    },
  })
  assert.ok(p.listModels)
  const models = await p.listModels()
  assert.deepEqual(models, [
    { id: 'gpt-4o-mini', provider: 'openai', mode: 'chat', maxInputTokens: 128000, pricing: { input: 1, output: 2 } },
  ])
  await p.listModels()
  assert.equal(hits.filter((u) => u.endsWith('/v1/models')).length, 1)
  now = MODEL_CACHE_MS
  await p.listModels()
  assert.equal(hits.filter((u) => u.endsWith('/v1/models')).length, 2)

  const down = createExternalProvider({
    litellmBaseUrl: 'http://litellm.test',
    fetch: async () => {
      throw new TypeError('fetch failed')
    },
  })
  await assert.rejects(
    () => down.listModels!(),
    (err: unknown) => err instanceof RunFailure && err.error.code === 'litellm_unavailable',
  )
})

test('start wires mode into tools and plan system prompt', async () => {
  type ToolBody = {
    tools?: Array<{ function?: { name?: string; parameters?: { properties?: { action?: { enum?: string[] } } } } }>
    messages?: Array<{ role: string; content?: string }>
  }
  async function capture(mode?: 'ask' | 'plan' | 'agent'): Promise<ToolBody> {
    const root = await mkdtemp(join(tmpdir(), 'ext-mode-'))
    const homeDir = join(root, 'home')
    let body: ToolBody = {}
    const p = createExternalProvider({
      litellmBaseUrl: 'http://litellm.test',
      masterKey: 'sk',
      fetch: async (_url, init) => {
        body = JSON.parse(String(init?.body ?? '{}')) as ToolBody
        return sseResponse('ok')
      },
    })
    const { input } = await makeInput('hi', new AbortController().signal, homeDir)
    if (mode) input.run.mode = mode
    const result = await p.start(input)
    assert.equal(result.status, 'SUCCEEDED')
    return body
  }

  const ask = await capture('ask')
  assert.ok(!(ask.tools ?? []).some((t) => t.function?.name === 'shell'))
  const askFs = (ask.tools ?? []).find((t) => t.function?.name === 'fs')
  assert.deepEqual(askFs?.function?.parameters?.properties?.action?.enum, ['read', 'list', 'grep'])

  const plan = await capture('plan')
  assert.ok(!(plan.tools ?? []).some((t) => t.function?.name === 'shell'))
  const planFs = (plan.tools ?? []).find((t) => t.function?.name === 'fs')
  assert.deepEqual(planFs?.function?.parameters?.properties?.action?.enum, ['read', 'list', 'grep'])
  const system = plan.messages?.find((m) => m.role === 'system')?.content ?? ''
  assert.match(system, /plan/i)
  assert.match(system, /not (apply|make|perform).*(edit|change)/i)

  for (const mode of ['agent', undefined] as const) {
    const body = await capture(mode)
    assert.ok((body.tools ?? []).some((t) => t.function?.name === 'shell'))
    const fs = (body.tools ?? []).find((t) => t.function?.name === 'fs')
    assert.deepEqual(fs?.function?.parameters?.properties?.action?.enum, ['read', 'write', 'list', 'grep'])
  }
})

