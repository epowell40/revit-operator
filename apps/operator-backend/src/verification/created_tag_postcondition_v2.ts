import { payloadDigestV2 } from '@revitoperator/payload-digest-v2';
import { readAuthoritativeEvidence, readEvidenceRef } from '../evidence/evidence_store.js';
import { sameAssignmentBindingV2, type AssignmentSnapshotV2, type OperationV2, type OperationResultV2 } from '../domain/assignment-kernel/index.js';
import { appliedOperationHasVerifiedPostconditionV2 } from '../domain/assignment-kernel/outcome.js';

const GET_ELEMENT='method:Autodesk.Revit.DB.Document.GetElement(Autodesk.Revit.DB.ElementId)';
const GET_TYPE='method:Autodesk.Revit.DB.Element.GetTypeId()';
const GET_SUBJECTS='method:Autodesk.Revit.DB.IndependentTag.GetTaggedLocalElements()';
const SPATIAL_CLASSES={Room:'Autodesk.Revit.DB.Architecture.RoomTag',Space:'Autodesk.Revit.DB.Mechanical.SpaceTag'} as const;
const row=(v:unknown):Record<string,any>=>v&&typeof v==='object'&&!Array.isArray(v)?v as Record<string,any>:{};
const positive=(n:unknown):n is number=>typeof n==='number'&&Number.isSafeInteger(n)&&n>0;
const unique=(a:unknown[])=>new Set(a).size===a.length;
const body=(v:unknown)=>{const o=row(v);try{return row(typeof o.body==='string'?JSON.parse(o.body):o.body??v);}catch{return {};}};

/** Bounded explicit local-subject creation. Broader category searches and
 * skipped/preexisting tags need their own complete inventory, not this proof. */
export function createdTagRequestV2(input:unknown) {
 const o=row(input),b=body(input);
 if(o.method!=='POST'||o.path!=='/revit/tag-elements'||b.repairExistingTagId!=null||b.dryRun!==false||b.apply===false
  ||!positive(b.viewId)||(b.tagTypeId!=null&&!positive(b.tagTypeId))||!Array.isArray(b.elementIds)||!b.elementIds.length||b.elementIds.length>2
  ||!b.elementIds.every(positive)||!unique(b.elementIds)||typeof b.addLeader!=='boolean'
  ||b.categoryNames?.length||b.categoryTagTypeMap!=null||b.tagTypeName!=null
  ||b.orientation!=null&&!['horizontal','vertical'].includes(b.orientation))return null;
 return {viewId:b.viewId,typeId:positive(b.tagTypeId)?b.tagTypeId:null,subjectIds:b.elementIds as number[],hasLeader:b.addLeader,orientation:(b.orientation??'horizontal') as string};
}

/** Default selection is a native resolution, not an agent-supplied type.
 * Pin that resolution only from a complete committed creation inventory.
 * A separate fresh read must still establish the type and local association. */
function resolvedRequest(input:unknown,payload:unknown) {
 const r=createdTagRequestV2(input),p=row(payload);
 if(!r)return null;
 if(r.typeId!==null)return {...r,typeId:r.typeId};
 const ids=p.tagIds,rows=p.tagReadback;
 if(p.success!==true||p.applied!==true||row(p.transaction).status!=='committed'
  ||p.tagFamily!=null||!Array.isArray(ids)||ids.length!==r.subjectIds.length||!ids.every(positive)||!unique(ids)
  ||!Array.isArray(rows)||rows.length!==ids.length||!unique(rows.map((x:any)=>x?.tagId))
  ||!unique(rows.map((x:any)=>x?.targetElementId)))return null;
 for(const x of rows)if(!x||!ids.includes(x.tagId)||!r.subjectIds.includes(x.targetElementId)
  ||x.viewId!==r.viewId||!positive(x.tagTypeId)||typeof x.tagCategory!=='string'||typeof x.targetCategory!=='string')return null;
 const typeId=rows[0].tagTypeId;
 if(rows.some((x:any)=>x.tagTypeId!==typeId))return null;
 return {...r,typeId};
}

function createdIds(input:unknown,payload:unknown):number[]|null {
 const r=resolvedRequest(input,payload),p=row(payload),tx=row(p.transaction),ids=p.tagIds;
 if(!r||p.success!==true||p.applied!==true||p.viewId!==r.viewId||tx.status!=='committed'||tx.committed!==true
  ||p.continuationRequired===true||p.deferredCount!==0||p.errorCount!==0||p.skippedAlreadyTagged!==0||p.skippedNoLocation!==0
  ||p.targetCount!==r.subjectIds.length||p.taggedCount!==r.subjectIds.length
  ||!Array.isArray(ids)||ids.length!==r.subjectIds.length||!ids.every(positive)||!unique(ids)
  ||!Array.isArray(tx.added_element_ids)||!ids.every(id=>tx.added_element_ids.includes(id))
  ||!Array.isArray(tx.deleted_element_ids)||tx.deleted_element_ids.some((id:any)=>ids.includes(id)))return null;
 return [...ids].sort((a,b)=>a-b);
}

function spatialAssociation(payload:any,r:NonNullable<ReturnType<typeof createdTagRequestV2>>,id:number):'Space'|'Room'|null {
 const nativeRow=Array.isArray(payload?.tagReadback)?payload.tagReadback.find((x:any)=>x.tagId===id&&x.viewId===r.viewId&&x.tagTypeId===r.typeId&&r.subjectIds.includes(x.targetElementId)):null;
 return nativeRow?.tagCategory==='Space Tags'&&nativeRow.targetCategory==='Spaces'?'Space'
  :nativeRow?.tagCategory==='Room Tags'&&nativeRow.targetCategory==='Rooms'?'Room':null;
}

/** Only a reviewed read graph admits tag-association semantics. No arbitrary
 * native API graph or apply-local tagReadback flag becomes verification. */
function readGraph(input:unknown) {
 const o=row(input),b=body(input),ops=b.operations;
 if(o.method!=='POST'||o.path!=='/revit/native-api-ops'||!Array.isArray(ops)||ops.length<6||ops.length>16)return null;
 const names=new Set<string>(),handles=new Set<string>(),tagHandles=new Set<string>(),tagIds=new Set<number>();
 for(const op of ops){
  if(!op||typeof op.id!=='string'||!/^[A-Za-z0-9_-]{1,80}$/.test(op.id)||names.has(op.id))return null;
  names.add(op.id);
  if(op.op==='call'&&op.target==='doc'&&op.memberId===GET_ELEMENT&&Array.isArray(op.args)&&op.args.length===1&&positive(op.args[0])){
   handles.add('$'+op.id);
  }else if(op.op==='get_property'&&handles.has(op.target)&&['OwnerViewId','HasLeader','TagOrientation','Room','Space','IsOrphaned'].includes(op.property)){
   tagHandles.add(op.target);
  }else if(op.op==='call'&&handles.has(op.target)&&[GET_TYPE,GET_SUBJECTS].includes(op.memberId)
   &&(op.args===undefined||Array.isArray(op.args)&&op.args.length===0))tagHandles.add(op.target);
  else return null;
 }
 for(const handle of tagHandles){const op=ops.find(x=>'$'+x.id===handle);tagIds.add(op.args[0]);
  const children=ops.filter(x=>x.target===handle);
  const associations=children.filter(x=>x.op==='call'&&x.memberId===GET_SUBJECTS||x.op==='get_property'&&['Room','Space'].includes(x.property));
  const spatial=associations[0]?.op==='get_property';
  if(children.length<4||associations.length!==1||!['OwnerViewId','HasLeader'].every(p=>children.filter(x=>x.op==='get_property'&&x.property===p).length===1)
   ||children.filter(x=>x.op==='call'&&x.memberId===GET_TYPE).length!==1
   ||children.filter(x=>x.property==='TagOrientation').length>1
   ||children.filter(x=>x.property==='IsOrphaned').length!==(spatial?1:0))return null;
 }
 if(!tagIds.size||tagIds.size>2||!Array.isArray(b.returns)||!unique(b.returns)
  ||b.returns.length!==ops.length||!ops.every(op=>b.returns.includes('$'+op.id)))return null;
 return {ops,tagIds:[...tagIds].sort((a,b)=>a-b)};
}
export function nativeCreatedTagReadTargetsV2(input:unknown):readonly string[]{return readGraph(input)?.tagIds.map(n=>'id:'+n)??[];}

export function decodeNativeCreatedTagReadV2(input:unknown,payload:unknown){
 const q=readGraph(input),p=row(payload);
 if(!q||p.version!=='operator.native_api_ops.v2'||p.ok!==true||p.read_only!==true||p.operation_count!==q.ops.length
  ||!Array.isArray(p.operations)||p.operations.length!==q.ops.length)return null;
 const handles=new Map<string,any>(),elements=new Map<number,string>();
 for(let i=0;i<q.ops.length;i++){
  const op=q.ops[i],seen=p.operations[i];if(!seen||seen.id!==op.id||seen.op!==op.op)return null;
  if(op.target==='doc'){
   const id=row(seen.result_preview);
   if(seen.member_id!==GET_ELEMENT||seen.target_type!=='Autodesk.Revit.DB.Document'||id.id!==op.args[0]
    ||typeof id.unique_id!=='string'||id.unique_id.length<10||id.unique_id.length>120
    ||elements.has(id.id)&&elements.get(id.id)!==id.unique_id)return null;
   elements.set(id.id,id.unique_id);handles.set('$'+op.id,{id:id.id,uniqueId:id.unique_id,properties:{}});
  }else{
   const tag=handles.get(op.target);
   const association=q.ops.find(x=>x.target===op.target&&(x.memberId===GET_SUBJECTS||['Room','Space'].includes(x.property)));
   const expectedClass=association?.property?SPATIAL_CLASSES[association.property as keyof typeof SPATIAL_CLASSES]:'Autodesk.Revit.DB.IndependentTag';
   if(!tag||!expectedClass||seen.target_type!==expectedClass)return null;
   tag.nativeClass=expectedClass;
   if(op.op==='get_property'){
    if(seen.property!==op.property||!Object.hasOwn(seen,'result_preview'))return null;
    tag.properties[op.property]=seen.result_preview;
    if(['Room','Space'].includes(op.property)){
     const subject=row(seen.result_preview);
     if(!positive(subject.id)||typeof subject.unique_id!=='string'||subject.unique_id.length<10||subject.unique_id.length>120)return null;
     tag.subject=subject;
    }
   }else if(op.memberId===GET_TYPE){
    if(seen.member_id!==GET_TYPE||!positive(seen.result_preview?.id))return null;
    tag.typeId=seen.result_preview.id;
   }else{
    const c=row(p.results?.[op.id]);
    if(seen.member_id!==GET_SUBJECTS||c.complete!==true||c.truncated!==false||c.hasMore!==false||c.count!==1||c.total!==1
     ||!Array.isArray(c.items)||c.items.length!==1||!positive(c.items[0]?.id)||typeof c.items[0].unique_id!=='string')return null;
    tag.subject=c.items[0];
   }
  }
 }
 const tags=[...handles.values()].filter(t=>q.tagIds.includes(t.id));
 if(tags.length!==q.tagIds.length)return null;
 for(const t of tags)if(!t.subject||elements.get(t.subject.id)!==t.subject.unique_id
  ||t.nativeClass!=='Autodesk.Revit.DB.IndependentTag'&&t.properties.IsOrphaned!==false)return null;
 return tags;
}

export function createdTagReadbackMatchesV2(input:unknown,applyPayload:unknown,readInput:unknown,payload:unknown):boolean{
 const r=resolvedRequest(input,applyPayload),ids=createdIds(input,applyPayload),tags=decodeNativeCreatedTagReadV2(readInput,payload);
 if(!r||!ids||!tags||tags.length!==ids.length||!unique(tags.map(t=>t.subject.id)))return false;
 return tags.every(t=>ids.includes(t.id)&&r.subjectIds.includes(t.subject.id)&&t.typeId===r.typeId
  &&t.nativeClass===(spatialAssociation(applyPayload,r,t.id)?SPATIAL_CLASSES[spatialAssociation(applyPayload,r,t.id)!]:'Autodesk.Revit.DB.IndependentTag')
  &&t.properties.OwnerViewId?.id===r.viewId&&t.properties.HasLeader===r.hasLeader
  &&(!r.orientation||typeof t.properties.TagOrientation==='string'&&t.properties.TagOrientation.toLowerCase()===r.orientation));
}

function nativeApply(snapshot:AssignmentSnapshotV2,op:OperationV2){
 const r=op.result;
 if(!r||r.status!=='succeeded'||r.authority!=='native-host'||r.dispatch_state!=='dispatched'||r.native_transaction_state!=='committed'
  ||r.persistent_effect!=='applied'||r.operation_id!==op.operation_id||!r.receipt_id||!r.native_correlation_id
  ||!sameAssignmentBindingV2(snapshot.current_binding,op.binding)||!sameAssignmentBindingV2(r.binding,op.binding)
  ||op.request_identity?.path!=='/revit/tag-elements'||op.request_identity.method!=='POST'||!op.request_identity.request_signature
  ||r.request_identity?.request_signature!==op.request_identity.request_signature||!Number.isFinite(Date.parse(r.completed_at)))return null;
 for(const id of op.observation_ids){const obs=snapshot.observations[id];
  if(!obs||obs.operation_id!==op.operation_id||obs.authority!=='native-host'||obs.raw_payload_hash!==r.raw_payload_hash
   ||!sameAssignmentBindingV2(obs.binding,op.binding))continue;
  try{const ref=readEvidenceRef(obs.raw_payload_ref.replace(/^evidence:/,''));if(ref.byte_count>2_000_000)continue;
   const p=JSON.parse(readAuthoritativeEvidence(ref,{...op.binding,attempt_id:op.operation_id}).toString('utf8'));
   const ids=createdIds(op.input,p);
   if(payloadDigestV2(p).digest===r.raw_payload_hash&&ids?.every(n=>r.affected_target_identities?.includes('element_id:'+n)))return p;
  }catch{/* Corrupt/missing native commit evidence leaves the check open. */}
 }return null;
}
function newerWrite(snapshot:AssignmentSnapshotV2,op:OperationV2,ids:number[]){return Object.values(snapshot.operations).some(o=>o.operation_id!==op.operation_id
 &&o.requested_effect==='apply'&&o.persistent_effect!=='none'&&o.opened_at>=op.opened_at
 &&o.result?.affected_target_identities?.some(n=>ids.some(id=>n==='element_id:'+id)));}

export function committedCreatedTagReadbackPlanV2(snapshot:AssignmentSnapshotV2,op:OperationV2){
 if(snapshot.terminal||snapshot.outcome!=='active'||snapshot.completion_proposal||snapshot.execution_control?.state==='paused'
  ||snapshot.unresolved_unknown_operation_ids.length||snapshot.input_invalidated_operation_ids?.includes(op.operation_id)
  ||op.requested_effect!=='apply'||op.persistent_effect!=='applied'||op.settlement_state!=='settled'||op.admission_state!=='admitted'
  ||op.dispatch_state!=='dispatched'||op.verification_operation_ids.length||appliedOperationHasVerifiedPostconditionV2(snapshot,op.operation_id))return null;
 const applied=nativeApply(snapshot,op),r=resolvedRequest(op.input,applied),ids=createdIds(op.input,applied);
 if(!r||!ids||newerWrite(snapshot,op,[...ids,...r.subjectIds,r.typeId]))return null;
 const operations:any[]=[];
 ids.forEach((id,i)=>{const h='tag'+i;operations.push({id:h,op:'call',target:'doc',memberId:GET_ELEMENT,args:[id]},
  {id:h+'_owner',op:'get_property',target:'$'+h,property:'OwnerViewId'},
  {id:h+'_leader',op:'get_property',target:'$'+h,property:'HasLeader'},
  {id:h+'_type',op:'call',target:'$'+h,memberId:GET_TYPE,args:[]});
  // Native commit category chooses the read adapter; only the independent
  // read's exact runtime class, local subject UID and orphan state prove it.
  const spatial=spatialAssociation(applied,r,id);
  if(spatial)operations.push({id:h+'_subject',op:'get_property',target:'$'+h,property:spatial},
    {id:h+'_orphan',op:'get_property',target:'$'+h,property:'IsOrphaned'});
  else operations.push({id:h+'_subjects',op:'call',target:'$'+h,memberId:GET_SUBJECTS,args:[]});
  if(r.orientation)operations.push({id:h+'_orientation',op:'get_property',target:'$'+h,property:'TagOrientation'});
 });
 r.subjectIds.forEach((id,i)=>operations.push({id:'subject'+i,op:'call',target:'doc',memberId:GET_ELEMENT,args:[id]}));
 return {method:'POST',path:'/revit/native-api-ops',body:{operations,returns:operations.map(o=>'$'+o.id)}};
}

export function createdTagPostconditionSatisfiedV2(snapshot:AssignmentSnapshotV2,op:OperationV2,result:OperationResultV2,payload:unknown):boolean{
 const read=snapshot.operations[result.operation_id],commit=op.result,applied=nativeApply(snapshot,op),r=resolvedRequest(op.input,applied),ids=createdIds(op.input,applied);
 if(!read||!commit||!r||!ids||snapshot.execution_control?.state==='paused'||snapshot.unresolved_unknown_operation_ids.length
  ||snapshot.input_invalidated_operation_ids?.includes(op.operation_id)||op.persistent_effect!=='applied'||op.settlement_state!=='settled'
  ||read.requested_effect!=='read'||read.verification_of_operation_id!==op.operation_id||result.status!=='succeeded'||result.authority!=='native-host'
  ||result.dispatch_state!=='dispatched'||result.persistent_effect!=='none'||result.native_transaction_state!=='not_applicable'
  ||!sameAssignmentBindingV2(result.binding,snapshot.current_binding)||!sameAssignmentBindingV2(read.binding,result.binding)
  ||!read.request_identity?.request_signature||result.request_identity?.request_signature!==read.request_identity.request_signature
  ||![commit.completed_at,read.opened_at,result.completed_at].every(t=>Number.isFinite(Date.parse(t)))
  ||Date.parse(read.opened_at)<Date.parse(commit.completed_at)||Date.parse(result.completed_at)<Date.parse(read.opened_at)
  ||payloadDigestV2(payload).digest!==result.raw_payload_hash||newerWrite(snapshot,op,[...ids,...r.subjectIds,r.typeId]))return false;
 return createdTagReadbackMatchesV2(op.input,applied,read.input,payload);
}
