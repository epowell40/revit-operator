import assert from 'node:assert/strict';
import test from 'node:test';
import {VISUAL_WORK_REVIEW_TOOL,normalizeVisualReviewRequest} from './visual_work_review.mjs';
import {CANONICAL_NATIVE_TASK_GUIDANCE} from './native_task_routing.mjs';

test('local annotation review uses native geometry and one sufficient visual scope, not a compulsory two-image sequence',()=>{
  const text=CANONICAL_NATIVE_TASK_GUIDANCE;
  assert.match(text,/native readback.*bounding box/);
  assert.match(text,/one contextual close-up/);
  assert.match(text,/not a mandatory overview-then-close-up sequence/);
  assert.match(text,/missing or incomplete.*unknown/);
  assert.match(text,/aggregate titleblock bounds do not prove unused paper/);
  assert.match(text,/Final visual review and correction remain required/);
  assert.match(text,/native verification and checkpoint save\/file inspection before handoff/);
});

test('review discovery has a consistent actual-screen first strategy, with native export only for a stated need',()=>{
  const text=VISUAL_WORK_REVIEW_TOOL.description;
  assert.match(text,/Prefer visible_work for an active sheet or drawing/);
  assert.match(text,/native_visible_region only when/);
  assert.match(text,/target_view only when/);
  assert.doesNotMatch(text,/Use target_view for a full-sheet\/inactive overview/);
  assert.match(text,/Do not ask the reviewer to re-prove/);
  assert.match(text,/same suitable image/);
  assert.match(text,/unseen areas remain unverified/);
  assert.match(text,/No automatic capture fallback/);
});

test('scope guidance does not silently change explicit capture requests or authorize underspecified completion',()=>{
  for(const mode of ['visible_work','target_view','native_visible_region']){
    const request=normalizeVisualReviewRequest({view_id:41,capture_mode:mode,checks:[{id:'readability',expected:'Local text is legible'}]});
    assert.equal(request.capture_mode,mode);
  }
  assert.throws(()=>normalizeVisualReviewRequest({view_id:41,capture_mode:'native_proof',checks:[{id:'x',expected:'x'}]}));
  assert.throws(()=>normalizeVisualReviewRequest({view_id:41,focus_element_ids:[10],checks:[{id:'x',expected:'x'}]}));
});

test('model-visible discovery exposes contextual geometry and preserves an already framed view',()=>{
 const tool=VISUAL_WORK_REVIEW_TOOL;
 assert.match(tool.description,/omit focus_element_ids so the host preserves it/);
 assert.match(tool.description,/settles element focus before a separate contextual zoom within this single tool call/);
 for(const k of ['context_bbox_min_xyz','context_bbox_max_xyz']){
  assert.equal(tool.parameters.properties[k].type,'array');assert.equal(tool.parameters.properties[k].minItems,3);assert.equal(tool.parameters.properties[k].maxItems,3);
 }
 const request={view_id:41,capture_mode:'visible_work',complete_inspection_item_id:'inspect',focus_element_ids:[101],context_bbox_min_xyz:[.05,1.5,0],context_bbox_max_xyz:[1.55,2.45,0],checks:[{id:'clear',expected:'The note is readable and clear of nearby plan and border.'}]};
 const normalized=normalizeVisualReviewRequest(request);assert.deepEqual(normalized,request);
 request.context_bbox_min_xyz[0]=99;assert.equal(normalized.context_bbox_min_xyz[0],.05);
});
