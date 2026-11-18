import path from 'node:path';
import {nativeDocumentCheckpointResultV2} from '@revitoperator/assignment-kernel-v2-contracts';
import {payloadDigestV2} from '@revitoperator/payload-digest-v2';
import {canonicalJsonV2,sameAssignmentBindingV2,verificationOperationHasVerifiedPostconditionV2,type AssignmentSnapshotV2,type OperationV2} from '../domain/assignment-kernel/index.js';
import {readAuthoritativeEvidence,readEvidenceRef} from '../evidence/evidence_store.js';
import {familySessionSavedV1} from '../verification/family_session_open_v1.js';
import {savedDocumentPostconditionV2} from '../verification/saved_document_postcondition_v2.js';

const normalized=(value:string)=>path.win32.normalize(value).replaceAll('\\','/').toLowerCase();
const hash=(value:unknown)=>typeof value==='string'&&/^[a-f0-9]{64}$/i.test(value);

function boundNativeOperation(snapshot:AssignmentSnapshotV2,operation:OperationV2):boolean {
 const result=operation.result,request=operation.request_identity;
 return Boolean(result&&request&&result.authority==='native-host'
  &&operation.admission_state==='admitted'&&operation.dispatch_state==='dispatched'&&operation.settlement_state==='settled'
  &&!snapshot.input_invalidated_operation_ids?.includes(operation.operation_id)
  &&sameAssignmentBindingV2(operation.binding,snapshot.current_binding)&&sameAssignmentBindingV2(result.binding,operation.binding)
  &&operation.operation_id===result.operation_id&&request.path===operation.input.path&&request.method===operation.input.method
  &&hash(request.request_signature)&&result.request_identity?.request_signature===request.request_signature
  &&result.request_identity.path===request.path&&result.request_identity.method===request.method);
}

function nativePayload(snapshot:AssignmentSnapshotV2,operation:OperationV2,accept:(raw:Record<string,unknown>)=>boolean) {
 for(const id of operation.observation_ids){
  const o=snapshot.observations[id];
  if(!o||o.operation_id!==operation.operation_id||o.authority!=='native-host'||!sameAssignmentBindingV2(o.binding,operation.binding)
   ||o.raw_payload_hash!==operation.result?.raw_payload_hash||!o.raw_payload_ref.startsWith('evidence:'))continue;
  try{
   const ref=readEvidenceRef(o.raw_payload_ref.slice(9));
   if(ref.trust_level!=='authoritative_native')continue;
   const raw=JSON.parse(readAuthoritativeEvidence(ref,{...operation.binding,attempt_id:operation.operation_id}).toString('utf8'));
   if(payloadDigestV2(raw).digest===o.raw_payload_hash&&accept(raw))return id;
  }catch{/* Unavailable, foreign or mismatched evidence cannot support delivery. */}
 }
 return null;
}

function latestSavedProject(snapshot:AssignmentSnapshotV2, eligible:(save:OperationV2,file:string)=>boolean){
 const candidates=Object.values(snapshot.operations).filter(op=>op.requested_effect==='apply'&&op.persistent_effect==='applied')
  .sort((a,b)=>(b.result?.completed_at??'').localeCompare(a.result?.completed_at??''));
 for(const op of candidates){
  const r=op.result,body=op.input?.body as Record<string,unknown>|undefined;
  if(!r||!nativeDocumentCheckpointResultV2(r)||!boundNativeOperation(snapshot,op)
   ||op.input.path!=='/revit/save-as'||op.input.method!=='POST'||!Number.isFinite(Date.parse(r.completed_at))
   ||!body||body.dryRun===true||typeof body.filePath!=='string')continue;
  const saved=r.native_artifact_receipt?.save_document,output=r.native_artifact_receipt?.outputs?.[0];
  if(!saved?.after||!output||output.stable_read!==true||!path.win32.isAbsolute(saved.after.path)||saved.project_binding_changed
   ||saved.before.project_fingerprint!==op.binding.document_fingerprint||saved.after.project_fingerprint!==op.binding.document_fingerprint)continue;
  const file=saved.after.path;
  const expected=path.win32.isAbsolute(body.filePath)?body.filePath:path.win32.resolve(path.win32.dirname(saved.before.path),body.filePath);
  if(normalized(expected)!==normalized(file)||normalized(output.path)!==normalized(file)||!eligible(op,file))continue;
  const id=nativePayload(snapshot,op,raw=>canonicalJsonV2(raw.artifact_receipt)===canonicalJsonV2(r.native_artifact_receipt));
  if(id)return {file,copy:saved.document_path_changed,created_at:r.completed_at,observation_id:id};
 }
 return null;
}

/** Reports a native Save As when later checks have stopped.
 * It does not establish design, content coverage or task completion. */
export function savedCopyHandoffV2(snapshot:AssignmentSnapshotV2):null|{text:string;observation_ids:string[]}{
 if(snapshot.unresolved_unknown_operation_ids?.length||snapshot.in_flight_operation_ids?.length)return null;
 const saved=latestSavedProject(snapshot,save=>!Object.values(snapshot.operations).some(later=>
  later.operation_id!==save.operation_id&&later.requested_effect==='apply'&&later.persistent_effect==='applied'
  &&(later.result?.completed_at??later.opened_at)>save.result!.completed_at));
 if(!saved)return null;
 return {text:`${saved.copy?'Saved copy':'Saved model'}: ${path.win32.basename(saved.file)}. Final content verification is pending.\nSaved file: ${saved.file}`,observation_ids:[saved.observation_id]};
}

function localFile(pathname:unknown,extension:string):pathname is string{
 return typeof pathname==='string'&&pathname.length<=2000&&/^[a-z]:[\\/]/i.test(pathname)
  &&!/[\u0000-\u001f]/.test(pathname)&&path.win32.extname(pathname).toLowerCase()===extension;
}

/** An independently checked copy of the project at its saved checkpoint.
 * An outstanding model response cannot change these facts. Native work,
 * uncertain effects and a later committed edit can supersede the checkpoint. */
export function savedProjectCheckpointV2(snapshot:AssignmentSnapshotV2){
 if(snapshot.terminal||snapshot.outcome!=='active'||snapshot.spec.requested_effect!=='apply'
  ||snapshot.in_flight_operation_ids.length||snapshot.unresolved_unknown_operation_ids.length)return null;
 return latestSavedProject(snapshot,(save,file)=>{
  if(!localFile(file,'.rvt')||save.result?.native_artifact_receipt?.save_document?.document_path_changed!==true
   ||!save.settled_assignment_version)return false;
  if(Object.values(snapshot.operations).some(op=>op.operation_id!==save.operation_id&&op.persistent_effect!=='none'
    &&(!op.settled_assignment_version||op.settled_assignment_version>save.settled_assignment_version!)))return false;
  return save.verification_operation_ids.some(id=>{
   const read=snapshot.operations[id],result=read?.result;
   return read?.verification_of_operation_id===save.operation_id&&result?.dispatch_state==='dispatched'
    &&result.result_schema_id==='operator-native/POST:/revit/inspect-exported-files/v2'
    &&boundNativeOperation(snapshot,read)&&verificationOperationHasVerifiedPostconditionV2(snapshot,id)
    &&Date.parse(read.opened_at)>=Date.parse(save.result!.completed_at)
    &&nativePayload(snapshot,read,raw=>savedDocumentPostconditionV2(save.input,save.result!.native_artifact_receipt,raw,read.input))!==null;
  });
 });
}

function isolatedFamilyOpen(operation:OperationV2,body:Record<string,unknown>,savedFile:string):boolean {
 return operation.input.path==='/revit/open-model'&&operation.result?.status==='failed_after_dispatch'
  &&localFile(body.filePath,'.rfa')&&normalized(body.filePath)!==normalized(savedFile)
  &&Object.entries(body).every(([key,value])=>key==='filePath'
     ||(['audit','detach','discardExistingOpenDocument','continueOnUnresolvedReferences'].includes(key)&&value===false));
}

function preservesEarlierFile(snapshot:AssignmentSnapshotV2,save:OperationV2,file:string):boolean {
 if(!localFile(file,'.rvt')||!save.settled_assignment_version)return false;
 const pending=new Set(snapshot.unresolved_unknown_operation_ids);
 for(const op of Object.values(snapshot.operations)){
  if(op.persistent_effect==='none')continue;
  const version=op.settled_assignment_version;
  if(!version)return false;
  if(version<=save.settled_assignment_version){
   if(pending.has(op.operation_id))return false;
   continue;
  }
  if(!op.admitted_assignment_version||op.admitted_assignment_version<=save.settled_assignment_version
    ||op.requested_effect!=='apply'||op.input.method!=='POST'||!boundNativeOperation(snapshot,op))return false;
  const body=op.input.body as Record<string,unknown>|undefined;
  if(!body||typeof body!=='object'||Array.isArray(body))return false;
  if(op.persistent_effect==='unknown'&&pending.has(op.operation_id)&&isolatedFamilyOpen(op,body,file)){
   pending.delete(op.operation_id);
  }else if(op.persistent_effect!=='applied'||op.input.path!=='/revit/save-family-doc'||op.result?.status!=='succeeded'
   ||!nativePayload(snapshot,op,raw=>familySessionSavedV1('/revit/save-family-doc',body,raw)
      &&localFile(raw.filePath,'.rfa')&&normalized(raw.filePath)!==normalized(file))){
   return false;
  }
 }
 return pending.size===0;
}

/** Historical output for the selected task's conversation. Later work must
 * have a separate native scope. This does not recheck the file's current bytes. */
export function savedProjectBeforeInterruptionV2(snapshot:AssignmentSnapshotV2){
 if(snapshot.terminal||snapshot.outcome!=='active'||snapshot.spec.requested_effect!=='apply'||!snapshot.unresolved_unknown_operation_ids.length
  ||snapshot.in_flight_operation_ids.length||snapshot.in_flight_provider_call_ids.length||snapshot.provider_usage_hold
  ||snapshot.pending_review_ids.length||snapshot.execution_control?.state==='paused')return null;
 return latestSavedProject(snapshot,(save,file)=>preservesEarlierFile(snapshot,save,file));
}
