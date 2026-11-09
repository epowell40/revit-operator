import test from 'node:test';
import assert from 'node:assert/strict';
import * as api from './native_code_review.mjs';

const now=Date.parse('2026-11-09T12:15:37Z');
const request='Recreate the attached detail in the active drafting view.';
const owner={assignment_id:'a',session_id:'s',run_id:'r',generation:1,principal_id:'p',document_fingerprint:'a'.repeat(64)};
function context(){return {revit:{schema:'revit-operator.context.v1',source:{live:true},observed_at_utc:new Date(now-1000).toISOString(),process_id:42,
 document:{title:'Trial',path:'C:/private/model.rvt',sessionId:'native-s',projectIdentity:{fingerprint:owner.document_fingerprint},activeView:{id:975109,name:'Drafting',type:'DraftingView'},selection:[]}}};}
function packet(){return {owner:{...owner},executions:[{recorded_at:new Date(now+10000).toISOString(),document_session_id:'native-s'}]};}
function capture(c=context(),r=request){return api.bindNativeCodeReviewStart(api.captureNativeCodeReviewStart(c,r,now),owner);}

test('original active-view context survives later view changes as bounded historical context only',()=>{
 const c=context(),token=capture(c);c.revit.document.activeView.id=999;
 const p=api.nativeCodeReviewStartContext(token,packet(),request);
 assert.equal(p.view_id,975109);assert.equal(p.authority,'host_request_start_identity');
 assert.equal(p.native_postcondition_verified,false);assert.equal(p.whole_task_verified,false);
 assert.equal(p.requested_target_verified,false);assert.doesNotMatch(JSON.stringify(p),/private|selection|write_grant/);
 assert(Buffer.byteLength(JSON.stringify(p))<2000);
});

test('serialized caller data or restored current context cannot masquerade as captured task start',()=>{
 const token=capture();
 for(const forged of [null,{},JSON.parse(JSON.stringify(token)),{view_id:975109,authority:'host_request_start_identity'}])
  assert.equal(api.nativeCodeReviewStartContext(forged,packet(),request),null);
});

test('stale, failed, unknown, invalid-session or invalid document captures remain absent',()=>{
 for(const mutate of [c=>c.revit.observed_at_utc=new Date(now-5001).toISOString(),c=>c.revit.source.live=false,
  c=>c.revit.outcome_unknown=true,c=>c.revit.canonical_attempt_settlement={outcome_unknown:true},c=>delete c.revit.document.sessionId,
  c=>c.revit.document.projectIdentity.fingerprint='not-a-digest',c=>c.revit.document.activeView.id=0]){
  const c=context();mutate(c);assert.equal(api.nativeCodeReviewStartContext(capture(c),packet(),request),null);
 }
});

test('foreign assignment, changed direction, earlier execution and different document session cannot reuse start identity',()=>{
 const token=capture();
 for(const key of ['assignment_id','session_id','run_id','generation','document_fingerprint']){
  const p=packet();p.owner[key]=key==='generation'?2:'foreign';assert.equal(api.nativeCodeReviewStartContext(token,p,request),null,key);
 }
 for(const mutate of [p=>p.executions[0].recorded_at=new Date(now-2000).toISOString(),p=>p.executions[0].recorded_at='invalid',
  p=>p.executions[0].document_session_id='reopened',p=>p.executions=[]]){
  const p=packet();mutate(p);assert.equal(api.nativeCodeReviewStartContext(token,p,request),null);
 }
 assert.equal(api.nativeCodeReviewStartContext(token,packet(),request+' Also change another view.'),null);
});

test('sparse local binding normalizes goal_id but conflicting principal remains rejected',()=>{
 const sparse={goal_id:owner.assignment_id,session_id:owner.session_id,run_id:owner.run_id,generation:1};
 const token=api.bindNativeCodeReviewStart(api.captureNativeCodeReviewStart(context(),request,now),sparse);
 assert.equal(api.nativeCodeReviewStartContext(token,packet(),request).view_id,975109);
 const p=packet();const pinned=capture();p.owner.principal_id='other';assert.equal(api.nativeCodeReviewStartContext(pinned,p,request),null);
});
