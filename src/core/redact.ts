const MIN_SECRET_LENGTH = 4
const MASK = '***'

export interface Redactor {
  add(secret: string): void
  remove(secret: string): void
  /** Deep-copies `value`, replacing every occurrence of a registered secret in any string with `***`. */
  redact<T>(value: T): T
}

export function redactString(text: string, secrets: Iterable<string>): string {
  let out = text
  for (const s of secrets) if (s.length >= MIN_SECRET_LENGTH) out = out.split(s).join(MASK)
  return out
}

function walk(value: unknown, secrets: Set<string>): unknown {
  if (typeof value === 'string') return redactString(value, secrets)
  if (Array.isArray(value)) return value.map((v) => walk(v, secrets))
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value)) out[k] = walk(v, secrets)
    return out
  }
  return value
}

export function createRedactor(): Redactor {
  const secrets = new Set<string>()
  return {
    add(secret) {
      if (secret.length >= MIN_SECRET_LENGTH) secrets.add(secret)
    },
    remove(secret) {
      secrets.delete(secret)
    },
    redact<T>(value: T): T {
      if (secrets.size === 0) return value
      return walk(value, secrets) as T
    },
  }
}
