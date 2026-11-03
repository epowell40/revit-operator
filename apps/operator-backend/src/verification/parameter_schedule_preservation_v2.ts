import {payloadDigestV2} from '@revitoperator/payload-digest-v2';
import {sameAssignmentBindingV2,type AssignmentSnapshotV2,type OperationV2} from '../domain/assignment-kernel/index.js';
import {readAuthoritativeEvidence,readEvidenceRef} from '../evidence/evidence_store.js';
import {preservedScheduleTargets,preservedScheduleReadMatchesV2} from './native_annotation_postcondition_v2.js';
import {postconditionSatisfiedByPayloadV2} from '../postcondition_verification_v2.js';
import {viewNameScheduleProjectionV2,viewNameScheduleReadMatchesV2} from './view_name_schedule_projection_v2.js';

const object=(v:unknown):Record<string,any>=>v&&typeof v==='object'&&!Array.isArray(v)?v as Record<string,any>:{};
const ids=(v:unknown,max=100):v is number[]=>Array.isArray(v)&&v.length<=max&&v.every(n=>Number.isSafeInteger(n)&&n>0)&&new Set(v).size===v.length;
const same=(a:number[],b:number[])=>a.length===b.length&&a.every(n=>b.includes(n));

function retainedBounded(snapshot:AssignmentSnapshotV2,op:OperationV2,requireNativeEvidenceTrust:boolean,maximumBytes:number) {
 const r=op?.result;
 if(!r||op.admission_state!=='admitted'||op.dispatch_state!=='dispatched'||op.settlement_state!=='settled'
  ||r.authority!=='native-host'||r.status!=='succeeded'||r.dispatch_state!=='dispatched'||r.operation_id!==op.operation_id
  ||r.persistent_effect!==op.persistent_effect||r.result_schema_id!==`operator-native/POST:${op.input.path}/v2`
  ||!r.receipt_id||!r.native_correlation_id||!r.raw_payload_hash||!op.request_identity?.request_signature
  ||r.request_identity?.request_signature!==op.request_identity.request_signature
  ||op.input.method!=='POST'||op.input.path!==op.request_identity.path||r.request_identity.path!==op.input.path
  ||r.request_identity.method!==op.input.method||!sameAssignmentBindingV2(op.binding,snapshot.current_binding)
  ||!sameAssignmentBindingV2(r.binding,op.binding)||snapshot.input_invalidated_operation_ids?.includes(op.operation_id))return null;
 for(const id of op.observation_ids){const o=snapshot.observations[id];
  if(o?.authority!=='native-host'||o.operation_id!==op.operation_id||o.raw_payload_hash!==r.raw_payload_hash||!sameAssignmentBindingV2(o.binding,op.binding))continue;
  try{const ref=readEvidenceRef(o.raw_payload_ref.replace(/^evidence:/,''));if(ref.byte_count>maximumBytes
    ||requireNativeEvidenceTrust&&ref.trust_level!=='authoritative_native')continue;
   const p=JSON.parse(readAuthoritativeEvidence(ref,{...op.binding,attempt_id:op.operation_id}).toString('utf8'));
   if(payloadDigestV2(p).digest===r.raw_payload_hash)return p;
  }catch{/* Missing/foreign/corrupt evidence cannot widen a target-value check. */}
 }return null;
}
function retained(snapshot:AssignmentSnapshotV2,op:OperationV2,requireNativeEvidenceTrust=false){
 return retainedBounded(snapshot,op,requireNativeEvidenceTrust,2_000_000);
}
/** Placement-only encoded transport bounds. All source, scope and digest checks
 * are shared above; callers must still decode and run the complete comparator.
 * No other preservation contract receives a larger retained-payload allowance. */
export function retainedNativeAccessoryPayloadV2(snapshot:AssignmentSnapshotV2,op:OperationV2){
 if(op?.input.method!=='POST')return null;
 const isApply=op.input.path==='/revit/place-mep-accessory-interactively'&&op.requested_effect==='apply';
 const isRead=op.input.path==='/revit/get-connectors'&&op.requested_effect==='read'&&object(op.input.body).includeNativePlacementState===true;
 if(!isApply&&!isRead)return null;
 return retainedBounded(snapshot,op,true,isApply?6_500_000:3_100_000);
}

// Reuse the same native provenance boundary for other bounded preservation
// contracts. This reads retained evidence; it does not admit or settle work.
export {retained as retainedNativePreservationPayloadV2};

/** New producer evidence only. Old successful parameter checks retain their
 * target-value meaning; missing historical before-state never becomes proof. */
export function parameterSchedulePreservationCommitV2(snapshot:AssignmentSnapshotV2,op:OperationV2) {
 if(snapshot.execution_control?.state==='paused'||snapshot.unresolved_unknown_operation_ids.length
  ||op.request_identity?.path!=='/revit/set-parameter'||op.requested_effect!=='apply'||op.persistent_effect!=='applied'
  ||op.result?.native_transaction_state!=='committed')return null;
 const body=object(op.input.body),changes=body.changes,excluded=body.excludeElementIds??[];
 if(!Array.isArray(changes)||!changes.length||changes.length>100||!ids(excluded))return null;
 if(changes.some(c=>!c||!Number.isSafeInteger(c.elementId)||c.elementId<=0||typeof c.parameterName!=='string'||!c.parameterName.trim()||typeof c.value!=='string'))return null;
 const targets=[...new Set<number>(changes.filter(c=>!excluded.includes(c.elementId)).map(c=>c.elementId))].sort((a,b)=>a-b),p=retained(snapshot,op);
 if(!targets.length||!p)return null;
 const tx=object(p.transaction),tracking=object(p.changeTracking),affected=op.result.affected_target_identities;
 if(tx.status!=='committed'||tx.committed!==true||!ids(tx.added_element_ids)||tx.added_element_ids.length
  ||!ids(tx.deleted_element_ids)||tx.deleted_element_ids.length||!ids(tx.modified_element_ids,132)||!ids(tx.affected_element_ids,132)
  ||!targets.every(n=>tx.modified_element_ids.includes(n))||!same(tx.modified_element_ids,tx.affected_element_ids)
  ||!Array.isArray(affected)||!same(tx.affected_element_ids,affected.map(x=>Number(/^element_id:([1-9]\d*)$/.exec(x)?.[1])))
  ||tracking.documentChangedObserved!==true||tracking.exhaustiveChangeInventory!==true||tracking.captureFailureCount!==0
  ||tracking.matchingEventCount<1||tracking.distinctWrapperMatchCount!==1)return null;
 const extra=tx.modified_element_ids.filter((n:number)=>!targets.includes(n));
 if(extra.length>32)return null;
 const viewNameProjection=extra.length&&!preservedScheduleTargets(p,extra)
  ?viewNameScheduleProjectionV2(p,extra,changes.filter(c=>!excluded.includes(c.elementId))):null;
 if(extra.length&&!preservedScheduleTargets(p,extra)&&!viewNameProjection)return null;
 return {targets,preservedIds:extra.sort((a:number,b:number)=>a-b),payload:p,viewNameProjection};
}

/** Complete current independent scope for the parameter/inspection consumer.
 * No native call, new fact, permission, or automatic task completion occurs. */
export function parameterScheduleReadScopeV2(snapshot:AssignmentSnapshotV2,apply:OperationV2,read:OperationV2) {
 const c=parameterSchedulePreservationCommitV2(snapshot,apply),r=read?.result,body=object(read?.input.body);
 if(!c||read.requested_effect!=='read'||read.persistent_effect!=='none'||read.request_identity?.path!=='/revit/get-parameters'
  ||read.purpose==='verification'&&read.verification_of_operation_id!==apply.operation_id
  ||r?.native_transaction_state!=='not_applicable'||!ids(body.elementIds)||!same(body.elementIds,c.targets)
  ||!ids(body.preservationScheduleIds,32)||!same(body.preservationScheduleIds,c.preservedIds)
  ||!Number.isFinite(Date.parse(read.opened_at))||!Number.isFinite(Date.parse(r.completed_at))
  ||Date.parse(read.opened_at)<Date.parse(apply.result!.completed_at)||Date.parse(r.completed_at)<Date.parse(read.opened_at))return null;
 // SaveAs does not rewrite model content. Every other intervening model write,
 // unresolved write or read invalidation remains a blocker; no scope renewal.
 if(Object.values(snapshot.operations).some(o=>o.operation_id!==apply.operation_id&&o.requested_effect==='apply'
   &&(o.persistent_effect==='unknown'||o.dispatch_state==='dispatched'&&o.settlement_state!=='settled'
    ||o.persistent_effect!=='none'&&Date.parse(o.result?.completed_at??o.opened_at)>=Date.parse(apply.result!.completed_at)
   &&!(o.request_identity?.path==='/revit/save-as'&&o.result?.authority==='native-host'&&o.result.status==='succeeded'
     &&o.settlement_state==='settled'&&o.persistent_effect==='applied'&&o.result.native_artifact_receipt
     &&o.result.dispatch_state==='dispatched'&&sameAssignmentBindingV2(o.binding,apply.binding)
     &&sameAssignmentBindingV2(o.result.binding,o.binding)))))return null;
 const p=retained(snapshot,read);if(!p||!Array.isArray(p.items)||p.items.length!==c.targets.length
  ||!same(p.items.map((x:any)=>x.id),c.targets)||new Set(p.items.map((x:any)=>x.id)).size!==c.targets.length
  ||p.items.some((x:any)=>typeof x.uniqueId!=='string'||!x.uniqueId.trim()||x.error!=null||x.found===false)
  ||!postconditionSatisfiedByPayloadV2(apply.input,p,{path:'/revit/set-parameter',verification_input:read.input}))return null;
 // GetElementParametersHandler writes the same raw value into the scalar map
 // and each detail. A contradictory duplicate representation is not proof,
 // even when the older target-only matcher finds one expected token.
 for(const change of object(apply.input.body).changes){
  if(!c.targets.includes(change.elementId))continue;
  const row=p.items.find((x:any)=>x.id===change.elementId),name=change.parameterName.trim().toLowerCase();
  const values=Object.entries(object(row.parameters)).filter(([key])=>key.trim().toLowerCase()===name);
  const details=Array.isArray(row.parameterDetails)?row.parameterDetails.filter((x:any)=>String(x?.name??'').trim().toLowerCase()===name):[];
  if(values.length!==1||details.length!==1||typeof values[0]![1]!=='string'||values[0]![1]!==details[0].value
    ||details[0].storageType==='String'&&details[0].valueString!=null&&details[0].valueString!==details[0].value)return null;
 }
 if(c.preservedIds.length&&!(c.viewNameProjection?viewNameScheduleReadMatchesV2(c.viewNameProjection,c.preservedIds,p)
  :preservedScheduleReadMatchesV2(c.payload,c.preservedIds,p)))return null;
 if(!c.preservedIds.length){const scope=object(p.schedulePreservation);if(scope.schema!=='operator.annotation_schedule_read.v1'||scope.complete!==true||!same(scope.requestedElementIds??[],[])||!Array.isArray(scope.items)||scope.items.length)return null;}
 return {target_ids:c.targets,preserved_schedule_ids:c.preservedIds};
}
