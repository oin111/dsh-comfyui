// Hostile-backend regressions. Synthetic streams model lying lengths that HTTP parsers reject.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createServer } from 'node:http'
import { ComfyUIClient } from '../lib/comfyui.js'
import { startBackgroundRun } from '../lib/tools.js'
import { ProgressTracker } from '../lib/progress.js'
import { apply } from '../lib/index.js'
import { mkdtemp, rm, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

test('buffered and streamed 200/206 media count actual bytes, cancel and cap ranges', { timeout: 5000 }, async () => {
  for (const streamed of [false, true]) {
    for (const status of [200, 206]) {
      for (const length of [undefined, '1', '33554432']) {
        const headers = { ...(length ? { 'content-length': length } : {}), ...(status === 206 ? { 'content-range': 'bytes 0-1023/9999999' } : {}) }
        const f = endless(status, headers)
        await fixture(f.response, async () => {
          await assert.rejects(async () => {
            if (!streamed) return client().fetchView(ref)
            const v = await client().fetchViewStreamed(ref, 'bytes=0-9999999')
            for await (const chunk of v.body) assert.ok(chunk.length <= 1024)
          }, /too large/)
          assert.equal(f.cancelled, true)
          assert.ok(f.reads < 5)
        })
      }
    }
  }
  for (const input of ['bytes=4096-', 'bytes=4096-999999', 'bytes=-999999']) {
    const original = globalThis.fetch
    let forwarded
    globalThis.fetch = async (_url, init) => {
      forwarded = init.headers.Range
      const cr = input.startsWith('bytes=-') ? 'bytes 8976-9999/10000' : 'bytes 4096-5119/10000'
      return new Response(new Uint8Array(1024), { status: 206, headers: { 'content-range': cr } })
    }
    try {
      const v = await client().fetchViewStreamed(ref, input)
      assert.equal((await new Response(v.body).arrayBuffer()).byteLength, 1024)
      assert.equal(forwarded, input.startsWith('bytes=-') ? 'bytes=-1024' : 'bytes=4096-5119')
    } finally { globalThis.fetch = original }
  }
  for (const cr of [undefined, 'bytes 1-10/10000', 'bytes 0-2047/10000', 'bytes 0-10/5']) {
    const f = endless(206, cr ? { 'content-range': cr } : {})
    await fixture(f.response, async () => {
      await assert.rejects(client().fetchViewStreamed(ref, 'bytes=0-1023'), /range/i)
      assert.equal(f.cancelled, true)
    })
  }
  for (const range of ['bytes=0-1,5-6', 'bytes=oops', 'bytes=5-1']) {
    let called = false
    const original = globalThis.fetch
    globalThis.fetch = async () => { called = true; return new Response('x') }
    try { await assert.rejects(client().fetchViewStreamed(ref, range), /range/i); assert.equal(called, false) }
    finally { globalThis.fetch = original }
  }
})

test('stream transfer timeout remains active after headers and downstream cancel closes upstream', { timeout: 5000 }, async () => {
  const server = createServer((_q, s) => { s.writeHead(200); s.write('x') })
  await new Promise(r => server.listen(0, '127.0.0.1', r))
  try {
    const c = new ComfyUIClient(`http://127.0.0.1:${server.address().port}`, undefined, 60, 1024)
    const v = await c.fetchViewStreamed(ref)
    let deadline
    try {
      await assert.rejects(Promise.race([new Response(v.body).arrayBuffer(), new Promise((_, reject) => { deadline = setTimeout(() => reject(new Error('transfer did not stop')), 300) })]), /abort|timeout/i)
    } finally { clearTimeout(deadline) }
  } finally { server.closeAllConnections(); await new Promise(r => server.close(r)) }
  const f = endless()
  await fixture(f.response, async () => { const v = await client().fetchViewStreamed(ref); await v.body.cancel(); assert.equal(f.cancelled, true) })
})

test('all HTTP backend paths refuse hostile redirects without reaching the second origin', { timeout: 5000 }, async () => {
  let reached = 0
  const target = createServer((_q, s) => { reached++; s.end('{}') })
  await new Promise(r => target.listen(0, '127.0.0.1', r))
  const backend = createServer((q, s) => {
    q.resume()
    if (q.url === '/system_stats') { s.writeHead(404); s.end('{}'); return }
    s.writeHead(307, { location: `http://127.0.0.1:${target.address().port}/private` }); s.end()
  })
  await new Promise(r => backend.listen(0, '127.0.0.1', r))
  try {
    const c = new ComfyUIClient(`http://127.0.0.1:${backend.address().port}`, undefined, 1000, 1024)
    for (const call of [() => c.systemStats(), () => c.uploadFile(new Uint8Array(1), 'multipart/form-data'), () => c.fetchView(ref), () => c.fetchViewStreamed(ref), () => c.cancelJob('owned')]) {
      await assert.rejects(call(), /redirect/i)
    }
    assert.equal(reached, 0)
  } finally {
    for (const s of [backend, target]) { s.closeAllConnections(); await new Promise(r => s.close(r)) }
  }
})

test('abort during failed/inflight history attempts targeted cleanup before killed/untrack', { timeout: 5000 }, async () => {
  for (const failure of ['http', 'transport', 'hanging']) {
    let entered, release, historyClosed = false
    const reached = new Promise(r => entered = r), gate = new Promise(r => release = r)
    const calls = [], untracked = []
    const backend = createServer(async (q, s) => {
      calls.push(q.method + ' ' + q.url)
      q.resume()
      if (q.url.startsWith('/history/')) {
        s.on('close', () => historyClosed = true)
        entered(); await gate
        if (failure === 'http') { s.writeHead(500); s.end('failure') }
        if (failure === 'transport') s.destroy()
        return
      }
      assert.equal(untracked.length, 0, 'cleanup precedes untrack')
      s.end(q.method === 'GET' ? '{"queue_running":[[0,"foreign"]],"queue_pending":[]}' : '{}')
    })
    await new Promise(r => backend.listen(0, '127.0.0.1', r))
    let hooks
    try {
      const c = new ComfyUIClient(`http://127.0.0.1:${backend.address().port}`, undefined, 150, 1024)
      await startBackgroundRun({ jobs: { start(spec) { hooks = spec.run({ updateProgress() {} }); return 'job' } }, runtime: { untrack: id => untracked.push(id), queueProgress() {}, proxyBase() {} }, client: c, config: { pollIntervalMs: 100, maxMediaItems: 1 }, promptId: 'owned', label: 'test', waitMs: 1000, owner: 'session' })
      await reached; hooks.cancel(); release()
      const outcome = await hooks.done
      assert.equal(outcome.status, 'killed')
      assert.ok(calls.includes('POST /queue'), JSON.stringify(calls))
      assert.ok(calls.includes('GET /queue'))
      assert.ok(!calls.includes('POST /interrupt'))
      assert.deepEqual(untracked, ['owned'])
      if (failure === 'hanging') assert.equal(historyClosed, true)
    } finally { release(); backend.closeAllConnections(); await new Promise(r => backend.close(r)) }
  }
})

test('native WebSocket progress handshake does not follow redirects', { timeout: 5000 }, async () => {
  let reached = 0, attempted
  const attempt = new Promise(r => attempted = r)
  const target = createServer((_q, s) => { reached++; s.end() })
  await new Promise(r => target.listen(0, '127.0.0.1', r))
  const backend = createServer((_q, s) => { s.writeHead(302, { location: `http://127.0.0.1:${target.address().port}/private` }); s.end(); attempted() })
  await new Promise(r => backend.listen(0, '127.0.0.1', r))
  const p = new ProgressTracker()
  try {
    p.attach(`ws://127.0.0.1:${backend.address().port}/ws`)
    await attempt; await new Promise(r => setTimeout(r, 100)); assert.equal(reached, 0)
  } finally { p.dispose(); for (const s of [backend, target]) { s.closeAllConnections(); await new Promise(r => s.close(r)) } }
})

test('real host argument validators admit comfyui_workflow skill action', { timeout: 5000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'schema-'))
  const tools = new Map(), disposers = []
  const service = { register(d) { tools.set(d.name, d); return () => {} } }
  const ctx = { tools: service, get: n => n === 'tools' ? service : undefined, effect(f) { const d = f(); if (typeof d === 'function') disposers.push(d); return d }, on() {}, inject() {}, fiber: {} }
  try {
    await apply(ctx, { dataDir: dir, baseUrl: 'http://127.0.0.1:1' })
    const definition = tools.get('comfyui_workflow')
    const validators = [await import('@deepseek-ai/dsh-tools')]
    for (const root of (process.env.DSH_VALIDATOR_ROOTS ?? '').split(':').filter(Boolean)) {
      validators.push(await import(pathToFileURL(join(root, 'node_modules/@deepseek-ai/dsh-tools/lib/index.js')).href))
    }
    for (const h of validators) {
      h.assertSupportedJsonSchema(definition.parameters)
      assert.deepEqual(h.validateJsonSchemaValue(definition.parameters, { action: 'skill', id: 'wf' }), [])
      assert.notDeepEqual(h.validateJsonSchemaValue(definition.parameters, { action: 'unknown', id: 'wf' }), [])
    }
    assert.match(definition.description, /action: skill/)
    assert.match(definition.parameters.properties.action.description, /skill.*SKILL.md/)
  } finally { for (const d of disposers.reverse()) d(); await rm(dir, { recursive: true, force: true }) }
})

test('CLAUDE contract matches backend boundaries and trusted origin/deletion semantics', async () => {
  const contract = await readFile(new URL('../CLAUDE.md', import.meta.url), 'utf8')
  assert.ok(!contract.includes('Host/Referer'))
  assert.ok(!contract.includes('POST，删记录 + 删输出文件'))
  for (const token of ['8 MiB', '64 KiB', 'maxMediaBytes', 'Content-Range', 'connectTimeoutMs', 'redirect', 'cancelPrompt']) assert.ok(contract.includes(token), token)
})

test('READMEs state backend bounds and runtime comment reflects bind-address fallback', async () => {
  const root = new URL('../', import.meta.url)
  for (const name of ['README.md', 'README.en.md']) {
    const doc = await readFile(new URL(name, root), 'utf8')
    for (const token of ['8 MiB', '64 KiB', 'maxMediaBytes', 'Content-Range', 'connectTimeoutMs', 'redirect', 'cancelPrompt']) assert.ok(doc.includes(token), `${name}: ${token}`)
  }
  const tools = await readFile(new URL('src/tools.ts', root), 'utf8')
  assert.match(tools, /Absolute media proxy URL base:.*bind-address/)
})

test('buffered media HTTP refusal cancels upstream without reading diagnostics', async () => {
  const f = endless(500)
  await fixture(f.response, async () => {
    await assert.rejects(client().fetchView(ref), /HTTP 500/)
    assert.equal(f.cancelled, true)
    assert.ok(f.reads < 3)
  })
})

test('partial media refuses absent or truncated actual body', async () => {
  for (const body of [null, new Uint8Array(5)]) {
    await fixture(new Response(body, { status: 206, headers: { 'content-range': 'bytes 0-9/1000' } }), async () => {
      await assert.rejects(async () => { const v = await client().fetchViewStreamed(ref, 'bytes=0-9'); await new Response(v.body).arrayBuffer() }, /truncated|missing/i)
    })
  }
})

test('real chunked media stops early for 200 and 206 without buffering the entire backend body', { timeout: 5000 }, async () => {
  for (const streamed of [false, true]) {
    for (const status of [200, 206]) {
      let sent = 0, closed
      const stopped = new Promise(r => closed = r)
      const server = createServer((_q, s) => {
        s.writeHead(status, status === 206 ? { 'content-range': 'bytes 0-1023/9999999' } : {})
        const timer = setInterval(() => { sent += 512; s.write(Buffer.alloc(512)); if (sent >= 1024 * 1024) { clearInterval(timer); s.end() } }, 2)
        s.on('close', () => { clearInterval(timer); closed() })
      })
      await new Promise(r => server.listen(0, '127.0.0.1', r))
      try {
        const c = new ComfyUIClient(`http://127.0.0.1:${server.address().port}`, undefined, 1000, 1024)
        let received = 0
        await assert.rejects(async () => {
          if (!streamed) return c.fetchView(ref)
          const v = await c.fetchViewStreamed(ref, status === 206 ? 'bytes=0-1023' : undefined)
          for await (const chunk of v.body) received += chunk.length
        }, /too large/)
        await stopped
        assert.ok(received <= 1024)
        assert.ok(sent < 1024 * 1024, `early upstream close: ${sent}`)
      } finally { server.closeAllConnections(); await new Promise(r => server.close(r)) }
    }
  }
})

test('HEAD and 416 never consume backend bodies and bounded valid downloads still work', async () => {
  const original = globalThis.fetch
  try {
    for (const [status, method] of [[200, 'HEAD'], [416, 'GET']]) {
      const f = endless(status, { 'content-length': '9999999' })
      globalThis.fetch = async (_url, init) => { assert.equal(init.method, method); return f.response }
      const v = await client().fetchViewStreamed(ref, undefined, method)
      assert.equal(v.status, status); assert.equal(v.body, null); assert.equal(f.cancelled, true)
      if (status === 416) assert.equal(v.headers.get('content-length'), '0')
    }
    for (const streamed of [false, true]) {
      globalThis.fetch = async () => new Response(new Uint8Array(1024), { headers: { 'content-length': '1024' } })
      const bytes = streamed ? new Uint8Array(await new Response((await client().fetchViewStreamed(ref)).body).arrayBuffer()) : (await client().fetchView(ref)).bytes
      assert.equal(bytes.length, 1024)
    }
  } finally { globalThis.fetch = original }
})

test('refused background registration attempts cleanup before untracking', async () => {
  const events = []
  await assert.rejects(startBackgroundRun({ jobs: { start() { throw new Error('refused') } }, runtime: { untrack() { events.push('untrack') } }, client: { async cancelPrompt(id) { assert.equal(id, 'owned'); events.push('cleanup'); await Promise.resolve(); events.push('cleanup-finished') } }, config: {}, promptId: 'owned', label: 'test', waitMs: 1000 }), /refused/)
  assert.deepEqual(events, ['cleanup', 'cleanup-finished', 'untrack'])
})

const ref = { filename: 'x.png', subfolder: '', type: 'output' }
const client = (timeout = 1000) => new ComfyUIClient('http://backend.test', undefined, timeout, 1024)
async function fixture(response, run) {
  const original = globalThis.fetch
  globalThis.fetch = async () => response
  try { await run() } finally { globalThis.fetch = original }
}
function endless(status = 200, headers = {}) {
  let reads = 0, cancelled = false
  const body = new ReadableStream({
    pull(c) { reads++; if (reads > 512) c.close(); else c.enqueue(new Uint8Array(64 * 1024).fill(120)) },
    cancel() { cancelled = true },
  })
  return { response: new Response(body, { status, headers }), get reads() { return reads }, get cancelled() { return cancelled } }
}

test('JSON and error response budgets count bytes and cancel refused bodies', { timeout: 5000 }, async () => {
  for (const status of [200, 500]) {
    for (const headers of [{}, { 'content-length': '1' }, { 'content-length': '33554432' }]) {
      const f = endless(status, headers)
      await fixture(f.response, async () => {
        await assert.rejects(client().systemStats(), /body too large/)
        assert.equal(f.cancelled, true)
        assert.ok(f.reads < (status === 200 ? 132 : 5), `early refusal: ${f.reads}`)
      })
    }
  }
})
