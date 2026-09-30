import assert from 'node:assert/strict'
import { test } from 'node:test'
import { appendLog, createSession } from '../session.js'

test('session log is append-only and sequenced', () => {
  const session = createSession({ prompt: 'hi', workspacePath: '' })
  appendLog(session, 'step/start', { step: 1 })
  assert.equal(session.log[0].seq, 1)
  assert.equal(session.log.at(-1)?.seq, session.log.length)
  assert.equal(session.messages[0].role, 'system')
  assert.equal(session.messages[1].content, 'hi')
})
