// Test composition root: full in-process stack (fake provider, tmp data root, tmp workspaces) on an ephemeral port.
import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { composeApp, type AppConfig, type RunningApp } from '../server.js'

export const TEST_API_KEY = 'test-api-key-0123456789abcdef'
export const TEST_PRODUCTS = ['aw', 'vector'] as const
export type TestProduct = (typeof TEST_PRODUCTS)[number]

export interface TestApp extends RunningApp {
  baseUrl: string
  dataRoot: string
  /** Product → absolute workspace root (an existing tmp dir). */
  workspaceRoots: Map<string, string>
  /** Closes the server and removes the tmp dirs this call created. */
  destroy(): Promise<void>
}

export function authHeaders(product: TestProduct, extra: Record<string, string> = {}): Record<string, string> {
  return { Authorization: `Bearer ${TEST_API_KEY}`, 'X-Amazing-Product': product, ...extra }
}

export async function createTestApp(overrides: Partial<AppConfig> = {}): Promise<TestApp> {
  const created: string[] = []
  const tmp = (prefix: string) => {
    const dir = mkdtempSync(path.join(os.tmpdir(), prefix))
    created.push(dir)
    return dir
  }
  const dataRoot = overrides.dataRoot ?? tmp('amz-data-')
  const workspaceRoots = overrides.workspaceRoots ?? new Map(TEST_PRODUCTS.map((p) => [p, tmp(`amz-ws-${p}-`)]))
  const app = await composeApp({
    port: 0,
    dataRoot,
    workspaceRoots,
    apiKey: TEST_API_KEY,
    maxConcurrent: 4,
    maxConcurrentPerProduct: 2,
    defaultTimeoutSec: 3600,
    sessionIdleTtlSec: 3600,
    sessionSweepSec: 60,
    enableFake: true,
    registerFake: false,
    log: () => {},
    ...overrides,
  })
  return {
    ...app,
    baseUrl: `http://127.0.0.1:${app.port}`,
    dataRoot,
    workspaceRoots,
    async destroy() {
      await app.close()
      for (const dir of created) rmSync(dir, { recursive: true, force: true })
    },
  }
}
