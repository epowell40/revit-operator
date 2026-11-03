import fs from 'node:fs';import path from 'node:path';import assert from 'node:assert/strict';import test from 'node:test';
import {prepareBoundedModelEvidenceInput as prepare,assertBoundedModelEvidencePayload as validate} from '../src/evidence/model_context_budget.js';
const fixture=()=>JSON.parse(fs.readFileSync(path.resolve('test/fixtures/native-sheet-read-batch-60.json'),'utf8'));
const decode=(r:any)=>JSON.parse(r.output[0].text);
test('actual fourteen native reads fit with exact sheet/view associations and raw evidence, no calls lost',()=>{
 const a=fixture(),before=structuredClone(a);assert.throws(()=>validate(a),/32768-byte/);
 const b:any=prepare(a);assert.deepEqual(a,before);const usage=validate(b);assert(usage.projected_bytes<32768);assert.equal(b.length,14);
 for(let i=0;i<a.length;i++){
  assert.equal(b[i].call_id,a[i].call_id);assert.deepEqual(b[i].output.slice(1),a[i].output.slice(1));
  const x=decode(a[i]).evidence_projections[0],y=decode(b[i]).evidence_projections[0];
  for(const key of ['evidence_id','artifact_ref','content_hash','byte_count','assignment_id','run_id','attempt_id','generation','target_scope','source','trust_level','effect_state','before_hash','after_hash','verification_relevance','retrieval'])assert.deepEqual(y[key],x[key],key);
  if(x.inline_payload.action==='detail'){
   assert(y.inline_payload,'No whole-sheet blackout that forces all thirteen reads again');
   for(const key of ['sheetElementId','sheetNumber','sheetName','placedViews','viewportCount','placedViewCount','placedScheduleCount','titleBlockCount'])assert.deepEqual(y.inline_payload[key],x.inline_payload[key]);
   assert.equal(y.truncated,true);assert.match(y.diagnostics.join(' '),/partial.*geometry.*not.*proof/i);
  }else assert.deepEqual(b[i],a[i]);
 }
 assert.strictEqual(prepare(b),b);
});
test('batch core compaction preserves canonical controls, foreign and unexpected scalar summaries',()=>{
 const a=fixture();const e=decode(a[0]);e.evidence_projections[0].key_facts.pending_verification='keep';e.evidence_projections[0].key_facts.status='Paused';e.evidence_projections[0].key_counts.pending_usage=1;e.evidence_projections[0].key_counts['placedViews.length']=99;a[0].output[0].text=JSON.stringify(e);
 a[0].output.push({type:'input_image',image_url:'data:image/png;base64,AAAA'});a.push({role:'user',content:'Pause; unknown and pending work remain.'});
 const b:any=prepare(a);assert.equal(decode(b[0]).evidence_projections[0].key_facts.pending_verification,'keep');assert.equal(decode(b[0]).evidence_projections[0].key_facts.status,'Paused');assert.equal(decode(b[0]).evidence_projections[0].key_counts.pending_usage,1);assert.equal(decode(b[0]).evidence_projections[0].key_counts['placedViews.length'],99);assert.deepEqual(b[0].output.at(-1),a[0].output.at(-1));assert.deepEqual(b.at(-1),a.at(-1));
});
for(const change of [{effect_state:'unknown'},{effect_state:'applied'},{source:'foreign'},{before_hash:'sha256:'+'a'.repeat(64)},{content_hash:'bad'},{artifact_ref:'wrong'}])test('ineligible batch remains refused: '+JSON.stringify(change),()=>{
 const a=fixture();for(const row of a){const e=decode(row);Object.assign(e.evidence_projections[0],change);row.output[0].text=JSON.stringify(e);}assert.throws(()=>prepare(a),/32768-byte/);
});
test('in-cap bytes and malformed item failures unchanged; metadata floor never raises request limit',()=>{
 const a=fixture().slice(0,1);assert.strictEqual(prepare(a),a);
 assert.throws(()=>prepare([{type:'function_call_output',call_id:'bad',output:'x'.repeat(9000)}]),/8192-byte/);
 const b=fixture();for(const row of b){const e=decode(row);e.evidence_projections[0].key_facts.unrelated_preserved_control='x'.repeat(700);row.output[0].text=JSON.stringify(e);}assert.throws(()=>prepare(b),/32768-byte/);
});
