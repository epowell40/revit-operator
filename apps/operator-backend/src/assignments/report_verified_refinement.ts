import type {AssignmentSnapshotV2} from '../domain/assignment-kernel/snapshot.js';
import {sameAssignmentBindingV2} from '../domain/assignment-kernel/identity.js';
import {checkedEditIsCurrentV2,checkedReadIsCurrentV2} from '../verification/current_postcondition_v2.js';
import {nativeProgramEffectStateV2} from '../verification/native_program_effect_postcondition_v2.js';

/** Presentation only: an earlier checked result can be deliberately refined by
 * a later, independently checked edit. Do not renew the old proof, alter task
 * outcome, or infer preservation from a provider's prose/returned ID list. */
export function reportHasVerifiedRefinement(snapshot:AssignmentSnapshotV2,id:string):boolean {
 if(snapshot.unresolved_unknown_operation_ids.length||snapshot.in_flight_operation_ids.length
   ||snapshot.execution_control?.state==='paused')return false;
 const subject=snapshot.operations[id];if(!subject)return false;
 const original=nativeProgramEffectStateV2(snapshot,subject);if(!original?.scoped)return false;
 return subject.verification_operation_ids.some(readId=>{
  const read=snapshot.operations[readId],at=Date.parse(read?.result?.completed_at??'');
  if(!read||read.verification_of_operation_id!==id||!Number.isFinite(at))return false;
  const later=Object.values(snapshot.operations).filter(op=>op.operation_id!==id&&op.requested_effect==='apply'
   &&op.persistent_effect==='applied'&&sameAssignmentBindingV2(op.binding,snapshot.current_binding)
   &&(Date.parse(op.result?.completed_at??'')>at
    ||(Date.parse(op.result?.completed_at??'')===at&&Number.isSafeInteger(op.settled_assignment_version)
      &&Number.isSafeInteger(read?.settled_assignment_version)&&op.settled_assignment_version!>read!.settled_assignment_version!)));
  if(!later.length)return false;
  const laterIds=new Set(later.map(op=>op.operation_id));
  // Check the actual earlier receipt at its retained point in history. This
  // temporary projection is never published or written back to the snapshot.
  const before={...snapshot,operations:Object.fromEntries(Object.entries(snapshot.operations).filter(([key])=>!laterIds.has(key)))};
  if(!checkedReadIsCurrentV2(before,readId))return false;
  let refined=false;
  for(const op of later){
   const next=nativeProgramEffectStateV2(snapshot,op);if(!next?.scoped)return false;
   const overlap=original.targets.filter(target=>next.footprint.includes(target));
   if(!overlap.length)continue;
   if(!overlap.every(target=>next.targets.includes(target))||!checkedEditIsCurrentV2(snapshot,op.operation_id))return false;
   refined=true;
  }
  return refined;
 });
}
