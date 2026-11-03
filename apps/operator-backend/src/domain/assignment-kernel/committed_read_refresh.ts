import {canonicalJsonV2} from './canonical.js';
import {sameAssignmentBindingV2} from './identity.js';
import {operationProgressIdentityV2} from './progress/controller.js';
import type {OperationV2} from './operation.js';
import type {AssignmentSnapshotV2} from './snapshot.js';
import {nativeDocumentCheckpointResultV2} from '@revitoperator/assignment-kernel-v2-contracts';

const ids=(op:OperationV2)=>new Set([op.target.target_id,...Object.values(op.target.semantic_scope??{})]
 .flatMap(v=>typeof v==='string'&&/^id:[1-9]\d*$/.test(v)?[v.slice(3)]:[]));
function nativeResult(s:AssignmentSnapshotV2,op:OperationV2){
 const r=op.result;
 return op.admission_state==='admitted'&&op.dispatch_authority==='native'&&op.dispatch_state==='dispatched'&&op.settlement_state==='settled'
  &&!op.observation_retention_error&&op.observation_ids.length>0&&op.admitted_assignment_version
  &&op.settled_assignment_version&&op.settled_assignment_version>op.admitted_assignment_version
  &&op.settled_assignment_version<=s.assignment_version&&r?.authority==='native-host'&&r.status==='succeeded'
  &&r.dispatch_state==='dispatched'&&r.operation_id===op.operation_id&&!!r.receipt_id&&!!r.native_correlation_id
  &&/^[a-f0-9]{64}$/.test(r.raw_payload_hash??'')&&!!op.request_identity?.request_signature
  &&r.result_schema_id===`operator-native/${op.request_identity.method}:${op.request_identity.path}/v2`
  &&sameAssignmentBindingV2(op.binding,r.binding)
  &&op.observation_ids.some(id=>{const o=s.observations[id];return o?.operation_id===op.operation_id
    &&o.authority==='native-host'&&sameAssignmentBindingV2(op.binding,o.binding)
    &&o.raw_payload_hash===r.raw_payload_hash&&o.result_schema_id===r.result_schema_id&&!!o.raw_payload_ref;})
  &&canonicalJsonV2(r.request_identity)===canonicalJsonV2(op.request_identity);
}

function readWitness(s:AssignmentSnapshotV2,prior:OperationV2,scope:'target'|'document'):OperationV2|null{
 if(prior.result?.native_transaction_state!=='not_applicable'||prior.persistent_effect!=='none'||prior.result.persistent_effect!=='none')return null;
 if(nativeResult(s,prior))return prior;
 if(scope!=='document'||prior.result.status!=='completed_without_native_dispatch'||prior.result.authority!=='operator-mcp-transport'
  ||prior.result.dispatch_state!=='not_dispatched'||prior.dispatch_state!=='not_dispatched'
  ||prior.result.result_schema_id!==`operator-capability/${prior.capability_id}/v2`
  ||!sameAssignmentBindingV2(prior.binding,prior.result.binding)
  ||canonicalJsonV2(prior.request_identity)!==canonicalJsonV2(prior.result.request_identity))return null;
 const children=Object.values(s.operations).filter(p=>p.parent_operation_id===prior.operation_id);
 if(children.length!==1)return null;const child=children[0]!;
 return child.root_operation_id===prior.operation_id&&child.operation_role==='child'&&child.blocks_parent_settlement===true
  &&child.requested_effect==='read'&&child.persistent_effect==='none'&&child.result?.persistent_effect==='none'
  &&child.result.native_transaction_state==='not_applicable'&&nativeResult(s,child)
  &&sameAssignmentBindingV2(prior.binding,child.binding)&&child.target.document_fingerprint===prior.binding.document_fingerprint
  &&child.admitted_assignment_version!>prior.admitted_assignment_version!&&child.settled_assignment_version!<prior.settled_assignment_version!
  &&!s.input_invalidated_operation_ids?.includes(child.operation_id)&&!child.result.input_schema_gap&&!child.result.result_semantic_gap?child:null;
}
function sameDocumentSave(op:OperationV2){
 const r=op.result,save=r?.native_artifact_receipt?.save_document,body=op.input.body as any;
 const normalized=(p:string)=>p.replace(/\\/g,'/').toLowerCase();
 if(!(r&&r.native_transaction_state==='not_applicable'&&nativeDocumentCheckpointResultV2(r)
  &&save?.same_document===true&&!!save.after&&save.before.project_fingerprint===op.binding.document_fingerprint
  &&save.after.project_fingerprint===op.binding.document_fingerprint&&typeof body?.filePath==='string'))return false;
 const actual=normalized(save.after.path),requested=normalized(body.filePath);
 if(requested===actual&&op.target.target_id===`path:${actual}`)return true;
 // The existing native SaveAs route also accepts a bare model filename and
 // resolves its folder. Do not guess that folder from the filename: require
 // the complete native receipt plus its exact absolute affected artifact.
 // This witnesses a document checkpoint only; it authorizes no file write.
 return /^[^\\/:*?"<>|\u0000-\u001f]+\.rvt$/i.test(body.filePath)&&!body.filePath.includes('..')
  &&actual.endsWith('/'+requested)
  &&(op.target.target_id===undefined||op.target.target_id===`path:${actual}`)
  &&r.affected_target_identities?.some(p=>normalized(p)===`artifact_path:${actual}`)===true;
}

/** One fresh inspection of an unchanged request after a later native commit
 * changed one of its exact declared targets. Recomputed under the journal
 * lock; this is read admission only, never mutation replay or completion proof. */
function readRefreshV2(s:AssignmentSnapshotV2,op:OperationV2,scope:'target'|'document'){
 try{
  if(op.requested_effect!=='read'||!['discovery','verification'].includes(op.purpose)
   ||(op.operation_role??'root')!=='root'||s.terminal||s.completion_proposal
   ||s.execution_control?.state==='paused'||s.unresolved_unknown_operation_ids.length
   ||!op.binding.document_fingerprint||op.target.document_fingerprint!==op.binding.document_fingerprint
   ||!sameAssignmentBindingV2(s.current_binding,op.binding)||!op.request_identity?.request_signature
   ||s.in_flight_operation_ids.some(id=>s.operations[id]?.requested_effect==='apply'))return null;
  const all=Object.values(s.operations),identity=operationProgressIdentityV2(op);
  const prior=all.filter(p=>sameAssignmentBindingV2(op.binding,p.binding)&&operationProgressIdentityV2(p)===identity)
   .sort((a,b)=>(b.admitted_assignment_version??0)-(a.admitted_assignment_version??0))[0];
  if(!prior||prior.requested_effect!=='read'||prior.settlement_state!=='settled'||!readWitness(s,prior,scope)
   ||prior.result?.input_schema_gap||prior.result?.result_semantic_gap
   ||s.input_invalidated_operation_ids?.includes(prior.operation_id)
   ||all.some(p=>p.retry_of_operation_id===prior.operation_id))return null;
  const requested=ids(op);if(scope==='target'&&!requested.size)return null;
  const change=all.filter(p=>{
   if(p.requested_effect!=='apply'||p.persistent_effect!=='applied'||p.result?.persistent_effect!=='applied'
    ||!(p.result.native_transaction_state==='committed'||scope==='document'&&sameDocumentSave(p))||!nativeResult(s,p)
    ||!sameAssignmentBindingV2(op.binding,p.binding)||p.target.document_fingerprint!==op.binding.document_fingerprint
    ||p.admitted_assignment_version!<=prior.settled_assignment_version!
    ||s.input_invalidated_operation_ids?.includes(p.operation_id))return false;
   if(scope==='document')return true;
   const declared=ids(p);
   return p.result.affected_target_identities?.some(v=>{const m=/^(?:element_id|id):([1-9]\d*)$/.exec(v);return !!m&&declared.has(m[1]!)&&requested.has(m[1]!);});
  }).sort((a,b)=>b.settled_assignment_version!-a.settled_assignment_version!)[0];
  return change?{retry_of_operation_id:prior.operation_id,retry_basis:scope==='target'?'committed_target_read' as const:'committed_document_read' as const,retry_after_operation_id:change.operation_id}:null;
 }catch{return null;}
}

export function committedReadRefreshV2(s:AssignmentSnapshotV2,op:OperationV2){return readRefreshV2(s,op,'target');}

/** A sheet can change its derived layout after an edit to a placed schedule,
 * and final content inspection must be fresh after SaveAs. Allow one unchanged
 * native read after a later native commit to the exact same bound document.
 * This separate typed basis cannot replay a write, certify the read's contents,
 * clear a pending inspection, or make any engineering/absence claim. */
export function committedDocumentReadRefreshV2(s:AssignmentSnapshotV2,op:OperationV2){return readRefreshV2(s,op,'document');}
