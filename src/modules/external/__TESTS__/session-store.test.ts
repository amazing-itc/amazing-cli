import assert from 'node:assert/strict'
import { mkdtemp, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createSessionStore } from '../../../core/session-store.js'
import { compactIfNeeded } from '../runtime/compaction.js'
import { createSession } from '../runtime/session.js'
import { measureTokens } from '../runtime/token-meter.js'

test('JSONL rebuild honours compaction/end messages', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ext-store-'))
  const homeDir = join(root, 'home')
  await mkdir(homeDir, { recursive: true })
  const store = createSessionStore(join(root, 'session.jsonl'))
  const session = createSession({
    prompt: 'seed',
    workspacePath: '',
    contextWindow: 80,
    persist: (event) => store.append(event),
  })
  session.messages = Array.from({ length: 40 }, (_, i) => ({ role: 'user' as const, content: 'x'.repeat(20) + i }))
  const result = compactIfNeeded(session, measureTokens(session.messages), { thresholdRatio: 0.8, retainRatio: 0.16 })
  assert.equal(result.didCompact, true)

  const rebuilt = store.rebuild()
  assert.ok(rebuilt.some((message) => String(message.content ?? '').includes('compacted-summary')))
  assert.equal(rebuilt.length, session.messages.length)
  assert.deepEqual(
    rebuilt.map((m) => m.content),
    session.messages.map((m) => m.content),
  )
})
