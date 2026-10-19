import assert from 'node:assert/strict'
import { test } from 'node:test'
import { QueueTracker } from '../lib/queue.js'

const tick = () => new Promise(resolve => setImmediate(resolve))
const deferred = () => {
  let resolve, reject
  const promise = new Promise((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
const run = id => ({ promptId: String(id), ts: '2026-01-01T00:00:00.000Z', workflowName: 'Workflow', source: 'test' })
const complete = { status: { completed: true }, outputs: {} }
const options = (getHistory = async () => undefined, appendAsset = async () => {}) => ({ client: { getHistory }, store: { appendAsset }, maxItems: 10, proxyBase: undefined })
function backing(initial = { runs: [], archived: [] }) {
  const writes = []
  return { writes, load: async () => initial, save: async state => { writes.push(structuredClone(state)) } }
}

test('unchanged tracks, missing untracks, and idle/archived sweeps do not write queue state', async () => {
  const storage = backing()
  const tracker = new QueueTracker(storage)
  await tracker.init()
  await tracker.sweep(options())
  tracker.untrack('missing')
  assert.equal(storage.writes.length, 0)
  tracker.track(run('one'))
  await tick()
  assert.equal(storage.writes.length, 1)
  tracker.track({ ...run('one') })
  await tracker.sweep(options())
  await tracker.sweep(options(async () => { throw new Error('offline') }))
  assert.equal(storage.writes.length, 1)
  await tracker.sweep(options(async () => complete))
  await tick()
  assert.equal(storage.writes.length, 2)
  assert.deepEqual(storage.writes.at(-1).archived, ['one'])
  await tracker.sweep(options(() => assert.fail('archived history was fetched again')))
  tracker.track(run('one'))
  await tick()
  assert.equal(storage.writes.length, 2)
  tracker.untrack('one')
  await tick()
  assert.deepEqual(storage.writes.at(-1), { runs: [], archived: [] })
  tracker.untrack('one')
  await tick()
  assert.equal(storage.writes.length, 3)
})

test('persistence is serialized, coalesces pending snapshots, and retains the newest state', async () => {
  const gates = [], writes = [], finished = []
  let active = 0, maxActive = 0
  const tracker = new QueueTracker({
    load: async () => ({ runs: [], archived: [] }),
    save: async state => {
      active++
      maxActive = Math.max(maxActive, active)
      const gate = deferred()
      gates.push(gate)
      writes.push(structuredClone(state))
      await gate.promise
      finished.push(structuredClone(state))
      active--
    },
  })
  await tracker.init()
  const original = run('first')
  tracker.track(original)
  original.workflowName = 'external mutation'
  tracker.track(run('second'))
  tracker.track(run('third'))
  tracker.untrack('second')
  assert.equal(writes.length, 1, 'newer save started before the older save finished')
  assert.equal(writes[0].runs[0].workflowName, 'Workflow')
  gates[0].resolve()
  await tick()
  assert.equal(writes.length, 2, 'intermediate snapshots should be coalesced')
  assert.deepEqual(writes[1].runs.map(item => item.promptId), ['first', 'third'])
  gates[1].resolve()
  await tick()
  assert.equal(maxActive, 1)
  assert.deepEqual(finished.at(-1), writes.at(-1))
  tracker.get('first').source = 'mutated read'
  tracker.list()[0].source = 'mutated list'
  assert.equal(tracker.get('first').source, 'test')
})

test('a failed save does not block the next snapshot, or cause duplicate successful writes', async () => {
  const first = deferred()
  const writes = []
  const tracker = new QueueTracker({
    load: async () => ({ runs: [], archived: [] }),
    save: async state => {
      writes.push(structuredClone(state))
      if (writes.length === 1) await first.promise
    },
  })
  await tracker.init()
  tracker.track(run('one'))
  tracker.track(run('two'))
  first.reject(new Error('disk unavailable'))
  await tick()
  assert.equal(writes.length, 2)
  assert.deepEqual(writes.at(-1).runs.map(item => item.promptId), ['one', 'two'])
  tracker.track({ ...run('one'), workflowName: 'changed' })
  tracker.track(run('one'))
  await tick()
  const count = writes.length
  tracker.track(run('one'))
  await tracker.sweep(options())
  assert.equal(writes.length, count)
})

test('restore and track bound all runs and remove obsolete archived IDs immediately', async () => {
  const initialRuns = Array.from({ length: 1_200 }, (_, i) => run(i))
  const storage = backing({ runs: initialRuns, archived: [...initialRuns.map(item => item.promptId), 'orphan'] })
  const tracker = new QueueTracker(storage)
  await tracker.init()
  await tick()
  assert.equal(tracker.list().length, 500)
  assert.equal(tracker.list()[0].promptId, '700')
  assert.equal(storage.writes.at(-1).runs.length, 500)
  assert.deepEqual(storage.writes.at(-1).archived, tracker.list().map(item => item.promptId))
  tracker.track(run('new'))
  await tick()
  assert.equal(tracker.list().length, 500)
  assert.equal(tracker.get('700'), undefined)
  assert.equal(storage.writes.at(-1).archived.includes('700'), false)
  tracker.untrack('701')
  await tick()
  assert.equal(storage.writes.at(-1).archived.includes('701'), false)
})

test('empty restored state and clean persisted state are not rewritten', async () => {
  for (const state of [{ runs: [], archived: [] }, { runs: [run('one')], archived: ['one'] }]) {
    const storage = backing(state)
    const tracker = new QueueTracker(storage)
    await tracker.init()
    await tracker.sweep(options(() => assert.fail('no unarchived run expected')))
    await tick()
    assert.equal(storage.writes.length, 0)
  }
})

test('concurrent sweeps share history reads and appends, and recover after append failure', async () => {
  const storage = backing()
  const tracker = new QueueTracker(storage)
  await tracker.init()
  tracker.track(run('one'))
  await tick()
  const history = deferred(), append = deferred()
  let reads = 0, appends = 0
  const opts = options(async () => { reads++; return history.promise }, async () => { appends++; await append.promise })
  const first = tracker.sweep(opts)
  const second = tracker.sweep(opts)
  assert.equal(first, second)
  assert.equal(reads, 1)
  history.resolve(complete)
  await tick()
  assert.equal(appends, 1)
  assert.equal(tracker.sweep(opts), first, 'append must remain inside the sweep lock')
  const rejected = assert.rejects(first, /append failed/)
  append.reject(new Error('append failed'))
  await rejected
  assert.deepEqual(storage.writes.at(-1).archived, [])
  const records = await tracker.sweep(options(async () => complete, async () => { appends++ }))
  await tick()
  assert.equal(records.length, 1)
  assert.equal(appends, 2)
  assert.deepEqual(storage.writes.at(-1).archived, ['one'])
})

test('successful earlier archives persist even if a later append fails', async () => {
  const storage = backing()
  const tracker = new QueueTracker(storage)
  await tracker.init()
  tracker.track(run('one'))
  tracker.track(run('two'))
  await assert.rejects(tracker.sweep(options(async () => complete, async record => {
    if (record.promptId === 'two') throw new Error('append failed')
  })), /append failed/)
  await tick()
  assert.deepEqual(storage.writes.at(-1).archived, ['one'])
})

test('untrack or replacement during history lookup cannot archive stale runs', async () => {
  for (const replacement of [false, true]) {
    const storage = backing()
    const tracker = new QueueTracker(storage)
    await tracker.init()
    tracker.track(run('one'))
    const history = deferred()
    const sweep = tracker.sweep(options(() => history.promise, () => assert.fail('stale run appended')))
    tracker.untrack('one')
    if (replacement) tracker.track({ ...run('one'), source: 'replacement' })
    history.resolve(complete)
    assert.deepEqual(await sweep, [])
    await tick()
    assert.deepEqual(storage.writes.at(-1).archived, [])
  }
})

test('untrack while append is pending does not recreate an obsolete archive marker', async () => {
  const storage = backing()
  const tracker = new QueueTracker(storage)
  await tracker.init()
  tracker.track(run('one'))
  const append = deferred()
  const sweep = tracker.sweep(options(async () => complete, () => append.promise))
  await tick()
  tracker.untrack('one')
  append.resolve()
  await sweep
  await tick()
  assert.deepEqual(storage.writes.at(-1), { runs: [], archived: [] })
})

test('failed snapshots are retried by the next unchanged sweep or identical track, without healthy rewrites', async () => {
  for (const retry of ['sweep', 'track']) {
    const writes = []
    const tracker = new QueueTracker({
      load: async () => ({ runs: [], archived: [] }),
      save: async state => {
        writes.push(structuredClone(state))
        if (writes.length === 1) throw new Error('temporary disk failure')
      },
    })
    await tracker.init()
    tracker.track(run('one'))
    await tick()
    assert.equal(writes.length, 1, 'failed writes must not retry in a tight loop')
    if (retry === 'sweep') await tracker.sweep(options())
    else tracker.track(run('one'))
    await tick()
    assert.equal(writes.length, 2)
    assert.deepEqual(writes[1], writes[0])
    tracker.track(run('one'))
    await tracker.sweep(options())
    await tick()
    assert.equal(writes.length, 2, 'successful retry must clear dirty state')
  }
})

test('failed partial writes still retry when memory returns to the last successfully saved snapshot', async () => {
  const original = { runs: [run('one')], archived: [] }
  const writes = []
  const tracker = new QueueTracker({
    load: async () => original,
    save: async state => {
      writes.push(structuredClone(state))
      if (writes.length === 1) throw new Error('partial disk write')
    },
  })
  await tracker.init()
  tracker.track(run('two'))
  await tick()
  tracker.untrack('two')
  await tick()
  assert.equal(writes.length, 2)
  assert.deepEqual(writes[1], original)
})

test('replacing an archived prompt clears its old marker and sweeps the replacement', async () => {
  const storage = backing({ runs: [run('one')], archived: ['one'] })
  const tracker = new QueueTracker(storage)
  await tracker.init()
  tracker.track({ ...run('one'), ts: '2026-02-01T00:00:00.000Z', source: 'replacement' })
  await tick()
  assert.deepEqual(storage.writes.at(-1).archived, [])
  const appended = []
  await tracker.sweep(options(async () => complete, async record => { appended.push(record) }))
  await tick()
  assert.equal(appended.length, 1)
  assert.equal(appended[0].source, 'replacement')
  assert.deepEqual(storage.writes.at(-1).archived, ['one'])
})
