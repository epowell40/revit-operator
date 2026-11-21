import test from 'node:test';
import assert from 'node:assert/strict';
import * as contracts from './index.js';

const pending=['pending_review_ids','pending_input_variable_ids','unresolved_unknown_operation_ids','in_flight_operation_ids','in_flight_provider_call_ids'];
function fixture(){
 const binding={assignment_id:'task',session_id:'session',run_id:'run',generation:1,principal_id:'principal',document_fingerprint:'model'};
 return {schema:'revit-operator.assignment-kernel-publication/v2',assignment_id:'task',assignment_version:12,
  snapshot:{schema:'revit-operator.assignment-snapshot/v2',assignment_version:12,current_binding:binding,
   execution_control:{state:'running',command_id:'resume',changed_at:'2026-11-21T00:00:00Z'},
   outcome:'active',terminal:false,quiescent:true,provider_budget_exhausted:false,completion_proposal:null,
   ...Object.fromEntries(pending.map(k=>[k,[]])),provider_call_ids:[],provider_calls:{},
   work_plan:{items:[{source:'Reference PDF',retained_history:'x'.repeat(100_000)}]}},
  provider_ledger:{schema:'revit-operator.assignment-provider-ledger/v2',assignment_id:'task',run_id:'run',generation:1,call_ids:[],in_flight_call_ids:[],calls:{}}};
}
test('dispatch projection preserves actual control fields while omitting model/history/ledger payloads',()=>{
 assert.equal(typeof contracts.projectAssignmentDispatchControlV1,'function');
 const p=fixture(),before=structuredClone(p),value=contracts.projectAssignmentDispatchControlV1(p);
 assert.deepEqual(contracts.parseAssignmentDispatchControlV1(JSON.parse(JSON.stringify(value))),value);
 assert.deepEqual(value.snapshot.current_binding,p.snapshot.current_binding);
 for(const k of pending)assert.deepEqual(value.snapshot[k],p.snapshot[k]);
 assert.equal(value.snapshot.execution_control.command_id,'resume');
 assert.equal(value.snapshot.provider_usage_hold,false);assert.equal(value.snapshot.completion_proposal,false);
 assert(Buffer.byteLength(JSON.stringify(value))<2000);assert(!JSON.stringify(value).includes('retained_history'));
 assert.deepEqual(p,before,'Projection does not mutate or drop authoritative history');
});
test('dispatch projection validates the original publication and refuses incoherent ledgers',()=>{
 assert.equal(typeof contracts.projectAssignmentDispatchControlV1,'function');
 for(const change of [p=>p.provider_ledger.run_id='foreign',p=>p.snapshot.provider_call_ids=['missing'],p=>p.snapshot.assignment_version++,p=>p.snapshot.execution_control.state='unknown']){
  const p=fixture();change(p);assert.throws(()=>contracts.projectAssignmentDispatchControlV1(p));
 }
});
test('compact control validates without cloning discarded drawing history and returns isolated fields',()=>{
 const source=fixture(), before=structuredClone(source), clone=globalThis.structuredClone;
 let fullCopies=0;
 try{
  globalThis.structuredClone=(value,...args)=>{
   if(value?.schema==='revit-operator.assignment-kernel-publication/v2'||value?.schema==='revit-operator.assignment-snapshot/v2')fullCopies++;
   return clone(value,...args);
  };
  const control=contracts.projectAssignmentDispatchControlV1(source);
  control.snapshot.current_binding.run_id='changed';control.snapshot.pending_review_ids.push('changed');
  control.snapshot.execution_control.state='paused';
 }finally{globalThis.structuredClone=clone;}
 assert.equal(fullCopies,0,'Compact reads must not copy unrelated retained model evidence.');
 assert.deepEqual(source,before);
 const parsed=contracts.parseAssignmentKernelPublicationV2(source);
 parsed.snapshot.work_plan.items[0].source='changed';
 assert.deepEqual(source,before,'The full public parser still returns an isolated value.');
});
test('initial absence of a control command and a real provider usage hold remain explicit',()=>{
 const p=fixture();delete p.snapshot.execution_control;
 assert.equal(contracts.projectAssignmentDispatchControlV1(p).snapshot.execution_control,null);
 p.snapshot.provider_usage_hold={schema:'revit-operator.provider-usage-hold/v1',hold_id:'hold',binding:{...p.snapshot.current_binding},attempt_id:'attempt',
  provider_thread_id:'thread',provider_turn_id:'turn',code:'usageLimitExceeded',recorded_at:'2026-11-21T00:00:00Z',
  resume_budget:Object.fromEntries(['max_reasoning_turns','max_provider_calls','max_operations','max_equivalent_operations','max_no_progress_epochs','max_reconciliation_attempts','max_wall_clock_ms','max_total_tokens'].map(k=>[k,1])),
  worker_identity:{provider:'openai_codex',configured_billing_mode:'unknown',requested_model:null,requested_reasoning_effort:null,reported_model:null,reported_model_source:null}};
 assert.equal(contracts.projectAssignmentDispatchControlV1(p).snapshot.provider_usage_hold,true);
 p.snapshot.provider_usage_hold.binding.run_id='foreign';assert.throws(()=>contracts.projectAssignmentDispatchControlV1(p));
});
test('dispatch parser fails closed on omitted, malformed or mixed-version control fields',()=>{
 assert.equal(typeof contracts.projectAssignmentDispatchControlV1,'function');
 const original=contracts.projectAssignmentDispatchControlV1(fixture());
 for(const field of ['current_binding','execution_control','outcome','terminal','quiescent','provider_budget_exhausted','provider_usage_hold','completion_proposal',...pending]){
  const value=structuredClone(original);delete value.snapshot[field];assert.throws(()=>contracts.parseAssignmentDispatchControlV1(value),field);
 }
 for(const change of [p=>p.assignment_version++,p=>p.snapshot.current_binding.assignment_id='foreign',p=>p.snapshot.execution_control.state='unknown',p=>p.snapshot.provider_usage_hold='false',p=>p.snapshot.in_flight_operation_ids=[null]]){
  const value=structuredClone(original);change(value);assert.throws(()=>contracts.parseAssignmentDispatchControlV1(value));
 }
});
