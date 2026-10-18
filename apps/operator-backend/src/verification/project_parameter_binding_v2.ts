import { payloadDigestV2 } from '@revitoperator/payload-digest-v2';
import { readAuthoritativeEvidence, readEvidenceRef } from '../evidence/evidence_store.js';
import { canonicalJsonV2, sameAssignmentBindingV2, type AssignmentSnapshotV2, type OperationV2, type OperationResultV2 } from '../domain/assignment-kernel/index.js';
import { appliedOperationHasVerifiedPostconditionV2 } from '../domain/assignment-kernel/outcome.js';

const object = (v: unknown): Record<string, any> => v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, any> : {};
const positive = (v: unknown): v is number => Number.isSafeInteger(v) && Number(v) > 0;
const equal = (a: unknown, b: unknown) => canonicalJsonV2(a) === canonicalJsonV2(b);
const identity = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && v.length <= 1024;
const hash = (v: unknown) => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
const guid = (v: unknown) => typeof v === 'string' && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(v);
const route = '/revit/project-parameters';
const normalizedType = (v: string) => ({yes_no:'yesno','yes/no':'yesno',multiline:'multiline_text',multilinetext:'multiline_text'}[v] ?? v);
const normalizedGroup = (v: string) => v === 'identity' ? 'identity_data' : v;
function preservation(value: unknown, categoryIds: number[]) {
  const p=object(value);
  if(p.schema!=='operator.project_binding_preservation.v1'||p.complete!==true||p.coverage!=='category_instances_and_types_raw_parameters_v1'
      ||!equal(p.categoryIds,[...categoryIds].sort((a,b)=>a-b))||!(p.excludedParameterId===null||positive(p.excludedParameterId))
      ||!Array.isArray(p.elements)||p.elements.length>10000||p.elementCount!==p.elements.length
      ||!Number.isSafeInteger(p.totalParameters)||p.totalParameters<0||p.totalParameters>300000)return null;
  const rows=new Map<number,Record<string,any>>(),uids=new Set<string>();let count=0;
  for(const raw of p.elements){const r=object(raw);
    if(!positive(r.id)||!identity(r.uniqueId)||uids.has(r.uniqueId)||rows.has(r.id)||!categoryIds.includes(r.categoryId)
        ||!(r.typeId===-1||positive(r.typeId))||typeof r.isType!=='boolean'||!Number.isSafeInteger(r.parameterCount)
        ||r.parameterCount<0||r.parameterCount>2048||!hash(r.parametersHash))return null;
    rows.set(r.id,r);uids.add(r.uniqueId);count+=r.parameterCount;
  }
  if(count!==p.totalParameters)return null;
  for(const r of rows.values())if(!r.isType&&r.typeId>0&&rows.get(r.typeId)?.isType!==true)return null;
  return {value:p,rows};
}
export function projectParameterBindingRequestV2(input: unknown) {
  const wrapper = object(input), b = object(wrapper.body ?? input);
  if (b.action !== 'create' || Object.keys(b).some(k => !['action','name','categoryNames','instanceBinding','parameterGroup','dataType','visible','userModifiable','rebindIfExists','dryRun'].includes(k))
      || typeof b.name !== 'string' || !b.name.trim() || b.name.length > 128
      || !Array.isArray(b.categoryNames) || !b.categoryNames.length || b.categoryNames.length > 200
      || b.categoryNames.some((v: unknown) => typeof v !== 'string' || !v.trim() || v.length > 120)
      || ['instanceBinding','visible','userModifiable','rebindIfExists','dryRun'].some(k => b[k] !== undefined && typeof b[k] !== 'boolean')
      || b.rebindIfExists === true || b.dryRun === true
      || (b.dataType !== undefined && !['text','url','multiline_text','multiline','multilinetext','yesno','yes_no','yes/no','integer','number'].includes(b.dataType))
      || (b.parameterGroup !== undefined && !['identity_data','identity','data','text','constraints','geometry','materials','graphics','phasing'].includes(b.parameterGroup))) return null;
  return {name:b.name.trim(), categories:[...new Set<string>(b.categoryNames.map((v:string)=>v.trim()))].sort(),
    isInstance:b.instanceBinding ?? true, dataType:normalizedType(b.dataType ?? 'text'), group:normalizedGroup(b.parameterGroup ?? 'identity_data'),
    visible:b.visible ?? true, userModifiable:b.userModifiable ?? true};
}
export function projectParameterBindingReadIdV2(input: unknown): number | null {
  const wrapper=object(input), b=object(wrapper.body ?? input);
  return b.action==='detail' && positive(b.parameterId) && Object.keys(b).every(k=>['action','parameterId'].includes(k)) ? b.parameterId : null;
}
function detail(value: unknown) {
  const v=object(value), p=object(v.parameter);
  if(v.status!=='Ok'||v.action!=='detail'||v.read_only!==true||v.schema!=='operator.project_parameter_binding.v1'||v.complete!==true
      ||v.coverage!=='native_shared_binding_and_owner_type_preservation_v2'||!hash(v.otherBindingsHash)
      ||!positive(p.id)||!identity(p.uniqueId)||!identity(p.name)||!guid(p.guid)||!identity(p.dataTypeId)||!identity(p.groupTypeId)
      ||typeof p.isInstance!=='boolean'||typeof p.visible!=='boolean'||!Array.isArray(p.categories)||!p.categories.length||p.categories.length>200
      ||!Array.isArray(v.owners)||v.owners.length>5000)return null;
  const categories=new Set<number>();
  for(const raw of p.categories){const c=object(raw);if(!Number.isSafeInteger(c.id)||c.id>=0||!identity(c.name)||categories.has(c.id))return null;categories.add(c.id);}
  const owners=new Map<number,Record<string,any>>();
  for(const raw of v.owners){const o=object(raw);
    if(!positive(o.id)||!identity(o.uniqueId)||!Number.isSafeInteger(o.typeId)||!categories.has(o.categoryId)||owners.has(o.id)
        ||o.hasParameter!==true||o.parameterId!==p.id||typeof o.hasValue!=='boolean'||typeof o.userModifiable!=='boolean'||typeof o.isReadOnly!=='boolean'
        ||!['String','Integer','Double'].includes(o.storage)||!Object.hasOwn(o,'value'))return null;
    if(!o.hasValue ? o.value!==null : o.storage==='String' ? typeof o.value!=='string'
        : o.storage==='Integer' ? !Number.isSafeInteger(o.value) : typeof o.value!=='number'||!Number.isFinite(o.value))return null;
    owners.set(o.id,o);
  }
  const preserved=preservation(v.preservation,[...categories]);
  if(!preserved||preserved.value.excludedParameterId!==p.id
      ||[...preserved.rows.values()].filter(r=>r.isType===!p.isInstance).length!==owners.size)return null;
  for(const o of owners.values()){
    const r=preserved.rows.get(o.id);
    if(!r||r.uniqueId!==o.uniqueId||r.typeId!==o.typeId||r.categoryId!==o.categoryId||r.isType!==!p.isInstance)return null;
  }
  return {value:v,parameter:p,owners,preserved};
}
function inventory(value: unknown) {
  const t=object(value), a=t.added_element_ids,m=t.modified_element_ids,d=t.deleted_element_ids;
  if(t.committed!==true||t.pending===true||t.rolledBack===true
      ||![a,m,d].every(ids=>Array.isArray(ids)&&ids.length<=6000&&ids.every(positive)&&new Set(ids).size===ids.length)
      ||d.length||a.some((id:number)=>m.includes(id)))return null;
  return {added:a as number[],modified:m as number[]};
}
function emptyDefault(owner:Record<string,any>) {
  return owner.hasValue===false ? owner.value===null : owner.storage==='String' ? owner.value==='' : owner.value===0;
}
/** Proves a new shared binding and unchanged initial values, not family-file authoring or engineering suitability. */
export function projectParameterBindingReadbackMatchesV2(input:unknown,applied:unknown,fresh:unknown):boolean {
  const w=projectParameterBindingRequestV2(input),a=object(applied),p=detail(a.bindingReadback),n=detail(fresh),tx=inventory(a.transaction),r=object(a.requestedDefinition),resolution=object(a.requestResolution);
  if(!w||!p||!n||!tx||a.status!=='Success'||a.action!=='create'||a.mode!=='create_new'||a.dryRun!==false
      ||object(a.changeTracking).exhaustiveChangeInventory!==true||!equal(p.value,n.value)||!equal(a.parameter,p.parameter)
      ||!hash(a.otherBindingsHashBefore)||p.value.otherBindingsHash!==a.otherBindingsHashBefore
      ||!Array.isArray(a.ownerValuesBefore)||a.ownerValuesBefore.length!==p.owners.size
      ||!['dataTypeToken','groupToken','categoryRequests'].every(k=>Object.hasOwn(resolution,k))
      ||normalizedType(resolution.dataTypeToken)!==w.dataType||normalizedGroup(resolution.groupToken)!==w.group
      ||!Array.isArray(resolution.categoryRequests)||resolution.categoryRequests.length!==w.categories.length
      ||!equal(resolution.categoryRequests.map((v:unknown)=>object(v).requested).sort(),w.categories)
      ||!equal([...new Set(resolution.categoryRequests.map((v:unknown)=>object(v).id))].sort((x:any,y:any)=>x-y),p.parameter.categories.map((v:any)=>v.id).sort((x:number,y:number)=>x-y))
      ||r.name!==w.name||r.isInstance!==w.isInstance||r.visible!==w.visible||r.userModifiable!==w.userModifiable)return false;
  const {userModifiable,...requestedNative}=r;
  if(!equal(p.parameter,{...requestedNative,id:p.parameter.id,uniqueId:p.parameter.uniqueId})
      ||object(a.externalDefinitionEffect).selectionRestored!==true)return false;
  const existing=a.existingParameterElementIdBefore;
  if(existing!==null&&existing!==p.parameter.id)return false;
  const before=preservation(a.preservationBefore,p.parameter.categories.map((c:any)=>c.id));
  if(!before||before.value.excludedParameterId!==existing||!equal(before.value.elements,p.preserved.value.elements)
      ||before.value.elementCount!==p.preserved.value.elementCount||before.value.totalParameters!==p.preserved.value.totalParameters)return false;
  if(!equal(tx.added,existing===null?[p.parameter.id]:[])||![...tx.added,...tx.modified].includes(p.parameter.id)
      ||tx.modified.some(id=>id!==p.parameter.id&&!p.owners.has(id)))return false;
  const storage=['text','url','multiline_text'].includes(w.dataType)?'String':w.dataType==='number'?'Double':'Integer';
  const seen=new Set<number>();
  for(const raw of a.ownerValuesBefore){const old=object(raw),current=p.owners.get(old.id);
    if(!current||seen.has(old.id)||old.uniqueId!==current.uniqueId||old.typeId!==current.typeId||old.categoryId!==current.categoryId
        ||typeof old.hasParameter!=='boolean'||current.storage!==storage||current.userModifiable!==userModifiable)return false;
    seen.add(old.id);
    if(old.hasParameter){
      if(old.parameterId!==p.parameter.id||!['storage','hasValue','value','userModifiable','isReadOnly'].every(k=>Object.hasOwn(old,k)&&equal(old[k],current[k])))return false;
    }else if(!emptyDefault(current))return false;
  }
  return seen.size===p.owners.size;
}

function retainedApply(snapshot:AssignmentSnapshotV2,op:OperationV2) {
  for(const id of op.observation_ids){const o=snapshot.observations[id];
    if(!o||o.authority!=='native-host'||o.operation_id!==op.operation_id||o.raw_payload_hash!==op.result?.raw_payload_hash||!sameAssignmentBindingV2(o.binding,op.binding))continue;
    try{
      const ref=readEvidenceRef(o.raw_payload_ref.replace(/^evidence:/,''));if(ref.byte_count>2_000_000)continue;
      const payload=JSON.parse(readAuthoritativeEvidence(ref,{...op.binding,attempt_id:op.operation_id}).toString('utf8'));
      if(payloadDigestV2(payload).digest===op.result?.raw_payload_hash)return payload;
    }catch{/* Missing or unbound apply evidence stays unverified; never replay its mutation. */}
  }
  return null;
}
function settledApply(snapshot:AssignmentSnapshotV2,op:OperationV2) {
  const r=op.result;
  if(!projectParameterBindingRequestV2(op.input)||snapshot.unresolved_unknown_operation_ids.length||snapshot.input_invalidated_operation_ids?.includes(op.operation_id)
      ||!sameAssignmentBindingV2(op.binding,snapshot.current_binding)||op.request_identity?.path!==route||op.input.path!==route||op.input.method!=='POST'
      ||op.requested_effect!=='apply'||op.admission_state!=='admitted'||op.dispatch_state!=='dispatched'||op.settlement_state!=='settled'||op.persistent_effect!=='applied'
      ||!r||r.authority!=='native-host'||r.status!=='succeeded'||r.dispatch_state!=='dispatched'||r.native_transaction_state!=='committed'||r.persistent_effect!=='applied'
      ||!sameAssignmentBindingV2(r.binding,op.binding)||r.operation_id!==op.operation_id||r.request_identity?.request_signature!==op.request_identity.request_signature
      ||!r.native_correlation_id||!r.receipt_id||!Number.isFinite(Date.parse(r.completed_at))||!Array.isArray(r.affected_target_identities))return null;
  if(Object.values(snapshot.operations).some(other=>other.operation_id!==op.operation_id&&other.requested_effect==='apply'
      &&((other.dispatch_state==='dispatched'&&other.settlement_state!=='settled')
        ||(other.persistent_effect!=='none'&&other.result&&Date.parse(other.result.completed_at)>=Date.parse(r.completed_at)))))return null;
  const payload=retainedApply(snapshot,op),p=object(payload),id=object(p.parameter).id,tx=inventory(p.transaction);
  if(!positive(id)||!tx||new Set(r.affected_target_identities).size!==r.affected_target_identities.length
      ||!equal([...tx.added,...tx.modified].map(n=>'element_id:'+n).sort(),[...r.affected_target_identities].sort()))return null;
  return {id,payload};
}
export function committedProjectParameterBindingReadbackPlanV2(snapshot:AssignmentSnapshotV2,op:OperationV2) {
  const wanted=settledApply(snapshot,op);
  if(!wanted||snapshot.terminal||snapshot.outcome!=='active'||snapshot.completion_proposal||snapshot.execution_control?.state==='paused'
      ||op.verification_operation_ids.length||appliedOperationHasVerifiedPostconditionV2(snapshot,op.operation_id))return null;
  return {method:'POST',path:route,body:{action:'detail',parameterId:wanted.id}};
}
export function projectParameterBindingPostconditionSatisfiedV2(snapshot:AssignmentSnapshotV2,op:OperationV2,read:OperationResultV2,payload:unknown) {
  const wanted=settledApply(snapshot,op);
  if(!wanted||read.authority!=='native-host'||read.status!=='succeeded'||read.dispatch_state!=='dispatched'||read.persistent_effect!=='none'
      ||read.native_transaction_state!=='not_applicable'||!sameAssignmentBindingV2(read.binding,snapshot.current_binding)||read.request_identity?.method!=='POST'||read.request_identity.path!==route
      ||!read.request_identity.request_signature||!read.native_correlation_id||!read.receipt_id
      ||!Number.isFinite(Date.parse(read.completed_at))||Date.parse(read.completed_at)<=Date.parse(op.result!.completed_at)||payloadDigestV2(payload).digest!==read.raw_payload_hash)return false;
  const readOp=snapshot.operations[read.operation_id];
  if(!readOp||readOp.requested_effect!=='read'||readOp.admission_state!=='admitted'||!['dispatching','dispatched'].includes(readOp.dispatch_state)
      ||readOp.input.path!==route||readOp.input.method!=='POST'||readOp.purpose!=='verification'||readOp.verification_of_operation_id!==op.operation_id
      ||snapshot.input_invalidated_operation_ids?.includes(readOp.operation_id)||!Number.isFinite(Date.parse(readOp.opened_at))
      ||Date.parse(readOp.opened_at)<Date.parse(op.result!.completed_at)||Date.parse(read.completed_at)<Date.parse(readOp.opened_at)
      ||!sameAssignmentBindingV2(readOp.binding,read.binding)||readOp.request_identity?.request_signature!==read.request_identity.request_signature
      ||!equal(readOp.input.body,{action:'detail',parameterId:wanted.id}))return false;
  return projectParameterBindingReadbackMatchesV2(op.input,wanted.payload,payload);
}
