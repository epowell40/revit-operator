import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {buildNativeCodeReviewPacket,reviewExecutedCode,parseNativeCodeReview,NATIVE_CODE_REVIEW_INSTRUCTIONS,nativeCodeReviewModelOutput} from './native_code_review.mjs';
import {normalizeVisualReviewRequest,VISUAL_WORK_REVIEW_TOOL} from './visual_work_review.mjs';
const digest=s=>'sha256:'+createHash('sha256').update(s).digest('hex');
function fixture(){
  const owner={assignment_id:'assignment',session_id:'session',run_id:'run',generation:1,principal_id:'principal',document_fingerprint:'a'.repeat(64)};
  const source='using Autodesk.Revit.DB;\r\npublic static class Draft { public static string Execute(Document d) { return "done"; }}';
  const ref={schema:'revit-operator.evidence-ref.v1',evidence_id:'ev1_'+'A'.repeat(32),content_hash:digest('evidence'),source:'assignment_kernel_v2:operator_run_dynamic_revit_program',
    trust_level:'authoritative_native',secret_screening_status:'passed',...owner};
  const native={schema:'dynamic-revit-native-execution-receipt/v1',source_hash:digest(source.replaceAll('\r\n','\n')),document_fingerprint:'sha256:'+owner.document_fingerprint,
    document_session_id:'native-session',document_revision_before:3,verified:false,retry_permitted:false,read_only:false,success:true,
    transaction:{status:'committed',committed:true,affected_element_ids:Array.from({length:120},(_,i)=>i+1),modified_element_ids:Array.from({length:120},(_,i)=>i+1),added_element_ids:[],deleted_element_ids:[]},program_result:'done',error:null};
  const row={call_id:'call_write',recorded_at:'2026-10-31T15:00:00Z',tool_name:'native__invoke',arguments:{tool:'operator_run_dynamic_revit_program',arguments:{source,mode:'apply',native_program:{effect_scope:'active_document'}}},
    result:{content:[{type:'inputText',text:JSON.stringify({schema:'revit-operator.model-evidence-envelope.v1',evidence_projections:[ref]})}]}};
  const selection={'payload.schema':'revit-operator.dynamic-revit-program-run.v1','payload.execution_lane':'native','payload.requested_mode':'apply','payload.execution_status':'completed',
    'payload.iteration.source_sha256':native.source_hash,'payload.evidence.nativeExecutionReceipt':JSON.stringify(native)};
  const response=()=>({ok:true,result:{schema:'revit-operator.evidence-retrieval.v1',evidence_ref:ref,selection,complete:false,missing_fields:[],selection_origins:Object.fromEntries(Object.keys(selection).map(k=>[k,'payload'])),returned_bytes:Buffer.byteLength(JSON.stringify(selection))}});
  const calls=[];const host={owner:()=>owner,assertControl:async()=>{},receipts:()=>[row],request:async(route,options)=>{calls.push({route,body:JSON.parse(options.body)});return response();}};
  return {owner,source,ref,native,row,selection,response,host,calls,sync:()=>{selection['payload.evidence.nativeExecutionReceipt']=JSON.stringify(native);}};
}
test('exact normalized source and native audit retained without predicting 120 dependents',async()=>{
  const f=fixture(),p=await buildNativeCodeReviewPacket(['ev1_'+'A'.repeat(32)],f.host);
  assert.equal(p.executions[0].source,f.source.replaceAll('\r\n','\n'));assert.equal(p.executions[0].transaction.modified_element_ids.length,120);
  assert.equal(p.native_postcondition_verified,false);assert.equal(p.coverage.all_assignment_calls,false);assert.equal(p.coverage.predicted_dependents_required,false);
  assert.equal(f.calls[0].route,'/evidence/retrieve');assert.deepEqual(f.calls[0].body.scope,{assignment_id:'assignment',session_id:'session',run_id:'run',generation:1});
});

test('direct primary native C# tool has the same strict code-audit contract as its invoke alias',async()=>{
 for(const mode of ['apply','read']){
  const f=fixture();f.row.tool_name='native__operator_run_dynamic_revit_program';f.row.arguments={...f.row.arguments.arguments,mode};
  if(mode==='read'){f.native.read_only=true;f.native.transaction={status:'not_started',committed:false,affected_element_ids:[],added_element_ids:[],modified_element_ids:[],deleted_element_ids:[]};f.selection['payload.requested_mode']='read';f.sync();}
  const p=await buildNativeCodeReviewPacket([f.ref.evidence_id],f.host);
  assert.equal(p.executions[0].mode,mode);assert.equal(p.executions[0].source_sha256,f.native.source_hash);assert.equal(p.coverage.journal_native_calls,1);
  assert.equal(p.native_postcondition_verified,false);assert.equal(p.whole_task_verified,false);
 }
});

test('a direct code-tool name never excuses a foreign source, digest or unknown outcome',async()=>{
 for(const fault of ['name','digest','unknown','foreign']){
  const f=fixture();f.row.tool_name='native__operator_run_dynamic_revit_program';f.row.arguments=f.row.arguments.arguments;
  if(fault==='name')f.row.tool_name+='-foreign';if(fault==='digest')f.row.arguments.source+='// changed';
  if(fault==='unknown'){f.native.transaction.status='unknown';f.sync();}if(fault==='foreign')f.ref.run_id='foreign';
  await assert.rejects(buildNativeCodeReviewPacket([f.ref.evidence_id],f.host));
 }
});

test('a sparse desktop owner obtains document and principal only from same-bound canonical host identity',async()=>{
  const f=fixture(),local={...f.owner,principal_id:null,document_fingerprint:null};let reads=0;
  f.host.owner=()=>local;
  f.host.readCanonicalOwner=async expected=>{reads++;assert.deepEqual(expected,local);return {...f.owner};};
  const packet=await buildNativeCodeReviewPacket([f.ref.evidence_id],f.host);
  assert.equal(reads,1);assert.deepEqual(packet.owner,f.owner);
  assert.equal(packet.executions[0].source_sha256,f.native.source_hash);
});

test('canonical review identity never replaces conflicting local identity or changes control',async()=>{
  for(const key of ['assignment_id','session_id','run_id','generation','principal_id','document_fingerprint']){
    const f=fixture(),local={...f.owner};f.host.owner=()=>local;
    f.host.readCanonicalOwner=async()=>({...f.owner,[key]:key==='generation'?2:'foreign'});
    await assert.rejects(buildNativeCodeReviewPacket([f.ref.evidence_id],f.host),/canonical_owner_mismatch/);
    assert.equal(f.calls.length,0);
  }
  for(const change of ['pause','owner']){
    const f=fixture(),local={...f.owner,principal_id:null,document_fingerprint:null};f.host.owner=()=>local;
    f.host.readCanonicalOwner=async()=>{if(change==='pause')f.host.assertControl=async()=>{throw Error('paused');};else local.run_id='foreign';return {...f.owner};};
    await assert.rejects(buildNativeCodeReviewPacket([f.ref.evidence_id],f.host),/paused|owner_changed/);
    assert.equal(f.calls.length,0);
  }
});
test('source substitution, wrong document, untrusted/foreign ref and missing raw fields never reach review',async()=>{
  for(const change of [f=>f.row.arguments.arguments.source+=' unrelated',f=>{f.native.source_hash=digest('other');f.sync();},f=>{f.native.document_fingerprint='sha256:'+'b'.repeat(64);f.sync();},
    f=>f.ref.trust_level='untrusted_caller',f=>f.ref.session_id='foreign',f=>delete f.selection['payload.iteration.source_sha256'],f=>f.host.request=async()=>({ok:false})]){
    const f=fixture();change(f);await assert.rejects(buildNativeCodeReviewPacket(['ev1_'+'A'.repeat(32)],f.host));
  }
});
test('unknown effects and malformed committed audit cannot acquire a settled code-review packet',async()=>{
  for(const change of [n=>{n.transaction.status='unknown';n.transaction.committed=null;},n=>n.transaction.committed=false,n=>n.transaction.modified_element_ids=[0],n=>n.transaction.affected_element_ids=[1,1],n=>n.program_result={}]){
    const f=fixture();change(f.native);f.sync();await assert.rejects(buildNativeCodeReviewPacket(['ev1_'+'A'.repeat(32)],f.host));
  }
});
test('rollback remains a failed attempt, read remains read-only observation',async()=>{
  const f=fixture();f.native.success=false;f.selection['payload.execution_status']='failed';f.native.error='failed';f.native.transaction={status:'rolled_back',committed:false,affected_element_ids:[1],modified_element_ids:[],added_element_ids:[],deleted_element_ids:[]};f.sync();
  assert.equal((await buildNativeCodeReviewPacket(['ev1_'+'A'.repeat(32)],f.host)).executions[0].execution_success,false);
  f.row.arguments.arguments.mode='read';f.selection['payload.requested_mode']='read';f.native.success=true;f.selection['payload.execution_status']='completed';f.native.read_only=true;f.native.transaction.status='not_started';f.native.transaction.affected_element_ids=[];f.sync();
  assert.equal((await buildNativeCodeReviewPacket(['ev1_'+'A'.repeat(32)],f.host)).executions[0].mode,'read');
});
test('missing/duplicate host calls, change of owner and Pause refuse without mutation',async()=>{
  for(const setup of [f=>f.host.receipts=()=>[],f=>f.host.receipts=()=>[f.row,f.row],f=>f.host.assertControl=async()=>{throw Error('paused');},
    f=>f.host.request=async()=>{f.owner.generation++;return f.response();}]){
    const f=fixture();setup(f);await assert.rejects(buildNativeCodeReviewPacket(['ev1_'+'A'.repeat(32)],f.host));
  }
});
test('reviewer sees original task/code/actual outcome in one tool-free request with no screenshot',async()=>{
  const f=fixture(),requests=[];
  const h={...f.host,codeReviewPacket:ids=>buildNativeCodeReviewPacket(ids,f.host),userRequest:()=> 'Draft the requested ducts.',settings:()=>({model:'approved-model',reasoning_effort:'medium'}),
    requestResponse:async body=>{requests.push(body);return {id:'resp_code',status:'completed',output:[],output_text:JSON.stringify({code_review:{status:'uncertain',observed:'Code returns done but creates nothing.',correction:'Inspect requested duct creation.'}})};}};
  const r=await reviewExecutedCode({review_mode:'code_execution',code_evidence_ids:['ev1_'+'A'.repeat(32)]},h);
  assert.equal(requests.length,1);assert.equal(requests[0].context_role,'independent_review');assert.deepEqual(requests[0].tools,[]);assert.equal(requests[0].input[0].content.length,1);
  assert.equal(JSON.parse(requests[0].input[0].content[0].text).executed_code.executions[0].source,f.source.replaceAll('\r\n','\n'));
  assert.equal(r.state,'uncertain');assert.equal(r.whole_task_verified,false);assert.equal(r.native_postcondition_verified,false);
  assert.match(NATIVE_CODE_REVIEW_INSTRUCTIONS,/Do not predict every Revit dependent change/);
  const out=JSON.parse(nativeCodeReviewModelOutput({output:JSON.stringify({schema:'revit-operator.model-evidence-envelope.v1',evidence_projections:[{evidence_id:'ev1_review',content_hash:digest('review')}]})},r,'ev1_review').output).evidence_projections[0].native_code_review;assert.equal(out.code_review.status,'uncertain');assert.equal(out.raw_review_evidence,undefined);
});
test('reviewer tool calls and task direction changes cannot become accepted assessment',async()=>{
  for(const kind of ['tool','changed','pause','refusal']){
    const f=fixture();let direction='Draft ducts';const h={...f.host,codeReviewPacket:ids=>buildNativeCodeReviewPacket(ids,f.host),userRequest:()=>direction,settings:()=>({model:'approved',reasoning_effort:'medium'}),
      requestResponse:async()=>{if(kind==='changed')direction='Stop';if(kind==='pause')h.assertControl=async()=>{throw Error('paused');};return {id:'r',status:'completed',output:kind==='tool'?[{type:'function_call'}]:kind==='refusal'?[{type:'message',content:[{type:'refusal'}]}]:[],output_text:JSON.stringify({code_review:{status:'matched',observed:'Within scope',correction:''}})};}};
    assert.equal((await reviewExecutedCode({review_mode:'code_execution',code_evidence_ids:['ev1_'+'A'.repeat(32)]},h)).state,'unavailable');
  }
});
test('review schema accepts only explicit assessment, never a native proof or an unspecified verdict',()=>{
  for(const v of [{status:'pass',observed:'ok',correction:''},{status:'matched',observed:'ok',correction:'',verified:true},{status:'mismatch',observed:'wrong',correction:''}])assert.throws(()=>parseNativeCodeReview(v));
});
test('existing review tool exposes code-only and combined visual-code options',()=>{
  assert.deepEqual(normalizeVisualReviewRequest({view_id:41,checks:[{id:'c',expected:'Duct layout readable'}],code_evidence_ids:['ev1_'+'A'.repeat(32)]}).code_evidence_ids,['ev1_'+'A'.repeat(32)]);
  assert.match(VISUAL_WORK_REVIEW_TOOL.description,/code_execution/);
});
