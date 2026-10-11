import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { readDesktopResponse, retainDesktopResponse, desktopResponseContinuationAllowed } from '../src/desktop_response_store.js';
const binding = { session_id:'s', assignment_id:'a', run_id:'r', generation:1, kernelVersion:2 as const };
test('late response survives transport loss; duplicate identities never invoke provider again', async () => {
 const old=process.env.OPERATOR_WORKSPACE_ROOT; process.env.OPERATOR_WORKSPACE_ROOT=fs.mkdtempSync(path.join(os.tmpdir(),'desktop-result-'));
 try {
  let resolve!: (v: unknown)=>void, calls=0;
  const pending=retainDesktopResponse(binding,'m',{input:'original'},()=>{calls++;return new Promise(r=>resolve=r);},()=>({error:'safe'}));
  assert.equal(readDesktopResponse(binding,'m')?.status,'pending');
  await assert.rejects(retainDesktopResponse(binding,'m',{input:'original'},async()=>{calls++;},()=>null),/already_dispatched/);
  await assert.rejects(retainDesktopResponse(binding,'m',{input:'changed'},async()=>{calls++;},()=>null),/identity_conflict/);
  resolve({id:'late-response',output:[{type:'computer_call',call_id:'one'}],usage:{tokens:12}});
  await pending;
  assert.equal(readDesktopResponse(binding,'m')?.status,'complete');
  assert.equal((readDesktopResponse(binding,'m')?.response as any).id,'late-response');
  assert.throws(()=>readDesktopResponse({...binding,generation:2},'m'),/binding_mismatch/);
  assert.throws(()=>readDesktopResponse({...binding,assignment_id:'other'},'m'),/binding_mismatch/);
  assert.equal(readDesktopResponse({...binding,session_id:'other'},'m'),null);
  assert.throws(()=>readDesktopResponse(binding,'../../escape'),/identity_required/);
  await assert.rejects(retainDesktopResponse(binding,'m',{input:'original'},async()=>{calls++;},()=>null),/already_dispatched/);
  assert.equal(calls,1);
 } finally { if(old===undefined)delete process.env.OPERATOR_WORKSPACE_ROOT;else process.env.OPERATOR_WORKSPACE_ROOT=old; }
});
test('provider error receipt persists; error is not re-invoked or changed into completion',async()=>{
 const old=process.env.OPERATOR_WORKSPACE_ROOT;process.env.OPERATOR_WORKSPACE_ROOT=fs.mkdtempSync(path.join(os.tmpdir(),'desktop-error-'));
 try {
  await assert.rejects(retainDesktopResponse(binding,'e',{},async()=>{throw Error('private');},()=>({error:'safe',model_call_receipts:[{call_id:'failed'}]})),/private/);
  const result=readDesktopResponse(binding,'e');assert.equal(result?.status,'error');
  assert.equal((result?.failure as any).model_call_receipts[0].call_id,'failed');assert.ok(!JSON.stringify(result).includes('private'));
 }finally {if(old===undefined)delete process.env.OPERATOR_WORKSPACE_ROOT;else process.env.OPERATOR_WORKSPACE_ROOT=old;}
});

test('consuming a late response respects pause, unknown effects and required human input',()=>{
 const settled={terminal:false,quiescent:true,unresolved_unknown_operation_ids:[],pending_input_variable_ids:[],pending_review_ids:[]} as any;
 assert.equal(desktopResponseContinuationAllowed(settled),true);
 for(const blocked of [null,{terminal:true},{quiescent:false},{execution_control:{state:'paused'}},{provider_usage_hold:{}},
  {unresolved_unknown_operation_ids:['unknown']},{pending_input_variable_ids:['question']},{pending_review_ids:['approval']}]) {
  assert.equal(desktopResponseContinuationAllowed(blocked===null?null:{...settled,...blocked}),false);
 }
});
