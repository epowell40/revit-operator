import {payloadDigestV2} from '@revitoperator/payload-digest-v2';
import {sameAssignmentBindingV2,type AssignmentSnapshotV2,type OperationV2,type OperationResultV2} from '../domain/assignment-kernel/index.js';
import {retainedNativeAccessoryPayloadV2} from './parameter_schedule_preservation_v2.js';
import {combinedReadFollowsSettledChanges} from './open_duct_postcondition_v2.js';
import {nativeAccessoryPreservationV2} from './native_accessory_preservation_v2.js';
import {expandNativeAccessoryPreservationV2,expandNativeAccessoryReadbackV2} from './native_preservation_snapshot_v2.js';
const route='/revit/place-mep-accessory-interactively';
const obj=(v:unknown):Record<string,any>=>v&&typeof v==='object'&&!Array.isArray(v)?v as Record<string,any>:{};
const sameIds=(a:unknown,b:unknown,max:number)=>Array.isArray(a)&&Array.isArray(b)&&a.length===b.length&&a.length<=max
 &&a.every(n=>Number.isSafeInteger(n)&&n>0)&&b.every(n=>Number.isSafeInteger(n)&&n>0)
 &&new Set(a).size===a.length&&new Set(b).size===b.length&&a.every(n=>b.includes(n));

function scope(snapshot:AssignmentSnapshotV2,apply:OperationV2){
 try{
  if(snapshot.execution_control?.state==='paused'||snapshot.unresolved_unknown_operation_ids.length
   ||snapshot.operations[apply.operation_id]!==apply||apply.requested_effect!=='apply'||apply.persistent_effect!=='applied'
   ||apply.result?.native_transaction_state!=='committed'||apply.input.path!==route)return null;
  const retained=retainedNativeAccessoryPayloadV2(snapshot,apply);
  if(!retained)return null;
  const payload=expandNativeAccessoryPreservationV2(retained),p=obj(payload),b=obj(obj(p.preservationBefore).nativePlacementState),n=obj(obj(p.preservationAfter).nativePlacementState),tx=obj(p.transaction);
  if(!payload||p.applied!==true||tx.status!=='committed'||tx.committed!==true||b.complete!==true||n.complete!==true
   ||b.schema!=='operator.native_accessory_placement_state.v1'||n.schema!==b.schema
   ||!sameIds(n.requestedElementIds,n.requestedElementIds,5000)||!n.requestedElementIds.length
   ||!sameIds(n.requestedTypeIds,[obj(apply.input.body).accessoryTypeId],1)||!sameIds(b.requestedTypeIds,n.requestedTypeIds,1)
   ||!sameIds(n.requestedSystemIds,b.requestedSystemIds,50)
   ||!sameIds(obj(n.schedulePreservation).requestedElementIds,obj(b.schedulePreservation).requestedElementIds,32)
   ||!sameIds(n.requestedChangedIds,tx.affected_element_ids,1024)
   ||!sameIds(tx.affected_element_ids,(apply.result.affected_target_identities??[]).map(s=>Number(/^element_id:([1-9]\d*)$/.exec(s)?.[1])),1024))return null;
  return {payload,body:{elementIds:n.requestedElementIds,includeNativePlacementState:true,placementTypeIds:n.requestedTypeIds,
   placementSystemIds:n.requestedSystemIds,preservationScheduleIds:n.schedulePreservation.requestedElementIds,
   placementChangedIds:n.requestedChangedIds,includeAllRefs:true,includeCoordinateSystem:true,includeFlexGeometry:true,
   onlyOpenPhysicalConnectors:false,maxConnectorsPerElement:512}};
 }catch{return null;}
}
export function nativeAccessoryReadRequestMatchesV2(snapshot:AssignmentSnapshotV2,apply:OperationV2,input:unknown):boolean{
 const s=scope(snapshot,apply),r=obj(input),b=obj(r.body);if(!s||r.method!=='POST'||r.path!=='/revit/get-connectors')return false;
 const allowed=Object.keys(s.body);
 if(Object.keys(b).some(k=>!allowed.includes(k)))return false;
 return Object.entries(s.body).every(([k,v])=>Array.isArray(v)?sameIds(b[k],v,k==='elementIds'?5000:k==='placementChangedIds'?1024:k==='preservationScheduleIds'?32:50):b[k]===v);
}
export function committedNativeAccessoryReadbackPlanV2(snapshot:AssignmentSnapshotV2,apply:OperationV2){
 if(snapshot.terminal||snapshot.outcome!=='active'||snapshot.completion_proposal||apply.verification_operation_ids.length)return null;
 const s=scope(snapshot,apply);if(!s)return null;
 if(Object.values(snapshot.operations).some(o=>o.operation_id!==apply.operation_id&&o.requested_effect==='apply'
  &&(o.persistent_effect==='unknown'||o.dispatch_state==='dispatched'&&o.settlement_state!=='settled'
    ||o.persistent_effect==='applied'&&Date.parse(o.result?.completed_at??o.opened_at)>=Date.parse(apply.result!.completed_at))))return null;
 return {method:'POST',path:'/revit/get-connectors',body:s.body};
}
function eligible(snapshot:AssignmentSnapshotV2,subject:OperationV2,current:OperationResultV2,payload:unknown){
 const read=snapshot.operations[current.operation_id],identity=read?.request_identity;
 if(snapshot.execution_control?.state==='paused'||snapshot.unresolved_unknown_operation_ids.length
  ||snapshot.input_invalidated_operation_ids?.includes(current.operation_id)||snapshot.operations[subject.operation_id]!==subject
  ||!read||read.admission_state!=='admitted'||!['dispatching','dispatched'].includes(read.dispatch_state)||read.requested_effect!=='read'
  ||read.purpose!=='verification'||read.fulfillment_role!=='verification'||read.verification_of_operation_id!==subject.operation_id
  ||read.input.path!=='/revit/get-connectors'||read.input.method!=='POST'||identity?.path!==read.input.path||identity.method!=='POST'
  ||!identity.request_signature||current.request_identity?.request_signature!==identity.request_signature
  ||current.request_identity.path!==read.input.path||current.request_identity.method!=='POST'
  ||current.authority!=='native-host'||current.status!=='succeeded'||current.dispatch_state!=='dispatched'||current.persistent_effect!=='none'
  ||current.native_transaction_state!=='not_applicable'||!current.receipt_id||!current.native_correlation_id
  ||current.result_schema_id!=='operator-native/POST:/revit/get-connectors/v2'
  ||!sameAssignmentBindingV2(read.binding,snapshot.current_binding)||!sameAssignmentBindingV2(current.binding,read.binding)
  ||!Number.isFinite(Date.parse(current.completed_at))||!Number.isFinite(Date.parse(read.opened_at))
  ||Date.parse(read.opened_at)<Date.parse(subject.result?.completed_at??'')||Date.parse(current.completed_at)<Date.parse(read.opened_at)
  ||!combinedReadFollowsSettledChanges(snapshot,current)||payloadDigestV2(payload).digest!==current.raw_payload_hash
  ||!nativeAccessoryReadRequestMatchesV2(snapshot,subject,read.input))return null;
 return scope(snapshot,subject);
}
/** Incoming native read uses current envelope authority; it does not fabricate a
 * settled read to call the retained-evidence path. */
export function nativeAccessoryIncomingPostconditionV2(snapshot:AssignmentSnapshotV2,subject:OperationV2,current:OperationResultV2,payload:unknown):boolean{
 try{const s=eligible(snapshot,subject,current,payload);return !!s&&!!nativeAccessoryPreservationV2(subject.input,subject.result!.affected_target_identities??[],s.payload,expandNativeAccessoryReadbackV2(payload));}catch{return false;}
}
export function nativeAccessoryPostconditionSatisfiedV2(snapshot:AssignmentSnapshotV2,subject:OperationV2,current:OperationResultV2,payload:unknown):boolean{
 try{
  const s=eligible(snapshot,subject,current,payload),read=snapshot.operations[current.operation_id];
  if(!s||!read?.result||payloadDigestV2(read.result).digest!==payloadDigestV2(current).digest)return false;
  const observed=retainedNativeAccessoryPayloadV2(snapshot,read);
  return !!observed&&payloadDigestV2(observed).digest===current.raw_payload_hash
   &&!!nativeAccessoryPreservationV2(subject.input,subject.result!.affected_target_identities??[],s.payload,expandNativeAccessoryReadbackV2(observed));
 }catch{return false;}
}
