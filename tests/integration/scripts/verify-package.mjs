import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const tgz=path.resolve(process.argv[2]||'');assert(process.argv[2],'Pass plugin tarball');
await fs.mkdir(path.join(root, 'runtime'), { recursive: true });
await fs.mkdir(path.join(root, 'reports'), { recursive: true });
const entries=execFileSync('tar',['-tzf',tgz],{encoding:'utf8'}).trim().split('\n');
for(const file of entries)assert(file.startsWith('package/')&&!file.split('/').includes('..'),'Unsafe archive path');
const temp=await fs.mkdtemp(path.join(root,'runtime/package-verify-'));
try{
 execFileSync('tar',['-xzf',tgz,'-C',temp]);const records=[];
 for(const file of entries){const source=path.join(temp,file);if(!(await fs.lstat(source)).isFile())continue;const rel=file.slice(8);const data=await fs.readFile(source);const sha256=createHash('sha256').update(data).digest('hex');for(const profile of ['web','headless']){const installed=await fs.readFile(path.join(root,'runtime/home/profiles',profile,'node_modules/@oin111/dsh-comfyui',rel));assert.equal(createHash('sha256').update(installed).digest('hex'),sha256,`${profile}/${rel}`);}records.push({file:rel,sha256});}
 const report={tarball:path.basename(tgz),sha256:createHash('sha256').update(await fs.readFile(tgz)).digest('hex'),files:records.length,profiles:['web','headless'],status:'passed',manifest:records};await fs.writeFile(path.join(root,'reports/package-integrity.json'),JSON.stringify(report,null,2)+'\n');console.log(`Verified ${records.length} packaged files in both installed profiles.`);
}finally{await fs.rm(temp,{recursive:true,force:true});}
