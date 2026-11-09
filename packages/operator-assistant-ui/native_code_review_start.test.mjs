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

function savedSnapshot(){
 const binding={...owner},id='save',observationId='save-observation',signature='b'.repeat(64),digest='c'.repeat(64);
 const identity={capability_id:'revit_call_tool',method:'POST',path:'/revit/save-as',request_signature:signature};
 const provenance={source:{algorithm:'sha256',representation:'utf8_json_bytes',digest,byte_count:200}};
 const completed_at=new Date(now+5000).toISOString();
 const result={operation_id:id,binding,authority:'native-host',status:'succeeded',dispatch_state:'dispatched',persistent_effect:'applied',
  receipt_id:'receipt',native_correlation_id:'receipt',request_identity:identity,payload_provenance:provenance,completed_at,
  native_artifact_receipt:{schema:'revit-operator.native-artifact-receipt.v1',method:'POST',path:'/revit/save-as',phase:'apply',status:'complete',
   save_document:{native_save_returned:true,same_document:true,project_binding_changed:false,document_session_changed:true,
    before:{session_id:'native-s',project_fingerprint:owner.document_fingerprint},after:{session_id:'saved-s',project_fingerprint:owner.document_fingerprint}}}};
 return {schema:'revit-operator.assignment-snapshot/v2',current_binding:binding,unresolved_unknown_operation_ids:[],in_flight_operation_ids:[],
  operations:{[id]:{operation_id:id,binding,capability_id:'revit_call_tool',input:{method:'POST',path:'/revit/save-as',body:{dryRun:false}},
   request_identity:identity,dispatch_state:'dispatched',settlement_state:'settled',persistent_effect:'applied',observation_ids:[observationId],result}},
  observations:{[observationId]:{observation_id:observationId,operation_id:id,binding,authority:'native-host',capability_id:'revit_call_tool',
   raw_payload_ref:'evidence:ev1_'+'A'.repeat(32),payload_provenance:provenance}}};
}

test('native same-document SaveAs preserves historical start for later selected code without claiming current verification',()=>{
 const token=capture(),p=packet();p.executions[0].document_session_id='saved-s';
 const result=api.nativeCodeReviewStartContext(token,p,request,savedSnapshot());
 assert.equal(result?.view_id,975109);assert.equal(result.document_session_id,'native-s');
 assert.deepEqual(result.document_session_transitions,[{operation_id:'save',before:'native-s',after:'saved-s',completed_at:new Date(now+5000).toISOString()}]);
 assert.equal(result.native_postcondition_verified,false);assert.equal(result.requested_target_verified,false);
 assert.equal(result.whole_task_verified,false);
});

test('SaveAs bridge rejects foreign, unknown, invalidated, malformed and unbound historical evidence',()=>{
 const mutations={
  'foreign snapshot':s=>s.current_binding={...owner,run_id:'other'},
  'unknown':s=>s.unresolved_unknown_operation_ids=['unknown'],
  'pending operation':s=>s.in_flight_operation_ids=['pending'],
  'invalidated':s=>s.input_invalidated_operation_ids=['save'],
  'foreign operation':s=>s.operations.save.binding={...owner,principal_id:'other'},
  'unsettled':s=>s.operations.save.settlement_state='pending',
  'failed':s=>s.operations.save.result.status='failed',
  'unknown effect':s=>s.operations.save.result.persistent_effect='unknown',
  'wrong authority':s=>s.operations.save.result.authority='model',
  'wrong receipt':s=>s.operations.save.result.receipt_id='foreign',
  'wrong request':s=>s.operations.save.result.request_identity={...s.operations.save.request_identity,request_signature:'d'.repeat(64)},
  'wrong digest':s=>s.observations['save-observation'].payload_provenance={source:{...s.operations.save.result.payload_provenance.source,digest:'d'.repeat(64)}},
  'missing observation':s=>s.observations={},
  'foreign observation':s=>s.observations['save-observation'].binding={...owner,session_id:'other'},
  'wrong evidence':s=>s.observations['save-observation'].raw_payload_ref='untrusted',
  'different document':s=>s.operations.save.result.native_artifact_receipt.save_document.same_document=false,
  'changed project':s=>s.operations.save.result.native_artifact_receipt.save_document.project_binding_changed=true,
  'foreign fingerprint':s=>s.operations.save.result.native_artifact_receipt.save_document.after.project_fingerprint='b'.repeat(64),
  'save did not return':s=>s.operations.save.result.native_artifact_receipt.save_document.native_save_returned=false,
  'preview':s=>s.operations.save.result.native_artifact_receipt.phase='dry_run',
  'before request':s=>s.operations.save.result.completed_at=new Date(now-2000).toISOString(),
  'after execution':s=>s.operations.save.result.completed_at=new Date(now+20000).toISOString(),
  'invalid time':s=>s.operations.save.result.completed_at='invalid',
  'unbridged reopen':s=>s.operations.save.result.native_artifact_receipt.save_document.after.session_id='reopened',
 };
 for(const [name,mutate] of Object.entries(mutations)){
  const s=savedSnapshot(),p=packet();p.executions[0].document_session_id='saved-s';mutate(s);
  assert.equal(api.nativeCodeReviewStartContext(capture(),p,request,s),null,name);
 }
 const p=packet();p.executions[0].document_session_id='saved-s';
 for(const forged of [null,{},JSON.parse(JSON.stringify(capture()))])assert.equal(api.nativeCodeReviewStartContext(forged,p,request,savedSnapshot()),null);
 assert.equal(api.nativeCodeReviewStartContext(capture(),p,request+' changed',savedSnapshot()),null);
});

test('ordered native SaveAs chain is bounded and ambiguous branches or cycles never establish continuity',()=>{
 const s=savedSnapshot(),second=structuredClone(s.operations.save),obs=structuredClone(s.observations['save-observation']);
 second.operation_id='save2';second.result.operation_id='save2';second.observation_ids=['save2-observation'];
 second.result.completed_at=new Date(now+6000).toISOString();
 second.result.native_artifact_receipt.save_document.before.session_id='saved-s';
 second.result.native_artifact_receipt.save_document.after.session_id='saved-again';
 obs.operation_id='save2';obs.observation_id='save2-observation';s.operations.save2=second;s.observations[obs.observation_id]=obs;
 const p=packet();p.executions[0].document_session_id='saved-again';
 assert.equal(api.nativeCodeReviewStartContext(capture(),p,request,s).document_session_transitions.length,2);
 second.result.native_artifact_receipt.save_document.before.session_id='native-s';
 assert.equal(api.nativeCodeReviewStartContext(capture(),p,request,s),null,'ambiguous start');
 second.result.native_artifact_receipt.save_document.before.session_id='saved-s';second.result.native_artifact_receipt.save_document.after.session_id='native-s';
 assert.equal(api.nativeCodeReviewStartContext(capture(),p,request,s),null,'cycle');
});

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
