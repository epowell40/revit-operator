import path from 'node:path';
import {nativeDocumentCheckpointResultV2} from '@revitoperator/assignment-kernel-v2-contracts';
import {payloadDigestV2} from '@revitoperator/payload-digest-v2';
import {canonicalJsonV2,sameAssignmentBindingV2,type AssignmentSnapshotV2} from '../domain/assignment-kernel/index.js';
import {readAuthoritativeEvidence,readEvidenceRef} from '../evidence/evidence_store.js';

/** Reports a known native SaveAs effect even if later checks did not finish.
 * It is not a content check, criterion pass or progress-credit operation. */
export function savedCopyHandoffV2(snapshot:AssignmentSnapshotV2):null|{text:string;observation_ids:string[]}{
 if(snapshot.unresolved_unknown_operation_ids?.length||snapshot.in_flight_operation_ids?.length)return null;
 const normalize=(value:string)=>path.win32.normalize(value).replaceAll('\\','/').toLowerCase();
 const candidates=Object.values(snapshot.operations).filter(op=>op.requested_effect==='apply'&&op.persistent_effect==='applied')
  .sort((a,b)=>(b.result?.completed_at??'').localeCompare(a.result?.completed_at??''));
 for(const op of candidates){
  const r=op.result,body=op.input?.body as Record<string,unknown>|undefined;
  if(!r||!nativeDocumentCheckpointResultV2(r)||op.admission_state!=='admitted'||op.dispatch_state!=='dispatched'
   ||op.settlement_state!=='settled'||snapshot.input_invalidated_operation_ids?.includes(op.operation_id)
   ||!sameAssignmentBindingV2(op.binding,snapshot.current_binding)||!sameAssignmentBindingV2(r.binding,op.binding)
   ||r.operation_id!==op.operation_id||op.request_identity?.path!=='/revit/save-as'||op.input?.method!=='POST'||op.input.path!==op.request_identity.path
   ||!(/^[a-f0-9]{64}$/i).test(op.request_identity.request_signature)||r.request_identity?.request_signature!==op.request_identity.request_signature||!Number.isFinite(Date.parse(r.completed_at))
   ||!body||body.dryRun===true||typeof body.filePath!=='string')continue;
  const saved=r.native_artifact_receipt?.save_document,output=r.native_artifact_receipt?.outputs?.[0];
  if(!saved?.after||!output||output.stable_read!==true||!path.win32.isAbsolute(saved.after.path)||saved.project_binding_changed
   ||saved.before.project_fingerprint!==op.binding.document_fingerprint||saved.after.project_fingerprint!==op.binding.document_fingerprint)continue;
  const expected=path.win32.isAbsolute(body.filePath)?body.filePath:path.win32.resolve(path.win32.dirname(saved.before.path),body.filePath);
  if(normalize(expected)!==normalize(saved.after.path)||normalize(output.path)!==normalize(saved.after.path)
   ||candidates.some(later=>later.operation_id!==op.operation_id&&(later.result?.completed_at??later.opened_at)>r.completed_at))continue;
  for(const id of op.observation_ids){
   const o=snapshot.observations[id];
   if(!o||o.operation_id!==op.operation_id||o.authority!=='native-host'||!sameAssignmentBindingV2(o.binding,op.binding)
    ||o.raw_payload_hash!==r.raw_payload_hash||!o.raw_payload_ref.startsWith('evidence:'))continue;
   try{
    const ref=readEvidenceRef(o.raw_payload_ref.slice(9));
    const raw=JSON.parse(readAuthoritativeEvidence(ref,{...op.binding,attempt_id:op.operation_id}).toString('utf8'));
    if(payloadDigestV2(raw).digest!==r.raw_payload_hash||canonicalJsonV2(raw.artifact_receipt)!==canonicalJsonV2(r.native_artifact_receipt))continue;
    return {text:`${saved.document_path_changed?'Saved copy':'Saved model'}: ${path.win32.basename(saved.after.path)}. Final content verification is pending.`,observation_ids:[id]};
   }catch{/* Missing, foreign or mismatched retained evidence cannot support delivery. */}
  }
 }
 return null;
}
