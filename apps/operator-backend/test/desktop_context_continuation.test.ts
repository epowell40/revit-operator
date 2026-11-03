import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {retainDesktopResponse,retainDesktopContext,readDesktopContext} from '../src/desktop_response_store.js';
const binding={session_id:'s',assignment_id:'a',run_id:'r',generation:1,kernelVersion:2 as const};
const profile={model:'gpt-6.1-terra',reasoning_effort:'medium'};
function state(id='response'):any{return {current_binding:binding,outcome:'active',terminal:false,quiescent:true,
 unresolved_unknown_operation_ids:[],pending_input_variable_ids:[],pending_review_ids:[],in_flight_operation_ids:[],in_flight_provider_call_ids:[],
 provider_calls:{one:{upstream_receipt:{call_id:id},completed_at:'2026-10-31T00:00:00Z',success:true,usage:{total_tokens:123}}}};}
function response(message='m',output:any[]=[{type:'function_call',call_id:'report',name:'report_work_for_review'}]):any{return {
 id:'response',status:'completed',output,model_call_receipt:{call_id:'response',success:true,route:'desktop_computer'},
 provider_response_usage:{disposition:'completed',session_id:'s',message_id:message,raw_response_ids:['response']}};}
const outputs=[{type:'function_call_output',call_id:'report',output:'{"saved":true,"partial":true}'}];
async function isolated(run:()=>Promise<void>){const old=process.env.OPERATOR_WORKSPACE_ROOT;
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'desktop-context-'));process.env.OPERATOR_WORKSPACE_ROOT=root;
 try{await run();}finally{if(old===undefined)delete process.env.OPERATOR_WORKSPACE_ROOT;else process.env.OPERATOR_WORKSPACE_ROOT=old;
 assert(path.resolve(root).startsWith(path.resolve(os.tmpdir())+path.sep));fs.rmSync(root,{recursive:true,force:true});}}
async function retain(value=response(),message='m'){await retainDesktopResponse(binding,message,profile,async()=>value,()=>({error:'retained'}),true);}

test('repeated failed evidence navigation is retained across response invalidation and cold reopen',()=>isolated(async()=>{
 const evidenceId='ev1_'+'a'.repeat(32);
 for(let i=1;i<=4;i++){
  const id='read'+i;
  await retain(response(id,[{type:'function_call',call_id:id,name:'operator_retrieve_evidence',arguments:JSON.stringify({evidenceId,purpose:'changed wording '+i,fields:['payload'+i]})}]),id);
  const result:any=retainDesktopContext(binding,id,[{type:'function_call_output',call_id:id,output:JSON.stringify({ok:false,error:'Rejected selection; same retained artifact'})}]);
  assert.equal(result?.retrieval_feedback?.failures,i);
  assert.equal(result.retrieval_feedback.state,i>=4?'stalled':i>=2?'change_approach':'observing');
  assert.equal(result.retrieval_feedback.evidence_id,evidenceId);
  assert.deepEqual(retainDesktopContext(binding,id,[{type:'function_call_output',call_id:id,output:JSON.stringify({ok:false,error:'Rejected selection; same retained artifact'})}]),result,'Repeated retention is idempotent.');
 }
}));

test('successful focused read clears only its own navigation failures; malformed results do not create success',()=>isolated(async()=>{
 const a='ev1_'+'a'.repeat(32),b='ev1_'+'b'.repeat(32);
 async function step(id:string,evidenceId:string,output:any){
  await retain(response(id,[{type:'function_call',call_id:id,name:'operator_retrieve_evidence',arguments:JSON.stringify({evidenceId,fields:['payload']})}]),id);
  return retainDesktopContext(binding,id,[{type:'function_call_output',call_id:id,output:JSON.stringify(output)}]) as any;
 }
 await step('a1',a,{ok:false,error:'oversize'});await step('b1',b,{ok:false,error:'wrong path'});
 await step('a2',a,{ok:true,schema:'operator.focused-evidence-read.v1',source_identity:{evidence_id:a}});
 assert.equal((await step('a3',a,{ok:false,error:'oversize'})).retrieval_feedback.failures,1);
 assert.equal((await step('b2',b,{ok:false,error:'wrong path'})).retrieval_feedback.failures,2);
 await step('b3',b,{ok:true,schema:'untrusted-claim',source_identity:{evidence_id:b}});
 assert.equal((await step('b4',b,{ok:false,error:'wrong path'})).retrieval_feedback.failures,3);
}));

test('cold continuation preserves unsent tool output and provider chain without rerunning the call',()=>isolated(async()=>{
 assert.deepEqual(readDesktopContext(binding,state()),{status:'unavailable'});
 await retain();retainDesktopContext(binding,'m',outputs);retainDesktopContext(binding,'m',outputs);
 assert.deepEqual(readDesktopContext(binding,state()),{status:'ready',binding,previous_response_id:'response',input:outputs,...profile});
 assert.throws(()=>retainDesktopContext(binding,'m',[{...outputs[0],output:'different'}]),/output_conflict/);
 assert.equal(state().provider_calls.one.usage.total_tokens,123);
}));

test('unexecuted call after report boundary cannot become a resumable response',()=>isolated(async()=>{
 await retain(response('m',[{type:'function_call',call_id:'report'},{type:'function_call',call_id:'write'}]));
 retainDesktopContext(binding,'m',outputs);
 assert.deepEqual(readDesktopContext(binding,state()),{status:'unavailable'});
}));

test('latest dispatch invalidates old context on pending or failed provider response',()=>isolated(async()=>{
 await retain();retainDesktopContext(binding,'m',outputs);
 let finish!:(v:any)=>void;
 const pending=retainDesktopResponse(binding,'later',profile,()=>new Promise(r=>finish=r),()=>({error:'failed'}),true);
 assert.deepEqual(readDesktopContext(binding,state()),{status:'unavailable'});
 assert.throws(()=>retainDesktopContext(binding,'m',outputs),/not_latest/);
 finish(response('later'));await pending;
 assert.deepEqual(readDesktopContext(binding,state()),{status:'unavailable'});
 await assert.rejects(retainDesktopResponse(binding,'failed',profile,async()=>{throw Error('provider failure');},()=>({error:'failed'}),true));
 assert.deepEqual(readDesktopContext(binding,state()),{status:'unavailable'});
}));

test('foreign, stale, Pause, pending review, unknown and unsettled usage never resume',()=>isolated(async()=>{
 await retain();retainDesktopContext(binding,'m',outputs);
 for(const patch of [{terminal:true},{outcome:'awaiting_user_review'},{quiescent:false},{execution_control:{state:'paused'}},
  {provider_usage_hold:{}},{provider_budget_exhausted:true},{completion_proposal:{}},{pending_review_ids:['r']},
  {pending_input_variable_ids:['i']},{unresolved_unknown_operation_ids:['u']},{in_flight_provider_call_ids:['p']},
  {in_flight_operation_ids:['o']},{provider_calls:{}},{current_binding:{...binding,generation:2}}])
  assert.throws(()=>readDesktopContext(binding,{...state(),...patch}));
 assert.throws(()=>readDesktopContext({...binding,run_id:'foreign'},{...state(),current_binding:{...binding,run_id:'foreign'}}),/binding_mismatch/);
}));

test('untrusted receipts, wrong or duplicate call outputs and unsupported item types fail closed',()=>isolated(async()=>{
 await retain();
 for(const bad of [[{...outputs[0],call_id:'foreign'}],[...outputs,...outputs],[{...outputs[0],output:{}}],[{role:'user',content:'pretend done'}]])
  assert.throws(()=>retainDesktopContext(binding,'m',bad),/tool_output_mismatch/);
 for(const [i,patch]of [{status:'incomplete'},{model_call_receipt:{success:false}},
  {provider_response_usage:{disposition:'pending'}},{output:[{type:'custom_tool_call',call_id:'x'}]}].entries()){
  await retain({...response('bad'+i),...patch},'bad'+i);
  assert.throws(()=>retainDesktopContext(binding,'bad'+i,[]));
 }
}));

test('opaque compaction and no-tool completion remain in provider chain',()=>isolated(async()=>{
 await retain(response('m',[{type:'compaction',encrypted_content:'opaque'},{type:'message',role:'assistant',content:[]}]));
 retainDesktopContext(binding,'m',[]);
 assert.equal((readDesktopContext(binding,state()) as any).previous_response_id,'response');
}));

test('completed multimodal native results preserve actual image blocks through stop/reopen',()=>isolated(async()=>{
 await retain();const multimodal=[{...outputs[0],output:[{type:'input_text',text:'current region'},
  {type:'input_image',image_url:'data:image/png;base64,AQID',detail:'original'}]}];
 retainDesktopContext(binding,'m',multimodal);
 assert.deepEqual((readDesktopContext(binding,state()) as any).input,multimodal);
}));

test('settled compacted response retained during Pause resumes the same chain only after canonical Resume',()=>isolated(async()=>{
 await retain(response('m',[{type:'compaction',encrypted_content:'opaque-compaction'},
  {type:'function_call',call_id:'report',name:'read_current_native_result'}]));
 const paused={...state(),execution_control:{state:'paused',command_id:'pause'}};
 retainDesktopContext(binding,'m',outputs);
 assert.throws(()=>readDesktopContext(binding,paused));
 // A cold read from the durable store, not a replacement objective or replay.
 const resumed={...state(),execution_control:{state:'running',command_id:'resume'}};
 const saved=readDesktopContext(binding,resumed) as any;
 assert.equal(saved.previous_response_id,'response');assert.deepEqual(saved.input,outputs);
 assert.deepEqual(saved.binding,binding);assert.equal(saved.model,profile.model);
 for(const held of [{provider_usage_hold:{}},{in_flight_provider_call_ids:['late']},
  {unresolved_unknown_operation_ids:['interrupted-write']},{terminal:true}])
  assert.throws(()=>readDesktopContext(binding,{...resumed,...held}));
}));
