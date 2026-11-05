import test from'node:test';import assert from'node:assert/strict';
import{focusNativeReviewTarget,confirmNativeViewActivation,assertNativeViewContextUnchanged,NATIVE_VIEW_ACTIVATION_TOOL}from'./native_view_activation.mjs';
const context=id=>({process_id:12,document:{sessionId:'doc',projectIdentity:{fingerprint:'project'},activeView:{id,name:'View'}}});
for(const kind of ['bounds','fit','elements','elements_and_bounds'])test('existing host sequence completes '+kind+' across view activation',async()=>{
 let active=7;const calls=[],before=context(active);
 const target={view_id:41,...(kind.includes('elements')?{show_element_ids:[101]}:{}),...(kind.includes('bounds')?{bbox_min_xyz:[0,0,0],bbox_max_xyz:[2,2,0]}:{}),...(kind==='fit'?{zoom_to_fit:true}:{})};
 const result=await focusNativeReviewTarget(target,{activeViewId:active,assertCurrent:async()=>{},activate:async part=>{
  calls.push(part);return confirmNativeViewActivation(part,{assertCurrent:async()=>{},readContext:async()=>{const c=context(active);assertNativeViewContextUnchanged(before,c);return c;},activate:async()=>{
   active=part.view_id;return{ok:true,requestedViewId:active,activeViewId:active,activeViewName:'View',activationPending:false,focusPending:false,didZoom:true,shownElementIds:part.show_element_ids??[],notShownElementIds:[]};
  }});
 }});
 assert.equal(result.ok,true);assert.equal(result.focus.confirmed,true);assert.deepEqual(calls[0],{view_id:41});assert.equal(calls.length,kind==='elements_and_bounds'?3:2);
});
for(const key of ['process','session','project','missing'])test('navigation sequence identity anchor rejects '+key,()=>{
 const before=context(7),after=context(41);if(key==='process')after.process_id++;if(key==='session')after.document.sessionId='other';if(key==='project')after.document.projectIdentity.fingerprint='other';if(key==='missing')delete after.document.sessionId;
 assert.throws(()=>assertNativeViewContextUnchanged(before,after),/native_view_activation_context/);
});
test('model-visible contract describes one request without claiming visual correctness',()=>{
 assert.match(NATIVE_VIEW_ACTIVATION_TOOL.description,/one call/);assert.match(NATIVE_VIEW_ACTIVATION_TOOL.description,/unconfirmed step stops/);assert.match(NATIVE_VIEW_ACTIVATION_TOOL.description,/navigation only/);
});
