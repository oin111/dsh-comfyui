import path from 'node:path';
import assert from 'node:assert/strict';

// Applied after the profile layer; the real PTC runtime/sandbox remain unchanged.
export function executorPatch(mode) {
 assert(['native','ptc'].includes(mode), 'Unknown executor mode');
 return `- id: tool-executor-native\n  disabled: ${mode === 'ptc'}\n- id: tool-executor-ptc\n  name: '@deepseek-ai/dsh-tool-executor-ptc'\n  disabled: ${mode === 'native'}\n`;
}

export function validateToolSurface(scenario, requests) {
 assert(requests.length > 0, 'No actual model requests observed');
 for (const {tools} of requests) {
  assert(Array.isArray(tools), 'Missing model-facing tool list');
  if (executorMode(scenario) === 'ptc') {
   assert.deepEqual(tools, ['run_code'], 'PTC must expose only run_code');
  } else {
   for (const name of ['comfyui_run','job_output','job_kill']) assert(tools.includes(name), `Native surface missing ${name}`);
   assert(!tools.includes('run_code'), 'Native must not expose run_code');
  }
 }
 return requests[0].tools;
}

export function executorMode(scenario) {
 return ['E2E_SANDBOX','E2E_PTC'].includes(scenario) ? 'ptc' : 'native';
}

export function headlessArgs(dsh, root, scenario) {
 return [dsh,'--profile','headless','--patch',path.join(root,`runtime/executor-${executorMode(scenario)}.patch.yml`),'--json',scenario];
}
