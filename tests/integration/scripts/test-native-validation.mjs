import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

// Execute the actual pre-fix assertions, not a hand-recreated approximation.
export function originalValidator() {
 // Verbatim assertion block extracted from git HEAD 7ba991b before the fix.
 const block = readFileSync(new URL('../fixtures/original-native-assertions.txt', import.meta.url), 'utf8');
 assert(block.includes('state.cancelled.length>0'));
 return async ({scenario, events, canonical, state, unrelated}) => vm.runInNewContext(`(async()=>{${block}})()`, {
  assert, scenario, events, unrelated, observer: 'unused', mockBase: 'http://mock',
  fs: {readFile: async () => canonical.map(x => JSON.stringify(x)).join('\n')},
  fetch: async () => ({json: async () => state}),
 });
}
let validate;
try { ({validateNativeScenario: validate} = await import('./validate-native.mjs')); }
catch (error) { if (error.code !== 'ERR_MODULE_NOT_FOUND') throw error; validate = originalValidator(); }

function trace(scenario = 'E2E_SYNC') {
 const completed = {kind:'sync', promptId:'prompt-1', status:'completed', media:[{filename:'dsh-e2e.png', type:'output', kind:'image'}]};
 const background = {kind:'background', jobId:'job-1', promptId:'prompt-1'};
 const value = scenario === 'E2E_SYNC' ? completed : background;
 const runText = 'generation result';
 const data = {scenario, unrelated:'unrelated', before:{prompts:[],cancelled:[]}, state:{prompts:['prompt-1','unrelated'],cancelled:[]},
  events:[{type:'tool_call',callId:'run-1',tool:'comfyui_run',input:{mode:scenario === 'E2E_SYNC'?'sync':'async'}}, {type:'tool_result',callId:'run-1',status:'completed',result:runText}],
  canonical:[{kind:'tool-result',name:'comfyui_run',result:{isError:false,value,content:[{type:'text',text:runText}]}}]};
 if (scenario !== 'E2E_SYNC') {
  const name = scenario === 'E2E_ASYNC' ? 'job_output' : 'job_kill';
  const output = name === 'job_output' ? {text:JSON.stringify(completed),job:{id:'job-1',status:'completed'}} : {outcome:'cancellation-requested',job:{id:'job-1',status:'stopping'}};
  const text = name === 'job_output' ? output.text+'\n[status: completed]' : 'requested cancellation of job job-1';
  data.events.push({type:'tool_call',callId:'job-call',tool:name,input:{job_id:'job-1',wait:true}},{type:'tool_result',callId:'job-call',status:'completed',result:text});
  data.canonical.push({kind:'tool-result',name,result:{isError:false,value:output,content:[{type:'text',text}]}});
  if (scenario === 'E2E_CANCEL') data.state.cancelled.push('prompt-1');
 }
 return data;
}

test('rejects a wrong-tool-only SYNC trace that the original assertions accept', async () => {
 const bad = trace(); bad.events=[{type:'tool_call',callId:'wrong',tool:'job_output'}]; bad.canonical=[];
 await originalValidator()(bad);
 await assert.rejects(async () => validate(bad));
});

for (const scenario of ['E2E_SYNC','E2E_ASYNC','E2E_CANCEL']) {
 test(`${scenario} accepts a complete correlated trace`, () => validate(trace(scenario)));
 const mutations = {
  'missing calls': d => d.events = d.events.filter(x => x.type !== 'tool_call'),
  'missing results': d => d.events = d.events.filter(x => x.type !== 'tool_result'),
  'missing canonical results': d => d.canonical = [],
  'wrong call ID': d => d.events[1].callId = 'wrong',
  'duplicate call ID': d => d.events.push(structuredClone(d.events[0])),
  'failed result': d => d.events[1].status = 'failed',
  'canonical error': d => d.canonical[0].result.isError = true,
  'wrong canonical tool': d => d.canonical[0].name = 'other',
  'mismatched rendered result': d => d.events[1].result = 'unrelated success',
  'missing canonical value': d => delete d.canonical[0].result.value,
  'wrong mode': d => d.events[0].input.mode = 'other',
  'missing prompt ID': d => delete d.canonical[0].result.value.promptId,
  'prompt absent from backend': d => d.state.prompts = ['unrelated'],
  'stale prompt from previous scenario': d => d.before.prompts = ['prompt-1'],
 };
 if (scenario === 'E2E_SYNC') Object.assign(mutations, {
  'wrong run kind': d => d.canonical[0].result.value.kind = 'background',
  'not completed': d => d.canonical[0].result.value.status = 'running',
  'missing media': d => delete d.canonical[0].result.value.media,
  'empty media': d => d.canonical[0].result.value.media = [],
  'invalid media': d => d.canonical[0].result.value.media = [{}],
  'cancelled completed prompt': d => d.state.cancelled = ['prompt-1'],
 });
 for (const [name, mutate] of Object.entries(mutations)) test(`${scenario} rejects ${name}`, async () => {
  const d = trace(scenario); mutate(d); await assert.rejects(async () => validate(d));
 });
}

for (const scenario of ['E2E_ASYNC','E2E_CANCEL']) {
 const mutations = {
  'wrong background kind': d => d.canonical[0].result.value.kind = 'sync',
  'missing job ID': d => delete d.canonical[0].result.value.jobId,
  'missing job operation': d => { d.events.splice(2); d.canonical.splice(1); },
  'wrong job target': d => d.events[2].input.job_id = 'other',
  'wrong job result ID': d => d.canonical[1].result.value.job.id = 'other',
  'missing job value': d => delete d.canonical[1].result.value.job,
  'wrong job status': d => d.canonical[1].result.value.job.status = 'running',
 };
 if (scenario === 'E2E_ASYNC') Object.assign(mutations, {
  'invalid result JSON': d => d.canonical[1].result.value.text = 'not JSON',
  'missing output text': d => delete d.canonical[1].result.value.text,
  'mismatched completed prompt': d => { const v=JSON.parse(d.canonical[1].result.value.text); v.promptId='other'; d.canonical[1].result.value.text=JSON.stringify(v); },
  'unfinished generation': d => { const v=JSON.parse(d.canonical[1].result.value.text); v.status='running'; d.canonical[1].result.value.text=JSON.stringify(v); },
  'empty generated media': d => { const v=JSON.parse(d.canonical[1].result.value.text); v.media=[]; d.canonical[1].result.value.text=JSON.stringify(v); },
  'cancelled async prompt': d => d.state.cancelled=['prompt-1'],
  'output text differs from content': d => d.canonical[1].result.value.text = '{}',
 });
 else Object.assign(mutations, {
  'wrong kill outcome': d => d.canonical[1].result.value.outcome='not-found',
  'no backend cancellation': d => d.state.cancelled=[],
  'unrelated-only cancellation': d => d.state.cancelled=['unrelated'],
  'target plus unrelated cancellation': d => d.state.cancelled.push('unrelated'),
  'target plus another cancellation': d => d.state.cancelled.push('other'),
  'stale target cancellation': d => d.before.cancelled=['prompt-1'],
  'no unrelated sentinel': d => delete d.unrelated,
 });
 for (const [name, mutate] of Object.entries(mutations)) test(`${scenario} rejects ${name}`, async () => {
  const d=trace(scenario); mutate(d); await assert.rejects(async () => validate(d));
 });
}

for (const scenario of ['E2E_ASYNC','E2E_CANCEL']) test(`original validator accepts ${scenario} without generation`, async () => {
 const d=trace(scenario); d.events.splice(0,2); d.canonical.splice(0,1);
 await originalValidator()(d);
 await assert.rejects(async () => validate(d));
});

export {trace, validate};
