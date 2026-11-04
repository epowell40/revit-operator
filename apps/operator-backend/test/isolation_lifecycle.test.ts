import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {acquireCodexIsolation,pruneCodexIsolation,CODEX_ISOLATION_RETENTION} from '../src/codex/isolation_lifecycle.js';
import {prepareCertifiedCodexIsolation} from '../src/codex/config.js';
import {ModelConversationIntake} from '../src/brains/conversation_intake_model.js';

test('actual isolation preparation tolerates an ancestor disappearing before its metadata observation',async t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'operator-isolation-metadata-'));
 const absent=path.join(root,'new-base'),exists=fs.existsSync;
 // Reproduce a stale existence answer without deleting another process's path.
 // The atomic metadata observation should see ENOENT and permit mkdir below it.
 t.mock.method(fs,'existsSync',(p:any)=>path.resolve(String(p))===absent||exists(p));
 t.mock.method(os,'homedir',()=>root); // Never copy the developer's auth into this fixture.
 try {
  const lease=prepareCertifiedCodexIsolation({workspaceRoot:path.join(root,'workspace'),isolationRoot:absent,ephemeral:true});
  assert.match(fs.readFileSync(path.join(lease.codexHome,'config.toml'),'utf8'),/MCP servers are intentionally absent/);
  assert(!exists(path.join(lease.codexHome,'auth.json')));
  await lease.release!();assert(!exists(lease.cwd));
 } finally {t.mock.restoreAll();fs.rmSync(root,{recursive:true,force:true});}
});

test('ancestor junctions and metadata permission errors still fail closed',async t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'operator-isolation-ancestor-'));
 try {
  const target=path.join(root,'protected'),alias=path.join(root,'alias');fs.mkdirSync(target);
  fs.writeFileSync(path.join(target,'keep'),'unchanged');
  fs.symlinkSync(target,alias,process.platform==='win32'?'junction':'dir');
  assert.throws(()=>acquireCodexIsolation(path.join(alias,'nested'),'a'.repeat(24)),/reparse_path/);
  assert.deepEqual(fs.readdirSync(target),['keep']);
  const stat=fs.lstatSync;
  t.mock.method(fs,'lstatSync',((p:any,opts:any)=>{
   if(path.resolve(String(p))===root)throw Object.assign(Error('fixture metadata denied'),{code:'EPERM'});
   return stat(p,opts);
  }) as typeof fs.lstatSync);
  assert.throws(()=>acquireCodexIsolation(path.join(root,'denied'),'b'.repeat(24)),/fixture metadata denied/);
  assert(!fs.existsSync(path.join(root,'denied')));
 } finally {t.mock.restoreAll();fs.rmSync(root,{recursive:true,force:true});}
});

test('closing leases remain protected and release refuses changed ownership',async()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'operator-isolation-owner-'));
 try {
  const lease=acquireCodexIsolation(root,'a'.repeat(24)),marker=path.join(lease.root,'isolation.json');
  const meta=JSON.parse(fs.readFileSync(marker,'utf8'));
  fs.writeFileSync(marker,JSON.stringify({...meta,closedAt:Date.now()-48*3600_000,closing:true}));
  assert.equal(pruneCodexIsolation(root,{...CODEX_ISOLATION_RETENTION,maxEntries:0,maxBytes:0}).removed,0);
  fs.writeFileSync(marker,JSON.stringify({...meta,workspaceHash:'b'.repeat(24)}));
  await assert.rejects(lease.release(),/release_owner_changed/);
  assert(fs.existsSync(marker),'an altered lease must not be deleted');
 } finally {fs.rmSync(root,{recursive:true,force:true});}
});

test('ephemeral homes clean on release; retained homes keep legacy continuity',async()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'operator-isolation-lifecycle-'));
 try {
  const opts={workspaceRoot:path.join(root,'workspace'),isolationRoot:path.join(root,'isolation')};
  const durable=prepareCertifiedCodexIsolation(opts);
  for(let i=0;i<20;i++){
   const lease=prepareCertifiedCodexIsolation({...opts,ephemeral:true});
   fs.writeFileSync(path.join(lease.codexHome,'synthetic-runtime.bin'),Buffer.alloc(4096));
   await lease.release!();await lease.release!();assert(!fs.existsSync(lease.cwd));
  }
  assert.deepEqual(fs.readdirSync(path.join(opts.isolationRoot,'ephemeral-v2')),[]);
  assert(fs.existsSync(durable.cwd));
 } finally {fs.rmSync(root,{recursive:true,force:true});}
});

test('retention protects active ownership, bounds abandoned bytes and refuses low headroom',async()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'operator-isolation-budget-'));
 try {
  const active=acquireCodexIsolation(root,'a'.repeat(24));
  fs.writeFileSync(path.join(active.root,'keep'),Buffer.alloc(80));
  for(let i=0;i<6;i++){
   const lease=acquireCodexIsolation(root,'b'.repeat(24),{policy:{...CODEX_ISOLATION_RETENTION,maxEntries:20}});
   const marker=path.join(lease.root,'isolation.json'),meta=JSON.parse(fs.readFileSync(marker,'utf8'));
   fs.writeFileSync(marker,JSON.stringify({...meta,closedAt:Date.now()-3600_000}));
   fs.writeFileSync(path.join(lease.root,'bytes'),Buffer.alloc(4096));
  }
  const result=pruneCodexIsolation(root,{...CODEX_ISOLATION_RETENTION,maxEntries:2,maxBytes:1000});
  assert.equal(result.removed,6);assert(fs.existsSync(path.join(active.root,'keep')));
  assert.throws(()=>acquireCodexIsolation(root,'c'.repeat(24),{freeBytes:()=>0}),/headroom/);
  assert.throws(()=>acquireCodexIsolation(root,'../escape'),/identity/);
  await active.release();
 } finally {fs.rmSync(root,{recursive:true,force:true});}
});

test('actual intake close waits for worker exit and releases on success, error, timeout and cancellation',{concurrency:false},async()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'operator-intake-lifecycle-'));
 const previous={brain:process.env.OPERATOR_BRAIN,model:process.env.OPERATOR_INTAKE_MODEL};
 process.env.OPERATOR_BRAIN='codex';process.env.OPERATOR_INTAKE_MODEL='gpt-6.1-sol';
 try {
  for(const outcome of ['success','error','timeout','cancellation']){
   let listener:(event:any)=>void=()=>{},made=0,stopped=0,releaseCount=0,unblock:()=>void=()=>{};
   const exit=new Promise<void>(r=>unblock=r),leaseRoot=path.join(root,outcome);fs.mkdirSync(leaseRoot);
   const client:any={setServerRequestHandler(){},async ensureStarted(){},async startThread(){return{model:'gpt-6.1-sol',thread:{id:'t'}}},
    onNotification(fn:any){listener=fn;return()=>{}},async startBoundTurn(){return{turn:{id:'u'}}},
    async waitForTurnCompleted(){if(outcome!=='success')throw Error(outcome);listener({threadId:'t',method:'item/completed',params:{item:{type:'agentMessage',text:'{"operation_scope":null}'}}});return{status:'completed'}},
    getTurnInstructionBinding(){return{}},stopAndWait(){stopped++;return exit}};
   const intake=new ModelConversationIntake({createClient:()=>{made++;return client},prepareIsolation:()=>({codexHome:leaseRoot,cwd:leaseRoot,release:()=>{releaseCount++;fs.rmdirSync(leaseRoot)}})});
   const call=()=>intake.interpret({user_text:'Read this drawing'} as any,new AbortController().signal);
   if(outcome==='success'){await call();await call();assert.equal(made,1,'reuse one home/client between turns');}
   else await assert.rejects(call(),new RegExp(outcome));
   const closing=intake.close();await Promise.resolve();assert.equal(releaseCount,0,'never delete a live worker home');
   unblock();await closing;assert.equal(stopped,1);assert.equal(releaseCount,1);assert(!fs.existsSync(leaseRoot));
  }
 } finally {
  if(previous.brain===undefined)delete process.env.OPERATOR_BRAIN;else process.env.OPERATOR_BRAIN=previous.brain;
  if(previous.model===undefined)delete process.env.OPERATOR_INTAKE_MODEL;else process.env.OPERATOR_INTAKE_MODEL=previous.model;
  fs.rmSync(root,{recursive:true,force:true});
 }
});
