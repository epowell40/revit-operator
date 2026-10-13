import type { TagScopeRequestV1 } from '../domain/assignment-kernel/work_plan_scope.js';
import { validTagScopeRequestV1 } from '../domain/assignment-kernel/work_plan_scope.js';
import { decodeNativeTagPropertyReadV2 } from './tag_property_readback_v2.js';

export type ScopeNativeReadV1 = { operation_id:string; input:any; payload:any };
const GET_ELEMENT='method:Autodesk.Revit.DB.Document.GetElement(Autodesk.Revit.DB.ElementId)';
const GET_SUBJECTS='method:Autodesk.Revit.DB.IndependentTag.GetTaggedLocalElements()';
const positive=(n:any)=>Number.isSafeInteger(n)&&n>0;
const unique=(a:any[])=>new Set(a).size===a.length;
const fail=(reason:string):never=>{throw Error('tag_scope_'+reason);};
const body=(i:any)=>typeof i?.body==='string'?JSON.parse(i.body):i?.body;

/** Exact native collection joins. No worker-supplied counts, classifications or
 * pass flags are accepted. Binding, hashes and freshness belong to the caller. */
export function checkTagScopeReadbackV1(scope:TagScopeRequestV1, reads:readonly ScopeNativeReadV1[]) {
  if(!validTagScopeRequestV1(scope)||!reads.length||reads.length>128||!unique(reads.map(r=>r.operation_id)))fail('request_invalid');
  const inventories=reads.filter(r=>r.input?.method==='POST'&&r.input.path==='/revit/find-elements');
  if(inventories.length!==1)fail('one_inventory_required');
  const inventory=inventories[0]!, b=body(inventory.input), p=inventory.payload;
  // An unfiltered whole-document category census: hidden candidates cannot be
  // removed by names, text, identity, region, view or physical-only filters.
  if(!b||b.category!==scope.category||Object.entries(b).some(([k,v])=>
    !['category','limit','includeGeometry'].includes(k)&&v!==undefined&&v!==null)
    ||p?.status!=='Ok'||p.scope?.kind!=='Document'||p.scope.viewIds?.length!==0||p.scope.sheetId!==null
    ||p.categoryFilterApplied!==true||!Array.isArray(p.items)||p.items.length>20_000||p.count!==p.items.length
    ||!Array.isArray(p.elementIds)||p.elementIds.length!==p.count||!unique(p.elementIds)
    ||p.itemsComplete!==true||p.truncated!==false||p.scanCapReached!==false||p.identityExpansionScanCapReached!==false
    ||!Array.isArray(p.warnings)||p.warnings.length||p.items.some((x:any)=>!positive(x.elementId)||x.builtInCategory!==scope.category)
    ||!unique(p.items.map((x:any)=>x.elementId))||p.items.some((x:any)=>!p.elementIds.includes(x.elementId)))fail('inventory_incomplete');
  const candidates=p.items.filter((x:any)=>scope.view_ids.includes(x.ownerViewId)
    &&(!scope.family_names||scope.family_names.includes(x.familyName)));
  if(!candidates.length)fail('empty_candidate_set');
  const tags=new Map<number,any>(),subjects=new Map<number,any[]>(),parameters=new Map<number,any>();
  for(const read of reads.filter(r=>r!==inventory)) {
    if(read.input?.method!=='POST')fail('unsupported_read');
    if(read.input.path==='/revit/get-parameters') {
      const q=body(read.input), rows=read.payload?.items;
      if(!q||!Array.isArray(q.elementIds)||!unique(q.elementIds)||!Array.isArray(q.names)||!q.names.includes('Family')
        ||!Array.isArray(rows)||rows.length!==q.elementIds.length||!unique(rows.map((x:any)=>x.id))
        ||rows.some((x:any)=>!q.elementIds.includes(x.id)||typeof x.uniqueId!=='string'||!Array.isArray(x.parameterDetails)))fail('subject_parameters_incomplete');
      for(const row of rows) {
        const family=row.parameterDetails.filter((x:any)=>x.name==='Family');
        if(family.length!==1||typeof family[0].valueString!=='string'||!family[0].valueString.length)fail('subject_family_missing');
        const value={unique_id:row.uniqueId,family:family[0].valueString},prior=parameters.get(row.id);
        // Iterative inspection can repeat a subject across separate fresh native
        // calls. Coalesce only agreement; never let a later value overwrite it.
        if(prior&&(prior.unique_id!==value.unique_id||prior.family!==value.family))fail('subject_family_conflict');
        parameters.set(row.id,value);
      }
      continue;
    }
    if(read.input.path!=='/revit/native-api-ops')fail('unsupported_read');
    const decoded=decodeNativeTagPropertyReadV2(read.input,read.payload);
    if(decoded) {
      for(const tag of decoded) {
        if(!positive(tag.properties.OwnerViewId?.id)||typeof tag.properties.HasLeader!=='boolean')fail('tag_properties_missing');
        const prior=tags.get(tag.element_id);
        if(prior&&(prior.unique_id!==tag.unique_id||prior.properties.OwnerViewId.id!==tag.properties.OwnerViewId.id
          ||prior.properties.HasLeader!==tag.properties.HasLeader))fail('tag_read_conflict');
        tags.set(tag.element_id,tag);
      }
      continue;
    }
    const q=body(read.input),data=read.payload;
    if(!Array.isArray(q?.operations)||q.operations.length<2||q.operations.length>16
      ||data?.version!=='operator.native_api_ops.v2'||data.ok!==true||data.read_only!==true
      ||!Array.isArray(data.operations)||data.operation_count!==q.operations.length||data.operations.length!==q.operations.length)fail('subjects_read_invalid');
    const handles=new Map<string,any>(), ids=new Set<string>();let joins=0;
    for(let i=0;i<q.operations.length;i++) {
      const op=q.operations[i], observed=data.operations[i];
      if(typeof op.id!=='string'||ids.has(op.id)||observed?.id!==op.id||observed.op!==op.op)fail('subjects_read_invalid');
      ids.add(op.id);
      if(op.op==='call'&&op.target==='doc'&&op.memberId===GET_ELEMENT&&op.args?.length===1&&positive(op.args[0])) {
        const identity=observed.result_preview;
        if(observed.member_id!==GET_ELEMENT||observed.target_type!=='Autodesk.Revit.DB.Document'
          ||identity?.id!==op.args[0]||typeof identity.unique_id!=='string')fail('tag_identity_invalid');
        handles.set('$'+op.id,identity);
      } else if(op.op==='get_property'&&op.property==='TagText'&&handles.has(op.target)) {
        if(observed.property!=='TagText'||observed.target_type!=='Autodesk.Revit.DB.IndependentTag'||typeof observed.result_preview!=='string')fail('subjects_read_invalid');
      } else if(op.op==='call'&&op.memberId===GET_SUBJECTS&&handles.has(op.target)
        &&(op.args===undefined||(Array.isArray(op.args)&&op.args.length===0))) {
        const tag=handles.get(op.target), collection=data.results?.[op.id];
        if(observed.member_id!==GET_SUBJECTS||observed.target_type!=='Autodesk.Revit.DB.IndependentTag'
          ||collection?.complete!==true||collection.truncated!==false||collection.hasMore!==false
          ||!Array.isArray(collection.items)||collection.count!==collection.items.length||collection.total!==collection.count
          ||!collection.count||collection.count>16||!unique(collection.items.map((x:any)=>x.id))
          ||collection.items.some((x:any)=>!positive(x.id)||typeof x.unique_id!=='string'))fail('subjects_incomplete');
        const values=collection.items.map((x:any)=>({id:x.id,unique_id:x.unique_id,tag_unique_id:tag.unique_id})).sort((a:any,b:any)=>a.id-b.id);
        const prior=subjects.get(tag.id);
        if(prior&&JSON.stringify(prior)!==JSON.stringify(values))fail('subject_read_conflict');
        subjects.set(tag.id,values);joins++;
      } else fail('subjects_read_invalid');
    }
    if(!joins)fail('subjects_read_invalid');
  }
  const matched:number[]=[],excluded:number[]=[],failed:number[]=[];
  for(const candidate of candidates) {
    const tag=tags.get(candidate.elementId);
    if(!tag||tag.properties.OwnerViewId.id!==candidate.ownerViewId)fail('candidate_read_missing');
    if(scope.subject_family_names) {
      const refs=subjects.get(candidate.elementId);
      if(!refs||refs.some(x=>x.tag_unique_id!==tag.unique_id))fail('subject_join_missing');
      const families=refs!.map(x=>{
        const detail=parameters.get(x.id);
        if(!detail||detail.unique_id!==x.unique_id)fail('subject_identity_mismatch');
        return scope.subject_family_names!.includes(detail.family);
      });
      // Mixed multi-target tags require a human/agent scope decision; exclusion
      // of a partly matching tag would hide a requested subject.
      if(families.some(Boolean)&&!families.every(Boolean))fail('mixed_subjects_ambiguous');
      if(!families.every(Boolean)){excluded.push(candidate.elementId);continue;}
    }
    matched.push(candidate.elementId);
    if(tag.properties.HasLeader!==scope.has_leader)failed.push(candidate.elementId);
  }
  if(!matched.length)fail('empty_match_set');
  return {schema:'revit-operator.tag-scope-readback/v1' as const,scope_is_assistant_interpretation:true as const,
    inventory_count:p.count,candidate_count:candidates.length,matched_count:matched.length,excluded_count:excluded.length,
    satisfied_count:matched.length-failed.length,failed_target_ids:failed,matched_target_ids:matched,excluded_target_ids:excluded,
    declared_scope_satisfied:failed.length===0,
    notice:'Native properties checked for the declared search domain. Original drawing coverage, replacement suitability and engineering intent are not certified.'};
}
