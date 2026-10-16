import { nativeScheduleFilterRequestV1, nativeScheduleFilterResultStateV1 } from '@revitoperator/assignment-kernel-v2-contracts';
import { canonicalJsonV2, utf8TextSha256V2 } from './canonical.js';
import { sameAssignmentBindingV2 } from './identity.js';
import type { OperationV2 } from './operation.js';
import type { AssignmentSnapshotV2 } from './snapshot.js';

export interface NativeScheduleFilterStateV1 { result_id:string;raw_payload_hash:string;schedule_id:number;state_hash:string }
/** Derived before the trusted raw payload leaves the hot snapshot. Journal
 * replay rederives this; an admission proposal cannot supply it. */
export function deriveNativeScheduleFilterStateV1(operation:OperationV2):NativeScheduleFilterStateV1|undefined {
  const request=nativeScheduleFilterRequestV1(operation),result=operation.result,commit=operation.observation_commit;
  if(!request || !operation.binding.document_fingerprint || operation.target.document_fingerprint!==operation.binding.document_fingerprint
    || operation.dispatch_authority!=='native' || !result || result.authority!=='native-host'
    || result.status!=='succeeded' || result.dispatch_state!=='dispatched' || result.persistent_effect!=='applied'
    || result.native_transaction_state!=='committed' || !result.receipt_id || !result.native_correlation_id
    || result.input_schema_gap || result.result_semantic_gap || result.operation_id!==operation.operation_id
    || !sameAssignmentBindingV2(operation.binding,result.binding)
    || result.result_schema_id!==`operator-native/POST:${operation.request_identity?.path}/v2`
    || canonicalJsonV2(result.request_identity)!==canonicalJsonV2(operation.request_identity)
    || !commit || commit.result_id!==result.result_id || utf8TextSha256V2(canonicalJsonV2(commit.raw_payload))!==result.raw_payload_hash
    || !result.affected_target_identities?.includes(`element_id:${request.schedule_id}`))return undefined;
  const state=nativeScheduleFilterResultStateV1(operation,commit.raw_payload);
  return state ? {result_id:result.result_id,raw_payload_hash:result.raw_payload_hash,schedule_id:state.schedule_id,state_hash:utf8TextSha256V2(state.state)}:undefined;
}
export type ScheduleFilterRestorationV1={filter_restoration_of_operation_id:string;filter_restoration_after_operation_id:string};
/** A new requested transition after a proven counter-state, not a replay of an
 * applied or uncertain write. Rederived while holding the assignment lock. */
export function scheduleFilterRestorationV1(snapshot:AssignmentSnapshotV2,operation:OperationV2):ScheduleFilterRestorationV1|null {
  const request=nativeScheduleFilterRequestV1(operation);
  if(!request || !operation.binding.document_fingerprint || !sameAssignmentBindingV2(snapshot.current_binding,operation.binding)
    || operation.target.document_fingerprint!==operation.binding.document_fingerprint || snapshot.unresolved_unknown_operation_ids.length
    || operation.retry_of_operation_id || operation.retry_basis || operation.retry_after_operation_id
    || operation.checkpoint_of_operation_id || operation.checkpoint_after_operation_id
    || operation.reassignment_of_operation_id || operation.reassignment_after_operation_id)return null;
  const operations=Object.values(snapshot.operations).filter(o=>o.operation_id!==operation.operation_id);
  if(operations.some(o=>o.requested_effect==='apply' && (o.settlement_state!=='settled'||o.persistent_effect==='unknown')))return null;
  const completeFootprint=(o:OperationV2)=>!!o.result?.raw_payload_hash&&o.observation_ids.some(id=>{
    const obs=snapshot.observations[id];return obs?.operation_id===o.operation_id&&obs.authority==='native-host'
      &&sameAssignmentBindingV2(operation.binding,obs.binding)&&sameAssignmentBindingV2(operation.binding,o.result!.binding)
      &&obs.raw_payload_hash===o.result!.raw_payload_hash
      &&obs.facts.some(f=>f.fact_id==='control.native_change_inventory_complete'&&f.fact_class==='control'&&f.value===true);
  });
  const valid=(o:OperationV2)=>{
    const state=o.native_schedule_filter_state,result=o.result,decoded=nativeScheduleFilterRequestV1(o);
    return !!state&&!!result&&decoded?.schedule_id===request.schedule_id && state.schedule_id===request.schedule_id
      && state.state_hash===utf8TextSha256V2(decoded.state) && state.result_id===result.result_id && state.raw_payload_hash===result.raw_payload_hash
      && sameAssignmentBindingV2(operation.binding,o.binding) && sameAssignmentBindingV2(operation.binding,result.binding)
      && o.target.document_fingerprint===operation.binding.document_fingerprint && o.settlement_state==='settled'
      && o.persistent_effect==='applied' && o.dispatch_authority==='native' && !o.observation_retention_error
      && result.status==='succeeded' && result.authority==='native-host' && result.dispatch_state==='dispatched'
      && result.persistent_effect==='applied' && result.native_transaction_state==='committed'
      && !!result.receipt_id && !!result.native_correlation_id && !result.input_schema_gap && !result.result_semantic_gap
      && result.affected_target_identities?.includes(`element_id:${request.schedule_id}`)&&completeFootprint(o)
      && o.observation_ids.some(id=>{const obs=snapshot.observations[id];return obs?.operation_id===o.operation_id&&obs.authority==='native-host'
        && sameAssignmentBindingV2(operation.binding,obs.binding)&&obs.raw_payload_hash===state.raw_payload_hash;})
      && Number.isSafeInteger(o.admitted_assignment_version)&&o.admitted_assignment_version!>0
      && Number.isSafeInteger(o.settled_assignment_version)&&o.settled_assignment_version!>o.admitted_assignment_version!
      && o.settled_assignment_version!<=snapshot.assignment_version;
  };
  const repeats=operations.filter(o=>o.requested_effect==='apply'&&o.request_identity?.method===operation.request_identity?.method
    && o.request_identity?.path===operation.request_identity?.path&&o.request_identity?.request_signature===operation.request_identity?.request_signature);
  if(!repeats.length || repeats.some(o=>!valid(o)||canonicalJsonV2(o.input)!==canonicalJsonV2(operation.input)
    ||canonicalJsonV2(o.target)!==canonicalJsonV2(operation.target)))return null;
  const prior=repeats.sort((a,b)=>b.settled_assignment_version!-a.settled_assignment_version!)[0]!;
  const counter=operations.filter(o=>valid(o)&&o.admitted_assignment_version!>prior.settled_assignment_version!
    && o.native_schedule_filter_state!.state_hash!==prior.native_schedule_filter_state!.state_hash)
    .sort((a,b)=>b.settled_assignment_version!-a.settled_assignment_version!)[0];
  if(!counter || operations.some(o=>o.filter_restoration_after_operation_id===counter.operation_id))return null;
  // Unknown footprints cannot establish that the counter-state is still current.
  if(operations.some(o=>o.operation_id!==counter.operation_id&&o.requested_effect==='apply'&&o.persistent_effect!=='none'
    &&(!Number.isSafeInteger(o.settled_assignment_version)||o.settled_assignment_version!>counter.settled_assignment_version!)
    &&(!completeFootprint(o)||!o.result?.affected_target_identities?.length
      ||o.result.affected_target_identities.some(id=>id===`element_id:${request.schedule_id}`||id===`id:${request.schedule_id}`))))return null;
  return {filter_restoration_of_operation_id:prior.operation_id,filter_restoration_after_operation_id:counter.operation_id};
}
