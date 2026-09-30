import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { parseProviderManifest, type ProviderManifest } from '../../core/provider-manifest.js'

const cache = new Map<string, ProviderManifest>()

/** Bundled `providers/<family>.yaml`, next to the package root. */
export function loadBundledManifest(family: string): ProviderManifest {
  const cached = cache.get(family)
  if (cached) return cached
  const file = fileURLToPath(new URL(`../../../providers/${family}.yaml`, import.meta.url))
  const manifest = parseProviderManifest(readFileSync(file, 'utf8'), file)
  cache.set(family, manifest)
  return manifest
}
