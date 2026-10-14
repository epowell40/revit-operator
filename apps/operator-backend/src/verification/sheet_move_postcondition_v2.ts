import { payloadDigestV2 } from '@revitoperator/payload-digest-v2';
import { readAuthoritativeEvidence, readEvidenceRef } from '../evidence/evidence_store.js';
import { sameAssignmentBindingV2, type AssignmentSnapshotV2, type OperationV2, type OperationResultV2 } from '../domain/assignment-kernel/index.js';
import { appliedOperationHasVerifiedPostconditionV2 } from '../domain/assignment-kernel/outcome.js';

const row=(v:unknown):Record<string,any>=>v&&typeof v==='object'&&!Array.isArray(v)?v as Record<string,any>:{};
const finite=(v:unknown):v is number=>typeof v==='number'&&Number.isFinite(v);
const id=(v:unknown):v is number=>Number.isSafeInteger(v)&&Number(v)>0;
const near=(a:number,b:number)=>Math.abs(a-b)<=1e-7;
const xyz=(v:unknown):v is number[]=>Array.isArray(v)&&v.length===3&&v.every(finite);

/** A committed native sheet-anchor inventory supplies its owner, avoiding an
 * actor-written verification recipe. Older receipts without owner metadata
 * remain unplanned; fresh sheet readback is still required for truth. */
export function committedSheetMoveReadbackPlanV2(snapshot:AssignmentSnapshotV2,op:OperationV2){
 const r=op.result,b=row(op.input.body),ids=b.ids;
 if(snapshot.terminal||snapshot.outcome!=='active'||snapshot.completion_proposal||snapshot.execution_control?.state==='paused'
  ||snapshot.unresolved_unknown_operation_ids.length||snapshot.input_invalidated_operation_ids?.includes(op.operation_id)
  ||op.admission_state!=='admitted'||op.dispatch_state!=='dispatched'||op.settlement_state!=='settled'
  ||op.requested_effect!=='apply'||op.persistent_effect!=='applied'||op.request_identity?.path!=='/revit/move-elements'
  ||op.input.method!=='POST'||b.mode!=='vector'||b.dryRun!==false
  ||!Array.isArray(ids)||!ids.length||ids.length>256||!ids.every(id)||new Set(ids).size!==ids.length
  ||!r||r.status!=='succeeded'||r.authority!=='native-host'||r.dispatch_state!=='dispatched'
  ||r.native_transaction_state!=='committed'||r.persistent_effect!=='applied'||r.operation_id!==op.operation_id
  ||!sameAssignmentBindingV2(op.binding,snapshot.current_binding)||!sameAssignmentBindingV2(r.binding,op.binding)
  ||!op.request_identity.request_signature||r.request_identity?.request_signature!==op.request_identity.request_signature
  ||!r.receipt_id||!r.native_correlation_id||!Number.isFinite(Date.parse(r.completed_at))
  ||op.verification_operation_ids.length||appliedOperationHasVerifiedPostconditionV2(snapshot,op.operation_id)
  ||ids.some((n:number)=>!r.affected_target_identities?.includes('element_id:'+n))
  ||Object.values(snapshot.operations).some(o=>o.operation_id!==op.operation_id&&o.persistent_effect==='applied'
    &&o.result&&Date.parse(o.result.completed_at)>=Date.parse(r.completed_at)))return null;
 for(const oid of op.observation_ids){const obs=snapshot.observations[oid];
  if(!obs||obs.operation_id!==op.operation_id||obs.authority!=='native-host'||obs.raw_payload_hash!==r.raw_payload_hash
    ||!sameAssignmentBindingV2(obs.binding,op.binding))continue;
  try{const ref=readEvidenceRef(obs.raw_payload_ref.replace(/^evidence:/,''));if(ref.byte_count>2_000_000)continue;
   const payload=JSON.parse(readAuthoritativeEvidence(ref,{...op.binding,attempt_id:op.operation_id}).toString('utf8'));
   if(payloadDigestV2(payload).digest!==r.raw_payload_hash||!Array.isArray(payload.snapshots)||payload.snapshots.length!==ids.length)continue;
   const sheetId=payload.snapshots[0]?.before?.ownerViewId;
   if(!id(sheetId)||payload.snapshots.some((s:any)=>s.before?.ownerViewId!==sheetId||s.after?.ownerViewId!==sheetId))continue;
   const actual={status:'Ok',action:'detail',sheetId,sheetElementId:sheetId,viewportCount:0,viewportGeometry:[] as any[],placedScheduleCount:0,placedSchedules:[] as any[]};
   for(const s of payload.snapshots){const a=s.after;
    if(a?.kind==='ViewportBoxCenter'){actual.viewportGeometry.push({viewportId:s.id,center:{u:a.pointXyz?.[0],v:a.pointXyz?.[1]}});actual.viewportCount++;}
    else{actual.placedSchedules.push({instanceId:s.id,placementType:a?.kind==='PanelScheduleOrigin'?'PanelScheduleSheetInstance':a?.kind==='ScheduleInsertion'?'ScheduleSheetInstance':'Unknown',point:{u:a?.pointXyz?.[0],v:a?.pointXyz?.[1]}});actual.placedScheduleCount++;}
   }
   // This only validates a planning recipe against the retained commit. It is
   // never emitted as a read result or a verification credit.
   if(!sheetMoveReadbackMatchesV2(op.input,payload,actual))continue;
   return {method:'POST',path:'/revit/sheets',body:{action:'detail',sheetId,placementIds:[...ids],includeViewportGeometry:true}};
  }catch{/* Invalid/missing retained native metadata cannot plan a check. */}
 }
 return null;
}

/** Sheet UV is not a model Location. Establish the desired position from the
 * admitted vector and native before-anchor, then compare a separate fresh sheet
 * read. An apply's verified flag or after-coordinate alone proves nothing. */
export function sheetMoveReadbackMatchesV2(input:unknown, nativeApply:unknown, payload:unknown):boolean {
 const request=row(input),body=row(request.body),applied=row(nativeApply),actual=row(payload),tx=row(applied.transaction);
 const ids=body.ids,delta=[body.vectorX??0,body.vectorY??0,body.vectorZ??0];
 if(request.path!=='/revit/move-elements'||body.mode!=='vector'||body.dryRun===true
   ||!Array.isArray(ids)||ids.length<1||ids.length>256||!ids.every(id)||new Set(ids).size!==ids.length
   ||!delta.every(finite)||delta[2]!==0||!delta.some(v=>v!==0)
   ||applied.success!==true||applied.applied!==true||applied.status!=='Moved'||applied.rolledBack!==false
   ||tx.status!=='committed'||tx.committed!==true||!Array.isArray(tx.modified_element_ids)
   ||ids.some(value=>!tx.modified_element_ids.includes(value))
   ||!Array.isArray(tx.added_element_ids)||tx.added_element_ids.length!==0
   ||!Array.isArray(tx.deleted_element_ids)||tx.deleted_element_ids.length!==0
   ||!Array.isArray(applied.movedIds)||applied.movedIds.length!==ids.length
   ||new Set(applied.movedIds).size!==ids.length||applied.movedIds.some((value:unknown)=>!id(value)||!ids.includes(value))
   ||!Array.isArray(applied.snapshots)||applied.snapshots.length!==ids.length
   ||actual.status!=='Ok'||actual.action!=='detail'||!id(actual.sheetId)||actual.sheetElementId!==actual.sheetId
   ||actual.truncated===true
   ||!Array.isArray(actual.viewportGeometry)||actual.viewportCount!==actual.viewportGeometry.length
   ||!Array.isArray(actual.placedSchedules)||actual.placedScheduleCount!==actual.placedSchedules.length) return false;
 const anchors=new Map<number,{kind:string;point:number[]}>();
 for(const item of actual.viewportGeometry){const v=row(item),p=row(v.center);
  if(!id(v.viewportId)||anchors.has(v.viewportId)||!finite(p.u)||!finite(p.v))return false;
  anchors.set(v.viewportId,{kind:'ViewportBoxCenter',point:[p.u,p.v,0]});
 }
 for(const item of actual.placedSchedules){const v=row(item),p=row(v.point);
  // Native panel schedules expose Origin; ordinary schedules expose Point.
  // Keep these types distinct so an anchor from the wrong class cannot pass.
  const kind=v.placementType==='PanelScheduleSheetInstance'?'PanelScheduleOrigin'
   :v.placementType==='ScheduleSheetInstance'?'ScheduleInsertion':null;
  if(!kind||!id(v.instanceId)||anchors.has(v.instanceId)||!finite(p.u)||!finite(p.v))return false;
  anchors.set(v.instanceId,{kind,point:[p.u,p.v,0]});
 }
 const seen=new Set<number>();
 return applied.snapshots.every((item:unknown)=>{
  const v=row(item),before=row(v.before),after=row(v.after),current=anchors.get(v.id);
  if(!ids.includes(v.id)||seen.has(v.id)||!current||current.kind!==before.kind||after.kind!==before.kind
    ||!xyz(before.pointXyz)||!xyz(after.pointXyz)||!near(before.pointXyz[2]!,0))return false;
  // New receipts pin the native owning sheet. Legacy receipts only qualify
  // when their native change inventory also identifies this sheet; an old
  // panel receipt without either cannot gain retrospective verification.
  if(before.ownerViewId!=null||after.ownerViewId!=null){
   if(before.ownerViewId!==actual.sheetId||after.ownerViewId!==actual.sheetId)return false;
  }else if(!tx.modified_element_ids.includes(actual.sheetId))return false;
  seen.add(v.id);
  return current.point.every((value,index)=>near(value,before.pointXyz[index]+delta[index]!)
    &&near(after.pointXyz[index],before.pointXyz[index]+delta[index]!));
 });
}

export function sheetMovePostconditionSatisfiedV2(snapshot:AssignmentSnapshotV2,subject:OperationV2,current:OperationResultV2,payload:unknown):boolean {
 const applied=subject.result;
 if(subject.request_identity?.path!=='/revit/move-elements'||subject.requested_effect!=='apply'
   ||subject.persistent_effect!=='applied'||subject.settlement_state!=='settled'
   ||applied?.authority!=='native-host'||applied.status!=='succeeded'||applied.native_transaction_state!=='committed'
   ||!sameAssignmentBindingV2(subject.binding,snapshot.current_binding)||!sameAssignmentBindingV2(applied.binding,snapshot.current_binding)
   ||current.authority!=='native-host'||current.status!=='succeeded'||current.dispatch_state!=='dispatched'||current.persistent_effect!=='none'
   ||current.request_identity?.method!=='POST'||current.request_identity.path!=='/revit/sheets'
   ||!sameAssignmentBindingV2(current.binding,snapshot.current_binding)
   ||!Number.isFinite(Date.parse(current.completed_at))||!Number.isFinite(Date.parse(applied.completed_at))
   ||Date.parse(current.completed_at)<=Date.parse(applied.completed_at)||payloadDigestV2(payload).digest!==current.raw_payload_hash)return false;
 // A later edit may move a dependent sheet object. Require the latest state,
 // rather than rewarding historical before/after evidence out of order.
 if(Object.values(snapshot.operations).some(op=>op.operation_id!==subject.operation_id&&op.persistent_effect==='applied'
   &&op.result&&Date.parse(op.result.completed_at)>=Date.parse(applied.completed_at)))return false;
 for(const oid of subject.observation_ids){const observation=snapshot.observations[oid];
  if(!observation||observation.operation_id!==subject.operation_id||observation.authority!=='native-host'
    ||observation.raw_payload_hash!==applied.raw_payload_hash||!sameAssignmentBindingV2(observation.binding,snapshot.current_binding))continue;
  try{
   const ref=readEvidenceRef(observation.raw_payload_ref.replace(/^evidence:/,''));if(ref.byte_count>2_000_000)continue;
   const bytes=readAuthoritativeEvidence(ref,{...snapshot.current_binding,attempt_id:subject.operation_id});
   const nativeApply=JSON.parse(bytes.toString('utf8'));if(payloadDigestV2(nativeApply).digest!==observation.raw_payload_hash)continue;
   return sheetMoveReadbackMatchesV2(subject.input,nativeApply,payload);
  }catch{/* Missing or corrupt evidence cannot create a progress credit. */}
 }
 return false;
}
