import {payloadDigestV2} from '@revitoperator/payload-digest-v2';
import {sameAssignmentBindingV2,type AssignmentSnapshotV2,type OperationV2,type OperationResultV2} from '../domain/assignment-kernel/index.js';
import {retainedNativePreservationPayloadV2} from './parameter_schedule_preservation_v2.js';
import {combinedReadFollowsSettledChanges} from './open_duct_postcondition_v2.js';
import {teeTakeoffReadbackMatchesV2,teeTakeoffTransitionV2} from './tee_takeoff_readback_v2.js';
const obj=(v:unknown):Record<string,any>=>v&&typeof v==='object'&&!Array.isArray(v)?v as Record<string,any>:{};
const ids=(v:any,max=128):v is number[]=>Array.isArray(v)&&v.length<=max&&v.every(n=>Number.isSafeInteger(n)&&n>0)&&new Set(v).size===v.length;
const same=(a:any,b:any,max=128)=>ids(a,max)&&ids(b,max)&&a.length===b.length&&a.every(n=>b.includes(n));
function scope(snapshot:AssignmentSnapshotV2,apply:OperationV2){
  try{
    const b=obj(apply.input.body);
    if(snapshot.execution_control?.state==='paused'||snapshot.unresolved_unknown_operation_ids.length||snapshot.operations[apply.operation_id]!==apply
      ||apply.requested_effect!=='apply'||apply.persistent_effect!=='applied'||apply.result?.native_transaction_state!=='committed'
      ||apply.input.path!=='/revit/connect-existing-mep-branch'||b.connectionMode!=='replace_tee_with_takeoff')return null;
    const p=retainedNativePreservationPayloadV2(snapshot,apply,true),tx=obj(p?.transaction);
    if(!p||p.applied!==true||p.dryRun!==false||p.connectionMode!==b.connectionMode||tx.status!=='committed'||tx.committed!==true||tx.pending===true||tx.rolled_back===true)return null;
    const s=teeTakeoffTransitionV2(p.preservationBefore,p.preservationAfter,b.teeElementId,p.createdBridgeId,p.createdFittingId,[b.mainElementId,b.secondMainElementId,b.branchElementId],tx.modified_element_ids);
    if(!s||!same(tx.added_element_ids,s.added,12)||!same(tx.deleted_element_ids,s.deleted,12)||!ids(tx.modified_element_ids,64)
      ||tx.modified_element_ids.some(n=>!s.covered.includes(n))
      ||!same(tx.affected_element_ids,[...new Set<number>([...tx.added_element_ids,...tx.deleted_element_ids,...tx.modified_element_ids])])
      ||!same(tx.affected_element_ids,(apply.result.affected_target_identities??[]).map(v=>Number(/^element_id:([1-9]\d*)$/.exec(v)?.[1]))))return null;
    return {...s,payload:p};
  }catch{return null;}
}
export function teeTakeoffReadRequestMatchesV2(snapshot:AssignmentSnapshotV2,apply:OperationV2,input:unknown):boolean{
  const r=obj(input),b=obj(r.body),s=scope(snapshot,apply);
  return !!s&&r.path==='/revit/get-connectors'&&r.method==='POST'&&b.includeTeeReplacementState===true
    &&(b.includeInlineAccessoryState===undefined||b.includeInlineAccessoryState===false)
    &&same(b.elementIds,s.physical,8)&&same(b.replacementRemovedIds,s.deleted,12)&&same(b.replacementTypeIds,s.types,16)
    &&same(b.preservationScheduleIds,s.schedules,32)&&b.includeAllRefs!==false&&b.includeCoordinateSystem!==false&&b.includeFlexGeometry!==false&&b.onlyOpenPhysicalConnectors!==true;
}
function responseScope(body:Record<string,any>,payload:unknown):boolean{
  const s=obj(obj(payload).teeReplacementState);
  return same(body.elementIds,s.requestedElementIds,8)&&same(body.replacementRemovedIds,s.requestedRemovedIds,12)
    &&same(body.replacementTypeIds,s.requestedAdditionalTypeIds,16)&&same(body.preservationScheduleIds,obj(s.schedulePreservation).requestedElementIds,32);
}
export function teeTakeoffPostconditionSatisfiedV2(snapshot:AssignmentSnapshotV2,subject:OperationV2,current:OperationResultV2,payload:unknown):boolean{
  try{
    const read=snapshot.operations[current.operation_id],r=read?.result;
    if(!read||read.requested_effect!=='read'||read.persistent_effect!=='none'||read.purpose!=='verification'||read.fulfillment_role!=='verification'
      ||read.verification_of_operation_id!==subject.operation_id||!r||r.native_transaction_state!=='not_applicable'
      ||payloadDigestV2(r).digest!==payloadDigestV2(current).digest||!Number.isFinite(Date.parse(current.completed_at))
      ||!combinedReadFollowsSettledChanges(snapshot,current)||!teeTakeoffReadRequestMatchesV2(snapshot,subject,read.input))return false;
    const applied=retainedNativePreservationPayloadV2(snapshot,subject,true),observed=retainedNativePreservationPayloadV2(snapshot,read,true);
    if(!applied||!observed||payloadDigestV2(payload).digest!==current.raw_payload_hash||payloadDigestV2(observed).digest!==current.raw_payload_hash
      ||!responseScope(obj(read.input.body),observed))return false;
    return teeTakeoffReadbackMatchesV2(subject.input,subject.result!.affected_target_identities??[],applied,observed);
  }catch{return false;}
}
/** The incoming result is not settled yet. Check its admitted native envelope;
 * subsequent retained inspection independently verifies the stored source. */
export function teeTakeoffIncomingPostconditionV2(snapshot:AssignmentSnapshotV2,subject:OperationV2,current:OperationResultV2,payload:unknown):boolean{
  try{
    const read=snapshot.operations[current.operation_id],identity=read?.request_identity;
    if(snapshot.input_invalidated_operation_ids?.includes(current.operation_id)||!read||read.admission_state!=='admitted'
      ||!['dispatching','dispatched'].includes(read.dispatch_state)||read.requested_effect!=='read'||read.purpose!=='verification'||read.fulfillment_role!=='verification'
      ||read.verification_of_operation_id!==subject.operation_id||read.input.path!=='/revit/get-connectors'||read.input.method!=='POST'
      ||identity?.path!==read.input.path||identity.method!=='POST'||!identity.request_signature||current.request_identity?.request_signature!==identity.request_signature
      ||current.request_identity.path!==read.input.path||current.request_identity.method!=='POST'||current.authority!=='native-host'||current.status!=='succeeded'
      ||current.dispatch_state!=='dispatched'||current.persistent_effect!=='none'||current.native_transaction_state!=='not_applicable'
      ||!current.receipt_id||!current.native_correlation_id||current.result_schema_id!=='operator-native/POST:/revit/get-connectors/v2'
      ||!sameAssignmentBindingV2(read.binding,snapshot.current_binding)||!sameAssignmentBindingV2(current.binding,read.binding)
      ||!Number.isFinite(Date.parse(current.completed_at))||!combinedReadFollowsSettledChanges(snapshot,current)
      ||payloadDigestV2(payload).digest!==current.raw_payload_hash||!teeTakeoffReadRequestMatchesV2(snapshot,subject,read.input)
      ||!responseScope(obj(read.input.body),payload))return false;
    const s=scope(snapshot,subject);return !!s&&teeTakeoffReadbackMatchesV2(subject.input,subject.result!.affected_target_identities??[],s.payload,payload);
  }catch{return false;}
}
export function committedTeeTakeoffReadbackPlanV2(snapshot:AssignmentSnapshotV2,apply:OperationV2){
  if(snapshot.terminal||snapshot.outcome!=='active'||snapshot.completion_proposal||apply.verification_operation_ids.length)return null;
  const s=scope(snapshot,apply);if(!s)return null;
  if(Object.values(snapshot.operations).some(o=>o.operation_id!==apply.operation_id&&o.requested_effect==='apply'
    &&(o.persistent_effect==='unknown'||o.dispatch_state==='dispatched'&&o.settlement_state!=='settled'
      ||o.persistent_effect==='applied'&&Date.parse(o.result?.completed_at??o.opened_at)>Date.parse(apply.result!.completed_at))))return null;
  return {method:'POST',path:'/revit/get-connectors',body:{elementIds:s.physical,replacementRemovedIds:[...s.deleted].sort((a,b)=>a-b),
    replacementTypeIds:s.types,preservationScheduleIds:s.schedules,includeTeeReplacementState:true,includeAllRefs:true,includeCoordinateSystem:true,
    includeFlexGeometry:true,onlyOpenPhysicalConnectors:false,maxConnectorsPerElement:512}};
}
