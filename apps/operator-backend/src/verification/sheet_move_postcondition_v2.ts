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
export function committedSheetMoveReadbackPlansV2(snapshot:AssignmentSnapshotV2,op:OperationV2){
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
   const sheets=new Map<number,{status:string;action:string;sheetId:number;sheetElementId:number;viewportCount:number;viewportGeometry:any[];placedScheduleCount:number;placedSchedules:any[]}>();
   for(const s of payload.snapshots){const a=s.after;
    const sheetId=s.before?.ownerViewId;
    if(!id(sheetId)||a?.ownerViewId!==sheetId){sheets.clear();break;}
    if(!sheets.has(sheetId))sheets.set(sheetId,{status:'Ok',action:'detail',sheetId,sheetElementId:sheetId,viewportCount:0,viewportGeometry:[],placedScheduleCount:0,placedSchedules:[]});
    const actual=sheets.get(sheetId)!;
    const point={u:a?.pointXyz?.[0],v:a?.pointXyz?.[1],z:a?.pointXyz?.[2]};
    if(a?.kind==='ViewportBoxCenter'||a?.kind==='ViewportProjectionOrigin'){actual.viewportGeometry.push({viewportId:s.id,center:point,...(a.kind==='ViewportProjectionOrigin'?{placementAnchor:a}:{})});actual.viewportCount++;}
    else{actual.placedSchedules.push({instanceId:s.id,placementType:a?.kind==='PanelScheduleOrigin'?'PanelScheduleSheetInstance':a?.kind==='ScheduleInsertion'?'ScheduleSheetInstance':'Unknown',point});actual.placedScheduleCount++;}
   }
   // This only validates a planning recipe against the retained commit. It is
   // never emitted as a read result or a verification credit.
   // Bound automatic fan-out. Every read still consumes the ordinary operation
   // allowance and reacquires native authorization, pause and settlement gates.
   if(!sheets.size||sheets.size>16||!sheetMoveReadbacksMatchV2(op.input,payload,[...sheets.values()]))continue;
   return [...sheets.values()].map(actual=>({method:'POST',path:'/revit/sheets',body:{action:'detail',sheetId:actual.sheetId,
    placementIds:payload.snapshots.filter((s:any)=>s.before.ownerViewId===actual.sheetId).map((s:any)=>s.id),includeViewportGeometry:true}}));
  }catch{/* Invalid/missing retained native metadata cannot plan a check. */}
 }
 return null;
}

/** Compatibility for callers that need one read; multi-owner batches use the
 * plural planner and separate native observations, never a fabricated union. */
export function committedSheetMoveReadbackPlanV2(snapshot:AssignmentSnapshotV2,op:OperationV2){
 const plans=committedSheetMoveReadbackPlansV2(snapshot,op);return plans?.length===1?plans[0]:null;
}

/** Sheet UV is not a model Location. Establish the desired position from the
 * admitted vector and native before-anchor, then compare a separate fresh sheet
 * read. An apply's verified flag or after-coordinate alone proves nothing. */
export function sheetMoveReadbackMatchesV2(input:unknown, nativeApply:unknown, payload:unknown):boolean {
 return sheetMoveReadbacksMatchV2(input,nativeApply,[payload]);
}

export function sheetMoveReadbacksMatchV2(input:unknown, nativeApply:unknown, payloads:readonly unknown[]):boolean {
 const request=row(input),body=row(request.body),applied=row(nativeApply),tx=row(applied.transaction);
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
   ||!payloads.length||payloads.length>ids.length) return false;
 const anchors=new Map<number,{kind:string;point:number[];sheetId:number;projection?:Record<string,any>}>(),sheets=new Set<number>();
 for(const payload of payloads){const actual=row(payload);
 if(actual.status!=='Ok'||actual.action!=='detail'||!id(actual.sheetId)||actual.sheetElementId!==actual.sheetId||sheets.has(actual.sheetId)
   ||actual.truncated===true
   ||!Array.isArray(actual.viewportGeometry)||actual.viewportCount!==actual.viewportGeometry.length
   ||!Array.isArray(actual.placedSchedules)||actual.placedScheduleCount!==actual.placedSchedules.length) return false;
 if(!actual.viewportGeometry.some((v:any)=>ids.includes(v.viewportId))&&!actual.placedSchedules.some((v:any)=>ids.includes(v.instanceId)))return false;
 sheets.add(actual.sheetId);
 for(const item of actual.viewportGeometry){const v=row(item),p=row(v.center);
  if(!id(v.viewportId)||anchors.has(v.viewportId)||!finite(p.u)||!finite(p.v)||('z' in p&&!finite(p.z)))return false;
  const projection=row(v.placementAnchor);
  if(projection.kind==='ViewportProjectionOrigin'
    &&(!xyz(projection.pointXyz)||projection.ownerViewId!==actual.sheetId
      ||!['basisXXyz','basisYXyz','basisZXyz'].every(k=>xyz(projection[k]))))return false;
  anchors.set(v.viewportId,{kind:'ViewportBoxCenter',point:[p.u,p.v,p.z??0],sheetId:actual.sheetId,
    ...(projection.kind==='ViewportProjectionOrigin'?{projection}:{})});
 }
 for(const item of actual.placedSchedules){const v=row(item),p=row(v.point);
  // Native panel schedules expose Origin; ordinary schedules expose Point.
  // Keep these types distinct so an anchor from the wrong class cannot pass.
  const kind=v.placementType==='PanelScheduleSheetInstance'?'PanelScheduleOrigin'
   :v.placementType==='ScheduleSheetInstance'?'ScheduleInsertion':null;
  if(!kind||!id(v.instanceId)||anchors.has(v.instanceId)||!finite(p.u)||!finite(p.v)||('z' in p&&!finite(p.z)))return false;
  anchors.set(v.instanceId,{kind,point:[p.u,p.v,p.z??0],sheetId:actual.sheetId});
 }
 }
 const seen=new Set<number>();
 return applied.snapshots.every((item:unknown)=>{
  const v=row(item),before=row(v.before),after=row(v.after),anchor=anchors.get(v.id);
  const current=before.kind==='ViewportProjectionOrigin'&&anchor?.projection
    ?{kind:'ViewportProjectionOrigin',point:anchor.projection.pointXyz as number[],sheetId:anchor.sheetId}:anchor;
  if(!ids.includes(v.id)||seen.has(v.id)||!current||current.kind!==before.kind||after.kind!==before.kind
    ||!xyz(before.pointXyz)||!xyz(after.pointXyz))return false;
  // New receipts pin the native owning sheet. Legacy receipts only qualify
  // when their native change inventory also identifies this sheet; an old
  // panel receipt without either cannot gain retrospective verification.
  if(before.ownerViewId!=null||after.ownerViewId!=null){
   if(before.ownerViewId!==current.sheetId||after.ownerViewId!==current.sheetId)return false;
  }else if(payloads.length!==1||!tx.modified_element_ids.includes(current.sheetId))return false;
  if(before.kind==='ViewportProjectionOrigin'&&!['basisXXyz','basisYXyz','basisZXyz'].every(k=>
    xyz(before[k])&&xyz(after[k])&&xyz(anchor?.projection?.[k])
    &&before[k].every((n:number,i:number)=>near(n,after[k][i])&&near(n,anchor!.projection![k][i]))))return false;
  seen.add(v.id);
  return current.point.every((value,index)=>near(value,before.pointXyz[index]+delta[index]!)
    &&near(after.pointXyz[index],before.pointXyz[index]+delta[index]!));
 });
}

export function sheetMovePostconditionSatisfiedV2(snapshot:AssignmentSnapshotV2,subject:OperationV2,current:OperationResultV2,payload:unknown):boolean {
 const applied=subject.result;
 if(snapshot.unresolved_unknown_operation_ids.length||snapshot.input_invalidated_operation_ids?.includes(subject.operation_id)
   ||subject.request_identity?.path!=='/revit/move-elements'||subject.requested_effect!=='apply'
   ||subject.persistent_effect!=='applied'||subject.settlement_state!=='settled'
   ||applied?.authority!=='native-host'||applied.status!=='succeeded'||applied.native_transaction_state!=='committed'
   ||!sameAssignmentBindingV2(subject.binding,snapshot.current_binding)||!sameAssignmentBindingV2(applied.binding,snapshot.current_binding)
   ||current.authority!=='native-host'||current.status!=='succeeded'||current.dispatch_state!=='dispatched'||current.persistent_effect!=='none'
   ||current.request_identity?.method!=='POST'||current.request_identity.path!=='/revit/sheets'
   ||!sameAssignmentBindingV2(current.binding,snapshot.current_binding)
   ||!Number.isFinite(Date.parse(current.completed_at))||!Number.isFinite(Date.parse(applied.completed_at))
   ||Date.parse(current.completed_at)<=Date.parse(applied.completed_at)||!freshSheetRead(snapshot,subject,current,payload))return false;
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
   const owners=new Set<number>();
   for(const s of row(nativeApply).snapshots??[]){
    if(!id(s.before?.ownerViewId)||s.after?.ownerViewId!==s.before.ownerViewId)
     return sheetMoveReadbackMatchesV2(subject.input,nativeApply,payload);
    owners.add(s.before.ownerViewId);
   }
   if(!owners.has(row(payload).sheetId))return false;
   // Each owner gets its own authenticated native read. Earlier partial reads
   // are useful evidence but never proof until all requested anchors match.
   const reads=new Map<number,unknown>([[row(payload).sheetId,payload]]);
   const candidates=subject.verification_operation_ids.map(id=>snapshot.operations[id])
    .filter(op=>op&&op.operation_id!==current.operation_id&&op.settlement_state==='settled'&&op.result
      &&Date.parse(op.result.completed_at)<=Date.parse(current.completed_at))
    .sort((a,b)=>Date.parse(b!.result!.completed_at)-Date.parse(a!.result!.completed_at));
   for(const op of candidates){
    for(const observationId of op!.observation_ids){const obs=snapshot.observations[observationId];
     if(!obs||obs.operation_id!==op!.operation_id||obs.authority!=='native-host'
       ||!sameAssignmentBindingV2(obs.binding,snapshot.current_binding)||obs.raw_payload_hash!==op!.result!.raw_payload_hash
       ||!obs.raw_payload_ref.startsWith('evidence:'))continue;
     try{
      const ref=readEvidenceRef(obs.raw_payload_ref.slice('evidence:'.length));if(ref.byte_count>2_000_000)continue;
      const p=JSON.parse(readAuthoritativeEvidence(ref,{...snapshot.current_binding,attempt_id:op!.operation_id}).toString('utf8'));
      if(!freshSheetRead(snapshot,subject,op!.result!,p)||!owners.has(row(p).sheetId)||reads.has(row(p).sheetId))continue;
      reads.set(row(p).sheetId,p);
     }catch{/* A missing, stale, foreign or altered read cannot complete the batch. */}
    }
   }
   return reads.size===owners.size&&sheetMoveReadbacksMatchV2(subject.input,nativeApply,[...reads.values()]);
  }catch{/* Missing or corrupt evidence cannot create a progress credit. */}
 }
 return false;
}

function freshSheetRead(snapshot:AssignmentSnapshotV2,subject:OperationV2,result:OperationResultV2,payload:unknown):boolean {
 const op=snapshot.operations[result.operation_id],applied=subject.result;
 return Boolean(op&&applied&&op.requested_effect==='read'&&op.purpose==='verification'
  &&op.verification_of_operation_id===subject.operation_id&&!snapshot.input_invalidated_operation_ids?.includes(op.operation_id)
  &&op.request_identity?.method==='POST'&&op.request_identity.path==='/revit/sheets'
  &&op.request_identity.request_signature&&op.request_identity.request_signature===result.request_identity?.request_signature
  &&result.authority==='native-host'&&result.status==='succeeded'&&result.dispatch_state==='dispatched'
  &&result.persistent_effect==='none'&&result.native_transaction_state==='not_applicable'&&result.receipt_id&&result.native_correlation_id
  &&sameAssignmentBindingV2(op.binding,snapshot.current_binding)&&sameAssignmentBindingV2(result.binding,snapshot.current_binding)
  &&Number.isFinite(Date.parse(op.opened_at))&&Number.isFinite(Date.parse(result.completed_at))
  &&Date.parse(op.opened_at)>=Date.parse(applied.completed_at)&&Date.parse(result.completed_at)>=Date.parse(op.opened_at)
  &&payloadDigestV2(payload).digest===result.raw_payload_hash);
}
