import test from 'node:test';import assert from 'node:assert/strict';
import {committedReadRefreshV2} from '../src/domain/assignment-kernel/committed_read_refresh.js';
import {nativeCommittedReadRefreshV2} from '../src/assignments/native_committed_read_refresh_v2.js';
const binding={assignment_id:'assignment',run_id:'run',generation:1,session_id:'session',principal_id:'owner',document_fingerprint:'project'};
function fixture(){
 const op=(id:string,effect='read',version=1):any=>({operation_id:id,binding:{...binding},requested_effect:effect,purpose:effect==='read'?'discovery':'work',
  capability_id:'revit_call_tool',fulfillment_role:effect==='read'?'supporting_control':'delegated_task_execution',operation_role:'root',
  target:{document_fingerprint:'project',target_id:'id:7'},input:{method:'POST',path:effect==='read'?'/revit/get-element-summary':'/revit/change-element-type',body:{elementIds:[7]}},
  request_identity:{method:'POST',path:effect==='read'?'/revit/get-element-summary':'/revit/change-element-type',request_signature:effect==='read'?'read-signature':'edit-signature'},
  advances_criterion_ids:[],eligible_criterion_ids:[],resolves_gap_ids:['work-plan:scope'],admission_state:'admitted',dispatch_authority:'native',dispatch_state:'dispatched',
  settlement_state:'settled',persistent_effect:effect==='read'?'none':'applied',admitted_assignment_version:version,settled_assignment_version:version+2,observation_ids:['observation-'+id]});
 const prior=op('prior'),edit=op('edit','apply',4);
 for(const p of [prior,edit])p.result={operation_id:p.operation_id,binding:{...binding},authority:'native-host',status:'succeeded',dispatch_state:'dispatched',
  persistent_effect:p.persistent_effect,native_transaction_state:p.requested_effect==='read'?'not_applicable':'committed',receipt_id:'receipt-'+p.operation_id,native_correlation_id:'native-'+p.operation_id,
  raw_payload_hash:'a'.repeat(64),result_schema_id:`operator-native/POST:${p.input.path}/v2`,request_identity:{...p.request_identity},affected_target_identities:p.requested_effect==='read'?[]:['element_id:7']};
 const candidate={...op('refresh'),dispatch_state:'not_dispatched',settlement_state:'open',persistent_effect:'none',observation_ids:[],admitted_assignment_version:undefined,settled_assignment_version:undefined};
 const observations=Object.fromEntries([prior,edit].map(p=>[p.observation_ids[0],{operation_id:p.operation_id,authority:'native-host',binding:{...binding},raw_payload_hash:p.result.raw_payload_hash,result_schema_id:p.result.result_schema_id,raw_payload_ref:'evidence:'+p.operation_id}]));
 const snapshot:any={assignment_version:7,current_binding:{...binding},outcome:'active',terminal:false,operations:{prior,edit},observations,unresolved_unknown_operation_ids:[],in_flight_operation_ids:[]};
 return {snapshot,candidate,prior,edit};
}
test('one native target commit permits fresh inspection, not another edit or completion',()=>{
 const f=fixture(),before=JSON.stringify(f);assert.deepEqual(committedReadRefreshV2(f.snapshot,f.candidate),{retry_of_operation_id:'prior',retry_basis:'committed_target_read',retry_after_operation_id:'edit'});
 assert.equal(JSON.stringify(f),before);assert.deepEqual(committedReadRefreshV2(JSON.parse(JSON.stringify(f.snapshot)),f.candidate),committedReadRefreshV2(f.snapshot,f.candidate));
});
const negatives:Record<string,(f:ReturnType<typeof fixture>)=>void>={
 apply:f=>f.candidate.requested_effect='apply',terminal:f=>f.snapshot.terminal=true,proposal:f=>f.snapshot.completion_proposal={},paused:f=>f.snapshot.execution_control={state:'paused'},
 unknown:f=>f.snapshot.unresolved_unknown_operation_ids=['unknown'],inflight:f=>f.snapshot.in_flight_operation_ids=['edit'],
 foreign_owner:f=>f.edit.binding.principal_id='foreign',foreign_read:f=>f.prior.binding.session_id='foreign',foreign_document:f=>f.edit.target.document_fingerprint='other',
 foreign_result:f=>f.edit.result.binding.generation=2,non_native:f=>f.edit.result.authority='dynamic-runtime',wrong_schema:f=>f.edit.result.result_schema_id='operator-capability/edit/v2',
 unknown_commit:f=>f.edit.persistent_effect='unknown',rollback:f=>f.edit.result.native_transaction_state='rolled_back',failed_commit:f=>f.edit.result.status='failed_after_dispatch',
 missing_observation:f=>f.edit.observation_ids=[],bad_hash:f=>f.edit.result.raw_payload_hash='bad',no_receipt:f=>f.edit.result.receipt_id='',
 missing_observation_record:f=>delete f.snapshot.observations['observation-edit'],foreign_observation:f=>f.snapshot.observations['observation-edit'].binding.principal_id='other',
 mismatched_observation:f=>f.snapshot.observations['observation-edit'].raw_payload_hash='b'.repeat(64),
 result_signature:f=>f.edit.result.request_identity.request_signature='foreign',retention_error:f=>f.edit.observation_retention_error='missing',
 unrelated_target:f=>f.edit.result.affected_target_identities=['element_id:8'],incidental_target:f=>f.edit.target.target_id='id:8',names_only:f=>f.candidate.target.target_id='name:tag',
 no_later_change:f=>f.edit.admitted_assignment_version=2,unsettled:f=>f.edit.settlement_state='open',future_version:f=>f.edit.settled_assignment_version=10,
 failed_prior:f=>f.prior.result.status='failed_after_dispatch',applied_prior:f=>f.prior.persistent_effect='applied',schema_prior:f=>f.prior.result.input_schema_gap={},
 prior_invalidated:f=>f.snapshot.input_invalidated_operation_ids=['prior'],commit_invalidated:f=>f.snapshot.input_invalidated_operation_ids=['edit'],
 used_basis:f=>f.snapshot.operations.used={...f.candidate,operation_id:'used',retry_of_operation_id:'prior',retry_after_operation_id:'edit'},
 changed_request:f=>f.candidate.input.body.elementIds=[8]
 ,missing_request_identity:f=>delete f.candidate.request_identity
 ,missing_request_signature:f=>f.candidate.request_identity.request_signature=''
};
for(const[name,change]of Object.entries(negatives))test('refresh rejects '+name,()=>{const f=fixture();change(f);assert.equal(committedReadRefreshV2(f.snapshot,f.candidate),null);});

function opaqueNativeHistory() {
 const f=fixture();
 // The kernel must reason about retained native authority, not HTTP routes.
 for(const op of [f.prior,f.edit,f.candidate]) {
  const path=op.requested_effect==='read'?'opaque:inspect':'opaque:edit';
  op.input.path=path;op.request_identity.path=path;
  if(op.result) {
   op.result.request_identity.path=path;op.result.result_schema_id=`operator-native/POST:${path}/v2`;
   f.snapshot.observations[op.observation_ids[0]].result_schema_id=op.result.result_schema_id;
  }
 }
 return f;
}
test('kernel refresh depends on native evidence and exact identity, not an application route prefix',()=>{
 const f=opaqueNativeHistory();
 assert.deepEqual(committedReadRefreshV2(f.snapshot,f.candidate),{
  retry_of_operation_id:'prior',retry_basis:'committed_target_read',retry_after_operation_id:'edit'});
});
test('Revit application adapter retains its route restriction',()=>{
 const f=opaqueNativeHistory();assert.equal(nativeCommittedReadRefreshV2(f.snapshot,f.candidate),null);
 const ordinary=fixture();
 assert.deepEqual(nativeCommittedReadRefreshV2(ordinary.snapshot,ordinary.candidate),committedReadRefreshV2(ordinary.snapshot,ordinary.candidate));
 for(const path of [undefined,'','/other/inspect','/revitish/inspect']) {
  ordinary.candidate.request_identity.path=path as any;
  assert.equal(nativeCommittedReadRefreshV2(ordinary.snapshot,ordinary.candidate),null);
 }
});
for(const who of ['prior','edit'] as const)test(`opaque route cannot substitute for ${who} native authority`,()=>{
 const f=opaqueNativeHistory();f[who].dispatch_authority='backend';
 assert.equal(committedReadRefreshV2(f.snapshot,f.candidate),null);
});
test('opaque route refresh still requires the same request as the retained native read',()=>{
 const f=opaqueNativeHistory();f.candidate.input.path='opaque:different';f.candidate.request_identity.path='opaque:different';
 assert.equal(committedReadRefreshV2(f.snapshot,f.candidate),null);
});
