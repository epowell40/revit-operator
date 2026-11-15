// Compare native render observations around one immutable image. This never
// accepts caller pixels, edits, an old verdict, or model correctness. Ordinary
// native epoch/sequence, document/owner/control and retained-image checks must
// also pass. Unsupported states keep the legacy capture comparison path.
const requiredModes=['ExplodedView','PreviewFamilyVisibility','RevealConstraints','RevealHiddenElements','TemporaryHideIsolate','TemporaryViewProperties','WorksharingDisplay'];
const positive=v=>Number.isSafeInteger(v)&&v>0;
const text=v=>typeof v==='string'&&v.length>0&&v.length<=200;
const corners=v=>Array.isArray(v)&&v.length===2&&v.every(p=>Array.isArray(p)&&p.length===3&&p.every(Number.isFinite))&&v[0].some((x,i)=>x!==v[1][i]);

export function nativeSheetRenderState(value,viewId,uniqueId){
 if(value?.schema!=='operator.sheet-render-state.v1'||value.state!=='available'||value.scope!=='sheet_and_placed_views'
  ||value.viewId!==viewId||!positive(viewId)||!text(uniqueId)||value.viewUniqueId!==uniqueId)return null;
 const names=value.modeNames;
 if(!Array.isArray(names)||names.length<requiredModes.length||names.length>32||new Set(names).size!==names.length
  ||!names.every(n=>typeof n==='string'&&/^[A-Za-z][A-Za-z0-9_]{0,79}$/.test(n))||!requiredModes.every(n=>names.includes(n)))return null;
 if(!Array.isArray(value.views)||!value.views.length||value.views.length>128)return null;
 const views=[];
 for(const v of value.views){
  if(!positive(v?.viewId)||!text(v.viewUniqueId)||v.customizedTemporaryMode!==false
   ||!Array.isArray(v.temporaryModes)||v.temporaryModes.length!==names.length
   ||new Set(v.temporaryModes.map(m=>m?.name)).size!==names.length
   ||!v.temporaryModes.every(m=>names.includes(m?.name)&&m.active===false))return null;
  views.push({viewId:v.viewId,viewUniqueId:v.viewUniqueId,customizedTemporaryMode:false,
   temporaryModes:v.temporaryModes.map(m=>({name:m.name,active:false})).sort((a,b)=>a.name.localeCompare(b.name))});
 }
 if(new Set(views.map(v=>v.viewId)).size!==views.length||new Set(views.map(v=>v.viewUniqueId)).size!==views.length
  ||!views.some(v=>v.viewId===viewId&&v.viewUniqueId===uniqueId))return null;
 return {viewId,viewUniqueId:uniqueId,modeNames:[...names].sort(),views:views.sort((a,b)=>a.viewId-b.viewId),
  activeViewportCornersXyz:corners(value.activeViewportCornersXyz)?value.activeViewportCornersXyz.map(p=>[...p]):null};
}

export function sameNativeSheetRendering(a,b,mode){
 if(!a||!b||!['full_view','visible_region'].includes(mode))return false;
 const {activeViewportCornersXyz:av,...as}=a,{activeViewportCornersXyz:bv,...bs}=b;
 return JSON.stringify(as)===JSON.stringify(bs)&&(mode==='full_view'
  ||corners(av)&&corners(bv)&&av.every((p,i)=>p.every((n,j)=>Math.abs(n-bv[i][j])<=1e-9)));
}

export function nativeSheetArtifactState(location,frame){
 if(location?.active_view_id!==frame?.view_id||location.view_id!==frame.view_id||frame.view_type!=='DrawingSheet')return null;
 const native=nativeSheetRenderState(location.sheet_render_state,frame.view_id,frame.view_unique_id);
 const captured=nativeSheetRenderState(frame.sheet_render_state,frame.view_id,frame.view_unique_id);
 if(!sameNativeSheetRendering(native,captured,frame.export_mode))return null;
 if(frame.export_mode==='visible_region'&&(!corners(frame.viewport?.zoomCornersXyz)
  ||!native.activeViewportCornersXyz?.every((p,i)=>p.every((n,j)=>Math.abs(n-frame.viewport.zoomCornersXyz[i][j])<=1e-9))))return null;
 return captured;
}
