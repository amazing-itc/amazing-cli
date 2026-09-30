import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, test } from 'node:test'
import { RunFailure } from '../errors.js'
import { createWorkspaceResolver, parseWorkspaceRoots, parseWorkspacesRoot } from '../workspace.js'

let sandbox: string
let root: string
let outside: string
beforeEach(() => {
  sandbox = mkdtempSync(path.join(os.tmpdir(), 'workspace-'))
  root = path.join(sandbox, 'products', 'aw')
  outside = path.join(sandbox, 'outside')
  mkdirSync(path.join(root, 'nested', 'deep'), { recursive: true })
  mkdirSync(outside)
  writeFileSync(path.join(root, 'file.txt'), 'x')
  symlinkSync(outside, path.join(root, 'escape-link'))
  symlinkSync(path.join(root, 'nested'), path.join(root, 'inside-link'))
})
afterEach(() => {
  rmSync(sandbox, { recursive: true, force: true })
})

async function rejectsWith(p: Promise<unknown>, code: string) {
  await assert.rejects(p, (err: unknown) => err instanceof RunFailure && err.error.code === code)
}

test('parseWorkspaceRoots: trims, accepts several products, empty env → empty map', () => {
  const roots = parseWorkspaceRoots(' alpha=/data/products/alpha , beta=/data/products/beta ,')
  assert.deepEqual([...roots], [['alpha', '/data/products/alpha'], ['beta', '/data/products/beta']])
  assert.equal(parseWorkspaceRoots(undefined).size, 0)
  assert.equal(parseWorkspaceRoots('  ').size, 0)
})

test('parseWorkspaceRoots: relative path, missing "=", empty product/path and duplicate product → validation', () => {
  const isValidation = (e: unknown) => e instanceof RunFailure && e.error.code === 'validation'
  for (const bad of ['alpha=relative/path', 'alpha', '=/x', 'alpha=', 'alpha=/a,alpha=/b', 'alpha=./x']) {
    assert.throws(() => parseWorkspaceRoots(bad), isValidation, bad)
  }
})

test('resolve: root itself, nested dir, "." and a symlink that stays inside the root are ok and realpath-ed', async () => {
  const resolver = createWorkspaceResolver(new Map([['aw', root]]))
  const realRoot = realpathSync(root)
  assert.equal(await resolver.resolve('aw', '.'), realRoot)
  assert.equal(await resolver.resolve('aw', 'nested'), path.join(realRoot, 'nested'))
  assert.equal(await resolver.resolve('aw', 'nested/deep/'), path.join(realRoot, 'nested', 'deep'))
  assert.equal(await resolver.resolve('aw', 'inside-link'), path.join(realRoot, 'nested'))
})

test('resolve: absolute path uses the directory itself; no product root required', async () => {
  const withRoot = createWorkspaceResolver(new Map([['aw', root]]))
  assert.equal(await withRoot.resolve('aw', path.join(root, 'nested')), path.join(realpathSync(root), 'nested'))
  assert.equal(await withRoot.resolve('aw', outside), realpathSync(outside))

  const bare = createWorkspaceResolver(new Map())
  assert.equal(await bare.resolve('aw', outside), realpathSync(outside))
  await rejectsWith(bare.resolve('aw', path.join(sandbox, 'missing-dir')), 'workspace_out_of_root')
  await rejectsWith(bare.resolve('aw', 'relative-only'), 'validation')
})

test('resolve: ".." escape, symlink pointing outside, sibling prefix dir → workspace_out_of_root', async () => {
  mkdirSync(path.join(sandbox, 'products', 'aw-other'))
  const resolver = createWorkspaceResolver(new Map([['aw', root]]))
  await rejectsWith(resolver.resolve('aw', '..'), 'workspace_out_of_root')
  await rejectsWith(resolver.resolve('aw', '../outside'), 'workspace_out_of_root')
  await rejectsWith(resolver.resolve('aw', 'nested/../../outside'), 'workspace_out_of_root')
  await rejectsWith(resolver.resolve('aw', 'escape-link'), 'workspace_out_of_root')
  await rejectsWith(resolver.resolve('aw', '../aw-other'), 'workspace_out_of_root')
})

test('resolve: missing dir and a regular file → workspace_out_of_root (nothing is created)', async () => {
  const resolver = createWorkspaceResolver(new Map([['aw', root]]))
  await rejectsWith(resolver.resolve('aw', 'does-not-exist'), 'workspace_out_of_root')
  await rejectsWith(resolver.resolve('aw', 'file.txt'), 'workspace_out_of_root')
  assert.ok(!existsSync(path.join(root, 'does-not-exist')), 'resolver must never create the workspace')
})

test('resolve: a parent root jails any safe caller id; unsafe id is validation', async () => {
  const parent = path.join(sandbox, 'products')
  const resolver = createWorkspaceResolver(new Map(), parent)
  assert.equal(await resolver.resolve('aw', '.'), realpathSync(root))
  await rejectsWith(resolver.resolve('nope', '.'), 'workspace_out_of_root')
  await rejectsWith(resolver.resolve('../escape', '.'), 'validation')
  await rejectsWith(resolver.resolve('a/b', 'x'), 'validation')
  assert.equal(parseWorkspacesRoot('/data/products'), '/data/products')
  assert.equal(parseWorkspacesRoot('  '), undefined)
})

test('resolve: unknown product and empty path → validation; missing root dir → workspace_out_of_root', async () => {
  const resolver = createWorkspaceResolver(new Map([['aw', root], ['ghost', path.join(sandbox, 'nope')]]))
  await rejectsWith(resolver.resolve('vector', 'x'), 'validation')
  await rejectsWith(resolver.resolve('aw', ''), 'validation')
  await rejectsWith(resolver.resolve('aw', '   '), 'validation')
  await rejectsWith(resolver.resolve('ghost', '.'), 'workspace_out_of_root')
})
