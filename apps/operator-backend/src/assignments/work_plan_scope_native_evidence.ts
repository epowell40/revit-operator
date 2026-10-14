import type { AssignmentSnapshotV2 } from '../domain/assignment-kernel/snapshot.js';
import type { WorkPlanScopeRequestV1 } from '../domain/assignment-kernel/work_plan_scope.js';
import { sameAssignmentBindingV2 } from '../domain/assignment-kernel/identity.js';
import { payloadDigestV2 } from '@revitoperator/payload-digest-v2';
import { readEvidenceRef, readAuthoritativeEvidence } from '../evidence/evidence_store.js';

/** Shared retained-byte boundary for checking and host readback planning. */
export function readCurrentNativeScopeEvidenceV1(snapshot:AssignmentSnapshotV2,request:WorkPlanScopeRequestV1) {
    if(snapshot.unresolved_unknown_operation_ids.length||snapshot.in_flight_operation_ids.length)throw Error('scope_check_unsettled');
    const editTimes=Object.values(snapshot.operations).filter(op=>op.requested_effect==='apply'&&op.persistent_effect!=='none')
      .map(op=>Date.parse(op.result?.completed_at??op.opened_at));
    if(editTimes.some(t=>!Number.isFinite(t)))throw Error('scope_check_edit_time_invalid');
    const lastEdit=Math.max(0,...editTimes);
    const readTimes:number[]=[];
    const requestedAt=Date.parse(request.requested_at);
    if(!Number.isFinite(requestedAt))throw Error('scope_check_request_time_invalid');
    if(!request.operation_ids.length)throw Error('scope_check_no_current_native_reads');
    const reads=request.operation_ids.map(id=>{
      const op=snapshot.operations[id],r=op?.result;
      const openedAt=Date.parse(op?.opened_at??''),completedAt=Date.parse(r?.completed_at??'');
      if(!op||op.requested_effect!=='read'||op.persistent_effect!=='none'||op.settlement_state!=='settled'
        ||op.dispatch_state!=='dispatched'||r?.authority!=='native-host'||r.status!=='succeeded'||r.dispatch_state!=='dispatched'
        ||snapshot.input_invalidated_operation_ids?.includes(id)||!sameAssignmentBindingV2(op.binding,snapshot.current_binding)
        ||!sameAssignmentBindingV2(r.binding,snapshot.current_binding)||!Number.isFinite(openedAt)||!Number.isFinite(completedAt)
        ||openedAt<=lastEdit||completedAt<openedAt||completedAt>requestedAt)throw Error('scope_check_current_native_reads_required');
      readTimes.push(completedAt);
      for(const oid of op.observation_ids) {
        const o=snapshot.observations[oid];
        if(!o||o.operation_id!==id||o.authority!=='native-host'||o.raw_payload_hash!==r.raw_payload_hash
          ||!sameAssignmentBindingV2(o.binding,snapshot.current_binding))continue;
        const ref=readEvidenceRef(o.raw_payload_ref.replace(/^evidence:/,''));
        if(ref.byte_count>8_000_000)continue;
        const payload=JSON.parse(readAuthoritativeEvidence(ref,{...snapshot.current_binding,attempt_id:id}).toString('utf8'));
        if(payloadDigestV2(payload).digest!==o.raw_payload_hash)continue;
        return {operation_id:id,input:op.input,payload};
      }
      throw Error('scope_check_native_payload_required');
    });
    return {reads,readTimes};
}
