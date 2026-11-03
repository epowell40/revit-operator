import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import * as lifecycle from './development-workspace-lifecycle.mjs';

test('aggregate staging refuses another workspace while preserving protected existing work',()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'operator-workspace-admission-'));
 try{
  const current=path.join(root,'isolated-api-workspace1');fs.mkdirSync(current);fs.writeFileSync(path.join(current,'pending.rvt'),Buffer.alloc(120));
  assert.equal(typeof lifecycle.admitDevelopmentWorkspace,'function');
  assert.throws(()=>lifecycle.admitDevelopmentWorkspace({root,workspace:path.join(root,'isolated-api-workspace2'),policy:{maxBytes:150,maxWorkspaces:8,minFreeBytes:0,reservedBytes:40}}),/aggregate.*byte/i);
  assert.equal(fs.statSync(path.join(current,'pending.rvt')).size,120);assert(!fs.existsSync(path.join(root,'isolated-api-workspace2')));
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});

test('count, byte reservation and free-space limits refuse safely; legacy and managed roots count',()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'operator-workspace-count-'));
 try{
  for(const name of ['isolated-api-workspace7','managed-case']){const p=path.join(root,name);fs.mkdirSync(p);fs.writeFileSync(path.join(p,'.test-workspace.json'),'{}');}
  fs.mkdirSync(path.join(root,'unrelated'));fs.writeFileSync(path.join(root,'unrelated','keep'),'unrelated');
  const options={root,workspace:path.join(root,'isolated-api-workspace8'),policy:{maxBytes:1000,maxWorkspaces:2,minFreeBytes:0,reservedBytes:1}};
  assert.throws(()=>lifecycle.admitDevelopmentWorkspace(options),/count budget/);
  const allowed=lifecycle.admitDevelopmentWorkspace({...options,policy:{...options.policy,maxWorkspaces:3}});assert.equal(allowed.existingWorkspaces,2);assert.equal(allowed.expandedBytes,4);
  assert.throws(()=>lifecycle.admitDevelopmentWorkspace({...options,policy:{...options.policy,maxWorkspaces:3,minFreeBytes:Number.MAX_SAFE_INTEGER}}),/headroom/);
  assert.throws(()=>lifecycle.admitDevelopmentWorkspace({...options,workspace:path.join(root,'unrelated','nested')}),/direct child/);
  assert.throws(()=>lifecycle.admitDevelopmentWorkspace({...options,policy:{...options.policy,reservedBytes:NaN}}),/Invalid workspace budget/);
  assert.equal(fs.readFileSync(path.join(root,'unrelated','keep'),'utf8'),'unrelated');
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});

test('retiring an eligible test restores admission without deleting a pending sibling',()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'operator-workspace-retire-'));
 try{
  const pending=path.join(root,'isolated-api-workspace1'),closed=path.join(root,'isolated-api-workspace2');for(const p of [pending,closed]){fs.mkdirSync(p);fs.writeFileSync(path.join(p,'model.rvt'),Buffer.alloc(30));}
  const options={root,workspace:path.join(root,'isolated-api-workspace3'),policy:{maxBytes:100,maxWorkspaces:2,minFreeBytes:0,reservedBytes:1}};
  assert.throws(()=>lifecycle.admitDevelopmentWorkspace(options),/count budget/);
  lifecycle.finalizeDevelopmentWorkspace({workspace:closed,allowedRoot:root,archiveStore:path.join(root,'archive'),outcome:'success',activity:{terminal:true,quiescent:true}});
  assert.equal(lifecycle.admitDevelopmentWorkspace(options).existingWorkspaces,1);assert.equal(fs.statSync(path.join(pending,'model.rvt')).size,30);
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});
