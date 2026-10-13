import { validCategoryGraphicsScopeV1, type CategoryGraphicsScopeV1 } from '../domain/assignment-kernel/work_plan_scope.js';
import type { ScopeNativeReadV1 } from './tag_scope_readback_v1.js';

const positive=(n:unknown):n is number=>Number.isSafeInteger(n)&&Number(n)>0;
const unique=(x:readonly unknown[])=>new Set(x).size===x.length;
const sameSet=(a:readonly unknown[],b:readonly unknown[])=>a.length===b.length&&unique(a)&&unique(b)&&a.every(x=>b.includes(x));
const fail=(reason:string):never=>{throw Error('category_graphics_scope_'+reason);};
const body=(x:any)=>typeof x?.body==='string'?JSON.parse(x.body):x?.body;
const label=(x:string)=>x.replace(/[A-Z]/g,l=>l.toLowerCase());
const templateId=(v:unknown)=>v===null||v===-1?null:v;
const clean=(p:any)=>p&&typeof p==='object'&&!Array.isArray(p)&&p.error==null&&p.ok!==false&&p.success!==false&&p.isError!==true&&p.truncated!==true;

/** Derive candidates from an exhaustive native view census, then join every
 * category read by native view/category/template identity. Actor counts and
 * selected view IDs cannot narrow the result. Hash/binding/freshness admission
 * is provided by checkWorkPlanScopeV1, before this decoder sees the bytes. */
export function checkCategoryGraphicsScopeV1(scope:CategoryGraphicsScopeV1,reads:readonly ScopeNativeReadV1[]) {
  if(!validCategoryGraphicsScopeV1(scope)||!reads.length||reads.length>128||!unique(reads.map(r=>r.operation_id)))fail('request_invalid');
  const inventories=reads.filter(r=>r.input?.method==='POST'&&r.input.path==='/revit/views');
  if(inventories.length!==1)fail('one_view_inventory_required');
  const inventory=inventories[0]!,q=body(inventory.input),p=inventory.payload;
  if(!q||q.action!=='list'||q.includeTemplates!==true
    ||Object.keys(q).some(k=>!['action','includeTemplates','disciplines','limit','offset'].includes(k))
    ||(q.offset!==undefined&&q.offset!==0)
    ||(q.disciplines!==undefined&&(!Array.isArray(q.disciplines)||!sameSet(q.disciplines,scope.disciplines)))
    ||!clean(p)||p.status!=='ok'||p.action!=='list'||p.offset!==0||p.truncated!==false
    ||!Array.isArray(p.views)||!p.views.length||p.views.length>20_000||p.count!==p.views.length||p.returned!==p.views.length
    ||!Array.isArray(p.appliedFilters)||!sameSet(p.appliedFilters,q.disciplines===undefined?[]:['disciplines_exact'])
    ||!unique(p.views.map((v:any)=>v.id))||p.views.some((v:any)=>!positive(v.id)||typeof v.name!=='string'
      ||typeof v.isTemplate!=='boolean'||typeof v.type!=='string'||typeof v.discipline!=='string'
      ||(v.viewTemplateId!==undefined&&templateId(v.viewTemplateId)!==null&&!positive(v.viewTemplateId))
      ||(q.disciplines!==undefined&&!q.disciplines.includes(v.discipline))))fail('view_inventory_incomplete');
  const views=new Map<number,any>(p.views.map((v:any)=>[v.id,v]));
  const candidates=p.views.filter((v:any)=>!v.isTemplate&&scope.disciplines.includes(v.discipline)&&scope.view_types.includes(v.type));
  if(!candidates.length)fail('empty_candidate_set');
  const observations=new Map<number,{category:any,operation_id:string,controlling_view_id:number}>();
  for(const read of reads.filter(r=>r!==inventory)) {
    const b=body(read.input),raw=read.payload,v=raw?.view,listed=views.get(v?.id);
    if(read.input?.method!=='POST'||read.input.path!=='/revit/visibility'||!b||b.action!=='get'||b.dryRun===true
      ||b.viewId!==v?.id||b.categoryName!==scope.category||b.includeCategoryState!==true
      ||Object.keys(b).some(k=>!['action','viewId','categoryName','includeCategoryState','includeLinkedModels','dryRun'].includes(k))
      ||!clean(raw)||raw.status!=='Ok'||raw.action!=='get'||raw.dryRun!==false||!listed
      ||v.name!==listed.name||v.isTemplate!==listed.isTemplate||v.viewType!==listed.type||v.discipline!==listed.discipline
      ||(templateId(v.viewTemplateId)!==null&&!positive(v.viewTemplateId))
      ||(listed.viewTemplateId!==undefined&&templateId(v.viewTemplateId)!==templateId(listed.viewTemplateId))
      ||typeof v.templateControlsModelGraphics!=='boolean')fail('category_read_invalid');
    const cat=v.categoryOverride,snap=v.categorySnapshot,target=snap?.target;
    if(!cat||!Number.isSafeInteger(cat.categoryId)||cat.categoryId>=0||!/^OST_[A-Za-z0-9_]+$/.test(cat.builtInCategory??'')
      ||typeof cat.categoryName!=='string'||typeof cat.hidden!=='boolean'||typeof cat.halftone!=='boolean'
      ||(/^OST_/.test(scope.category)?cat.builtInCategory!==scope.category:label(cat.categoryName)!==label(scope.category))
      ||snap?.complete!==true||snap.targetCategoryId!==cat.categoryId||target?.id!==cat.categoryId
      ||target.name!==cat.categoryName||target.hidden!==cat.hidden||target.graphics?.halftone!==cat.halftone)fail('category_identity_unproven');
    let controlling=cat,controllingId=v.id;
    if(v.templateControlsModelGraphics) {
      const template=views.get(v.viewTemplateId),t=v.templateCategoryOverride;
      if(!template?.isTemplate||template.name!==v.viewTemplate||!t||t.categoryId!==cat.categoryId
        ||t.categoryName!==cat.categoryName||t.builtInCategory!==cat.builtInCategory
        ||typeof t.hidden!=='boolean'||typeof t.halftone!=='boolean')fail('template_control_unproven');
      controlling=t;controllingId=template.id;
    }
    const decoded={category:controlling,operation_id:read.operation_id,controlling_view_id:controllingId};
    const prior=observations.get(v.id);
    if(prior&&(JSON.stringify(prior.category)!==JSON.stringify(controlling)||prior.controlling_view_id!==controllingId))fail('conflicting_read');
    observations.set(v.id,decoded);
  }
  const matched:number[]=[],excluded:number[]=[],failed:number[]=[];
  const controlling=new Map<number,{hidden:boolean,halftone:boolean}>();
  const proof=candidates.map((v:any)=>{
    const observed=observations.get(v.id);if(!observed)fail('candidate_read_missing');
    const {category,controlling_view_id,operation_id}=observed!;
    const state={hidden:category.hidden,halftone:category.halftone},prior=controlling.get(controlling_view_id);
    if(prior&&(prior.hidden!==state.hidden||prior.halftone!==state.halftone))fail('controlling_state_conflict');
    controlling.set(controlling_view_id,state);
    if(category.hidden)excluded.push(v.id);else {matched.push(v.id);if(category.halftone!==scope.halftone)failed.push(v.id);}
    return {view_id:v.id,view_name:v.name,controlling_view_id,operation_id,...state};
  });
  if(!matched.length)fail('empty_visible_set');
  return {schema:'revit-operator.category-graphics-scope/v1' as const,scope_is_assistant_interpretation:true as const,
    inventory_count:p.views.length,candidate_count:candidates.length,matched_count:matched.length,excluded_count:excluded.length,
    satisfied_count:matched.length-failed.length,failed_target_ids:failed,matched_target_ids:matched,excluded_target_ids:excluded,
    declared_scope_satisfied:failed.length===0,view_proofs:proof,
    notice:'Stored controlling category properties checked across the declared native view domain. Hidden views are excluded, not certified unchanged. Effective linked/filtered graphics, source interpretation and visual appearance require separate evidence.'};
}
