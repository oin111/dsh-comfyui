import { test } from 'node:test'
import assert from 'node:assert/strict'
import { analyzeWorkflowParameters, applyWorkflowParameters, refreshParameterMetadata } from '../lib/params.js'

import { convertGraphToApi } from '../lib/convert.js'
import { ComfyUIStore } from '../lib/store.js'
import { buildExportPackage, applyImportPackage } from '../lib/transfer.js'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const row = { on: true, lora: 'synthetic/authored.safetensors', strength: .8, strengthTwo: null, future: { keep: true } }
const workflow = { '17': { class_type: 'Power Lora Loader (rgthree)', inputs: { model: ['1', 0], clip: ['2', 0], lora_1: row, lora_2: { ...row, strength: 0 }, lora_3: { ...row, on: false } } } }
const info = { LoraLoader: { input: { required: { lora_name: [['synthetic/new.safetensors']] } } } }

test('named and legacy keyed-object extraction feed the typed parameter path without broader inference', () => {
  const type = 'Power Lora Loader (rgthree)'
  const rows = { lora_1: row, lora_2: { ...row, on: false }, lora_3: { ...row, strengthTwo: 0 } }
  const objectInfo = { ...info, [type]: { input: { required: {}, optional: { model: ['MODEL'], clip: ['CLIP'] } }, output: ['MODEL', 'CLIP'] } }
  for (const widgets of [{ widgets_values_named: rows, widgets_values: ['wrong'] }, { widgets_values: rows }]) {
    const graph = { nodes: [{ id: 17, type, inputs: [], ...widgets }], links: [] }
    const extracted = convertGraphToApi(graph, objectInfo)
    assert.ok(extracted.ok, extracted.error)
    assert.deepEqual(extracted.workflow['17'].inputs, rows)
    const params = analyzeWorkflowParameters(extracted.workflow, objectInfo)
    assert.equal(params.length, 3)
    assert.deepEqual(applyWorkflowParameters(extracted.workflow, params, {}, objectInfo), extracted.workflow)
  }
  assert.equal(analyzeWorkflowParameters({ '17': { class_type: 'Unrelated', inputs: rows } }, info).length, 0)
})

test('three rgthree rows are typed parameters and remain intact through an untouched run', () => {
  const params = analyzeWorkflowParameters(workflow, info)
  assert.equal(params.length, 3)
  assert.ok(params.every(p => p.type === 'lora'))
  assert.deepEqual(params[0].default, row)
  assert.deepEqual(params[0].options, ['synthetic/new.safetensors'])
  assert.deepEqual(applyWorkflowParameters(workflow, params, {}, info), workflow)
  const changed = applyWorkflowParameters(workflow, params, { lora_1: { on: false, strength: 0, strengthTwo: null, lora: 'synthetic/new.safetensors' } }, info)
  assert.deepEqual(changed['17'].inputs.lora_1, { ...row, on: false, strength: 0, lora: 'synthetic/new.safetensors' })
  assert.deepEqual(workflow['17'].inputs.lora_1, row)
})

test('refuse legacy scalar parameters that would destroy object-valued rows', () => {
  const legacy = { id: 'old', name: 'lora_1', type: 'string', nodeId: '17', inputKey: 'lora_1', default: '' }
  assert.deepEqual(applyWorkflowParameters(workflow, [legacy], {}), workflow)
  assert.throws(() => applyWorkflowParameters(workflow, [legacy], { lora_1: 'broken' }), /object|LoRA/)
})

test('malformed and unsafe row overrides fail without touching source', () => {
  const params = analyzeWorkflowParameters(workflow, info)
  for (const patch of [null, [], 'text', { on: 0 }, { strength: NaN }, { strength: Infinity }, { strengthTwo: '0' }, { strength: undefined }, { extra: true }, JSON.parse('{"__proto__":{}}'), { constructor: {} }, { lora: 'unknown' }]) {
    assert.throws(() => applyWorkflowParameters(workflow, params, { lora_1: patch }, info))
  }
  for (const patch of ['', {}, undefined]) assert.deepEqual(applyWorkflowParameters(workflow, params, { lora_1: patch }, info), workflow)
  for (const patch of [{ on: false }, { strength: 0 }, { strength: -.5 }, { strengthTwo: 0 }, { strengthTwo: -.2 }, { strengthTwo: null }]) {
    assert.deepEqual(applyWorkflowParameters(workflow, params, { lora_1: patch }, info)['17'].inputs.lora_1, { ...row, ...patch })
  }
})

test('typed LoRA defaults survive save, edit, reload, export, import, and run', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'lora-roundtrip-'))
  try {
    const store = new ComfyUIStore(dir, 10)
    await store.init()
    const host = { listWorkflows: () => store.listWorkflows(), getWorkflow: id => store.getWorkflow(id), saveWorkflow: input => store.saveWorkflow(input), skillPacks: { info: async () => undefined } }
    const parameters = analyzeWorkflowParameters(workflow, info)
    const saved = await store.saveWorkflow({ name: 'synthetic LoRA', description: '', workflow, parameters })
    assert.ok(saved.ok)
    parameters[0].default = { ...row, on: false, strength: 0, strengthTwo: -.2 }
    await store.saveWorkflow({ id: saved.workflow.id, name: 'synthetic LoRA', description: '', workflow, parameters })
    const reloaded = await new ComfyUIStore(dir, 10).getWorkflow(saved.workflow.id)
    assert.deepEqual(reloaded.parameters, JSON.parse(JSON.stringify(parameters)))
    const packed = await buildExportPackage(host, [saved.workflow.id])
    assert.ok(packed.ok)
    const imported = await applyImportPackage(host, Buffer.from(packed.bytes), [0])
    assert.ok(imported.ok)
    const result = await store.getWorkflow(imported.results[0].newId)
    assert.deepEqual(result.parameters, reloaded.parameters)
    assert.deepEqual(applyWorkflowParameters(result.workflow, result.parameters, {}, info)['17'].inputs.lora_1, parameters[0].default)
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('unsafe prototypes and undefined clip overrides are refused', () => {
  const params = analyzeWorkflowParameters(workflow, info)
  for (const patch of [Object.create({ on: false }), { strengthTwo: undefined }]) {
    assert.throws(() => applyWorkflowParameters(workflow, params, { lora_1: patch }, info))
  }
})

test('refresh and fallback choices keep typed authored values', () => {
  const params = analyzeWorkflowParameters(workflow, info)
  for (const loader of ['LoraLoader', 'LoraLoaderModelOnly', 'LoraLoaderBypass', 'LoraLoaderBypassModelOnly']) {
    const fresh = { [loader]: { input: { required: { lora_name: [['synthetic/refreshed.safetensors']] } } } }
    const result = refreshParameterMetadata(params, fresh, workflow)
    assert.equal(result.changed.length, 3)
    assert.deepEqual(result.parameters[0].options, ['synthetic/refreshed.safetensors'])
    assert.deepEqual(result.parameters[0].default, row)
    assert.equal(result.parameters[0].type, 'lora')
  }
})
