import {MAX_NATIVE_AFFECTED_TARGETS_V2,isCanonicalNativeAffectedTargetSetV2} from '@revitoperator/assignment-kernel-v2-contracts';
import {payloadDigestV2} from '@revitoperator/payload-digest-v2';
import {readAuthoritativeEvidence,readEvidenceRef} from '../evidence/evidence_store.js';
import {canonicalJsonV2,sameAssignmentBindingV2,type AssignmentSnapshotV2,type OperationV2,type OperationResultV2} from '../domain/assignment-kernel/index.js';
import {nativePropertyReadIsFreshNativeV2} from '../assignments/native_observation_inputs_v2.js';
import {vectorSourceProofRecordV2,type PreparedVectorSourceProofV2} from './vector_detail_source_proof_v2.js';

const object=(v:unknown):Record<string,any>=>v&&typeof v==='object'&&!Array.isArray(v)?v as Record<string,any>:{};
const id=(v:unknown):v is number=>Number.isSafeInteger(v)&&Number(v)>0;
const hash=(v:unknown)=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
const equal=(a:unknown,b:unknown)=>canonicalJsonV2(a)===canonicalJsonV2(b);
const ids=(v:unknown):v is number[]=>Array.isArray(v)&&v.length<=MAX_NATIVE_AFFECTED_TARGETS_V2&&v.every(id)&&new Set(v).size===v.length;
const applyRoute='/revit/import-vector-detail',readRoute='/revit/inspect-vector-detail';
export const VECTOR_DETAIL_PART_SEMANTIC_V2='vector_detail.part_original_source_and_native_projection';
export const VECTOR_DETAIL_SOURCE_FACT_V2='verification.vector_original_source_comparison';
export function vectorDetailImportRequestV2(input:unknown){
 const w=object(input),b=object(w.body??input);
 if(w.path!==undefined&&w.path!==applyRoute||typeof b.sourcePath!=='string'||!/^artifacts\/uploads\/[^/\\\r\n]+$/.test(b.sourcePath)||b.sourcePath.length>520
  ||typeof b.nativePlanPath!=='string'||!/^artifacts\/drafting-vector\/source-[a-f0-9]{64}\.json\.gz$/.test(b.nativePlanPath)
  ||!hash(b.expectedSourceSha256)||!hash(b.expectedNativePlanFileSha256)||!hash(b.expectedNativePlanSha256)
  ||typeof b.viewName!=='string'||!b.viewName.trim()||b.viewName.length>160||b.dryRun===true||b.dryRun!==undefined&&typeof b.dryRun!=='boolean'
  ||Object.keys(b).some(k=>!['sourcePath','expectedSourceSha256','nativePlanPath','expectedNativePlanFileSha256','expectedNativePlanSha256','viewName','partIndex','manifestElementId','expectedImportSnapshotSha256','dryRun'].includes(k))
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
 if(!wanted||a.status!=='Success'||a.applied!==true||a.dryRun===true||!id(a.manifestElementId)||!id(a.viewId)||a.viewName!==wanted.viewName.trim()
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
    :!added.includes(a.manifestElementId)||!added.includes(a.viewId))
  ||!isCanonicalNativeAffectedTargetSetV2(affected)||!equal([...added,...modified].map(v=>'element_id:'+v).sort(),[...affected].sort()))return null;
 return{wanted,applied:a};
}
export function vectorDetailImportReadbackMatchesV2(input:unknown,applied:unknown,readInput:unknown,payload:unknown,affected:readonly string[],proof:PreparedVectorSourceProofV2|null|undefined,result:OperationResultV2):boolean{
 const c=committed(input,applied,affected),n=object(payload),b=object(object(readInput).body??readInput),projection=object(n.sourceProjection),source=vectorSourceProofRecordV2(proof,result);
 return !!c&&source?.matches===true&&vectorDetailInspectionReadIdV2(readInput)===c.applied.manifestElementId&&b.partIndex===c.applied.partIndex
  &&n.schema==='operator.vector-drafting-native-inspection.v1'&&n.read_only===true&&n.nativeSnapshotMatchesImport===true&&n.snapshotError==null
  &&n.manifestElementId===c.applied.manifestElementId&&n.partIndex===c.applied.partIndex&&n.viewId===c.applied.viewId&&n.viewName===c.applied.viewName
  &&n.sourcePath===c.wanted.sourcePath&&n.sourceSha256===c.applied.sourceSha256&&n.sourceFileCurrent===true&&n.sourceFileError==null
  &&n.nativePlanPath===c.wanted.nativePlanPath&&n.nativePlanSha256===c.applied.nativePlanSha256&&n.nativePlanFileSha256===c.applied.nativePlanFileSha256
  &&n.partNativeSnapshotSha256===c.applied.partNativeSnapshotSha256&&hash(n.importSnapshotSha256)
  &&n.partsTotal===c.applied.partsTotal&&equal(n.completedPartIndices,Array.from({length:c.applied.completedParts},(_,i)=>i))
  &&equal(n.remainingPartIndices,c.applied.remainingPartIndices)&&equal(n.observedEntityIds,c.applied.createdEntityIds)
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
  ||op.input.method!=='POST'||op.input.path!==applyRoute||op.request_identity?.path!==applyRoute||op.requested_effect!=='apply'
  ||op.admission_state!=='admitted'||op.dispatch_state!=='dispatched'||op.settlement_state!=='settled'||op.persistent_effect!=='applied'
  ||!a||a.authority!=='native-host'||a.status!=='succeeded'||a.dispatch_state!=='dispatched'||a.native_transaction_state!=='committed'||a.persistent_effect!=='applied'
  ||a.operation_id!==op.operation_id||!sameAssignmentBindingV2(a.binding,op.binding)||a.request_identity?.request_signature!==op.request_identity.request_signature
  ||a.request_identity?.method!=='POST'||a.request_identity?.path!==applyRoute||!a.native_correlation_id||!a.receipt_id||!Number.isFinite(Date.parse(a.completed_at))
  ||Object.values(s.operations).some(v=>v.requested_effect==='apply'&&v.dispatch_state==='dispatched'&&v.settlement_state!=='settled'))return null;
 const payload=retained(s,op),c=committed(op.input,payload,a.affected_target_identities??[]);return c?{...c,payload}:null;
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
 return vectorDetailImportReadbackMatchesV2(op.input,c.payload,read.input,payload,op.result!.affected_target_identities??[],proof,result);
}
