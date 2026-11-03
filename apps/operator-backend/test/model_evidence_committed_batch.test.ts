import fs from 'node:fs';import path from 'node:path';import assert from 'node:assert/strict';import test from 'node:test';
import{prepareBoundedModelEvidenceInput as prepare,assertBoundedModelEvidencePayload as validate}from'../src/evidence/model_context_budget.js';
const fixture=()=>JSON.parse(fs.readFileSync(path.resolve('test/fixtures/committed-native-batch384.json'),'utf8'));
test('actual committed six-call batch retains all calls and native effect custody within request cap',()=>{
 const input=fixture(),original=structuredClone(input);assert.throws(()=>validate(input),/32768-byte/);
 const output:any=prepare(input);assert(validate(output).projected_bytes<=32768);assert.deepEqual(input,original);
 assert.deepEqual(output.map((r:any)=>r.call_id),input.map((r:any)=>r.call_id));
 for(let i=0;i<input.length;i++){
  const before=JSON.parse(input[i].output[0].text).evidence_projections[0],after=JSON.parse(output[i].output[0].text).evidence_projections[0];
  for(const key of ['evidence_id','artifact_ref','content_hash','byte_count','source','trust_level','effect_state','assignment_id','run_id','attempt_id','generation','target_scope','before_hash','after_hash','retrieval','key_counts','key_facts'])assert.deepEqual(after[key],before[key],key);
  if(after.inline_payload!==before.inline_payload&&JSON.stringify(after.inline_payload)!==JSON.stringify(before.inline_payload)){
   assert.equal(after.truncated,true);assert.equal(after.additional_evidence,true);
   for(const key of ['status','success','dryRun','transaction','changeTracking','applied','transactionGroupRolledBack','rollbackVerified','nativeFailures','capturedFailures','failureRollbackRequested','nextAction'])assert.deepEqual(after.inline_payload[key],before.inline_payload[key],key);
   assert.match(after.diagnostics.at(-1),/batch_budget.*details.*not.*verification/i);
  }
 }
 assert.strictEqual(prepare(output),output);
});
test('legacy in-cap bytes and all raw source records remain exact',()=>{
 const input=fixture().slice(0,1);assert.strictEqual(prepare(input),input);
 const full=fixture(),raw=JSON.stringify(full);prepare(full);assert.equal(JSON.stringify(full),raw);
});
for(const change of [
 {effect_state:'unknown'},{effect_state:'none'},{trust_level:'untrusted_caller'},
 {source:'foreign'},{content_hash:'bad'},{artifact_ref:'ev1_other'},{attempt_id:null},{generation:0},
 {retrieval:null},{verification_relevance:'supporting'}
])test('ineligible native facts are not elided: '+JSON.stringify(change),()=>{
 const input=fixture();for(const row of input){const e=JSON.parse(row.output[0].text);Object.assign(e.evidence_projections[0],change);row.output[0].text=JSON.stringify(e);}
 assert.throws(()=>prepare(input),/32768-byte/);
});
for(const [key,value]of Object.entries({success:false,applied:false,dryRun:true,transactionGroupRolledBack:true,failureRollbackRequested:true,
 nativeFailures:[{message:'Unresolved native failure'}],capturedFailures:[{message:'Uncertain result'}]}))test('failed or uncertain native result stays exact: '+key,()=>{
 const input=fixture();for(const row of input){const e=JSON.parse(row.output[0].text);e.evidence_projections[0].inline_payload[key]=value;row.output[0].text=JSON.stringify(e);}assert.throws(()=>prepare(input),/32768-byte/);
});
test('unsupported connector fields cannot silently lose controls',()=>{
 const input=fixture();for(const row of input){const e=JSON.parse(row.output[0].text);e.evidence_projections[0].inline_payload.terminalConnector.pending_verification=['keep'];row.output[0].text=JSON.stringify(e);}assert.throws(()=>prepare(input),/32768-byte/);
});
test('every image, current control and native footprint survives bounded presentation',()=>{
 const input=fixture();input[0].output.push({type:'input_image',image_url:'data:image/png;base64,AAAA',detail:'original'});
 input[1].output.push({type:'input_text',text:'{"unknown_effect":true,"pending_usage":1,"paused":true}'});
 input.push({role:'user',content:'Current Pause/unknown state remains authoritative.'});
 const e=JSON.parse(input[0].output[0].text);e.evidence_projections[0].inline_payload.unrecognized_control={pending:['keep'],state:'unreviewed'};input[0].output[0].text=JSON.stringify(e);
 const out:any=prepare(input);validate(out);assert.deepEqual(out[0].output[2],input[0].output[2]);assert.deepEqual(out[1].output[2],input[1].output[2]);assert.deepEqual(out.at(-1),input.at(-1));
 assert.deepEqual(JSON.parse(out[0].output[0].text).evidence_projections[0].inline_payload.unrecognized_control,{pending:['keep'],state:'unreviewed'});
});
test('irreducible metadata is refused without larger limits or dropped calls',()=>{
 const input=fixture();for(const row of input){const e=JSON.parse(row.output[0].text);e.evidence_projections[0].inline_payload.required_control='x'.repeat(1800);row.output[0].text=JSON.stringify(e);}assert.throws(()=>prepare(input));
});
