import {createHash} from 'node:crypto';
import {payloadDigestV2} from '@revitoperator/payload-digest-v2';
import {readAuthoritativeEvidence,readEvidenceRef} from '../evidence/evidence_store.js';
import {canonicalJsonV2,sameAssignmentBindingV2,type AssignmentSnapshotV2,type OperationV2} from '../domain/assignment-kernel/index.js';
import {appliedOperationHasVerifiedPostconditionV2} from '../domain/assignment-kernel/outcome.js';
import {nativeProgramParameterChecksV2,nativeProgramParameterPostconditionSatisfiedV2} from '../verification/native_program_parameter_postcondition_v2.js';

const row=(v:unknown):Record<string,any>=>v&&typeof v==='object'&&!Array.isArray(v)?v as Record<string,any>:{};
const label=(v:string)=>v.replace(/[\u0000-\u001f\u007f]/g,' ').slice(0,4096)+(v.length>4096?'… [display shortened]':'');
function payload(snapshot:AssignmentSnapshotV2,operation:OperationV2,id:string){
 const o=snapshot.observations[id],r=operation.result;
 if(!o||!r||o.operation_id!==operation.operation_id||o.authority!=='native-host'
  ||!sameAssignmentBindingV2(o.binding,snapshot.current_binding)||o.raw_payload_hash!==r.raw_payload_hash)return null;
 try{const ref=readEvidenceRef(o.raw_payload_ref.replace(/^evidence:/,''));
  if(ref.trust_level!=='authoritative_native'||ref.byte_count>8*1024*1024)return null;
  const p=JSON.parse(readAuthoritativeEvidence(ref,{...snapshot.current_binding,attempt_id:operation.operation_id}).toString('utf8'));
  return payloadDigestV2(p).digest===o.raw_payload_hash?{p:row(p),ref}:null;
 }catch{return null;}
}
function current(snapshot:AssignmentSnapshotV2,op:OperationV2){
 const r=op.result;
 return r&&op.admission_state==='admitted'&&op.dispatch_state==='dispatched'&&op.settlement_state==='settled'
  &&r.status==='succeeded'&&r.authority==='native-host'&&r.dispatch_state==='dispatched'
  &&sameAssignmentBindingV2(op.binding,snapshot.current_binding)&&sameAssignmentBindingV2(r.binding,snapshot.current_binding)
  &&!snapshot.input_invalidated_operation_ids?.includes(op.operation_id)&&Number.isFinite(Date.parse(r.completed_at))&&Number.isFinite(Date.parse(op.opened_at))
  &&!Object.values(snapshot.operations).some(other=>other.operation_id!==op.operation_id&&other.requested_effect==='apply'
   &&['applied','unknown'].includes(other.persistent_effect)&&Date.parse(other.result?.completed_at??other.opened_at)>Date.parse(op.requested_effect==='read'?op.opened_at:r.completed_at));
}

/** Delivery only: program-return text remains explicitly labelled output,
 * never a semantic fact, an independent check, or authority to complete work.
 * Checked fields use the existing exact paired native comparator. */
export function nativeProgramResultPresentationV2(snapshot:AssignmentSnapshotV2):{summary:string;observation_ids:string[]}|null{
 if(!snapshot.terminal||!['complete','verified_noop','complete_with_issues'].includes(snapshot.outcome)
  ||snapshot.execution_control?.state==='paused'||snapshot.unresolved_unknown_operation_ids?.length)return null;
 const lines:string[]=[],ids=new Set<string>();
 for(const op of Object.values(snapshot.operations)){
  if(op.capability_id!=='operator_run_dynamic_revit_program'||!current(snapshot,op))continue;
  if(op.requested_effect==='apply'&&appliedOperationHasVerifiedPostconditionV2(snapshot,op.operation_id)){
   for(const rid of op.verification_operation_ids){const read=snapshot.operations[rid];if(!read||!current(snapshot,read)||!read.result)continue;
    for(const oid of read.observation_ids){const found=payload(snapshot,read,oid);
     if(!found||!nativeProgramParameterPostconditionSatisfiedV2(snapshot,op,read.result,found.p))continue;
     for(const check of nativeProgramParameterChecksV2(snapshot,op)??[]){
      const item=found.p.items.find((v:any)=>v.id===check.element_id);
      lines.push(`Verified native parameter — element ${check.element_id}, ${label(check.parameter_name)}: ${label(item.parameters[check.parameter_name])}`);
     }
     ids.add(oid);
    }
   }
  }
 }
 const reads=Object.values(snapshot.operations).filter(op=>op.capability_id==='operator_run_dynamic_revit_program'
  &&op.requested_effect==='read'&&op.persistent_effect==='none'&&current(snapshot,op))
  .sort((a,b)=>Date.parse(b.result!.completed_at)-Date.parse(a.result!.completed_at));
 for(const op of reads){
  const args=row(row(op.input).arguments??op.input),r=op.result!;
  if(args.mode!=='read'||typeof args.source!=='string'||r.result_schema_id!=='operator-dynamic-runtime/mcp-program/v2'
   ||r.native_transaction_state!=='not_started'||!r.receipt_id||!r.native_correlation_id
   ||r.request_identity?.request_signature!==op.request_identity?.request_signature
   ||op.request_identity?.request_signature!==createHash('sha256').update(canonicalJsonV2({capability_id:op.capability_id,input:op.input})).digest('hex'))continue;
  for(const oid of op.observation_ids){const found=payload(snapshot,op,oid);if(!found)continue;
   try{const p=found.p,e=row(p.evidence),n=JSON.parse(e.nativeExecutionReceipt),prep=JSON.parse(e.snapshotReceipt);
    const hash='sha256:'+createHash('sha256').update(args.source.replace(/\r\n?/g,'\n')).digest('hex');
    if(found.ref.source!=='assignment_kernel_v2:operator_run_dynamic_revit_program'
     ||p.schema!=='revit-operator.dynamic-revit-program-run.v1'||p.execution_lane!=='native'||p.requested_mode!=='read'
     ||p.execution_status!=='completed'||p.execution_ok!==true||e.schema!=='dynamic-revit-native-program-evidence/v1'||e.ok!==true
     ||p.iteration?.source_sha256!==hash||n.schema!=='dynamic-revit-native-execution-receipt/v1'||n.success!==true||n.read_only!==true
     ||n.source_hash!==hash||n.transaction?.status!=='not_started'||n.transaction?.committed!==false
     ||['added_element_ids','modified_element_ids','deleted_element_ids','affected_element_ids'].some(k=>JSON.stringify(n.transaction[k])!=='[]')
     ||prep.Schema!=='dynamic-revit-native-preparation/v1'||prep.SourceHash!==hash||prep.PreparationId!==n.preparation_id
     ||n.document_fingerprint!=='sha256:'+String(snapshot.current_binding.document_fingerprint).replace(/^sha256:/,'')
     ||n.document_fingerprint!==prep.Document?.ProjectFingerprint||!n.document_session_id||n.document_session_id!==prep.Document?.SessionId
     ||typeof n.program_result!=='string'||!n.program_result.trim()||n.program_result.length>4096)continue;
    const api=prep.References?.find((v:any)=>v.Name==='RevitAPI');
    if(typeof api?.Version==='string'&&String(Number(api.Version.split('.')[0])+2000)===String(args.target_revit_year))
     lines.push(`Revit ${args.target_revit_year} (API ${label(api.Version)}).`);
    if(typeof prep.Document.Title==='string')lines.push(`Project: ${label(prep.Document.Title)}.`);
    lines.push(`Native C# read output (program result, not an independent verification):\n${label(n.program_result)}`);
    ids.add(oid);return {summary:lines.slice(0,70).join('\n'),observation_ids:[...ids]};
   }catch{/* Missing or malformed native receipts do not become a result. */}
  }
 }
 return lines.length?{summary:lines.slice(0,70).join('\n'),observation_ids:[...ids]}:null;
}
