import assert from 'node:assert/strict';
import test from 'node:test';
import type {AssignmentSnapshotV2} from '../src/domain/assignment-kernel/index.js';
import {checkedEditIsCurrentV2} from '../src/verification/current_postcondition_v2.js';
import {visibilityCheckNeedsRefreshV2,operationNeedsReadbackV2} from '../src/verification/regular_schedule_recheck_v2.js';
import {committedVisibilityReadbackPlanV2} from '../src/verification/committed_visibility_readback_plan_v2.js';

// Minimal retained native history: phase was checked, then another committed
// property of the same view changed. No mutation is needed to refresh proof.
function fixture(): AssignmentSnapshotV2 {
 const binding={assignment_id:'refresh-plan',run_id:'run',generation:1,session_id:'session',principal_id:'local:test',document_fingerprint:'model'};
 const request={path:'/revit/visibility',request_signature:'phase-request'};
 const apply={operation_id:'phase',binding,requested_effect:'apply',purpose:'work',persistent_effect:'applied',settlement_state:'settled',
  admission_state:'admitted',dispatch_state:'dispatched',input:{method:'POST',path:request.path,body:{action:'set_phase',viewId:42,phaseId:21} as Record<string,unknown>},
  request_identity:request,target:{target_id:'id:42'},verification_operation_ids:['read'],observation_ids:[],
  opened_at:'2026-10-16T12:00:00Z',settled_assignment_version:2,
  result:{operation_id:'phase',status:'succeeded',binding,authority:'native-host',native_transaction_state:'committed',persistent_effect:'applied',
   request_identity:request,completed_at:'2026-10-16T12:00:01Z',affected_target_identities:['element_id:42']}};
 const read={operation_id:'read',binding,requested_effect:'read',purpose:'verification',persistent_effect:'none',settlement_state:'settled',
  verification_of_operation_id:'phase',verification_operation_ids:[],observation_ids:['observation'],input:{},request_identity:{path:request.path},
  target:{target_id:'id:42'},opened_at:'2026-10-16T12:00:02Z',settled_assignment_version:3,
  result:{status:'succeeded',binding,authority:'native-host',raw_payload_hash:'native-read-hash',completed_at:'2026-10-16T12:00:02Z'}};
 const later=structuredClone(apply);
 later.operation_id='filter';later.verification_operation_ids=[];later.opened_at='2026-10-16T12:00:03Z';later.settled_assignment_version=4;
 later.input.body={action:'set_phase_filter',viewId:42,phaseFilterId:51};
 later.result={...later.result,operation_id:'filter',completed_at:'2026-10-16T12:00:04Z'};
 return {current_binding:binding,operations:{phase:apply,read,filter:later},observations:{observation:{operation_id:'read',binding,authority:'native-host',
   raw_payload_hash:'native-read-hash',facts:[{fact_id:'verification.postcondition_satisfied',fact_class:'verification',value:true}]}},
  unresolved_unknown_operation_ids:[],in_flight_operation_ids:[],input_invalidated_operation_ids:[],terminal:false,quiescent:true,outcome:'active'
 } as unknown as AssignmentSnapshotV2;
}
const plan=(s:AssignmentSnapshotV2)=>committedVisibilityReadbackPlanV2(s,s.operations.phase!);
test('stale checked phase gets an ordinary getter, preserving native history and requesting no apply',()=>{
 const s=fixture(),before=structuredClone(s);
 assert.equal(checkedEditIsCurrentV2(s,'phase'),false);
 assert.equal(visibilityCheckNeedsRefreshV2(s,s.operations.phase!),true);
 assert.equal(operationNeedsReadbackV2(s,s.operations.phase!),true);
 assert.deepEqual(plan(s),{method:'POST',path:'/revit/visibility',body:{action:'get',viewId:42}});
 assert.deepEqual(s,before);
});

// Faults deliberately mutate a private fixture, not a production snapshot.
const cases:Record<string,(s:any)=>void>={
 'already current':s=>{delete s.operations.filter;},
 'same property superseded':s=>{s.operations.filter.input.body={action:'set_phase',viewId:42,phaseId:22};},
 'unsupported later edit':s=>{s.operations.filter.input.body={action:'unknown',viewId:42};},
 'invalidated original input':s=>{s.input_invalidated_operation_ids=['phase'];},
 'invalidated later input':s=>{s.input_invalidated_operation_ids=['filter'];},
 'paused':s=>{s.execution_control={state:'paused'};},
 'terminal':s=>{s.terminal=true;},
 'review proposed':s=>{s.completion_proposal={};},
 'nonactive outcome':s=>{s.outcome='complete';},
 'unknown effect':s=>{s.unresolved_unknown_operation_ids=['other'];},
 'in-flight work':s=>{s.in_flight_operation_ids=['other'];},
 'foreign binding':s=>{s.operations.phase.binding={...s.current_binding,run_id:'foreign'};},
 'missing retained native proof':s=>{s.observations.observation.facts=[];},
 'unsettled later write':s=>{s.operations.filter.settlement_state='pending';},
 'unknown later write':s=>{s.operations.filter.persistent_effect='unknown';}
};
for(const[name,mutate]of Object.entries(cases))test(`refresh cannot revive work when ${name}`,()=>{
 const s=fixture();mutate(s);assert.equal(visibilityCheckNeedsRefreshV2(s,s.operations.phase!),false);assert.equal(plan(s),null);
});

const commitFaults:Record<string,(s:any)=>void>={
 'preview':s=>{s.operations.phase.input.body.dryRun=true;},
 'not admitted':s=>{s.operations.phase.admission_state='rejected';},
 'not dispatched':s=>{s.operations.phase.dispatch_state='not_started';},
 'non-native commit':s=>{s.operations.phase.result.authority='provider';},
 'not committed':s=>{s.operations.phase.result.native_transaction_state='rolled_back';},
 'wrong native owner':s=>{s.operations.phase.result.operation_id='other';},
 'wrong commit binding':s=>{s.operations.phase.result.binding={...s.current_binding,generation:2};},
 'different request signature':s=>{s.operations.phase.result.request_identity={request_signature:'different'};},
 'missing commit timestamp':s=>{s.operations.phase.result.completed_at='';},
 'different affected target':s=>{s.operations.phase.result.affected_target_identities=['element_id:99'];}
};
for(const[name,mutate]of Object.entries(commitFaults))test(`strict refresh planner rejects ${name} without changing proof records`,()=>{
 const s=fixture();mutate(s);const before=structuredClone(s);assert.equal(plan(s),null);assert.deepEqual(s,before);
});
