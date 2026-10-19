import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const workflow = JSON.parse(await fs.readFile(path.join(root, 'fixtures/workflow.json'), 'utf8'));
const port = Number(process.env.MOCK_PORT || 18188);
const logfile = process.env.MOCK_LOG || path.join(root, 'runtime/mock-events.jsonl');
await fs.mkdir(path.dirname(logfile), { recursive: true });
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aWZkAAAAASUVORK5CYII=', 'base64');
const state = { requests: {}, prompts: [], cancelled: [], llm: [] };
const jobs = new Map();
const info = {
 CheckpointLoaderSimple:{ input:{required:{ckpt_name:[['mock-checkpoint.safetensors']]}}, output:['MODEL','CLIP','VAE'], output_name:['MODEL','CLIP','VAE'], category:'mock' },
 CLIPTextEncode:{input:{required:{text:['STRING',{multiline:true}],clip:['CLIP']}},output:['CONDITIONING'],category:'mock'},
 EmptyLatentImage:{input:{required:{width:['INT',{default:64}],height:['INT',{default:64}],batch_size:['INT',{default:1}]}},output:['LATENT'],category:'mock'},
 KSampler:{input:{required:{seed:['INT',{default:1}],steps:['INT',{default:1}],cfg:['FLOAT',{default:1}],sampler_name:[['euler']],scheduler:[['normal']],denoise:['FLOAT',{default:1}],model:['MODEL'],positive:['CONDITIONING'],negative:['CONDITIONING'],latent_image:['LATENT']}},output:['LATENT'],category:'mock'},
 VAEDecode:{input:{required:{samples:['LATENT'],vae:['VAE']}},output:['IMAGE'],category:'mock'},
 SaveImage:{input:{required:{images:['IMAGE'],filename_prefix:['STRING',{default:'dsh-e2e'}]}},output:[],output_node:true,category:'mock'}
};
function json(res, value, status=200) { res.writeHead(status, {'content-type':'application/json'}); res.end(JSON.stringify(value)); }
function history(id,j) { return {prompt:[j.n,id,j.workflow,{},['6']],outputs:{'6':{images:[{filename:'dsh-e2e.png',subfolder:'',type:'output'}]}},status:{status_str:j.cancelled?'error':'success',completed:!j.cancelled,messages:j.cancelled?[['execution_interrupted',{prompt_id:id}]]:[['execution_success',{prompt_id:id}]]}}; }
function isDone(j) { return !j.cancelled && Date.now()>=j.doneAt; }
function event(value) { return fs.appendFile(logfile, JSON.stringify({time:new Date().toISOString(),...value})+'\n'); }
function extractJSON(s) { const t=typeof s==='string'?s:JSON.stringify(s); const m=t.match(/"jobId"\s*:\s*"([^"]+)"/); return m?.[1] || t.match(/\(job ([^,\s]+)/)?.[1]; }
function llmResponse(body) {
 const messages=body.messages||[]; const texts=messages.filter(x=>x.role==='user').map(x=>typeof x.content==='string'?x.content:JSON.stringify(x.content)).join('\n');
 const marker=texts.match(/E2E_(SANDBOX|PTC|SYNC|ASYNC|CANCEL)/)?.[0];
 const toolMessages=messages.filter(x=>x.role==='tool');
 let name,args;
 if(marker && toolMessages.length===0) {
  if(marker==='E2E_SANDBOX') { name='run_code';args={description:'Validate the actual confined Node PTC runtime',code:`const fs = await import('node:fs/promises'); await fs.writeFile('allowed.txt','inside workspace'); let denied=false,denialCode; try { await fs.writeFile('../outside/denied.txt','should not be written'); } catch(e) { denied=true; denialCode=e.code; } console.log('PTC process executing'); return {marker:'PTC_REAL_SANDBOX_OK',environmentEmpty:Object.keys(process.env).length===0,cwd:process.cwd(),outsideWriteDenied:denied,denialCode};`}; }
  else if(marker==='E2E_PTC') { name='run_code'; args={description:'Validate ComfyUI tools through the sandboxed PTC runtime',code:`const listed = await tools.comfyui_workflow({action:'list'}); const info = await tools.comfyui_object_info({}); const run = await tools.comfyui_run({workflow:${JSON.stringify(workflow)},mode:'sync'}); return { marker:'PTC_REAL_SANDBOX_OK', environmentEmpty:Object.keys(process.env).length===0, workflowCount:listed.workflows?.length, objectInfo:info, run };`}; }
  else { name='comfyui_run'; const wf=structuredClone(workflow); if(marker==='E2E_CANCEL') wf['6'].inputs.e2e_delay_ms=60000; args={workflow:wf,mode:marker==='E2E_SYNC'?'sync':'async'}; }
 } else if(marker && toolMessages.length===1 && (marker==='E2E_ASYNC'||marker==='E2E_CANCEL')) {
  const id=extractJSON(toolMessages[0].content); if(id) {name=marker==='E2E_CANCEL'?'job_kill':'job_output';args={job_id:id,...marker==='E2E_ASYNC'?{wait:true}:{}};}
 }
 if(name) return {role:'assistant',content:null,tool_calls:[{id:`e2e_${randomUUID().replaceAll('-','')}`,type:'function',function:{name,arguments:JSON.stringify(args)}}]};
 return {role:'assistant',content:marker?`${marker}_FINISHED ${toolMessages.map(x=>typeof x.content==='string'?x.content:JSON.stringify(x.content)).join('\n')}`:'Mock LLM ready. Use E2E_SYNC, E2E_ASYNC, E2E_CANCEL or E2E_PTC.'};
}
const server=http.createServer(async(req,res)=>{try{
 const url=new URL(req.url,`http://127.0.0.1:${port}`);const p=url.pathname.replace(/^\/api(?=\/)/,'');
 state.requests[url.pathname]=(state.requests[url.pathname]||0)+1;
 const chunks=[];for await(const c of req) chunks.push(c); const bytes=Buffer.concat(chunks); let body={};if(bytes.length&&req.headers['content-type']?.includes('application/json')) body=JSON.parse(bytes.toString());
 if(url.pathname==='/__state') return json(res,state);
 if(url.pathname==='/__health') return json(res,{ok:true,mock:true});
 if(url.pathname==='/v1/models') return json(res,{object:'list',data:[{id:'dsh-e2e-mock',object:'model',owned_by:'local-test'}]});
 if(url.pathname==='/v1/chat/completions') {
  const result=llmResponse(body);state.llm.push({tool:result.tool_calls?.[0]?.function.name,stream:body.stream});await event({kind:'llm',request:body,response:result});
  const base={id:'chatcmpl-e2e',object:'chat.completion',created:Math.floor(Date.now()/1000),model:'dsh-e2e-mock'};
  if(!body.stream) return json(res,{...base,choices:[{index:0,message:result,finish_reason:result.tool_calls?'tool_calls':'stop'}],usage:{prompt_tokens:10,completion_tokens:10,total_tokens:20}});
  res.writeHead(200,{'content-type':'text/event-stream','cache-control':'no-cache'});
  const delta=result.tool_calls?{role:'assistant',tool_calls:result.tool_calls.map((t,i)=>({index:i,...t}))}:{role:'assistant',content:result.content};
  res.write(`data: ${JSON.stringify({...base,object:'chat.completion.chunk',choices:[{index:0,delta,finish_reason:null}]})}\n\n`);
  res.write(`data: ${JSON.stringify({...base,object:'chat.completion.chunk',choices:[{index:0,delta:{},finish_reason:result.tool_calls?'tool_calls':'stop'}],usage:{prompt_tokens:10,completion_tokens:10,total_tokens:20}})}\n\ndata: [DONE]\n\n`); return res.end();
 }
 if(p==='/system_stats')return json(res,{system:{os:'mock',comfyui_version:'mock-e2e-1.0',python_version:'mock'},devices:[]});
 if(p==='/object_info'||p.startsWith('/object_info/'))return json(res,p==='/object_info'?info:{[decodeURIComponent(p.split('/').pop())]:info[decodeURIComponent(p.split('/').pop())]});
 if(p==='/v2/userdata'||p==='/userdata')return json(res,[]);
 if(p==='/prompt'&&req.method==='POST'){const id=body.prompt_id||randomUUID();const n=jobs.size+1;const delay=Object.values(body.prompt||{}).find(x=>x.inputs?.e2e_delay_ms)?.inputs.e2e_delay_ms||350;jobs.set(id,{n,workflow:body.prompt,doneAt:Date.now()+delay});state.prompts.push(id);await event({kind:'prompt',id,body});return json(res,{prompt_id:id,number:n,node_errors:{}});}
 if(p==='/queue'&&req.method==='GET'){const active=[...jobs].filter(([,j])=>!isDone(j)&&!j.cancelled).map(([id,j])=>[j.n,id,j.workflow,{},['6']]);return json(res,{queue_running:active.slice(0,1),queue_pending:active.slice(1)});}
 if(p==='/history'&&req.method==='GET')return json(res,Object.fromEntries([...jobs].filter(([,j])=>isDone(j)||j.cancelled).map(([id,j])=>[id,history(id,j)])));
 if(p.startsWith('/history/')){const id=decodeURIComponent(p.slice(9)),j=jobs.get(id);return json(res,j&&(isDone(j)||j.cancelled)?{[id]:history(id,j)}:{});}
 if(p==='/interrupt'||(p==='/queue'&&req.method==='POST')){for(const [id,j]of jobs)if(!isDone(j)&&!j.cancelled&&(p==='/interrupt'||body.clear||body.delete?.includes(id))){j.cancelled=true;state.cancelled.push(id);if(p==='/interrupt')break;}return json(res,{});}
 if(p==='/history'&&req.method==='POST'){for(const[id]of jobs)if(body.clear||body.delete?.includes(id))jobs.delete(id);return json(res,{});}
 if(p==='/jobs'||p.startsWith('/jobs/')) return json(res,{error:'mock uses documented queue/history fallback'},404);
 if(p==='/free')return json(res,{});
 if(p==='/view'){res.writeHead(200,{'content-type':'image/png','content-length':png.length});return res.end(req.method==='HEAD'?undefined:png);}
 if(p==='/upload/image')return json(res,{name:'mock-upload.png',subfolder:'',type:'input'});
 return json(res,{error:`Mock route not implemented: ${req.method} ${url.pathname}`},404);
 }catch(error){await event({kind:'error',message:String(error)});json(res,{error:String(error)},500);}});
server.listen(port,'127.0.0.1',()=>console.log(`Mock ComfyUI + LLM: http://127.0.0.1:${port}`));
for(const sig of ['SIGINT','SIGTERM'])process.on(sig,()=>server.close(()=>process.exit(0)));
