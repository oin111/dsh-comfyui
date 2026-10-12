import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import ts from 'typescript'
import { isLoraInput, isLoraValue } from '../lib/lora.js'

function editorHarness() {
  const source = readFileSync(new URL('../src/client/panel.tsx', import.meta.url), 'utf8').replace(/^import .*$/gm, '').replace(/export /g, '') + '\n globalThis.editor = ParameterEditor;'
  let slots = [], index = 0
  const context = vm.createContext({ isLoraInput, isLoraValue, console, crypto: { randomUUID: () => 'synthetic-id' }, Component: class {}, h: (type, props, ...children) => ({ type, props: props ?? {}, children }), useState: value => { const i = index++; if (!(i in slots)) slots[i] = value; return [slots[i], next => { slots[i] = typeof next === 'function' ? next(slots[i]) : next }] }, useRef: value => ({ current: value }), useEffect: () => {}, useCallback: fn => fn, postJson: async () => ({ ok: true, options: ['synthetic/new.safetensors'] }), window: {}, localStorage: { getItem: () => null } })
  vm.runInContext(ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText, context)
  return props => { index = 0; return context.editor(props) }
}
function all(tree) { return !tree || typeof tree !== 'object' ? [] : [tree, ...tree.children.flat(Infinity).flatMap(all)] }
const row = { on: true, lora: 'synthetic/authored.safetensors', strength: .8, strengthTwo: null, extra: 'keep' }
const workflow = { '17': { class_type: 'Power Lora Loader (rgthree)', inputs: { lora_1: row, unknown: { value: 1 } } } }

test('structured LoRA editor changes typed fields without stringifying the object', () => {
  const render = editorHarness()
  let params = [{ id: 'p', name: 'lora_1', label: 'LoRA', type: 'lora', nodeId: '17', inputKey: 'lora_1', default: row, options: ['synthetic/new.safetensors'] }]
  const tree = render({ workflow, params, onChange: next => { params = next }, t: key => key })
  const controls = all(tree)
  const enable = controls.find(n => n.type === 'input' && n.props.type === 'checkbox' && n.props['aria-label'] === 'loraEnable')
  assert.ok(enable, 'missing structured enable editor')
  enable.props.onChange({ target: { checked: false } })
  assert.equal(params[0].default.on, false)
  assert.equal(params[0].default.extra, 'keep')
  const next = all(render({ workflow, params, onChange: value => { params = value }, t: key => key }))
  next.find(n => n.props['aria-label'] === 'loraStrength').props.onChange({ target: { value: '0' } })
  assert.equal(params[0].default.strength, 0)
  const final = all(render({ workflow, params, onChange: value => { params = value }, t: key => key }))
  final.find(n => n.props['aria-label'] === 'loraClipStrength').props.onChange({ target: { value: '-.2' } })
  assert.equal(params[0].default.strengthTwo, -.2)
})

test('malformed persisted LoRA defaults cannot crash the editor', () => {
  const render = editorHarness()
  assert.doesNotThrow(() => render({ workflow, params: [{ id: 'bad', label: 'bad', name: 'lora_1', type: 'lora', nodeId: '17', inputKey: 'lora_1', default: null }], onChange: () => {}, t: key => key }))
})

test('advanced picker offers only supported values and routes LoRA to structured type', async () => {
  const render = editorHarness()
  let params = []
  const props = () => ({ workflow, params, onChange: next => { params = next }, t: key => key })
  all(render(props())).find(n => n.type === 'button' && n.children.includes('wfParamsAdd')).props.onClick()
  let tree = all(render(props()))
  tree.find(n => n.type === 'select' && all(n).some(c => c.type === 'option' && c.props.value === '17')).props.onChange({ target: { value: '17' } })
  tree = all(render(props()))
  assert.ok(!tree.some(n => n.type === 'option' && n.props.value === 'unknown'), 'unsupported object still offered')
  tree.find(n => n.type === 'select' && all(n).some(c => c.type === 'option' && c.props.value === 'lora_1')).props.onChange({ target: { value: 'lora_1' } })
  tree = all(render(props()))
  const add = tree.find(n => n.type === 'button' && n.children.includes('wfParamAdd'))
  assert.ok(add)
  await add.props.onClick()
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(params[0].type, 'lora')
  assert.equal(params[0].default.lora, row.lora)
})
