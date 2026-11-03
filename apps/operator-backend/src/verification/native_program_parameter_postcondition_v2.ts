import {createHash} from 'node:crypto';
import {payloadDigestV2} from '@revitoperator/payload-digest-v2';
import {normalizeNativeParameterChecks} from '@revitoperator/assignment-kernel-v2-contracts';
import {readAuthoritativeEvidence,readEvidenceRef} from '../evidence/evidence_store.js';
import {generatedParameterPostconditionSatisfiedV2} from './generated_parameter_postcondition_v2.js';
import {canonicalJsonV2,sameAssignmentBindingV2,type AssignmentSnapshotV2,type OperationV2,type OperationResultV2} from '../domain/assignment-kernel/index.js';

const row=(v:unknown):Record<string,unknown>=>v!==null&&typeof v==='object'&&!Array.isArray(v)?v as Record<string,unknown>:{};
const same=(a:unknown,b:unknown)=>JSON.stringify(a)===JSON.stringify(b);
const sorted=(v:readonly string[])=>[...v].sort();

export function dynamicProgramParameterPostconditionSatisfiedV2(snapshot:AssignmentSnapshotV2,subject:OperationV2,result:OperationResultV2,payload:unknown):boolean{
 return nativeProgramParameterPostconditionSatisfiedV2(snapshot,subject,result,payload)
  ||generatedParameterPostconditionSatisfiedV2(snapshot,subject,result,payload);
}

/** Explicit desired text fields from the immutable request, backed by the
 * exact authenticated native commit. This never interprets C# source or its
 * return string. Unrequested/collateral targets remain outside this contract. */
export function nativeProgramParameterChecksV2(snapshot:AssignmentSnapshotV2,subject:OperationV2) {
 const r=subject.result, args=row(row(subject.input).arguments??subject.input), native=row(args.native_program);
 if(subject.capability_id!=='operator_run_dynamic_revit_program'||subject.requested_effect!=='apply'
  ||subject.admission_state!=='admitted'||subject.dispatch_state!=='dispatched'||subject.settlement_state!=='settled'
  ||subject.persistent_effect!=='applied'||!sameAssignmentBindingV2(subject.binding,snapshot.current_binding)
  ||!r||r.operation_id!==subject.operation_id||r.authority!=='native-host'||r.status!=='succeeded'
  ||r.result_schema_id!=='operator-dynamic-runtime/mcp-program/v2'||r.native_transaction_state!=='committed'
  ||r.persistent_effect!=='applied'||r.dispatch_state!=='dispatched'||r.error_code||r.result_semantic_gap
  ||!sameAssignmentBindingV2(r.binding,subject.binding)||!r.receipt_id||!r.native_correlation_id
  ||!subject.request_identity?.request_signature||r.request_identity?.request_signature!==subject.request_identity.request_signature
  ||subject.request_identity.request_signature!==createHash('sha256').update(canonicalJsonV2({capability_id:subject.capability_id,input:subject.input})).digest('hex')
  ||!Number.isFinite(Date.parse(r.completed_at))
  ||args.mode!=='apply'||typeof args.source!=='string'||typeof native.entry_type!=='string'
  ||snapshot.input_invalidated_operation_ids?.includes(subject.operation_id))return null;
 try {
  const checks=normalizeNativeParameterChecks(native.parameter_checks,'apply');if(!checks)return null;
  const targets=sorted([...new Set(checks.map(c=>'element_id:'+c.element_id))]);
  if(!same(targets,sorted(r.affected_target_identities??[])))return null;
  const sourceHash='sha256:'+createHash('sha256').update(args.source.replace(/\r\n?/g,'\n'),'utf8').digest('hex');
  const fingerprint='sha256:'+String(snapshot.current_binding.document_fingerprint??'').replace(/^sha256:/,'');
  for(const id of subject.observation_ids){
   const o=snapshot.observations[id];
   if(!o||o.operation_id!==subject.operation_id||o.authority!=='native-host'||o.evidence_class!=='task_result'
    ||!sameAssignmentBindingV2(o.binding,subject.binding)||o.raw_payload_hash!==r.raw_payload_hash)continue;
   const ref=readEvidenceRef(o.raw_payload_ref.replace(/^evidence:/,''));
   if(ref.byte_count>8*1024*1024||ref.trust_level!=='authoritative_native'
    ||ref.source!=='assignment_kernel_v2:operator_run_dynamic_revit_program')continue;
   const bytes=readAuthoritativeEvidence(ref,{...subject.binding,attempt_id:subject.operation_id});
   const payload=row(JSON.parse(bytes.toString('utf8')));
   if(payloadDigestV2(payload).digest!==r.raw_payload_hash||payload.schema!=='revit-operator.dynamic-revit-program-run.v1'
    ||payload.execution_lane!=='native'||payload.requested_mode!=='apply'||payload.execution_status!=='completed'
    ||payload.execution_ok!==true||row(payload.iteration).source_sha256!==sourceHash)continue;
   // The canonical native-host result and authoritative ref have already
   // passed launcher/MAC admission. Bind the exact retained body again here;
   // do not turn caller reports or a copied request into expected results.
   const evidence=row(payload.evidence),outcome=row(payload.native_outcome);
   const parse=(v:unknown)=>typeof v==='string'&&v.length<=2*1024*1024?row(JSON.parse(v)):{};
   const receipt=parse(evidence.nativeExecutionReceipt),prepared=parse(evidence.snapshotReceipt),doc=row(prepared.Document),tx=row(receipt.transaction);
   const affected=tx.affected_element_ids,modified=tx.modified_element_ids;
   if(evidence.schema!=='dynamic-revit-native-program-evidence/v1'||evidence.ok!==true
    ||receipt.schema!=='dynamic-revit-native-execution-receipt/v1'||receipt.success!==true||receipt.verified!==false
    ||receipt.source_hash!==sourceHash||prepared.Schema!=='dynamic-revit-native-preparation/v1'||prepared.SourceHash!==sourceHash
    ||receipt.preparation_id!==prepared.PreparationId||doc.ProjectFingerprint!==fingerprint||receipt.document_fingerprint!==fingerprint
    ||typeof doc.SessionId!=='string'||!doc.SessionId||receipt.document_session_id!==doc.SessionId
    ||outcome.persistent_effect!=='applied'||outcome.native_transaction_state!=='committed'||outcome.task_verified!==false||outcome.verification_required!==true
    ||tx.status!=='committed'||tx.committed!==true||!same(tx.added_element_ids,[])||!same(tx.deleted_element_ids,[])
    ||!Array.isArray(affected)||!Array.isArray(modified)||affected.some(id=>!Number.isSafeInteger(id)||id<=0)
    ||new Set(affected).size!==affected.length||!same(sorted(affected.map(id=>'element_id:'+id)),targets)
    ||!same(sorted(modified.map(id=>'element_id:'+id)),targets))continue;
   return checks;
  }
 }catch{/* Malformed, foreign, missing or untrusted evidence is not a check. */}
 return null;
}

/** One actual separate native callback, using existing read admission and
 * settlement. It proves these text fields only, not arbitrary C# semantics. */
export function committedNativeProgramParameterReadbackPlanV2(snapshot:AssignmentSnapshotV2,subject:OperationV2){
 if(snapshot.terminal||snapshot.outcome!=='active'||snapshot.completion_proposal||snapshot.execution_control?.state==='paused'
  ||snapshot.unresolved_unknown_operation_ids.length||subject.verification_operation_ids.length)return null;
 const checks=nativeProgramParameterChecksV2(snapshot,subject);if(!checks)return null;
 return {method:'POST',path:'/revit/get-parameters',body:{elementIds:[...new Set(checks.map(c=>c.element_id))].sort((a,b)=>a-b),
  names:sorted([...new Set(checks.map(c=>c.parameter_name))]),includeEmpty:true,limit:500}};
}

export function nativeProgramParameterPostconditionSatisfiedV2(snapshot:AssignmentSnapshotV2,subject:OperationV2,
 result:OperationResultV2,payload:unknown):boolean{
 const op=snapshot.operations[result.operation_id],p=row(payload),checks=nativeProgramParameterChecksV2(snapshot,subject);
 if(!checks||snapshot.unresolved_unknown_operation_ids.length||snapshot.execution_control?.state==='paused'
  ||!op||op.verification_of_operation_id!==subject.operation_id||op.requested_effect!=='read'||op.purpose!=='verification'
  ||op.fulfillment_role!=='verification'||op.persistent_effect!=='none'||!['dispatching','dispatched'].includes(op.dispatch_state)
  ||!sameAssignmentBindingV2(op.binding,subject.binding)||!sameAssignmentBindingV2(result.binding,subject.binding)
  ||result.authority!=='native-host'||result.status!=='succeeded'||result.dispatch_state!=='dispatched'
  ||result.persistent_effect!=='none'||result.native_transaction_state!=='not_applicable'||!result.receipt_id||!result.native_correlation_id
  ||result.error_code||result.result_semantic_gap||!result.raw_payload_hash||payloadDigestV2(payload).digest!==result.raw_payload_hash
  ||result.request_identity?.method!=='POST'||result.request_identity.path!=='/revit/get-parameters'
  ||!op.request_identity?.request_signature||result.request_identity.request_signature!==op.request_identity.request_signature
  ||snapshot.input_invalidated_operation_ids?.includes(op.operation_id)
  ||!Number.isFinite(Date.parse(op.opened_at))||Date.parse(op.opened_at)<Date.parse(subject.result!.completed_at)
  ||!Number.isFinite(Date.parse(result.completed_at))||Date.parse(result.completed_at)<Date.parse(op.opened_at)
  ||Object.values(snapshot.operations).some(other=>other.operation_id!==subject.operation_id&&other.requested_effect==='apply'
   &&(other.persistent_effect==='applied'||other.persistent_effect==='unknown'||snapshot.in_flight_operation_ids.includes(other.operation_id))
   &&sameAssignmentBindingV2(other.binding,subject.binding)&&Date.parse(other.opened_at)>=Date.parse(subject.result!.completed_at)))return false;
 const ids=[...new Set(checks.map(c=>c.element_id))].sort((a,b)=>a-b),names=sorted([...new Set(checks.map(c=>c.parameter_name))]);
 const body=row(op.input.body);
 if(!same(body.elementIds,ids)||!same(body.names,names)||p.truncated===true||p.complete===false||p.success===false
  ||!Array.isArray(p.items)||p.items.length!==ids.length)return false;
 const items=new Map<number,Record<string,unknown>>();
 for(const value of p.items){const item=row(value);
  if(!Number.isSafeInteger(item.id)||!ids.includes(Number(item.id))||items.has(Number(item.id))||item.found===false
   ||typeof item.uniqueId!=='string'||!item.uniqueId||!Array.isArray(item.parameterDetails))return false;
  items.set(Number(item.id),item);
 }
 return checks.every(c=>{
  const item=items.get(c.element_id)!,parameters=row(item.parameters);
  const details=(item.parameterDetails as unknown[]).map(row).filter(p=>p.name===c.parameter_name);
  return Object.hasOwn(parameters,c.parameter_name)&&parameters[c.parameter_name]===c.expected_value
   &&details.length===1&&details[0].storageType==='String'&&Number.isSafeInteger(details[0].parameterId)
   &&details[0].value===c.expected_value;
 });
}
