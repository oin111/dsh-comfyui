// Read-only test observer: records canonical outputs without replacing policy or runtime.
import { appendFileSync } from 'node:fs';
export const name = 'dsh-e2e-observer';
export const inject = ['tools', 'sandbox'];
export async function apply(ctx) {
 const file = process.env.DSH_E2E_OBSERVE_PATH;
 if (!file) return;
 const confined = await ctx.sandbox.confine([process.execPath, '--version'], { mode: 'workspace-write', workspaceRoot: process.cwd() });
 appendFileSync(file, JSON.stringify({kind:'sandbox-selection',backendExecutable:confined.argv[0],enforcement:confined.enforcement,runnerFailureRules:confined.runnerFailureRules})+'\n');
 ctx.on('tools/result', (exec,result) => {
  if (exec.name === 'run_code' || exec.name.startsWith('comfyui_') || exec.name.startsWith('job_')) appendFileSync(file,JSON.stringify({kind:'tool-result',name:exec.name,result})+'\n');
 });
}
