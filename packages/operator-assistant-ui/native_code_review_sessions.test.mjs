import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import * as code from './native_code_review.mjs';
import {reviewCurrentWork,visualWorkReviewModelOutput} from './visual_work_review.mjs';

// PNG10 selected three committed construction calls and a post-SaveAs read.
// Sessions are historical receipt facts; a mixed packet must still refuse.
function fixture(){
 const owner={assignment_id:'assignment',session_id:'session',run_id:'run',generation:1,principal_id:'principal',document_fingerprint:'a'.repeat(64)};
 const entries=[0,1,2,3].map(i=>{
  const id='ev1_'+String.fromCharCode(65+i).repeat(32),source=`// bounded observed operation ${i}`,mode=i===3?'read':'apply';
  const hash='sha256:'+createHash('sha256').update(source).digest('hex');
  const ref={evidence_id:id,content_hash:'sha256:'+String(i+1).repeat(64),source:'assignment_kernel_v2:operator_run_dynamic_revit_program',trust_level:'authoritative_native',secret_screening_status:'passed',...owner};
  const native={schema:'dynamic-revit-native-execution-receipt/v1',source_hash:hash,document_fingerprint:'sha256:'+owner.document_fingerprint,document_session_id:i===3?'after-save':'before-save',document_revision_before:i,verified:false,retry_permitted:false,read_only:mode==='read',success:true,transaction:{status:mode==='read'?'not_started':'committed',committed:mode==='apply',affected_element_ids:[],added_element_ids:[],modified_element_ids:[],deleted_element_ids:[]},program_result:'observed',error:null};
  const selection={'payload.schema':'revit-operator.dynamic-revit-program-run.v1','payload.execution_lane':'native','payload.requested_mode':mode,'payload.execution_status':'completed','payload.iteration.source_sha256':hash,'projection.native_execution_audit':native};
  const row={call_id:'call_'+i,tool_name:'native__operator_run_dynamic_revit_program',arguments:{source,mode,native_program:{effect_scope:'active_document'}},result:{content:[{type:'inputText',text:JSON.stringify({schema:'revit-operator.model-evidence-envelope.v1',evidence_projections:[ref]})}]}};
  return {id,ref,native,selection,row};
 });
 const calls={native:0,provider:0};
 const host={owner:()=>owner,assertControl:async()=>{},receipts:()=>entries.map(e=>e.row),userRequest:()=> 'Draw the reference detail',
  request:async(route,options)=>{const e=entries.find(e=>e.id===JSON.parse(options.body).evidence_id);return {ok:true,result:{schema:'revit-operator.evidence-retrieval.v1',evidence_ref:e.ref,selection:e.selection,returned_bytes:Buffer.byteLength(JSON.stringify(e.selection)),selection_origins:Object.fromEntries(Object.keys(e.selection).map(k=>[k,k==='projection.native_execution_audit'?'deterministic_projection':'payload'])),missing_fields:[]}};},
  readContext:async()=>{calls.native++;throw Error('native_capture_should_not_start');},requestResponse:async()=>{calls.provider++;throw Error('reviewer_should_not_start');}};
 host.codeReviewPacket=ids=>code.buildNativeCodeReviewPacket(ids,host);
 return {owner,entries,host,calls,ids:entries.map(e=>e.id)};
}

test('mixed sessions refuse with only validated execution grouping, while each historical group remains auditable',async()=>{
 const f=fixture();let failure;try{await f.host.codeReviewPacket(f.ids);}catch(e){failure=e;}
 assert.match(failure.message,/document_session_changed/);
 assert.equal(typeof code.nativeCodeReviewSessionDiagnostic,'function');
 const d=code.nativeCodeReviewSessionDiagnostic(failure);
 assert.deepEqual(d.groups.map(g=>g.executions.map(e=>e.evidence_id)),[f.ids.slice(0,3),f.ids.slice(3)]);
 assert.deepEqual(d.groups.map(g=>g.executions.map(e=>e.mode)),[['apply','apply','apply'],['read']]);
 assert.equal(d.native_postcondition_verified,false);assert.equal(d.whole_task_verified,false);
 for(const ids of [f.ids.slice(0,3),f.ids.slice(3)])assert.equal((await f.host.codeReviewPacket(ids)).executions.length,ids.length);
});

test('mixed-session combined request is rejected before native capture and delivers recovery to the model',async()=>{
 const f=fixture(),r=await reviewCurrentWork({view_id:41,checks:[{id:'detail',expected:'Complete reference detail'}],code_evidence_ids:f.ids},f.host);
 assert.equal(r.reason,'native_code_review_document_session_changed');assert.equal(f.calls.native,0);assert.equal(f.calls.provider,0);
 assert.equal(r.code_session_diagnostic.groups.length,2);assert.equal(r.state,'unavailable');assert.equal(r.whole_task_verified,false);
 const output={output:JSON.stringify({schema:'revit-operator.model-evidence-envelope.v1',evidence_projections:[{evidence_id:'ev1_review'}]})};
 const projected=JSON.parse(visualWorkReviewModelOutput(output,r,'ev1_review').output).evidence_projections[0].visual_work_review;
 assert.deepEqual(projected.code_session_diagnostic,r.code_session_diagnostic);assert.match(projected.guidance,/one document.session group/i);
});

test('code-only consumer preserves grouping; forged errors, invalid receipts and Pause never gain a trusted diagnostic',async()=>{
 const f=fixture(),r=await code.reviewExecutedCode({review_mode:'code_execution',code_evidence_ids:f.ids},f.host);
 assert.equal(r.code_session_diagnostic.groups.length,2);assert.equal(r.state,'unavailable');
 const fake=Object.assign(Error('native_code_review_document_session_changed'),{code_session_diagnostic:r.code_session_diagnostic});
 assert.equal(code.nativeCodeReviewSessionDiagnostic(fake),null);
 for(const bad of ['digest','foreign','unknown','pause']){
  const x=fixture();if(bad==='digest')x.entries[3].native.source_hash='sha256:'+'f'.repeat(64);if(bad==='foreign')x.entries[3].ref.run_id='other';if(bad==='unknown')x.entries[3].native.transaction.status='unknown';if(bad==='pause')x.host.assertControl=async()=>{throw Error('paused');};
  const v=await code.reviewExecutedCode({review_mode:'code_execution',code_evidence_ids:x.ids},x.host);
  assert.equal(v.state,'unavailable');assert.equal(v.code_session_diagnostic,undefined);assert.equal(x.calls.provider,0);
 }
});
