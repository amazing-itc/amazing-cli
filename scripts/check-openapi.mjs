#!/usr/bin/env node
// OpenAPI gate (dev-only deps: yaml). Checks, against <root>/openapi.yaml:
//   (a) `openapi` is 3.1.x
//   (b) every path has >= 1 operation and every operation has `responses`
//   (c) every local `$ref` ("#/...") resolves
//   (d) the route set {method, path} equals `ROUTES` exported by dist/api/routes.js (run after `npm run build`)
// Usage: node scripts/check-openapi.mjs [--root <dir>]
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { parse } from 'yaml'

const args = process.argv.slice(2)
const rootIdx = args.indexOf('--root')
const root = rootIdx >= 0 && args[rootIdx + 1]
  ? path.resolve(args[rootIdx + 1])
  : path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

const specPath = path.join(root, 'openapi.yaml')
const routesPath = path.join(root, 'dist', 'api', 'routes.js')
for (const [what, file] of [['openapi.yaml', specPath], ['dist/api/routes.js (run npm run build first)', routesPath]]) {
  if (!existsSync(file)) {
    console.error(`check-openapi: missing ${what} at ${file}`)
    process.exit(2)
  }
}

const METHODS = new Set(['get', 'put', 'post', 'delete', 'patch', 'head', 'options', 'trace'])
const problems = []
const doc = parse(readFileSync(specPath, 'utf8'))

if (typeof doc?.openapi !== 'string' || !doc.openapi.startsWith('3.1')) problems.push(`openapi must be 3.1.x, got ${JSON.stringify(doc?.openapi)}`)

const documented = new Set()
for (const [p, item] of Object.entries(doc?.paths ?? {})) {
  const ops = Object.entries(item ?? {}).filter(([k]) => METHODS.has(k))
  if (ops.length === 0) problems.push(`path ${p} has no operation`)
  for (const [method, op] of ops) {
    if (!op || typeof op !== 'object' || !op.responses || Object.keys(op.responses).length === 0) problems.push(`${method.toUpperCase()} ${p} has no responses`)
    documented.add(`${method.toUpperCase()} ${p}`)
  }
}

function resolvePointer(ref) {
  let node = doc
  for (const raw of ref.slice(2).split('/')) {
    const key = raw.replace(/~1/g, '/').replace(/~0/g, '~')
    if (node === null || typeof node !== 'object' || !(key in node)) return false
    node = node[key]
  }
  return true
}

function walkRefs(node, at) {
  if (Array.isArray(node)) return node.forEach((v, i) => walkRefs(v, `${at}[${i}]`))
  if (node === null || typeof node !== 'object') return
  for (const [k, v] of Object.entries(node)) {
    if (k === '$ref') {
      if (typeof v !== 'string' || !v.startsWith('#/')) problems.push(`${at}: only local $ref ("#/...") are supported, got ${JSON.stringify(v)}`)
      else if (!resolvePointer(v)) problems.push(`${at}: unresolved $ref ${v}`)
    } else walkRefs(v, `${at}.${k}`)
  }
}
walkRefs(doc, '$')

const { ROUTES } = await import(pathToFileURL(routesPath).href)
const implemented = new Set(ROUTES.map((r) => `${r.method} ${r.pattern}`))
for (const route of implemented) if (!documented.has(route)) problems.push(`implemented but not in openapi.yaml: ${route}`)
for (const route of documented) if (!implemented.has(route)) problems.push(`in openapi.yaml but not implemented: ${route}`)

if (problems.length > 0) {
  console.error(`openapi problems (${problems.length}):`)
  for (const p of problems) console.error(`  ${p}`)
  process.exit(1)
}
console.log(`openapi OK (${documented.size} operations, ${Object.keys(doc.components?.schemas ?? {}).length} schemas)`)
