import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {visualWorkReviewModelOutput} from './visual_work_review.mjs';
const fixture=JSON.parse(fs.readFileSync(new URL('./fixtures/visual-review-changed-frame-61.json',import.meta.url),'utf8'));
const project=(result=structuredClone(fixture.result),modelOutput=fixture.modelOutput)=>{
 const out=visualWorkReviewModelOutput(modelOutput,result,fixture.evidenceId);
 return {out,projection:JSON.parse(out.output).evidence_projections[0]};
};
test('retained changed-image refusal fits without exposing the full rendering inventory',()=>{
 const before=JSON.stringify(fixture),{out,projection}=project(),f=projection.visual_work_review;
 assert(Buffer.byteLength(out.output)<=8192);
 assert.equal(f.state,'unavailable');assert.equal(f.ok,false);
 assert.equal(f.reason_code,'visual_review_visible_frame_changed_during_review');
 assert.equal(f.native_postcondition_verified,false);assert.equal(f.whole_task_verified,false);assert.equal(f.recheck_evidence_id,null);
 for(const key of ['evidence_id','content_hash','byte_count'])assert.equal(f.changed_capture[key],fixture.result.changed_capture[key]);
 const {sheet_render_state,...frame}=fixture.result.changed_capture.frame;
 assert.deepEqual(f.changed_capture.frame,frame);
 assert.equal(f.retrieval.changed_capture_frame_path,'changed_capture.frame');
 assert.equal(f.changed_capture.frame_complete,false);
 assert.deepEqual(f.changed_capture.omitted_frame_fields,['sheet_render_state']);
 assert.equal(projection.content_hash,JSON.parse(fixture.modelOutput.output).evidence_projections[0].content_hash);
 const old=JSON.parse(fixture.modelOutput.output).evidence_projections[0];
 for(const key of ['evidence_id','content_hash','byte_count','source','trust_level','target_scope','verification_relevance','session_id','assignment_id','run_id','generation'])assert.deepEqual(projection[key],old[key],key);
 assert.equal(JSON.stringify(fixture),before);
});
test('omitting render inventory cannot turn empty, foreign or changed guard data into a pass',()=>{
 for(const guard of [null,{}, {state:'unavailable'}, {viewId:999,views:[]}, {state:'available',unknown:'x'.repeat(10000)}]){
  const r=structuredClone(fixture.result);r.changed_capture.frame.sheet_render_state=guard;
  const before=JSON.stringify(r),{projection}=project(r),f=projection.visual_work_review;
  assert.equal(f.state,'unavailable');assert.equal(f.ok,false);assert.equal(f.native_postcondition_verified,false);assert.equal(f.whole_task_verified,false);
  assert.equal(f.recheck_evidence_id,null);assert.equal(f.changed_capture.frame_complete,false);
  assert.equal(JSON.stringify(r),before);
 }
});
test('absent render inventory preserves the existing changed-frame fields and exact captures',()=>{
 const r=structuredClone(fixture.result);delete r.changed_capture.frame.sheet_render_state;
 const {projection}=project(r),f=projection.visual_work_review;
 assert.deepEqual(f.changed_capture.frame,r.changed_capture.frame);
 assert.equal(f.changed_capture.frame_complete,undefined);assert.equal(f.changed_capture.omitted_frame_fields,undefined);
 assert.equal(f.capture.content_hash,r.capture.content_hash);assert.equal(f.changed_capture.content_hash,r.changed_capture.content_hash);
 assert.notEqual(f.capture.content_hash,f.changed_capture.content_hash);
});
test('no changed capture and all existing control/refusal states stay unverified',()=>{
 for(const reason of ['Paused','visual_review_scene_changed_during_review','visual_review_native_scene_unavailable','unknown_effect']){
  const r=structuredClone(fixture.result);r.reason=reason;r.changed_capture=null;
  const {projection}=project(r),f=projection.visual_work_review;
  assert.equal(f.state,'unavailable');assert.equal(f.ok,false);assert.equal(f.recheck_evidence_id,null);assert.equal(f.changed_capture,null);assert.equal(f.reason_summary,reason);
 }
});
test('unknown large frame fields and unrelated envelope data still fail closed',()=>{
 const r=structuredClone(fixture.result);r.changed_capture.frame.unknown_control='x'.repeat(10000);
 assert.throws(()=>project(r),/projection_budget_exceeded/);
 const envelope=JSON.parse(fixture.modelOutput.output);envelope.unknown_control='x'.repeat(10000);
 assert.throws(()=>project(fixture.result,{output:JSON.stringify(envelope)}),/projection_budget_exceeded/);
});
test('foreign or absent artifact binding is still rejected',()=>{
 const envelope=JSON.parse(fixture.modelOutput.output);envelope.evidence_projections[0].evidence_id='foreign';
 assert.throws(()=>project(fixture.result,{output:JSON.stringify(envelope)}),/artifact_binding_missing/);
});
