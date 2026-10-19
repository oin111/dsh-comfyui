import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, readFile, writeFile, readdir, mkdir, rm, symlink, readlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ComfyUIStore } from '../lib/store.js'

const input = name => ({ name, description: '', workflow: { '1': { class_type: 'SyntheticNode', inputs: {} } } })
async function fixture(fn) {
  const root = await mkdtemp(join(tmpdir(), 'comfyui-workflow-concurrency-'))
  const dir = join(root, 'data')
  const store = new ComfyUIStore(dir, 100)
  await store.init()
  try { await fn({ root, dir, store }) } finally { await rm(root, { recursive: true, force: true }) }
}

test('all 20 concurrent workflow saves survive, including across store instances and path aliases', () => fixture(async ({ root, dir, store }) => {
  const alias = join(root, 'alias')
  await symlink(dir, alias)
  const stores = [store, new ComfyUIStore(dir, 100), new ComfyUIStore(alias, 100)]
  const results = await Promise.all(Array.from({ length: 20 }, (_, i) => stores[i % 3].saveWorkflow(input(`workflow-${i}`))))
  assert.ok(results.every(result => result.ok))
  const saved = await store.listWorkflows()
  assert.equal(saved.length, 20)
  assert.equal(new Set(saved.map(item => item.id)).size, 20)
  assert.deepEqual(saved.map(item => item.name).sort(), Array.from({ length: 20 }, (_, i) => `workflow-${i}`).sort())
  assert.deepEqual(await readdir(dir), ['workflows.json'])
}))

test('concurrent readers see complete old or new JSON snapshots', () => fixture(async ({ dir, store }) => {
  await store.saveWorkflow(input('seed'))
  let done = false
  const writes = Promise.all(Array.from({ length: 20 }, (_, i) => store.saveWorkflow(input(`new-${i}`)))).finally(() => { done = true })
  let reads = 0
  do {
    const snapshot = JSON.parse(await readFile(join(dir, 'workflows.json'), 'utf8'))
    assert.ok(snapshot.length >= 1 && snapshot.length <= 21)
    assert.equal(snapshot[0].name, 'seed')
    reads++
  } while (!done)
  await writes
  assert.ok(reads > 0)
  assert.equal((await store.listWorkflows()).length, 21)
}))

test('workflow edits and skill updates share the same mutation lock', () => fixture(async ({ dir, store }) => {
  const saved = await store.saveWorkflow(input('initial'))
  const second = new ComfyUIStore(dir, 100)
  await Promise.all([
    second.updateWorkflowSkill(saved.workflow.id, { skillDir: 'synthetic-pack', requireSkill: true }),
    store.saveWorkflow({ ...input('updated'), id: saved.workflow.id }),
    store.saveWorkflow(input('unrelated')),
  ])
  const updated = await store.getWorkflow(saved.workflow.id)
  assert.equal(updated.name, 'updated')
  assert.equal(updated.skillDir, 'synthetic-pack')
  assert.equal(updated.requireSkill, true)
  assert.equal((await store.listWorkflows()).length, 2)
}))

test('concurrent delete and create neither resurrects nor loses workflows', () => fixture(async ({ store }) => {
  const first = await store.saveWorkflow(input('delete-me'))
  const [deleted, saved] = await Promise.all([store.deleteWorkflow(first.workflow.id), store.saveWorkflow(input('keep-me'))])
  assert.equal(deleted, true)
  assert.equal(saved.ok, true)
  assert.deepEqual((await store.listWorkflows()).map(item => item.name), ['keep-me'])
}))

test('invalid workflow is rejected and does not poison later queued saves', () => fixture(async ({ store }) => {
  const [bad, good] = await Promise.all([store.saveWorkflow({ ...input('bad'), workflow: {} }), store.saveWorkflow(input('good'))])
  assert.equal(bad.ok, false)
  assert.equal(good.ok, true)
  assert.equal((await store.listWorkflows()).length, 1)
}))

test('mutations preserve corrupt or unreadable library rather than overwriting it', () => fixture(async ({ dir, store }) => {
  const path = join(dir, 'workflows.json')
  for (const original of ['{broken', '{}', 'null']) {
    await writeFile(path, original)
    await assert.rejects(store.saveWorkflow(input('must-not-erase')))
    await assert.rejects(store.deleteWorkflow('anything'))
    await assert.rejects(store.updateWorkflowSkill('anything', { requireSkill: true }))
    assert.equal(await readFile(path, 'utf8'), original)
  }
  await writeFile(path, '[]')
  assert.equal((await store.saveWorkflow(input('recovered'))).ok, true)
}))

test('atomic writes ignore predictable temp symlinks and preserve their target', () => fixture(async ({ root, dir, store }) => {
  const victim = join(root, 'victim')
  const alias = join(dir, 'workflows.json.tmp')
  await writeFile(victim, 'unchanged')
  await symlink(victim, alias)
  await store.saveWorkflow(input('saved'))
  assert.equal(await readFile(victim, 'utf8'), 'unchanged')
  assert.equal(await readlink(alias), victim)
  assert.deepEqual((await readdir(dir)).sort(), ['workflows.json', 'workflows.json.tmp'])
}))

test('failed atomic replacement cleans its temporary file and permits recovery', () => fixture(async ({ dir, store }) => {
  // A directory cannot be replaced by the atomic tracked-state file rename.
  await mkdir(join(dir, 'tracked.json'))
  await writeFile(join(dir, 'tracked.json.tmp'), 'unrelated')
  await assert.rejects(store.saveTracked({ runs: [], archived: [] }))
  assert.deepEqual((await readdir(dir)).sort(), ['tracked.json', 'tracked.json.tmp'])
  await rm(join(dir, 'tracked.json'), { recursive: true })
  await store.saveTracked({ runs: [], archived: [] })
  assert.deepEqual(await store.loadTracked(), { runs: [], archived: [] })
}))

test('tracked-state loader handles null and filters incomplete records', () => fixture(async ({ dir, store }) => {
  await writeFile(join(dir, 'tracked.json'), 'null')
  assert.deepEqual(await store.loadTracked(), { runs: [], archived: [] })
  const good = { promptId: 'valid', ts: '', source: 'test', workflowName: null }
  await writeFile(join(dir, 'tracked.json'), JSON.stringify({ runs: [null, { promptId: 'bad' }, good], archived: [null, 'valid', 5] }))
  assert.deepEqual(await store.loadTracked(), { runs: [good], archived: ['valid'] })
}))
