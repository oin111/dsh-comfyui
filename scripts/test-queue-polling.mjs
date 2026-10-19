import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import ts from 'typescript'

const tick = () => new Promise(resolve => setImmediate(resolve))
const deferred = () => {
  let resolve, reject
  const promise = new Promise((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
const transpile = source => ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText
const pollingSource = transpile(readFileSync(new URL('../src/client/queue-polling.ts', import.meta.url), 'utf8').replace(/export /g, ''))
const panelSource = transpile(readFileSync(new URL('../src/client/panel.tsx', import.meta.url), 'utf8').replace(/^import .*$/gm, '').replace(/export /g, ''))

function environment(extra = {}) {
  let now = 0, nextId = 1
  const timers = new Map(), listeners = new Set()
  const document = {
    hidden: false,
    addEventListener(type, fn) { assert.equal(type, 'visibilitychange'); listeners.add(fn) },
    removeEventListener(type, fn) { assert.equal(type, 'visibilitychange'); listeners.delete(fn) },
  }
  const context = vm.createContext({
    AbortController, ...extra, document,
    setTimeout(fn, ms) { const id = nextId++; timers.set(id, { at: now + ms, fn }); return id },
    clearTimeout(id) { timers.delete(id) },
  })
  vm.runInContext(pollingSource, context)
  return {
    context, timers, listeners,
    visibility(hidden) { document.hidden = hidden; for (const fn of listeners) fn() },
    advance(ms) {
      const target = now + ms
      while (true) {
        const due = [...timers].filter(([, timer]) => timer.at <= target).sort((a, b) => a[1].at - b[1].at)[0]
        if (!due) break
        now = due[1].at; timers.delete(due[0]); due[1].fn()
      }
      now = target
    },
  }
}
function pollerHarness() {
  const env = environment()
  const requests = [], applied = [], failures = []
  const poller = env.context.createQueuePoller({
    read(signal) { const pair = [deferred(), deferred()]; pair.signal = signal; requests.push(pair); return pair.map(item => item.promise) },
    apply(data) { applied.push(data) },
    fail(error) { failures.push(error) },
  })
  return { ...env, poller, requests, applied, failures }
}
const settle = pair => { pair[0].resolve('active'); pair[1].resolve('history') }

test('slow polls and an early rejection hold the single-flight gate until every sibling settles', async () => {
  const h = pollerHarness()
  h.requests[0][0].reject(new Error('early failure'))
  await tick()
  h.advance(30_000)
  assert.equal(h.requests.length, 1)
  assert.equal(h.failures.length, 0, 'unfinished sibling request still owns this poll')
  h.poller.refresh()
  h.poller.refresh()
  await tick()
  assert.equal(h.requests.length, 1, 'manual refresh must not bypass the gate')
  h.requests[0][1].resolve('old history')
  await tick()
  assert.equal(h.requests.length, 2)
  assert.equal(h.applied.length, 0)
  assert.equal(h.failures.length, 0, 'invalidated failures are stale too')
  settle(h.requests[1])
  await tick()
  assert.equal(h.applied.length, 1)
  h.advance(2_999)
  assert.equal(h.requests.length, 2)
  h.advance(1)
  assert.equal(h.requests.length, 3)
  h.poller.dispose()
  settle(h.requests[2])
  await tick()
})

test('failed settled poll reports its error and retries only after the polling delay', async () => {
  const h = pollerHarness()
  h.requests[0][0].reject(new Error('offline'))
  h.requests[0][1].resolve('history')
  await tick()
  assert.equal(h.failures.length, 1)
  assert.match(h.failures[0].message, /offline/)
  h.advance(3_000)
  assert.equal(h.requests.length, 2)
  settle(h.requests[1])
  await tick()
  assert.equal(h.applied.length, 1)
  h.poller.dispose()
})

test('hidden tabs pause timers and ignore old responses; showing resumes with one fresh poll', async () => {
  const h = pollerHarness()
  h.visibility(true)
  settle(h.requests[0])
  await tick()
  assert.equal(h.applied.length, 0)
  h.advance(60_000)
  assert.equal(h.requests.length, 1)
  assert.equal(h.timers.size, 0)
  h.visibility(false)
  assert.equal(h.requests.length, 2)
  settle(h.requests[1])
  await tick()
  assert.equal(h.applied.length, 1)
  assert.equal(h.timers.size, 1)
  h.visibility(true)
  assert.equal(h.timers.size, 0)
  h.advance(60_000)
  assert.equal(h.requests.length, 2)
  h.poller.dispose()
  assert.equal(h.listeners.size, 0)
})

test('hide/show while requests remain in flight cannot start overlapping requests', async () => {
  const h = pollerHarness()
  h.visibility(true)
  h.visibility(false)
  h.visibility(true)
  h.visibility(false)
  assert.equal(h.requests.length, 1)
  settle(h.requests[0])
  await tick()
  assert.equal(h.requests.length, 2)
  assert.equal(h.applied.length, 0)
  h.poller.dispose()
  settle(h.requests[1])
  await tick()
  assert.equal(h.applied.length, 0)
  assert.equal(h.timers.size, 0)
  h.visibility(false)
  h.poller.refresh()
  h.advance(60_000)
  assert.equal(h.requests.length, 2)
})

test('a tab mounted while hidden waits until visible before sending any requests', async () => {
  const env = environment()
  env.visibility(true)
  let reads = 0
  const poller = env.context.createQueuePoller({ read: () => { reads++; return [] }, apply() {}, fail() {} })
  assert.equal(reads, 0)
  env.advance(60_000)
  assert.equal(reads, 0)
  env.visibility(false)
  await tick()
  assert.equal(reads, 1)
  poller.dispose()
})

const all = tree => !tree || typeof tree !== 'object' ? [] : [tree, ...tree.children.flat(Infinity).flatMap(all)]
function panelHarness() {
  let slots = []
  const effects = [], requests = [], actions = []
  let index = 0, mounted = true, updates = 0, lateUpdates = 0
  const env = environment({
    Component: class {},
    h: (type, props, ...children) => ({ type, props: props ?? {}, children }),
    useState(initial) {
      const i = index++
      if (!(i in slots)) slots[i] = typeof initial === 'function' ? initial() : initial
      return [slots[i], value => { if (!mounted) lateUpdates++; updates++; slots[i] = typeof value === 'function' ? value(slots[i]) : value }]
    },
    useRef(initial) {
      const i = index++
      if (!(i in slots)) slots[i] = { current: initial }
      return slots[i]
    },
    useEffect(fn, dependencies) {
      const i = index++
      const previous = slots[i]
      if (previous && dependencies.every((value, n) => Object.is(previous.dependencies[n], value))) return
      slots[i] = { dependencies, cleanup: previous?.cleanup, setup: fn }
      effects.push(() => { slots[i].cleanup?.(); slots[i].cleanup = fn() })
    },
    getJson(path, signal) { const pending = deferred(); requests.push({ path, signal, ...pending }); return pending.promise },
    postJson(path, body) { const pending = deferred(); actions.push({ path, body, ...pending }); return pending.promise },
  })
  vm.runInContext(panelSource, env.context)
  const t = key => key
  return {
    ...env, requests, actions,
    get lateUpdates() { return lateUpdates },
    get updates() { return updates },
    render() {
      index = 0
      const tree = all(env.context.QueueTab({ t, onPreview() {} }))
      for (const effect of effects.splice(0)) effect()
      return tree
    },
    close() {
      mounted = false
      for (const value of slots) value?.cleanup?.()
    },
    reopen() { mounted = true; slots = []; return this.render() },
    replayEffects() {
      for (const value of slots) {
        if (value?.setup) { value.cleanup?.(); value.cleanup = value.setup() }
      }
    },
    resolvePoll(start = requests.length - 2, ids = ['active', 'history']) {
      for (let n = 0; n < 2; n++) requests[start + n].resolve({ ok: true, jobs: [{ id: ids[n], createTime: n, previewOutput: null }] })
    },
  }
}

test('QueueTab filter changes discard stale requests and refresh with the latest filter', async () => {
  const h = panelHarness()
  h.render()
  assert.equal(h.requests.length, 2, 'mount should send exactly one pair')
  h.resolvePoll()
  await tick()
  let tree = h.render()
  h.advance(3_000)
  assert.equal(h.requests.length, 4)
  tree.find(node => node.type === 'button' && node.children.includes('jobFilterFailed')).props.onClick()
  h.render()
  assert.equal(h.requests.length, 4)
  h.resolvePoll(2, ['stale active', 'stale history'])
  await tick()
  assert.equal(h.requests.length, 6)
  assert.match(h.requests[5].path, /status=failed&/)
  tree = h.render()
  assert.ok(!tree.some(node => node.props.job?.id === 'stale history'))
  h.resolvePoll(4, ['fresh active', 'fresh history'])
  await tick()
  assert.ok(h.render().some(node => node.props.job?.id === 'fresh history'))
  h.close()
})

test('QueueTab closing suppresses both late success and failure from polling', async () => {
  for (const fail of [false, true]) {
    const h = panelHarness()
    h.render()
    h.close()
    if (fail) { h.requests[0].reject(new Error('offline')); h.requests[1].resolve({ ok: true, jobs: [] }) }
    else h.resolvePoll()
    await tick()
    assert.equal(h.lateUpdates, 0)
    assert.equal(h.listeners.size, 0)
    assert.equal(h.timers.size, 0)
    h.advance(30_000)
    assert.equal(h.requests.length, 2)
  }
})

test('QueueTab action completions cannot update or refresh a closed component', async () => {
  for (const fail of [false, true]) {
    const h = panelHarness()
    h.render(); h.resolvePoll(); await tick()
    const button = h.render().find(node => node.type === 'button' && node.children.includes('jobClearQueue'))
    button.props.onClick()
    button.props.onClick()
    assert.equal(h.actions.length, 1, 'repeated clicks before render must be serialized')
    h.close()
    if (fail) h.actions[0].reject(new Error('action failed'))
    else h.actions[0].resolve({ ok: true })
    await tick()
    assert.equal(h.lateUpdates, 0)
    assert.equal(h.requests.length, 2)
    assert.equal(h.timers.size, 0)
  }
})

test('QueueTab action refresh waits for every existing poll request before starting fresh', async () => {
  const h = panelHarness()
  h.render(); h.resolvePoll(); await tick()
  const button = h.render().find(node => node.type === 'button' && node.children.includes('jobClearQueue'))
  h.advance(3_000)
  button.props.onClick()
  h.actions[0].resolve({ ok: true })
  h.requests[2].reject(new Error('early failed poll'))
  await tick()
  assert.equal(h.requests.length, 4)
  h.requests[3].resolve({ ok: true, jobs: [] })
  await tick()
  assert.equal(h.requests.length, 6)
  h.resolvePoll(4)
  await tick()
  h.close()
})

test('remount aborts old reads and waits for both to drain even when cancellation is ignored', async () => {
  const h = panelHarness()
  h.render()
  const oldSignal = h.requests[0].signal
  assert.equal(oldSignal, h.requests[1].signal)
  assert.equal(oldSignal.aborted, false)
  h.close()
  assert.equal(oldSignal.aborted, true)
  h.reopen()
  assert.equal(h.requests.length, 2, 'remount must wait for outstanding cancelled requests')
  h.requests[0].reject(new Error('cancelled first request'))
  await tick()
  assert.equal(h.requests.length, 2, 'the second old request still owns the gate')
  h.requests[1].resolve({ ok: true, jobs: [] })
  await tick()
  assert.equal(h.requests.length, 4)
  assert.equal(h.updates, 0, 'the closed tab must not update after its replacement mounts')
  assert.notEqual(h.requests[2].signal, oldSignal)
  assert.equal(h.requests[2].signal.aborted, false)
  h.resolvePoll(2, ['new active', 'new history'])
  await tick()
  assert.ok(h.render().some(node => node.props.job?.id === 'new history'))
  assert.equal(h.lateUpdates, 0)
  h.close()
})

test('StrictMode effect replay cancels before replacing the poller and never overlaps reads', async () => {
  const h = panelHarness()
  h.render()
  const oldSignal = h.requests[0].signal
  h.replayEffects()
  assert.equal(oldSignal.aborted, true)
  assert.equal(h.requests.length, 2)
  h.resolvePoll(0, ['stale active', 'stale history'])
  await tick()
  assert.equal(h.requests.length, 4)
  assert.equal(h.updates, 0, 'the disposed effect must not apply its old result')
  h.resolvePoll(2)
  await tick()
  assert.ok(h.updates > 0)
  h.close()
})

test('hidden visibility aborts pending reads and the request deadline cancels a hung poll', async () => {
  const h = pollerHarness()
  const signal = h.requests[0].signal
  h.advance(29_999)
  assert.equal(signal.aborted, false)
  h.advance(1)
  assert.equal(signal.aborted, true, 'hung polling requests need a bounded fetch lifetime')
  settle(h.requests[0])
  await tick()
  h.advance(3_000)
  assert.equal(h.requests.length, 2)
  const nextSignal = h.requests[1].signal
  assert.equal(nextSignal.aborted, false)
  h.visibility(true)
  assert.equal(nextSignal.aborted, true)
  assert.equal(h.timers.size, 0)
  settle(h.requests[1])
  await tick()
  h.poller.dispose()
})

test('getJson forwards the polling signal to fetch so disposal cancels actual requests', async () => {
  const source = transpile(readFileSync(new URL('../src/client/api.ts', import.meta.url), 'utf8').replace(/export /g, ''))
  const env = environment({ fetch: (_url, init) => new Promise((_resolve, reject) => {
    init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true })
  }) })
  vm.runInContext(source, env.context)
  const callbacks = []
  const poller = env.context.createQueuePoller({
    read: signal => [env.context.getJson('/active', signal), env.context.getJson('/history', signal)],
    apply: () => callbacks.push('apply'),
    fail: () => callbacks.push('fail'),
  })
  poller.dispose()
  await tick()
  assert.equal(env.timers.size, 0)
  assert.deepEqual(callbacks, [])
  let reopened = 0
  const replacement = env.context.createQueuePoller({ read: () => { reopened++; return [] }, apply() {}, fail() {} })
  await tick()
  assert.equal(reopened, 1, 'cancelled fetches must release the shared gate')
  replacement.dispose()
})
