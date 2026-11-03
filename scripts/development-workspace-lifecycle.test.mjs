import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import {withDevelopmentWorkspace,finalizeDevelopmentWorkspace} from './development-workspace-lifecycle.mjs';
import {restoreFile} from './development-archive.mjs';
test('all outcomes archive unique receipts, deduplicate dependencies and preserve pending work',async()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'operator-workspace-lifecycle-')),archiveStore=path.join(root,'archive');
 try{
  const receipts=[];
  for(let i=0;i<12;i++){
   const workspace=path.join(root,'workspace'+i);fs.mkdirSync(workspace);fs.writeFileSync(path.join(workspace,'dependency.dll'),Buffer.alloc(100_000));fs.writeFileSync(path.join(workspace,'failure.json'),JSON.stringify({i}));
   const options={workspace,allowedRoot:root,archiveStore,readActivity:async()=>({processesAlive:false,terminal:true,quiescent:true,unknown:false,pendingUsage:false}),onCleanup:r=>receipts.push(r)};
   const work=()=>withDevelopmentWorkspace(options,async()=>{if(i%4){const e=Error('retained unique failure '+i);e.name=i%4===1?'Error':i%4===2?'AbortError':'TimeoutError';throw e;}});
   if(i%4)await assert.rejects(work());else await work();assert(!fs.existsSync(workspace));
  }
  assert.deepEqual([...new Set(receipts.map(x=>x.outcome))].sort(),['cancellation','failure','success','timeout']);
  assert.equal(receipts.reduce((n,r)=>n+r.stats.uniqueObjects,0),13);
  const restored=path.join(root,'workspace3','failure.json');restoreFile(archiveStore,restored,{allowedRoots:[root]});assert.deepEqual(JSON.parse(fs.readFileSync(restored)),{i:3});
  for(const flags of [{terminal:false},{unknown:true},{pendingUsage:true},{processesAlive:true}]){
   const pending=path.join(root,'pending');fs.mkdirSync(pending,{recursive:true});fs.writeFileSync(path.join(pending,'keep'),'untouched');
   assert.equal(finalizeDevelopmentWorkspace({workspace:pending,allowedRoot:root,archiveStore,outcome:'timeout',activity:{terminal:true,quiescent:true,...flags}}).state,'protected');assert(fs.existsSync(path.join(pending,'keep')));
  }
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});
test('archive quota fails before deleting the expanded source and preserves the original failure',async()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'operator-workspace-quota-')),workspace=path.join(root,'workspace');fs.mkdirSync(workspace);fs.writeFileSync(path.join(workspace,'unique.json'),'valuable failure bytes');
 try{
  const notices=[];const options={workspace,allowedRoot:root,archiveStore:path.join(root,'archive'),budget:{maxBytes:1,maxGroups:1},readActivity:async()=>({terminal:true,quiescent:true}),onCleanup:r=>notices.push(r)};
  await assert.rejects(withDevelopmentWorkspace(options,async()=>{throw Error('original task failure')}),/original task failure/);
  assert.equal(notices[0].state,'cleanup_failed');assert(fs.existsSync(path.join(workspace,'unique.json')));
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});
