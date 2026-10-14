import type { ScopeNativeReadV1 } from './tag_scope_readback_v1.js';

/** Derive every placed model view from native sheet inventories, not actor IDs/counts. */
export function nativeSheetScopeViewIdsV1(sheetIds:readonly number[],reads:readonly ScopeNativeReadV1[],views:Map<number,any>) {
 const fail=(reason:string):never=>{throw Error('category_visibility_scope_sheet_'+reason);};
 const sameSet=(a:readonly unknown[],b:readonly unknown[])=>a.length===b.length&&new Set(a).size===a.length&&new Set(b).size===b.length&&a.every(v=>b.includes(v));
 const sheets=reads.filter(r=>r.input?.method==='POST'&&r.input.path==='/revit/sheets');
 if(sheets.length!==sheetIds.length)fail('inventory_missing');
 const seen=new Set<number>(),ids=new Set<number>();
 for(const r of sheets){
  const b=typeof r.input.body==='string'?JSON.parse(r.input.body):r.input.body,p=r.payload;
  if(!b||b.action!=='detail'||!sheetIds.includes(b.sheetId)||seen.has(b.sheetId)
   ||Object.keys(b).some(k=>!['action','sheetId','includeViewportGeometry','includePlacedViews','includeViewports','includeSchedules','includeTitleBlocks','includeSheetOutline'].includes(k))
   ||p?.status!=='Ok'||p.action!=='detail'||p.error!=null||p.ok===false||p.success===false||p.isError===true||p.truncated===true||p.isPlaceholder!==false
   ||p.sheetId!==b.sheetId||p.sheetElementId!==b.sheetId||p.viewId!==b.sheetId||typeof p.sheetNumber!=='string'
   ||p.requestedPlacementIds!==null||!Array.isArray(p.placedViews)||!p.placedViews.length
   ||p.placedViewCount!==p.placedViews.length||new Set(p.placedViews.map((v:any)=>v.viewId)).size!==p.placedViews.length
   ||!Array.isArray(p.viewportIds)||!Array.isArray(p.viewportGeometry)||p.viewportCount!==p.viewportIds.length
   ||p.viewportCount!==p.viewportGeometry.length||!sameSet(p.viewportIds,p.viewportGeometry.map((v:any)=>v.viewportId))
   ||!sameSet(p.placedViews.map((v:any)=>v.viewId),[...new Set(p.viewportGeometry.map((v:any)=>v.viewId))]))fail('inventory_incomplete');
  for(const v of p.placedViews){const listed=views.get(v.viewId);
   if(!Number.isSafeInteger(v.viewId)||v.viewId<=0||!listed||listed.isTemplate||v.name!==listed.name||v.viewType!==listed.type
    ||!Array.isArray(v.viewportIds)||!sameSet(v.viewportIds,p.viewportGeometry.filter((p:any)=>p.viewId===v.viewId).map((p:any)=>p.viewportId)))fail('view_identity_unproven');
   ids.add(v.viewId);
  }
  seen.add(b.sheetId);
 }
 if(!sameSet([...seen],sheetIds))fail('domain_incomplete');
 return ids;
}
