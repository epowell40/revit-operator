import {MAX_NATIVE_AFFECTED_TARGETS_V2,isCanonicalNativeAffectedTargetSetV2} from '@revitoperator/assignment-kernel-v2-contracts';
import {payloadDigestV2} from '@revitoperator/payload-digest-v2';
import {readAuthoritativeEvidence,readEvidenceRef} from '../evidence/evidence_store.js';
import {canonicalJsonV2,sameAssignmentBindingV2,type AssignmentSnapshotV2,type OperationV2,type OperationResultV2} from '../domain/assignment-kernel/index.js';
import {nativePropertyReadIsFreshNativeV2} from '../assignments/native_observation_inputs_v2.js';

const object=(v:unknown):Record<string,any>=>v&&typeof v==='object'&&!Array.isArray(v)?v as Record<string,any>:{};
const id=(v:unknown):v is number=>Number.isSafeInteger(v)&&Number(v)>0;
const hash=(v:unknown)=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
const equal=(a:unknown,b:unknown)=>canonicalJsonV2(a)===canonicalJsonV2(b);
const ids=(v:unknown):v is number[]=>Array.isArray(v)&&v.length<=MAX_NATIVE_AFFECTED_TARGETS_V2&&v.every(id)&&new Set(v).size===v.length;
const applyRoute='/revit/import-excel-output',readRoute='/revit/inspect-excel-import';
export const EXCEL_TABLE_PART_SEMANTIC_V2='excel_table.part_source_format_and_bounds';
export function excelTableImportRequestV2(input:unknown){
 const w=object(input),b=object(w.body??input);
 if(w.path!==undefined&&w.path!==applyRoute||typeof b.sourcePath!=='string'||!b.sourcePath.trim()||b.sourcePath.length>520
  ||typeof b.sheetName!=='string'||!b.sheetName.trim()||b.sheetName.length>128||!hash(b.expectedSourceSha256)
  ||typeof b.viewName!=='string'||!b.viewName.trim()||b.viewName.length>110||b.dryRun===true||b.dryRun!==undefined&&typeof b.dryRun!=='boolean'
  ||Object.keys(b).some(k=>!['sourcePath','sheetName','expectedSourceSha256','viewName','partIndex','manifestElementId','expectedImportSnapshotSha256','textTypeName','layout','borderWeights','dryRun'].includes(k))
  ||b.partIndex!==undefined&&(!Number.isInteger(b.partIndex)||b.partIndex<0||b.partIndex>499)
  ||(b.partIndex??0)>0&&!id(b.manifestElementId)||b.manifestElementId!==undefined&&(!id(b.manifestElementId)||!hash(b.expectedImportSnapshotSha256))
  ||b.manifestElementId===undefined&&b.expectedImportSnapshotSha256!==undefined)return null;
 return b;
}
export function excelTableInspectionReadIdV2(input:unknown):number|null{
 const w=object(input),b=object(w.body??input);
 return id(b.manifestElementId)&&Number.isInteger(b.partIndex)&&b.partIndex>=0&&b.partIndex<500&&typeof b.sourcePath==='string'&&!!b.sourcePath.trim()&&b.sourcePath.length<=520
  &&(b.action===undefined||b.action==='inspect')&&(b.section===undefined||b.section==='summary')&&(b.pageOffset===undefined||b.pageOffset===0)
  &&(b.pageSize===undefined||Number.isInteger(b.pageSize)&&b.pageSize>=1&&b.pageSize<=100)
  &&(b.expectedInspectionSnapshotSha256===undefined||hash(b.expectedInspectionSnapshotSha256))
  &&Object.keys(b).every(k=>['action','sourcePath','manifestElementId','partIndex','section','pageOffset','pageSize','expectedInspectionSnapshotSha256'].includes(k))?b.manifestElementId:null;
}
function committed(input:unknown,payload:unknown,affected:readonly string[]){
 const wanted=excelTableImportRequestV2(input),a=object(payload),tx=object(a.transaction),added=tx.added_element_ids,modified=tx.modified_element_ids,deleted=tx.deleted_element_ids;
 if(!wanted||a.status!=='Success'||a.applied!==true||a.dryRun===true||!id(a.manifestElementId)||!id(a.partManifestElementId)||!id(a.viewId)
  ||a.partIndex!==(wanted.partIndex??0)||!id(a.partsTotal)||a.partsTotal>500||a.partsImported!==a.partIndex+1||a.partsImported>a.partsTotal
  ||a.sourceSha256!==wanted.expectedSourceSha256||typeof a.worksheet!=='string'||a.worksheet.toLowerCase()!==wanted.sheetName.trim().toLowerCase()
  ||!hash(a.planSha256)||!hash(a.partNativeSnapshotSha256)||!hash(a.importSnapshotSha256)||!ids(a.createdTextNoteIds)||!ids(a.createdBorderIds)
  ||!id(a.sourceCellCount)||a.sourceCellCount>100000||!Number.isInteger(a.sourceCachedErrorCount)||a.sourceCachedErrorCount<0||a.calculationPerformed!==false
  ||!equal(a.remainingPartIndices,Array.from({length:a.partsTotal-a.partsImported},(_,i)=>a.partsImported+i))||a.nextPartIndex!==(a.partsImported<a.partsTotal?a.partsImported:null)
  ||tx.committed!==true||tx.status!=='committed'||object(a.changeTracking).exhaustiveChangeInventory!==true
  ||!ids(added)||!added.length||!ids(modified)||!ids(deleted)||deleted.length||added.some(v=>modified.includes(v))
  ||!added.includes(a.partManifestElementId)||!added.includes(a.viewId)||![...a.createdTextNoteIds,...a.createdBorderIds].every(v=>added.includes(v))
  ||new Set([...a.createdTextNoteIds,...a.createdBorderIds]).size!==a.createdTextNoteIds.length+a.createdBorderIds.length
  ||(wanted.manifestElementId!==undefined?(a.manifestElementId!==wanted.manifestElementId||!modified.includes(a.manifestElementId)||modified.some(v=>v!==a.manifestElementId))
    :(!added.includes(a.manifestElementId)||modified.length>0))
  ||!isCanonicalNativeAffectedTargetSetV2(affected)||!equal([...added,...modified].map(v=>'element_id:'+v).sort(),[...affected].sort()))return null;
 return {wanted,applied:a};
}
/** One committed part's source/native content, formatting and geometric screens. Not visual, sheet or engineering proof. */
export function excelTableImportReadbackMatchesV2(input:unknown,applied:unknown,readInput:unknown,payload:unknown,affected:readonly string[]):boolean{
 const c=committed(input,applied,affected),w=object(readInput),b=object(w.body??readInput),n=object(payload),checks=object(n.checks),text=object(checks.Text),projection=object(n.sourceProjection);
 return !!c&&excelTableInspectionReadIdV2(b)===c.applied.manifestElementId&&b.partIndex===c.applied.partIndex&&b.sourcePath===c.wanted.sourcePath
  &&n.schema==='operator.xlsx_import_inspection.v1'&&n.status==='Ok'&&n.read_only===true&&n.completeNativePartRead===true
  &&n.manifestElementId===c.applied.manifestElementId&&typeof n.manifestUniqueId==='string'&&!!n.manifestUniqueId&&n.manifestUniqueId.length<=1024
  &&n.partManifestElementId===c.applied.partManifestElementId&&n.partIndex===c.applied.partIndex&&n.viewId===c.applied.viewId
  &&n.sourcePath===c.wanted.sourcePath&&n.sourceSha256===c.applied.sourceSha256&&n.retainedSourceSha256===c.applied.sourceSha256&&n.sourceFileMatchesImport===true
  &&n.planSha256===c.applied.planSha256&&n.partNativeSnapshotSha256===c.applied.partNativeSnapshotSha256&&n.retainedPartNativeSnapshotSha256===c.applied.partNativeSnapshotSha256
  &&n.nativeSnapshotMatchesImport===true&&n.snapshotError==null&&hash(n.importSnapshotSha256)&&hash(n.inspectionSnapshotSha256)
  &&(b.expectedInspectionSnapshotSha256===undefined||b.expectedInspectionSnapshotSha256===n.inspectionSnapshotSha256)
  &&projection.Matches===true&&projection.IssueCount===0&&projection.SourceCellCount===c.applied.sourceCellCount
  &&n.sourceCachedErrorCount===c.applied.sourceCachedErrorCount&&n.calculationPerformed===false
  &&equal(n.observedNoteIds,c.applied.createdTextNoteIds)&&equal(n.observedBorderIds,c.applied.createdBorderIds)
  &&checks.IssueCount===0&&checks.InsideCellBounds===true&&checks.CellReadingOrderMatches===true&&checks.NativeBordersMatch===true
  &&text.IssueCount===0&&text.NativeNotes===c.applied.createdTextNoteIds.length
  &&['SourceCoverageMatches','NativeTextMatches','NativeIdentityAndOwnershipMatches','SourceFormattingMatches'].every(k=>text[k]===true);
}
function retained(s:AssignmentSnapshotV2,op:OperationV2):unknown{
 for(const oid of op.observation_ids??[]){const o=s.observations[oid];
  if(!o||o.authority!=='native-host'||o.operation_id!==op.operation_id||o.raw_payload_hash!==op.result?.raw_payload_hash||!sameAssignmentBindingV2(o.binding,op.binding))continue;
  try{const ref=readEvidenceRef(o.raw_payload_ref.replace(/^evidence:/,''));if(ref.byte_count>2_000_000)continue;
   const payload=JSON.parse(readAuthoritativeEvidence(ref,{...op.binding,attempt_id:op.operation_id}).toString('utf8'));
   if(payloadDigestV2(payload).digest===op.result?.raw_payload_hash)return payload;
  }catch{/* Missing exact native apply evidence cannot authorize a guessed retry. */}
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
export function committedExcelTableImportReadbackPlanV2(s:AssignmentSnapshotV2,op:OperationV2){
 if(s.terminal||s.outcome!=='active'||s.completion_proposal||s.execution_control?.state==='paused'||op.verification_operation_ids.length)return null;
 const c=settled(s,op);return c?{method:'POST',path:readRoute,body:{sourcePath:c.wanted.sourcePath,manifestElementId:c.applied.manifestElementId,partIndex:c.applied.partIndex,pageSize:1}}:null;
}
export function excelTableImportPostconditionSatisfiedV2(s:AssignmentSnapshotV2,op:OperationV2,result:OperationResultV2,payload:unknown):boolean{
 const read=s.operations[result.operation_id],c=settled(s,op);
 if(!c||!read||read.requested_effect!=='read'||read.purpose!=='verification'||read.fulfillment_role!=='verification'
  ||read.verification_of_operation_id!==op.operation_id||read.admission_state!=='admitted'||!['dispatching','dispatched'].includes(read.dispatch_state)
  ||read.input.path!==readRoute||read.input.method!=='POST'||s.input_invalidated_operation_ids?.includes(read.operation_id)
  ||!sameAssignmentBindingV2(read.binding,s.current_binding)||!nativePropertyReadIsFreshNativeV2(op,read,result,readRoute)
  ||result.request_identity?.method!=='POST'||result.operation_id!==read.operation_id||result.native_transaction_state!=='not_applicable'||result.dispatch_state!=='dispatched'||!result.receipt_id||!result.native_correlation_id
  ||payloadDigestV2(payload).digest!==result.raw_payload_hash)return false;
 return excelTableImportReadbackMatchesV2(op.input,c.payload,read.input,payload,op.result!.affected_target_identities??[]);
}
