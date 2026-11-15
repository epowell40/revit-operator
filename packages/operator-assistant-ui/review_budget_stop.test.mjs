import test from 'node:test';
import assert from 'node:assert/strict';
import * as closeout from './reviewed_inspection_closeout.mjs';
const binding={assignment_id:'ranch',session_id:'s',run_id:'r',generation:1};
const review={schema:'operator.visual_work_review.v1',authority:'supporting_visual_assessment',owner:binding,
 state:'unavailable',ok:false,native_postcondition_verified:false,whole_task_verified:false};
const snapshot={current_binding:binding,assignment_version:300,terminal:true,outcome:'blocked',quiescent:true,
 terminal_reason:'provider_call_budget_exhausted',in_flight_operation_ids:[],in_flight_provider_call_ids:[],unresolved_unknown_operation_ids:[]};
test('unavailable final reviewer stops at the existing canonical budget outcome without verification or another provider',async()=>{
 assert.equal(typeof closeout.reviewStoppedAssignment,'function');
 const result=await closeout.reviewStoppedAssignment({binding,review,readSnapshot:async()=>snapshot});
 assert.equal(result.state,'canonical_stopped');assert.equal(result.reason,'provider_call_budget_exhausted');
 assert.equal(result.native_postcondition_verified,false);assert.equal(result.whole_task_verified,false);
 assert.equal(closeout.reviewedInspectionHasTerminalResult(result),true);
});
test('review text, stale owners, active work, unknown effects and failed reads cannot establish a terminal result',async()=>{
 assert.equal(typeof closeout.reviewStoppedAssignment,'function');
 for(const patch of [{current_binding:{...binding,generation:2}},{terminal:false},{outcome:'active'},{quiescent:false},
  {in_flight_operation_ids:['write']},{in_flight_provider_call_ids:['call']},{unresolved_unknown_operation_ids:['unknown']},{assignment_version:0}]){
  assert.equal(await closeout.reviewStoppedAssignment({binding,review,readSnapshot:async()=>({...snapshot,...patch})}),null);
 }
 assert.equal(await closeout.reviewStoppedAssignment({binding,review:{...review,owner:{...binding,run_id:'foreign'}},readSnapshot:async()=>snapshot}),null);
 assert.equal(await closeout.reviewStoppedAssignment({binding,review,readSnapshot:async()=>{throw Error('lost')}}),null);
});
