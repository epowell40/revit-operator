type Row=Record<string,any>;
export const DELETION_SEMANTIC_OUTPUT_V2='elements.deleted_absence';
export const NATIVE_ELEMENT_LOOKUP_V2='method:Autodesk.Revit.DB.Document.GetElement(Autodesk.Revit.DB.ElementId)';
const DELETE='method:Autodesk.Revit.DB.Document.Delete(Autodesk.Revit.DB.ElementId)';
export const deletionRowV2=(v:unknown):Row=>v&&typeof v==='object'&&!Array.isArray(v)?v as Row:{};
const row=deletionRowV2;
const body=(v:unknown)=>{const r=row(v);return row(r.body??r.arguments??v);};
const positive=(v:unknown):v is number=>Number.isSafeInteger(v)&&Number(v)>0;
const ids=(v:unknown):v is number[]=>Array.isArray(v)&&v.length<=4096&&v.every(positive)&&new Set(v).size===v.length;
const equalSet=(a:unknown,b:unknown)=>ids(a)&&ids(b)&&a.length===b.length&&a.every(x=>b.includes(x));
const ref=(v:unknown)=>typeof v==='string'?v.replace(/^\$/,''):Object.keys(row(v)).length===1?row(v).$ref:undefined;

/** Only explicit deletion operations. Mixed native programs retain their own
 * proof requirements; finding one Delete call cannot certify the whole graph. */
export function deletionRequestV2(input:unknown){
  const r=row(input),b=body(input);
  if(b.dryRun===true||b.apply===false)return null;
  if(r.path==='/revit/delete')return ids(b.ids)&&b.ids.length?{ids:b.ids as number[],native:false,steps:[] as Row[],deletes:[] as Row[],transaction:{} as Row}:null;
  if(r.path!=='/revit/native-api-mutation-ops'||!Array.isArray(b.operations)||!b.operations.length||b.operations.length>16)return null;
  const steps=b.operations.map(row),prefix=steps[0],doc=prefix.op==='get_property'&&prefix.target==='uidoc'&&prefix.property==='Document'
    &&prefix.args===undefined&&prefix.memberId===undefined?prefix:null;
  const deletes=doc?steps.slice(1):steps;
  if(!deletes.length||steps.some((s:Row)=>typeof s.id!=='string'||!s.id||s.id.length>64)
    ||new Set(steps.map((s:Row)=>s.id)).size!==steps.length)return null;
  for(const s of steps)if(Object.keys(s).some(k=>!['id','op','target','property','memberId','args'].includes(k)))return null;
  if(deletes.some((s:Row)=>s.op!=='call'||s.memberId!==DELETE||s.property!==undefined
    ||(!['doc','document'].includes(s.target)&&!(doc&&ref(s.target)===doc.id))
    ||!Array.isArray(s.args)||s.args.length!==1||!positive(s.args[0])))return null;
  const requested=deletes.map((s:Row)=>s.args[0]);if(!ids(requested))return null;
  if(!Array.isArray(b.returns)||b.returns.length!==deletes.length||new Set(b.returns.map(ref)).size!==deletes.length
    ||deletes.some((s:Row)=>!b.returns.some((v:unknown)=>ref(v)===s.id)))return null;
  const tx=row(b.transaction);
  if(tx.mode!=='commit'||!ids(tx.allowedExistingElementIds)||!positive(tx.maxAffectedElements)||tx.maxAffectedElements>4096
    ||typeof tx.allowCreate!=='boolean'||requested.some((id:number)=>!tx.allowedExistingElementIds.includes(id)))return null;
  return {ids:requested as number[],native:true,steps,deletes,transaction:tx};
}

/** Return the complete native deletion closure, not just the requested parents.
 * A complete canonical inventory is mandatory for the ordinary delete route. */
export function deletionClosureV2(input:unknown,payload:unknown,affected:readonly string[],ordinaryInventoryComplete=false):number[]|null{
  const g=deletionRequestV2(input),p=row(payload),tx=row(p.transaction);if(!g||p.error||p.ok===false||p.truncated===true)return null;
  const deleted=tx.deleted_element_ids;
  if(tx.status!=='committed'||tx.committed!==true||tx.dry_run===true||tx.pending===true||tx.rolled_back===true
    ||!ids(deleted)||!deleted.length||g.ids.some(id=>!deleted.includes(id))
    ||!ids(tx.modified_element_ids)||tx.modified_element_ids.length||!ids(tx.added_element_ids)
    ||tx.added_element_ids.some((id:number)=>!deleted.includes(id))
    ||JSON.stringify([...affected].sort())!==JSON.stringify(deleted.map(id=>'element_id:'+id).sort()))return null;
  if(!g.native){
    if(!ordinaryInventoryComplete||p.status!=='Deleted'||!equalSet(p.requestedIds,g.ids)||!equalSet(p.impactedIds,deleted)
      ||p.requestedCount!==g.ids.length||p.impactedCount!==deleted.length
      ||!equalSet(p.dependentIds,deleted.filter(id=>!g.ids.includes(id))))return null;
  }else{
    if(p.version!=='operator.native_api_mutation_ops.v1'||p.ok!==true||p.read_only!==false
      ||p.operation_count!==g.steps.length||p.mutation_operation_count!==g.deletes.length
      ||!Array.isArray(p.geometry_cleanup_errors)||p.geometry_cleanup_errors.length||!Array.isArray(p.operations)||p.operations.length!==g.steps.length
      ||tx.mode!=='commit'||tx.dry_run!==false||tx.scope_enforcement!=='failure_processing_allowed_commit'
      ||tx.scope_baseline!=='complete_native_document_ids_before_transaction'||!positive(tx.scope_baseline_element_count)
      ||!positive(tx.scope_observer_executions)||tx.existing_scope_matched!==true||tx.scope_discovery_only!==false
      ||!equalSet(tx.unexpected_existing_element_ids,[])||!equalSet(tx.transient_created_ids,[])
      ||!equalSet(tx.allowed_existing_element_ids,g.transaction.allowedExistingElementIds)
      ||!equalSet(tx.commit_allowed_existing_element_ids,g.transaction.allowedExistingElementIds)
      ||tx.max_affected_elements!==g.transaction.maxAffectedElements||tx.allow_create!==g.transaction.allowCreate
      ||tx.affected_element_count!==deleted.length||deleted.length>tx.max_affected_elements
      ||deleted.some(id=>!g.transaction.allowedExistingElementIds.includes(id)))return null;
    const union=new Set<number>();
    for(const [i,s]of g.steps.entries()){
      const n=row(p.operations[i]);if(n.id!==s.id||n.op!==s.op||n.error||n.ok===false)return null;
      if(s.op==='get_property'){if(n.property!=='Document'||n.target_type!=='Autodesk.Revit.UI.UIDocument')return null;continue;}
      if(n.member_id!==DELETE||n.target_type!=='Autodesk.Revit.DB.Document')return null;
      const collection=row(row(p.results)[s.id]),items=collection.items;
      if(!Array.isArray(items)||collection.complete!==true||collection.hasMore!==false||collection.truncated!==false
        ||collection.count!==items.length||collection.total!==items.length||!ids(items.map((x:unknown)=>row(x).id)))return null;
      const values=items.map((x:unknown)=>row(x).id);if(!values.includes(s.args[0]))return null;values.forEach((id:number)=>union.add(id));
    }
    if(Object.keys(row(p.results)).length!==g.deletes.length||!equalSet([...union],deleted))return null;
  }
  return [...deleted].sort((a,b)=>a-b);
}

/** GetElement must itself be returned. Missing fields and empty collections are
 * not evidence of absence. Additional successful read-only operations may coexist. */
export function deletionReadTargetsV2(input:unknown):number[]{
  const r=row(input),b=body(input);if(r.path!=='/revit/native-api-ops'||b.transaction!==undefined
    ||!Array.isArray(b.operations)||!b.operations.length||b.operations.length>16||!Array.isArray(b.returns))return [];
  const steps=b.operations.map(row);if(new Set(steps.map((s:Row)=>s.id)).size!==steps.length)return [];
  return steps.filter((s:Row)=>s.op==='call'&&s.memberId===NATIVE_ELEMENT_LOOKUP_V2&&['doc','document'].includes(s.target)
    &&s.property===undefined&&Array.isArray(s.args)&&s.args.length===1&&positive(s.args[0])&&b.returns.some((v:unknown)=>ref(v)===s.id))
    .map((s:Row)=>s.args[0]);
}
export function nativeAbsentElementIdsV2(input:unknown,payload:unknown):number[]{
  const targets=deletionReadTargetsV2(input),b=body(input),p=row(payload);if(!targets.length||p.version!=='operator.native_api_ops.v2'||p.ok!==true||p.read_only!==true
    ||p.truncated===true||p.error||p.operation_count!==b.operations.length||!Array.isArray(p.operations)||p.operations.length!==b.operations.length)return [];
  const results=row(p.results),absent:number[]=[];
  for(const [i,s]of b.operations.entries()){
    const n=row(p.operations[i]);if(n.id!==s.id||n.op!==s.op||n.error||n.ok===false)return [];
    if(s.op==='call'&&n.member_id!==s.memberId||s.op==='get_property'&&n.property!==s.property)return [];
    if(!targets.includes(s.args?.[0])||s.memberId!==NATIVE_ELEMENT_LOOKUP_V2||!b.returns.some((v:unknown)=>ref(v)===s.id))continue;
    if(n.target_type!=='Autodesk.Revit.DB.Document'||!Object.hasOwn(n,'result_preview')||n.result_preview!==null
      ||!Object.hasOwn(results,s.id)||results[s.id]!==null)return [];
    absent.push(s.args[0]);
  }
  return [...new Set(absent)];
}
