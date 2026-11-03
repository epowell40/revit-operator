import {nativeDocumentCheckpointResultV2,isNativeDocumentCheckpointRequestV2} from '@revitoperator/assignment-kernel-v2-contracts';
import {sameAssignmentBindingV2} from './identity.js';
import {advisoryVerificationV2} from './execution_policy.js';
import {appliedOperationHasVerifiedPostconditionV2} from './outcome.js';
import {inspectionIsCurrentV2,workPlanItemDeferredV2} from './work_plan.js';
import {nativeCommitProgressIdentityV2,retainedNativeSuccess} from './progress/native_work_progress.js';
import type {OperationV2} from './operation.js';
import type {AssignmentSnapshotV2} from './snapshot.js';

function boundNativeResult(s:AssignmentSnapshotV2,o:OperationV2):boolean {
 const r=o.result,q=o.request_identity;
 return Boolean(r&&q&&retainedNativeSuccess(s,o)&&r.receipt_id&&r.native_correlation_id
  &&q.capability_id===o.capability_id&&q.method===o.input.method&&q.path===o.input.path
  &&/^[a-f0-9]{64}$/i.test(q.request_signature)
  &&r.request_identity?.capability_id===q.capability_id&&r.request_identity.method===q.method
  &&r.request_identity.path===q.path&&r.request_identity.request_signature===q.request_signature
  &&o.observation_ids.length&&o.observation_ids.every(id=>{
   const v=s.observations[id];
   return v?.authority==='native-host'&&v.operation_id===o.operation_id
    &&sameAssignmentBindingV2(v.binding,s.current_binding)&&v.capability_id===o.capability_id
    &&v.result_schema_id===r.result_schema_id&&Boolean(v.raw_payload_ref)
    &&/^[a-f0-9]{64}$/i.test(v.raw_payload_hash)&&v.raw_payload_hash===r.raw_payload_hash;
  }));
}

/** Eligibility for a PARTIAL criterion evaluation, never a full result fact,
 * completion of deferred scope, or a terminal outcome without evaluation.
 * The existing native inspection and criterion admissibility remain required. */
export function verifiedSavedPartialV2(s:AssignmentSnapshotV2):boolean {
 if(s.spec.requested_effect!=='apply'||s.spec.work_plan_required!==true||advisoryVerificationV2(s)
  ||!s.quiescent||s.execution_control?.state==='paused'||s.provider_usage_hold||s.provider_budget_exhausted||s.progress_blocker
  ||s.pending_input_variable_ids.length||s.pending_review_ids.length||s.in_flight_operation_ids.length||s.in_flight_provider_call_ids.length
  ||s.unresolved_unknown_operation_ids.length||s.execution_failure_ids.length||s.completion_proposal
  ||(s.spec.result_delivery_required&&!s.result_delivery))return false;
 const required=s.spec.criteria.filter(c=>c.required);
 if(required.length!==1||required[0]!.semantic_fact_requirements.length!==1||required[0]!.semantic_fact_requirements[0]!=='task.result_available')return false;
 const items=s.work_plan?.items;if(!items?.length)return false;
 const deferred=items.filter(workPlanItemDeferredV2),done=items.filter(i=>!workPlanItemDeferredV2(i));
 if(!deferred.length||deferred.some(i=>i.completed_at||i.kind==='inspection'||(i.kind!==undefined&&i.kind!=='edit')||i.operation_ids.length
  ||!i.deferrals?.at(-1)?.reason.trim()||!Number.isFinite(Date.parse(i.deferrals.at(-1)!.deferred_at))))return false;
 if(!done.length||done.some(i=>!i.completed_at||!i.operation_ids.length
  ||(i.kind!==undefined&&i.kind!=='edit'&&i.kind!=='inspection')))return false;
 const inspections=done.filter(i=>i.kind==='inspection'),edits=done.filter(i=>i.kind!=='inspection');
 if(!inspections.length||inspections.some(i=>!inspectionIsCurrentV2(s,i))||!edits.length)return false;
 const inspected=new Set(inspections.flatMap(i=>i.depends_on??[]));
 if(edits.some(i=>!inspected.has(i.item_id)))return false;
 const applied=Object.values(s.operations).filter(o=>o.requested_effect==='apply'&&o.persistent_effect==='applied');
 const represented=new Set(edits.flatMap(i=>i.operation_ids));
 if(applied.length<2||represented.size!==applied.length||applied.some(o=>!represented.has(o.operation_id)
  ||o.result?.authority!=='native-host'||o.result.status!=='succeeded'||o.settlement_state!=='settled'
  ||!sameAssignmentBindingV2(o.binding,s.current_binding)||!sameAssignmentBindingV2(o.result.binding,s.current_binding)
  ||!boundNativeResult(s,o)||nativeCommitProgressIdentityV2(s,o)===null
  ||s.input_invalidated_operation_ids?.includes(o.operation_id)||!appliedOperationHasVerifiedPostconditionV2(s,o.operation_id)))return false;
 // A later invalidation or foreign verification cannot inherit an earlier pass.
 const reads=new Set([...inspections.flatMap(i=>i.operation_ids),...applied.flatMap(o=>o.verification_operation_ids)]);
 if([...reads].some(id=>{const o=s.operations[id],r=o?.result;
  return !o||!r||!boundNativeResult(s,o)||s.input_invalidated_operation_ids?.includes(id)||r.authority!=='native-host'||r.status!=='succeeded'
   ||o.requested_effect!=='read'||o.persistent_effect!=='none'||r.persistent_effect!=='none'
   ||r.native_transaction_state!=='not_applicable'||o.settlement_state!=='settled'
   ||!sameAssignmentBindingV2(o.binding,s.current_binding)||!sameAssignmentBindingV2(r.binding,s.current_binding)
   ||!o.observation_ids.length||o.observation_ids.some(oid=>{const observed=s.observations[oid];return !observed||observed.operation_id!==id
    ||observed.authority!=='native-host'||!sameAssignmentBindingV2(observed.binding,s.current_binding)||observed.raw_payload_hash!==r.raw_payload_hash;});
 }))return false;
 const saved=applied.filter(o=>isNativeDocumentCheckpointRequestV2(o)&&nativeDocumentCheckpointResultV2(o.result))
  .sort((a,b)=>Date.parse(b.result!.completed_at)-Date.parse(a.result!.completed_at))[0];
 return Boolean(saved&&Number.isFinite(Date.parse(saved.result!.completed_at))
  &&applied.every(o=>Number.isFinite(Date.parse(o.result!.completed_at))&&Date.parse(o.result!.completed_at)<=Date.parse(saved.result!.completed_at))
  &&applied.some(o=>!isNativeDocumentCheckpointRequestV2(o)));
}
