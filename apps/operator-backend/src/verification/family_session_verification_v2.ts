import path from 'node:path';
import {payloadDigestV2} from '@revitoperator/payload-digest-v2';
import {readAuthoritativeEvidence, readEvidenceRef} from '../evidence/evidence_store.js';
import {sameAssignmentBindingV2, type AssignmentSnapshotV2, type OperationV2, type OperationResultV2} from '../domain/assignment-kernel/index.js';
import {appliedOperationHasVerifiedPostconditionV2} from '../domain/assignment-kernel/outcome.js';
import {familySessionSavedV1, familySessionReloadedV1} from './family_session_open_v1.js';
import {preservedScheduleTargets,preservedScheduleReadMatchesV2} from './native_annotation_postcondition_v2.js';

const row=(v:unknown):Record<string,any>=>v&&typeof v==='object'&&!Array.isArray(v)?v as Record<string,any>:{};
const body=(v:unknown)=>{const r=row(v);if(typeof r.body==='string'){try{return row(JSON.parse(r.body));}catch{return {};}}return row(r.body??r);};
const canonical=(v:unknown)=>typeof v==='string'&&v.length>0&&v.length<=2000&&!/[\u0000-\u001f]/.test(v)&&path.win32.isAbsolute(v)
  ?path.win32.normalize(v).replaceAll('\\','/').toLowerCase():null;
const session=(v:unknown)=>typeof v==='string'&&/^[a-f0-9]{32}$/.test(v.trim())?v.trim():null;
const routes=new Set(['/revit/save-family-doc','/revit/load-family-doc','/revit/reload-family-edit-session','/revit/load-family']);

/** New file loads have no tracked Family Editor session. Their committed native
 * transaction and separate project read prove definition identity only. Existing
 * family replacement and parameter overwrites are not covered. Modified existing
 * schedules require complete unchanged native before/after plus current read. */
function newFileLoad(input:unknown,value:unknown){
 const request=row(input),b=body(input),p=row(value),t=row(p.transaction),tracking=row(p.changeTracking);
 const validId=(v:unknown)=>Number.isSafeInteger(v)&&Number(v)>0;
 if(request.method!=='POST'||request.path!=='/revit/load-family'
  ||Object.keys(b).some(k=>!['filePath','overwriteParameterValues'].includes(k))
  ||typeof b.filePath!=='string'||!b.filePath.trim()||b.filePath.length>2000||/[\u0000-\u001f]/.test(b.filePath)||! /\.rfa$/i.test(b.filePath)
  ||b.overwriteParameterValues!==undefined&&b.overwriteParameterValues!==false
  ||p.status!=='Loaded'||p.loaded!==true||p.success!==true||p.ok!==true||p.applied!==true||p.verified!==true
  ||p.error||p.isError===true||!validId(p.familyId)||typeof p.familyName!=='string'||!p.familyName.trim()
  ||t.status!=='committed'||t.committed!==true||!Array.isArray(t.added_element_ids)||!t.added_element_ids.length
  ||t.added_element_ids.length>2000||!t.added_element_ids.every(validId)||new Set(t.added_element_ids).size!==t.added_element_ids.length
  ||!t.added_element_ids.includes(p.familyId)||!Array.isArray(t.modified_element_ids)||t.modified_element_ids.length>32
  ||!t.modified_element_ids.every(validId)||new Set(t.modified_element_ids).size!==t.modified_element_ids.length
  ||t.modified_element_ids.some((id:unknown)=>t.added_element_ids.includes(id))
  ||!Array.isArray(t.deleted_element_ids)||t.deleted_element_ids.length
  ||!Array.isArray(t.affected_element_ids)||t.affected_element_ids.length!==t.added_element_ids.length+t.modified_element_ids.length
  ||new Set(t.affected_element_ids).size!==t.affected_element_ids.length
  ||!t.affected_element_ids.every((id:unknown)=>t.added_element_ids.includes(id)||t.modified_element_ids.includes(id))
  ||tracking.documentChangedObserved!==true||tracking.exhaustiveChangeInventory!==true||tracking.captureFailureCount!==0
  ||!Array.isArray(p.symbols)||!p.symbols.length||p.symbols.length>1999)return null;
 const symbols=p.symbols.map(row);
 if(symbols.some((s:Record<string,any>)=>!validId(s.id)||s.id===p.familyId||!t.added_element_ids.includes(s.id)||typeof s.name!=='string'||!s.name.trim())
  ||new Set(symbols.map((s:Record<string,any>)=>s.id)).size!==symbols.length)return null;
 const schedules=t.modified_element_ids as number[];
 if(schedules.length&&(t.affected_element_ids.length>2000||t.pending===true||t.rolled_back===true
  ||!Number.isSafeInteger(tracking.matchingEventCount)||tracking.matchingEventCount<1||tracking.distinctWrapperMatchCount!==1
  ||!preservedScheduleTargets(p,schedules)))return null;
 return {familyId:p.familyId as number,familyName:p.familyName as string,symbols,addedIds:t.added_element_ids as number[],scheduleIds:schedules};
}

function fileLoadReadbackMatches(input:unknown,applied:unknown,readInput:unknown,payload:unknown):boolean{
 const load=newFileLoad(input,applied),read=row(readInput),rb=body(readInput),p=row(payload),ids=rb.elementIds;
 if(!load||read.method!=='POST'||read.path!=='/revit/get-element-summary'||!Array.isArray(ids)||!ids.length||ids.length>2000
  ||new Set(ids).size!==ids.length||ids.some(id=>!load.addedIds.includes(id)&&!load.scheduleIds.includes(id))||!ids.includes(load.familyId)
  ||load.symbols.some((s:Record<string,any>)=>!ids.includes(s.id))||p.error||p.isError===true||p.success===false||p.truncated===true||p.itemsComplete===false
  ||!Array.isArray(p.result)||p.result.length!==ids.length||new Set(p.result.map((v:unknown)=>row(v).id)).size!==ids.length)return false;
 if(load.scheduleIds.length){
  const requested=rb.preservationScheduleIds;
  if(!Array.isArray(requested)||requested.length!==load.scheduleIds.length||new Set(requested).size!==requested.length
   ||requested.some(id=>!load.scheduleIds.includes(id))||load.scheduleIds.some(id=>!ids.includes(id))
   ||!preservedScheduleReadMatchesV2(row(applied),load.scheduleIds,p))return false;
 }
 return p.result.every((value:unknown)=>{
  const actual=row(value);if(!ids.includes(actual.id)||actual.found!==true||typeof actual.uniqueId!=='string'||!actual.uniqueId.trim())return false;
  if(actual.id===load.familyId)return actual.className==='Family'&&actual.fullClassName==='Autodesk.Revit.DB.Family'&&actual.name===load.familyName;
  if(load.scheduleIds.includes(actual.id)){
   const prior=row(row(applied).schedulePreservation).before.find((r:any)=>r.elementId===actual.id);
   return actual.className==='ViewSchedule'&&actual.fullClassName==='Autodesk.Revit.DB.ViewSchedule'&&actual.uniqueId===prior.uniqueId;
  }
  const symbol=load.symbols.find((s:Record<string,any>)=>s.id===actual.id);
  return !symbol||actual.className==='FamilySymbol'&&actual.fullClassName==='Autodesk.Revit.DB.FamilySymbol'&&actual.name===symbol.name
    &&typeof actual.category==='string'&&actual.category.trim().length>0;
 });
}

export function familySessionVerificationTargetsV2(value:unknown):readonly string[]{
 const r=body(value), s=session(r.docId??r.familyDocumentId??row(r.saved_document).family_session_id);
 if(r.loaded===true&&r.status==='Loaded'&&Number.isSafeInteger(r.familyId)&&r.familyId>0&&Array.isArray(r.symbols))
  return [...new Set([r.familyId,...r.symbols.map(row).map((x:Record<string,any>)=>x.id).filter((id:unknown)=>Number.isSafeInteger(id)&&Number(id)>0)])].sort((a,b)=>a-b).map(id=>'id:'+id);
 const loaded=r.loadedFamilyId;
 return [...(s?['family_session:'+s]:[]),...(Number.isSafeInteger(loaded)&&loaded>0?['id:'+loaded]:[])];
}

/** This proves a saved file or loaded family identity, never label typography,
 * tag placement, scope coverage, or the user's complete design request. */
export function familySessionReadbackMatchesV2(input:unknown, appliedValue:unknown, readInput:unknown, payload:unknown):boolean{
 if(row(input).path==='/revit/load-family')return fileLoadReadbackMatches(input,appliedValue,readInput,payload);
 const request=row(input), b=body(input), applied=row(appliedValue), read=row(readInput), rb=body(readInput), p=row(payload);
 const s=session(b.docId??b.familyDocumentId);
 if(!s||request.method!=='POST'||read.method!=='POST'||b.dryRun===true||b.closeSession===true
  ||p.error||p.isError===true||p.success===false||p.truncated===true||applied.error||applied.isError===true)return false;
 if(request.path==='/revit/save-family-doc'){
  if(!familySessionSavedV1(request.path,b,applied)||read.path!=='/revit/inspect-exported-files'
    ||session(rb.familyDocumentId)!==s||!Array.isArray(rb.paths)||rb.paths.length!==1)return false;
  const saved=row(applied.family_save_receipt), expected=canonical(saved.path), document=row(p.saved_document);
  if(!expected||canonical(rb.paths[0])!==expected||p.schema!=='revit-operator.exported-file-inspection.v1'
    ||p.ok!==true||p.itemsComplete!==true||!Array.isArray(p.requestedPaths)||p.requestedPaths.length!==1
    ||canonical(p.requestedPaths[0])!==expected||!Array.isArray(p.files)||p.files.length!==1
    ||canonical(document.path)!==expected||document.family_session_id!==s||document.is_family_document!==true
    ||document.is_modified!==false||document.is_modifiable!==false)return false;
  const file=row(p.files[0]);
  return canonical(file.path)===expected&&file.exists===true&&file.readable===true&&file.stable_read===true
    &&file.size_bytes===saved.size_bytes&&file.sha256===saved.sha256;
 }
 if(['/revit/load-family-doc','/revit/reload-family-edit-session'].includes(request.path)){
  if(!familySessionReloadedV1(request.path,b,applied)||read.path!=='/revit/get-element-summary'
    ||!Array.isArray(rb.elementIds)||rb.elementIds.length<1||rb.elementIds.length>2000
    ||!rb.elementIds.includes(applied.loadedFamilyId)||new Set(rb.elementIds).size!==rb.elementIds.length)return false;
  const items=Array.isArray(payload)?payload:p.result;
  if(!Array.isArray(items)||items.length!==rb.elementIds.length
    ||new Set(items.map(item=>row(item).id)).size!==items.length)return false;
  const symbols=Array.isArray(applied.symbols)?applied.symbols.map(row):[];
  for(const id of rb.elementIds){
   const observed=row(items.find(item=>row(item).id===id));
   if(observed.found!==true||typeof observed.uniqueId!=='string'||!observed.uniqueId.trim())return false;
   if(id===applied.loadedFamilyId)continue;
   const known=symbols.find(symbol=>symbol.id===id);
   if(!known||observed.className!=='FamilySymbol'||observed.fullClassName!=='Autodesk.Revit.DB.FamilySymbol'
     ||observed.name!==known.name)return false;
  }
  const item=row(items.find(item=>row(item).id===applied.loadedFamilyId)), receipt=row(applied.family_reload_receipt);
  return item.found===true&&item.id===receipt.family_id&&item.uniqueId===receipt.family_unique_id
    &&item.className==='Family'&&item.fullClassName==='Autodesk.Revit.DB.Family'&&item.name===applied.familyName;
 }
 return false;
}

function nativeApply(snapshot:AssignmentSnapshotV2, op:OperationV2, requireNativeEvidenceTrust=false):unknown|null{
 const result=op.result, identity=op.request_identity;
 if(!identity||identity.method!=='POST'||!routes.has(identity.path??'')||op.input.method!=='POST'||op.input.path!==identity.path
  ||op.requested_effect!=='apply'||op.admission_state!=='admitted'||op.dispatch_state!=='dispatched'
  ||op.settlement_state!=='settled'||op.persistent_effect!=='applied'||!result||result.status!=='succeeded'
  ||result.authority!=='native-host'||result.persistent_effect!=='applied'||result.operation_id!==op.operation_id
  ||result.result_schema_id!=='operator-native/POST:'+identity.path+'/v2'
  ||!identity.request_signature||result.request_identity?.request_signature!==identity.request_signature
  ||result.request_identity?.method!==identity.method||result.request_identity?.path!==identity.path
  ||!sameAssignmentBindingV2(snapshot.current_binding,op.binding)||!sameAssignmentBindingV2(result.binding,op.binding)
  ||!result.raw_payload_hash||!Number.isFinite(Date.parse(result.completed_at)))return null;
 for(const id of op.observation_ids){
  const observation=snapshot.observations[id];
  if(!observation||observation.operation_id!==op.operation_id||observation.authority!=='native-host'
   ||observation.raw_payload_hash!==result.raw_payload_hash||!sameAssignmentBindingV2(observation.binding,op.binding))continue;
  try{
   const ref=readEvidenceRef(observation.raw_payload_ref.replace(/^evidence:/,''));if(ref.byte_count>2_000_000
    ||requireNativeEvidenceTrust&&ref.trust_level!=='authoritative_native')continue;
   const bytes=readAuthoritativeEvidence(ref,{...op.binding,attempt_id:op.operation_id});const p=JSON.parse(bytes.toString('utf8'));
   if(payloadDigestV2(p).digest!==result.raw_payload_hash)continue;
   return p;
  }catch{/* Corrupt or foreign retained source does not confer authority. */}
 }
 return null;
}

function noInterveningWrite(snapshot:AssignmentSnapshotV2,op:OperationV2):boolean{
 const at=Date.parse(op.result!.completed_at);
 return !Object.values(snapshot.operations).some(other=>other.operation_id!==op.operation_id&&other.requested_effect==='apply'
  &&(snapshot.in_flight_operation_ids.includes(other.operation_id)||other.persistent_effect==='unknown'
    ||other.persistent_effect==='applied'&&Date.parse(other.result?.completed_at??other.opened_at)>=at));
}

/** Explain a known exclusion from the identity-only load verifier. This reads
 * the same bound native receipt as verification, but never certifies collateral
 * preservation, changes settlement, or supplies a retry/verification recipe. */
export function familyLoadVerificationExclusionGuidanceV2(snapshot:AssignmentSnapshotV2,op:OperationV2):string|null{
 if(op.input?.path!=='/revit/load-family'||op.result?.native_transaction_state!=='committed'
  ||snapshot.input_invalidated_operation_ids?.includes(op.operation_id)
  ||snapshot.unresolved_unknown_operation_ids.length||!noInterveningWrite(snapshot,op))return null;
 const p=row(nativeApply(snapshot,op,true)),t=row(p.transaction);
 const ids=(v:unknown):v is number[]=>Array.isArray(v)&&v.length<=2000
  &&v.every(id=>Number.isSafeInteger(id)&&id>0)&&new Set(v).size===v.length;
 if(!ids(t.added_element_ids)||!ids(t.modified_element_ids)||!ids(t.deleted_element_ids)||!ids(t.affected_element_ids))return null;
 const added=t.added_element_ids,modified=t.modified_element_ids,deleted=t.deleted_element_ids;
 if(!modified.length&&!deleted.length)return null;
 if(newFileLoad(op.input,p))return null; // Supported preservation read is planned below.
 const union=[...added,...modified,...deleted];
 if(union.length>2000||new Set(union).size!==union.length||t.affected_element_ids.length!==union.length
  ||!t.affected_element_ids.every(id=>union.includes(id)))return null;
 // Validate the remaining native identity/transaction/tracking fields using the
 // existing strict additive contract. This local projection is only structural
 // validation for a refusal explanation; it is never admitted as native proof.
 if(!newFileLoad(op.input,{...p,transaction:{...t,modified_element_ids:[],deleted_element_ids:[],affected_element_ids:added}}))return null;
 const show=(values:number[])=>values.slice(0,16).join(', ')+(values.length>16?` (${values.length-16} more; ID list truncated)`:'');
 const footprint=[modified.length?`${modified.length} modified existing IDs [${show(modified)}]`:null,
  deleted.length?`${deleted.length} deleted existing IDs [${show(deleted)}]`:null].filter(Boolean).join(' and ');
 return ` The committed native family load reports ${footprint}. Identity-only verification covers additions only; modified schedules additionally require complete unchanged native before/after observations and a separate current preservation read. That supported preservation contract is not established here; deletions and other collateral remain unsupported. A family/symbol identity read cannot verify this collateral footprint. This diagnosis does not verify preservation or clear pending verification. Do not reload the family or repeat identity-only reads to satisfy this exclusion. Retain the applied effect and its unresolved verification; defer this unsupported verification scope and continue independent work only when the current controller permits it. This is a technical verification limit, not a new engineering-input question.`;
}

export function familySessionPostconditionSatisfiedV2(snapshot:AssignmentSnapshotV2,op:OperationV2,current:OperationResultV2,payload:unknown):boolean{
 if(op.input.path==='/revit/load-family'&&op.result?.native_transaction_state!=='committed')return false;
 const applied=nativeApply(snapshot,op), read=snapshot.operations[current.operation_id];
 if(op.input.path==='/revit/load-family'&&row(row(applied).transaction).modified_element_ids?.length
  &&!nativeApply(snapshot,op,true))return false;
 if(!applied||!read||read.verification_of_operation_id!==op.operation_id||read.purpose!=='verification'
  ||read.requested_effect!=='read'||!current.request_identity?.request_signature
  ||read.request_identity?.request_signature!==current.request_identity.request_signature
  ||read.request_identity?.method!=='POST'||read.request_identity.path!==read.input.path
  ||!sameAssignmentBindingV2(read.binding,op.binding)||!sameAssignmentBindingV2(current.binding,op.binding)
  ||current.authority!=='native-host'||current.status!=='succeeded'||current.dispatch_state!=='dispatched'
  ||current.persistent_effect!=='none'||current.native_transaction_state!=='not_applicable'
  ||current.result_schema_id!=='operator-native/POST:'+read.input.path+'/v2'
  ||!Number.isFinite(Date.parse(current.completed_at))||Date.parse(current.completed_at)<Date.parse(op.result!.completed_at)
  ||payloadDigestV2(payload).digest!==current.raw_payload_hash||!noInterveningWrite(snapshot,op))return false;
 return familySessionReadbackMatchesV2(op.input,applied,read.input,payload);
}

/** A read recipe re-enters ordinary native admission. It never repeats a save,
 * load, close or mutation, nor reconciles an unknown or rewrites saved history. */
export function committedFamilySessionReadbackPlanV2(snapshot:AssignmentSnapshotV2,op:OperationV2){
 if(snapshot.terminal||snapshot.outcome!=='active'||snapshot.completion_proposal||snapshot.execution_control?.state==='paused'
  ||snapshot.unresolved_unknown_operation_ids.length||snapshot.input_invalidated_operation_ids?.includes(op.operation_id)
  ||op.verification_operation_ids.length||appliedOperationHasVerifiedPostconditionV2(snapshot,op.operation_id))return null;
 const p=row(nativeApply(snapshot,op)),b=body(op.input),s=session(b.docId??b.familyDocumentId);
 if(op.input.path==='/revit/load-family'){
  const load=newFileLoad(op.input,p);
  return load&&op.result?.native_transaction_state==='committed'&&noInterveningWrite(snapshot,op)
    &&(!load.scheduleIds.length||nativeApply(snapshot,op,true))
    ?{method:'POST',path:'/revit/get-element-summary',body:{elementIds:[...load.addedIds,...load.scheduleIds].sort((a,b)=>a-b),
      ...(load.scheduleIds.length?{preservationScheduleIds:[...load.scheduleIds].sort((a,b)=>a-b)}:{})}}:null;
 }
 if(!s||!noInterveningWrite(snapshot,op))return null;
 if(op.input.path==='/revit/save-family-doc'&&familySessionSavedV1(op.input.path,b,p))
  return {method:'POST',path:'/revit/inspect-exported-files',body:{familyDocumentId:s,paths:[p.filePath]}};
 if(familySessionReloadedV1(String(op.input.path),b,p))
  return {method:'POST',path:'/revit/get-element-summary',body:{elementIds:[p.loadedFamilyId]}};
 return null;
}
