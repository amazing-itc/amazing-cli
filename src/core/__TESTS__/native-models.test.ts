import assert from 'node:assert/strict'
import test from 'node:test'
import { listNativeModels, mergeNativeModels, parseModelListOutput } from '../native-models.js'

test('parseModelListOutput reads lines, json arrays and { models }', () => {
  assert.deepEqual(parseModelListOutput('cursor-grok-4.6-high\ncomposer-2.5\n'), [
    'cursor-grok-4.6-high',
    'composer-2.5',
  ])
  assert.deepEqual(parseModelListOutput('Available models:\n- gpt-5.6\n'), ['gpt-5.6'])
  assert.deepEqual(parseModelListOutput(JSON.stringify([{ id: 'a' }, { model: 'b' }])), ['a', 'b'])
  assert.deepEqual(parseModelListOutput(JSON.stringify({ models: [{ name: 'c' }] })), ['c'])
})

test('mergeNativeModels keeps catalog labels and appends live ids', () => {
  const models = mergeNativeModels('cursor', ['cursor-grok-4.6-high', 'new-model'])
  const grok = models.find((model) => model.id === 'cursor-grok-4.6-high')
  const extra = models.find((model) => model.id === 'new-model')
  assert.equal(grok?.label, 'Grok 4.6')
  assert.equal(grok?.default, true)
  assert.equal(grok?.provider, 'cursor')
  assert.equal(extra?.label, 'New Model')
  assert.equal(models.filter((model) => model.default).length, 1)
})

test('listNativeModels falls back to the catalog when discovery throws', async () => {
  const models = await listNativeModels('claude', async () => {
    throw new Error('cli down')
  })
  assert.equal(models.find((model) => model.default)?.id, 'sonnet')
  assert.ok(models.every((model) => model.provider === 'claude'))
})

test('listNativeModels skips discovery when AMAZING_CLI_LLM_DISCOVER=0', async () => {
  const previous = process.env.AMAZING_CLI_LLM_DISCOVER
  process.env.AMAZING_CLI_LLM_DISCOVER = '0'
  try {
    let called = false
    const models = await listNativeModels('codex', async () => {
      called = true
      return ['should-not-appear']
    })
    assert.equal(called, false)
    assert.equal(models.find((model) => model.default)?.id, 'gpt-5.6-sol')
  } finally {
    if (previous === undefined) delete process.env.AMAZING_CLI_LLM_DISCOVER
    else process.env.AMAZING_CLI_LLM_DISCOVER = previous
  }
})
