import {payloadDigestV2}from '@revitoperator/payload-digest-v2';
import {readAuthoritativeEvidence,readEvidenceRef}from '../evidence/evidence_store.js';
import {sameAssignmentBindingV2,type AssignmentSnapshotV2,type OperationV2,type OperationResultV2}from '../domain/assignment-kernel/index.js';
import {nativePropertyReadIsFreshNativeV2}from '../assignments/native_observation_inputs_v2.js';

type Row=Record<string,any>;
function row(v:unknown):Row{if(typeof v==='string'&&v.length<=1_000_000){try{return row(JSON.parse(v));}catch{return {};}}return v&&typeof v==='object'&&!Array.isArray(v)?v as Row:{};}
const body=(v:unknown)=>{const r=row(v);return row(r.body??r.arguments??v);};
const positive=(v:unknown):v is number=>Number.isSafeInteger(v)&&Number(v)>0;
const equal=(a:unknown,b:unknown)=>JSON.stringify(a)===JSON.stringify(b);
const key=(v:unknown)=>typeof v==='string'?v.trim().toLowerCase():'';
const ref=(v:unknown)=>typeof v==='string'&&v.startsWith('$')?key(v.slice(1)):
 Object.keys(row(v)).length===1?key(row(v).$ref):'';
const GET='method:Autodesk.Revit.DB.Document.GetElement(Autodesk.Revit.DB.ElementId)';
const CREATE='method:Autodesk.Revit.DB.PhaseFilter.Create(Autodesk.Revit.DB.Document,System.String)';
const SET='method:Autodesk.Revit.DB.PhaseFilter.SetPhaseStatusPresentation(Autodesk.Revit.DB.ElementOnPhaseStatus,Autodesk.Revit.DB.PhaseStatusPresentation)';
const READ='method:Autodesk.Revit.DB.PhaseFilter.GetPhaseStatusPresentation(Autodesk.Revit.DB.ElementOnPhaseStatus)';
const TYPE='Autodesk.Revit.DB.PhaseFilter';
const STATUSES=['New','Existing','Demolished','Temporary'];
// These two native enum values cover explicit inclusion/exclusion. Other
// presentations stay unverified until their exact native wire is qualified.
const PRESENTATIONS=['ShowByCategory','DontShow'];
const enumName=(v:unknown,choices:string[])=>choices.find(x=>key(x)===key(v));
function steps(v:unknown,count:number):Row[]|null{
 const b=body(v);if(!Array.isArray(b.operations)||b.operations.length!==count)return null;
 const out=b.operations.map(row),ids=out.map(s=>key(s.id));
 if(ids.some(id=>!id||id.length>64)||new Set(ids).size!==ids.length
  ||out.some(s=>Object.keys(s).some(k=>!['id','op','target','property','memberId','args'].includes(k))))return null;
 return out;
}
function positiveSet(v:unknown):v is number[]{return Array.isArray(v)&&v.length<=4096&&v.every(positive)&&new Set(v).size===v.length;}
const sameSet=(a:unknown,b:unknown)=>positiveSet(a)&&positiveSet(b)&&a.length===b.length&&a.every(x=>b.includes(x));
export function isNativePhaseFilterEditV2(v:unknown):boolean{
 const ops=body(v).operations;return Array.isArray(ops)&&ops.some(s=>[CREATE,SET].includes(row(s).memberId));
}
/** Complete creation of one new filter only. No partially recognized graph,
 * existing-filter edits, arbitrary code or mixed mutation gets proof credit. */
export function nativePhaseFilterCreationV2(v:unknown){
 if(row(v).path!==undefined&&row(v).path!=='/revit/native-api-mutation-ops')return null;
 const b=body(v),s=steps(v,6),tx=row(b.transaction);if(!s)return null;
 const [doc,create]=s;
 if(doc.op!=='get_property'||key(doc.target)!=='uidoc'||doc.property!=='Document'||doc.args!==undefined||doc.memberId!==undefined
  ||create.op!=='call'||create.memberId!==CREATE||create.target!=null||create.property!==undefined
  ||!Array.isArray(create.args)||create.args.length!==2||ref(create.args[0])!==key(doc.id)
  ||typeof create.args[1]!=='string'||!create.args[1].trim()||create.args[1].length>240
  ||!Array.isArray(b.returns)||!equal(b.returns,['$'+create.id])
  ||tx.mode!=='commit'||tx.allowCreate!==true||!positiveSet(tx.allowedExistingElementIds)||!positive(tx.maxAffectedElements)||tx.maxAffectedElements>4096)return null;
 const values:Record<string,string>={};
 for(const op of s.slice(2)){
  if(op.op!=='call'||op.memberId!==SET||ref(op.target)!==key(create.id)||op.property!==undefined||!Array.isArray(op.args)||op.args.length!==2)return null;
  const status=enumName(op.args[0],STATUSES),presentation=enumName(op.args[1],PRESENTATIONS);
  if(!status||!presentation||values[status]!==undefined)return null;values[status]=presentation;
 }
 if(Object.keys(values).length!==4||Object.values(values).every(x=>x==='DontShow'))return null;
 return {name:create.args[1] as string,values,steps:s,create,transaction:tx};
}
function readGraph(v:unknown){
 if(row(v).path!==undefined&&row(v).path!=='/revit/native-api-ops')return null;
 const b=body(v),s=steps(v,5);if(!s||b.transaction!==undefined)return null;const [lookup]=s;
 if(lookup.op!=='call'||lookup.memberId!==GET||!['doc','document'].includes(key(lookup.target))
  ||lookup.property!==undefined||!Array.isArray(lookup.args)||lookup.args.length!==1||!positive(lookup.args[0]))return null;
 const getters=new Map<string,Row>();
 for(const op of s.slice(1)){
  if(op.op!=='call'||op.memberId!==READ||ref(op.target)!==key(lookup.id)||op.property!==undefined||!Array.isArray(op.args)||op.args.length!==1)return null;
  const status=enumName(op.args[0],STATUSES);if(!status||getters.has(status))return null;getters.set(status,op);
 }
 const expected=s.map(op=>'$'+op.id).sort();
 if(!Array.isArray(b.returns)||b.returns.length!==5||!equal([...b.returns].sort(),expected))return null;
 return {id:lookup.args[0] as number,lookup,getters,steps:s};
}
export function nativePhaseFilterReadTargetsV2(v:unknown):number[]{const g=readGraph(v);return g?[g.id]:[];}
function nativeRows(p:Row,s:Row[]){
 if(p.error||p.isError===true||p.truncated===true||p.ok!==true||!Array.isArray(p.operations)||p.operations.length!==s.length||p.operation_count!==s.length
  ||!Array.isArray(p.geometry_cleanup_errors)||p.geometry_cleanup_errors.length)return null;
 for(const [i,op]of s.entries()){const n=row(p.operations[i]);if(n.error||n.ok===false||n.id!==op.id||n.op!==op.op||(op.op==='call'&&n.member_id!==op.memberId)||(op.op==='get_property'&&n.property!==op.property))return null;}
 return p.operations.map(row) as Row[];
}
function receiver(n:Row,id:number,uid:string){const r=row(n.target_identity);return n.target_type===TYPE&&r.schema==='operator.native_element_receiver.v1'
 &&r.type_name===TYPE&&r.element_id===id&&r.unique_id===uid&&r.active_document===true;}
export function decodeNativePhaseFilterReadV2(input:unknown,payload:unknown){
 const g=readGraph(input),p=row(payload);if(!g||p.version!=='operator.native_api_ops.v2'||p.read_only!==true)return null;
 const n=nativeRows(p,g.steps),results=row(p.results);if(!n||Object.keys(results).length!==5)return null;
 const identity=row(n[0].result_preview),uid=identity.unique_id;
 if(n[0].target_type!=='Autodesk.Revit.DB.Document'||identity.id!==g.id||typeof uid!=='string'||!uid||typeof identity.name!=='string'
  ||!equal(results[g.lookup.id],identity))return null;
 const values:Record<string,string>={};
 for(const [status,op]of g.getters){const native=n.find(x=>x.id===op.id)!;const actual=enumName(native.result_preview,PRESENTATIONS);
  if(!receiver(native,g.id,uid)||!actual||results[op.id]!==native.result_preview)return null;values[status]=actual;}
 return {id:g.id,uniqueId:uid,name:identity.name as string,values};
}
export function nativePhaseFilterReadbackMatchesV2(input:unknown,appliedPayload:unknown,readInput:unknown,readPayload:unknown,affected:readonly string[]):boolean{
 const g=nativePhaseFilterCreationV2(input),a=row(appliedPayload),r=decodeNativePhaseFilterReadV2(readInput,readPayload);if(!g||!r||a.version!=='operator.native_api_mutation_ops.v1'||a.read_only!==false)return false;
 const native=nativeRows(a,g.steps),tx=row(a.transaction);if(!native)return false;
 const created=row(native[1].result_preview),uid=created.unique_id;
 if(!positive(created.id)||typeof uid!=='string'||!uid||created.name!==g.name||r.id!==created.id||r.uniqueId!==uid||r.name!==g.name
  ||!equal(row(a.results)[g.create.id],created)||Object.keys(row(a.results)).length!==1
  ||native[0].target_type!=='Autodesk.Revit.UI.UIDocument'||native.slice(2).some(n=>!receiver(n,created.id,uid)))return false;
 if(tx.mode!=='commit'||tx.status!=='committed'||tx.committed!==true||tx.dry_run!==false||tx.allow_create!==true||tx.pending===true||tx.rolled_back===true
  ||tx.scope_enforcement!=='failure_processing_allowed_commit'||tx.existing_scope_matched!==true||tx.scope_discovery_only!==false
  ||tx.scope_baseline!=='complete_native_document_ids_before_transaction'||!positive(tx.scope_baseline_element_count)||!positive(tx.scope_observer_executions)
  ||!equal(tx.added_element_ids,[created.id])||!equal(tx.deleted_element_ids,[])||!equal(tx.transient_created_ids,[])
  ||!equal(tx.unexpected_existing_element_ids,[])||!positiveSet(tx.modified_element_ids)||tx.modified_element_ids.includes(created.id)
  ||tx.modified_element_ids.some((id:number)=>!g.transaction.allowedExistingElementIds.includes(id))
  ||!sameSet(tx.allowed_existing_element_ids,g.transaction.allowedExistingElementIds)||!sameSet(tx.commit_allowed_existing_element_ids,g.transaction.allowedExistingElementIds)
  ||tx.max_affected_elements!==g.transaction.maxAffectedElements||a.mutation_operation_count!==5)return false;
 const all=[created.id,...tx.modified_element_ids];
 if(tx.affected_element_count!==all.length||all.length>g.transaction.maxAffectedElements||!equal([...affected].sort(),all.map(id=>'element_id:'+id).sort()))return false;
 return STATUSES.every(status=>r.values[status]===g.values[status]);
}
function retained(snapshot:AssignmentSnapshotV2,op:OperationV2){for(const id of op.observation_ids){const o=snapshot.observations[id];
 if(!o||o.authority!=='native-host'||o.operation_id!==op.operation_id||o.raw_payload_hash!==op.result?.raw_payload_hash||!sameAssignmentBindingV2(o.binding,op.binding))continue;
 try{const ref=readEvidenceRef(o.raw_payload_ref.replace(/^evidence:/,''));if(ref.byte_count>1_000_000)continue;
  const payload=JSON.parse(readAuthoritativeEvidence(ref,{...op.binding,attempt_id:op.operation_id}).toString('utf8'));if(payloadDigestV2(payload).digest===op.result?.raw_payload_hash)return payload;
 }catch{/* Missing immutable receipt never authorizes a repeat mutation. */}
 }return null;}
/** Predicate credit only. Does not certify unrequested existing collateral. */
export function nativePhaseFilterPostconditionSatisfiedV2(snapshot:AssignmentSnapshotV2,op:OperationV2,result:OperationResultV2,payload:unknown):boolean{
 const read=snapshot.operations[result.operation_id],commit=op.result;
 if(!read||!commit||snapshot.unresolved_unknown_operation_ids.length||snapshot.input_invalidated_operation_ids?.some(id=>[op.operation_id,read.operation_id].includes(id))
  ||op.request_identity?.path!=='/revit/native-api-mutation-ops'||op.input.path!==op.request_identity.path||op.input.method!=='POST'
  ||op.requested_effect!=='apply'||op.admission_state!=='admitted'||op.dispatch_state!=='dispatched'||op.settlement_state!=='settled'||op.persistent_effect!=='applied'
  ||!sameAssignmentBindingV2(op.binding,snapshot.current_binding)||!sameAssignmentBindingV2(commit.binding,op.binding)||commit.operation_id!==op.operation_id
  ||commit.dispatch_state!=='dispatched'||commit.request_identity?.request_signature!==op.request_identity.request_signature||!commit.receipt_id||!commit.native_correlation_id
  ||read.purpose!=='verification'||read.fulfillment_role!=='verification'||read.verification_of_operation_id!==op.operation_id||read.requested_effect!=='read'
  ||!sameAssignmentBindingV2(read.binding,snapshot.current_binding)||!nativePropertyReadIsFreshNativeV2(op,read,result)||result.native_transaction_state!=='not_applicable'
  ||!result.receipt_id||!result.native_correlation_id||payloadDigestV2(payload).digest!==result.raw_payload_hash
  ||Object.values(snapshot.operations).some(o=>o.requested_effect==='apply'&&(o.persistent_effect==='unknown'||snapshot.in_flight_operation_ids.includes(o.operation_id))))return false;
 const applied=retained(snapshot,op);return applied!==null&&nativePhaseFilterReadbackMatchesV2(op.input,applied,read.input,payload,commit.affected_target_identities??[]);
}
