import assert from 'node:assert/strict';
import test from 'node:test';
import type { AssignmentSnapshotV2 } from '../src/domain/assignment-kernel/index.js';
import { checkedEditIsCurrentV2 } from '../src/verification/current_postcondition_v2.js';
import { packetOperationVerificationV2,packetOverallTrustV2 } from '../src/work_packets/assignment_kernel_v2_verification.js';
import {generateVerifiedWorkPacketFromKernelV2}from '../src/work_packets/assignment_kernel_v2_generator.js';
import type {GoalRecord}from '../src/goals/service.js';

// Fault injection deliberately mutates proof records; production snapshots stay readonly.
type MutableProofFixture=Omit<AssignmentSnapshotV2,'operations'|'observations'> & {operations:Record<string,any>;observations:Record<string,any>};
function fixture():MutableProofFixture {
 const binding={assignment_id:'packet-freshness',run_id:'run',generation:1,session_id:'session',principal_id:'local:test',document_fingerprint:'model'};
 const op:any={operation_id:'apply',binding,requested_effect:'apply',purpose:'work',persistent_effect:'applied',settlement_state:'settled',
  input:{method:'POST',path:'/revit/visibility',body:{action:'set_phase',viewId:42,phaseId:21}},request_identity:{path:'/revit/visibility'},
  target:{target_id:'id:42'},verification_operation_ids:['read'],observation_ids:[],opened_at:'2026-10-16T12:00:00Z',settled_assignment_version:2,
  result:{completed_at:'2026-10-16T12:00:01Z',affected_target_identities:['element_id:42']}};
 const read:any={operation_id:'read',binding,requested_effect:'read',purpose:'verification',persistent_effect:'none',settlement_state:'settled',
  verification_of_operation_id:'apply',verification_operation_ids:[],observation_ids:['observation'],input:{},request_identity:{path:'/revit/visibility'},target:{target_id:'id:42'},opened_at:'2026-10-16T12:00:02Z',
  settled_assignment_version:3,result:{status:'succeeded',binding,authority:'native-host',raw_payload_hash:'sha256:native-read',completed_at:'2026-10-16T12:00:02Z'}};
 return {current_binding:binding,operations:{apply:op,read},observations:{observation:{operation_id:'read',binding,authority:'native-host',
  raw_payload_hash:'sha256:native-read',facts:[{fact_id:'verification.postcondition_satisfied',fact_class:'verification',value:true}]}},
  unresolved_unknown_operation_ids:[],in_flight_operation_ids:[],input_invalidated_operation_ids:[],terminal:true,quiescent:true,outcome:'complete',
  execution_failure_ids:[],execution_failures:{},pending_input_variable_ids:[],pending_review_ids:[],clarifications:{},provider_call_ids:[],provider_calls:{},
  finished_at:'2026-10-16T12:00:10Z',spec:{created_at:'2026-10-16T12:00:00Z',source_user_request:'Change the schedule phase.',requested_effect:'apply',
   criteria:[{criterion_id:'requested-state',requirement:'Requested phase is retained.',semantic_fact_requirements:[]}]},criteria:{'requested-state':{status:'pass',supporting_facts:[]}}} as unknown as MutableProofFixture;
}
const action=(s:AssignmentSnapshotV2,id='apply')=>packetOperationVerificationV2(s,s.operations[id]!);
const packet=(s:AssignmentSnapshotV2)=>generateVerifiedWorkPacketFromKernelV2({id:s.current_binding.assignment_id,non_goals:[],updated_at:s.finished_at}as unknown as GoalRecord,s,null);
test('current native proof is passed in both packet rows and overall trust',()=>{
 const s=fixture();assert(checkedEditIsCurrentV2(s,'apply'));assert.equal(action(s).state,'passed');assert.equal(action(s,'read').state,'passed');
 assert.equal(packetOverallTrustV2(s),'independently_verified');
 assert.equal(packet(s).status,'verified_complete');
});
function later(s:MutableProofFixture,options:Record<string,unknown>={}){
 s.operations.later={...structuredClone(s.operations.apply!),operation_id:'later',verification_operation_ids:[],
  opened_at:'2026-10-16T12:00:03Z',settled_assignment_version:4,result:{...s.operations.apply!.result!,completed_at:'2026-10-16T12:00:04Z'},...options} as any;
}
const negatives:Record<string,(s:MutableProofFixture)=>void>={
 'changed authenticated input':s=>{s.input_invalidated_operation_ids=['apply'];},
 'invalidated read':s=>{s.input_invalidated_operation_ids=['read'];},
 'foreign operation binding':s=>{s.operations.apply!.binding={...s.current_binding,run_id:'foreign'};},
 'foreign read binding':s=>{s.operations.read!.binding={...s.current_binding,generation:2};},
 'foreign native result binding':s=>{s.operations.read!.result!.binding={...s.current_binding,document_fingerprint:'other'};},
 'observation hash mismatch':s=>{s.observations.observation!.raw_payload_hash='sha256:other';},
 'non-native observation':s=>{s.observations.observation!.authority='provider' as any;},
 'missing retained proof fact':s=>{s.observations.observation!.facts=[];},
 'read before commit':s=>{s.operations.read!.result!.completed_at='2026-10-16T11:59:59Z';},
 'later overlapping edit':s=>later(s),
 'equal time with later retained order':s=>later(s,{result:{...s.operations.apply!.result!,completed_at:s.operations.read!.result!.completed_at}}),
 'overlapping unknown write opened earlier':s=>{later(s,{persistent_effect:'unknown',opened_at:'2026-10-16T11:00:00Z',result:undefined});s.unresolved_unknown_operation_ids=['later'];},
 'in-flight overlapping write opened earlier':s=>{later(s,{persistent_effect:'none',opened_at:'2026-10-16T11:00:00Z',result:undefined});s.in_flight_operation_ids=['later'];},
 'missing commit timestamp':s=>{s.operations.apply!.result!.completed_at='';}
};
for(const[name,mutate]of Object.entries(negatives))test(`packet never preserves a pass after ${name}`,()=>{
 const s=fixture();mutate(s);assert.equal(action(s).state,'inconclusive');assert.equal(action(s,'read').state,'inconclusive');
 assert.equal(packetOverallTrustV2(s),'uncertain_or_missing');
 const p=packet(s);assert.equal(p.status,'complete_with_issues');assert.match(p.status_reason,/current verification is incomplete/);
 assert(p.issues.some(i=>i.affected_attempt_ids.includes('apply')));assert.equal(s.outcome,'complete','projection cannot rewrite historical canonical outcome');
});
test('a later read can renew the parent without renewing the superseded read row',()=>{
 const s=fixture();later(s);const read=structuredClone(s.operations.read!);read.operation_id='fresh-read';read.observation_ids=['fresh-observation'];
 read.result={...read.result!,completed_at:'2026-10-16T12:00:05Z'};s.operations['fresh-read']=read;s.operations.apply!.verification_operation_ids.push('fresh-read');
 s.observations['fresh-observation']={...structuredClone(s.observations.observation!),operation_id:'fresh-read'};
 assert(checkedEditIsCurrentV2(s,'apply'));assert.equal(action(s).state,'passed');assert.equal(action(s,'read').state,'inconclusive');assert.equal(action(s,'fresh-read').state,'passed');
});
test('unrelated target edit does not stale this property check',()=>{
 const s=fixture();later(s,{target:{target_id:'id:99'},result:{...s.operations.apply!.result!,affected_target_identities:['element_id:99'],completed_at:'2026-10-16T12:00:04Z'}});
 assert(checkedEditIsCurrentV2(s,'apply'));assert.equal(action(s).state,'passed');assert.equal(action(s,'read').state,'passed');
});
test('equal timestamps preserve a check only when retained order puts the effect before the read',()=>{
 const s=fixture();later(s,{settled_assignment_version:2,result:{...s.operations.apply!.result!,completed_at:s.operations.read!.result!.completed_at}});
 assert(checkedEditIsCurrentV2(s,'apply'));assert.equal(action(s).state,'passed');
});
