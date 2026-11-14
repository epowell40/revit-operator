import {createHash} from 'node:crypto';
import {payloadDigestV2} from '@revitoperator/payload-digest-v2';
import {readAuthoritativeEvidence,readEvidenceRef} from '../evidence/evidence_store.js';
import {canonicalJsonV2,sameAssignmentBindingV2,type AssignmentSnapshotV2,type OperationV2} from '../domain/assignment-kernel/index.js';

const row=(v:unknown):Record<string,any>=>v&&typeof v==='object'&&!Array.isArray(v)?v as Record<string,any>:{};
const sha=(v:string)=>'sha256:'+createHash('sha256').update(v).digest('hex');
const hash=(v:unknown)=>typeof v==='string'&&/^sha256:[a-f0-9]{64}$/.test(v);
const text=(v:unknown,n:number)=>typeof v==='string'&&v.trim().length>0&&v.length<=n&&!/[\u0000-\u001f\u007f]/.test(v);
// Native artifact binding uses length-prefixed UTF-16 strings, not JSON.
const packed=(values:string[])=>values.map(v=>`${v.length}:${v}\n`).join('');

/** A successful source-bound native read's compiler-observed API surface.
 * This is bounded discovery novelty, NOT an execution trace, returned-data
 * truth, semantic completion, or a grant to run more provider calls. */
export function nativeProgramDiscoveryMembersV2(snapshot:AssignmentSnapshotV2,op:OperationV2):string[]|null{
 const r=op.result,b=op.binding,cur=snapshot.current_binding,args=row(op.input.arguments??op.input);
 if(op.capability_id!=='operator_run_dynamic_revit_program'||op.requested_effect!=='read'||op.purpose!=='discovery'
  ||op.fulfillment_role!=='supporting_control'||op.admission_state!=='admitted'||op.dispatch_state!=='dispatched'
  ||op.settlement_state!=='settled'||op.persistent_effect!=='none'||!r||r.operation_id!==op.operation_id
  ||r.status!=='succeeded'||r.authority!=='native-host'||r.dispatch_state!=='dispatched'||r.persistent_effect!=='none'
  ||r.native_transaction_state!=='not_started'||r.result_schema_id!=='operator-dynamic-runtime/mcp-program/v2'
  ||!r.receipt_id||!r.native_correlation_id||!sameAssignmentBindingV2(r.binding,b)
  ||!Number.isSafeInteger(op.settled_assignment_version)||op.settled_assignment_version!<1
  ||!Number.isFinite(Date.parse(op.opened_at))||!Number.isFinite(Date.parse(r.completed_at))||Date.parse(r.completed_at)<Date.parse(op.opened_at)
  ||b.assignment_id!==cur.assignment_id||b.principal_id!==cur.principal_id||b.document_fingerprint!==cur.document_fingerprint
  ||snapshot.input_invalidated_operation_ids?.includes(op.operation_id)||args.mode!=='read'
  ||typeof args.source!=='string'||args.source.length>1_000_000
  ||r.request_identity?.request_signature!==op.request_identity?.request_signature
  ||op.request_identity?.request_signature!==sha(canonicalJsonV2({capability_id:op.capability_id,input:op.input})).slice(7))return null;
 const sourceHash=sha(args.source.replace(/\r\n?/g,'\n'));
 for(const id of op.observation_ids){const o=snapshot.observations[id];
  if(!o||o.operation_id!==op.operation_id||o.capability_id!==op.capability_id||o.authority!=='native-host'
   ||o.evidence_class!=='control'||o.fulfillment_role!=='supporting_control'||!sameAssignmentBindingV2(o.binding,b)
   ||o.raw_payload_hash!==r.raw_payload_hash||!o.facts.some(f=>f.fact_id==='control.domain_succeeded'&&f.value===true))continue;
  try{
   const ref=readEvidenceRef(o.raw_payload_ref.replace(/^evidence:/,''));
   if(ref.trust_level!=='authoritative_native'||ref.source!=='assignment_kernel_v2:operator_run_dynamic_revit_program'||ref.byte_count>8*1024*1024)continue;
   const p=JSON.parse(readAuthoritativeEvidence(ref,{...b,attempt_id:op.operation_id}).toString('utf8'));
   if(payloadDigestV2(p).digest!==o.raw_payload_hash)continue;
   const e=row(p.evidence),n=JSON.parse(e.nativeExecutionReceipt),prep=JSON.parse(e.snapshotReceipt),a=row(row(e.workerOutput).nativeProgramArtifact),scope=row(prep.Scope);
   if(p.schema!=='revit-operator.dynamic-revit-program-run.v1'||p.execution_lane!=='native'||p.requested_mode!=='read'
    ||p.execution_status!=='completed'||p.execution_ok!==true||p.iteration?.source_sha256!==sourceHash
    ||e.schema!=='dynamic-revit-native-program-evidence/v1'||e.ok!==true
    ||n.schema!=='dynamic-revit-native-execution-receipt/v1'||n.success!==true||n.read_only!==true||n.source_hash!==sourceHash
    ||n.transaction?.status!=='not_started'||n.transaction?.committed!==false
    ||['added_element_ids','modified_element_ids','deleted_element_ids','affected_element_ids'].some(k=>JSON.stringify(n.transaction[k])!=='[]')
    ||typeof n.program_result!=='string'||!n.program_result.trim()
    ||prep.Schema!=='dynamic-revit-native-preparation/v1'||prep.SourceHash!==sourceHash||prep.PreparationId!==n.preparation_id
    ||n.document_fingerprint!=='sha256:'+String(b.document_fingerprint).replace(/^sha256:/,'')
    ||n.document_fingerprint!==prep.Document?.ProjectFingerprint||!n.document_session_id||n.document_session_id!==prep.Document?.SessionId
    ||a.schema!=='dynamic-revit-native-compile-artifact/v1'||a.mode!=='read'||a.sourceHash!==sourceHash
    ||String(a.revitYear)!==String(args.target_revit_year)||!text(a.entryType,256)||a.entryType!==row(args.native_program).entry_type
    ||!hash(a.assemblyHash)||a.assemblyHash!==n.assembly_hash||!Array.isArray(a.references)||a.references.length<1||a.references.length>8
    ||a.references.some((v:any)=>!text(v.name,64)||!text(v.version,64)||!hash(v.sha256)
      ||!prep.References?.some((q:any)=>q.Name===v.name&&q.Version===v.version&&q.Sha256===v.sha256))
    ||new Set(a.references.map((v:any)=>v.name)).size!==a.references.length
    ||!Array.isArray(a.directNativeMembers)||!a.directNativeMembers.length||a.directNativeMembers.length>512
    ||a.directNativeMembers.some((m:any)=>!text(m.id,2048)||!text(m.declaringType,512)||!m.declaringType.startsWith('Autodesk.Revit.')||!text(m.name,256)||m.mutationHint!==false)
    ||new Set(a.directNativeMembers.map((m:any)=>m.id)).size!==a.directNativeMembers.length)continue;
   const members=[...a.directNativeMembers].sort((x,y)=>x.id<y.id?-1:x.id>y.id?1:0);
   const refs=[...a.references].sort((x,y)=>x.name<y.name?-1:x.name>y.name?1:0);
   const artifactHash=sha(packed([a.schema,String(a.revitYear),a.mode,a.entryType,a.sourceHash,a.assemblyHash,
    ...refs.flatMap(v=>[v.name,v.version,v.sha256]),String(members.length),...members.flatMap(m=>[m.id,m.declaringType,m.name,'0'])]));
   if(scope.EffectScope!=='listed_elements'||scope.DocumentFingerprint!==n.document_fingerprint||scope.DocumentSessionId!==n.document_session_id
    ||!Number.isSafeInteger(scope.DocumentRevision)||scope.DocumentRevision<0||scope.DocumentRevision!==n.document_revision_before
    ||!hash(scope.NativeScopeHash)||scope.AllowCreate!==false||scope.MaxAffectedElements!==0
    ||JSON.stringify(scope.AllowedExistingElementIds)!=='[]'||!Number.isSafeInteger(scope.DeadlineMs)||scope.DeadlineMs<250||scope.DeadlineMs>10000
    ||n.native_binding_hash!==sha(packed(['dynamic-revit-native-program-binding/v1',artifactHash,scope.DocumentFingerprint,scope.DocumentSessionId,
      String(scope.DocumentRevision),scope.NativeScopeHash,'0','0',String(scope.DeadlineMs)])))continue;
   return members.map(m=>m.id);
  }catch{/* Malformed, unavailable or foreign evidence cannot buy progress. */}
 }
 return null;
}

/** Count new native API coverage, not arbitrary combinations of known members.
 * Re-derive from retained history across resume; no mutable counter or caller
 * identity. Cosmetic source/output changes and repeated/subset reads add none.
 * Same API with different model selectors is deliberately not inferred here. */
export function nativeProgramDiscoveryIdentitiesV2(snapshot:AssignmentSnapshotV2):Record<string,string>{
 const seen=new Set<string>(),identities:Record<string,string>={};
 const operations=Object.values(snapshot.operations).filter(op=>op.capability_id==='operator_run_dynamic_revit_program')
  .sort((a,b)=>(a.settled_assignment_version??Number.MAX_SAFE_INTEGER)-(b.settled_assignment_version??Number.MAX_SAFE_INTEGER)||a.operation_id.localeCompare(b.operation_id));
 for(const op of operations){const members=nativeProgramDiscoveryMembersV2(snapshot,op);if(!members)continue;
  if(members.some(m=>!seen.has(m)))identities[op.operation_id]=canonicalJsonV2({native_read_members:members,document:op.binding.document_fingerprint});
  for(const member of members)seen.add(member);
 }
 return identities;
}
