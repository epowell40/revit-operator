import {nativeSourceInventoryRequestV1,nativeSourceInventoryWorkloadV1} from '@revitoperator/assignment-kernel-v2-contracts';
import {canonicalJsonV2,utf8TextSha256V2} from './canonical.js';
import {sameAssignmentBindingV2} from './identity.js';
import type {OperationV2} from './operation.js';
import type {AssignmentSnapshotV2} from './snapshot.js';
import {validNativeScopePlanningPolicyV1} from './execution_policy.js';

export interface NativeInventoryWorkloadV1 {
 schema:'revit-operator.native-inventory-workload/v1';operation_id:string;result_id:string;raw_payload_hash:string;
 receipt_id:string;native_correlation_id:string;request_signature:string;
 inventory_kind:'regular'|'panel'|'all'|'power_circuits';item_count:number;
}
/** Derive only from the retained native result before raw bytes leave the hot snapshot. */
export function deriveNativeInventoryWorkloadV1(op:OperationV2):NativeInventoryWorkloadV1|undefined {
 const r=op.result,c=op.observation_commit,q=op.request_identity;
 if(op.requested_effect!=='read'||op.dispatch_authority!=='native'||op.persistent_effect!=='none'
   ||!op.binding.document_fingerprint||op.target.document_fingerprint!==op.binding.document_fingerprint
   ||!r||r.authority!=='native-host'||r.status!=='succeeded'||r.dispatch_state!=='dispatched'
   ||r.persistent_effect!=='none'||r.native_transaction_state!=='not_applicable'||!r.observation_required
   ||!r.receipt_id||!r.native_correlation_id||!r.raw_payload_hash||r.input_schema_gap||r.result_semantic_gap
   ||r.operation_id!==op.operation_id||!sameAssignmentBindingV2(op.binding,r.binding)||!q||!r.request_identity
   ||r.result_schema_id!==`operator-native/POST:${q.path}/v2`||canonicalJsonV2(r.request_identity)!==canonicalJsonV2(q)
   ||!c||c.schema!=='revit-operator.observation-commit-input/v2'||c.result_id!==r.result_id
   ||utf8TextSha256V2(canonicalJsonV2(c.raw_payload))!==r.raw_payload_hash)return undefined;
 const decoded=nativeSourceInventoryWorkloadV1(op,c.raw_payload);if(!decoded)return undefined;
 return {schema:'revit-operator.native-inventory-workload/v1',operation_id:op.operation_id,result_id:r.result_id,
  raw_payload_hash:r.raw_payload_hash,receipt_id:r.receipt_id,native_correlation_id:r.native_correlation_id,
  request_signature:q.request_signature,...decoded};
}
/** Initial source size is a planning allocation, never checked edits or completion.
 * Repeated censuses use the largest complete cohort, not an additive credit. */
export function nativeInventoryPlanningV1(s:AssignmentSnapshotV2):{units:number;items:number}|undefined {
 if(!s.current_binding.document_fingerprint||!validNativeScopePlanningPolicyV1(s.spec))return undefined;
 let count=0;
 for(const op of Object.values(s.operations)){
  const state=op.native_inventory_workload,r=op.result,q=op.request_identity,request=nativeSourceInventoryRequestV1(op);
  if(!state||!r||!q||!r.request_identity||!request||!r.receipt_id||!r.native_correlation_id||!r.raw_payload_hash||state.schema!=='revit-operator.native-inventory-workload/v1'
   ||state.operation_id!==op.operation_id||state.result_id!==r.result_id||state.raw_payload_hash!==r.raw_payload_hash
   ||state.receipt_id!==r.receipt_id||state.native_correlation_id!==r.native_correlation_id||state.request_signature!==q.request_signature
   ||state.inventory_kind!==request.kind||!Number.isSafeInteger(state.item_count)||state.item_count<1||state.item_count>request.max
   ||op.requested_effect!=='read'||op.dispatch_authority!=='native'||op.dispatch_state!=='dispatched'
   ||op.settlement_state!=='settled'||op.persistent_effect!=='none'||op.observation_retention_error
   ||!sameAssignmentBindingV2(op.binding,s.current_binding)||op.target.document_fingerprint!==s.current_binding.document_fingerprint
   ||r.authority!=='native-host'||r.status!=='succeeded'||r.dispatch_state!=='dispatched'||r.persistent_effect!=='none'
   ||r.operation_id!==op.operation_id||!r.observation_required||r.input_schema_gap||r.result_semantic_gap
   ||r.native_transaction_state!=='not_applicable'||!sameAssignmentBindingV2(r.binding,s.current_binding)
   ||r.result_schema_id!==`operator-native/POST:${q.path}/v2`||canonicalJsonV2(r.request_identity)!==canonicalJsonV2(q)
   ||!Number.isFinite(Date.parse(op.opened_at))||Date.parse(op.opened_at)<Date.parse(s.spec.created_at)
   ||!Number.isFinite(Date.parse(r.completed_at))||Date.parse(r.completed_at)<Date.parse(op.opened_at)
   ||!Number.isFinite(Date.parse(op.settled_at??''))||Date.parse(op.settled_at!)<Date.parse(r.completed_at)
   ||!Number.isSafeInteger(op.admitted_assignment_version)||!Number.isSafeInteger(op.settled_assignment_version)
   ||op.settled_assignment_version!<=op.admitted_assignment_version!||op.settled_assignment_version!>s.assignment_version
   ||!op.observation_ids.some(id=>{const o=s.observations[id];return o?.operation_id===op.operation_id&&o.authority==='native-host'
     &&sameAssignmentBindingV2(o.binding,s.current_binding)&&o.raw_payload_hash===r.raw_payload_hash;}))continue;
  if(op.operation_role==='child'){
   const parent=op.parent_operation_id?s.operations[op.parent_operation_id]:undefined;
   if(!parent||op.root_operation_id!==parent.operation_id||parent.settlement_state!=='settled'
    ||!sameAssignmentBindingV2(parent.binding,s.current_binding))continue;
  }else if(op.operation_role&&op.operation_role!=='root')continue;
  count=Math.max(count,state.item_count);
 }
 const policy=s.spec.execution_policy!.native_scope_planning!;
 return {units:Math.min(policy.max_units,Math.max(1,Math.ceil(count/policy.items_per_unit))),items:count};
}
