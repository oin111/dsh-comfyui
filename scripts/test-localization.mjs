/** Localization regression: run actual TS module without browser framework. */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import ts from 'typescript'
const source = fs.readFileSync('src/client/i18n.ts', 'utf8')
const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext } }).outputText
const locale = await import(`data:text/javascript;base64,${Buffer.from(compiled).toString('base64')}`)
test('only Russian and English; Russian default; legacy preferences migrate', () => {
  assert.deepEqual(locale.LANGS, ['ru', 'en'])
  for (const initial of [null, 'zh', 'ru', 'invalid', 'en']) {
    const values = new Map(initial === null ? [] : [['dsh-comfyui.lang', initial]])
    globalThis.localStorage = { getItem: k => values.get(k) ?? null, setItem: (k,v) => values.set(k,v) }
    assert.equal(locale.getLang(), initial === 'en' ? 'en' : 'ru')
    if (initial === 'zh') assert.equal(values.get('dsh-comfyui.lang'), 'ru')
    locale.setLang('en'); assert.equal(locale.getLang(), 'en')
    locale.setLang('ru'); assert.equal(locale.getLang(), 'ru')
  }
  globalThis.localStorage = { getItem() { throw Error('unavailable') }, setItem() { throw Error('unavailable') } }
  assert.equal(locale.getLang(), 'ru'); assert.doesNotThrow(() => locale.setLang('en'))
})
test('complete Russian translations preserve all interpolation keys', () => {
  assert.ok(locale.ru)
  assert.deepEqual(Object.keys(locale.ru).sort(), Object.keys(locale.en).sort())
  for (const key of Object.keys(locale.en)) {
    const placeholders = text => [...text.matchAll(/\{(\w+)\}/g)].map(m => m[1]).sort()
    assert.deepEqual(placeholders(locale.ru[key]), placeholders(locale.en[key]), key)
    assert.ok(locale.ru[key].length > 0, key)
    const params = Object.fromEntries(placeholders(locale.en[key]).map(k => [k, `VALUE_${k}`]))
    for (const lang of ['ru', 'en']) {
      const translated = locale.makeT(lang)(key, params)
      for (const value of Object.values(params)) assert.ok(translated.includes(value), `${lang}:${key}`)
    }
  }
})
test('production sources, built text, editable documentation and package metadata contain no Han', () => {
  const files = ['package.json', 'README.md', 'README.en.md', 'AWESOME.md']
  function walk(dir) { for (const entry of fs.readdirSync(dir, { withFileTypes: true })) { const p = path.join(dir, entry.name); if (entry.isDirectory()) walk(p); else if (/\.(ts|tsx|js|md|json)$/.test(p)) files.push(p) } }
  for (const dir of ['src', 'lib', 'client', 'docs']) walk(dir)
  for (const file of files) assert.doesNotMatch(fs.readFileSync(file, 'utf8'), /\p{Script=Han}/u, file)
  assert.equal(fs.existsSync('README.zh-CN.md'), false)
  const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'))
  assert.equal(pkg.version, '0.6.3')
  assert.ok(!pkg.files.includes('README.zh-CN.md'))
})

// The user explicitly removed the obsolete Chinese maintainer document.
if (process.env.LOCALIZATION_FULL === '1') test('obsolete maintainer document stays removed', () => {
  assert.equal(fs.existsSync('CLAUDE.md'), false)
})

test('agent definitions, renderers, companion skill and generated pack prose are ru/en', async () => {
  const { registerComfyUITools } = await import('../lib/tools.js')
  const { COMFYUI_SKILL } = await import('../lib/skill.js')
  const { seedSkillDocument, parseSkillPath } = await import('../lib/skillpack.js')
  const host = await import('@deepseek-ai/dsh-tools')
  const definitions = []
  registerComfyUITools({ tools: { register(def) { definitions.push(def); return () => {} } } }, {})
  assert.equal(definitions.length, 4)
  for (const def of definitions) {
    assert.doesNotMatch(JSON.stringify({ description: def.description, parameters: def.parameters, output: def.output.schema }), /\p{Script=Han}/u, def.name)
    host.assertSupportedJsonSchema(def.parameters)
    host.assertSupportedJsonSchema(def.output.schema)
  }
  assert.doesNotMatch(JSON.stringify(COMFYUI_SKILL), /\p{Script=Han}/u)
  assert.match(COMFYUI_SKILL.content, /Respond to the user in Russian by default/)
  assert.doesNotMatch(seedSkillDocument('Example', ['prompt']), /\p{Script=Han}/u)
  assert.match(seedSkillDocument('Example', ['prompt']), /Когда использовать/)
  assert.doesNotMatch(parseSkillPath('../invalid').error, /\p{Script=Han}/u)
  const workflow = definitions.find(d => d.name === 'comfyui_workflow')
  const skill = definitions.find(d => d.name === 'comfyui_skill')
  const fixtures = [
    [workflow, { action: 'skill', id: 'wf' }],
    [workflow, { action: 'refresh', name: 'Example', parameterCount: 2, changed: ['voice_name'] }],
    [workflow, { action: 'refresh', name: 'Example', changed: [] }],
    [workflow, { action: 'list', env: { baseUrl: 'http://localhost:8188', comfyuiDirs: [] }, workflows: [{ id: 'wf', name: 'Example', description: '', skill: { summary: 'Example pack', files: 2, required: true }, parameters: [{ name: 'prompt', label: 'Запрос', random: true, default: 'test', options: ['test'], upload: 'media', subfolder: 'input' }] }], loadArea: { slots: 1, loaded: 1, items: [{ name: 'sample.png', kind: 'image' }] }, comfyuiWorkflows: [{ name: 'graph.json', extracted: false, derived: [] }, { name: 'other.json', extracted: true, derived: [{ name: 'Example', libraryId: 'wf' }] }] }],
    [skill, { action: 'read', path: 'SKILL.md', workflowName: 'Example', content: 'test', truncated: true }],
    [skill, { action: 'list', workflowName: 'Example', dir: '/pack', required: true, summary: 'Example pack', files: [], dirs: ['references'] }],
    [skill, { action: 'write', workflowName: 'Example', path: 'SKILL.md', files: [] }],
  ]
  for (const [def, fixture] of fixtures) assert.doesNotMatch(JSON.stringify(def.output.render({}, fixture)), /\p{Script=Han}/u, `${def.name}:${fixture.action}`)
})
