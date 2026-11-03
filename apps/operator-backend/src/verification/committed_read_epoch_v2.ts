import {sameAssignmentBindingV2,type AssignmentSnapshotV2} from '../domain/assignment-kernel/index.js';

/** Retained write ordering is a read-cohort boundary, never a renewed proof. */
export function committedReadEpochV2(s:AssignmentSnapshotV2){
 if(s.unresolved_unknown_operation_ids.length||Object.values(s.operations).some(op=>op.requested_effect==='apply'&&op.dispatch_state==='dispatched'&&op.settlement_state!=='settled'))return null;
 const writes=Object.values(s.operations).filter(op=>op.requested_effect==='apply'&&op.persistent_effect==='applied'&&sameAssignmentBindingV2(op.binding,s.current_binding));
 if(!writes.length||writes.some(op=>op.settlement_state!=='settled'||!Number.isSafeInteger(op.settled_assignment_version)
  ||op.result?.authority!=='native-host'||op.result.status!=='succeeded'||op.result.operation_id!==op.operation_id||!sameAssignmentBindingV2(op.result.binding,op.binding)
  ||!Number.isFinite(Date.parse(op.result.completed_at))))return null;
 writes.sort((a,b)=>b.settled_assignment_version!-a.settled_assignment_version!);
 const op=writes[0]!;return{operation_id:op.operation_id,settled_version:op.settled_assignment_version!,completed_at:op.result!.completed_at};
}
