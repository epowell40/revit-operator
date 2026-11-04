import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {Archive,direct,under,restoreArchiveGroup} from './development-archive.mjs';
import {admitDevelopmentWorkspace,DEVELOPMENT_ARCHIVE_BUDGET,DEVELOPMENT_WORKSPACE_BUDGET} from './development-workspace-lifecycle.mjs';

const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const read=p=>JSON.parse(fs.readFileSync(p,'utf8'));
const write=(p,value)=>{const fd=fs.openSync(p,'wx');try{fs.writeFileSync(fd,JSON.stringify(value,null,2));fs.fsyncSync(fd);}finally{fs.closeSync(fd);}};
const stopped=s=>s?.processesAlive===false&&s.quiescent===true&&s.unknown===false&&s.pendingUsage===false
 &&s.terminal===false&&/^[a-f0-9]{64}$/.test(s.fingerprint);
function manifest(store,group){
 assert(group?.verified&&typeof group.manifest==='string'&&path.basename(group.manifest)===group.manifest);
 const file=path.join(store,group.manifest);direct(file);const raw=zlib.gunzipSync(fs.readFileSync(file));assert.equal(hash(raw),group.manifestSha256,'Archive manifest identity');
 const value=JSON.parse(raw);assert.equal(path.resolve(value.root),path.resolve(group.root));assert(Array.isArray(value.records));
 const seen=new Set();for(const row of value.records){const file=path.resolve(value.root,row.p);assert(typeof row.p==='string'&&under(value.root,file)&&file!==path.resolve(value.root));
  const key=file.toLowerCase();assert(!seen.has(key),'Duplicate restore path');seen.add(key);assert(Number.isSafeInteger(row.bytes)&&row.bytes>=0);
  assert(row.credentialCopy===true&&row.h===null||/^[a-f0-9]{64}$/.test(row.h),'Archive object identity');}
 return value;
}
function verifyKeepers(workspace,keepers){
 assert(Array.isArray(keepers)&&keepers.length>0,'Explicit immutable keepers required');
 for(const k of keepers){assert(under(workspace,k.source)&&!under(workspace,k.keeper),'Keeper must live outside the parked workspace');direct(k.source);direct(k.keeper);
  assert.equal(hash(fs.readFileSync(k.source)),k.sha256);assert.equal(hash(fs.readFileSync(k.keeper)),k.sha256);}
}

/** Explicit owner-requested storage parking, never routine terminal cleanup.
 * An unfinished task stays unfinished. Archive its complete stopped workspace,
 * prove recoverability and external model/history keepers, then free expansion.
 * No journal/control/budget is changed and no model/tool/provider is invoked.
 */
export async function parkDevelopmentWorkspace({workspace,allowedRoot,archiveStore,receiptFile,caseId,keepers,readActivity,budget=DEVELOPMENT_ARCHIVE_BUDGET}){
 workspace=path.resolve(workspace);allowedRoot=path.resolve(allowedRoot);archiveStore=path.resolve(archiveStore);receiptFile=path.resolve(receiptFile);
 assert(path.dirname(workspace)===allowedRoot,'Only the explicitly owned direct-child workspace may be parked');direct(workspace);direct(archiveStore);direct(receiptFile);
 assert(!under(workspace,archiveStore)&&under(allowedRoot,receiptFile)&&!under(workspace,receiptFile),'Durable receipt/archive outside workspace required');
 assert(!fs.existsSync(receiptFile)&&!fs.existsSync(receiptFile+'.intent'),'Fresh parking receipt required');
 const marker=read(path.join(workspace,'.test-workspace.json'));assert.equal(marker.caseId,caseId);assert.equal(path.resolve(marker.workspace),workspace);
 const before=await readActivity();if(!stopped(before))return{state:'protected',reason:'active_unknown_pending_or_not_stopped',activity:before};
 verifyKeepers(workspace,keepers);
 const catalog=path.join(archiveStore,'groups.jsonl');if(fs.existsSync(catalog))assert(new Set(fs.readFileSync(catalog,'utf8').trim().split('\n').filter(Boolean).map(JSON.parse).map(g=>g.id)).size<budget.maxGroups,'Archive count budget');
 const archive=new Archive(archiveStore,{maxBytes:budget.maxBytes});
 try{
  const copied=archive.archiveTree(workspace,{allowedRoots:[allowedRoot],excludeCredentials:true,remove:false});
  const contents=manifest(archiveStore,copied);for(const row of contents.records)if(!row.credentialCopy)assert.equal(hash(archive.get(row.h)),row.h);
  const after=await readActivity();assert(stopped(after)&&after.fingerprint===before.fingerprint,'Canonical/runtime state changed; expanded work stays protected');
  verifyKeepers(workspace,keepers);
  const intent={schema:'operator.development-resumable-parking/v1',at:new Date().toISOString(),workspace,allowedRoot,archiveStore,caseId,
   canonicalFingerprint:before.fingerprint,activity:before,keepers,copied,canonicalMutated:false,credentials:'Expired credential copies excluded; normal authentication required on recovery'};
  write(receiptFile+'.intent',intent);
  // Archive group IDs include milliseconds. The second verified removal group
  // must have a distinct ID, even for a tiny synthetic workspace.
  await new Promise(resolve=>setTimeout(resolve,2));
  const removed=archive.archiveTree(workspace,{allowedRoots:[allowedRoot],excludeCredentials:true,remove:true,beforeRemove:current=>{
   assert.deepEqual(current.records.map(r=>[r.p,r.h,r.bytes,r.credentialCopy]),contents.records.map(r=>[r.p,r.h,r.bytes,r.credentialCopy]),'Workspace changed before removal');
   verifyKeepers(workspace,keepers);
  }});
  const removedContents=manifest(archiveStore,removed);
  assert.deepEqual(removedContents.records.map(r=>[r.p,r.h,r.bytes,r.credentialCopy]),contents.records.map(r=>[r.p,r.h,r.bytes,r.credentialCopy]),'Workspace changed before removal');
  for(const k of keepers)assert.equal(hash(fs.readFileSync(k.keeper)),k.sha256);
  const result={...intent,state:removed.fullyRemoved?'parked_resumable':'partially_parked_protected',removed,stats:archive.stats};write(receiptFile,result);return result;
 }finally{archive.close();}
}

/** Restore exact original paths before ordinary task/model reconciliation.
 * Fresh admission uses the same expansion/headroom limits. A partial restore
 * is retained on failure; recovery never overwrites a differing file.
 */
export async function restoreParkedDevelopmentWorkspace({receiptFile,allowedRoot,archiveStore,readActivity,policy=DEVELOPMENT_WORKSPACE_BUDGET}){
 direct(receiptFile);const ticket=read(receiptFile),workspace=path.resolve(ticket.workspace);
 assert.equal(ticket.schema,'operator.development-resumable-parking/v1');assert.equal(path.resolve(ticket.allowedRoot),path.resolve(allowedRoot));assert.equal(path.resolve(ticket.archiveStore),path.resolve(archiveStore));
 assert.equal(path.dirname(workspace),path.resolve(allowedRoot));assert(ticket.state==='parked_resumable','A fully parked workspace receipt is required');
 const activity=await readActivity();assert(stopped(activity)&&activity.fingerprint===ticket.canonicalFingerprint,'Restore runtime/canonical state differs');
 const original=manifest(archiveStore,ticket.removed);for(const k of ticket.keepers){assert(!under(workspace,k.keeper));direct(k.keeper);assert.equal(hash(fs.readFileSync(k.keeper)),k.sha256);}
 assert(!fs.existsSync(workspace),'Existing or partially restored workspace is protected; reconcile exact archive mapping before retry');
 const admission=admitDevelopmentWorkspace({root:allowedRoot,workspace,policy});
 assert(original.records.reduce((n,r)=>n+(r.credentialCopy?0:r.bytes),0)<=policy.reservedBytes,'Restore exceeds the admitted workspace reservation');
 const restored=restoreArchiveGroup(archiveStore,ticket.removed,{allowedRoots:[workspace]});
 for(const k of ticket.keepers)assert.equal(hash(fs.readFileSync(k.source)),k.sha256);
 return{state:'restored_pending',workspace,files:restored.files,bytes:restored.bytes,admission,canonicalMutated:false,canonicalFingerprint:ticket.canonicalFingerprint,credentialsRestored:false};
}
