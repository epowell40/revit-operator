import {MAX_NATIVE_AFFECTED_TARGETS_V2,isCanonicalNativeAffectedTargetSetV2} from '@revitoperator/assignment-kernel-v2-contracts';
import {payloadDigestV2} from '@revitoperator/payload-digest-v2';
import {readAuthoritativeEvidence,readEvidenceRef} from '../evidence/evidence_store.js';
import {canonicalJsonV2,sameAssignmentBindingV2,type AssignmentSnapshotV2,type OperationV2,type OperationResultV2} from '../domain/assignment-kernel/index.js';
import {nativePropertyReadIsFreshNativeV2} from '../assignments/native_observation_inputs_v2.js';
import {vectorSourceProofRecordV2,type PreparedVectorSourceProofV2} from './vector_detail_source_proof_v2.js';
import {VECTOR_ANNOTATION_RENDERER,VECTOR_ANNOTATION_PART_SIZE} from '../pdf/drafting_vector_annotations.js';
import {appliedOperationHasVerifiedPostconditionV2} from '../domain/assignment-kernel/outcome.js';
import {checkedEditIsCurrentV2} from './current_postcondition_v2.js';

const object=(v:unknown):Record<string,any>=>v&&typeof v==='object'&&!Array.isArray(v)?v as Record<string,any>:{};
const id=(v:unknown):v is number=>Number.isSafeInteger(v)&&Number(v)>0;
const hash=(v:unknown)=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
const equal=(a:unknown,b:unknown)=>canonicalJsonV2(a)===canonicalJsonV2(b);
const ids=(v:unknown):v is number[]=>Array.isArray(v)&&v.length<=MAX_NATIVE_AFFECTED_TARGETS_V2&&v.every(id)&&new Set(v).size===v.length;
const applyRoute='/revit/import-vector-detail',readRoute='/revit/inspect-vector-detail';
const annotationRoute='/revit/import-vector-annotations';
const applyRoutes=[applyRoute,annotationRoute];
export const VECTOR_DETAIL_PART_SEMANTIC_V2='vector_detail.part_original_source_and_native_projection';
export {VECTOR_DETAIL_SOURCE_FACT_V2} from './vector_source_proof_contract_v2.js';
export function vectorDetailImportRequestV2(input:unknown){
 const w=object(input),b=object(w.body??input);
 const annotation=w.path===annotationRoute;
 if(w.path!==undefined&&!applyRoutes.includes(w.path)||typeof b.sourcePath!=='string'||!/^artifacts\/uploads\/[^/\\\r\n]+$/.test(b.sourcePath)||b.sourcePath.length>520
  ||typeof b.nativePlanPath!=='string'||!/^artifacts\/drafting-vector\/source-[a-f0-9]{64}\.json\.gz$/.test(b.nativePlanPath)
  ||!hash(b.expectedSourceSha256)||!hash(b.expectedNativePlanFileSha256)||!hash(b.expectedNativePlanSha256)
  ||(annotation?(!id(b.viewId)||typeof b.expectedViewUniqueId!=='string'||!b.expectedViewUniqueId.trim()||b.expectedViewUniqueId.length>160)
    :(typeof b.viewName!=='string'||!b.viewName.trim()||b.viewName.length>160))||b.dryRun===true||b.dryRun!==undefined&&typeof b.dryRun!=='boolean'
  ||Object.keys(b).some(k=>!['sourcePath','expectedSourceSha256','nativePlanPath','expectedNativePlanFileSha256','expectedNativePlanSha256',...(annotation?['viewId','expectedViewUniqueId']:['viewName']),'partIndex','manifestElementId','expectedImportSnapshotSha256','dryRun'].includes(k))
  ||b.partIndex!==undefined&&(!Number.isInteger(b.partIndex)||b.partIndex<0||b.partIndex>1999)
  ||(b.partIndex??0)>0&&!id(b.manifestElementId)||b.manifestElementId!==undefined&&(!id(b.manifestElementId)||!hash(b.expectedImportSnapshotSha256))
  ||b.manifestElementId===undefined&&b.expectedImportSnapshotSha256!==undefined)return null;
 return b;
}
export function vectorDetailInspectionReadIdV2(input:unknown):number|null{
 const w=object(input),b=object(w.body??input);
 return id(b.manifestElementId)&&Number.isInteger(b.partIndex)&&b.partIndex>=0&&b.partIndex<=1999
  &&(b.action===undefined||b.action==='inspect')&&(b.includeItems===undefined||b.includeItems===false)
  &&(b.offset===undefined||b.offset===0)&&(b.limit===undefined||Number.isInteger(b.limit)&&b.limit>=1&&b.limit<=100)
  &&Object.keys(b).every(k=>['action','manifestElementId','partIndex','offset','limit','includeItems'].includes(k))?b.manifestElementId:null;
}
function committed(input:unknown,payload:unknown,affected:readonly string[]){
 const wanted=vectorDetailImportRequestV2(input),a=object(payload),tx=object(a.transaction),added=tx.added_element_ids,modified=tx.modified_element_ids,deleted=tx.deleted_element_ids;
 const annotation=object(input).path===annotationRoute;
 if(!wanted||a.status!=='Success'||a.applied!==true||a.dryRun===true||!id(a.manifestElementId)||!id(a.viewId)
  ||(annotation?(a.renderer!==VECTOR_ANNOTATION_RENDERER||a.viewId!==wanted.viewId||a.viewUniqueId!==wanted.expectedViewUniqueId||typeof a.viewName!=='string'||!a.viewName.trim())
    :a.viewName!==wanted.viewName.trim())
  ||a.partIndex!==(wanted.partIndex??0)||!id(a.partsTotal)||a.partsTotal>2000||a.completedParts!==a.partIndex+1||a.completedParts>a.partsTotal
  ||a.sourcePath!==wanted.sourcePath||a.sourceSha256!==wanted.expectedSourceSha256||a.nativePlanSha256!==wanted.expectedNativePlanSha256
  ||a.nativePlanFileSha256!==wanted.expectedNativePlanFileSha256||!hash(a.partNativeSnapshotSha256)||!hash(a.importSnapshotSha256)
  ||!ids(a.createdEntityIds)||!a.createdEntityIds.length||a.createdContentCount!==a.createdEntityIds.length
  ||!equal(a.remainingPartIndices,Array.from({length:a.partsTotal-a.completedParts},(_,i)=>a.completedParts+i))
  ||a.nextPartIndex!==(a.completedParts<a.partsTotal?a.completedParts:null)
  ||tx.committed!==true||tx.status!=='committed'||object(a.changeTracking).exhaustiveChangeInventory!==true
  ||!ids(added)||!added.length||!ids(modified)||!ids(deleted)||deleted.length||added.some(v=>modified.includes(v))
  ||!a.createdEntityIds.every((v:number)=>added.includes(v))
  ||(wanted.manifestElementId!==undefined?(a.manifestElementId!==wanted.manifestElementId||!modified.includes(a.manifestElementId))
    :!added.includes(a.manifestElementId)||!annotation&&!added.includes(a.viewId))
  ||!isCanonicalNativeAffectedTargetSetV2(affected)||!equal([...added,...modified].map(v=>'element_id:'+v).sort(),[...affected].sort()))return null;
 if(annotation&&(!id(a.expectedContentCount)||a.expectedContentCount>80000||a.partsTotal!==Math.ceil(a.expectedContentCount/VECTOR_ANNOTATION_PART_SIZE)
  ||a.createdContentCount!==Math.min(VECTOR_ANNOTATION_PART_SIZE,a.expectedContentCount-a.partIndex*VECTOR_ANNOTATION_PART_SIZE)
  ||!id(a.sourcePlanEntityCount)||a.sourcePlanEntityCount<a.expectedContentCount||a.sourcePlanEntityCount>100000
  ||!Array.isArray(a.createdSourceEntityIds)||a.createdSourceEntityIds.length!==a.createdContentCount
  ||!a.createdSourceEntityIds.every((v:unknown)=>typeof v==='string'&&v.length>0)||new Set(a.createdSourceEntityIds).size!==a.createdContentCount
  ||added.includes(a.viewId)||a.createdEntityIds.includes(a.manifestElementId)))return null;
 return{wanted,applied:a,annotation};
}
export function vectorDetailImportReadbackMatchesV2(input:unknown,applied:unknown,readInput:unknown,payload:unknown,affected:readonly string[],proof:PreparedVectorSourceProofV2|null|undefined,result:OperationResultV2,manifestCheckpoint?:Record<string,any>):boolean{
 const c=committed(input,applied,affected),n=object(payload),b=object(object(readInput).body??readInput),projection=object(n.sourceProjection),source=vectorSourceProofRecordV2(proof,result);
 const head=c?.annotation?(manifestCheckpoint??c.applied):c?.applied;
 return !!c&&source?.matches===true&&vectorDetailInspectionReadIdV2(readInput)===c.applied.manifestElementId&&b.partIndex===c.applied.partIndex
  &&n.schema===(c.annotation?'operator.vector-drafting-annotation-inspection.v1':'operator.vector-drafting-native-inspection.v1')&&n.read_only===true&&n.nativeSnapshotMatchesImport===true&&n.snapshotError==null
  &&(!c.annotation||(n.renderer===VECTOR_ANNOTATION_RENDERER&&source.renderer===VECTOR_ANNOTATION_RENDERER&&n.viewUniqueId===c.wanted.expectedViewUniqueId
    &&n.expectedContentCount===c.applied.expectedContentCount&&n.sourcePlanEntityCount===c.applied.sourcePlanEntityCount&&source.sourcePlanEntityCount===n.sourcePlanEntityCount
    &&equal(n.observedSourceEntityIds,c.applied.createdSourceEntityIds)&&equal(source.sourcePartEntityIds,n.observedSourceEntityIds)))
  &&n.manifestElementId===c.applied.manifestElementId&&n.partIndex===c.applied.partIndex&&n.viewId===c.applied.viewId&&n.viewName===c.applied.viewName
  &&n.sourcePath===c.wanted.sourcePath&&n.sourceSha256===c.applied.sourceSha256&&n.sourceFileCurrent===true&&n.sourceFileError==null
  &&n.nativePlanPath===c.wanted.nativePlanPath&&n.nativePlanSha256===c.applied.nativePlanSha256&&n.nativePlanFileSha256===c.applied.nativePlanFileSha256
  &&n.partNativeSnapshotSha256===c.applied.partNativeSnapshotSha256&&hash(n.importSnapshotSha256)
  &&n.partsTotal===c.applied.partsTotal&&equal(n.completedPartIndices,Array.from({length:head!.completedParts},(_,i)=>i))
  &&equal(n.remainingPartIndices,head!.remainingPartIndices)&&(!c.annotation||n.importSnapshotSha256===head!.importSnapshotSha256)
  &&equal(n.observedEntityIds,c.applied.createdEntityIds)
  &&n.totalPartContent===c.applied.createdContentCount&&projection.schema==='operator.vector-drafting-native-projection.v1'
  &&projection.completePartRead===true&&projection.sourceNativeProjectionMatches===true&&projection.issueCount===0&&projection.issueListTruncated===false
  &&projection.nativeEntitiesInspected===c.applied.createdContentCount&&projection.sourceEntityCount===c.applied.createdContentCount
  &&source.sourceSha256===n.sourceSha256&&source.nativePlanSha256===n.nativePlanSha256&&source.nativePlanFileSha256===n.nativePlanFileSha256
  &&source.sourcePartEntityCount===c.applied.createdContentCount&&source.partIndex===c.applied.partIndex&&source.partsTotal===n.partsTotal
  &&source.sourceEntityCount===n.expectedContentCount;
}
function retained(s:AssignmentSnapshotV2,op:OperationV2):unknown{
 for(const oid of op.observation_ids??[]){const o=s.observations[oid];
  if(!o||o.authority!=='native-host'||o.operation_id!==op.operation_id||o.raw_payload_hash!==op.result?.raw_payload_hash||!sameAssignmentBindingV2(o.binding,op.binding))continue;
  try{const ref=readEvidenceRef(o.raw_payload_ref.replace(/^evidence:/,''));if(ref.byte_count>2_000_000)continue;
   const payload=JSON.parse(readAuthoritativeEvidence(ref,{...op.binding,attempt_id:op.operation_id}).toString('utf8'));
   if(payloadDigestV2(payload).digest===op.result?.raw_payload_hash)return payload;
  }catch{/* Missing exact committed evidence cannot authorize retry or verification. */}
 }return null;
}
function settled(s:AssignmentSnapshotV2,op:OperationV2){
 const a=op.result;
 if(s.unresolved_unknown_operation_ids.length||s.input_invalidated_operation_ids?.includes(op.operation_id)||!sameAssignmentBindingV2(op.binding,s.current_binding)
  ||op.input.method!=='POST'||typeof op.input.path!=='string'||!applyRoutes.includes(op.input.path)||op.request_identity?.path!==op.input.path||op.requested_effect!=='apply'
  ||op.admission_state!=='admitted'||op.dispatch_state!=='dispatched'||op.settlement_state!=='settled'||op.persistent_effect!=='applied'
  ||!a||a.authority!=='native-host'||a.status!=='succeeded'||a.dispatch_state!=='dispatched'||a.native_transaction_state!=='committed'||a.persistent_effect!=='applied'
  ||a.operation_id!==op.operation_id||!sameAssignmentBindingV2(a.binding,op.binding)||a.request_identity?.request_signature!==op.request_identity?.request_signature
  ||a.request_identity?.method!=='POST'||a.request_identity?.path!==op.input.path||!a.native_correlation_id||!a.receipt_id||!Number.isFinite(Date.parse(a.completed_at))
  ||Object.values(s.operations).some(v=>v.requested_effect==='apply'&&v.dispatch_state==='dispatched'&&v.settlement_state!=='settled'))return null;
 const payload=retained(s,op),c=committed(op.input,payload,a.affected_target_identities??[]);return c?{...c,payload}:null;
}
/** A newer manifest head needs actual canonical commits, not a larger read count.
 * The original part's IDs/source/native snapshot are still checked separately. */
export function vectorAnnotationManifestHeadV2(s:AssignmentSnapshotV2,subject:OperationV2,read?:OperationV2){
 const base=settled(s,subject);if(!base?.annotation)return null;
 let head=base;
 const following=Object.values(s.operations).filter(op=>op.operation_id!==subject.operation_id&&op.requested_effect==='apply'&&op.persistent_effect!=='none'
  &&sameAssignmentBindingV2(op.binding,subject.binding)&&Number(op.admitted_assignment_version)>Number(subject.admitted_assignment_version)
  &&(object(op.input.body).manifestElementId===base.applied.manifestElementId
    ||op.input.path===annotationRoute&&object(retained(s,op)).manifestElementId===base.applied.manifestElementId))
  .sort((a,b)=>a.admitted_assignment_version!-b.admitted_assignment_version!);
 for(const op of following){
  const next=settled(s,op);
  if(!next?.annotation||!Number.isSafeInteger(op.settled_assignment_version)
   ||read&&(!Number.isSafeInteger(read.admitted_assignment_version)||op.settled_assignment_version!>=read.admitted_assignment_version!
     ||Date.parse(op.result!.completed_at)>Date.parse(read.opened_at))
   ||next.applied.partIndex!==head.applied.partIndex+1||next.wanted.expectedImportSnapshotSha256!==head.applied.importSnapshotSha256
   ||next.wanted.manifestElementId!==base.applied.manifestElementId
   ||!['manifestElementId','viewId','viewUniqueId','viewName','sourcePath','sourceSha256','nativePlanSha256','nativePlanFileSha256','renderer','partsTotal','expectedContentCount','sourcePlanEntityCount']
      .every(key=>equal(next.applied[key],base.applied[key]))
   ||next.wanted.nativePlanPath!==base.wanted.nativePlanPath)return null;
  head=next;
 }
 return head;
}
export function vectorDetailReadSubjectMatchesV2(s:AssignmentSnapshotV2,op:OperationV2,readInput:unknown):boolean{
 const w=object(readInput);
 if(!applyRoutes.includes(String(op.input.path??''))||w.path!==readRoute)return true;
 const b=object(w.body),c=settled(s,op);
 return !!c&&vectorDetailInspectionReadIdV2(w)===c.applied.manifestElementId&&b.partIndex===c.applied.partIndex;
}
export function vectorAnnotationCheckNeedsRefreshV2(s:AssignmentSnapshotV2,op:OperationV2):boolean{
 return op.input.path===annotationRoute&&!s.terminal&&s.outcome==='active'&&!s.completion_proposal&&s.execution_control?.state!=='paused'
  &&!s.in_flight_operation_ids.length&&appliedOperationHasVerifiedPostconditionV2(s,op.operation_id)&&!checkedEditIsCurrentV2(s,op.operation_id)
  &&!!vectorAnnotationManifestHeadV2(s,op);
}
export function committedVectorAnnotationRefreshPlanV2(s:AssignmentSnapshotV2,op:OperationV2){
 const c=vectorAnnotationCheckNeedsRefreshV2(s,op)?settled(s,op):null;
 return c?{method:'POST',path:readRoute,body:{manifestElementId:c.applied.manifestElementId,partIndex:c.applied.partIndex}}:null;
}
export function committedVectorDetailReadbackPlanV2(s:AssignmentSnapshotV2,op:OperationV2){
 if(s.terminal||s.outcome!=='active'||s.completion_proposal||s.execution_control?.state==='paused'||op.verification_operation_ids.length)return null;
 const c=settled(s,op);return c?{method:'POST',path:readRoute,body:{manifestElementId:c.applied.manifestElementId,partIndex:c.applied.partIndex}}:null;
}
export function vectorDetailImportDeliverableTargetsV2(s:AssignmentSnapshotV2,op:OperationV2):string[]{const c=settled(s,op);return c?[`element_id:${c.applied.viewId}`]:[];}
export function vectorDetailImportPostconditionSatisfiedV2(s:AssignmentSnapshotV2,op:OperationV2,result:OperationResultV2,payload:unknown,proof?:PreparedVectorSourceProofV2|null):boolean{
 const read=s.operations[result.operation_id],c=settled(s,op);
 if(!c||!read||read.requested_effect!=='read'||read.purpose!=='verification'||read.fulfillment_role!=='verification'
  ||read.verification_of_operation_id!==op.operation_id||read.admission_state!=='admitted'||!['dispatching','dispatched'].includes(read.dispatch_state)
  ||read.input.path!==readRoute||read.input.method!=='POST'||s.input_invalidated_operation_ids?.includes(read.operation_id)
  ||!sameAssignmentBindingV2(read.binding,s.current_binding)||!nativePropertyReadIsFreshNativeV2(op,read,result,readRoute)
  ||result.request_identity?.method!=='POST'||result.operation_id!==read.operation_id||result.native_transaction_state!=='not_applicable'||result.dispatch_state!=='dispatched'||!result.receipt_id||!result.native_correlation_id
  ||payloadDigestV2(payload).digest!==result.raw_payload_hash)return false;
 const head=c.annotation?vectorAnnotationManifestHeadV2(s,op,read):c;
 return !!head&&vectorDetailImportReadbackMatchesV2(op.input,c.payload,read.input,payload,op.result!.affected_target_identities??[],proof,result,head.applied);
}
