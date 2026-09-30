#!/usr/bin/env node
// Module boundary check (zero deps). Rules, relative to <root>/src:
//   (a) modules/<a>/** may only import core/**, its own directory, modules/spawn/**,
//       node builtins and npm deps — never another family nor modules/index.ts.
//       modules/spawn/** may not import a family (the adapter is injected the other way).
//   (b) core/** must not import anything under modules/** (including modules/index.ts)
//   (c) api/** must not import anything under modules/**
//   (d) only the composition roots — server.ts and test-support/** — may import modules/** from outside modules/
// modules/index.ts is the only file allowed to import from multiple modules/<x>/.
// core and api receive the provider registry by injection.
// Usage: node scripts/check-boundaries.mjs [--root <dir>]
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const args = process.argv.slice(2)
const rootIdx = args.indexOf('--root')
const root = rootIdx >= 0 && args[rootIdx + 1]
  ? path.resolve(args[rootIdx + 1])
  : path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const srcDir = path.join(root, 'src')
if (!existsSync(srcDir) || !statSync(srcDir).isDirectory()) {
  console.error(`check-boundaries: no src/ directory under ${root}`)
  process.exit(2)
}

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name)
    if (statSync(full).isDirectory()) walk(full, out)
    else if (name.endsWith('.ts')) out.push(full)
  }
  return out
}

const SPECIFIER_RE = /(?:\bimport|\bexport)\s[^'"]*?\sfrom\s*['"]([^'"]+)['"]|\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)|\bimport\s*['"]([^'"]+)['"]/g

function specifiers(source) {
  const out = []
  for (const m of source.matchAll(SPECIFIER_RE)) out.push(m[1] ?? m[2] ?? m[3])
  return out
}

// Returns the module family for a src-relative path like "modules/fake/index.ts", or null.
function moduleOf(rel) {
  const m = /^modules\/([^/]+)\//.exec(rel)
  return m ? m[1] : null
}

function check(fileAbs) {
  const rel = path.relative(srcDir, fileAbs).split(path.sep).join('/')
  const violations = []
  if (rel === 'modules/index.ts') return violations
  const fileModule = moduleOf(rel)
  const inCore = rel.startsWith('core/')
  const inApi = rel.startsWith('api/')
  const isCompositionRoot = rel === 'server.ts' || rel.startsWith('test-support/')

  for (const spec of specifiers(readFileSync(fileAbs, 'utf8'))) {
    if (!spec.startsWith('.')) continue
    // ESM specifiers point at emitted `.js`; report the `.ts` source path instead.
    const target = path
      .relative(srcDir, path.resolve(path.dirname(fileAbs), spec))
      .split(path.sep)
      .join('/')
      .replace(/\.js$/, '.ts')
    if (!target.startsWith('modules/')) continue // only imports into modules/** are restricted
    const targetModule = moduleOf(target)
    if (fileModule) {
      if (targetModule === fileModule) continue
      if (fileModule !== 'spawn' && targetModule === 'spawn') continue
      const what = targetModule ? `module "${targetModule}"` : 'modules/index.ts'
      violations.push(`${rel} -> ${target}: module "${fileModule}" must not import ${what}`)
    } else if (inCore) {
      violations.push(`${rel} -> ${target}: core must not import modules`)
    } else if (inApi) {
      violations.push(`${rel} -> ${target}: api must not import modules (registry is injected)`)
    } else if (!isCompositionRoot) {
      violations.push(`${rel} -> ${target}: only composition roots (server.ts, test-support/**) may import modules`)
    }
  }
  return violations
}

const files = walk(srcDir)
const violations = files.flatMap(check)
if (violations.length > 0) {
  console.error(`boundary violations (${violations.length}):`)
  for (const v of violations) console.error(`  ${v}`)
  process.exit(1)
}
console.log(`boundaries OK (${files.length} files)`)
