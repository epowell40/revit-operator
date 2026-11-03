import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {acquireCodexIsolation,pruneCodexIsolation,CODEX_ISOLATION_RETENTION} from '../src/codex/isolation_lifecycle.js';
import {prepareCertifiedCodexIsolation} from '../src/codex/config.js';
import {ModelConversationIntake} from '../src/brains/conversation_intake_model.js';

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
