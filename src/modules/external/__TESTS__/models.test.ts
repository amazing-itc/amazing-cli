import assert from 'node:assert/strict'
import { test } from 'node:test'
import { RunFailure } from '../../../core/errors.js'
import { createModelCatalog, MODEL_CACHE_MS, normalizeModels } from '../models.js'

test('normalizeModels joins /v1/models with /model/info', () => {
  const models = normalizeModels(
    { data: [{ id: 'gpt-4o-mini', owned_by: 'openai' }] },
    {
      data: [
        {
          model_name: 'gpt-4o-mini',
          litellm_params: { custom_llm_provider: 'openai' },
          model_info: {
            mode: 'chat',
            max_input_tokens: 128000,
            input_cost_per_token: 0.00015,
            output_cost_per_token: 0.0006,
          },
        },
      ],
    },
  )
  assert.deepEqual(models, [
    {
      id: 'gpt-4o-mini',
      provider: 'openai',
      mode: 'chat',
      maxInputTokens: 128000,
      pricing: { input: 0.00015, output: 0.0006 },
    },
  ])
})

test('listModels caches for 60s and throws litellm_unavailable when down', async () => {
  let now = 1_000
  const hits: string[] = []
  const catalog = createModelCatalog({
    baseUrl: 'http://litellm.test',
    masterKey: 'sk',
    now: () => now,
    fetch: async (url) => {
      hits.push(String(url))
      if (String(url).endsWith('/v1/models')) {
        return Response.json({ data: [{ id: 'm1', owned_by: 'openai' }] })
      }
      if (String(url).endsWith('/model/info')) {
        return Response.json({ data: [{ model_name: 'm1', model_info: { mode: 'chat', max_input_tokens: 8 } }] })
      }
      return new Response('no', { status: 404 })
    },
  })
  const first = await catalog.listModels()
  const second = await catalog.listModels()
  assert.deepEqual(first, [{ id: 'm1', provider: 'openai', mode: 'chat', maxInputTokens: 8 }])
  assert.equal(second, first)
  assert.equal(hits.filter((u) => u.endsWith('/v1/models')).length, 1)
  assert.equal(MODEL_CACHE_MS, 60_000)

  now += MODEL_CACHE_MS
  await catalog.listModels()
  assert.equal(hits.filter((u) => u.endsWith('/v1/models')).length, 2)

  const down = createModelCatalog({
    baseUrl: 'http://litellm.test',
    masterKey: 'sk',
    fetch: async () => {
      throw new TypeError('fetch failed')
    },
  })
  await assert.rejects(
    () => down.listModels(),
    (err: unknown) => err instanceof RunFailure && err.error.code === 'litellm_unavailable',
  )
})
