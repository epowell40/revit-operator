import {createHash} from 'node:crypto';
import {payloadDigestV2} from '@revitoperator/payload-digest-v2';
import {resolveNativeResultTargets} from '@revitoperator/assignment-kernel-v2-contracts';
import {readAuthoritativeEvidence,readEvidenceRef} from '../evidence/evidence_store.js';
import {canonicalJsonV2,sameAssignmentBindingV2,type AssignmentSnapshotV2,type OperationV2,type OperationResultV2} from '../domain/assignment-kernel/index.js';

const row=(v:unknown):Record<string,any>=>v!==null&&typeof v==='object'&&!Array.isArray(v)?v as Record<string,any>:{};
const sha=(s:string)=>createHash('sha256').update(s).digest('hex');
const same=(a:unknown,b:unknown)=>canonicalJsonV2(a)===canonicalJsonV2(b);
const ids=(v:unknown):v is number[]=>Array.isArray(v)&&v.length<=4096&&v.every(n=>Number.isSafeInteger(n)&&n>0)&&new Set(v).size===v.length;
const sorted=(v:readonly number[])=>[...v].sort((a,b)=>a-b);
function nativePublicType(state:Record<string,any>,shape:Record<string,any>){
 // This descriptor is captured by the trusted native adapter, not the submitted
 // program. Authentication/source/receipt checks below remain prerequisites.
 if(!Object.hasOwn(shape,'nativeType'))return ['View','Space','FamilyInstance','ElectricalSystem','IndependentTag'].includes(state.className);
 const t=row(shape.nativeType),name=state.className;
 return typeof name==='string'&&name!=='Element'&&/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)
  &&t.assembly==='RevitAPI'&&t.baseType==='Autodesk.Revit.DB.Element'
  &&typeof t.fullName==='string'&&t.fullName.length<=256
  &&/^Autodesk\.Revit\.DB\.(?:[A-Za-z_][A-Za-z0-9_]*\.)*[A-Za-z_][A-Za-z0-9_]*$/.test(t.fullName)
  &&t.fullName.endsWith('.'+name);
}
function nativeVersion(v:unknown,session:string){
 const p=row(v);
 return Number.isSafeInteger(p.ProcessId)&&p.ProcessId>0&&typeof p.Epoch==='string'&&p.Epoch.length>0&&p.Epoch.length<=200
  &&p.DocumentSessionId===session&&Number.isSafeInteger(p.Sequence)&&p.Sequence>=0?p:null;
}

/** This is native observed-effect persistence, not a parser for arbitrary C#,
 * task/design correctness, visual review or saved persistence. All actual
 * selected result identities must have a supported complete host-produced state. */
export function readNativeProgramEffectObservationV2(v:unknown,fingerprint:string,session:string,targets:number[]){
 const p=row(v);
 if(p.scope!=='native_drafting_effect_state_v1'||p.complete!==true||p.documentFingerprint!==fingerprint||p.documentSessionId!==session
  ||!ids(p.requestedElementIds)||!same(p.requestedElementIds,targets)||!Array.isArray(p.items)||p.items.length!==targets.length)return null;
 let bytes=0,opaque=false,versionBound=false;const seen=new Set<number>();
 for(const item of p.items){const i=row(item);
  if(!targets.includes(i.elementId)||seen.has(i.elementId)||i.complete!==true||typeof i.found!=='boolean'
   ||typeof i.stateJson!=='string'||!i.stateJson||Buffer.byteLength(i.stateJson)>65536
   ||i.stateHash!=='sha256:'+sha(i.stateJson))return null;
  bytes+=Buffer.byteLength(i.stateJson);if(bytes>2*1024*1024)return null;
  try{const state=row(JSON.parse(i.stateJson));if(state.elementId!==i.elementId||state.found!==i.found)return null;
   const shape=row(state.shape);
   if(shape.kind==='opaque_element_public_state'){
    if(i.found!==true||state.className!=='Element'||typeof state.uniqueId!=='string'||!state.uniqueId||state.typeUniqueId!==null
     ||!Array.isArray(state.parameters)||shape.category!==null||shape.typeId!==-1||shape.location!==null||shape.box!==null||shape.privateStateInspected!==false)return null;
    opaque=true;versionBound=true;
   }else if(shape.kind==='public_element_observation'){
    // Limited public state is useful for general model work, but must never
    // masquerade as exhaustive geometry/topology or survive intervening edits.
    if(i.found!==true||!nativePublicType(state,shape)
     ||typeof state.uniqueId!=='string'||!state.uniqueId||!Array.isArray(state.parameters)
     ||!same(shape.observedFields,['identity','parameters','location','modelBoundingBox'])
     ||shape.privateStateInspected!==false||shape.geometryTopologyInspected!==false
     ||!Number.isSafeInteger(shape.typeId)||!(shape.category===null||typeof shape.category==='string')
     ||!Object.hasOwn(shape,'location')||!Object.hasOwn(shape,'box'))return null;
    versionBound=true;
   }else if(state.className==='Element'&&shape.kind!=='view_extent_infrastructure')return null;
  }catch{return null;}
  seen.add(i.elementId);
 }
 const version=nativeVersion(p.nativeVersion,session);if(versionBound&&!version)return null;
 return {items:p.items as Array<{elementId:number;found:boolean;stateJson:string;stateHash:string;complete:true}>,opaque,versionBound,version};
}

/** Select checked deliverables without rewriting the full native observation.
 * Extra notifications, including regenerated/deleted dependents, are retained
 * for code/intent review, not classified here as harmless or preserved. */
export function selectNativeProgramResultObservationV2(observation:unknown,footprint:number[],deleted:number[],targets:number[],fingerprint:string,session:string){
 const p=row(observation);
 if(!targets.length||targets.length>256||!ids(targets)||targets.some(id=>!footprint.includes(id))||!ids(deleted)||deleted.some(id=>!footprint.includes(id))
  ||p.scope!=='native_drafting_effect_state_v1'||p.documentFingerprint!==fingerprint||p.documentSessionId!==session
  ||typeof p.complete!=='boolean'||!ids(p.requestedElementIds)||!same(p.requestedElementIds,footprint)
  ||!Array.isArray(p.items)||p.items.length!==footprint.length||!ids(p.items.map(i=>row(i).elementId))
  ||!same(sorted(p.items.map(i=>row(i).elementId)),footprint)
  ||p.items.some(i=>typeof row(i).complete!=='boolean')||p.complete!==p.items.every(i=>row(i).complete===true))return null;
 const selected=p.items.filter(i=>targets.includes(row(i).elementId));
 // This new, explicitly scoped projection must never replace the raw receipt.
 return readNativeProgramEffectObservationV2({...p,complete:true,requestedElementIds:targets,items:selected},fingerprint,session,targets);
}

export function nativeProgramEffectStateV2(snapshot:AssignmentSnapshotV2,subject:OperationV2){
 const r=subject.result,args=row(row(subject.input).arguments??subject.input),native=row(args.native_program);
 // Explicit desired parameter checks must keep their stronger value comparator.
 if(Object.hasOwn(native,'parameter_checks')||subject.capability_id!=='operator_run_dynamic_revit_program'||subject.requested_effect!=='apply'
  ||subject.admission_state!=='admitted'||subject.dispatch_state!=='dispatched'||subject.settlement_state!=='settled'||subject.persistent_effect!=='applied'
  ||!sameAssignmentBindingV2(subject.binding,snapshot.current_binding)||!r||r.operation_id!==subject.operation_id
  ||r.authority!=='native-host'||r.status!=='succeeded'||r.dispatch_state!=='dispatched'||r.persistent_effect!=='applied'
  ||r.native_transaction_state!=='committed'||r.result_schema_id!=='operator-dynamic-runtime/mcp-program/v2'||r.error_code||r.result_semantic_gap
  ||!r.receipt_id||!r.native_correlation_id||!sameAssignmentBindingV2(r.binding,subject.binding)
  ||!subject.request_identity?.request_signature||r.request_identity?.request_signature!==subject.request_identity.request_signature
  ||subject.request_identity.request_signature!==sha(canonicalJsonV2({capability_id:subject.capability_id,input:subject.input}))
  ||args.mode!=='apply'||typeof args.source!=='string'||typeof native.entry_type!=='string'||!Number.isFinite(Date.parse(r.completed_at))
  ||snapshot.input_invalidated_operation_ids?.includes(subject.operation_id))return null;
 const sourceHash='sha256:'+sha(args.source.replace(/\r\n?/g,'\n'));
 const fingerprint='sha256:'+String(snapshot.current_binding.document_fingerprint??'').replace(/^sha256:/,'');
 try{for(const id of subject.observation_ids){const o=snapshot.observations[id];
  if(!o||o.operation_id!==subject.operation_id||o.authority!=='native-host'||o.evidence_class!=='task_result'
   ||!sameAssignmentBindingV2(o.binding,subject.binding)||o.raw_payload_hash!==r.raw_payload_hash)continue;
  const ref=readEvidenceRef(o.raw_payload_ref.replace(/^evidence:/,''));
  if(ref.byte_count>8*1024*1024||ref.trust_level!=='authoritative_native'||ref.source!=='assignment_kernel_v2:operator_run_dynamic_revit_program')continue;
  const bytes=readAuthoritativeEvidence(ref,{...subject.binding,attempt_id:subject.operation_id}),p=row(JSON.parse(bytes.toString('utf8')));
  if(payloadDigestV2(p).digest!==r.raw_payload_hash||p.schema!=='revit-operator.dynamic-revit-program-run.v1'||p.execution_lane!=='native'
   ||p.requested_mode!=='apply'||p.execution_status!=='completed'||p.execution_ok!==true||row(p.iteration).source_sha256!==sourceHash)continue;
  const evidence=row(p.evidence),outcome=row(p.native_outcome);
  const parse=(v:unknown)=>typeof v==='string'&&Buffer.byteLength(v)<=4*1024*1024?row(JSON.parse(v)):{};
  const receipt=parse(evidence.nativeExecutionReceipt),prepared=parse(evidence.snapshotReceipt),doc=row(prepared.Document),tx=row(receipt.transaction);
  if(evidence.schema!=='dynamic-revit-native-program-evidence/v1'||evidence.ok!==true
   ||receipt.schema!=='dynamic-revit-native-execution-receipt/v1'||receipt.success!==true||receipt.verified!==false
   ||receipt.source_hash!==sourceHash||prepared.Schema!=='dynamic-revit-native-preparation/v1'||prepared.SourceHash!==sourceHash
   ||receipt.preparation_id!==prepared.PreparationId||doc.ProjectFingerprint!==fingerprint||receipt.document_fingerprint!==fingerprint
   ||typeof doc.SessionId!=='string'||!doc.SessionId||receipt.document_session_id!==doc.SessionId
   ||outcome.persistent_effect!=='applied'||outcome.native_transaction_state!=='committed'||outcome.task_verified!==false||outcome.verification_required!==true
   ||tx.status!=='committed'||tx.committed!==true||![tx.added_element_ids,tx.modified_element_ids,tx.deleted_element_ids,tx.affected_element_ids].every(ids))continue;
  const footprint=sorted([...new Set<number>([...tx.added_element_ids,...tx.modified_element_ids,...tx.deleted_element_ids])]);
  if(!footprint.length||footprint.length>4096||!same(sorted(tx.affected_element_ids),footprint)
   ||!same([...r.affected_target_identities??[]].sort(),footprint.map(n=>'element_id:'+n).sort()))continue;
  const declared=resolveNativeResultTargets(native.result_targets,receipt.program_result),targets=declared??footprint;
  const observed=declared
   ?selectNativeProgramResultObservationV2(receipt.effect_observation,footprint,tx.deleted_element_ids,targets,fingerprint,doc.SessionId)
   :readNativeProgramEffectObservationV2(receipt.effect_observation,fingerprint,doc.SessionId,targets);
  if(!observed||observed.items.some(i=>i.found===tx.deleted_element_ids.includes(i.elementId)))continue;
  if(observed.versionBound&&(!Number.isSafeInteger(receipt.document_revision_before)||receipt.document_revision_before<0
   ||row(prepared.Scope).DocumentRevision!==receipt.document_revision_before||observed.version!.Sequence<=receipt.document_revision_before))continue;
  return {fingerprint,session:doc.SessionId as string,targets,...observed,scoped:Boolean(declared),footprint,
   uncheckedNotificationIds:footprint.filter(id=>!targets.includes(id)),
   uncheckedDeletedIds:tx.deleted_element_ids.filter((id:number)=>!targets.includes(id)),
   footprintCounts:{added:tx.added_element_ids.length,modified:tx.modified_element_ids.length,deleted:tx.deleted_element_ids.length}};
 }}catch{/* Missing, corrupt, foreign, unsupported and historical evidence stays unverified. */}
 return null;
}

export function committedNativeProgramEffectReadbackPlanV2(snapshot:AssignmentSnapshotV2,subject:OperationV2){
 if(snapshot.terminal||snapshot.outcome!=='active'||snapshot.completion_proposal||snapshot.execution_control?.state==='paused'
  ||snapshot.unresolved_unknown_operation_ids.length||subject.verification_operation_ids.length)return null;
 const state=nativeProgramEffectStateV2(snapshot,subject);return state?{method:'POST',path:'/revit/get-element-summary',
  body:{elementIds:state.targets,includeNativeProgramEffectState:true}}:null;
}

/** Model-visible accounting, not a claim that dependent changes are harmless. */
export function nativeProgramResultScopeNoticeV2(snapshot:AssignmentSnapshotV2,subject:OperationV2){
 const s=nativeProgramEffectStateV2(snapshot,subject);if(!s?.scoped)return null;
 return {scope:'requested_result_persistence',result_element_ids:s.targets,
  native_change_notifications:s.footprintCounts,notification_count:s.footprint.length,
  other_notification_count:s.uncheckedNotificationIds.length,
  other_notification_sample:s.uncheckedNotificationIds.slice(0,16),sample_complete:s.uncheckedNotificationIds.length<=16,
  other_deleted_count:s.uncheckedDeletedIds.length,other_deleted_sample:s.uncheckedDeletedIds.slice(0,16),
  notice:'The separate read checks the requested result elements only. Full added/modified/deleted IDs remain in the native receipt. Other notifications are not proof of unrelated edits and are not certified harmless or preserved. Review the exact executed code against the task using the existing code/visual review path; investigate concrete unrelated actions or missing drawing content. Revit can regenerate dependent records, so a notification or deletion count alone is not a mismatch. Task correctness, visual review and saved-file proof remain separate.'};
}

export function nativeProgramEffectPostconditionSatisfiedV2(snapshot:AssignmentSnapshotV2,subject:OperationV2,result:OperationResultV2,payload:unknown){
 const state=nativeProgramEffectStateV2(snapshot,subject),op=snapshot.operations[result.operation_id];
 if(!state||snapshot.unresolved_unknown_operation_ids.length||snapshot.execution_control?.state==='paused'
  ||!op||op.verification_of_operation_id!==subject.operation_id||op.requested_effect!=='read'||op.purpose!=='verification'||op.fulfillment_role!=='verification'
  ||op.persistent_effect!=='none'||!['dispatching','dispatched'].includes(op.dispatch_state)||!sameAssignmentBindingV2(op.binding,subject.binding)
  ||result.authority!=='native-host'||result.status!=='succeeded'||result.dispatch_state!=='dispatched'||result.persistent_effect!=='none'
  ||result.native_transaction_state!=='not_applicable'||!result.receipt_id||!result.native_correlation_id||result.error_code||result.result_semantic_gap
  ||!sameAssignmentBindingV2(result.binding,subject.binding)||!op.request_identity?.request_signature
  ||result.request_identity?.request_signature!==op.request_identity.request_signature||result.request_identity?.method!=='POST'||result.request_identity.path!=='/revit/get-element-summary'
  ||op.request_identity.method!=='POST'||op.request_identity.path!=='/revit/get-element-summary'
  ||op.input.method!=='POST'||op.input.path!=='/revit/get-element-summary'
  ||row(payload).success===false||row(payload).ok===false||row(payload).error||row(payload).truncated===true
  ||result.raw_payload_hash!==payloadDigestV2(payload).digest||snapshot.input_invalidated_operation_ids?.includes(op.operation_id)
  ||!Number.isFinite(Date.parse(op.opened_at))||Date.parse(op.opened_at)<Date.parse(subject.result!.completed_at)
  ||!Number.isFinite(Date.parse(result.completed_at))||Date.parse(result.completed_at)<Date.parse(op.opened_at)
  ||Object.values(snapshot.operations).some(other=>other.operation_id!==subject.operation_id&&other.requested_effect==='apply'
   &&(other.persistent_effect==='applied'||other.persistent_effect==='unknown'||snapshot.in_flight_operation_ids.includes(other.operation_id))
   &&sameAssignmentBindingV2(other.binding,subject.binding)&&Date.parse(other.opened_at)>=Date.parse(subject.result!.completed_at)))return false;
 const b=row(op.input.body);if(!same(Object.keys(b).sort(),['elementIds','includeNativeProgramEffectState'])||b.includeNativeProgramEffectState!==true||!same(b.elementIds,state.targets))return false;
 const fresh=readNativeProgramEffectObservationV2(row(payload).nativeProgramEffectState,state.fingerprint,state.session,state.targets);
 if(!fresh||fresh.opaque!==state.opaque||fresh.versionBound!==state.versionBound||state.versionBound&&!same(fresh.version,state.version))return false;
 return Boolean(state.items.every(expected=>{const actual=fresh.items.find(i=>i.elementId===expected.elementId);return actual&&actual.found===expected.found
  &&actual.stateHash===expected.stateHash&&actual.stateJson===expected.stateJson;}));
}
