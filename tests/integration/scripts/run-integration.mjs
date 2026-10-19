import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { randomUUID } from 'node:crypto';
import { validateNativeScenario } from './validate-native.mjs';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const workspace=path.join(root,'runtime/workspace');
const reports=path.join(root,'reports');
const port=Number(process.env.DSH_E2E_PORT||13080),mockPort=Number(process.env.MOCK_PORT||18188);
for (const [name, value] of [['DSH_E2E_PORT', port], ['MOCK_PORT', mockPort]]) {
 if (!Number.isInteger(value) || value < 1 || value > 65535) throw new Error(`${name} must be an integer from 1 to 65535`);
}
assert.notEqual(port, mockPort, 'DSH_E2E_PORT and MOCK_PORT must differ');
const base=`http://127.0.0.1:${port}`, mockBase=`http://127.0.0.1:${mockPort}`;
const children=[];
const report={startedAt:new Date().toISOString(),node:process.version,dsh:JSON.parse(await fs.readFile(path.join(root,'node_modules/@deepseek-ai/dsh/package.json'))).version,checks:[],browser:{status:'not-run',reason:'Use scripts/start-browser.sh on a host where the browser shares the server network.'},gpu:{status:'not-run',reason:'Synthetic ComfyUI mock only'}};
await fs.mkdir(workspace,{recursive:true});await fs.mkdir(reports,{recursive:true});await fs.mkdir(path.join(root,'runtime/outside'),{recursive:true});
const env={...process.env,DSH_HOME:path.join(root,'runtime/home'),DSH_E2E_MOCK_KEY:'mock-only-not-secret',MOCK_PORT:String(mockPort)};
for (const kind of ['DATA', 'CONFIG', 'CACHE']) env[`XDG_${kind}_HOME`]=path.join(root,`runtime/xdg-${kind.toLowerCase()}`);
const dsh=path.join(root,'node_modules/@deepseek-ai/dsh/lib/bin.js');
function launch(args,options={}) { const cp=spawn(process.execPath,args,{cwd:options.cwd||root,env:{...env,...options.env},stdio:['ignore','pipe','pipe']});children.push(cp);let stdout='',stderr='';cp.stdout.on('data',b=>stdout+=b);cp.stderr.on('data',b=>stderr+=b);cp.on('error',e=>stderr+=String(e));const done=new Promise(resolve=>cp.on('close',(code,signal)=>resolve({code,signal,stdout,stderr})));return{cp,done,get stdout(){return stdout},get stderr(){return stderr}}; }
async function check(name,fn){try{const detail=await fn();report.checks.push({name,status:'passed',...(detail===undefined?{}:{detail})});console.log(`PASS ${name}`);return detail;}catch(e){report.checks.push({name,status:'failed',error:String(e)});throw e;}}
async function until(fn,ms=30000){const end=Date.now()+ms;let last;while(Date.now()<end){try{const v=await fn();if(v)return v;}catch(e){last=e;}await delay(150);}throw new Error(`Timed out: ${last||'condition not ready'}`);}
let cookie='';
async function request(route,{body,auth=true,origin=base,method=body===undefined?'GET':'POST'}={}){return fetch(base+route,{method,headers:{...(auth?{cookie}:{}),...(origin?{origin}:{}),...(body===undefined?{}:{'content-type':'application/json'})},...(body===undefined?{}:{body:JSON.stringify(body)}),redirect:'manual'});}
async function json(route,opts){const res=await request(route,opts);const text=await res.text();assert.equal(res.status,200,`${route}: ${res.status} ${text}`);return JSON.parse(text);}
try{
 const mock=launch([path.join(root,'scripts/mock-server.mjs')]);await until(async()=>{const r=await fetch(mockBase+'/__health');return r.ok;});
 const web=launch([dsh,'web','--no-open','--port',String(port)],{cwd:workspace});
 const login=await until(()=>`${web.stdout}\n${web.stderr}`.match(/http:\/\/127\.0\.0\.1:\d+\/\?token=[^\s]+/)?.[0],60000);
 await check('DSH authenticated browser-server bootstrap',async()=>{const r=await fetch(login,{redirect:'manual'});assert.equal(r.status,303);cookie=r.headers.getSetCookie().map(x=>x.split(';')[0]).join('; ');assert(cookie);const html=await request('/');assert.equal(html.status,200);assert.match(await html.text(),/<html/i);});
 await check('Installed plugin metadata includes the exact PNG icon without diagnostics',async()=>{
  // Actual host RPC: dsh-plugin-manager Remote and dsh-client-connection envelope.
  const method='pluginManager/listPlugins';
  const response=await json(`/api/${method}`,{body:{type:'client-request',rpcId:randomUUID(),method,payload:{args:{}}}});
  assert.equal(response.result?.ok,true,JSON.stringify(response));
  const rows=response.result.value;
  assert(Array.isArray(rows),'listPlugins must return an inventory array');
  const plugin=rows.find(row=>row.moduleName==='@oin111/dsh-comfyui');
  assert(plugin,'ComfyUI must appear in the actual host inventory');
  assert.equal(plugin.meta?.error,undefined,JSON.stringify(plugin.meta));
  assert.match(plugin.meta?.icon||'',/^data:image\/png;base64,[A-Za-z0-9+/]+={0,2}$/,'metadata must include a nonempty PNG data URI');
  const installed=path.join(root,'runtime/home/profiles/web/node_modules/@oin111/dsh-comfyui');
  const manifest=JSON.parse(await fs.readFile(path.join(installed,'package.json'),'utf8'));
  const target=manifest.icon??manifest.exports?.['./icon'];
  assert.equal(typeof target,'string','installed package must configure an icon');
  const bytes=await fs.readFile(path.join(installed,target));
  assert(bytes.length>0&&bytes.length<=256*1024,'installed icon must fit the host limit');
  assert.deepEqual(bytes.subarray(0,8),Buffer.from('89504e470d0a1a0a','hex'));
  assert.deepEqual(Buffer.from(plugin.meta.icon.split(',')[1],'base64'),bytes,'host metadata must equal the installed asset');
  return {moduleName:plugin.moduleName,icon:target,bytes:bytes.length};
 });
 await check('Unauthenticated plugin route denied',async()=>{assert.equal((await request('/comfyui/ping',{auth:false})).status,401);});
 await check('Cross-origin plugin route denied',async()=>{assert.equal((await request('/comfyui/config',{origin:'https://untrusted.invalid'})).status,403);});
 await check('Plugin configuration and backend probe',async()=>{const config=await json('/comfyui/config');assert.equal(config.baseUrl,mockBase);assert.equal((await json('/comfyui/test',{body:{}})).ok,true);return{baseUrl:config.baseUrl};});
 const workflow=JSON.parse(await fs.readFile(path.join(root,'fixtures/workflow.json')));
 const batch=randomUUID().slice(0,8);
 const saved=await check('Twenty concurrent workflow saves survive',async()=>{const rows=await Promise.all(Array.from({length:20},(_,i)=>json('/comfyui/workflows',{body:{name:`E2E ${batch} ${i}`,description:'Synthetic fixture',workflow}})));for(const row of rows)assert.equal(row.ok,true);const all=(await json('/comfyui/workflows')).workflows;for(const row of rows)assert(all.some(x=>x.id===row.workflow.id));return rows.map(x=>({id:x.workflow.id,name:x.workflow.name}));});
 const prompt=await check('Browser-facing workflow run',async()=>{const run=await json('/comfyui/workflows/run',{body:{id:saved[0].id}});assert.equal(run.ok,true);return run.promptId;});
 await check('Completed run becomes an asset',async()=>{const asset=await until(async()=>{const data=await json('/comfyui/assets');return data.assets?.find(x=>x.promptId===prompt);});assert(asset.media?.length>0);return {promptId:prompt,media:asset.media.length};});
 await check('Authenticated same-origin media proxy',async()=>{const r=await request('/comfyui/media?file=dsh-e2e.png&type=output');assert.equal(r.status,200);assert.match(r.headers.get('content-type'),/^image\/png/);assert.match(r.headers.get('content-disposition'),/dsh-e2e\.png/);assert.equal(new Uint8Array(await r.arrayBuffer())[0],137);});
 for(const scenario of ['E2E_SYNC','E2E_ASYNC','E2E_CANCEL','E2E_SANDBOX','E2E_PTC']){
  await check(`Actual DSH headless ${scenario}`,async()=>{
   let unrelated; if(scenario==='E2E_CANCEL'){const wf=structuredClone(workflow);wf['6'].inputs.e2e_delay_ms=60000;const r=await fetch(mockBase+'/prompt',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({prompt:wf})});unrelated=(await r.json()).prompt_id;}
   const before=await(await fetch(mockBase+'/__state')).json();
   const observer=path.join(reports,`${scenario}.canonical.jsonl`);await fs.writeFile(observer,'');
   const run=launch([dsh,'headless','--json',scenario],{cwd:workspace,env:{DSH_TOOLS_MODE:scenario==='E2E_PTC'||scenario==='E2E_SANDBOX'?'ptc':'native',DSH_E2E_OBSERVE_PATH:observer}});
   const timeout=setTimeout(()=>run.cp.kill('SIGTERM'),60000);const result=await run.done;clearTimeout(timeout);
   await fs.writeFile(path.join(reports,`${scenario}.ndjson`),result.stdout);await fs.writeFile(path.join(reports,`${scenario}.stderr`),result.stderr);
   assert.equal(result.code,0,result.stderr);const events=result.stdout.trim().split('\n').filter(Boolean).map(x=>JSON.parse(x));
   const calls=events.filter(x=>x.type==='tool_call'),results=events.filter(x=>x.type==='tool_result');assert(calls.length>0);for(const r of results)assert.equal(r.status,'completed',JSON.stringify(r));
   const canonical=(await fs.readFile(observer,'utf8')).trim().split('\n').filter(Boolean).map(x=>JSON.parse(x));for(const r of canonical.filter(x=>x.kind==='tool-result'))assert.equal(r.result.isError,false,JSON.stringify(r));
   let native;
   if(['E2E_SYNC','E2E_ASYNC','E2E_CANCEL'].includes(scenario)) {
    const state=await(await fetch(mockBase+'/__state')).json();
    native=validateNativeScenario({scenario,events,canonical,state,before,unrelated});
   }
   if(scenario==='E2E_PTC'||scenario==='E2E_SANDBOX'){
    const value=canonical.find(x=>x.name==='run_code')?.result.value;assert.equal(value.sandbox.mode,'workspace-write');assert.equal(value.sandbox.enforcement,'full');assert.equal(value.result.marker,'PTC_REAL_SANDBOX_OK');assert.equal(value.result.environmentEmpty,true);
    if(scenario==='E2E_SANDBOX'){assert.equal(value.result.outsideWriteDenied,true);assert(['EROFS','EACCES','EPERM'].includes(value.result.denialCode));assert.equal(await fs.readFile(path.join(workspace,'allowed.txt'),'utf8'),'inside workspace');await assert.rejects(fs.stat(path.join(root,'runtime/outside/denied.txt')),{code:'ENOENT'});}
    if(scenario==='E2E_PTC')assert.equal(value.result.run.status,'completed');
    return {tools:calls.map(x=>x.tool),sandbox:value.sandbox,backend:canonical.find(x=>x.kind==='sandbox-selection'),result:value.result};
   }
   return {tools:calls.map(x=>x.tool),...native};
  });
 }
 await check('Cancellation reached only mock prompt(s)',async()=>{const state=await(await fetch(mockBase+'/__state')).json();assert(state.cancelled.length>0);return {cancelled:state.cancelled.length,prompts:state.prompts.length};});
 report.status='passed';
}catch(e){report.status='failed';report.error=String(e);console.error(e);process.exitCode=1;
}finally{
 for(const cp of children)if(cp.exitCode===null)cp.kill('SIGTERM');
 await Promise.all(children.map(cp=>cp.exitCode!==null?Promise.resolve():new Promise(r=>{cp.once('close',r);setTimeout(()=>{cp.kill('SIGKILL');r();},5000).unref();})));
 report.finishedAt=new Date().toISOString();await fs.writeFile(path.join(reports,'integration-report.json'),JSON.stringify(report,null,2)+'\n');
}
