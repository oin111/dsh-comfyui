import assert from 'node:assert/strict'
import test from 'node:test'
import { createServer } from 'node:http'
import { ComfyUIClient } from '../lib/comfyui.js'
import { mountComfyUIRoutes } from '../lib/routes.js'
import { guardedRegistrar } from '../lib/guard.js'

async function fixture(run) {
  const calls = []
  const mode = { value: 'valid' }
  const backend = createServer((q, s) => {
    calls.push({ method: q.method, path: q.url, auth: q.headers.authorization })
    if (q.url.endsWith('/system_stats')) { s.writeHead(500); s.end('torch.cuda.OutOfMemoryError: CUDA out of memory in torch.cuda.mem_get_info'); return }
    if (mode.value === 'unreachable') { s.destroy(); return }
    if (mode.value === 'timeout') return
    if (mode.value === 'redirect') { s.writeHead(302, { location: '/system_stats' }); s.end(); return }
    if (mode.value === 'prefix' && q.url === '/queue') { s.writeHead(404); s.end('{}'); return }
    s.setHeader('content-type', 'application/json')
    s.end(mode.value === 'invalid-json' ? '<html>not ComfyUI</html>' : JSON.stringify(mode.value === 'valid' || mode.value === 'prefix' ? { queue_running: [], queue_pending: [] } : mode.value))
  })
  await new Promise(r => backend.listen(0, '127.0.0.1', r))
  const backendBase = `http://127.0.0.1:${backend.address().port}`
  const routes = new Map()
  const runtime = { getClient: async () => new ComfyUIClient(backendBase, 'synthetic-key', 60), getConfig: () => ({ baseUrl: backendBase }) }
  const registrar = guardedRegistrar({ register(r) { routes.set(r.path, r.handler); return () => {} } }, () => ({ requestRejection: r => r.headers.cookie === 'probe=yes' ? undefined : 401 }), () => {})
  mountComfyUIRoutes({}, runtime, registrar)
  const host = createServer((q, s) => Promise.resolve(routes.get(q.url)(q, s)).catch(e => { s.statusCode = 500; s.end(String(e)) }))
  await new Promise(r => host.listen(0, '127.0.0.1', r))
  const base = `http://127.0.0.1:${host.address().port}`
  const request = (init = {}) => fetch(base + '/comfyui/test', { method: 'POST', headers: { cookie: 'probe=yes', origin: base }, ...init })
  try { await run({ calls, mode, request, backendBase }) }
  finally { for (const server of [host, backend]) { server.closeAllConnections(); await new Promise(r => server.close(r)) } }
}

test('panel/settings probe succeeds without ever touching CUDA stats or submitting work', async () => fixture(async ({ calls, request }) => {
  const response = await request()
  const result = await response.json()
  assert.equal(response.status, 200)
  assert.equal(result.ok, true, JSON.stringify(result))
  assert.equal(result.version, 'unknown')
  assert.equal(typeof result.latencyMs, 'number')
  assert.deepEqual(calls, [{ method: 'GET', path: '/queue', auth: 'Bearer synthetic-key' }])
}))

test('probe learns /api prefix with credentials and never falls back to stats', async () => fixture(async ({ calls, mode, request }) => {
  mode.value = 'prefix'
  for (let i = 0; i < 2; i++) assert.equal((await (await request()).json()).ok, true)
  assert.deepEqual(calls.map(c => c.path), ['/queue', '/api/queue', '/api/queue'])
  assert.ok(calls.every(c => c.method === 'GET' && c.auth === 'Bearer synthetic-key'))
}))

test('probe reports unreachable, malformed, timed-out and redirected backends as failures', async () => fixture(async ({ calls, mode, request, backendBase }) => {
  for (const value of ['unreachable', 'invalid-json', 'timeout', 'redirect', {}, null, [], { queue_running: [] }, { queue_running: {}, queue_pending: [] }]) {
    mode.value = value
    const result = await (await request()).json()
    assert.equal(result.ok, false, JSON.stringify(value))
    assert.equal(typeof result.latencyMs, 'number')
    assert.ok(result.error.includes(backendBase), result.error)
    assert.match(result.error, /fetch failed|JSON|Unexpected|abort|redirect|Invalid ComfyUI/i)
  }
  assert.ok(calls.every(c => c.method === 'GET' && c.path === '/queue'), JSON.stringify(calls))
}))

test('probe guards authentication, method and origin before any backend I/O', async () => fixture(async ({ calls, request }) => {
  assert.equal((await request({ headers: {} })).status, 401)
  assert.equal((await request({ method: 'GET' })).status, 405)
  assert.equal((await request({ headers: { cookie: 'probe=yes', origin: 'https://untrusted.invalid' } })).status, 403)
  assert.deepEqual(calls, [])
}))
