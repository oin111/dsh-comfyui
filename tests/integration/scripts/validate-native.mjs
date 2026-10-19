import assert from 'node:assert/strict';

function nonempty(value, label) {
 assert(typeof value === 'string' && value.trim().length > 0, `missing ${label}`);
}
function completed(value, promptId) {
 assert.equal(value?.kind, 'sync', 'completed run kind');
 assert.equal(value.status, 'completed', 'generation status');
 assert.equal(value.promptId, promptId, 'generation prompt ID');
 assert(Array.isArray(value.media) && value.media.length > 0, 'missing generated media');
 for (const media of value.media) {
  nonempty(media?.filename, 'media filename');
  assert.equal(media.type, 'output', 'media type');
  assert.equal(media.kind, 'image', 'mock media kind');
 }
}

// Native scenarios are deterministic: one run, followed by one job operation
// when asynchronous. Canonical observations have no call ID, so require the
// exact ordered tool sequence and identical rendered text to bind both streams.
export function validateNativeScenario({scenario, events, canonical, state, before, unrelated}) {
 assert(['E2E_SYNC', 'E2E_ASYNC', 'E2E_CANCEL'].includes(scenario), 'unknown native scenario');
 const expected = scenario === 'E2E_SYNC' ? ['comfyui_run'] : ['comfyui_run', scenario === 'E2E_ASYNC' ? 'job_output' : 'job_kill'];
 const calls = events.filter(x => x.type === 'tool_call');
 const results = events.filter(x => x.type === 'tool_result');
 const observations = canonical.filter(x => x.kind === 'tool-result');
 assert.deepEqual(calls.map(x => x.tool), expected, 'expected native tool calls');
 assert.equal(results.length, calls.length, 'missing or extra native results');
 assert.deepEqual(observations.map(x => x.name), expected, 'expected canonical results');
 const ids = new Set();
 for (let i = 0; i < calls.length; i++) {
  nonempty(calls[i].callId, 'call ID');
  assert(!ids.has(calls[i].callId), 'duplicate call ID'); ids.add(calls[i].callId);
  assert.equal(results[i].callId, calls[i].callId, 'result call ID');
  assert.equal(results[i].status, 'completed', 'tool result status');
  const result = observations[i].result;
  assert.equal(result?.isError, false, 'canonical result error');
  assert(result.value && typeof result.value === 'object', 'missing canonical value');
  const text = result.content?.filter(x => x.type === 'text').map(x => x.text).join('\n');
  nonempty(text, 'canonical text');
  assert.equal(results[i].result, text, 'canonical/rendered result mismatch');
 }
 assert.equal(calls[0].input?.mode, scenario === 'E2E_SYNC' ? 'sync' : 'async', 'run mode');
 const run = observations[0].result.value;
 nonempty(run.promptId, 'prompt ID');
 assert(state.prompts.includes(run.promptId), 'prompt absent from mock state');
 assert(!before.prompts.includes(run.promptId), 'prompt predates scenario');
 if (scenario === 'E2E_SYNC') {
  completed(run, run.promptId);
  assert(!state.cancelled.includes(run.promptId), 'completed prompt was cancelled');
 } else {
  assert.equal(run.kind, 'background', 'background run kind');
  nonempty(run.jobId, 'job ID');
  assert.equal(calls[1].input?.job_id, run.jobId, 'job operation target');
  const output = observations[1].result.value;
  assert.equal(output.job?.id, run.jobId, 'job result ID');
  if (scenario === 'E2E_ASYNC') {
   assert.equal(output.job.status, 'completed', 'background job status');
   nonempty(output.text, 'job output text');
   completed(JSON.parse(output.text), run.promptId);
   const text = observations[1].result.content.filter(x => x.type === 'text').map(x => x.text).join('\n');
   assert.equal(text, `${output.text}\n[status: completed]`, 'job output content mismatch');
   assert(!state.cancelled.includes(run.promptId), 'completed prompt was cancelled');
  } else {
   assert.equal(output.outcome, 'cancellation-requested', 'job kill outcome');
   assert.equal(output.job.status, 'stopping', 'job kill status');
   nonempty(unrelated, 'unrelated prompt sentinel');
   assert.notEqual(unrelated, run.promptId, 'sentinel is target');
   assert(state.prompts.includes(unrelated), 'sentinel absent from backend');
   assert(!state.cancelled.includes(unrelated), 'unrelated running prompt was cancelled');
   assert(!before.cancelled.includes(run.promptId), 'target cancellation predates scenario');
   const cancelled = state.cancelled.filter(id => !before.cancelled.includes(id));
   assert.deepEqual(cancelled, [run.promptId], 'must cancel exactly the scenario prompt');
  }
 }
 return {promptId: run.promptId, ...(run.jobId ? {jobId: run.jobId} : {})};
}
