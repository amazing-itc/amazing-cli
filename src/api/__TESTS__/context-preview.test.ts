import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { after, before, test } from 'node:test'
import type { ContextUsage } from '../../core/context-manifest.js'
import { createTestApp, type TestApp } from '../../test-support/app.js'
import { call } from '../../test-support/client.js'
import { createOpenApiValidator } from '../../test-support/openapi-validator.js'

const validator = createOpenApiValidator()
let app: TestApp

before(async () => {
  app = await createTestApp()
})
after(() => app.destroy())

test('POST /v1/context/preview returns ContextUsage; folder does not count children; native window is null', async () => {
  const ws = app.workspaceRoots.get('aw')!
  const folder = join(ws, 'bundle')
  mkdirSync(folder)
  writeFileSync(join(folder, 'fat.txt'), 'y'.repeat(50_000))

  const res = await call(app, 'aw', 'POST', '/v1/context/preview', {
    family: 'cursor',
    modelId: 'cursor-grok-4.6-high',
    mode: 'ask',
    workspacePath: ws,
    prompt: 'draft',
    attachments: [{ kind: 'folder', path: folder, name: 'bundle' }],
  })
  assert.equal(res.status, 200, JSON.stringify(res.body))
  validator.assertValid('ContextUsage', res.body)
  const usage = res.body as ContextUsage
  assert.equal(usage.precision, 'estimate')
  assert.equal(usage.contextWindow, null)
  assert.equal(usage.usedTokens, Object.values(usage.categories).reduce((a, b) => a + b, 0))
  assert.equal(usage.categories.toolDefinitions, 0)
  assert.ok(usage.categories.conversation < Math.ceil(50_000 / 4) / 2)
  assert.equal(JSON.stringify(usage).includes('256000'), false)
})

test('POST /v1/context/preview external includes toolDefinitions from mode', async () => {
  const ws = app.workspaceRoots.get('aw')!
  const agent = await call(app, 'aw', 'POST', '/v1/context/preview', {
    family: 'external',
    mode: 'agent',
    workspace: { path: ws },
    prompt: 'hi',
  })
  const ask = await call(app, 'aw', 'POST', '/v1/context/preview', {
    family: 'external',
    mode: 'ask',
    workspace: { path: ws },
    prompt: 'hi',
  })
  assert.equal(agent.status, 200)
  assert.equal(ask.status, 200)
  const agentUsage = agent.body as ContextUsage
  const askUsage = ask.body as ContextUsage
  assert.ok(agentUsage.categories.toolDefinitions > askUsage.categories.toolDefinitions)
})
