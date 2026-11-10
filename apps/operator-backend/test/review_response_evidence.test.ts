import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';
import {assertEvidenceStoreInputSafe} from '../src/evidence/evidence_store.js';
import {assertBoundedModelEvidencePayload} from '../src/evidence/model_context_budget.js';

const ui=[path.resolve('../packages/operator-assistant-ui'),path.resolve('../../packages/operator-assistant-ui')]
  .find(p=>fs.existsSync(path.join(p,'review_response_evidence.mjs')));assert(ui);
const {reviewResponseEvidence}=await import(pathToFileURL(path.join(ui,'review_response_evidence.mjs')).href);
const opaque='gAAAA'+ 'a'.repeat(80)+'-sk-'+ 'b'.repeat(32)+'_tail';
const response=():any=>({id:'resp_review',status:'completed',output:[{type:'reasoning',id:'rs_test',summary:[],encrypted_content:opaque},{type:'message',role:'assistant',content:[{type:'output_text',text:'The connection is visible.'}]}],output_text:'The connection is visible.'});
const screen=(raw:unknown)=>assertEvidenceStoreInputSafe({scope:{session_id:'test'},source:'review_test',trust_level:'untrusted_caller',media_type:'application/json',raw});
test('review producer references opaque transport fields through strict evidence consumer without mutating provider continuation',()=>{
 const r=response(),before=JSON.stringify(r);assert.throws(()=>screen(r),/secret screening/);
 const projected=reviewResponseEvidence(r);assert.doesNotThrow(()=>screen(projected));assert.equal(JSON.stringify(r),before);
 assert.equal(projected.output_text,r.output_text);const ref=projected.output[0].encrypted_content_ref;
 assert.equal(ref.authority,'opaque_transport_only');assert.equal(ref.response_id,r.id);
 assert.equal(ref.response_sha256,'sha256:'+createHash('sha256').update(before).digest('hex'));
 assert.equal(ref.sha256,'sha256:'+createHash('sha256').update(opaque).digest('hex'));
 assert.equal(ref.utf8_bytes,Buffer.byteLength(opaque));assert.equal(ref.json_pointer,'/output/0/encrypted_content');
});
test('readable credentials in review text, reasoning summaries, metadata and unknown fields still reject',()=>{
 const mutations:((r:any)=>void)[]=[r=>r.output[1].content[0].text=opaque,r=>r.output[0].summary=[{type:'summary_text',text:opaque}],r=>r.metadata={text:opaque},r=>r.unknown={encrypted_content:opaque},r=>r.output.push({type:'unknown',encrypted_content:opaque})];
 for(const mutate of mutations){const r=response();mutate(r);assert.throws(()=>screen(reviewResponseEvidence(r)),/secret screening/);}
});
test('malformed and unsupported opaque field shapes remain visible to the strict guard',()=>{
 const mutations:((r:any)=>void)[]=[r=>r.id='unknown',r=>r.output[0].type='unknown',r=>r.output[0].encrypted_content={text:opaque},r=>r.output[0].encrypted_content='readable '+opaque,r=>r.output[0].encrypted_content_ref={unexpected:true}];
 for(const mutate of mutations){const r=response();mutate(r);assert.throws(()=>screen(reviewResponseEvidence(r)),/secret screening/);}
});
test('ordinary reviews, absent responses and provider usage metadata are preserved',()=>{
 const r=response();delete r.output[0].encrypted_content;r.usage={input_tokens:12,output_tokens:3};
 assert.deepEqual(reviewResponseEvidence(r),r);assert.equal(reviewResponseEvidence(null),null);
 const other=response();other.usage=r.usage;assert.deepEqual(reviewResponseEvidence(other).usage,r.usage);
});
test('compact model-visible review keeps the envelope recognized by unchanged evidence byte accounting',async()=>{
 const {visualWorkReviewModelOutput}=await import(pathToFileURL(path.join(ui!,'visual_work_review.mjs')).href);
 const result={schema:'operator.visual_work_review.v1',ok:true,state:'matched',request:{},checks:[{id:'visible',expected:'Connection visible',status:'matched',observed:'Connection visible',correction:''}],guidance:'Supporting observation only.'};
 for(const count of [1,2]){
  const projections=Array.from({length:count},(_,i)=>({schema:'revit-operator.evidence-projection.v1',evidence_id:'ev1_'+i,byte_count:100,media_type:'application/json'}));
  const wire={type:'function_call_output',call_id:'call_review',output:JSON.stringify({schema:'revit-operator.model-evidence-envelope.v1',evidence_projections:projections,omitted:0,retrieval:'Retrieve original evidence.'})};
  const presented=visualWorkReviewModelOutput(wire,result,'ev1_0'),usage=assertBoundedModelEvidencePayload([presented]);
  assert.equal(usage.projection_count,count);assert(usage.projected_bytes>0);
  const envelope=JSON.parse(presented.output);assert.equal(typeof envelope.retrieval,'string');
  assert.equal(envelope.evidence_projections[0].visual_work_review.whole_task_verified,false);
  if(count===2)assert.equal(envelope.retrieval,'Retrieve original evidence.');
 }
});
