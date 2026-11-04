import test from 'node:test';import assert from 'node:assert/strict';import {createHash}from'node:crypto';
import * as api from './native_code_review.mjs';
const hash=s=>'sha256:'+createHash('sha256').update(s).digest('hex');
function fixture(source='using Autodesk.Revit.DB;\r\npublic static class Draft { public static string Execute(Document d) { return d.Title; } }'){
 const owner={assignment_id:'assignment',session_id:'session',run_id:'run',generation:1,principal_id:'principal',document_fingerprint:'a'.repeat(64)};
 const ref={schema:'revit-operator.evidence-ref.v1',...owner,evidence_id:'ev1_'+'A'.repeat(32),content_hash:hash('native evidence'),source:'assignment_kernel_v2:operator_run_dynamic_revit_program',trust_level:'authoritative_native',secret_screening_status:'passed'};
 const native={schema:'dynamic-revit-native-execution-receipt/v1',source_hash:hash(source.replaceAll('\r\n','\n')),document_fingerprint:'sha256:'+owner.document_fingerprint,document_session_id:'old-native-session',document_revision_before:3,verified:false,retry_permitted:false,read_only:true,success:true,transaction:{status:'not_started',committed:false,affected_element_ids:[],added_element_ids:[],modified_element_ids:[],deleted_element_ids:[]},program_result:'A title',error:null};
 const row={call_id:'original-call',tool_name:'native__operator_run_dynamic_revit_program',recorded_at:'2026-11-04T12:00:00Z',arguments:{source,mode:'read',native_program:{effect_scope:'active_document'}},result:{content:[{type:'inputText',text:JSON.stringify({schema:'revit-operator.model-evidence-envelope.v1',evidence_projections:[ref]})}]}};
 const fields={'payload.schema':'revit-operator.dynamic-revit-program-run.v1','payload.execution_lane':'native','payload.requested_mode':'read','payload.execution_status':'completed','payload.iteration.source_sha256':native.source_hash,'payload.evidence.nativeExecutionReceipt':JSON.stringify(native)};
 const calls={reads:0,provider:0,native:0,canonical:0}, packetHost={owner:()=>owner,assertControl:async()=>{},receipts:()=>[row],request:async(route)=>{calls.reads++;assert.equal(route,'/evidence/retrieve');return{ok:true,result:{schema:'revit-operator.evidence-retrieval.v1',evidence_ref:ref,selection:fields,returned_bytes:Buffer.byteLength(JSON.stringify(fields)),missing_fields:[],selection_origins:Object.fromEntries(Object.keys(fields).map(k=>[k,'payload']))}};}};
 const host={owner:()=>owner,assertControl:async()=>{},codeReviewPacket:ids=>api.buildNativeCodeReviewPacket(ids,packetHost),requestResponse:async()=>{calls.provider++;throw Error('No provider call allowed');},capture:async()=>{calls.native++;throw Error('No native operation allowed');}};
 return{owner,source,ref,native,row,fields,calls,host,packetHost,args:{evidence_id:ref.evidence_id}};
}
test('source recovery reads exact own normalized code without a provider, native operation or verdict',async()=>{
 const f=fixture();assert.equal(typeof api.readExecutedCode,'function');const r=await api.readExecutedCode(f.args,f.host);
 assert.equal(r.state,'read');assert.equal(r.source_text,f.source.replaceAll('\r\n','\n'));assert.equal(r.source_sha256,f.native.source_hash);assert.equal(r.range.complete_source,true);assert.equal(r.range.next_start,null);assert.equal(r.historical_document_session_id,'old-native-session');
 assert.equal(r.native_postcondition_verified,false);assert.equal(r.whole_task_verified,false);assert.equal(r.retry_authorized,false);assert.deepEqual(f.calls,{reads:1,provider:0,native:0,canonical:0});
});
test('source recovery pages large code with exact indices and bounded encoded output',async()=>{
 const f=fixture(('// unicode \u2603 😀\r\n').repeat(900));let start=0,joined='',n=0;
 do{const r=await api.readExecutedCode({...f.args,start,length:4000},f.host);assert.equal(r.state,'read');assert.equal(r.range.start,start);assert(Buffer.byteLength(JSON.stringify(r))<=8192);assert.equal(r.source_text,f.source.replaceAll('\r\n','\n').slice(start,r.range.end));joined+=r.source_text;n++;if(r.range.next_start===null)break;assert(r.range.next_start>start);start=r.range.next_start;}while(n<100);
 assert.equal(joined,f.source.replaceAll('\r\n','\n'));assert(n>1);assert.equal(f.calls.provider,0);
});
test('source recovery stays model-visible through retained evidence projection',async()=>{
 const f=fixture(),r=await api.readExecutedCode(f.args,f.host),projection={evidence_id:'ev1_source_read',inline_payload:'discarded generic summary',key_facts:{a:1}},output={type:'function_call_output',call_id:'read',output:JSON.stringify({schema:'revit-operator.model-evidence-envelope.v1',evidence_projections:[projection]})};
 const sent=api.nativeCodeSourceModelOutput(output,r,'ev1_source_read'),p=JSON.parse(sent.output).evidence_projections[0];assert.equal(p.native_code_source.source_text,r.source_text);assert.equal(p.inline_payload,undefined);assert.equal(p.native_code_source.native_postcondition_verified,false);assert(Buffer.byteLength(sent.output)<=8192);
});
test('source recovery refuses unknown fields, caller source, bad IDs and invalid ranges before retrieval',async()=>{
 for(const change of [{source:'injected'},{start:-1},{start:1.5},{length:0},{length:4001},{evidence_id:'not-evidence'},{source_range:{start:0}}]){const f=fixture();await assert.rejects(api.readExecutedCode({...f.args,...change},f.host),/source_request_invalid/);assert.equal(f.calls.reads,0);}
});
test('source recovery preserves source digest, foreign evidence and unknown effect refusals',async()=>{
 for(const fault of ['digest','foreign','unknown','untrusted','missing','pause']){const f=fixture();
  if(fault==='digest')f.row.arguments.source+='foreign';if(fault==='foreign')f.ref.run_id='another';if(fault==='untrusted')f.ref.trust_level='untrusted_caller';if(fault==='missing')f.packetHost.receipts=()=>[];
  if(fault==='unknown'){f.native.transaction.status='unknown';f.fields['payload.evidence.nativeExecutionReceipt']=JSON.stringify(f.native);}if(fault==='pause')f.host.assertControl=async()=>{throw Error('paused');};
  const r=await api.readExecutedCode(f.args,f.host);assert.equal(r.state,'unavailable',fault);assert.equal(r.source_text,undefined,fault);assert.equal(f.calls.provider,0,fault);assert.equal(f.calls.native,0,fault);
 }
});
test('source recovery rejects a late owner switch after retained code read',async()=>{
 const f=fixture(),read=f.host.codeReviewPacket;f.host.codeReviewPacket=async ids=>{const p=await read(ids);f.owner.run_id='new-run';return p;};const r=await api.readExecutedCode(f.args,f.host);assert.equal(r.state,'unavailable');assert.equal(r.source_text,undefined);assert.equal(f.calls.provider,0);
});
test('source recovery uses existing canonical custody after local receipts disappear',async()=>{
 const f=fixture();f.packetHost.receipts=()=>[];f.packetHost.canonicalReceipts=async()=>{f.calls.canonical++;return[{...f.row,call_id:'canonical-operation',canonical_operation_id:'canonical-operation'}];};const r=await api.readExecutedCode(f.args,f.host);assert.equal(r.state,'read');assert.equal(r.operation_id,'canonical-operation');assert.equal(r.source_sha256,f.native.source_hash);assert.equal(f.calls.canonical,1);
});
test('source reader catalog is bounded and does not ask the primary for code or a new model',()=>{
 const t=api.NATIVE_CODE_SOURCE_TOOL;assert.equal(t.name,'read_executed_code');assert.equal(t.parameters.additionalProperties,false);assert.deepEqual(t.parameters.required,['evidence_id']);assert.equal(t.parameters.properties.length.maximum,4000);assert.equal(t.parameters.properties.source,undefined);
});
test('source recovery refuses a zero-progress surrogate slice and a start inside a pair',async()=>{
 const f=fixture('😀 Execute');for(const args of [{...f.args,length:1},{...f.args,start:1}]){const r=await api.readExecutedCode(args,f.host);assert.equal(r.state,'unavailable');assert.match(r.reason,/source_range/);assert.equal(r.source_text,undefined);}
});
test('source from a failed rolled-back execution stays a failed historical attempt',async()=>{
 const f=fixture();f.row.arguments.mode='apply';f.native.read_only=false;f.native.success=false;f.native.transaction.status='rolled_back';f.fields['payload.requested_mode']='apply';f.fields['payload.execution_status']='failed';f.fields['payload.evidence.nativeExecutionReceipt']=JSON.stringify(f.native);
 const r=await api.readExecutedCode(f.args,f.host);assert.equal(r.state,'read');assert.equal(r.historical_execution_success,false);assert.equal(r.historical_transaction_state,'rolled_back');assert.equal(r.retry_authorized,false);assert.equal(r.native_postcondition_verified,false);
});
