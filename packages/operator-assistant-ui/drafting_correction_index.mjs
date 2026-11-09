import {createHash} from 'node:crypto';

const object=v=>v!==null&&typeof v==='object'&&!Array.isArray(v);
const positive=v=>Number.isSafeInteger(v)&&v>0;
const count=v=>Number.isSafeInteger(v)&&v>=0;
const point=v=>object(v)&&['x','y','z'].every(k=>Number.isFinite(v[k]))
 ?['x','y','z'].map(k=>Math.round(v[k]*10000)/10000):null;
const unavailable=reason=>({schema:'operator.drafting_correction_index.v1',state:'unavailable',reason,
 native_postcondition_verified:false,whole_task_verified:false});

/** A small locator index from the existing owner-view native read. Its caller
 * brackets that read and the delivered image with unchanged native document
 * identity/epoch/sequence. This is neither pixel registration nor a verifier.
 * Full precision, UniqueIds and curve definitions remain in the raw receipt. */
export function buildDraftingCorrectionIndex(raw,scene,capture){
 const settlement=raw?.canonical_attempt_settlement;
 const viewIndex=Array.isArray(raw?.views)?raw.views.findIndex(v=>v?.view?.id===scene?.view_id):-1,view=raw?.views?.[viewIndex];
 if(raw?.schema!=='revit-operator.view-owned-detailing/v1'||raw.scope!=='exact_owner_view'
  ||raw.documentTitle!==scene?.document_title||scene?.view_type!=='DraftingView'||!positive(scene.process_id)
  ||typeof scene.document_session_id!=='string'||!scene.document_session_id||typeof scene.epoch!=='string'||!scene.epoch||!count(scene.through_sequence)
  ||!positive(scene.view_id)||!Array.isArray(raw.requestedViewIds)||raw.requestedViewIds.length>20||!raw.requestedViewIds.includes(scene.view_id)
  ||!raw.requestedViewIds.every(positive)||new Set(raw.requestedViewIds).size!==raw.requestedViewIds.length
  ||!Array.isArray(raw.views)||raw.views.length!==raw.requestedViewIds.length||raw.views.some(v=>!raw.requestedViewIds.includes(v?.view?.id))
  ||new Set(raw.views.map(v=>v?.view?.id)).size!==raw.views.length||view?.view?.id!==scene.view_id||view.view.uniqueId!==scene.view_unique_id
  ||view.view.viewType!=='DraftingView'||!Array.isArray(view.items)||view.items.length>2000||view.returnedCount!==view.items.length
  ||!count(view.totalOwnedCount)||view.totalOwnedCount<view.items.length||typeof view.truncated!=='boolean'||!count(view.unreadableCount)
  ||settlement?.method!=='POST'||settlement.path!=='/revit/view-owned-detailing'||settlement.requested_effect!=='read'
  ||settlement.effect_state!=='none'||settlement.request_dispatched!==true||raw.outcome_unknown===true
  ||typeof capture?.evidence_id!=='string'||!/^sha256:[a-f0-9]{64}$/.test(capture.content_hash??''))return unavailable('native_identity_or_read_unavailable');
 const items=view.items;
 if(items.some(r=>!object(r)||!positive(r.elementId)||r.ownerViewId!==scene.view_id||typeof r.uniqueId!=='string'||!r.uniqueId)
  ||new Set(items.map(r=>r.elementId)).size!==items.length||new Set(items.map(r=>r.uniqueId)).size!==items.length)return unavailable('native_rows_inconsistent');
 const rows=[],indices=[];let next=0,unlocated=0;
 const result={schema:'operator.drafting_correction_index.v1',state:'available',
  location:Object.fromEntries(['process_id','document_session_id','epoch','through_sequence','view_id','view_unique_id'].map(k=>[k,scene[k]])),
  capture:{evidence_id:capture.evidence_id,content_hash:capture.content_hash},source_sha256:createHash('sha256').update(JSON.stringify(raw)).digest('hex'),
  coordinate_units:'native_model_feet',coordinate_rounding_decimals:4,pixel_to_model_mapping:false,
  columns:['element_id','kind','xyz_pair','optional_text_excerpt'],rows,
  locators:{Line:'endpoints',other_kinds:'bounds'},
  coverage:{source_rows:items.length,total_owned_count:view.totalOwnedCount,returned_rows:0,unlocated_rows:0,
   source_inventory_complete:raw.viewsComplete===true&&view.itemsComplete===true&&!view.truncated&&view.unreadableCount===0&&view.totalOwnedCount===items.length,
   source_rows_exhausted:false,whole_drawing_verified:false},
  retrieval:{path:`raw_review_evidence.drafting_native_read.views[${viewIndex}].items`,source_row_indices:indices,next_start:0,
   fields:['elementId','uniqueId','ownerViewId','className','curve','boundingBox','visibleText']},
  native_postcondition_verified:false,whole_task_verified:false,
  guidance:'Locate correction targets using these current native IDs and coordinates with the delivered drawing image. Line locators are endpoints; other locators are native bounding boxes, not full curve shapes. Coordinates are rounded for locating only; retrieve exact original rows for precision, UniqueIds, curves or full text. IDs belong only to this document session and observed revision. Several curves may share an endpoint or bounds: inspect the intended shape, never delete an arbitrary match. No pixel-to-model transform, visual correctness, hidden-content absence or permission to write is established.'};
 const update=()=>{Object.assign(result.coverage,{returned_rows:rows.length,unlocated_rows:unlocated,source_rows_exhausted:next===items.length});result.retrieval.next_start=next===items.length?null:next;};
 for(let i=0;i<items.length;i++){
  const r=items[i],curve=r.curve;let a=null,b=null,kind='bounds';
  if(curve?.kind==='Line'){a=point(curve.start);b=point(curve.end);if(a&&b)kind='endpoints';}
  if(!a||!b){a=point(r.boundingBox?.min);b=point(r.boundingBox?.max);}
  next=i+1;
  if(!a||!b){unlocated++;update();continue;}
  let name=typeof curve?.kind==='string'?curve.kind:r.className;
  if(name==='Line'&&kind!=='endpoints')name='LineBounds';
  rows.push([r.elementId,typeof name==='string'?name.slice(0,64):'Element',[a,b],...(typeof r.visibleText==='string'?[r.visibleText.slice(0,240)]:[])]);indices.push(i);update();
  if(rows.length>400||Buffer.byteLength(JSON.stringify(result),'utf8')>16384){rows.pop();indices.pop();next=i;update();break;}
 }
 update();return result;
}
