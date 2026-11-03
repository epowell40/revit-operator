import {payloadDigestV2} from '@revitoperator/payload-digest-v2';
import {sameAssignmentBindingV2,type AssignmentSnapshotV2,type OperationV2,type OperationResultV2} from '../domain/assignment-kernel/index.js';
import {retainedNativePreservationPayloadV2} from './parameter_schedule_preservation_v2.js';
import {combinedReadFollowsSettledChanges} from './open_duct_postcondition_v2.js';
import {inlineAccessoryReadbackMatchesV2} from './inline_accessory_readback_v2.js';
import {inlineBookkeepingTransitionV2} from './inline_accessory_bookkeeping_v2.js';

const obj=(v:unknown):Record<string,any>=>v&&typeof v==='object'&&!Array.isArray(v)?v as Record<string,any>:{};
const sameIds=(a:unknown,b:unknown,max:number):boolean=>Array.isArray(a)&&Array.isArray(b)&&a.length===b.length&&a.length<=max
  &&a.every(n=>Number.isSafeInteger(n)&&n>0)&&b.every(n=>Number.isSafeInteger(n)&&n>0)
  &&new Set(a).size===a.length&&new Set(b).size===b.length&&a.every(n=>b.includes(n));

/** Retained inspection path, after normal native settlement.
 * One current native read covers physical owners, their types, and the exact
 * preserved schedules without asking a connector manager to read a schedule. */
export function inlineAccessoryPostconditionSatisfiedV2(snapshot:AssignmentSnapshotV2,subject:OperationV2,
  current:OperationResultV2,payload:unknown):boolean {
  try {
    const read=snapshot.operations[current.operation_id],r=read?.result,body=obj(read?.input.body);
    if(snapshot.execution_control?.state==='paused'||snapshot.unresolved_unknown_operation_ids.length
      ||snapshot.operations[subject.operation_id]!==subject||subject.requested_effect!=='apply'
      ||subject.persistent_effect!=='applied'||subject.result?.native_transaction_state!=='committed'
      ||!read||read.requested_effect!=='read'||read.persistent_effect!=='none'||read.purpose!=='verification'
      ||read.fulfillment_role!=='verification'||read.verification_of_operation_id!==subject.operation_id
      ||read.input.path!=='/revit/get-connectors'||!r||r.native_transaction_state!=='not_applicable'
      ||payloadDigestV2(r).digest!==payloadDigestV2(current).digest
      ||!Number.isFinite(Date.parse(current.completed_at))||!combinedReadFollowsSettledChanges(snapshot,current)
      ||body.includeInlineAccessoryState!==true||body.includeAllRefs===false||body.onlyOpenPhysicalConnectors===true
      ||body.includeCoordinateSystem===false||body.includeFlexGeometry===false)return false;
    const applied=retainedNativePreservationPayloadV2(snapshot,subject,true),observed=retainedNativePreservationPayloadV2(snapshot,read,true);
    if(!applied||!observed||payloadDigestV2(payload).digest!==current.raw_payload_hash
      ||payloadDigestV2(observed).digest!==current.raw_payload_hash)return false;
    const state=obj(obj(observed).inlineAccessoryState),schedules=obj(state.schedulePreservation);
    if(!sameIds(body.elementIds,state.requestedElementIds,5)
      ||!sameIds(body.preservationScheduleIds,schedules.requestedElementIds,32))return false;
    return inlineAccessoryReadbackMatchesV2(subject.input,subject.result.affected_target_identities??[],applied,observed);
  } catch { return false; }
}

/** Incoming native envelope path. The read is not yet settled/stored here.
 * Validate its admitted identity and current native receipt directly, without
 * inventing a settled snapshot or requiring a second read. */
export function inlineAccessoryIncomingPostconditionV2(snapshot:AssignmentSnapshotV2,subject:OperationV2,
  current:OperationResultV2,payload:unknown):boolean {
  try {
    const read=snapshot.operations[current.operation_id],body=obj(read?.input.body),identity=read?.request_identity;
    if(snapshot.execution_control?.state==='paused'||snapshot.unresolved_unknown_operation_ids.length
      ||snapshot.input_invalidated_operation_ids?.includes(current.operation_id)||snapshot.operations[subject.operation_id]!==subject
      ||!read||read.admission_state!=='admitted'||!['dispatching','dispatched'].includes(read.dispatch_state)||read.requested_effect!=='read'
      ||read.purpose!=='verification'||read.fulfillment_role!=='verification'||read.verification_of_operation_id!==subject.operation_id
      ||read.input.path!=='/revit/get-connectors'||read.input.method!=='POST'||identity?.path!==read.input.path
      ||identity.method!=='POST'||!identity.request_signature||current.request_identity?.request_signature!==identity.request_signature
      ||current.request_identity.path!==read.input.path||current.request_identity.method!=='POST'
      ||current.authority!=='native-host'||current.status!=='succeeded'||current.dispatch_state!=='dispatched'
      ||current.persistent_effect!=='none'||current.native_transaction_state!=='not_applicable'
      ||!current.receipt_id||!current.native_correlation_id||current.result_schema_id!=='operator-native/POST:/revit/get-connectors/v2'
      ||!sameAssignmentBindingV2(read.binding,snapshot.current_binding)||!sameAssignmentBindingV2(current.binding,read.binding)
      ||!Number.isFinite(Date.parse(current.completed_at))||!combinedReadFollowsSettledChanges(snapshot,current)
      ||payloadDigestV2(payload).digest!==current.raw_payload_hash)return false;
    const scope=inlineAccessoryScopeV2(snapshot,subject),state=obj(obj(payload).inlineAccessoryState);
    if(!scope||!inlineAccessoryReadRequestMatchesV2(snapshot,subject,read.input)
      ||!sameIds(body.elementIds,state.requestedElementIds,5)
      ||!sameIds(body.preservationScheduleIds,obj(state.schedulePreservation).requestedElementIds,32))return false;
    return inlineAccessoryReadbackMatchesV2(subject.input,subject.result!.affected_target_identities??[],scope.payload,payload);
  }catch{return false;}
}

function inlineAccessoryScopeV2(snapshot:AssignmentSnapshotV2,apply:OperationV2) {
  if(snapshot.execution_control?.state==='paused'||snapshot.unresolved_unknown_operation_ids.length
    ||apply.requested_effect!=='apply'||apply.persistent_effect!=='applied'||apply.result?.native_transaction_state!=='committed'
    ||apply.input.path!=='/revit/connect-existing-mep-branch'||obj(apply.input.body).connectionMode!=='insert_inline_accessory')return null;
  const p=retainedNativePreservationPayloadV2(snapshot,apply,true),before=obj(p?.preservationBefore),tx=obj(p?.transaction);
  if(!p||p.applied!==true||p.dryRun!==false||before.complete!==true||tx.status!=='committed'||tx.committed!==true
    ||tx.pending===true||tx.rolled_back===true||!sameIds(tx.deleted_element_ids,[],0))return null;
  const physical=[...(Array.isArray(before.requestedElementIds)?before.requestedElementIds:[]),p.createdDuctId,p.createdAccessoryId];
  const schedules=obj(before.schedulePreservation).requestedElementIds;
  if(!sameIds(physical,physical,5)||!physical.includes(obj(apply.input.body).mainElementId)
    ||!sameIds(schedules,schedules,32)||obj(before.schedulePreservation).complete!==true
    ||schedules.some((id:number)=>physical.includes(id))||physical.includes(p.accessoryTypeId))return null;
  const hasBookkeeping=before.bookkeeping!==undefined||obj(p.preservationAfter).bookkeeping!==undefined;
  const ancillary=hasBookkeeping?inlineBookkeepingTransitionV2(before,obj(p.preservationAfter),obj(apply.input.body).mainElementId,p.createdDuctId,p.createdAccessoryId):{added:[],covered:[]};
  if(!ancillary||!sameIds(tx.added_element_ids,[p.createdDuctId,p.createdAccessoryId,...ancillary.added],4))return null;
  const covered=[...physical,p.accessoryTypeId,...schedules,...ancillary.covered];
  if(!sameIds(covered,covered,128)||!sameIds(tx.affected_element_ids,(apply.result.affected_target_identities??[])
    .map(v=>Number(/^element_id:([1-9]\d*)$/.exec(v)?.[1])),128)||tx.affected_element_ids.some((id:number)=>!covered.includes(id)))return null;
  return {payload:p,physical:physical.sort((a,b)=>a-b),schedules:[...schedules].sort((a:number,b:number)=>a-b)};
}

export function inlineAccessoryReadRequestMatchesV2(snapshot:AssignmentSnapshotV2,apply:OperationV2,input:unknown):boolean {
  const request=obj(input),body=obj(request.body),scope=inlineAccessoryScopeV2(snapshot,apply);
  return !!scope&&request.method==='POST'&&request.path==='/revit/get-connectors'&&body.includeInlineAccessoryState===true
    &&sameIds(body.elementIds,scope.physical,5)&&sameIds(body.preservationScheduleIds,scope.schedules,32)
    &&body.includeAllRefs!==false&&body.includeCoordinateSystem!==false&&body.includeFlexGeometry!==false
    &&body.onlyOpenPhysicalConnectors!==true;
}

export function committedInlineAccessoryReadbackPlanV2(snapshot:AssignmentSnapshotV2,apply:OperationV2) {
  if(snapshot.terminal||snapshot.outcome!=='active'||snapshot.completion_proposal||apply.verification_operation_ids.length)return null;
  const scope=inlineAccessoryScopeV2(snapshot,apply);if(!scope)return null;
  if(Object.values(snapshot.operations).some(o=>o.operation_id!==apply.operation_id&&o.requested_effect==='apply'
    &&(o.persistent_effect==='unknown'||o.dispatch_state==='dispatched'&&o.settlement_state!=='settled'
      ||o.persistent_effect==='applied'&&Date.parse(o.result?.completed_at??o.opened_at)>Date.parse(apply.result!.completed_at))))return null;
  return {method:'POST',path:'/revit/get-connectors',body:{elementIds:scope.physical,preservationScheduleIds:scope.schedules,
    includeInlineAccessoryState:true,includeAllRefs:true,includeCoordinateSystem:true,includeFlexGeometry:true,
    onlyOpenPhysicalConnectors:false,maxConnectorsPerElement:512}};
}
