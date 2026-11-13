import test from 'node:test';
import assert from 'node:assert/strict';
import * as review from './visual_work_review.mjs';

const location={process_id:42,document_session_id:'doc',view_id:12};
test('visible capture refreshes existing Revit view before reading pixels, without changing framing',async()=>{
 const calls=[];
 const result=await review.captureRefreshedVisibleWork(location,{
  readNative:async(route,body,expected)=>{calls.push('refresh');assert.equal(route,'/revit/regenerate');assert.deepEqual(body,{refreshActiveView:true});assert.equal(expected,location);return{ok:true};},
  capture:async expected=>{calls.push('pixels');assert.equal(expected,location);return{image_base64:'fresh',frame:{kind:'revit_view'}};}
 });
 assert.deepEqual(calls,['refresh','pixels']);assert.equal(result.image_base64,'fresh');
 assert.equal(result.view_refresh.state,'requested');assert.equal(result.view_refresh.pixel_freshness_verified,false);
});
test('exact owned-modal admission refusal preserves dialog capture without dispatching refresh',async()=>{
 const e=Object.assign(new Error('script rejected'),{stderr:'visual_review_native_read_blocked_by_modal\r\n'});
 const result=await review.captureRefreshedVisibleWork(location,{readNative:async()=>{throw e;},capture:async()=>({frame:{kind:'revit_dialog'},image_base64:'dialog'})});
 assert.equal(result.view_refresh.state,'skipped_owned_modal');
});
for(const [name,value]of Object.entries({failed:{ok:false},unknown:{ok:true,outcome_unknown:true},nested_unknown:{ok:true,canonical_attempt_settlement:{outcome_unknown:true}},missing:{},untrusted:{ok:'true'}}))test('no screenshot or mutation retry after '+name+' refresh response',async()=>{
 let captures=0,reads=0;
 await assert.rejects(()=>review.captureRefreshedVisibleWork(location,{readNative:async()=>{reads++;return value;},capture:async()=>{captures++;}}),/visual_review_view_refresh_unconfirmed/);
 assert.equal(reads,1);assert.equal(captures,0);
});
for(const label of ['Paused','visual_review_window_owner_changed','visual_review_native_read_blocked_by_modal'])test('no fallback from untrusted or control exception '+label,async()=>{
 let captures=0;await assert.rejects(()=>review.captureRefreshedVisibleWork(location,{readNative:async()=>{throw Error(label);},capture:async()=>{captures++;}}),new RegExp(label));assert.equal(captures,0);
});
test('modal admission race cannot turn a skipped refresh into a drawing capture',async()=>{
 await assert.rejects(()=>review.captureRefreshedVisibleWork(location,{readNative:async()=>{throw Object.assign(Error('modal'),{stderr:'visual_review_native_read_blocked_by_modal'});},capture:async()=>({frame:{kind:'revit_view'}})}),/visual_review_modal_changed_before_capture/);
});
