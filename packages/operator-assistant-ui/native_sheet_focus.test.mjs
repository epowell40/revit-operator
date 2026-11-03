import test from 'node:test';import assert from 'node:assert/strict';
import {confirmNativeViewActivation,focusNativeReviewTarget} from './native_view_activation.mjs';
const target={view_id:41,bbox_min_xyz:[0.08,1.57,0],bbox_max_xyz:[1.3,2.47,0]},corners=[[-0.2,1.5,0],[1.6,2.5,0]];
function fixture(change=()=>{}){let reads=0,calls=0;return{count:()=>calls,options:{assertCurrent:async()=>{},readContext:async()=>{const c={process_id:123,document:{sessionId:'doc',projectIdentity:{fingerprint:'project'},activeView:{id:41,name:'Sheet',type:'DrawingSheet',sheetRenderState:{schema:'operator.sheet-render-state.v1',state:'available',scope:'sheet_and_placed_views',viewId:41,viewUniqueId:'sheet-uid',activeViewportCornersXyz:structuredClone(corners)}}}};if(reads++)change(c);return c;},activate:async()=>{calls++;return{ok:true,activationPending:false,focusPending:false,activeViewId:41,activeViewName:'Sheet',requestedViewId:41,didZoom:true};}}};}
test('sheet bounds confirmation requires actual current viewport coverage after native zoom',async()=>{const f=fixture();assert.equal((await confirmNativeViewActivation(target,f.options)).ok,true);assert.equal(f.count(),1);});
for(const [name,change]of Object.entries({
 tight:c=>c.document.activeView.sheetRenderState.activeViewportCornersXyz=[[0.36,1.90,0],[0.90,2.18,0]],
 absent:c=>delete c.document.activeView.sheetRenderState,
 unavailable:c=>c.document.activeView.sheetRenderState.state='unavailable',
 foreign:c=>c.document.activeView.sheetRenderState.viewId=42,
 uid:c=>delete c.document.activeView.sheetRenderState.viewUniqueId,
 nonfinite:c=>c.document.activeView.sheetRenderState.activeViewportCornersXyz[0][0]=NaN,
 point:c=>c.document.activeView.sheetRenderState.activeViewportCornersXyz=[[1,2,0],[1,2,0]],
 wrongPlane:c=>c.document.activeView.sheetRenderState.activeViewportCornersXyz=[[0,1,1],[2,3,1]],
 malformed:c=>c.document.activeView.sheetRenderState.activeViewportCornersXyz=[[0,1],[2,3]],
 scope:c=>c.document.activeView.sheetRenderState.scope='other'
}))test('sheet zoom '+name+' stays unconfirmed with no hidden retry',async()=>{const f=fixture(change),r=await confirmNativeViewActivation(target,f.options);assert.equal(r.ok,false);assert.equal(r.focus_pending,true);assert.equal(f.count(),1);});
test('corner ordering and aspect expansion do not require identical viewport corners',async()=>{const f=fixture(c=>c.document.activeView.sheetRenderState.activeViewportCornersXyz=[...corners].reverse());assert.equal((await confirmNativeViewActivation(target,f.options)).ok,true);});
test('combined review focus separates element focus from contextual zoom inside one host tool',async()=>{const calls=[];const r=await focusNativeReviewTarget({...target,show_element_ids:[101]},{activeViewId:41,assertCurrent:async()=>{},activate:async t=>{calls.push(t);return{ok:true,active_view:{id:41,name:'Sheet'},focus:{confirmed:true,kind:t.show_element_ids?'elements':'bounds',native_navigation_only:true}};}});assert.deepEqual(calls,[{view_id:41,show_element_ids:[101]},target]);assert.equal(r.focus.kind,'elements_and_bounds');});
test('unconfirmed first navigation never dispatches bounds and Pause stops the second step',async()=>{let calls=0;const r=await focusNativeReviewTarget({...target,show_element_ids:[101]},{activeViewId:41,assertCurrent:async()=>{},activate:async()=>{calls++;return{ok:false,focus_pending:true};}});assert.equal(r.ok,false);assert.equal(calls,1);calls=0;await assert.rejects(focusNativeReviewTarget({...target,show_element_ids:[101]},{activeViewId:41,assertCurrent:async()=>{if(calls)throw Error('paused');},activate:async()=>{calls++;return{ok:true};}}),/paused/);assert.equal(calls,1);});
