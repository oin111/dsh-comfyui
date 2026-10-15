import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, rm, readFile, writeFile, mkdir, symlink, readlink, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:http'
import { ComfyUIStore } from '../lib/store.js'
import { mountComfyUIRoutes } from '../lib/routes.js'
import { guardedRegistrar } from '../lib/guard.js'

const asset = (id, media = []) => ({ promptId: id, ts: '', workflowName: id, source: 'test', media })
const media = (filename, subfolder = '', type = 'output') => ({ filename, subfolder, type, node: '1', index: 0, kind: 'image', url: '' })
async function fixture(run) {
  const dir = await mkdtemp(join(tmpdir(), 'clear-assets-'))
  const store = new ComfyUIStore(join(dir, 'data'), 1000)
  await store.init()
  const output = join(dir, 'output'); await mkdir(output)
  const routes = new Map()
  const runtime = { listAssets: () => store.listAssets(), clearAssets: () => store.clearAssets(), getConfig: () => ({ outputDir: output }) }
  const registrar = guardedRegistrar({ register(r) { routes.set(r.path, r.handler); return () => {} } }, () => ({ requestRejection: r => r.headers.cookie === 'probe=yes' ? undefined : 401 }), () => {})
  mountComfyUIRoutes({}, runtime, registrar)
  const server = createServer((q, s) => { const handler = routes.get(q.url.split('?')[0]); if (handler) Promise.resolve(handler(q, s)).catch(e => { s.statusCode = 500; s.end(String(e)) }); else { s.statusCode = 404; s.end() } })
  await new Promise(r => server.listen(0, '127.0.0.1', r))
  const base = `http://127.0.0.1:${server.address().port}`
  const request = (init = {}) => fetch(base + '/comfyui/assets/clear', { method: 'POST', headers: { cookie: 'probe=yes', origin: base, 'content-type': 'application/json' }, body: '{}', ...init })
  try { await run({ dir, output, store, runtime, request, base }) } finally { server.closeAllConnections(); await new Promise(r => server.close(r)); await rm(dir, { recursive: true, force: true }) }
}

test('clear refuses an unreadable index instead of claiming empty success', { timeout: 10000 }, async () => fixture(async ({ dir, request }) => {
  await writeFile(join(dir, 'data', 'assets.json'), '{broken')
  assert.equal((await request()).status, 500)
  assert.equal(await readFile(join(dir, 'data', 'assets.json'), 'utf8'), '{broken')
}))

test('clear rejects the entire malformed snapshot before modifying index or files', { timeout: 10000 }, async () => fixture(async ({ dir, output, request }) => {
  const valid = asset('keep', [media('keep.png')])
  const malformed = [
    null, false, 'record', [], {},
    { ...valid, promptId: 1 }, { ...valid, ts: null },
    { ...valid, workflowName: 1 }, { ...valid, source: false },
    { ...valid, media: undefined }, { ...valid, media: null },
    { ...valid, media: {} }, { ...valid, media: 'text' },
    ...[null, false, 'ref', [], {},
      ...['filename', 'subfolder', 'type', 'node', 'url'].map(key => ({ ...media('keep.png'), [key]: 1 })),
      { ...media('keep.png'), index: '0' }, { ...media('keep.png'), index: -1 },
      { ...media('keep.png'), index: 0.5 }, { ...media('keep.png'), kind: 'unknown' },
    ].map(ref => ({ ...valid, media: [media('keep.png'), ref] })),
  ]
  const index = join(dir, 'data', 'assets.json')
  await writeFile(join(output, 'keep.png'), 'preserve')
  for (const invalid of malformed) {
    // Both orders prove validation completes before any commit or unlink.
    for (const snapshot of [[invalid, valid], [valid, invalid]]) {
      const original = JSON.stringify(snapshot, null, 2) + '\n'
      await writeFile(index, original)
      assert.equal((await request()).status, 500, original)
      assert.equal(await readFile(index, 'utf8'), original, 'index must remain byte-identical')
      assert.equal(await readFile(join(output, 'keep.png'), 'utf8'), 'preserve')
    }
  }
}))

test('asset writes preserve a predictable temporary symlink and its victim', { timeout: 10000 }, async () => fixture(async ({ dir, store, request }) => {
  await store.appendAsset(asset('old'))
  const victim = join(dir, 'victim')
  const alias = join(dir, 'data', 'assets.json.tmp')
  await writeFile(victim, 'do not change')
  await symlink(victim, alias)
  assert.equal((await request()).status, 200)
  assert.equal(await readFile(victim, 'utf8'), 'do not change')
  assert.equal(await readlink(alias), victim)
  await store.appendAsset(asset('new'))
  assert.deepEqual((await store.listAssets()).map(item => item.promptId), ['new'])
  assert.equal(await readFile(victim, 'utf8'), 'do not change')
  assert.deepEqual((await readdir(join(dir, 'data'))).sort(), ['assets.json', 'assets.json.tmp'])
}))

test('failed atomic asset replacement cleans up only its own temporary file', { timeout: 10000 }, async () => fixture(async ({ dir, store }) => {
  const data = join(dir, 'data')
  await mkdir(join(data, 'assets.json'))
  await writeFile(join(data, 'assets.json.tmp'), 'unrelated')
  await assert.rejects(store.appendAsset(asset('new')))
  assert.equal(await readFile(join(data, 'assets.json.tmp'), 'utf8'), 'unrelated')
  assert.deepEqual((await readdir(data)).sort(), ['assets.json', 'assets.json.tmp'])
}))

test('clear guards auth, method and origin before mutation', { timeout: 10000 }, async () => fixture(async ({ store, request, base }) => {
  await store.appendAsset(asset('keep'))
  assert.equal((await request({ headers: { origin: base } })).status, 401)
  assert.equal((await request({ method: 'GET', body: undefined })).status, 405)
  assert.equal((await request({ headers: { cookie: 'probe=yes', origin: 'http://evil.invalid' } })).status, 403)
  assert.equal((await store.listAssets()).length, 1)
}))

test('clear without trusted outputDir is index-only; file errors are reported honestly', { timeout: 10000 }, async () => fixture(async ({ store, output, runtime, request }) => {
  await writeFile(join(output, 'keep.png'), 'keep')
  for (const outputDir of ['', 'relative']) {
    runtime.getConfig = () => ({ outputDir })
    await store.appendAsset(asset('file', [media('keep.png')]))
    const result = await (await request()).json()
    assert.equal(result.skipped, 1); assert.equal(result.deleted, 0); assert.equal(result.outputDir, null)
    assert.equal(await readFile(join(output, 'keep.png'), 'utf8'), 'keep')
  }
  runtime.getConfig = () => ({ outputDir: output })
  await mkdir(join(output, 'directory'))
  await store.appendAsset(asset('failure', [media('directory')]))
  const result = await (await request()).json()
  assert.equal(result.removed, 1); assert.equal(result.deleted, 0); assert.equal(result.failures.length, 1)
  assert.deepEqual(await store.listAssets(), [])
}))

test('stores sharing a canonical directory serialize the full mutation', { timeout: 10000 }, async () => fixture(async ({ dir, store }) => {
  const alias = join(dir, 'data-alias')
  await symlink(join(dir, 'data'), alias)
  const other = new ComfyUIStore(alias, 1000)
  let release
  const held = new Promise(resolve => { release = resolve })
  let entered
  const reading = new Promise(resolve => { entered = resolve })
  const originalList = store.listAssets.bind(store)
  store.listAssets = async () => {
    const snapshot = await originalList()
    entered()
    await held
    return snapshot
  }
  const first = store.appendAsset(asset('first'))
  await reading
  const second = other.appendAsset(asset('second'))
  // The unprotected second store can commit while the first holds a stale
  // snapshot. A shared queue makes it wait; do not wait for it here.
  await new Promise(resolve => setTimeout(resolve, 30))
  release()
  await Promise.all([first, second])
  assert.deepEqual((await other.listAssets()).map(item => item.promptId).sort(), ['first', 'second'])
}))

test('clear and concurrent appends are serialized; new records survive', { timeout: 10000 }, async () => fixture(async ({ store }) => {
  await store.appendAsset(asset('old'))
  const clearing = store.clearAssets()
  const additions = Array.from({ length: 30 }, (_, i) => store.appendAsset(asset(`new-${i}`)))
  assert.equal((await clearing).length, 1)
  await Promise.all(additions)
  assert.equal((await store.listAssets()).length, 30)
}))

test('bulk clear removes every indexed record, not a filtered page; preserves other data and safe files', { timeout: 10000 }, async () => fixture(async ({ dir, output, store, request }) => {
  await writeFile(join(dir, 'data', 'workflows.json'), '[{"id":"keep"}]')
  await writeFile(join(output, 'unindexed.png'), 'keep')
  await writeFile(join(output, 'input.png'), 'keep')
  await writeFile(join(dir, 'outside.png'), 'keep')
  await mkdir(join(dir, 'outside')); await writeFile(join(dir, 'outside', 'secret.png'), 'keep')
  await symlink(join(dir, 'outside'), join(output, 'linked'))
  await writeFile(join(output, 'generated.png'), 'delete')
  for (let i = 0; i < 125; i++) await store.appendAsset(asset(String(i)))
  await store.appendAsset(asset('files', [media('generated.png'), media('missing.png'), media('input.png', '', 'input'), media('../outside.png'), media('secret.png', 'linked')]))
  const response = await request(); assert.equal(response.status, 200)
  const result = await response.json(); assert.equal(result.ok, true); assert.equal(result.removed, 126)
  assert.equal(result.deleted, 1); assert.equal(result.missing, 1); assert.equal(result.skipped, 3)
  assert.deepEqual(await store.listAssets(), [])
  await assert.rejects(readFile(join(output, 'generated.png')), { code: 'ENOENT' })
  for (const path of [join(output, 'unindexed.png'), join(output, 'input.png'), join(dir, 'outside.png'), join(dir, 'outside', 'secret.png')]) assert.equal(await readFile(path, 'utf8'), 'keep')
  assert.equal(await readFile(join(dir, 'data', 'workflows.json'), 'utf8'), '[{"id":"keep"}]')
  assert.equal((await (await request()).json()).removed, 0)
}))
