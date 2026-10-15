import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import ts from 'typescript'
const all = tree => !tree || typeof tree !== 'object' ? [] : [tree, ...tree.children.flat(Infinity).flatMap(all)]
const tick = () => new Promise(r => setImmediate(r))
function harness(items, post = async () => ({ ok: true, removed: 2, deleted: 2, missing: 0, skipped: 0, failures: [] })) {
  let slots = [], index = 0, effects = [], mounted = false
  const calls = []
  const source = readFileSync(new URL('../src/client/panel.tsx', import.meta.url), 'utf8').replace(/^import .*$/gm, '').replace(/export /g, '') + '\nglobalThis.assetsTab = AssetsTab;'
  const context = vm.createContext({ Component: class {}, h: (type, props, ...children) => ({ type, props: props ?? {}, children }), useState: value => { const i = index++; if (!(i in slots)) slots[i] = typeof value === 'function' ? value() : value; return [slots[i], value => { slots[i] = value }] }, useEffect: fn => { if (!mounted) effects.push(fn) }, useRef: value => ({ current: value }), panelStore: { getAssetFilter: () => 'A' }, getList: async () => items, postJson: async (path, body) => { calls.push({ path, body }); return post() }, window: {}, localStorage: { getItem: () => null } })
  vm.runInContext(ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText, context)
  return { calls, render() { index = 0; const tree = context.assetsTab({ t: (key, values) => values ? `${key}:${JSON.stringify(values)}` : key, onPreview() {} }); for (const effect of effects.splice(0)) effect(); mounted = true; return all(tree) } }
}
const items = [{ promptId: '1', workflowName: 'A', media: [] }, { promptId: '2', workflowName: 'B', media: [] }]
test('clear-all confirms global scope and uses one server request without filtered ids; empty/busy disabled', async () => {
  let resolve
  const h = harness(items, () => new Promise(r => { resolve = r }))
  h.render(); await tick()
  let tree = h.render()
  const clear = tree.find(n => n.type === 'button' && n.children.includes('assetClearAll'))
  assert.ok(clear, 'missing Clear all button'); assert.equal(clear.props.disabled, false)
  clear.props.onClick(); assert.equal(h.calls.length, 0)
  let dialog = h.render().find(n => typeof n.type === 'function' && n.type.name === 'ConfirmDialog')
  assert.equal(dialog.props.title, 'assetClearTitle'); assert.equal(dialog.props.body, 'assetClearBody')
  dialog.props.onCancel(); assert.ok(!h.render().some(n => n.props.title === 'assetClearTitle'))
  clear.props.onClick(); dialog = h.render().find(n => n.props.title === 'assetClearTitle'); dialog.props.onConfirm()
  assert.equal(h.calls.length, 1); assert.equal(h.calls[0].path, '/comfyui/assets/clear'); assert.equal(JSON.stringify(h.calls[0].body), '{}')
  assert.equal(h.render().find(n => n.type === 'button' && n.children.includes('assetClearAll')).props.disabled, true)
  resolve({ ok: true, removed: 2, deleted: 1, missing: 0, skipped: 1, failures: ['denied'] }); await tick()
  tree = h.render(); assert.ok(tree.some(n => n.props.message?.includes('denied')), 'file failures must remain visible after refresh')
  assert.ok(tree.some(n => n.children.some(c => typeof c === 'string' && c.includes('assetClearDone'))))
  const empty = harness([]); empty.render(); await tick()
  assert.equal(empty.render().find(n => n.type === 'button' && n.children.includes('assetClearAll')).props.disabled, true)
})
