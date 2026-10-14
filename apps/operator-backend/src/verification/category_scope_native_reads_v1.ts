import type { CategoryGraphicsScopeV1,CategoryVisibilityScopeV1 } from '../domain/assignment-kernel/work_plan_scope.js';
import type { ScopeNativeReadV1 } from './tag_scope_readback_v1.js';
import { nativeSheetScopeViewIdsV1 } from './native_sheet_scope_v1.js';
const positive=(n:unknown):n is number=>Number.isSafeInteger(n)&&Number(n)>0;
const unique=(x:readonly unknown[])=>new Set(x).size===x.length;
const sameSet=(a:readonly unknown[],b:readonly unknown[])=>a.length===b.length&&unique(a)&&unique(b)&&a.every(x=>b.includes(x));
const body=(x:any)=>typeof x?.body==='string'?JSON.parse(x.body):x?.body;
const label=(x:string)=>x.replace(/[A-Z]/g,l=>l.toLowerCase());
const templateId=(v:unknown)=>v===null||v===-1?null:v;
const clean=(p:any)=>p&&typeof p==='object'&&!Array.isArray(p)&&p.error==null&&p.ok!==false&&p.success!==false&&p.isError!==true&&p.truncated!==true;
// Native list includes non-model views whose VIEW_DISCIPLINE parameter is absent.
// They cannot enter the declared model-view types. Missing discipline on a
// model view remains an incomplete census, never an implicit exclusion.
const nondisciplinaryTypes=new Set(['DrawingSheet','Legend','PanelSchedule','Schedule','ProjectBrowser','SystemBrowser']);
const knownDiscipline=(v:any)=>typeof v.discipline==='string'||v.discipline===null&&nondisciplinaryTypes.has(v.type);


/** Shared exact native census/category/template decoding. Authority and freshness are checked by the application. */
export function categoryScopeNativeReadsV1(scope:CategoryGraphicsScopeV1|CategoryVisibilityScopeV1,reads:readonly ScopeNativeReadV1[]) {
 const fail=(reason:string):never=>{throw Error((scope.kind==='category_graphics_v1'?'category_graphics_scope_':'category_visibility_scope_')+reason);};
 if(!reads.length||reads.length>128||!unique(reads.map(r=>r.operation_id)))fail('request_invalid');
  const inventories=reads.filter(r=>r.input?.method==='POST'&&r.input.path==='/revit/views');
  if(inventories.length!==1)fail('one_view_inventory_required');
  const inventory=inventories[0]!,q=body(inventory.input),p=inventory.payload;
  // /revit/views and revit_list_views support omitted action as native list.
  // Accept that request only with the same complete authoritative list payload.
  if(!q||(q.action!==undefined&&q.action!=='list')||q.includeTemplates!==true
    ||Object.keys(q).some(k=>!['action','includeTemplates','disciplines','limit','offset'].includes(k))
    ||(q.offset!==undefined&&q.offset!==0)
    ||(q.disciplines!==undefined&&(!Array.isArray(q.disciplines)||!sameSet(q.disciplines,scope.disciplines)))
    ||!clean(p)||p.status!=='ok'||p.action!=='list'||p.offset!==0||p.truncated!==false
    ||!Array.isArray(p.views)||!p.views.length||p.views.length>20_000||p.count!==p.views.length||p.returned!==p.views.length
    ||!Array.isArray(p.appliedFilters)||!sameSet(p.appliedFilters,q.disciplines===undefined?[]:['disciplines_exact'])
    ||!unique(p.views.map((v:any)=>v.id))||p.views.some((v:any)=>!positive(v.id)||typeof v.name!=='string'
      ||typeof v.isTemplate!=='boolean'||typeof v.type!=='string'||!knownDiscipline(v)
      ||(v.viewTemplateId!==undefined&&templateId(v.viewTemplateId)!==null&&!positive(v.viewTemplateId))
      ||(q.disciplines!==undefined&&!q.disciplines.includes(v.discipline))))fail('view_inventory_incomplete');
  const views=new Map<number,any>(p.views.map((v:any)=>[v.id,v]));
  const sheetIds=scope.kind==='category_visibility_v1'&&scope.sheet_ids ? nativeSheetScopeViewIdsV1(scope.sheet_ids,reads,views):null;
  const candidates=p.views.filter((v:any)=>!v.isTemplate&&scope.disciplines.includes(v.discipline)&&scope.view_types.includes(v.type)&&(!sheetIds||sheetIds.has(v.id)));
  if(!candidates.length)fail('empty_candidate_set');
  const observations=new Map<number,{category:any,operation_id:string,controlling_view_id:number}>();
  for(const read of reads.filter(r=>r!==inventory&&!(sheetIds&&r.input?.path==='/revit/sheets'))) {
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
 return {inventory:p,candidates,observations};
}
