// Offline host-contract tests for the dsh 0.2.x line (run after `npm run build`).
// Drives the real plugin entry `apply(ctx, config)` against a stub host shaped
// like dsh 0.2.0-rc.2 / 0.2.1-alpha.2 and a stub ComfyUI HTTP server, then
// checks the package manifest against the host's install-time gates.
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { Writable } from 'node:stream'
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import semver from 'semver'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))

let failures = 0
let passed = 0
async function test(name, fn) {
  try {
    let timer
    await Promise.race([fn(), new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('test timed out (20s)')), 20_000) })])
    clearTimeout(timer)
    passed += 1
    console.log(`ok   ${name}`)
  } catch (error) {
    failures += 1
    console.log(`FAIL ${name}\n     ${error?.stack?.split('\n').slice(0, 3).join('\n     ') ?? error}`)
  }
}

// ---------------------------------------------------------------- manifest

await test('package is the oin111 fork', () => {
  assert.equal(pkg.name, '@oin111/dsh-comfyui')
  assert.ok(semver.gte(pkg.version, '0.6.0'), `version ${pkg.version}`)
})

await test('every dsh peer admits the 0.2 line and rejects 0.1.x / 0.2.0-rc.1 / 0.3', () => {
  // Same rule as dsh-app-boot evaluatePluginCompatibility: prereleases participate.
  const dshPeers = Object.entries(pkg.peerDependencies ?? {})
    .filter(([name]) => name === '@deepseek-ai/dsh' || name.startsWith('@deepseek-ai/dsh-'))
  assert.ok(dshPeers.length > 0, 'at least one dsh peer is declared')
  for (const [name, range] of dshPeers) {
    for (const ok of ['0.2.0-rc.2', '0.2.0', '0.2.1-alpha.1', '0.2.1-alpha.2', '0.2.9']) {
      assert.ok(semver.satisfies(ok, range, { includePrerelease: true }), `${name} ${range} should admit ${ok}`)
    }
    for (const bad of ['0.1.7-rc.2', '0.1.5-rc.3', '0.2.0-rc.1', '0.3.0-alpha.1', '0.3.0']) {
      assert.ok(!semver.satisfies(bad, range, { includePrerelease: true }), `${name} ${range} should reject ${bad}`)
    }
  }
})

await test('client inject lists no module the 0.2 host lacks', () => {
  const inject = pkg.dsh?.client?.inject ?? []
  assert.ok(!inject.includes('@deepseek-ai/dsh-client-runtime'))
})

await test('cordis.patch.yml row name equals the package name', async () => {
  const patch = await readFile(join(root, 'cordis.patch.yml'), 'utf8')
  const match = patch.match(/^\s*name:\s*'?"?([^'"\n]+)'?"?\s*$/m)
  assert.ok(match, 'patch has a name row')
  assert.equal(match[1].trim(), pkg.name)
  assert.match(patch, /^\s*-?\s*id:\s*comfyui\s*$/m, 'settings namespace / row id stays comfyui')
})

await test('client bundle registers its factory under the package name', async () => {
  const bundle = await readFile(join(root, 'client', 'client.js'), 'utf8')
  const head = bundle.slice(0, 200).replace(/\s+/g, ' ')
  assert.ok(head.startsWith(`window.__ModuleLoader__.load({ id: ${JSON.stringify(pkg.name)}, factory:`), head)
  assert.equal(bundle.split('__ModuleLoader__.load(').length - 1, 1, 'exactly one factory registration')
})

await test('package exports ./icon backed by a published file', async () => {
  const target = pkg.exports?.['./icon']
  assert.equal(typeof target, 'string')
  await stat(join(root, target))
  const published = (pkg.files ?? []).some((entry) => target.replace(/^\.\//, '').startsWith(entry.replace(/^\.\//, '')))
  assert.ok(published, `${target} is inside files[]`)
})

// ---------------------------------------------------------------- stub ComfyUI

function startComfy({ completeAfterPolls = 1, foreignRunning = false, viewType = 'image/png' } = {}) {
  const calls = []
  const histories = new Map()
  let next = 0
  const server = createServer((req, res) => {
    let body = ''
    req.on('data', (chunk) => { body += chunk })
    req.on('end', () => {
      calls.push({ method: req.method, url: req.url, body })
      const send = (status, value) => {
        res.writeHead(status, { 'content-type': 'application/json' })
        res.end(JSON.stringify(value))
      }
      if (req.method === 'POST' && req.url === '/prompt') {
        next += 1
        const id = `p-${next}`
        histories.set(id, 0)
        return send(200, { prompt_id: id, number: next })
      }
      const hist = req.url?.match(/^\/history\/([^?]+)/)
      if (req.method === 'GET' && hist) {
        const id = decodeURIComponent(hist[1])
        const polls = (histories.get(id) ?? 0) + 1
        histories.set(id, polls)
        if (completeAfterPolls === Infinity || polls < completeAfterPolls) return send(200, {})
        return send(200, {
          [id]: {
            status: { status_str: 'success', completed: true },
            outputs: { 9: { images: [{ filename: `${id}.png`, subfolder: '', type: 'output' }] } },
          },
        })
      }
      if (req.method === 'POST' && (req.url === '/queue' || req.url === '/interrupt')) return send(200, {})
      if (req.method === 'GET' && req.url === '/queue') {
        const running = [...histories.keys()].filter((id) => (histories.get(id) ?? 0) > 0 && completeAfterPolls === Infinity && !foreignRunning)
        return send(200, { queue_running: (foreignRunning ? [[0, 'foreign-prompt']] : running.map((id, i) => [i, id])), queue_pending: [] })
      }
      if (req.method === 'GET' && req.url?.startsWith('/view')) {
        res.writeHead(200, { 'content-type': viewType, 'content-disposition': 'attachment', 'x-content-type-options': 'nosniff' })
        return res.end('<script>alert(1)</script>')
      }
      if (req.method === 'GET' && req.url?.startsWith('/object_info')) return send(200, {})
      return send(404, { error: 'not found' })
    })
  })
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => {
    resolve({ calls, url: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((r) => { server.closeAllConnections?.(); server.close(() => r()) }) })
  }))
}

// ---------------------------------------------------------------- stub host

function stubHost({ settings, webServer, jobs, connection } = {}) {
  const tools = new Map()
  const effects = []
  const listeners = new Map()
  const services = { tools: { register(def) { tools.set(def.name, def); return () => tools.delete(def.name) } } }
  if (settings !== undefined) services.settings = settings
  if (webServer !== undefined) services.webServer = webServer
  if (jobs !== undefined) services.jobs = jobs
  if (connection !== undefined) services.connection = connection
  const ctx = {
    fiber: { label: 'stub-fiber' },
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    get: (name) => services[name],
    on: (name, fn) => { listeners.set(name, fn); return () => listeners.delete(name) },
    effect: (fn) => { const dispose = fn(); effects.push(dispose); return dispose },
    inject: (names, cb) => {
      if (names.every((name) => services[name] !== undefined)) {
        const child = { ...ctx }
        for (const name of names) child[name] = services[name]
        cb(child)
      }
    },
  }
  ctx.tools = services.tools
  return { ctx, tools, listeners, dispose: () => { for (const d of effects.reverse()) if (typeof d === 'function') d() } }
}

function stubJobs() {
  const started = []
  return {
    started,
    start(spec) { started.push(spec); return `comfyui-${started.length}` },
    // 0.1.7+ surface; its presence must not be what the plugin relies on.
    readAt() { return { chunks: [], nextOffset: 0 } },
  }
}

function jobHandle() {
  const progress = []
  const appended = []
  return { id: 'comfyui-1', progress, appended, append(text) { appended.push(text) }, updateProgress(line) { progress.push(line) } }
}

const plugin = await import(join(root, 'lib', 'index.js'))

async function withPlugin(options, fn) {
  if (options.jobsOverride !== undefined) options.host = { ...options.host, jobs: options.jobsOverride }
  const dataDir = await mkdtemp(join(tmpdir(), 'dsh-comfyui-test-'))
  const comfy = await startComfy(options.comfy)
  const jobs = stubJobs()
  const host = stubHost({ jobs, ...options.host })
  const effectiveJobs = options.host?.jobs ?? jobs
  try {
    if (options.seed !== undefined) await options.seed(dataDir)
    await plugin.apply(host.ctx, { baseUrl: comfy.url, dataDir, pollIntervalMs: 200, ...options.config })
    await fn({ host, comfy, jobs: effectiveJobs, dataDir })
  } finally {
    host.dispose()
    await comfy.close()
    await rm(dataDir, { recursive: true, force: true })
  }
}

const execFor = (signal = new AbortController().signal) => ({
  callId: 'call-1',
  name: 'comfyui_run',
  arguments: {},
  agent: { id: 'session-abc' },
  signal,
  deferContext() {},
  concludeTurn() {},
})

await test('apply registers the four tools with an output contract', async () => {
  await withPlugin({}, async ({ host }) => {
    assert.deepEqual([...host.tools.keys()].sort(), ['comfyui_object_info', 'comfyui_run', 'comfyui_skill', 'comfyui_workflow'])
    for (const def of host.tools.values()) {
      assert.equal(typeof def.output?.render, 'function', `${def.name} render`)
      assert.equal(typeof def.output?.schema, 'object', `${def.name} schema`)
    }
  })
})

await test('workflow list exposes a host-supported typed LoRA shape and merge guidance', async () => {
  const seed = async dataDir => {
    const { ComfyUIStore } = await import(join(root, 'lib', 'store.js'))
    const { analyzeWorkflowParameters } = await import(join(root, 'lib', 'params.js'))
    const store = new ComfyUIStore(dataDir, 100)
    await store.init()
    const workflow = { '17': { class_type: 'Power Lora Loader (rgthree)', inputs: { lora_1: { on: false, lora: 'synthetic.safetensors', strength: 0, strengthTwo: null } } } }
    await store.saveWorkflow({ name: 'LoRA synthetic', description: '', workflow, parameters: analyzeWorkflowParameters(workflow) })
  }
  await withPlugin({ seed }, async ({ host }) => {
    const def = host.tools.get('comfyui_workflow')
    const { assertSupportedJsonSchema, validateJsonSchemaValue } = await import('@deepseek-ai/dsh-tools')
    assertSupportedJsonSchema(def.output.schema)
    assert.ok(def.output.schema.properties?.workflows, 'opaque workflow list schema')
    const value = await def.execute({ action: 'list' }, execFor())
    assert.deepEqual(validateJsonSchemaValue(def.output.schema, JSON.parse(JSON.stringify(value))), [])
    const text = def.output.render({ action: 'list' }, value).map(x => x.text).join('\n')
    assert.match(text, /strengthTwo/)
    assert.match(text, /partial|частич/)
    assert.ok(!text.includes('[object Object]'))
  })
})

await test('settings: 0.2 path only — configure({auto:false}); legacy installSection is never used', async () => {
  const calls = { configure: [], installSection: 0 }
  const settings = {
    writable: true,
    async update() {},
    configure(presentation, owner) { calls.configure.push({ presentation, owner }); return () => {} },
    installSection() { calls.installSection += 1 },
  }
  await withPlugin({ host: { settings } }, async ({ host }) => {
    assert.equal(calls.installSection, 0)
    assert.equal(calls.configure.length, 1)
    assert.deepEqual(calls.configure[0].presentation, { auto: false })
    assert.ok(host.listeners.has('loader/volatile-update'))
  })
})

await test('async run: owner is the SessionId, outcome carries `result`, not `output`', async () => {
  await withPlugin({}, async ({ host, jobs }) => {
    const value = await host.tools.get('comfyui_run').execute({ template: 'txt2img', mode: 'async' }, execFor())
    assert.equal(value.kind, 'background')
    assert.equal(jobs.started.length, 1)
    const spec = jobs.started[0]
    assert.equal(spec.owner, 'session-abc')
    assert.equal(spec.kind, 'comfyui')
    const handle = jobHandle()
    const hooks = spec.run(handle)
    const outcome = await hooks.done
    assert.equal(outcome.status, 'completed')
    assert.ok(!('output' in outcome), 'legacy output field is gone')
    assert.equal(typeof outcome.result, 'string')
    const parsed = JSON.parse(outcome.result)
    assert.equal(parsed.promptId, value.promptId)
    assert.equal(parsed.media.length, 1)
  })
})

await test('async workflow run: same owner/result contract via comfyui_workflow', async () => {
  let id
  const seed = async (dataDir) => {
    const { ComfyUIStore } = await import(join(root, 'lib', 'store.js'))
    const store = new ComfyUIStore(dataDir, 100)
    await store.init()
    const saved = await store.saveWorkflow({
      name: 'stub', description: 'stub', source: 'paste', parameters: [],
      workflow: { 9: { class_type: 'SaveImage', inputs: { filename_prefix: 'x' } } },
    })
    assert.ok(saved.ok, JSON.stringify(saved))
    id = saved.workflow.id
  }
  await withPlugin({ seed }, async ({ host, jobs }) => {
    const value = await host.tools.get('comfyui_workflow').execute({ action: 'run', id, mode: 'async' }, execFor())
    assert.equal(value.background?.kind, 'background')
    assert.equal(jobs.started[0].owner, 'session-abc')
    const outcome = await jobs.started[0].run(jobHandle()).done
    assert.equal(outcome.status, 'completed')
    assert.ok(!('output' in outcome))
    assert.equal(JSON.parse(outcome.result).promptId, value.background.promptId)
  })
})

await test('async cancel stops polling and cancels only this prompt (no global interrupt)', async () => {
  await withPlugin({ comfy: { completeAfterPolls: Infinity } }, async ({ host, jobs, comfy }) => {
    const value = await host.tools.get('comfyui_run').execute({ template: 'txt2img', mode: 'async' }, execFor())
    const hooks = jobs.started[0].run(jobHandle())
    await new Promise((r) => setTimeout(r, 300))
    hooks.cancel('test')
    const outcome = await Promise.race([hooks.done, new Promise((_, reject) => setTimeout(() => reject(new Error('done did not settle after cancel')), 3000))])
    assert.equal(outcome.status, 'killed')
    const interrupts = comfy.calls.filter((c) => c.url === '/interrupt')
    assert.ok(interrupts.length >= 1, 'interrupt was sent')
    for (const call of interrupts) assert.deepEqual(JSON.parse(call.body || '{}'), { prompt_id: value.promptId })
    const dequeues = comfy.calls.filter((c) => c.url === '/queue' && c.method === 'POST')
    assert.ok(dequeues.some((c) => JSON.stringify(JSON.parse(c.body).delete) === JSON.stringify([value.promptId])), 'pending prompt is dequeued')
    const pollsAtCancel = comfy.calls.filter((c) => c.url.startsWith('/history/')).length
    await new Promise((r) => setTimeout(r, 600))
    assert.equal(comfy.calls.filter((c) => c.url.startsWith('/history/')).length, pollsAtCancel, 'polling stopped')
  })
})

await test('sync abort cancels only this prompt', async () => {
  await withPlugin({ comfy: { completeAfterPolls: Infinity } }, async ({ host, comfy }) => {
    const controller = new AbortController()
    const running = host.tools.get('comfyui_run').execute({ template: 'txt2img' }, execFor(controller.signal))
    await new Promise((r) => setTimeout(r, 300))
    controller.abort()
    const value = await running
    assert.equal(value.status, 'interrupted')
    const interrupts = comfy.calls.filter((c) => c.url === '/interrupt')
    assert.ok(interrupts.length >= 1)
    for (const call of interrupts) assert.deepEqual(JSON.parse(call.body || '{}'), { prompt_id: value.promptId })
  })
})

await test('media URLs use the web server bind address, not a guessed LAN IP', async () => {
  const webServer = { host: '127.0.0.1', port: 3399, register() { return () => {} }, tapIndex() { return () => {} } }
  await withPlugin({ host: { webServer } }, async ({ host }) => {
    const value = await host.tools.get('comfyui_run').execute({ template: 'txt2img' }, execFor())
    assert.equal(value.status, 'completed')
    assert.ok(value.media[0].url.startsWith('http://127.0.0.1:3399/comfyui/media'), value.media[0].url)
  })
})

await test('presentationMeta is pure JSON for sync and background results', async () => {
  await withPlugin({}, async ({ host }) => {
    const run = host.tools.get('comfyui_run')
    for (const args of [{ template: 'txt2img' }, { template: 'txt2img', mode: 'async' }]) {
      const value = await run.execute(args, execFor())
      const meta = run.output.presentationMeta(args, value)
      assert.deepEqual(JSON.parse(JSON.stringify(meta)), meta)
      const content = run.output.render(args, value)
      assert.ok(Array.isArray(content) && content.length > 0)
    }
  })
})

await test('comfyui_run declares a typed output schema the host accepts and enforces', async () => {
  const { assertSupportedJsonSchema, validateJsonSchemaValue } = await import('@deepseek-ai/dsh-tools')
  await withPlugin({}, async ({ host }) => {
    const run = host.tools.get('comfyui_run')
    const schema = run.output.schema
    assertSupportedJsonSchema(schema)
    assert.ok(Array.isArray(schema.oneOf) && schema.oneOf.length === 2, 'sync | background union')
    for (const args of [{ template: 'txt2img' }, { template: 'txt2img', mode: 'async' }]) {
      const value = await run.execute(args, execFor())
      assert.deepEqual(validateJsonSchemaValue(schema, JSON.parse(JSON.stringify(value))), [])
    }
    assert.ok(validateJsonSchemaValue(schema, { kind: 'background' }).length > 0, 'incomplete value is rejected')
  })
})


// ---------------------------------------------------------------- web routes (security)

function captureWebServer({ host = '127.0.0.1', port = 3399, protocol = 'http:' } = {}) {
  const routes = new Map()
  return {
    routes, host, port, protocol,
    register(route) { routes.set(route.path, route); return () => routes.delete(route.path) },
    tapIndex() { return () => {} },
  }
}

function fakeRequest({ method = 'GET', url = '/', headers = {}, body } = {}) {
  const chunks = body === undefined ? [] : [Buffer.from(body)]
  const req = {
    method, url, headers: { host: '127.0.0.1:3399', ...headers },
    resume() {},
    async *[Symbol.asyncIterator]() { for (const c of chunks) yield c },
  }
  return req
}

function fakeResponse() {
  const collected = []
  const res = new Writable({ write(chunk, _enc, cb) { collected.push(Buffer.from(chunk)); cb() } })
  res.statusCode = 200
  res.headers = {}
  Object.defineProperty(res, 'body', { get: () => Buffer.concat(collected) })
  Object.defineProperty(res, 'headersSent', { get: () => res._sent === true })
  res.setHeader = (k, v) => { res.headers[k.toLowerCase()] = v }
  res.getHeader = (k) => res.headers[k.toLowerCase()]
  res.writeHead = (status, headers = {}) => { res.statusCode = status; res._sent = true; for (const [k, v] of Object.entries(headers)) res.headers[k.toLowerCase()] = v; return res }
  return res
}

async function callRoute(ws, path, request) {
  const route = ws.routes.get(path) ?? [...ws.routes.values()].find((r) => r.kind === 'prefix' && path.startsWith(r.path))
  assert.ok(route, `route ${path} registered`)
  const res = fakeResponse()
  await route.handler(request, res)
  return res
}

const allow = { requestRejection: () => undefined }

await test('every /comfyui route refuses requests the DSH connection rejects (401/403)', async () => {
  const ws = captureWebServer()
  await withPlugin({ host: { webServer: ws, connection: { requestRejection: () => 401 } } }, async () => {
    assert.ok(ws.routes.size >= 30, `routes mounted: ${ws.routes.size}`)
    for (const route of ws.routes.values()) {
      const res = fakeResponse()
      await route.handler(fakeRequest({ method: 'GET', url: route.path }), res)
      assert.equal(res.statusCode, 401, `${route.path} -> ${res.statusCode}`)
    }
  })
})

await test('routes fail closed when the host has no connection service', async () => {
  const ws = captureWebServer()
  await withPlugin({ host: { webServer: ws } }, async () => {
    for (const route of ws.routes.values()) {
      const res = fakeResponse()
      await route.handler(fakeRequest({ url: route.path }), res)
      assert.ok(res.statusCode === 403 || res.statusCode === 401, `${route.path} -> ${res.statusCode}`)
    }
  })
})

await test('host hint ignores Referer / X-Forwarded-Proto and unauthenticated requests', async () => {
  const ws = captureWebServer()
  let reject = 401
  const connection = { requestRejection: () => reject }
  await withPlugin({ host: { webServer: ws, connection } }, async ({ host }) => {
    await callRoute(ws, '/comfyui/ping', fakeRequest({ url: '/comfyui/ping', headers: { host: 'evil.example', referer: 'https://evil.example/x' } }))
    reject = undefined
    await callRoute(ws, '/comfyui/ping', fakeRequest({ url: '/comfyui/ping', headers: { referer: 'https://evil.example/x', 'x-forwarded-proto': 'javascript:alert(1)//' } }))
    const value = await host.tools.get('comfyui_run').execute({ template: 'txt2img' }, execFor())
    assert.ok(value.media[0].url.startsWith('http://127.0.0.1:3399/comfyui/media'), value.media[0].url)
  })
})

await test('media proxy never relays an active content type', async () => {
  const ws = captureWebServer()
  await withPlugin({ host: { webServer: ws, connection: allow }, comfy: { viewType: 'text/html' } }, async () => {
    const res = await callRoute(ws, '/comfyui/media', fakeRequest({ url: '/comfyui/media?file=x.png&subfolder=&type=output' }))
    assert.equal(res.headers['content-type'], 'application/octet-stream')
    assert.equal(res.headers['x-content-type-options'], 'nosniff')
    assert.match(String(res.headers['content-security-policy']), /sandbox/)
  })
})

await test('skill-pack SVG is served as a sandboxed attachment', async () => {
  const ws = captureWebServer()
  let id
  const seed = async (dataDir) => {
    const { ComfyUIStore } = await import(join(root, 'lib', 'store.js'))
    const store = new ComfyUIStore(dataDir, 100); await store.init()
    const saved = await store.saveWorkflow({ name: 'svg', description: '', source: 'paste', parameters: [], workflow: { 9: { class_type: 'SaveImage', inputs: {} } } })
    id = saved.workflow.id
  }
  await withPlugin({ seed, host: { webServer: ws, connection: allow } }, async ({ host }) => {
    const skill = host.tools.get('comfyui_skill')
    await skill.execute({ action: 'enable', workflow_id: id }, execFor())
    const wrote = await skill.execute({ action: 'write', workflow_id: id, path: 'assets/x.svg', content: '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>' }, execFor()).catch((e) => ({ error: String(e) }))
    assert.equal(wrote.error, undefined, 'svg written through the model tool (the attack path)')
    const res = await callRoute(ws, '/comfyui/workflows/skill/raw', fakeRequest({ url: `/comfyui/workflows/skill/raw?id=${id}&path=assets/x.svg` }))
    assert.equal(res.statusCode, 200)
    assert.match(String(res.headers['content-disposition']), /^attachment/)
    assert.match(String(res.headers['content-security-policy']), /sandbox/)
  })
})

await test('oversized JSON bodies are refused with 413 before parsing', async () => {
  const ws = captureWebServer()
  await withPlugin({ host: { webServer: ws, connection: allow } }, async () => {
    const big = JSON.stringify({ patch: { mediaHost: 'x'.repeat(20 * 1024 * 1024) } })
    const res = await callRoute(ws, '/comfyui/config', fakeRequest({ method: 'POST', url: '/comfyui/config', headers: { 'content-type': 'application/json', 'content-length': String(big.length) }, body: big }))
    assert.equal(res.statusCode, 413)
  })
})

await test('asset deletion never infers the output root from server-reported fullpath', async () => {
  const routes = await import(join(root, 'lib', 'routes.js'))
  assert.equal(typeof routes.resolveOutputDir, 'function')
  const assets = [{ media: [{ fullpath: '/home/u/.ssh/id_rsa', subfolder: '.ssh', filename: 'id_rsa' }] }]
  assert.equal(routes.resolveOutputDir('', assets), undefined)
  assert.equal(routes.resolveOutputDir('/srv/comfy/output', assets), '/srv/comfy/output')
})

await test('cancel does not interrupt when another client owns the running prompt (old ComfyUI)', async () => {
  await withPlugin({ comfy: { completeAfterPolls: Infinity, foreignRunning: true } }, async ({ host, jobs, comfy }) => {
    await host.tools.get('comfyui_run').execute({ template: 'txt2img', mode: 'async' }, execFor())
    const hooks = jobs.started[0].run(jobHandle())
    await new Promise((r) => setTimeout(r, 250))
    hooks.cancel('test')
    await hooks.done
    assert.equal(comfy.calls.filter((c) => c.url === '/interrupt').length, 0, 'no interrupt while a foreign prompt runs')
    assert.ok(comfy.calls.some((c) => c.url === '/queue' && c.method === 'POST'), 'still dequeued')
  })
})

// ---------------------------------------------------------------- spec review follow-ups

await test('every tool parameter schema is inside the host-enforced subset (typed PTC args)', async () => {
  const { assertSupportedJsonSchema } = await import('@deepseek-ai/dsh-tools')
  await withPlugin({}, async ({ host }) => {
    for (const def of host.tools.values()) assertSupportedJsonSchema(def.parameters)
  })
})

await test('a failing jobs.start leaves no orphan prompt queued', async () => {
  const broken = { start() { throw new Error('no controller') } }
  await withPlugin({ jobsOverride: broken }, async ({ host, comfy }) => {
    await assert.rejects(host.tools.get('comfyui_run').execute({ template: 'txt2img', mode: 'async' }, execFor()))
    assert.ok(comfy.calls.some((c) => c.url === '/queue' && c.method === 'POST' && c.body.includes('delete')), 'queued prompt was removed')
  })
})

await test('an invalid mode is rejected before anything is queued', async () => {
  await withPlugin({}, async ({ host, comfy }) => {
    await assert.rejects(host.tools.get('comfyui_run').execute({ template: 'txt2img', mode: 'bogus' }, execFor()))
    assert.equal(comfy.calls.filter((c) => c.url === '/prompt').length, 0)
  })
})

await test('async without a jobs service is refused before anything is queued (both tools)', async () => {
  let id
  const seed = async (dataDir) => {
    const { ComfyUIStore } = await import(join(root, 'lib', 'store.js'))
    const store = new ComfyUIStore(dataDir, 100)
    await store.init()
    const saved = await store.saveWorkflow({
      name: 'stub', description: 'stub', source: 'paste', parameters: [],
      workflow: { 9: { class_type: 'SaveImage', inputs: { filename_prefix: 'x' } } },
    })
    id = saved.workflow.id
  }
  await withPlugin({ seed, host: { jobs: undefined } }, async ({ host, comfy }) => {
    await assert.rejects(host.tools.get('comfyui_run').execute({ template: 'txt2img', mode: 'async' }, execFor()), /background jobs unavailable/)
    await assert.rejects(host.tools.get('comfyui_workflow').execute({ action: 'run', id, mode: 'async' }, execFor()), /background jobs unavailable/)
    assert.equal(comfy.calls.filter((c) => c.url === '/prompt').length, 0, 'no orphan prompt')
  })
})

await test('bindOrigin honours https and strips IPv6 zone ids', async () => {
  const { bindOrigin } = plugin
  assert.equal(bindOrigin('127.0.0.1', 3399, 'https:'), 'https://127.0.0.1:3399')
  assert.equal(bindOrigin('fe80::1%eth0', 80, 'http:'), 'http://[fe80::1]:80')
  assert.equal(bindOrigin('::1', 3399), 'http://[::1]:3399')
})

console.log(`\n${passed} passed, ${failures} failed`)
process.exit(failures === 0 ? 0 : 1)
