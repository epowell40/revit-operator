import test from 'node:test';
import assert from 'node:assert/strict';
import {submitWorkReportForReview,retainedWorkReportMessage,retainOwnerWrittenFindings,ownerWrittenFindingsReceipt,ownerWrittenFindingsMessage} from './work_report.mjs';
const binding={assignment_id:'a',session_id:'s',run_id:'r',generation:1};
const assignment={kernel_version:2,goal_id:'a',session_id:'s',run_id:'r',generation:1};
const text='Confirm the cafe appliance duty and HRU design basis before selecting equipment. No design was changed.';
const proposal={claimed_completed:[],remaining_work:[],uncertainties:[],written_findings:text};
function snapshot(){return {current_binding:binding,assignment_version:10,quiescent:true,outcome:'active',terminal:false,
 execution_control:{state:'running',command_id:'control',changed_at:'2026-10-26T12:00:00Z'},
 in_flight_operation_ids:[],in_flight_provider_call_ids:[],unresolved_unknown_operation_ids:[],pending_input_variable_ids:[],pending_review_ids:[],execution_failure_ids:[],
 operations:{edit:{requested_effect:'apply',persistent_effect:'applied',status:'success',result:{completed_at:'2026-10-26T12:10:00Z'}}}};}
const terminal=s=>({...s,assignment_version:12,terminal:true,outcome:'blocked'});
test('owner-reviewed requested writing survives a blocked native result without a completion proposal or new native request',async()=>{
 const s=snapshot(),calls=[];let record;
 const receipt=await submitWorkReportForReview(assignment,proposal,async(route,options)=>{calls.push(JSON.parse(options.body));return {ok:true,verification_policy:'strict',outcome:'active'};},
  {retainWrittenFindings:async(b,t)=>{record=retainOwnerWrittenFindings(b,t,s);return ownerWrittenFindingsReceipt(record);}});
 assert.deepEqual(calls.map(c=>c.action),['status']);assert.equal(receipt.whole_task_verified,false);assert.equal(receipt.native_postcondition_verified,false);
 assert.equal(retainedWorkReportMessage({name:'report_work_for_review'},{output:JSON.stringify(receipt)}),null,'retaining writing never ends the turn');
 assert.match(ownerWrittenFindingsMessage(record,binding,terminal(s)),/Confirm the cafe/);
 assert.match(ownerWrittenFindingsMessage(record,binding,terminal(s)),/not native verification/);
 for(const outcome of ['complete','complete_with_issues','verified_noop'])assert.match(ownerWrittenFindingsMessage(record,binding,{...terminal(s),outcome}),/Confirm the cafe/);
});
for(const [name,change] of Object.entries({foreign:s=>s.current_binding={...binding,run_id:'foreign'},Pause:s=>s.execution_control.state='paused',control:s=>s.execution_control.command_id='later',
 unknown:s=>s.unresolved_unknown_operation_ids=['unknown'],pendingUsage:s=>s.provider_usage_hold={reason:'pending'},provider:s=>s.in_flight_provider_call_ids=['provider'],
 native:s=>s.in_flight_operation_ids=['native'],input:s=>s.pending_input_variable_ids=['input'],review:s=>s.pending_review_ids=['review'],failure:s=>s.execution_failure_ids=['failure'],
 notQuiescent:s=>s.quiescent=false,oldVersion:s=>s.assignment_version=9,newWrite:s=>s.operations.later={requested_effect:'apply',persistent_effect:'applied',result:{completed_at:'2026-10-26T12:20:00Z'}},
 changedWrite:s=>s.operations.edit.result.completed_at='2026-10-26T12:20:00Z',unsettledWrite:s=>delete s.operations.edit.result.completed_at,failed:s=>s.outcome='failed',nonterminal:s=>s.terminal=false,
 invalidated:s=>s.input_invalidated_operation_ids=['edit'],missingArrays:s=>delete s.in_flight_provider_call_ids})){test('written result fails closed for '+name,()=>{const s=snapshot(),r=retainOwnerWrittenFindings(binding,text,s),after=terminal(structuredClone(s));change(after);assert.equal(ownerWrittenFindingsMessage(r,binding,after),'');});}
test('serialized helper/caller lookalikes and strict completion claims are never promoted',async()=>{
 const s=snapshot(),r=retainOwnerWrittenFindings(binding,text,s);assert.equal(ownerWrittenFindingsMessage(structuredClone(r),binding,terminal(s)),'');
 assert.throws(()=>ownerWrittenFindingsReceipt(structuredClone(r)),/owner_record/);
 for(const p of [{...proposal,claimed_completed:['All work verified']},{...proposal,written_findings:''},{...proposal,written_findings:'x'.repeat(8001)},{...proposal,assignment_id:'foreign'}])
  await assert.rejects(submitWorkReportForReview(assignment,p,async()=>({ok:true,verification_policy:'strict',outcome:'active'}),{retainWrittenFindings:()=>assert.fail('not invoked')}));
 await assert.rejects(submitWorkReportForReview(assignment,proposal,async()=>({ok:true,verification_policy:'strict',outcome:'active'})),/owner_retention/);
});
test('host control refusal is retained, never retried or converted to completion',async()=>{
 let calls=0;await assert.rejects(submitWorkReportForReview(assignment,proposal,async()=>{calls++;return {ok:true,verification_policy:'strict',outcome:'active'};},
  {retainWrittenFindings:()=>{throw Error('assignment_execution_paused');}}),/paused/);assert.equal(calls,1);
});

test('a settled missing-outcome failure preserves current read findings as a draft',()=>{
 const start={...snapshot(),spec:{requested_effect:'read'},operations:{}};
 const report=retainOwnerWrittenFindings(binding,'EA-12 airflow is 275 CFM in the upload.',start);
 const after={...terminal(structuredClone(start)),outcome:'failed',terminal_reason:'assignment_runtime_failed',
  execution_failure_ids:['provider-stop'],execution_failures:{'provider-stop':{binding,code:'assignment_runtime_failed',
   phase:'provider_turn',error_class:'runtime'}},
  operations:{inspection:{requested_effect:'read',persistent_effect:'none'}}};
 const error='task_outcome_required: No canonical outcome or question was retained.';
 const original=JSON.stringify(after);
 const fallback=ownerWrittenFindingsMessage(report,binding,after,error);
 assert.match(fallback,/^Unverified draft findings from this run/);
 assert.match(fallback,/EA-12 airflow is 275 CFM/);
 assert.equal(JSON.stringify(after),original);
 assert.equal(ownerWrittenFindingsMessage(report,binding,after,'unrelated failure'),'');
 assert.equal(ownerWrittenFindingsMessage(structuredClone(report),binding,after,error),'');
 for(const change of [
  s=>s.spec.requested_effect='apply',
  s=>s.operations.edit={requested_effect:'apply',persistent_effect:'applied'},
  s=>s.unresolved_unknown_operation_ids=['unknown'],
  s=>s.provider_usage_hold={reason:'pending'},
  s=>s.pending_review_ids=['review'],
  s=>s.execution_control.state='paused',
  s=>s.input_invalidated_operation_ids=['inspection'],
  s=>s.execution_failures['provider-stop'].binding.generation=2,
  s=>s.execution_failure_ids.push('other'),
  s=>s.result_delivery={items:[{}]},
 ]) { const invalid=structuredClone(after);change(invalid);assert.equal(ownerWrittenFindingsMessage(report,binding,invalid,error),''); }
});
