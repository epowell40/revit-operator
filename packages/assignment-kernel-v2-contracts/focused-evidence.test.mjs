import test from 'node:test';
import assert from 'node:assert/strict';
import {FOCUSED_EVIDENCE_TOOL_V1,retrieveFocusedEvidenceV1,focusedEvidenceFailureOutputV1} from './focused-evidence.js';

test('field text range reaches the existing evidence route with bounded truthful pagination',async()=>{
 const input={evidenceId:args.evidenceId,purpose:'Read the next part of an existing C# result',textRange:{path:'native_outcome.program_result',start:0,length:64},maxBytes:64};
 const r=response('first returned text');r.result.evidence_ref.byte_count=72652;delete r.result.missing_fields;delete r.result.selection_origins;
 r.result.text_pagination={path:input.textRange.path,start:0,requested_length:64,returned_utf8_bytes:19,total_utf8_bytes:12610,next_start:19,has_more:true,field_complete:false,byte_limited:true};
 const out=await retrieveFocusedEvidenceV1(()=>binding,input,async(p,o)=>{assert.equal(p,'/evidence/retrieve');const body=JSON.parse(o.body);assert.deepEqual(body.text_range,input.textRange);assert.equal(body.max_bytes,64);return r;});
 assert.equal(out.model_output.result.selection,'first returned text');assert.equal(out.model_output.result.complete,false);assert.equal(out.model_output.whole_task_verified,false);
});

test('field text consumer rejects malformed selectors and dishonest pagination without weakening old selectors',async()=>{
 const input={evidenceId:args.evidenceId,purpose:'Read retained text',textRange:{path:'native_outcome.program_result',start:0,length:64},maxBytes:64};
 const valid=()=>{const r=response('text');r.result.evidence_ref.byte_count=72652;r.result.text_pagination={path:input.textRange.path,start:0,requested_length:64,returned_utf8_bytes:4,total_utf8_bytes:12610,next_start:4,has_more:true,field_complete:false,byte_limited:true};return r;};
 for(const mutate of [r=>delete r.result.text_pagination,r=>r.result.complete=true,r=>r.result.text_pagination.path='foreign',r=>r.result.text_pagination.start=2,r=>r.result.text_pagination.next_start=0,r=>r.result.text_pagination.total_utf8_bytes=90000,r=>r.result.text_pagination.returned_utf8_bytes=3,r=>r.result.text_pagination.field_complete=true,r=>r.result.text_pagination.has_more=false,r=>r.result.text_pagination.byte_limited=false]){const r=valid();mutate(r);await assert.rejects(retrieveFocusedEvidenceV1(()=>binding,input,async()=>r),/text_pagination/);}
 for(const field of ['',null,42,'bad\npath'])await assert.rejects(retrieveFocusedEvidenceV1(()=>binding,{...input,textRange:{...input.textRange,path:field}},async()=>{throw Error('Malformed range must not reach transport');}),/text_range.path/);
 const foreign=valid();foreign.result.evidence_ref.assignment_id='another';await assert.rejects(retrieveFocusedEvidenceV1(()=>binding,input,async()=>foreign),/response_invalid/);
 await assert.rejects(retrieveFocusedEvidenceV1(()=>binding,{...input,textRange:{start:0,length:64}},async()=>valid()),/unexpected_text_pagination/);
});

test('bounded focused read failures stay fully visible without accepting success, foreign calls or oversized content',()=>{
 const call={name:'operator_retrieve_evidence',call_id:'read'};
 const error='Retained shape hints: '+ 'results[0].connectors:array, '.repeat(30);
 const output={type:'function_call_output',call_id:'read',output:JSON.stringify({ok:false,error,recoverable:true})};
 const sent=focusedEvidenceFailureOutputV1(call,output), parsed=JSON.parse(sent.output);
 assert.equal(parsed.error,error);assert.equal(parsed.whole_task_verified,false);assert.equal(parsed.native_postcondition_verified,false);
 for(const [c,o]of [[{...call,name:'other'},output],[{...call,call_id:'foreign'},output],
  [call,{...output,output:JSON.stringify({ok:true,error,recoverable:true})}],
  [call,{...output,output:JSON.stringify({ok:false,error:'x'.repeat(5000),recoverable:true})}],
  [call,{...output,output:JSON.stringify({ok:false,error,recoverable:true,extra:'unreviewed'})}]])
  assert.equal(focusedEvidenceFailureOutputV1(c,o),null);
});

const binding={assignment_id:'assignment',session_id:'session',run_id:'run',generation:1,principal_id:'owner',document_fingerprint:'model'};
const args={evidenceId:'ev1_'+'a'.repeat(32),purpose:'Read the complete retained helper handoff.',fields:['assistant_message']};
const message='Subtask report; not completion. '+('retained finding '.repeat(22))+' Exact scoped tags: 1201,1202. Family: Equipment Tag. Next: create a separate underlined variant; do not save RVT.';
test('owner scalar selection keeps current binding, original source index and partial authority',async()=>{
 const input={evidenceId:args.evidenceId,purpose:'Rank retained candidate lengths',itemRange:{path:'items',start:0,count:1,fields:['id','length'],filters:[{field:'diameter',op:'eq',value:0.5}],orderBy:{field:'length',direction:'desc'}}};
 const r=response([{row_index:7,values:{id:1201,length:5},missing_fields:[]}]);
 r.result.pagination={path:'items',start:0,requested_count:1,returned_count:1,total_items:40,has_more:false,next_start:null,byte_limited:false,requested_rows_complete:true,source_rows_exhausted:false,fields:['id','length'],row_projection:'selected_fields',selection_query:{cursor_basis:'selected_rank',source_total_items:40,matched_total_items:1,scanned_retained_rows:40,retained_scan_complete:true,non_comparable_filter_rows:0,unavailable_numeric_order_rows:0,filters:input.itemRange.filters,orderBy:input.itemRange.orderBy,selected_rows_exhausted:true}};
 const out=await retrieveFocusedEvidenceV1(()=>binding,input,async(_p,o)=>{const body=JSON.parse(o.body);assert.deepEqual(body.scope,{assignment_id:'assignment',session_id:'session',run_id:'run',generation:1});assert.deepEqual(body.item_range,input.itemRange);return r;});
 assert.equal(out.model_output.result.selection[0].row_index,7);assert.equal(out.model_output.result.complete,false);assert.equal(out.model_output.native_postcondition_verified,false);assert.equal(out.model_output.whole_task_verified,false);
 await assert.rejects(retrieveFocusedEvidenceV1(()=>binding,{...input,itemRange:{...input.itemRange,fields:undefined}},async()=>r),/fields/);
});
function response(selection={assistant_message:message}) {
  return {ok:true,result:{schema:'revit-operator.evidence-retrieval.v1',evidence_ref:{
    schema:'revit-operator.evidence-ref.v1',evidence_id:args.evidenceId,content_hash:'sha256:'+'b'.repeat(64),byte_count:12000,
    media_type:'application/json',source:'operator_desktop.function.delegate_revit_task',trust_level:'untrusted_caller',
    ...binding,attempt_id:null,secret_screening_status:'passed',redaction_status:'screened',verification_relevance:'required',target_scope:[]},
    selection,returned_bytes:Buffer.byteLength(JSON.stringify(selection)),complete:false,missing_fields:[],selection_origins:{assistant_message:'payload'}}};
}

test('owner sees byte-recovery guidance and can explicitly retry without changing scope or authority',async()=>{
  assert.match(FOCUSED_EVIDENCE_TOOL_V1.description,/JSON-encoded UTF-8/);
  const request={evidenceId:args.evidenceId,purpose:'Read retained tool documentation',textRange:{start:0,length:4000}};
  const refusal='Focused evidence selection exceeds 4096-byte limit (4143 JSON-encoded UTF-8 bytes). Retry the same evidence at the same start with recommended length: 2000.';
  let calls=0;
  const transport=async(_url,options)=>{
    calls++;const body=JSON.parse(options.body);
    assert.deepEqual(body.scope,{assignment_id:'assignment',session_id:'session',run_id:'run',generation:1});
    assert.equal(body.max_bytes,4096);
    return body.text_range.length===4000?{error:refusal}:response('x'.repeat(2000));
  };
  await assert.rejects(retrieveFocusedEvidenceV1(()=>binding,request,transport),e=>e.message===refusal);
  assert.equal(calls,1,'The host does not silently retry or spend another model call.');
  const recovered=await retrieveFocusedEvidenceV1(()=>binding,{...request,textRange:{start:0,length:2000}},transport);
  assert.equal(calls,2);assert.equal(recovered.model_output.result.selection.length,2000);
  assert.equal(recovered.model_output.result.complete,false);
  assert.equal(recovered.model_output.native_postcondition_verified,false);
  assert.equal(recovered.model_output.whole_task_verified,false);
});

test('focused tool reads a whole named field beyond its diagnostic prefix without granting result authority',async()=>{
  assert.equal(FOCUSED_EVIDENCE_TOOL_V1.name,'operator_retrieve_evidence');
  assert.equal(FOCUSED_EVIDENCE_TOOL_V1.strict,false);
  assert.equal(FOCUSED_EVIDENCE_TOOL_V1.parameters.additionalProperties,false);
  assert(!Object.hasOwn(FOCUSED_EVIDENCE_TOOL_V1.parameters.properties,'scope'));
  let calls=0;
  const owner={...binding,kernel_version:2,goal_id:binding.assignment_id};
  const before=JSON.stringify({owner,args});
  const out=await retrieveFocusedEvidenceV1(()=>owner,args,async(route,options)=>{
    calls++;assert.equal(route,'/evidence/retrieve');
    const request=JSON.parse(options.body);assert.equal(options.method,'POST');
    assert.deepEqual(request.scope,{assignment_id:'assignment',session_id:'session',run_id:'run',generation:1});
    assert.equal(request.evidence_id,args.evidenceId);assert.deepEqual(request.fields,['assistant_message']);
    assert.equal(request.max_bytes,4096);return response();
  });
  assert.equal(calls,1);assert.equal(out.model_output.result.selection.assistant_message,message);
  assert.match(out.model_output.result.selection.assistant_message,/1201,1202/);
  assert.equal(out.model_output.native_postcondition_verified,false);assert.equal(out.model_output.whole_task_verified,false);
  assert.equal(out.model_output.result.complete,false,'Artifact-wide completeness is not silently promoted.');
  assert.equal(out.model_output.source_identity.trust_level,'untrusted_caller');
  assert(Buffer.byteLength(JSON.stringify(out.model_output))<=8192);
  assert.equal(JSON.stringify({owner,args}),before);
});

test('caller cannot supply scope or combine selectors; rejected requests never reach storage',async()=>{
  for(const patch of [
    {scope:{session_id:'foreign'}},{assignmentId:'foreign'},{sessionId:'foreign'},{runId:'foreign'},{generation:2},
    {itemRange:{path:'none',start:0,count:1,fields:['none']},textRange:{start:0,length:1},targetSubset:['none']},
    {fields:[]},{fields:['assistant_message'],textRange:{start:0,length:20}},{fields:undefined},
    {evidenceId:'file:C:/secret'},{purpose:'all evidence'},{maxBytes:4097},{image:true},
    {itemRange:{path:'rows',start:-1,count:1},fields:undefined}
  ]) {
    let calls=0;const input={...args,...patch};if(input.fields===undefined)delete input.fields;
    await assert.rejects(retrieveFocusedEvidenceV1(()=>binding,input,async()=>{calls++;return response();}));
    assert.equal(calls,0);
  }
  for(const owner of [null,{...binding,generation:0},{...binding,session_id:''},{...binding,kernel_version:1},{...binding,goal_id:'other'}]){
    let calls=0;await assert.rejects(retrieveFocusedEvidenceV1(()=>owner,args,async()=>{calls++;return response();}));assert.equal(calls,0);
  }
});

test('late responses, foreign evidence and unbounded or malformed selections fail closed',async()=>{
  for(const change of [
    (r)=>r.result.evidence_ref.session_id='foreign',
    (r)=>r.result.evidence_ref.assignment_id='foreign',
    (r)=>r.result.evidence_ref.run_id='foreign',
    (r)=>r.result.evidence_ref.generation=2,
    (r)=>r.result.evidence_ref.evidence_id='ev1_'+'c'.repeat(32),
    (r)=>r.result.evidence_ref.secret_screening_status='failed',
    (r)=>r.result.returned_bytes++,
    (r)=>r.result.complete='true',
    (r)=>r.result.selection.assistant_message='z'.repeat(8192)
  ]){const r=response();change(r);await assert.rejects(retrieveFocusedEvidenceV1(()=>binding,args,async()=>r));}
  let owner={...binding};
  await assert.rejects(retrieveFocusedEvidenceV1(()=>owner,args,async()=>{owner.run_id='new-run';return response();}),/binding_changed/);
  await assert.rejects(retrieveFocusedEvidenceV1(()=>binding,args,async()=>({ok:false,error:'Evidence is outside scope.'})),/outside scope/);
});

test('pages, missing fields and byte ranges retain their exact selection and coverage',async()=>{
  const cases=[
    {input:{itemRange:{path:'rows',start:2,count:1,fields:['id']}},body:{item_range:{path:'rows',start:2,count:1,fields:['id']}},
      selection:[{row_index:2,values:{id:1201},missing_fields:[]}],metadata:{pagination:{path:'rows',start:2,requested_count:1,returned_count:1,total_items:9,has_more:true,next_start:3,requested_rows_complete:false,source_rows_exhausted:false,byte_limited:false}}},
    {input:{textRange:{start:201,length:50}},body:{text_range:{start:201,length:50}},selection:'Exact retained text after the prefix.',metadata:{}},
    {input:{targetSubset:['element_id:1201']},body:{target_subset:['element_id:1201']},selection:[{element_id:1201}],metadata:{}},
    {input:{fields:['absent']},body:{fields:['absent']},selection:{absent:null},metadata:{missing_fields:['absent'],selection_origins:{absent:'payload'}}}
  ];
  for(const c of cases){const r=response(c.selection);Object.assign(r.result,c.metadata);
    const out=await retrieveFocusedEvidenceV1(()=>binding,{evidenceId:args.evidenceId,purpose:args.purpose,...c.input},async(_p,o)=>{
      const body=JSON.parse(o.body);for(const [k,v]of Object.entries(c.body))assert.deepEqual(body[k],v);return r;});
    assert.deepEqual(out.model_output.result.selection,c.selection);for(const [k,v]of Object.entries(c.metadata))assert.deepEqual(out.model_output.result[k],v);
  }
});
