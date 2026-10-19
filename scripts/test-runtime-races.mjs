// Real plugin wiring, synthetic credentials and HTTP responses only.
import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { apply } from '../lib/index.js'
import { ComfyUIStore } from '../lib/store.js'

const definition = { SyntheticNode: { input: { required: { value: ['FLOAT', {}] } } } }
const exec = () => ({ signal: new AbortController().signal, agent: { id: 'synthetic-session' } })
async function fixture(fn) {
  const dataDir = await mkdtemp(join(tmpdir(), 'comfyui-runtime-races-'))
  const store = new ComfyUIStore(dataDir, 100)
  await store.init()
  const saved = await store.saveWorkflow({ name: 'Synthetic', description: '', workflow: { '1': { class_type: 'SyntheticNode', inputs: { value: 1 } } }, parameters: [{ id: 'value', name: 'value', label: 'Value', type: 'number', nodeId: '1', inputKey: 'value', default: 1 }] })
  const tools = new Map(), listeners = new Map(), disposers = []
  const cfg = { baseUrl: 'http://server-a.invalid', apiKeyEnv: 'SYNTHETIC_A', dataDir }
  let resolveKey = async reference => ({ value: reference + '-test-value' })
  const services = { tools: { register(def) { tools.set(def.name, def); return () => tools.delete(def.name) } }, credentials: { resolve: reference => resolveKey(reference) } }
  const ctx = {
    fiber: {}, tools: services.tools, logger: { info() {}, warn() {}, error() {}, debug() {} },
    get: name => services[name],
    on(name, listener) { listeners.set(name, listener); return () => {} },
    effect(fn) { const dispose = fn(); disposers.push(dispose); return dispose },
    inject(names, callback) { if (names.every(name => services[name])) callback(ctx) },
  }
  const calls = []
  const originalFetch = globalThis.fetch, originalWebSocket = globalThis.WebSocket
  globalThis.WebSocket = class { addEventListener() {} close() {} }
  let handler = async () => undefined
  let prompt = 0
  globalThis.fetch = async (url, init) => {
    const call = { url: new URL(url), auth: init.headers?.Authorization, body: init.body ? JSON.parse(init.body) : undefined }
    calls.push(call)
    const override = await handler(call)
    if (override !== undefined) return override
    if (call.url.pathname === '/object_info') return Response.json(definition)
    if (call.url.pathname === '/prompt') return Response.json({ prompt_id: `synthetic-${++prompt}` })
    if (call.url.pathname.startsWith('/history/')) return Response.json({ [decodeURIComponent(call.url.pathname.split('/').at(-1))]: { status: { completed: true }, outputs: {} } })
    return Response.json({})
  }
  try {
    await apply(ctx, cfg)
    await fn({
      calls, cfg,
      setCredentials: resolver => { resolveKey = resolver },
      setHandler: next => { handler = next },
      update: patch => { Object.assign(cfg, patch); listeners.get('loader/volatile-update')() },
      run: () => tools.get('comfyui_workflow').execute({ action: 'run', id: saved.workflow.id }, exec()),
      refresh: () => tools.get('comfyui_workflow').execute({ action: 'refresh', id: saved.workflow.id }, exec()),
      discover: () => tools.get('comfyui_object_info').execute({}, exec()),
    })
  } finally {
    for (const dispose of disposers.reverse()) if (typeof dispose === 'function') dispose()
    globalThis.fetch = originalFetch; globalThis.WebSocket = originalWebSocket
    // Let best-effort tracked-state persistence settle before fixture teardown.
    await new Promise(resolve => setTimeout(resolve, 30))
    await rm(dataDir, { recursive: true, force: true })
  }
}

test('real plugin coalesces parameter-definition loads for 10 concurrent runs', () => fixture(async ({ run, calls }) => {
  await Promise.all(Array.from({ length: 10 }, run))
  assert.equal(calls.filter(call => call.url.pathname === '/object_info').length, 1)
  assert.equal(calls.filter(call => call.url.pathname === '/prompt').length, 10)
}))

test('real plugin changes cache identity when server or resolved credential changes', () => fixture(async ({ run, calls, update, setCredentials }) => {
  await run(); await run()
  update({ baseUrl: 'http://server-b.invalid', apiKeyEnv: 'SYNTHETIC_B' })
  await run(); await run()
  setCredentials(async () => ({ value: 'synthetic-rotated-key' }))
  await run(); await run()
  const loads = calls.filter(call => call.url.pathname === '/object_info')
  assert.deepEqual(loads.map(call => [call.url.host, call.auth]), [
    ['server-a.invalid', 'Bearer SYNTHETIC_A-test-value'],
    ['server-b.invalid', 'Bearer SYNTHETIC_B-test-value'],
    ['server-b.invalid', 'Bearer synthetic-rotated-key'],
  ])
}))

test('real tool credential race keeps queue and history on the same original server', () => fixture(async ({ run, calls, update, setCredentials }) => {
  const gate = Promise.withResolvers(), entered = Promise.withResolvers()
  setCredentials(reference => { entered.resolve(reference); return gate.promise })
  const running = run()
  assert.equal(await entered.promise, 'SYNTHETIC_A')
  update({ baseUrl: 'http://server-b.invalid', apiKeyEnv: 'SYNTHETIC_B' })
  gate.resolve({ value: 'synthetic-old-key' })
  await running
  assert.ok(calls.length >= 3)
  assert.ok(calls.every(call => call.url.host === 'server-a.invalid'))
  assert.ok(calls.every(call => call.auth === 'Bearer synthetic-old-key'))
}))

test('real refresh invalidates old parameter flights without allowing late cache repopulation', () => fixture(async ({ run, refresh, calls, setHandler }) => {
  const old = Promise.withResolvers(), entered = Promise.withResolvers()
  let infoCalls = 0
  setHandler(call => {
    if (call.url.pathname === '/object_info' && ++infoCalls === 1) { entered.resolve(); return old.promise }
  })
  const oldRun = run()
  await entered.promise
  await refresh()
  await run()
  old.resolve(Response.json(definition))
  await oldRun
  await run()
  assert.equal(calls.filter(call => call.url.pathname === '/object_info').length, 3)
}))
