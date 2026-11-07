import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import test from 'node:test';

// Exercise the actual CLI argument construction offline, not a second copy of it.
test('each headless scenario selects an explicit invocation overlay, not legacy env', async () => {
 const source = await fs.readFile(new URL('./run-integration.mjs', import.meta.url), 'utf8');
 assert.doesNotMatch(source, /DSH_TOOLS_MODE/);
 const { headlessArgs } = await import('./executor-selection.mjs');
 for (const scenario of ['E2E_SYNC','E2E_ASYNC','E2E_CANCEL','E2E_SANDBOX','E2E_PTC']) {
  const mode = ['E2E_SANDBOX','E2E_PTC'].includes(scenario) ? 'ptc' : 'native';
  assert.deepEqual(headlessArgs('/dsh.js','/isolated',scenario), ['/dsh.js','--profile','headless','--patch',`/isolated/runtime/executor-${mode}.patch.yml`,'--json',scenario]);
 }
 assert.match(source, /headlessArgs\(dsh,root,scenario\)/);
});

test('generated invocation overlays select mutually exclusive real executors', async () => {
 const { executorPatch } = await import('./executor-selection.mjs');
 for (const mode of ['native','ptc']) {
  const patch = executorPatch(mode);
  assert.match(patch, new RegExp(`id: tool-executor-native\\n  disabled: ${mode === 'ptc'}`));
  assert.match(patch, /name: '@deepseek-ai\/dsh-tool-executor-ptc'/);
  assert.doesNotMatch(patch, /insert:/, '0.2.2 ships both executor rows; patch them without duplicate IDs');
  assert.match(patch, new RegExp(`id: tool-executor-ptc\\n  name: [^\\n]+\\n  disabled: ${mode === 'native'}`));
 }
});

test('actual model-facing tool surfaces reject ignored or mixed executor selection', async () => {
 const { validateToolSurface } = await import('./executor-selection.mjs');
 const native = [{tools:['comfyui_run','job_output','job_kill']}];
 const ptc = [{tools:['run_code']}];
 assert.deepEqual(validateToolSurface('E2E_SYNC',native),native[0].tools);
 assert.deepEqual(validateToolSurface('E2E_PTC',ptc),ptc[0].tools);
 for (const [scenario,requests] of [['E2E_PTC',native],['E2E_SYNC',ptc],['E2E_PTC',[]],['E2E_SYNC',[{tools:[]}]],['E2E_PTC',[{tools:['run_code','comfyui_run']}]],['E2E_PTC',[...ptc,...native]]]) {
  assert.throws(() => validateToolSurface(scenario,requests));
 }
 const source = await fs.readFile(new URL('./run-integration.mjs', import.meta.url),'utf8');
 assert.match(source,/validateToolSurface\(scenario,/);
});
