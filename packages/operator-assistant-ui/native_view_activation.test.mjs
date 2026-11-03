import test from 'node:test';import assert from 'node:assert/strict';
import {confirmNativeViewActivation} from './native_view_activation.mjs';
import * as activationContract from './native_view_activation.mjs';
const context=(id=7)=>({process_id:123,document:{sessionId:'doc',projectIdentity:{fingerprint:'project'},activeView:{id,name:id===7?'Old':'Target'}}});
function fixture(){const calls=[];let read=0;return {calls,options:{
 assertCurrent:async()=>{calls.push('guard');},delay:async()=>{calls.push('wait');},
 readContext:async()=>{calls.push('read');return context(++read<3?7:41);},
 activate:async()=>{calls.push('activate');return {ok:true,activationPending:true,requestedViewId:41,requestedViewName:'Target',activeViewId:7,activeViewName:'Old'};}
}};}
test('pending native change is observed on the same host/document with one activation',async()=>{
 const f=fixture();assert.deepEqual(await confirmNativeViewActivation({view_id:41},f.options),{ok:true,active_view:{id:41,name:'Target'}});
 assert.equal(f.calls.filter(x=>x==='activate').length,1);assert.equal(f.calls.filter(x=>x==='read').length,3);
});
test('pending name resolution must retain the exact native requested view',async()=>{
 const f=fixture();assert.equal((await confirmNativeViewActivation({view_name:'TARGET'},f.options)).ok,true);
});
test('timeout retains pending status and never replays activation',async()=>{
 const f=fixture();f.options.readContext=async()=>context();const r=await confirmNativeViewActivation({view_id:41},f.options);
 assert.equal(r.ok,false);assert.equal(r.activation_pending,true);assert.equal(r.requested_view_id,41);
 assert.equal(f.calls.filter(x=>x==='activate').length,1);
});
for(const [key,change]of Object.entries({process:c=>c.process_id++,session:c=>c.document.sessionId='other',project:c=>c.document.projectIdentity.fingerprint='other',missing:c=>delete c.document.sessionId}))
 test('pending confirmation rejects '+key+' identity drift',async()=>{const f=fixture();let n=0;f.options.readContext=async()=>{const c=context(41);if(n++)change(c);return c;};await assert.rejects(confirmNativeViewActivation({view_id:41},f.options),/context_identity_unavailable|context_changed/);});
for(const [key,change]of Object.entries({requested:r=>r.requestedViewId=99,missing:r=>delete r.requestedViewId,missing_active:r=>delete r.activeViewId,failed:r=>r.ok=false}))
 test('pending receipt rejects '+key,async()=>{const f=fixture(),activate=f.options.activate;f.options.activate=async()=>{const r=await activate();change(r);return r;};await assert.rejects(confirmNativeViewActivation({view_id:41},f.options),/identity|receipt/);});
test('Pause or changed owner stops the pending read loop without another activation',async()=>{
 const f=fixture();let guards=0;f.options.assertCurrent=async()=>{if(++guards===5)throw Error('paused');};
 await assert.rejects(confirmNativeViewActivation({view_id:41},f.options),/paused/);assert.equal(f.calls.filter(x=>x==='activate').length,1);
});
test('immediate activation still requires fresh same-document observed target',async()=>{
 const f=fixture();f.options.readContext=async()=>context(41);f.options.activate=async()=>({ok:true,activationPending:false,requestedViewId:41,activeViewId:41,activeViewName:'Target'});
 assert.equal((await confirmNativeViewActivation({view_id:41},f.options)).ok,true);
 f.options.readContext=async()=>context(7);await assert.rejects(confirmNativeViewActivation({view_id:41},f.options),/fresh_view_mismatch/);
});
test('missing immediate active identity is never replaced with the requested ID',async()=>{
 const f=fixture();f.options.activate=async()=>({ok:true,requestedViewId:41,activeViewName:'Target'});
 assert.equal((await confirmNativeViewActivation({view_id:41},f.options)).ok,false);
});

test('owner exposes and serializes existing native focus rather than requiring wheel choreography',()=>{
 assert.equal(typeof activationContract.nativeViewActivationRequest,'function');
 const tool=activationContract.NATIVE_VIEW_ACTIVATION_TOOL;
 assert(tool.parameters.properties.bbox_min_xyz&&tool.parameters.properties.bbox_max_xyz);
 assert(tool.parameters.properties.show_element_ids&&tool.parameters.properties.zoom_to_fit);
 const r=activationContract.nativeViewActivationRequest({view_id:41,bbox_min_xyz:[1,2,0],bbox_max_xyz:[3,4,0]});
 assert.deepEqual(r.body,{viewId:41,bboxMinXyz:[1,2,0],bboxMaxXyz:[3,4,0]});assert.equal(r.hasFocus,true);
});
test('focus cannot be claimed from activation alone when native zoom was not applied',async()=>{
 const f=fixture();f.options.readContext=async()=>context(41);
 f.options.activate=async()=>({ok:true,activationPending:false,focusPending:false,requestedViewId:41,activeViewId:41,activeViewName:'Target',didZoom:false});
 const r=await confirmNativeViewActivation({view_id:41,bbox_min_xyz:[1,2,0],bbox_max_xyz:[3,4,0]},f.options);
 assert.equal(r.ok,false);assert.match(r.error,/focus/);
});
for(const [label,change]of Object.entries({
 missing_pair:t=>delete t.bbox_max_xyz,reversed:t=>t.bbox_max_xyz=[0,4,0],nonfinite:t=>t.bbox_min_xyz=[NaN,2,0],
 string:t=>t.bbox_min_xyz=['1',2,0],wrong_length:t=>t.bbox_max_xyz=[3,4],line:t=>t.bbox_max_xyz=[3,2,0],
 competing:t=>t.zoom_to_fit=true,foreign_option:t=>t.path='/revit/save-as',name_only:t=>{delete t.view_id;t.view_name='Target';}
}))test('invalid native focus '+label+' refuses before native/context dispatch',async()=>{
 const t={view_id:41,bbox_min_xyz:[1,2,0],bbox_max_xyz:[3,4,0]};change(t);const f=fixture();
 await assert.rejects(confirmNativeViewActivation(t,f.options),/native_view_activation/);assert.deepEqual(f.calls,[]);
});
for(const ids of [[],[1,1],[0],[1.5],Array.from({length:201},(_,i)=>i+1)])test('invalid focus element cohort '+JSON.stringify(ids.slice(0,3)),()=>{
 assert.throws(()=>activationContract.nativeViewActivationRequest({view_id:41,show_element_ids:ids}),/elements_invalid/);
});
test('legacy omitted focus and false fit retain exact plain native body',()=>{
 assert.deepEqual(activationContract.nativeViewActivationRequest({view_id:41}).body,{viewId:41});
 assert.deepEqual(activationContract.nativeViewActivationRequest({view_name:' Target ',zoom_to_fit:false}).body,{viewName:'Target',exact:true});
});
test('inactive focus target refuses without trying focus against another view',async()=>{
 const f=fixture(),r=await confirmNativeViewActivation({view_id:41,zoom_to_fit:true},f.options);
 assert.equal(r.ok,false);assert.equal(r.focus_pending,true);assert.equal(f.calls.includes('activate'),false);
});
for(const kind of ['bounds','fit','elements'])test('confirmed '+kind+' focus requires a fresh same-document target read',async()=>{
 const f=fixture();f.options.readContext=async()=>context(41);
 const target={view_id:41,...(kind==='bounds'?{bbox_min_xyz:[1,2,0],bbox_max_xyz:[3,4,0]}:kind==='fit'?{zoom_to_fit:true}:{show_element_ids:[91,92]})};
 f.options.activate=async()=>({ok:true,activationPending:false,focusPending:false,requestedViewId:41,activeViewId:41,activeViewName:'Target',didZoom:true,shownElementIds:[92,91],notShownElementIds:[]});
 const r=await confirmNativeViewActivation(target,f.options);assert.equal(r.ok,true);assert.deepEqual(r.focus,{confirmed:true,kind,native_navigation_only:true});
 let reads=0;f.options.readContext=async()=>{const c=context(41);if(reads++)c.document.sessionId='foreign';return c;};
 await assert.rejects(confirmNativeViewActivation(target,f.options),/context_changed/);
});
for(const change of [r=>r.focusPending=true,r=>r.shownElementIds=[91],r=>r.shownElementIds=[91,93],r=>r.shownElementIds=[91,91],r=>r.notShownElementIds=[92]])
 test('partial or pending shown-elements receipt never claims complete focus',async()=>{
  const f=fixture();f.options.readContext=async()=>context(41);
  f.options.activate=async()=>{const r={ok:true,activationPending:false,focusPending:false,requestedViewId:41,activeViewId:41,activeViewName:'Target',shownElementIds:[91,92],notShownElementIds:[]};change(r);return r;};
  assert.equal((await confirmNativeViewActivation({view_id:41,show_element_ids:[91,92]},f.options)).ok,false);
 });
test('focus race returns pending and never replays native navigation',async()=>{
 const f=fixture();f.options.readContext=async()=>context(41);
 f.options.activate=async()=>{f.calls.push('activate');return{ok:true,activationPending:true,focusPending:true,requestedViewId:41,activeViewId:7};};
 const r=await confirmNativeViewActivation({view_id:41,zoom_to_fit:true},f.options);
 assert.equal(r.ok,false);assert.equal(r.focus_pending,true);assert.equal(f.calls.filter(c=>c==='activate').length,1);
});
