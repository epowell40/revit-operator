const positive=v=>Number.isSafeInteger(v)&&v>0;
const text=v=>typeof v==='string'&&v.trim().length>0&&v.length<=240;

/** One owner-requested focus sequence using the existing tracked navigation
 * path. Never retry an unconfirmed activation or infer model correctness. */
export async function focusNativeReviewTarget(target,{activeViewId,activate,assertCurrent}){
 const normalized=nativeViewActivationRequest(target);
 if(!['elements','bounds','elements_and_bounds'].includes(normalized.focusKind))throw Error('native_review_focus_requires_elements_or_bounds');
 await assertCurrent();
 if(activeViewId!==target.view_id){
  const opened=await activate({view_id:target.view_id});await assertCurrent();
  if(opened?.ok!==true||opened.active_view?.id!==target.view_id)return opened;
 }
 // Revit can settle ShowElements navigation after a same-dispatch zoom. Keep
 // both inside this owner tool, but let the first native dispatch settle before
 // the contextual zoom. Never retry a failed half or ask another model turn.
 if(normalized.focusKind==='elements_and_bounds'){
  await assertCurrent();const elements=await activate({view_id:target.view_id,show_element_ids:target.show_element_ids});await assertCurrent();
  if(elements?.ok!==true)return elements;
  const mapped=elements.focus?.model_sheet_associations;
  if(mapped?.length&&!mapped.every(a=>a.boundsMinXyz.every((n,i)=>target.bbox_min_xyz[i]<=n+1e-7)&&a.boundsMaxXyz.every((n,i)=>target.bbox_max_xyz[i]>=n-1e-7)))
   return{ok:false,focus_pending:true,error:'Requested contextual bounds exclude a projected native target. Enlarge the region from actual sheet geometry; no visual correctness inferred.'};
  const bounds=await activate({view_id:target.view_id,bbox_min_xyz:target.bbox_min_xyz,bbox_max_xyz:target.bbox_max_xyz});await assertCurrent();
  return bounds?.ok===true?{...bounds,focus:{...bounds.focus,kind:'elements_and_bounds',...(mapped?.length?{model_sheet_associations:mapped}:{})}}:bounds;
 }
 await assertCurrent();const focused=await activate(target);await assertCurrent();
 return focused;
}

export const NATIVE_VIEW_ACTIVATION_TOOL={type:'function',name:'activate_revit_view',
 description:'Activate an exact existing Revit view or schedule for authorized UI navigation without changing model content. '+
  'For deterministic focus, first activate the exact view, then use show_element_ids, paired bbox_min_xyz/bbox_max_xyz, or zoom_to_fit. In review_current_work, provide element IDs and contextual bounds together: its host sequence settles element focus before contextual zoom, without another model turn. Direct combined navigation is not confirmed unless the fresh actual sheet viewport contains the requested bounds. Do not combine zoom_to_fit with either. '+
  'Derive element IDs and bounds from fresh native geometry, never screenshot pixels. Bounds use the target view coordinate space: model feet for model views; sheet feet with z=0 for sheets. Never use model-coordinate bounds on a sheet. '+
  'On a sheet, an inspected schedule definition ID may be focused directly: native Revit resolves its unique actual placement on that sheet. Missing or repeated placements stay unconfirmed. This navigation association does not replace the definition ID in native verification. '+
  'For host model elements on a sheet, prefer show_element_ids without bounds: native Revit localizes their unique placed view and projection transforms, then frames the actual projected footprint with a small context margin. Include relevant neighboring model elements when wider context is needed. Ambiguous placements, unsupported crop or missing geometry stay unconfirmed; do not guess sheet coordinates or change elements to obtain focus. Native associations are navigation only, not proof that symbols render clearly. '+
  'Focus confirms navigation only: inspect the actual result. For stable detailed visual review use native_visible_region after focusing the work and all neighboring content needed by the checks. '+
  'A focused image cannot prove unseen areas; retain native preservation and separate whole-sheet obligations.',
 parameters:{type:'object',additionalProperties:false,properties:{
  view_id:{type:'integer',description:'Exact existing view/schedule ID. Required for focus.'},
  view_name:{type:'string',description:'Exact existing view/schedule name, for plain activation when ID is unavailable.'},
  show_element_ids:{type:'array',minItems:1,maxItems:200,items:{type:'integer'},description:'Existing native element IDs to show in the already active exact view. All must be confirmed shown.'},
  bbox_min_xyz:{type:'array',minItems:3,maxItems:3,items:{type:'number'},description:'Minimum [x,y,z] in target-view coordinates: model feet for model views, sheet feet (z=0) for sheets. Pair with bbox_max_xyz. For physical model elements on a sheet prefer show_element_ids without bounds, using native projection.'},
  bbox_max_xyz:{type:'array',minItems:3,maxItems:3,items:{type:'number'},description:'Maximum [x,y,z] in target-view coordinates: model feet for model views, sheet feet (z=0) for sheets. Pair with bbox_min_xyz; never copy model bounds onto a sheet.'},
  zoom_to_fit:{type:'boolean',description:'Fit the already active exact view. Does not select a stable detailed review region.'}
 },anyOf:[{required:['view_id']},{required:['view_name']}]}};

/** Existing native navigation only. Keep omitted legacy fields omitted, and
 * reject malformed or competing focus requests before any dispatch. */
export function nativeViewActivationRequest(target){
 if(!target||typeof target!=='object'||Array.isArray(target)||Object.keys(target).some(k=>!Object.hasOwn(NATIVE_VIEW_ACTIVATION_TOOL.parameters.properties,k)))
  throw Error('native_view_activation_options_invalid');
 const viewId=target.view_id,viewName=target.view_name;
 if(!positive(viewId)&&!text(viewName))throw Error('native_view_activation_target_invalid');
 const body=positive(viewId)?{viewId}:{viewName:viewName.trim(),exact:true};
 const ids=target.show_element_ids,hasIds=ids!==undefined;
 const hasBox=target.bbox_min_xyz!==undefined||target.bbox_max_xyz!==undefined;
 if(target.zoom_to_fit!==undefined&&typeof target.zoom_to_fit!=='boolean')throw Error('native_view_activation_focus_invalid');
 const hasFit=target.zoom_to_fit===true;
 if(hasFit&&(hasIds||hasBox))throw Error('native_view_activation_competing_focus');
 if(hasIds){
  if(!Array.isArray(ids)||!ids.length||ids.length>200||!ids.every(positive)||new Set(ids).size!==ids.length)throw Error('native_view_activation_elements_invalid');
  body.showElementIds=[...ids];
 }
 if(hasBox){
  const min=target.bbox_min_xyz,max=target.bbox_max_xyz,vector=v=>Array.isArray(v)&&v.length===3&&v.every(Number.isFinite);
  if(!vector(min)||!vector(max)||min.some((v,i)=>v>max[i])||min.filter((v,i)=>max[i]>v).length<2)throw Error('native_view_activation_bounds_invalid');
  body.bboxMinXyz=[...min];body.bboxMaxXyz=[...max];
 }
 if(hasFit)body.zoomToFit=true;
 const hasFocus=hasIds||hasBox||hasFit;
 if(hasFocus&&!positive(viewId))throw Error('native_view_activation_focus_requires_exact_id');
 return{body,hasFocus,focusKind:hasIds&&hasBox?'elements_and_bounds':hasIds?'elements':hasBox?'bounds':hasFit?'fit':null};
}
function identity(context){
 const d=context?.document;
 if(!positive(context?.process_id)||!text(d?.sessionId)||!text(d?.projectIdentity?.fingerprint))
  throw Error('native_view_activation_context_identity_unavailable');
 return {process:context.process_id,session:d.sessionId,project:d.projectIdentity.fingerprint};
}
function sameIdentity(before,context){
 const after=identity(context);
 if(Object.keys(before).some(k=>before[k]!==after[k]))throw Error('native_view_activation_context_changed');
}

function confirmedElementFocus(requested,shown,missing,associations,sheetId){
 if(!Array.isArray(shown)||!shown.every(positive)||new Set(shown).size!==shown.length||!Array.isArray(missing)||missing.length)return false;
 if(associations===undefined||Array.isArray(associations)&&!associations.length)
  return shown.length===requested.length&&requested.every(id=>shown.includes(id));
 if(!Array.isArray(associations)||associations.length>200||new Set(associations.map(a=>a?.scheduleId)).size!==associations.length)return false;
 if(!associations.every(a=>positive(a?.scheduleId)&&requested.includes(a.scheduleId)&&positive(a.instanceId)&&a.instanceId!==a.scheduleId
  &&a.sheetId===sheetId&&text(a.sheetUniqueId)&&text(a.scheduleUniqueId)&&text(a.instanceUniqueId)&&shown.includes(a.instanceId)))return false;
 const resolved=new Set(requested.map(id=>associations.find(a=>a.scheduleId===id)?.instanceId??id));
 return shown.length===resolved.size&&shown.every(id=>resolved.has(id));
}

function observedSheetBoundsCover(active,body){
 // Sheet coordinates have a native fixed display plane. Do not apply this
 // axis-aligned test to arbitrary model/3D views or infer rendered readability.
 if(active?.type!=='DrawingSheet'||body.bboxMinXyz===undefined)return true;
 const s=active.sheetRenderState,p=s?.activeViewportCornersXyz;
 if(s?.schema!=='operator.sheet-render-state.v1'||s.state!=='available'||s.scope!=='sheet_and_placed_views'
   ||s.viewId!==active.id||!text(s.viewUniqueId)||!Array.isArray(p)||p.length!==2
   ||p.some(v=>!Array.isArray(v)||v.length!==3||!v.every(Number.isFinite))||p[0].every((n,i)=>n===p[1][i]))return false;
 return body.bboxMinXyz.every((n,i)=>Math.min(p[0][i],p[1][i])<=n+1e-7)
  &&body.bboxMaxXyz.every((n,i)=>Math.max(p[0][i],p[1][i])>=n-1e-7);
}

function confirmedModelSheetFocus(rows,requested,receipt,active){
 if(rows===undefined||Array.isArray(rows)&&!rows.length)return [];
 if(!Array.isArray(rows)||rows.length>200||!requested||active?.type!=='DrawingSheet'||receipt.didZoom!==true
  ||new Set(rows.map(a=>a?.elementId)).size!==rows.length)return null;
 const vector=v=>Array.isArray(v)&&v.length===3&&v.every(Number.isFinite);
 const sheetUid=active.sheetRenderState?.viewUniqueId;
 const placements=new Map(),identityIds=new Map(),identityUids=new Map();
 for(const a of rows){
  if(!a||![a.elementId,a.viewId,a.viewportId,a.sheetId].every(positive)||new Set([a.elementId,a.viewId,a.viewportId,a.sheetId]).size!==4
   ||!requested.includes(a.elementId)||a.sheetId!==active.id||a.sheetUniqueId!==sheetUid
   ||![a.elementUniqueId,a.viewUniqueId,a.viewportUniqueId,a.sheetUniqueId].every(text)
   ||a.coordinateSpace!=='sheet_feet'||a.navigationOnly!==true||!vector(a.boundsMinXyz)||!vector(a.boundsMaxXyz)
   ||a.boundsMinXyz[2]!==0||a.boundsMaxXyz[2]!==0||a.boundsMinXyz[0]>=a.boundsMaxXyz[0]||a.boundsMinXyz[1]>=a.boundsMaxXyz[1]
   ||!observedSheetBoundsCover(active,{bboxMinXyz:a.boundsMinXyz,bboxMaxXyz:a.boundsMaxXyz}))return null;
  for(const [id,uid]of [[a.elementId,a.elementUniqueId],[a.viewId,a.viewUniqueId],[a.viewportId,a.viewportUniqueId],[a.sheetId,a.sheetUniqueId]]){
   if(identityIds.has(id)&&identityIds.get(id)!==uid||identityUids.has(uid)&&identityUids.get(uid)!==id)return null;
   identityIds.set(id,uid);identityUids.set(uid,id);
  }
  const identity=JSON.stringify([a.viewportUniqueId,a.viewId,a.viewUniqueId]);
  if(placements.has(a.viewportId)&&placements.get(a.viewportId)!==identity)return null;
  placements.set(a.viewportId,identity);
 }
 return rows;
}

/** The native host can accept RequestViewChange before ActiveView changes.
 * Read the same host/document until it confirms the requested view; never
 * repeat activation or infer success from the requested ID. This confirms UI
 * location only, not model effects, authorization or whole-task completion. */
export async function confirmNativeViewActivation(target,{readContext,activate,assertCurrent,delay}){
 const request=nativeViewActivationRequest(target);
 const viewId=target?.view_id,viewName=target?.view_name;
 if(!positive(viewId)&&!text(viewName))throw Error('native_view_activation_target_invalid');
 await assertCurrent();
 const initial=await readContext(),before=identity(initial);
 if(request.hasFocus&&initial.document.activeView?.id!==viewId)
  return{ok:false,focus_pending:true,requested_view_id:viewId,error:'Activate the exact target view before requesting native focus. No focus was dispatched.'};
 await assertCurrent();
 const receipt=await activate();
 await assertCurrent();
 if(!receipt||receipt.ok===false)throw Error('native_view_activation_receipt_unavailable');
 const requested=receipt.requestedViewId??viewId;
 if(!positive(requested)||(positive(viewId)&&requested!==viewId)
   ||(!positive(viewId)&&(!text(receipt.requestedViewName)||receipt.requestedViewName.trim().toLowerCase()!==viewName.trim().toLowerCase())))
  throw Error('native_view_activation_requested_identity_mismatch');
 if(receipt.activationPending===true){
  if(!positive(receipt.requestedViewId)||!positive(receipt.activeViewId))throw Error('native_view_activation_pending_identity_unavailable');
  if(request.hasFocus)return{ok:false,activation_pending:true,focus_pending:true,requested_view_id:requested,error:'The view changed during navigation; focus is unconfirmed. Inspect current context before another navigation request.'};
  for(let attempt=0;attempt<5;attempt++){
   await assertCurrent();
   const observed=await readContext();
   await assertCurrent();
   sameIdentity(before,observed);
   const active=observed.document?.activeView;
   if(active?.id===requested&&text(active.name))return {ok:true,active_view:{id:active.id,name:active.name}};
   if(!positive(active?.id))throw Error('native_view_activation_active_identity_unavailable');
   if(attempt<4)await delay(250);
  }
  return {ok:false,activation_pending:true,requested_view_id:requested,error:'Revit accepted the view change, but fresh context has not confirmed it yet. Inspect the current state before retrying.'};
 }
 if(receipt.activationPending!==undefined&&receipt.activationPending!==false)throw Error('native_view_activation_pending_flag_invalid');
 if(receipt.activeViewId!==requested||!text(receipt.activeViewName))
  return {ok:false,error:`Revit reported active view ${receipt.activeViewId||'unknown'}, not requested view ${requested}.`};
 // A separate read also detects document or process changes around immediate activation.
 const observed=await readContext();await assertCurrent();sameIdentity(before,observed);
 const active=observed.document?.activeView;
 if(active?.id!==requested||!text(active.name))throw Error('native_view_activation_fresh_view_mismatch');
 if(request.hasFocus){
  const shown=receipt.shownElementIds,missing=receipt.notShownElementIds;
  const needsElements=request.body.showElementIds!==undefined;
  const needsZoom=request.body.bboxMinXyz!==undefined||request.body.zoomToFit===true;
  const mapped=confirmedModelSheetFocus(receipt.modelSheetFocusAssociations,request.body.showElementIds,receipt,active);
  const direct=request.body.showElementIds?.filter(id=>!mapped?.some(a=>a.elementId===id));
  const confirmed=receipt.focusPending===false
   &&mapped!==null
   &&(!needsElements||confirmedElementFocus(direct,shown,missing,receipt.scheduleFocusAssociations,requested))
   &&(!needsZoom||receipt.didZoom===true)&&observedSheetBoundsCover(active,request.body);
  if(!confirmed)return{ok:false,focus_pending:true,active_view:{id:active.id,name:active.name},error:'Native activation was observed, but the requested focus was not confirmed. No model or visual correctness is inferred.'};
  return{ok:true,active_view:{id:active.id,name:active.name},focus:{confirmed:true,kind:request.focusKind,native_navigation_only:true,...(mapped.length?{model_sheet_associations:mapped}:{})}};
 }
 return {ok:true,active_view:{id:active.id,name:active.name}};
}
