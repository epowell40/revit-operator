import {MAX_NATIVE_AFFECTED_TARGETS_V2,isCanonicalNativeAffectedTargetSetV2} from '@revitoperator/assignment-kernel-v2-contracts';
import {payloadDigestV2} from '@revitoperator/payload-digest-v2';
import {readAuthoritativeEvidence,readEvidenceRef} from '../evidence/evidence_store.js';
import {canonicalJsonV2,sameAssignmentBindingV2,type AssignmentSnapshotV2,type OperationV2,type OperationResultV2} from '../domain/assignment-kernel/index.js';
import {nativePropertyReadIsFreshNativeV2} from '../assignments/native_observation_inputs_v2.js';

const object=(v:unknown):Record<string,any>=>v&&typeof v==='object'&&!Array.isArray(v)?v as Record<string,any>:{};
const id=(v:unknown):v is number=>Number.isSafeInteger(v)&&Number(v)>0;
const hash=(v:unknown)=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
const equal=(a:unknown,b:unknown)=>canonicalJsonV2(a)===canonicalJsonV2(b);
const ids=(v:unknown,limit:number):v is number[]=>Array.isArray(v)&&v.length>0&&v.length<=limit&&v.every(id)&&new Set(v).size===v.length;
const applyRoute='/revit/import-drawing-spec',readRoute='/revit/inspect-drawing-spec';
const fields=['sourcePath','viewId','viewName','textTypeName','columns','columnWidthInches','columnHeightInches','gutterInches','marginInches','startXInches','startYInches','dryRun'];
export function drawingSpecImportRequestV2(input:unknown){
 const w=object(input),b=object(w.body??input);
 if(w.path!==undefined&&w.path!==applyRoute||typeof b.sourcePath!=='string'||!b.sourcePath.trim()||b.sourcePath.length>520
  ||Object.keys(b).some(k=>!fields.includes(k))||b.dryRun===true||b.dryRun!==undefined&&typeof b.dryRun!=='boolean'
  ||b.viewId!==undefined&&!id(b.viewId)||['viewName','textTypeName'].some(k=>b[k]!==undefined&&(typeof b[k]!=='string'||!b[k].trim()||b[k].length>140))
  ||b.columns!==undefined&&(!Number.isInteger(b.columns)||b.columns<1||b.columns>24)
  ||['columnWidthInches','columnHeightInches','gutterInches','marginInches','startXInches','startYInches'].some(k=>b[k]!==undefined&&(typeof b[k]!=='number'||!Number.isFinite(b[k]))))return null;
 return b;
}
export function drawingSpecInspectionReadIdV2(input:unknown):number|null{
 const w=object(input),b=object(w.body??input);
 return id(b.manifestElementId)&&typeof b.sourcePath==='string'&&!!b.sourcePath.trim()&&b.sourcePath.length<=520
  &&Object.keys(b).every(k=>['sourcePath','manifestElementId','pageSize','pageOffset','expectedSnapshotSha256'].includes(k))
  &&(b.pageSize===undefined||Number.isInteger(b.pageSize)&&b.pageSize>=1&&b.pageSize<=100)
  &&(b.pageOffset===undefined||Number.isInteger(b.pageOffset)&&b.pageOffset>=0&&b.pageOffset<=20000)
  &&(b.expectedSnapshotSha256===undefined||hash(b.expectedSnapshotSha256))?b.manifestElementId:null;
}
function committed(input:unknown,payload:unknown,affected:readonly string[]){
 const wanted=drawingSpecImportRequestV2(input),a=object(payload),tx=object(a.transaction),added=tx.added_element_ids,modified=tx.modified_element_ids,deleted=tx.deleted_element_ids;
 if(!wanted||a.status!=='Success'||a.applied!==true||a.dryRun===true||a.remainingParagraphCount!==0||!id(a.paragraphCount)||a.paragraphCount>20000
  ||!hash(a.sourceSha256)||!hash(a.nativeSnapshotSha256)||!id(a.manifestElementId)||!ids(a.createdTextNoteIds,20000)||!ids(a.viewIds,1000)
  ||tx.committed!==true||tx.status!=='committed'||object(a.changeTracking).exhaustiveChangeInventory!==true
  ||!Array.isArray(added)||!added.length||added.length>MAX_NATIVE_AFFECTED_TARGETS_V2||!added.every(id)||new Set(added).size!==added.length
  ||!Array.isArray(modified)||modified.length>MAX_NATIVE_AFFECTED_TARGETS_V2||!modified.every(id)||new Set(modified).size!==modified.length
  ||!Array.isArray(deleted)||deleted.length||added.some((v:number)=>modified.includes(v))
  ||![a.manifestElementId,...a.createdTextNoteIds].every(v=>added.includes(v))
  ||!a.viewIds.every((v:number)=>added.includes(v)||wanted.viewId===v)
  ||!isCanonicalNativeAffectedTargetSetV2(affected)||new Set(affected).size!==affected.length||!equal([...added,...modified].map(v=>'element_id:'+v).sort(),[...affected].sort()))return null;
 return {wanted,applied:a};
}
/** Proves source text/runs/ownership plus column screens; not visual, sheet or engineering completion. */
export function drawingSpecImportReadbackMatchesV2(input:unknown,applied:unknown,readInput:unknown,payload:unknown,affected:readonly string[]):boolean{
 const c=committed(input,applied,affected),w=object(readInput),b=object(w.body??readInput),n=object(payload),checks=object(n.checks);
 if(!c||drawingSpecInspectionReadIdV2(b)!==c.applied.manifestElementId||b.sourcePath!==c.wanted.sourcePath||(b.pageOffset??0)!==0
  ||n.schema!=='operator.drawing_spec_inspection.v1'||n.status!=='Ok'||n.read_only!==true||n.completeNativeRead!==true
  ||n.sourcePath!==c.wanted.sourcePath||n.sourceSha256!==c.applied.sourceSha256||n.retainedSourceSha256!==c.applied.sourceSha256
  ||n.sourceFileMatchesImport!==true||n.sourceProjectionMatchesImport!==true||n.sourceBodyComplete!==true
  ||n.manifestElementId!==c.applied.manifestElementId||typeof n.manifestUniqueId!=='string'||!n.manifestUniqueId||n.manifestUniqueId.length>1024
  ||!hash(n.inspectionSnapshotSha256)||!hash(n.currentNativeSnapshotSha256)||n.snapshotError!=null
  ||typeof n.nativeSnapshotMatchesImport!=='boolean'||!equal(n.viewIds,c.applied.viewIds)||!equal(n.observedNoteIds,c.applied.createdTextNoteIds)
  ||(b.expectedSnapshotSha256!==undefined&&b.expectedSnapshotSha256!==n.inspectionSnapshotSha256)
  ||n.totalNotes!==c.applied.createdTextNoteIds.length||checks.SourceParagraphs!==c.applied.paragraphCount||!id(checks.SourceCharacters)||checks.SourceCharacters>4000000
  ||checks.NativeNotes!==c.applied.createdTextNoteIds.length||!id(checks.NativeRanges)||checks.NativeRanges>100000||checks.IssueCount!==0
  ||!['SourceCoverageMatches','NativeTextMatches','NativeIdentityAndOwnershipMatches','SourceFormattingMatches','InsideColumnBounds','ReadingOrderMatches'].every(k=>checks[k]===true))return false;
 // A known corrective edit may change the producer snapshot. Fresh source-derived predicates,
 // rather than equality with an earlier bad result, own the current-state verdict.
 return true;
}
function retained(s:AssignmentSnapshotV2,op:OperationV2){
 for(const key of op.observation_ids){const o=s.observations[key];
  if(!o||o.authority!=='native-host'||o.operation_id!==op.operation_id||o.raw_payload_hash!==op.result?.raw_payload_hash||!sameAssignmentBindingV2(o.binding,op.binding))continue;
  try{const ref=readEvidenceRef(o.raw_payload_ref.replace(/^evidence:/,''));if(ref.byte_count>2_000_000)continue;
   const p=JSON.parse(readAuthoritativeEvidence(ref,{...op.binding,attempt_id:op.operation_id}).toString('utf8'));
   if(payloadDigestV2(p).digest===op.result?.raw_payload_hash)return p;
  }catch{/* Missing source-bound native apply evidence never permits a guessed retry. */}
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
 const payload=retained(s,op),c=committed(op.input,payload,a.affected_target_identities??[]);
 return c?{...c,payload}:null;
}
export function committedDrawingSpecImportReadbackPlanV2(s:AssignmentSnapshotV2,op:OperationV2){
 if(s.terminal||s.outcome!=='active'||s.completion_proposal||s.execution_control?.state==='paused'||op.verification_operation_ids.length)return null;
 const c=settled(s,op);return c?{method:'POST',path:readRoute,body:{sourcePath:c.wanted.sourcePath,manifestElementId:c.applied.manifestElementId,pageSize:1}}:null;
}
export function drawingSpecImportPostconditionSatisfiedV2(s:AssignmentSnapshotV2,op:OperationV2,result:OperationResultV2,payload:unknown):boolean{
 const read=s.operations[result.operation_id],c=settled(s,op);
 if(!c||!read||read.requested_effect!=='read'||read.purpose!=='verification'||read.fulfillment_role!=='verification'
  ||read.verification_of_operation_id!==op.operation_id||read.admission_state!=='admitted'||!['dispatching','dispatched'].includes(read.dispatch_state)
  ||read.input.path!==readRoute||read.input.method!=='POST'||s.input_invalidated_operation_ids?.includes(read.operation_id)
  ||!sameAssignmentBindingV2(read.binding,s.current_binding)||!nativePropertyReadIsFreshNativeV2(op,read,result,readRoute)
  ||result.request_identity?.method!=='POST'||result.operation_id!==read.operation_id||result.native_transaction_state!=='not_applicable'||result.dispatch_state!=='dispatched'||!result.receipt_id||!result.native_correlation_id
  ||payloadDigestV2(payload).digest!==result.raw_payload_hash)return false;
 return drawingSpecImportReadbackMatchesV2(op.input,c.payload,read.input,payload,op.result!.affected_target_identities??[]);
}
