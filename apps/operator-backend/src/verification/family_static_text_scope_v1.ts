import { validFamilyStaticTextScopeV1,type FamilyStaticTextScopeV1 } from '../domain/assignment-kernel/work_plan_family_scope.js';
import type { ScopeNativeReadV1 } from './tag_scope_readback_v1.js';
const positive=(n:any)=>Number.isSafeInteger(n)&&n>0;
const unique=(xs:any[])=>new Set(xs).size===xs.length;
const normalize=(s:string)=>s.replace(/\s+/g,' ').trim();
const body=(r:ScopeNativeReadV1)=>typeof r.input?.body==='string'?JSON.parse(r.input.body):r.input?.body;
const fail=(s:string):never=>{throw Error('family_static_text_scope_'+s);};

/** Recomputes native static content for every discovered host instance/type.
 * No actor-selected identities, counts, pass flags or filtered family reads.
 * Authentication, binding, freshness and settlement are enforced by caller. */
export function checkFamilyStaticTextScopeV1(scope:FamilyStaticTextScopeV1,reads:readonly ScopeNativeReadV1[]) {
 if(!validFamilyStaticTextScopeV1(scope)||!reads.length||reads.length>128||!unique(reads.map(r=>r.operation_id)))fail('request_invalid');
 const inventories=reads.filter(r=>r.input?.method==='POST'&&r.input.path==='/revit/find-elements');
 if(inventories.length!==1)fail('one_inventory_required');
 const inventory=inventories[0]!;
 const {payload:p,category,instances,types}=familyStaticTextScopeInventoryV1(scope,inventory);
 const observed=new Map<number,{family_id:number,source_id:number,operation_id:string,text_ids:number[],content:string[],satisfied:boolean}>();
 for(const r of reads.filter(r=>r!==inventory)){
  const b=body(r),raw=r.payload,s=raw?.source,inv=raw?.inventory,x=instances.get(s?.elementId);
  if(r.input?.method!=='POST'||r.input.path!=='/revit/inspect-family-content'||!b||b.elementId!==s?.elementId
    ||Object.entries(b).some(([k,v])=>!['elementId','maxElements','includeParameters','includeOtherElements'].includes(k)&&v!=null)
    ||raw.ok!==true||raw.observational!==true||raw.mutated!==false||raw.query!==null
    ||raw.closedWithoutSaving!==true||!x||s.typeId!==x.typeId||s.familyName!==x.familyName||s.typeName!==x.typeName
    ||s.category!==category.name||!positive(s.familyId)||typeof s.uniqueId!=='string'||!s.uniqueId.length
    ||inv?.truncated!==false||!positive(inv.scannedElementCount)||!Number.isSafeInteger(inv.returnedElementCount)
    ||inv.returnedElementCount<0||inv.returnedElementCount>inv.scannedElementCount
    ||!positive(inv.maxElements)||inv.maxElements>2000||inv.returnedElementCount>=inv.maxElements
    ||!Array.isArray(raw.staticText)||!Array.isArray(raw.labels)||!Array.isArray(raw.nestedInstances)||!Array.isArray(raw.otherElements)
    ||inv.returnedElementCount!==raw.staticText.length+raw.labels.length+raw.nestedInstances.length+raw.otherElements.length
    ||!inv.classCounts||Object.values(inv.classCounts).some(n=>!Number.isSafeInteger(n)||Number(n)<0)
    ||Object.values(inv.classCounts).reduce<number>((sum,n)=>sum+Number(n),0)!==inv.scannedElementCount
    ||(inv.classCounts.TextNote??0)!==raw.staticText.length||raw.classification?.staticTextCount!==raw.staticText.length
    ||!unique(raw.staticText.map((t:any)=>t.elementId))||raw.staticText.some((t:any)=>!positive(t.elementId)||typeof t.uniqueId!=='string'||!t.uniqueId.length||typeof t.text!=='string'))fail('family_read_incomplete');
  const content=raw.staticText.map((t:any)=>normalize(t.text)).sort();
  const prior=observed.get(s.typeId);
  if(prior&&(prior.family_id!==s.familyId||JSON.stringify(prior.content)!==JSON.stringify(content)))fail('family_read_conflict');
  const text_ids=raw.staticText.filter((t:any)=>(' '+normalize(t.text)+' ').includes(' '+normalize(scope.expected_text)+' ')).map((t:any)=>t.elementId);
  observed.set(s.typeId,{family_id:s.familyId,source_id:s.elementId,operation_id:r.operation_id,text_ids,content,satisfied:text_ids.length>0});
 }
 for(const id of types.keys())if(!observed.has(id))fail('candidate_read_missing');
 // Native family names are unique within this category. Reject inconsistent
 // family joins across type samples rather than silently choosing one.
 const familyIds=new Map<string,number>();
 for(const [id,x] of types){const family=observed.get(id)!.family_id,prior=familyIds.get(x.familyName);
  if(prior!==undefined&&prior!==family)fail('family_identity_conflict');familyIds.set(x.familyName,family);}
 const matched=[...instances.keys()].sort((a,b)=>a-b),failed=matched.filter(id=>!observed.get(instances.get(id).typeId)!.satisfied);
 return {schema:'revit-operator.family-static-text-scope/v1' as const,scope_is_assistant_interpretation:true as const,
  inventory_count:p.count,candidate_count:p.count,matched_count:p.count,excluded_count:0,
  satisfied_count:p.count-failed.length,matched_target_ids:matched,failed_target_ids:failed,excluded_target_ids:[] as number[],
  declared_scope_satisfied:failed.length===0,family_type_proofs:[...types].map(([id,x])=>{
   const o=observed.get(id)!;return {type_id:id,family_id:o.family_id,family_name:x.familyName,type_name:x.typeName,
    source_instance_id:o.source_id,operation_id:o.operation_id,matching_static_text_ids:o.text_ids,satisfied:o.satisfied};}),
  notice:'Shared native static family text checked for every discovered host instance/type in the complete declared category, including already-correct text. It does not certify visible instance text, type visibility/formulas, nested or parameter labels, formatting, layout, original source interpretation, linked models or unrelated-state preservation.'};
}

/** Derive sample types only from the same complete native census used by the checker. */
export function familyStaticTextScopeInventoryV1(scope:FamilyStaticTextScopeV1,inventory:ScopeNativeReadV1) {
 if(!validFamilyStaticTextScopeV1(scope)||inventory.input?.method!=='POST'||inventory.input.path!=='/revit/find-elements')fail('request_invalid');
 const q=body(inventory),p=inventory.payload;
 if(!q||q.category!==scope.category||Object.entries(q).some(([k,v])=>!['category','limit','includeGeometry'].includes(k)&&v!=null)
   ||p?.status!=='Ok'||p.scope?.kind!=='Document'||p.scope.viewIds?.length!==0||p.scope.sheetId!==null
   ||p.categoryFilterApplied!==true||p.textFilterApplied!==false||p.identityFilterApplied!==false
   ||p.physicalElementsOnlyApplied!==false||p.topLevelInstancesOnlyApplied!==false||p.sheetRegionFilterApplied!==false
   ||!Array.isArray(p.items)||!p.items.length||p.items.length>20_000||p.count!==p.items.length
   ||!Array.isArray(p.elementIds)||p.elementIds.length!==p.count||!unique(p.elementIds)
   ||p.itemsComplete!==true||p.truncated!==false||p.scanCapReached!==false||p.identityExpansionScanCapReached!==false
   ||!Array.isArray(p.warnings)||p.warnings.length||!unique(p.items.map((x:any)=>x.elementId)))fail('inventory_incomplete');
 const categories=p.resolvedCategories;
 if(!Array.isArray(categories)||categories.length!==1||categories[0].requested!==scope.category
   ||!Number.isSafeInteger(categories[0].categoryId)||categories[0].categoryId>=0
   ||typeof categories[0].name!=='string'||!/^OST_[A-Za-z0-9_]+$/.test(categories[0].builtInToken??'')
   ||(/^OST_/.test(scope.category)&&scope.category!==categories[0].builtInToken))fail('category_identity_unproven');
 const category=categories[0],instances=new Map<number,any>(),types=new Map<number,any>();
 for(const x of p.items){
  if(!positive(x.elementId)||!p.elementIds.includes(x.elementId)||!positive(x.typeId)
    ||x.category!==category.name||x.builtInCategory!==category.builtInToken
    ||typeof x.familyName!=='string'||!x.familyName.trim()||typeof x.typeName!=='string'||!x.typeName.trim())fail('instance_identity_unproven');
  const prior=types.get(x.typeId);
  if(prior&&(prior.familyName!==x.familyName||prior.typeName!==x.typeName))fail('type_identity_conflict');
  instances.set(x.elementId,x);types.set(x.typeId,x);
 }
 return {payload:p,category,instances,types};
}
