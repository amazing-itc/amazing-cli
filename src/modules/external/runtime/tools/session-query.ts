import type { HarnessSession } from '../../types.js'

export function querySession(session: HarnessSession, query: string, limit = 20): string {
  const needle = (query ?? '').toLowerCase()
  const hits = session.log.filter(event => {
    const blob = `${event.type} ${JSON.stringify(event.data)}`.toLowerCase()
    return !needle || blob.includes(needle)
  })
  return hits
    .slice(-limit)
    .map(event => `#${event.seq} ${event.type} ${JSON.stringify(event.data).slice(0, 200)}`)
    .join('\n') || '(no log hits)'
}
