import test from 'node:test';
import assert from 'node:assert/strict';
import {nativeViewActivationRequest, confirmNativeViewActivation, focusNativeReviewTarget} from './native_view_activation.mjs';

const target={view_id:41,show_element_ids:[101,102],bbox_min_xyz:[0,1,0],bbox_max_xyz:[2,3,0]};
const context=()=>({process_id:123,document:{sessionId:'doc',projectIdentity:{fingerprint:'project'},activeView:{id:41,name:'Sheet'}}});
const receipt=()=>({ok:true,activationPending:false,focusPending:false,requestedViewId:41,activeViewId:41,activeViewName:'Sheet',shownElementIds:[102,101],notShownElementIds:[],didZoom:true});
function host(alter=()=>{}){let dispatches=0;return {count:()=>dispatches,options:{readContext:async()=>context(),assertCurrent:async()=>{},activate:async()=>{dispatches++;const r=receipt();alter(r);return r;}}};}

test('one owner focus tool settles element navigation before contextual bounds and requires both receipts',async()=>{
 const normalized=nativeViewActivationRequest(target);
 assert.equal(normalized.focusKind,'elements_and_bounds');
 assert.deepEqual(normalized.body,{viewId:41,showElementIds:[101,102],bboxMinXyz:[0,1,0],bboxMaxXyz:[2,3,0]});
 const f=host(),calls=[];
 const result=await focusNativeReviewTarget(target,{activeViewId:41,assertCurrent:async()=>{},activate:async t=>{calls.push(t);return confirmNativeViewActivation(t,f.options);}});
 assert.equal(result.ok,true);assert.equal(result.focus.kind,'elements_and_bounds');assert.deepEqual(calls,[{view_id:41,show_element_ids:[101,102]},{view_id:41,bbox_min_xyz:[0,1,0],bbox_max_xyz:[2,3,0]}]);assert.equal(f.count(),2);
});

for(const [name,alter] of Object.entries({zoom:r=>r.didZoom=false,missingZoom:r=>delete r.didZoom,partial:r=>r.shownElementIds=[101],hidden:r=>r.notShownElementIds=[102],duplicate:r=>r.shownElementIds=[101,101],pending:r=>r.focusPending=true}))
 test('combined focus refuses '+name+' instead of claiming either half is enough',async()=>{
  const f=host(alter);assert.equal((await confirmNativeViewActivation(target,f.options)).ok,false);assert.equal(f.count(),1);
 });

test('combined focus retains malformed, competing-fit, document and Pause guards',async()=>{
 for(const t of [{...target,zoom_to_fit:true},{...target,bbox_max_xyz:undefined},{...target,show_element_ids:[101,101]}]){
  const f=host();await assert.rejects(confirmNativeViewActivation(t,f.options));assert.equal(f.count(),0);
 }
 const f=host();let reads=0;f.options.readContext=async()=>{const c=context();if(reads++)c.document.sessionId='other';return c;};
 await assert.rejects(confirmNativeViewActivation(target,f.options),/context_changed/);
 const paused=host();paused.options.assertCurrent=async()=>{throw Error('paused');};
 await assert.rejects(confirmNativeViewActivation(target,paused.options),/paused/);assert.equal(paused.count(),0);
});
