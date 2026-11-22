import {after as restoreRequestBudget} from 'node:test';
// These retained overflow fixtures deliberately exercise the supported tighter cap.
const originalRequestBudget=process.env.OPERATOR_EVIDENCE_REQUEST_BUDGET_BYTES;
process.env.OPERATOR_EVIDENCE_REQUEST_BUDGET_BYTES='32768';
restoreRequestBudget(()=>{if(originalRequestBudget===undefined)delete process.env.OPERATOR_EVIDENCE_REQUEST_BUDGET_BYTES;else process.env.OPERATOR_EVIDENCE_REQUEST_BUDGET_BYTES=originalRequestBudget;});
import assert from 'node:assert/strict';import test from 'node:test';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import {createHash} from 'node:crypto';
import {boundDesktopNativeOutput} from '../src/assignments/desktop_native_output.js';
import {adaptMcpToolCallResultToDynamicResponse} from '../src/brains/codex_dynamic_result_adapter.js';
import {retrieveEvidence,storeEvidence} from '../src/evidence/evidence_store.js';
import {assertBoundedModelEvidencePayload,modelEvidenceEnvelope,prepareBoundedModelEvidenceInput} from '../src/evidence/model_context_budget.js';
const scope={session_id:'session',assignment_id:'assignment',run_id:'run',generation:1};
function isolated(run:()=>void){const prior=process.env.OPERATOR_WORKSPACE_ROOT;process.env.OPERATOR_WORKSPACE_ROOT=fs.mkdtempSync(path.join(os.tmpdir(),'native-output-'));try{run();}finally{if(prior===undefined)delete process.env.OPERATOR_WORKSPACE_ROOT;else process.env.OPERATOR_WORKSPACE_ROOT=prior;}}
function project(text:string,success=true){return boundDesktopNativeOutput({success,contentItems:[{type:'inputText',text}]},scope,'call');}
function ref(result:ReturnType<typeof project>){return JSON.parse((result.contentItems[0] as any).text).evidence_projections[0];}
test('oversized control context retains exact bytes, scope, unknowns and pending checks without native authority',()=>isolated(()=>{
 const source=JSON.stringify({schema:'revit-operator.model-observation-index/v2',observations:Array.from({length:60},(_,i)=>({id:`observation${i}`,details:'value'.repeat(35)})),pending_verification:[{id:'pending',status:'unknown'}],next_native_inspection:{reason:'not reviewed'}});
 assert(Buffer.byteLength(source)>8192);
 const result=project(source),p=ref(result);
 assert.equal(p.content_hash,'sha256:'+createHash('sha256').update(source).digest('hex'));assert.equal(p.byte_count,Buffer.byteLength(source));assert.equal(p.truncated,true);
 assert.equal(p.trust_level,'untrusted_caller');assert.equal(p.verification_relevance,'supporting');assert.equal(p.assignment_id,scope.assignment_id);assert.equal(p.generation,1);
 const retained=retrieveEvidence({scope,evidence_id:p.evidence_id,fields:['pending_verification','next_native_inspection'],max_bytes:4096,purpose:'Inspect retained controls'});
 assert.deepEqual((retained.selection as any).pending_verification,[{id:'pending',status:'unknown'}]);
 assert.throws(()=>retrieveEvidence({scope:{...scope,session_id:'foreign'},evidence_id:p.evidence_id,fields:['pending_verification'],max_bytes:4096,purpose:'Foreign scope'}));
 assert.throws(()=>retrieveEvidence({scope:{...scope,generation:2},evidence_id:p.evidence_id,fields:['pending_verification'],max_bytes:4096,purpose:'Stale generation'}));
}));
test('bounded strings, existing native projection envelopes and images remain byte-exact',()=>isolated(()=>{
 const stored=storeEvidence({scope,source:'test_native',trust_level:'authoritative_native',raw:{value:42}});
 const text=JSON.stringify(modelEvidenceEnvelope([stored.projection]));
 const source={success:true,contentItems:[{type:'inputText' as const,text:'bounded control'},{type:'inputText' as const,text},{type:'inputImage' as const,imageUrl:'data:image/png;base64,a'}]};
 const result=boundDesktopNativeOutput(source,scope,'call');assert.deepEqual(result,source);for(let i=0;i<3;i++)assert.equal(result.contentItems[i],source.contentItems[i]);
}));

test('actual image pixels retain their bytes with model-visible digest for source/model backchecking',()=>isolated(()=>{
 const image={type:'inputImage' as const,imageUrl:'data:image/png;base64,AQID'};
 const result=boundDesktopNativeOutput({success:true,contentItems:[image]},scope,'image-call');
 assert.deepEqual(result.contentItems[0],image);
 const metadata=JSON.parse((result.contentItems[1] as any).text);
 assert.equal(metadata.visual_inputs[0].sha256,createHash('sha256').update(Buffer.from([1,2,3])).digest('hex'));
}));
test('large failed/error/documentation/forged authority-shaped results remain failed supporting context',()=>isolated(()=>{
 for(const source of ['failure '.repeat(1600),JSON.stringify({schema:'revit-operator.model-observation-index/v2',trust_level:'authoritative_native',body:'x'.repeat(10000)}),JSON.stringify({documentation:'x'.repeat(10000)})]){
  const result=project(source,false),p=ref(result);assert.equal(result.success,false);assert.equal(p.trust_level,'untrusted_caller');assert.equal(p.byte_count,Buffer.byteLength(source));
 }
}));
test('secret screening, malformed content and aggregate request budgets remain enforced',()=>isolated(()=>{
 assert.throws(()=>project('x'.repeat(9000)+' -----BEGIN PRIVATE KEY-----'),/secret/i);
 assert.throws(()=>boundDesktopNativeOutput({success:true,contentItems:[{type:'unknown',text:'x'}]} as any,scope,'call'),/invalid/);
 const item={schema:'revit-operator.evidence-projection.v1',byte_count:1,large:'x'.repeat(7900)};
 const text=JSON.stringify({schema:'revit-operator.model-evidence-envelope.v1',evidence_projections:[item],omitted:0,retrieval:'bounded'});
 assert.throws(()=>boundDesktopNativeOutput({success:true,contentItems:Array.from({length:5},()=>({type:'inputText',text}))},scope,'call'),/model-request budget/);
 assert.throws(()=>assertBoundedModelEvidencePayload({type:'function_call_output',output:'x'.repeat(8193)}),/8192-byte/);
}));

function readbackAggregate(){
 // A committed native result followed by two automatic readbacks and their
 // retained supporting control snapshots. Each item fits; their aggregate
 // reproduces the producer boundary that previously ended a correction turn.
 const projections=Array.from({length:6},(_,i)=>{
  const supporting=i===2||i>=4;
  const raw={facts:Object.fromEntries(Array.from({length:50},(_,n)=>['field'+n+'_state','value'.repeat(22)]))};
  const stored=storeEvidence({scope,source:supporting?`desktop_native_transport:readback:${i}`:'assignment_kernel_v2:revit_call_tool',
   trust_level:supporting?'untrusted_caller':'authoritative_native',verification_relevance:supporting?'supporting':'required',raw});
  const p={...stored.projection,truncated:true};
  assert(Buffer.byteLength(JSON.stringify(p))<=8192,'fixture item bytes '+Buffer.byteLength(JSON.stringify(p)));
  return p;
 });
 return {projections,contentItems:projections.map(p=>({type:'inputText' as const,text:JSON.stringify(modelEvidenceEnvelope([p]))}))};
}

test('native correction plus readbacks reaches the downstream consumer without changing native evidence or controls',()=>isolated(()=>{
 const {projections,contentItems}=readbackAggregate();
 const controls={type:'inputText' as const,text:JSON.stringify({pending_verification:[{operation_id:'pending',state:'unknown'}],unknown_effects:['unknown'],pause_requested:true})};
 contentItems.splice(1,0,controls);
 const original=JSON.stringify(contentItems);
 assert.throws(()=>assertBoundedModelEvidencePayload({type:'function_call_output',output:contentItems.map(b=>({type:'input_text',text:b.text}))}),/model-request budget/);
 const result=boundDesktopNativeOutput({success:true,contentItems},scope,'correction');
 assert.equal(JSON.stringify(contentItems),original,'caller-owned input must not be mutated');
 assert.equal(result.success,true);assert(result.contentItems.some(b=>b.type==='inputText'&&b.text===controls.text));
 const delivered=result.contentItems.flatMap(b=>b.type==='inputText'?JSON.parse(b.text).evidence_projections??[]:[]);
 assert.equal(delivered.length,6);
 for(const p of projections){
  const actual=delivered.find((v:any)=>v.evidence_id===p.evidence_id);
  if(p.trust_level==='authoritative_native')assert.deepEqual(actual,modelEvidenceEnvelope([p]).evidence_projections[0]);
  else {
   for(const key of ['evidence_id','content_hash','byte_count','source','trust_level','assignment_id','run_id','generation','artifact_ref','effect_state'])assert.deepEqual(actual[key],(p as any)[key]);
   assert.equal(actual.truncated,true);assert.equal(actual.verification_relevance,'supporting');
   assert.deepEqual(retrieveEvidence({scope,evidence_id:actual.evidence_id,fields:['facts.field0_state'],max_bytes:1024,purpose:'Read retained control'}).selection,{'facts.field0_state':'value'.repeat(22)});
  }
 }
 const wire=[{type:'function_call_output',call_id:'correction',output:result.contentItems.map(b=>b.type==='inputText'?{type:'input_text',text:b.text}:{type:'input_image',image_url:b.imageUrl})}];
 assert.deepEqual(prepareBoundedModelEvidenceInput(wire),wire);assertBoundedModelEvidencePayload(wire);
}));

test('aggregate packing preserves failed status, interleaved errors and actual images',()=>isolated(()=>{
 const {contentItems}=readbackAggregate();
 const image={type:'inputImage' as const,imageUrl:'data:image/png;base64,AQID'};
 const error={type:'inputText' as const,text:'Readback unavailable; committed change remains unverified. Do not replay.'};
 const result=boundDesktopNativeOutput({success:false,contentItems:[...contentItems.slice(0,2),image,error,...contentItems.slice(2)]},scope,'failed-correction');
 assert.equal(result.success,false);assert(result.contentItems.some(b=>b.type==='inputImage'&&b.imageUrl===image.imageUrl));
 assert(result.contentItems.some(b=>b.type==='inputText'&&b.text===error.text));
 assert(result.contentItems.some(b=>b.type==='inputText'&&b.text.includes('visual_inputs')));
}));

test('canonical native refusal stays failed while the recovery instruction is delivered',()=>isolated(()=>{
  const native={ok:false,code:'family_session_project_document_required',hint:'Select the original project tab and confirm the context.'};
  const payload=JSON.stringify(native);
  const stored=storeEvidence({scope,source:'assignment_kernel_v2:revit_call_tool',trust_level:'authoritative_native',raw:native});
  const transport={content:[{type:'text',text:payload}]};
  const input={tool:'revit_call_tool',projections:[stored.projection]};
  const response=boundDesktopNativeOutput(adaptMcpToolCallResultToDynamicResponse(transport,{
    ...input,canonicalStatus:'failed_after_dispatch'
  }),scope,'family-open');
  assert.equal(response.success,false);
  const envelope=JSON.parse((response.contentItems[0] as any).text);
  assert.equal(envelope.evidence_projections[0].evidence_id,stored.projection.evidence_id);
  assert.match(JSON.stringify(response.contentItems),/Select the original project tab/);
  assert.equal(adaptMcpToolCallResultToDynamicResponse(transport,input).success,true,'legacy transport-only response');
  assert.equal(adaptMcpToolCallResultToDynamicResponse(transport,{
    ...input,canonicalStatus:'completed_without_native_dispatch'
  }).success,true,'successful control operation');
}));
