import assert from 'node:assert/strict'
import test from 'node:test'
import { ObjectInfoCache } from '../lib/object-info-cache.js'
import { ComfyUIClient } from '../lib/comfyui.js'
import { resolveClient } from '../lib/client-provider.js'

const deferred = () => Promise.withResolvers()
const client = (cache, server = 'http://synthetic.invalid', key) => new ComfyUIClient(server, key, 1000, 1024, cache)
const config = () => ({ baseUrl: 'http://server-a.invalid', apiKeyEnv: 'SYNTHETIC_A', connectTimeoutMs: 1000, maxMediaBytes: 1024 })
async function withFetch(fn) {
  const original = globalThis.fetch
  const calls = []
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), auth: init.headers.Authorization })
    return Response.json({ marker: String(url) + '|' + init.headers.Authorization })
  }
  try { await fn(calls) } finally { globalThis.fetch = original }
}

test('20 concurrent cache reads share one flight; completed cache is reused', async () => {
  const cache = new ObjectInfoCache()
  const flight = deferred()
  let calls = 0
  const load = () => { calls++; return flight.promise }
  const reads = Array.from({ length: 20 }, () => cache.get('same', load))
  await Promise.resolve()
  assert.equal(calls, 1)
  flight.resolve({ node: true })
  assert.ok((await Promise.all(reads)).every(value => value.node === true))
  assert.deepEqual(await cache.get('same', load), { node: true })
  assert.equal(calls, 1)
})

test('cache entries isolate server and resolved credential, and normalize trailing slash', () => withFetch(async calls => {
  const cache = new ObjectInfoCache()
  const a = await client(cache, 'http://server-a.invalid', 'synthetic-key-a').objectInfoCached()
  const b = await client(cache, 'http://server-b.invalid', 'synthetic-key-a').objectInfoCached()
  const rotated = await client(cache, 'http://server-b.invalid', 'synthetic-key-b').objectInfoCached()
  assert.notDeepEqual(a, b)
  assert.notDeepEqual(b, rotated)
  assert.deepEqual(await client(cache, 'http://server-b.invalid/', 'synthetic-key-b').objectInfoCached(), rotated)
  assert.equal(calls.length, 3)
}))

test('cache instances do not share data or flights', () => withFetch(async calls => {
  await client(new ObjectInfoCache()).objectInfoCached()
  await client(new ObjectInfoCache()).objectInfoCached()
  assert.equal(calls.length, 2)
}))

test('explicit discovery reads remain fresh instead of hiding new uploaded media', () => withFetch(async calls => {
  const c = client(new ObjectInfoCache())
  await c.objectInfo(); await c.objectInfo()
  assert.equal(calls.length, 2)
}))

test('failed cache flight is shared and the next read can retry', async () => {
  const cache = new ObjectInfoCache()
  const failure = deferred()
  const first = cache.get('key', () => failure.promise)
  const second = cache.get('key', () => { throw new Error('duplicate request') })
  const rejected = Promise.allSettled([first, second])
  failure.reject(new Error('synthetic failure'))
  assert.ok((await rejected).every(result => result.status === 'rejected'))
  assert.deepEqual(await cache.get('key', async () => ({ retried: true })), { retried: true })
})

test('refresh invalidates an in-flight old response without letting it replace the new cache', async () => {
  const cache = new ObjectInfoCache()
  const old = deferred(); const fresh = deferred()
  const before = cache.get('key', () => old.promise)
  cache.clear()
  const after = cache.get('key', () => fresh.promise)
  fresh.resolve({ generation: 'fresh' })
  await after
  old.resolve({ generation: 'old' })
  assert.deepEqual(await before, { generation: 'old' })
  assert.deepEqual(await cache.get('key', () => { throw new Error('cache replaced') }), { generation: 'fresh' })
})

test('invalidated rejection cannot remove a newer pending flight', async () => {
  const cache = new ObjectInfoCache()
  const old = deferred(); const fresh = deferred()
  const before = cache.get('key', () => old.promise)
  const rejected = assert.rejects(before, /old error/)
  cache.clear()
  const after = cache.get('key', () => fresh.promise)
  old.reject(new Error('old error')); await rejected
  const joined = cache.get('key', () => { throw new Error('duplicate fresh flight') })
  fresh.resolve({ generation: 'fresh' })
  assert.deepEqual(await after, await joined)
})

test('expired and evicted cache entries reload; cache is bounded', async () => {
  const cache = new ObjectInfoCache(0, 2)
  let loads = 0
  await cache.get('a', async () => ({ n: ++loads }))
  assert.deepEqual(await cache.get('a', async () => ({ n: ++loads })), { n: 2 })
  const bounded = new ObjectInfoCache(60_000, 2)
  for (const key of ['a', 'b', 'c']) await bounded.get(key, async () => ({ key }))
  assert.deepEqual(await bounded.get('a', async () => ({ reloaded: true })), { reloaded: true })
})

test('credential resolution never sends the old credential to a newly configured server', () => withFetch(async calls => {
  const cfg = config()
  const key = deferred()
  let reference
  const pending = resolveClient(cfg, ref => { reference = ref; return key.promise }, new ObjectInfoCache())
  cfg.baseUrl = 'http://server-b.invalid'
  cfg.apiKeyEnv = 'SYNTHETIC_B'
  key.resolve('synthetic-key-a')
  const old = await pending
  await old.systemStats()
  assert.equal(reference, 'SYNTHETIC_A')
  assert.deepEqual(calls, [{ url: 'http://server-a.invalid/system_stats', auth: 'Bearer synthetic-key-a' }])
  const current = await resolveClient(cfg, async ref => { assert.equal(ref, 'SYNTHETIC_B'); return 'synthetic-key-b' })
  await current.systemStats()
  assert.deepEqual(calls[1], { url: 'http://server-b.invalid/system_stats', auth: 'Bearer synthetic-key-b' })
}))
