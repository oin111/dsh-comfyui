import assert from 'node:assert/strict'
import { convertGraphToApi } from '../lib/convert.js'

// Synthetic public-safe fixture. Contract: rgthree py/power_lora_loader.py
// INPUT_TYPES has only optional model/clip; load_loras accepts lora_* kwargs.
const type = 'Power Lora Loader (rgthree)'
const info = { [type]: { input: { required: {}, optional: { model: ['MODEL'], clip: ['CLIP'] } }, output: ['MODEL', 'CLIP'] } }
const loras = {
  lora_1: { on: true, lora: 'example-a.safetensors', strength: 1, strengthTwo: null },
  lora_2: { on: true, lora: 'example-b.safetensors', strength: 0.25, strengthTwo: null },
  lora_3: { on: false, lora: 'example-c.safetensors', strength: -0.2, strengthTwo: 0 },
}
const graph = { nodes: [{ id: 17, type, inputs: [], widgets_values: [{}, { type: 'PowerLoraLoaderHeaderWidget' }, ...Object.values(loras), {}, ''], widgets_values_named: { divider: {}, PowerLoraLoaderHeaderWidget: { type: 'PowerLoraLoaderHeaderWidget' }, ...loras, 'divider#1': {}, '➕ Add Lora': '' } }], links: [] }
const result = convertGraphToApi(graph, info)
assert.ok(result.ok, result.error)
assert.deepEqual(result.workflow['17'].inputs, loras)
console.log('PASS: rgthree named dynamic LoRAs preserve exact values and omit UI widgets')

const regularInfo = { Source: { input: { required: {} }, output: ['INT'] }, Named: { input: { required: { seed: ['INT', { control_after_generate: true }], text: ['STRING', {}], amount: ['FLOAT', {}] } }, output: [] } }
const regular = { nodes: [
  { id: 1, type: 'Source', outputs: [{ links: [1] }] },
  { id: 2, type: 'Named', inputs: [{ name: 'seed', link: 1, widget: { name: 'seed' } }], widgets_values: [999, 'fixed', 'WRONG', 9], widgets_values_named: { amount: 0.25, text: 'synthetic text', seed: 123, control_after_generate: 'fixed', divider: {}, PowerLoraLoaderHeaderWidget: {}, '➕ Add Lora': '' } },
], links: [[1, 1, 0, 2, 0, 'INT']] }
const mapped = convertGraphToApi(regular, regularInfo)
assert.ok(mapped.ok, mapped.error)
assert.deepEqual(mapped.workflow['2'].inputs, { seed: ['1', 0], text: 'synthetic text', amount: 0.25 })
console.log('PASS: named values use explicit keys, override positional disagreements, links win, UI omitted')

const hostile = structuredClone(regular)
hostile.nodes[1].inputs.push({ name: '__proto__', link: 1 }, { name: 'divider', link: null, widget: { name: 'divider' } })
hostile.nodes[1].widgets_values_named = JSON.parse('{"seed":123,"text":"synthetic text","amount":0.25,"divider":{},"__proto__":{"polluted":true},"constructor":{},"prototype":{}}')
const secured = convertGraphToApi(hostile, regularInfo)
assert.ok(secured.ok, secured.error)
assert.equal(Object.getPrototypeOf(secured.workflow['2'].inputs), Object.prototype)
assert.deepEqual(secured.workflow['2'].inputs, { seed: ['1', 0], text: 'synthetic text', amount: 0.25 })
assert.equal({}.polluted, undefined)
console.log('PASS: hostile input names cannot change prototypes; UI widget metadata cannot admit divider')

for (const invalid of [null, 'bad', [], {}, { on: true, lora: 'example.safetensors' }, { on: true, lora: 'example.safetensors', strength: 1, strengthTwo: 'bad' }]) {
  const bad = structuredClone(graph)
  bad.nodes[0].widgets_values_named.lora_1 = invalid
  const rejected = convertGraphToApi(bad, info)
  assert.equal(rejected.ok, false, `malformed dynamic LoRA must fail: ${JSON.stringify(invalid)}`)
  assert.match(rejected.error, /lora_1/)
}
console.log('PASS: malformed named dynamic LoRAs fail explicitly rather than disappearing or reaching backend')

const brokenLink = structuredClone(regular)
brokenLink.links = []
const broken = convertGraphToApi(brokenLink, regularInfo)
assert.equal(broken.ok, false, 'a missing linked source must not be silently replaced by a named widget')
assert.match(broken.error, /seed/)
console.log('PASS: named values never replace broken graph links')

// Characterize deliberate policy: valid maps are authoritative, even partial;
// malformed containers use the unchanged legacy path instead of crashing.
for (const named of [{ amount: 0.25 }, {}, { amount: 0.25, text: undefined }]) {
  const partial = structuredClone(regular)
  partial.nodes[1].widgets_values_named = named
  const missing = convertGraphToApi(partial, regularInfo)
  assert.equal(missing.ok, false)
  assert.match(missing.error, /text/)
}
const legacyInfo = { Legacy: { input: { required: { seed: ['INT', { control_after_generate: true }], text: ['STRING', {}] } }, output: [] } }
const legacy = { nodes: [{ id: 1, type: 'Legacy', inputs: ['seed','text'].map(name=>({ name, link: null, widget: { name } })), widgets_values: [42, 'fixed', 'synthetic text'] }], links: [] }
for (const named of [undefined, null, [], 3, 'bad']) {
  const old = structuredClone(legacy)
  old.nodes[0].widgets_values_named = named
  const converted = convertGraphToApi(old, legacyInfo)
  assert.ok(converted.ok, converted.error)
  assert.deepEqual(converted.workflow['1'].inputs, { seed: 42, text: 'synthetic text' })
}
console.log('PASS: partial/empty named maps fail required checks; malformed containers preserve legacy seed alignment')

const dynamicInfo = { Dynamic: { input: { required: { mode: ['COMFY_DYNAMICCOMBO_V3', { options: [{ key: 'custom' }] }], seed: ['INT', { control_after_generate: true }] } }, output: [] } }
const dynamic = { nodes: [{ id: 1, type: 'Dynamic', inputs: ['mode.amount','mode','seed'].map(name=>({name,link:null,widget:{name}})), widgets_values: ['custom', 0.5, 42, 'fixed'] }], links: [] }
for (const named of [undefined, { seed: 42, 'mode.amount': 0.5, mode: 'custom', control_after_generate: 'fixed' }]) {
  const d = structuredClone(dynamic)
  d.nodes[0].widgets_values_named = named
  const converted = convertGraphToApi(d, dynamicInfo)
  assert.ok(converted.ok, converted.error)
  assert.deepEqual(converted.workflow['1'].inputs, { mode: 'custom', 'mode.amount': 0.5, seed: 42 })
}
console.log('PASS: named and legacy DynamicCombo children stay flat; legacy master reorder and seed control intact')

const unrelated = structuredClone(graph)
unrelated.nodes[0].type = 'Unrelated'
const onlyDeclared = convertGraphToApi(unrelated, { Unrelated: { input: { required: {} }, output: [] } })
assert.ok(onlyDeclared.ok)
assert.deepEqual(onlyDeclared.workflow['17'].inputs, {})
const keyed = { nodes: [{ id: 1, type: 'Keyed', widgets_values: JSON.parse('{"value":3,"videopreview":{},"internal":{"hidden":true},"__proto__":{"polluted":true}}') }], links: [] }
const keyedResult = convertGraphToApi(keyed, { Keyed: { input: { required: {value: ['INT', {}]} }, output: [] } })
assert.ok(keyedResult.ok)
assert.deepEqual(keyedResult.workflow['1'].inputs, {value:3})
console.log('PASS: rgthree exception is class-scoped; old object widgets remain supported without prototype mutation')
