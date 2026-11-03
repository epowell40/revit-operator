import {payloadDigestV2} from '@revitoperator/payload-digest-v2';
import {isCanonicalNativeAffectedTargetSetV2} from '@revitoperator/assignment-kernel-v2-contracts';
import {sameAssignmentBindingV2,canonicalJsonV2,type AssignmentSnapshotV2,type OperationV2,type OperationResultV2} from '../domain/assignment-kernel/index.js';
import {readEvidenceRef,readAuthoritativeEvidence} from '../evidence/evidence_store.js';
import {nativePropertyReadIsFreshNativeV2} from '../assignments/native_observation_inputs_v2.js';
import type {SourceProofRecord} from './vector_detail_source_proof_v2.js';
import {committedReadEpochV2} from './committed_read_epoch_v2.js';
import {appliedOperationHasVerifiedPostconditionV2,verificationOperationHasVerifiedPostconditionV2} from '../domain/assignment-kernel/outcome.js';
import {checkedEditIsCurrentV2} from './current_postcondition_v2.js';

const object=(v:unknown):Record<string,any>=>v&&typeof v==='object'&&!Array.isArray(v)?v as Record<string,any>:{};
const id=(v:unknown):v is number=>Number.isSafeInteger(v)&&Number(v)>0;
const hash=(v:unknown)=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
const equal=(a:unknown,b:unknown)=>canonicalJsonV2(a)===canonicalJsonV2(b);
export const VECTOR_STROKE_CAD_SEMANTIC_V2='cad.original_source_complete_stroke_geometry';
export const VECTOR_STROKE_CAD_RENDERER_V2='embedded_cad_strokes_v1';
export const VECTOR_STROKE_CAD_READ_ROUTE_V2='/revit/view-owned-detailing';
export const isVectorStrokeCadSourcePathV2=(v:unknown):v is string=>typeof v==='string'&&/^artifacts\/drafting-vector\/strokes-[a-f0-9]{64}\.dxf$/.test(v);

export function vectorStrokeCadImportRequestV2(input:unknown){
 const w=object(input),b=object(w.body);
 if(w.method!=='POST'||w.path!=='/revit/link-cad'||typeof b.sourcePath!=='string'
  ||!isVectorStrokeCadSourcePathV2(b.sourcePath)||!hash(b.expectedSourceSha256)
  ||!id(b.viewId)||b.link!==false||b.createDraftingView!==false||b.placeOnSheet!==false||b.placement!=='origin'
  ||b.importUnit!=='Foot'||b.customScale!==1||b.colorMode!=='preserve'||b.autoCorrectAlmostVHLines!==false
  ||b.dryRun!==undefined&&b.dryRun!==false
  ||Object.keys(b).some(k=>!['sourcePath','expectedSourceSha256','viewId','link','createDraftingView','placeOnSheet','placement','importUnit','customScale','colorMode','autoCorrectAlmostVHLines','dryRun'].includes(k)))return null;
 return b;
}
export function vectorStrokeCadReadRequestV2(input:unknown){
 const w=object(input),b=object(w.body??input);
 if(w.path!==undefined&&w.path!==VECTOR_STROKE_CAD_READ_ROUTE_V2||w.method!==undefined&&w.method!=='POST'
  ||!id(b.viewId)||!id(b.cadElementId)||b.includeCadGeometry!==true||b.cadTargetOnly!==true||b.cadGeometryLimit!==1000
  ||!Number.isSafeInteger(b.cadGeometryOffset)||b.cadGeometryOffset<0||b.cadGeometryOffset>=20000
  ||Object.keys(b).some(k=>!['viewId','cadElementId','includeCadGeometry','cadTargetOnly','cadGeometryLimit','cadGeometryOffset'].includes(k)))return null;
 return b;
}
export function retainedVectorCadPayloadV2(s:AssignmentSnapshotV2,op:OperationV2):unknown{
 for(const oid of op.observation_ids??[]){
  const o=s.observations[oid];
  if(!o||o.authority!=='native-host'||o.operation_id!==op.operation_id||o.raw_payload_hash!==op.result?.raw_payload_hash||!sameAssignmentBindingV2(o.binding,op.binding))continue;
  try{const ref=readEvidenceRef(o.raw_payload_ref.replace(/^evidence:/,''));if(ref.byte_count>16_000_000)continue;
   const p=JSON.parse(readAuthoritativeEvidence(ref,{...op.binding,attempt_id:op.operation_id}).toString('utf8'));
   if(payloadDigestV2(p).digest===op.result?.raw_payload_hash)return p;
  }catch{/* A missing or changed page never becomes a source proof. */}
 }return null;
}
export function settledVectorStrokeCadImportV2(s:AssignmentSnapshotV2,op:OperationV2){
 const wanted=vectorStrokeCadImportRequestV2(op.input),r=op.result;
 if(!wanted||s.unresolved_unknown_operation_ids.length||s.input_invalidated_operation_ids?.includes(op.operation_id)
  ||!sameAssignmentBindingV2(op.binding,s.current_binding)||op.admission_state!=='admitted'||op.dispatch_state!=='dispatched'
  ||op.settlement_state!=='settled'||op.requested_effect!=='apply'||op.persistent_effect!=='applied'
  ||!r||r.status!=='succeeded'||r.authority!=='native-host'||r.dispatch_state!=='dispatched'||r.persistent_effect!=='applied'||r.native_transaction_state!=='committed'
  ||r.operation_id!==op.operation_id||!sameAssignmentBindingV2(r.binding,op.binding)||r.request_identity?.path!=='/revit/link-cad'||r.request_identity.method!=='POST'
  ||r.request_identity.request_signature!==op.request_identity?.request_signature||!r.receipt_id||!r.native_correlation_id||!Number.isFinite(Date.parse(r.completed_at))
  ||Object.values(s.operations).some(v=>v.operation_id!==op.operation_id&&v.requested_effect==='apply'
    &&v.dispatch_state==='dispatched'&&v.settlement_state!=='settled'))return null;
 const applied=object(retainedVectorCadPayloadV2(s,op)),tx=object(applied.transaction),added=tx.added_element_ids,modified=tx.modified_element_ids,deleted=tx.deleted_element_ids;
 if(applied.success!==true||applied.mode!=='import'||applied.isLinked!==false||applied.sourceFormat!=='dxf'
  ||applied.sourcePath!==wanted.sourcePath||applied.sourceSha256!==wanted.expectedSourceSha256||applied.viewId!==wanted.viewId||applied.ownerViewId!==wanted.viewId
  ||applied.viewType!=='DraftingView'||applied.viewCreated!==false||!id(applied.elementId)||typeof applied.elementUniqueId!=='string'||!applied.elementUniqueId.trim()
  ||applied.totalTransformScale!==1||applied.importUnit!=='Foot'||applied.colorMode!=='Preserved'||applied.autoCorrectAlmostVHLines!==false
  ||tx.status!=='committed'||tx.committed!==true||!Array.isArray(added)||!added.every(id)||!added.includes(applied.elementId)||added.includes(applied.viewId)
  ||!Array.isArray(modified)||!modified.every(id)||!Array.isArray(deleted)||deleted.length||added.some(v=>modified.includes(v))
  ||new Set([...added,...modified]).size!==added.length+modified.length||!isCanonicalNativeAffectedTargetSetV2(r.affected_target_identities)
  ||!equal([...added,...modified].map(v=>'element_id:'+v).sort(),[...r.affected_target_identities].sort()))return null;
 return{wanted,applied};
}
type Page=Readonly<{operation:OperationV2;result:OperationResultV2;payload:Record<string,any>}>;
export function vectorStrokeCadPageChainV2(s:AssignmentSnapshotV2,apply:OperationV2,current?:Page){
 const c=settledVectorStrokeCadImportV2(s,apply);if(!c)return null;
 const epoch=committedReadEpochV2(s);if(!epoch)return null;
 // The incoming read is admitted and bound before settlement adds its ID to
 // the parent's completed verification set.
 if(current&&(!s.operations[current.operation.operation_id]||!Number.isSafeInteger(current.operation.admitted_assignment_version)
  ||current.operation.verification_of_operation_id!==apply.operation_id))return null;
 const pages:Page[]=[];
 const recordedReads=apply.verification_operation_ids.map(id=>s.operations[id]);
 if(recordedReads.some(op=>!op||!Number.isSafeInteger(op.admitted_assignment_version)))return null;
 const priorReads=recordedReads.filter(op=>Number(op!.admitted_assignment_version)>epoch.settled_version);
 priorReads.sort((a,b)=>a!.admitted_assignment_version!-b!.admitted_assignment_version!);
 for(const prior of priorReads){
  const oid=prior!.operation_id;
  if(current?.operation.operation_id===oid)continue;
  const op=s.operations[oid];if(!op||op.settlement_state!=='settled'||!op.result||op.result.status!=='succeeded')return null;
  const payload=retainedVectorCadPayloadV2(s,op);if(!payload)return null;
  pages.push({operation:op,result:op.result,payload:object(payload)});
 }
 if(current)pages.push(current);
 // Verification IDs are a canonical sorted set, not execution chronology.
 pages.sort((a,b)=>a.operation.admitted_assignment_version!-b.operation.admitted_assignment_version!);
 if(pages.length>256)return null;
 let cursor=0,terminal=false,snapshot:string|null=null,total:number|null=null,owner:string|null=null;
 for(const p of pages){
  const op=p.operation,r=p.result,n=p.payload,b=vectorStrokeCadReadRequestV2(op.input),t=object(n.target),g=object(t.cadGeometry),page=object(g.page);
  if(terminal||!b||b.viewId!==c.applied.viewId||b.cadElementId!==c.applied.elementId||b.cadGeometryOffset!==cursor
   ||op.verification_of_operation_id!==apply.operation_id||op.purpose!=='verification'||op.fulfillment_role!=='verification'||op.requested_effect!=='read'
   ||op.admission_state!=='admitted'||!['dispatching','dispatched'].includes(op.dispatch_state)||s.input_invalidated_operation_ids?.includes(op.operation_id)
   ||Number(op.admitted_assignment_version)<=epoch.settled_version||Date.parse(op.opened_at)<Date.parse(epoch.completed_at)
   ||!sameAssignmentBindingV2(op.binding,s.current_binding)||!nativePropertyReadIsFreshNativeV2(apply,op,r,VECTOR_STROKE_CAD_READ_ROUTE_V2)
   ||r.native_transaction_state!=='not_applicable'||r.dispatch_state!=='dispatched'||!r.receipt_id||!r.native_correlation_id||r.operation_id!==op.operation_id
   ||r.request_identity?.method!=='POST'||op.request_identity?.path!==VECTOR_STROKE_CAD_READ_ROUTE_V2||op.request_identity.method!=='POST'
   ||payloadDigestV2(n).digest!==r.raw_payload_hash||n.schema!=='revit-operator.cad-geometry-target/v1'||n.read_only!==true||n.targetReadComplete!==true
   ||n.scope!=='exact_owner_view_cad_target'||n.wholeViewInventoryRead!==false||n.requestedViewId!==c.applied.viewId||n.requestedCadElementId!==c.applied.elementId
   ||object(n.view).id!==c.applied.viewId||typeof object(n.view).uniqueId!=='string'||!object(n.view).uniqueId.trim()
   ||t.elementId!==c.applied.elementId||t.uniqueId!==c.applied.elementUniqueId||t.ownerViewId!==c.applied.viewId||t.className!=='ImportInstance'
   ||g.elementId!==c.applied.elementId||g.uniqueId!==c.applied.elementUniqueId||g.ownerViewId!==c.applied.viewId||g.isLinked!==false
   ||page.schema!=='revit-operator.cad-geometry-page/v1'||page.complete!==true||page.offset!==cursor||!hash(page.completeGeometrySnapshotSha256)
   ||!id(page.totalPrimitiveCount)||page.totalPrimitiveCount>20000||!Array.isArray(g.items)||g.items.length<1||g.items.length>1000||g.returnedCount!==g.items.length
   ||!Array.isArray(g.issues)||g.issues.length)return null;
  if(snapshot!==null&&(snapshot!==page.completeGeometrySnapshotSha256||total!==page.totalPrimitiveCount||owner!==n.view.uniqueId))return null;
  snapshot=page.completeGeometrySnapshotSha256;total=page.totalPrimitiveCount;owner=n.view.uniqueId;
  cursor+=g.items.length;terminal=cursor===total;
  if(cursor>total!||page.nextOffset!==(terminal?null:cursor)||g.complete!==(pages[0]===p&&terminal))return null;
 }
 return{...c,pages,cursor,terminal,snapshot,total,viewUniqueId:owner,writeEpoch:epoch};
}
export function vectorStrokeCadCheckNeedsRefreshV2(s:AssignmentSnapshotV2,op:OperationV2):boolean{
 if(!vectorStrokeCadImportRequestV2(op.input))return false;
 const epoch=committedReadEpochV2(s);
 const freshCohort=epoch&&op.verification_operation_ids.some(id=>{
  const read=s.operations[id];return read&&Number(read.admitted_assignment_version)>epoch.settled_version&&verificationOperationHasVerifiedPostconditionV2(s,id);
 });
 return !s.terminal&&s.outcome==='active'&&!s.completion_proposal&&s.execution_control?.state!=='paused'&&!s.in_flight_operation_ids.length
  &&appliedOperationHasVerifiedPostconditionV2(s,op.operation_id)&&(!checkedEditIsCurrentV2(s,op.operation_id)||!freshCohort)&&!!settledVectorStrokeCadImportV2(s,op);
}
export function vectorStrokeCadReadSubjectMatchesV2(s:AssignmentSnapshotV2,op:OperationV2,readInput:unknown):boolean{
 const b=vectorStrokeCadReadRequestV2(readInput);if(!b)return true;
 const owners=Object.values(s.operations).filter(v=>{
  const c=settledVectorStrokeCadImportV2(s,v);return !!c&&c.applied.elementId===b.cadElementId&&c.applied.viewId===b.viewId;
 });
 return !owners.length||owners.length===1&&owners[0]!.operation_id===op.operation_id;
}
/** Continue only a proven contiguous prefix through the existing readback owner. */
export function committedVectorStrokeCadReadbackPlanV2(s:AssignmentSnapshotV2,operation:OperationV2){
 if(s.terminal||s.outcome!=='active'||s.completion_proposal||s.execution_control?.state==='paused'||s.in_flight_operation_ids.length)return null;
 const apply=operation.requested_effect==='apply'?operation:s.operations[operation.verification_of_operation_id??''];
 if(!apply)return null;
 const chain=vectorStrokeCadPageChainV2(s,apply);if(!chain||chain.terminal||chain.pages.length>=256)return null;
 return{operation_id:apply.operation_id,plan:{method:'POST',path:VECTOR_STROKE_CAD_READ_ROUTE_V2,
  body:{viewId:chain.applied.viewId,cadElementId:chain.applied.elementId,includeCadGeometry:true,cadTargetOnly:true,cadGeometryLimit:1000,cadGeometryOffset:chain.cursor}}};
}
/** The caller obtains this record only from the existing opaque vector-proof owner. */
export function vectorStrokeCadPostconditionSatisfiedV2(s:AssignmentSnapshotV2,apply:OperationV2,result:OperationResultV2,payload:unknown,source:SourceProofRecord|null){
 const read=s.operations[result.operation_id],c=settledVectorStrokeCadImportV2(s,apply);
 if(!read||!c||source?.matches!==true||source.renderer!==VECTOR_STROKE_CAD_RENDERER_V2||!source.cad||!source.cad.geometryMatches
  ||source.readOperationId!==read.operation_id||source.nativeResultId!==result.result_id||source.nativeRawPayloadHash!==result.raw_payload_hash
  ||source.cad.applyOperationId!==apply.operation_id||source.cad.importElementId!==c.applied.elementId||source.cad.importUniqueId!==c.applied.elementUniqueId
  ||source.cad.viewId!==c.applied.viewId||source.cad.cadSha256!==c.wanted.expectedSourceSha256||source.sourceEntityCount!==source.cad.sourceStrokeCount)return false;
 const chain=vectorStrokeCadPageChainV2(s,apply,{operation:read,result,payload:object(payload)});
 return !!chain?.terminal&&chain.pages.length===source.cad.nativePageCount&&chain.snapshot===source.cad.nativeSnapshotSha256
  &&chain.viewUniqueId===source.cad.viewUniqueId&&chain.total===source.cad.nativePrimitiveCount;
}
