import test from 'node:test';
import assert from 'node:assert/strict';
import {confirmNativeViewActivation,focusNativeReviewTarget,NATIVE_VIEW_ACTIVATION_TOOL} from './native_view_activation.mjs';
// Actual164 identities. Bounds here are synthetic projection outputs, NOT
// recovered historical sheet coordinates or a retroactive visual verdict.
const ids=[1546001,1546027],sheet=1363547;
const association=id=>({elementId:id,elementUniqueId:'element-'+id,viewId:1363413,viewUniqueId:'plan',viewportId:1411505,viewportUniqueId:'viewport',sheetId:sheet,sheetUniqueId:'sheet',coordinateSpace:'sheet_feet',boundsMinXyz:[1,1,0],boundsMaxXyz:[1.1,1.2,0],navigationOnly:true});
const context=()=>({process_id:123,document:{sessionId:'doc',projectIdentity:{fingerprint:'project'},activeView:{id:sheet,name:'M101',type:'DrawingSheet',sheetRenderState:{schema:'operator.sheet-render-state.v1',state:'available',scope:'sheet_and_placed_views',viewId:sheet,viewUniqueId:'sheet',activeViewportCornersXyz:[[0.9,0.9,0],[1.3,1.4,0]]}}}});
const receipt=()=>({ok:true,activationPending:false,focusPending:false,requestedViewId:sheet,activeViewId:sheet,activeViewName:'M101',shownElementIds:[],notShownElementIds:[],modelSheetFocusAssociations:ids.map(association),didZoom:true});
async function run(alter=()=>{},change=()=>{}){let calls=0,reads=0;const r=await confirmNativeViewActivation({view_id:sheet,show_element_ids:ids},{assertCurrent:async()=>{},readContext:async()=>{const c=context();if(reads++)change(c);return c;},activate:async()=>{calls++;const r=receipt();alter(r);return r;}});assert.equal(calls,1);return r;}
test('actual164 target cohort can focus through native sheet associations without claiming model IDs were ShowElements sheet items',async()=>{const r=await run();assert.equal(r.ok,true);assert.equal(r.focus.native_navigation_only,true);assert.equal(r.focus.model_sheet_associations.length,2);});
for(const [name,alter]of Object.entries({foreign:r=>r.modelSheetFocusAssociations[0].sheetId++,uid:r=>r.modelSheetFocusAssociations[0].sheetUniqueId='foreign',missing:r=>r.modelSheetFocusAssociations.pop(),duplicate:r=>r.modelSheetFocusAssociations.push(r.modelSheetFocusAssociations[0]),unexpected:r=>r.modelSheetFocusAssociations[0].elementId=999,view:r=>r.modelSheetFocusAssociations[0].viewId=sheet,viewport:r=>r.modelSheetFocusAssociations[0].viewportUniqueId='',nan:r=>r.modelSheetFocusAssociations[0].boundsMinXyz[0]=NaN,inverted:r=>r.modelSheetFocusAssociations[0].boundsMinXyz[0]=9,plane:r=>r.modelSheetFocusAssociations[0].boundsMaxXyz[2]=1,unit:r=>r.modelSheetFocusAssociations[0].coordinateSpace='model_feet',claim:r=>r.modelSheetFocusAssociations[0].navigationOnly=false,noZoom:r=>r.didZoom=false,hidden:r=>r.notShownElementIds=[ids[0]],pending:r=>r.focusPending=true,shownLie:r=>r.shownElementIds=ids}))test('model-sheet focus refuses '+name,async()=>assert.equal((await run(alter)).ok,false));
for(const [name,change]of Object.entries({missing:c=>delete c.document.activeView.sheetRenderState,tight:c=>c.document.activeView.sheetRenderState.activeViewportCornersXyz=[[1.01,1.01,0],[1.05,1.05,0]],plane:c=>c.document.activeView.type='FloorPlan'}))test('model-sheet focus requires fresh '+name+' coverage',async()=>assert.equal((await run(()=>{},change)).ok,false));
test('cross-row identities cannot alias distinct native IDs',async()=>{
 assert.equal((await run(r=>r.modelSheetFocusAssociations[1].elementUniqueId=r.modelSheetFocusAssociations[0].elementUniqueId)).ok,false);
 assert.equal((await run(r=>r.modelSheetFocusAssociations[1].viewUniqueId='other-plan')).ok,false);
});
test('contextual second zoom cannot exclude a mapped element, and retained associations survive an encompassing zoom',async()=>{
 for(const valid of [false,true]){const calls=[];const r=await focusNativeReviewTarget({view_id:sheet,show_element_ids:ids,bbox_min_xyz:[valid?.9:1.05,.9,0],bbox_max_xyz:[1.3,1.4,0]},{activeViewId:sheet,assertCurrent:async()=>{},activate:async t=>{calls.push(t);return {ok:true,active_view:{id:sheet},focus:{confirmed:true,native_navigation_only:true,kind:t.show_element_ids?'elements':'bounds',...(t.show_element_ids?{model_sheet_associations:ids.map(association)}:{})}};}});assert.equal(r.ok,valid);assert.equal(calls.length,valid?2:1);if(valid)assert.equal(r.focus.model_sheet_associations.length,2);}
});
test('native focus model-visible contract preserves navigation-only limits and no guessed coordinates',()=>{
 assert.match(NATIVE_VIEW_ACTIVATION_TOOL.description,/projection transforms/);
 assert.match(NATIVE_VIEW_ACTIVATION_TOOL.description,/not proof/);
});
test('Pause and changed document prevent physical sheet-focus acceptance',async()=>{
 let calls=0;await assert.rejects(confirmNativeViewActivation({view_id:sheet,show_element_ids:ids},{assertCurrent:async()=>{throw Error('paused');},readContext:async()=>context(),activate:async()=>{calls++;return receipt();}}),/paused/);assert.equal(calls,0);
 await assert.rejects(run(()=>{},c=>c.document.sessionId='foreign'),/context_changed/);
});
