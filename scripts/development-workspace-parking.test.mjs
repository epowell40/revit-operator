import test from'node:test';import assert from'node:assert/strict';import fs from'node:fs';import os from'node:os';import path from'node:path';import{createHash}from'node:crypto';
import{parkDevelopmentWorkspace,restoreParkedDevelopmentWorkspace}from'./development-workspace-parking.mjs';
import{Archive}from'./development-archive.mjs';
const hash=b=>createHash('sha256').update(b).digest('hex');
function fixture(){const root=fs.mkdtempSync(path.join(os.tmpdir(),'resumable-parking-')),workspace=path.join(root,'isolated-api-workspace1'),archiveStore=path.join(root,'archive'),receiptFile=path.join(root,'parked.json');fs.mkdirSync(workspace);
 const journal=JSON.stringify({terminal:false,outcome:'awaiting_user_review',usage:{calls:82,tokens:12356132},pending_review_ids:['original-review'],events:['immutable history']});
 fs.writeFileSync(path.join(workspace,'.test-workspace.json'),JSON.stringify({caseId:'test',workspace}));fs.writeFileSync(path.join(workspace,'goal.json'),journal);fs.writeFileSync(path.join(workspace,'model.rvt'),'saved model bytes');fs.writeFileSync(path.join(workspace,'auth.json'),'secret');
 const keepers=['goal.json','model.rvt'].map(name=>{const source=path.join(workspace,name),keeper=path.join(root,'kept-'+name);fs.linkSync(source,keeper);return{source,keeper,sha256:hash(fs.readFileSync(source))};});
 const state={terminal:false,processesAlive:false,quiescent:true,unknown:false,pendingUsage:false,fingerprint:hash(Buffer.from(journal))};
 return{root,workspace,archiveStore,receiptFile,caseId:'test',allowedRoot:root,keepers,state,readActivity:async()=>({...state}),dispose(){assert(path.dirname(root)===path.resolve(os.tmpdir()));fs.rmSync(root,{recursive:true,force:true});}};
}
test('a stopped unfinished task parks and restores exact model/history without completion or credentials',async()=>{const f=fixture();try{
 const parked=await parkDevelopmentWorkspace(f);assert.equal(parked.state,'parked_resumable');assert(!fs.existsSync(f.workspace));assert.equal(parked.canonicalMutated,false);
 const restored=await restoreParkedDevelopmentWorkspace({...f});assert.equal(restored.state,'restored_pending');assert(!fs.existsSync(path.join(f.workspace,'auth.json')));
 const goal=JSON.parse(fs.readFileSync(path.join(f.workspace,'goal.json')));assert.equal(goal.terminal,false);assert.equal(goal.outcome,'awaiting_user_review');assert.deepEqual(goal.pending_review_ids,['original-review']);assert.equal(goal.usage.tokens,12356132);
 for(const k of f.keepers)assert.equal(hash(fs.readFileSync(k.source)),k.sha256);
}finally{f.dispose();}});
for(const flags of [{processesAlive:true},{quiescent:false},{unknown:true},{pendingUsage:true},{terminal:true},{pendingUsage:undefined}])test('parking protects '+JSON.stringify(flags),async()=>{const f=fixture();try{
 const result=await parkDevelopmentWorkspace({...f,readActivity:async()=>({...f.state,...flags})});assert.equal(result.state,'protected');assert(fs.existsSync(f.keepers[0].source));assert(!fs.existsSync(f.receiptFile));
}finally{f.dispose();}});
test('canonical change during archive retains expansion and never writes a completed parking ticket',async()=>{const f=fixture();try{let n=0;
 await assert.rejects(parkDevelopmentWorkspace({...f,readActivity:async()=>({...f.state,fingerprint:++n===1?f.state.fingerprint:'b'.repeat(64)})}),/state changed/);
 assert(fs.existsSync(f.workspace));assert(!fs.existsSync(f.receiptFile));
}finally{f.dispose();}});
test('archive quota failure leaves model, journal and keepers intact',async()=>{const f=fixture();try{
 await assert.rejects(parkDevelopmentWorkspace({...f,budget:{maxBytes:1,maxGroups:1}}),/byte budget/);assert(fs.existsSync(f.workspace));for(const k of f.keepers)assert.equal(hash(fs.readFileSync(k.source)),k.sha256);
}finally{f.dispose();}});
test('restore obeys unchanged admission budget and refuses overwrite of an existing workspace',async()=>{const f=fixture();try{
 await parkDevelopmentWorkspace(f);await assert.rejects(restoreParkedDevelopmentWorkspace({...f,policy:{maxWorkspaces:0,maxBytes:1024**3,minFreeBytes:0,reservedBytes:100000}}),/count budget/);assert(!fs.existsSync(f.workspace));
 fs.mkdirSync(f.workspace);fs.writeFileSync(path.join(f.workspace,'foreign'),'untouched');await assert.rejects(restoreParkedDevelopmentWorkspace(f),/Existing or partially restored/);assert.equal(fs.readFileSync(path.join(f.workspace,'foreign'),'utf8'),'untouched');
}finally{f.dispose();}});
test('wrong owner marker and keeper fail before removing any data',async()=>{const f=fixture();try{
 await assert.rejects(parkDevelopmentWorkspace({...f,caseId:'other'}));fs.writeFileSync(f.keepers[0].keeper,'changed');await assert.rejects(parkDevelopmentWorkspace(f));assert(fs.existsSync(f.workspace));
}finally{f.dispose();}});
test('a changed file set is refused before any expanded source file is removed',async()=>{const f=fixture();try{let n=0;
 await assert.rejects(parkDevelopmentWorkspace({...f,readActivity:async()=>{if(++n===2)fs.writeFileSync(path.join(f.workspace,'late.json'),'new record');return{...f.state};}}),/changed before removal/);
 assert(fs.existsSync(f.keepers[0].source));assert(fs.existsSync(f.keepers[1].source));assert(fs.existsSync(path.join(f.workspace,'late.json')));
}finally{f.dispose();}});
test('restore uses the exact parking group rather than a newer archive of the same path',async()=>{const f=fixture();try{
 await parkDevelopmentWorkspace(f);fs.mkdirSync(f.workspace);fs.writeFileSync(path.join(f.workspace,'model.rvt'),'newer different task bytes');
 const archive=new Archive(f.archiveStore);try{archive.archiveTree(f.workspace,{allowedRoots:[f.root],remove:true});}finally{archive.close();}
 await restoreParkedDevelopmentWorkspace(f);assert.equal(fs.readFileSync(path.join(f.workspace,'model.rvt'),'utf8'),'saved model bytes');
}finally{f.dispose();}});
