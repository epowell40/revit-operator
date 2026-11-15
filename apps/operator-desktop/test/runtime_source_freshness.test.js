import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs/promises';import os from 'node:os';import path from 'node:path';
import {runtimeSourcesSha256} from '../runtime_sources.mjs';
test('standalone runtime identity detects a changed imported helper even when server bytes are unchanged',async t=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'public-runtime-freshness-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
 await fs.writeFile(path.join(root,'server.js'),"import './helper.mjs';\n");await fs.writeFile(path.join(root,'helper.mjs'),'export const value=1;');
 const server=await fs.readFile(path.join(root,'server.js')),before=runtimeSourcesSha256(root);await fs.writeFile(path.join(root,'helper.mjs'),'export const value=2;');
 assert.notEqual(runtimeSourcesSha256(root),before);assert.deepEqual(await fs.readFile(path.join(root,'server.js')),server);
 const start=await fs.readFile(new URL('../../../scripts/opencore/Start.ps1',import.meta.url),'utf8'),show=await fs.readFile(new URL('../../../scripts/opencore/Show.ps1',import.meta.url),'utf8');
 assert.match(start,/Show\.ps1/);assert.match(show,/moduleSourcesSha256/);assert.match(show,/Assert-OpenCoreProcess/);
});
