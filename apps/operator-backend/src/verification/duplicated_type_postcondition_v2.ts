import { payloadDigestV2 } from '@revitoperator/payload-digest-v2';
import { readAuthoritativeEvidence, readEvidenceRef } from '../evidence/evidence_store.js';
import { sameAssignmentBindingV2, type AssignmentSnapshotV2, type OperationV2, type OperationResultV2 } from '../domain/assignment-kernel/index.js';
import { appliedOperationHasVerifiedPostconditionV2 } from '../domain/assignment-kernel/outcome.js';

const route='/revit/duplicate-type-and-swap-instance';
const row=(v:unknown):Record<string,any>=>v&&typeof v==='object'&&!Array.isArray(v)?v as Record<string,any>:{};
const positive=(v:unknown):v is number=>typeof v==='number'&&Number.isSafeInteger(v)&&v>0;

function request(input:unknown) {
 const outer=row(input),b=row(outer.body);
 if(outer.method!=='POST'||outer.path!==route||b.dryRun!==false||b.apply===false||!positive(b.instanceId)
  ||typeof b.newTypeName!=='string'||!b.newTypeName.trim()||b.newTypeName.length>256)return null;
 const changes=b.typeParamChanges??[];
 if(!Array.isArray(changes)||changes.length>50||changes.some(c=>!c||typeof c.parameterName!=='string'
  ||!c.parameterName.trim()||c.parameterName.length>256||typeof c.value!=='string')
  ||new Set(changes.map(c=>c.parameterName.trim())).size!==changes.length)return null;
 // Name/type identity fields are checked separately. They cannot be redefined
 // by the optional parameter batch and then hidden by a conflicting selector.
 if(changes.some(c=>['type','type name','family name'].includes(c.parameterName.trim().toLowerCase())))return null;
 return {instanceId:b.instanceId,name:b.newTypeName.trim(),changes:changes.map(c=>({name:c.parameterName.trim(),value:c.value}))};
}

function identities(input:unknown,payload:unknown) {
 const r=request(input),p=row(payload),tx=row(p.transaction);
 if(!r||p.success!==true||p.typeParameterChangesComplete!==true||p.dryRun!==false||p.instanceId!==r.instanceId
  ||p.newTypeName!==r.name||!positive(p.newTypeId)||p.swappedToTypeId!==p.newTypeId
  ||!positive(p.resultingInstanceId)||!positive(p.sourceTypeId)||p.sourceTypeId===p.newTypeId
  ||p.requestedTypeParamChanges!==r.changes.length||tx.status!=='committed'||tx.committed!==true
  ||!Array.isArray(tx.added_element_ids)||!tx.added_element_ids.includes(p.newTypeId)
  ||!Array.isArray(tx.deleted_element_ids)||!Array.isArray(p.missingAfterElementIds)||p.missingAfterElementIds.length)return null;
 if(p.resultingInstanceId!==r.instanceId&&(!tx.added_element_ids.includes(p.resultingInstanceId)||!tx.deleted_element_ids.includes(r.instanceId)))return null;
 if(p.resultingInstanceId===r.instanceId&&tx.deleted_element_ids.includes(r.instanceId))return null;
 if(!Array.isArray(p.typeParamDiffs)||p.typeParamDiffs.length!==r.changes.length||r.changes.some(c=>{
  const diffs=p.typeParamDiffs.filter((d:any)=>d.parameterName===c.name);
  return diffs.length!==1||diffs[0].typeId!==p.newTypeId||diffs[0].ok!==true;
 }))return null;
 return {...r,instanceId:p.resultingInstanceId,typeId:p.newTypeId};
}

/** A retained authoritative apply may supply new identities, never proof of
 * their final values. All requested values below come from a separate read. */
function nativeApply(snapshot:AssignmentSnapshotV2,op:OperationV2):unknown|null {
 const result=op.result;
 if(!result||result.operation_id!==op.operation_id||result.status!=='succeeded'||result.authority!=='native-host'
  ||result.dispatch_state!=='dispatched'||result.native_transaction_state!=='committed'||result.persistent_effect!=='applied'
  ||op.request_identity?.method!=='POST'||op.request_identity.path!==route||!op.request_identity.request_signature
  ||result.request_identity?.request_signature!==op.request_identity.request_signature
  ||!sameAssignmentBindingV2(snapshot.current_binding,op.binding)||!sameAssignmentBindingV2(result.binding,op.binding)
  ||!Number.isFinite(Date.parse(result.completed_at)))return null;
 for(const id of op.observation_ids){
  const obs=snapshot.observations[id];
  if(!obs||obs.operation_id!==op.operation_id||obs.authority!=='native-host'||obs.raw_payload_hash!==result.raw_payload_hash
   ||!sameAssignmentBindingV2(obs.binding,op.binding))continue;
  try{
   const ref=readEvidenceRef(obs.raw_payload_ref.replace(/^evidence:/,''));if(ref.byte_count>2_000_000)continue;
   const bytes=readAuthoritativeEvidence(ref,{...op.binding,attempt_id:op.operation_id}),payload=JSON.parse(bytes.toString('utf8'));
   if(payloadDigestV2(payload).digest!==result.raw_payload_hash)continue;
   const expected=identities(op.input,payload);
   if(expected&&[request(op.input)!.instanceId,expected.instanceId,expected.typeId].every(n=>result.affected_target_identities?.includes('element_id:'+n)))return payload;
  }catch{/* Missing or corrupt committed evidence leaves verification open. */}
 }
 return null;
}

export function duplicatedTypeReadbackMatchesV2(input:unknown,appliedPayload:unknown,readInput:unknown,payload:unknown):boolean {
 const expected=identities(input,appliedPayload),read=row(readInput),b=row(read.body),items=row(payload).items;
 if(!expected||read.method!=='POST'||read.path!=='/revit/get-parameters'||!Array.isArray(b.elementIds)
  ||b.elementIds.length!==2||new Set(b.elementIds).size!==2||![expected.instanceId,expected.typeId].every(id=>b.elementIds.includes(id))
  ||!Array.isArray(b.names)||!['Type','Type Name',...expected.changes.map(c=>c.name)].every(name=>b.names.includes(name))
  ||!Array.isArray(items)||items.length!==2||new Set(items.map((i:any)=>i.id)).size!==2
  ||items.some((i:any)=>![expected.instanceId,expected.typeId].includes(i.id)||typeof i.uniqueId!=='string'||!i.uniqueId.trim()
   ||i.found===false||i.error||!Array.isArray(i.parameterDetails)))return false;
 const instance=items.find((i:any)=>i.id===expected.instanceId),type=items.find((i:any)=>i.id===expected.typeId);
 const instanceTypes=instance.parameterDetails.filter((p:any)=>p.parameterId===-1002050),names=type.parameterDetails.filter((p:any)=>p.parameterId===-1002001);
 if(instanceTypes.length!==1||instanceTypes[0].name!=='Type'||instanceTypes[0].storageType!=='ElementId'
  ||instanceTypes[0].value!==String(expected.typeId)||instance.parameters?.Type!==String(expected.typeId)
  ||names.length!==1||names[0].name!=='Type Name'||names[0].storageType!=='String'||names[0].value!==expected.name
  ||type.parameters?.['Type Name']!==expected.name||type.name!==expected.name)return false;
 return expected.changes.every(change=>{
  const fields=type.parameterDetails.filter((p:any)=>p.name===change.name);if(fields.length!==1)return false;
  const field=fields[0];if(!Number.isSafeInteger(field.parameterId)||field.parameterId===0||type.parameters?.[change.name]!==field.value)return false;
  if(field.storageType==='String')return field.value===change.value;
  if(field.storageType==='Integer'||field.storageType==='ElementId'){
   const text=change.value.trim();return /^[+-]?\d+$/.test(text)&&Number.isSafeInteger(Number(text))&&field.value===String(Number(text));
  }
  // Length/spec/unit conversion needs its own explicit contract. A native
  // echoed converted value cannot prove an arbitrary user-supplied quantity.
  return false;
 });
}

export function committedDuplicatedTypeReadbackPlanV2(snapshot:AssignmentSnapshotV2,op:OperationV2){
 if(snapshot.terminal||snapshot.outcome!=='active'||snapshot.completion_proposal||snapshot.execution_control?.state==='paused'
  ||snapshot.unresolved_unknown_operation_ids.length||snapshot.input_invalidated_operation_ids?.includes(op.operation_id)
  ||op.admission_state!=='admitted'||op.dispatch_state!=='dispatched'||op.settlement_state!=='settled'
  ||op.requested_effect!=='apply'||op.persistent_effect!=='applied'||op.verification_operation_ids.length
  ||appliedOperationHasVerifiedPostconditionV2(snapshot,op.operation_id))return null;
 const applied=nativeApply(snapshot,op),expected=identities(op.input,applied);if(!expected)return null;
 const ids=[expected.instanceId,expected.typeId].sort((a,b)=>a-b);
 if(Object.values(snapshot.operations).some(other=>other.operation_id!==op.operation_id&&other.requested_effect==='apply'
  &&other.persistent_effect!=='none'&&other.opened_at>=op.opened_at
  &&other.result?.affected_target_identities?.some(id=>ids.some(n=>id==='element_id:'+n))))return null;
 return {method:'POST',path:'/revit/get-parameters',body:{elementIds:ids,names:[...new Set(['Type','Type Name',...expected.changes.map(c=>c.name)])],includeEmpty:true,limit:100}};
}

export function duplicatedTypePostconditionSatisfiedV2(snapshot:AssignmentSnapshotV2,subject:OperationV2,current:OperationResultV2,payload:unknown):boolean{
 const read=snapshot.operations[current.operation_id],commit=subject.result;
 if(!commit||!read||snapshot.unresolved_unknown_operation_ids.length||snapshot.execution_control?.state==='paused'
  ||subject.requested_effect!=='apply'||subject.persistent_effect!=='applied'||subject.settlement_state!=='settled'
  ||snapshot.input_invalidated_operation_ids?.includes(subject.operation_id)||read.requested_effect!=='read'
  ||read.verification_of_operation_id!==subject.operation_id||current.status!=='succeeded'||current.authority!=='native-host'
  ||current.dispatch_state!=='dispatched'||current.persistent_effect!=='none'||current.native_transaction_state!=='not_applicable'
  ||!sameAssignmentBindingV2(current.binding,snapshot.current_binding)||!sameAssignmentBindingV2(read.binding,current.binding)
  ||!read.request_identity?.request_signature||current.request_identity?.request_signature!==read.request_identity.request_signature
  ||![commit.completed_at,read.opened_at,current.completed_at].every(t=>Number.isFinite(Date.parse(t)))
  ||Date.parse(read.opened_at)<Date.parse(commit.completed_at)||Date.parse(current.completed_at)<Date.parse(read.opened_at)
  ||payloadDigestV2(payload).digest!==current.raw_payload_hash)return false;
 const applied=nativeApply(snapshot,subject),expected=identities(subject.input,applied);if(!expected)return false;
 if(Object.values(snapshot.operations).some(other=>other.operation_id!==subject.operation_id&&other.requested_effect==='apply'
  &&other.persistent_effect!=='none'&&other.opened_at>=subject.opened_at
  &&other.result?.affected_target_identities?.some(id=>[expected.instanceId,expected.typeId].some(n=>id==='element_id:'+n))))return false;
 return duplicatedTypeReadbackMatchesV2(subject.input,applied,read.input,payload);
}
