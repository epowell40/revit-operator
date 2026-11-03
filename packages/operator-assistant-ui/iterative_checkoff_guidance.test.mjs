import assert from 'node:assert/strict';
import test from 'node:test';
import {singleExecutionInstructions} from './desktop_native_tools.mjs';
import {VISUAL_WORK_REVIEW_TOOL, normalizeVisualReviewRequest} from './visual_work_review.mjs';

test('assembled owner instructions retain source-addressed drafted and backchecked work without claiming whole-region completion',()=>{
  const text=singleExecutionInstructions('Preserve Pause, unknown effects and required native verification.','Current native tool contracts.');
  assert.match(text,/source page, area and system/i);
  assert.match(text,/drafted.*backchecked/i);
  assert.match(text,/advisory claims remain unverified/i);
  assert.match(text,/unfinished parent.*open/i);
  assert.match(text,/resume.*saved model.*punch list/i);
  assert.match(text,/counts.*not.*coverage/i);
  assert.match(text,/Preserve Pause, unknown effects and required native verification/);
  assert.doesNotMatch(text,/delegate_revit_task/);
});

test('model-visible review contract distinguishes new bounded work from historical rechecks and binds source comparisons',()=>{
  const text=VISUAL_WORK_REVIEW_TOOL.description;
  assert.match(text,/completed batch.*unfinished/i);
  assert.match(text,/fresh scoped review.*prior.*open/i);
  assert.match(text,/reference_attachment_read.*source/i);
  assert.match(text,/do not rewrite checks to obtain a match/);
  assert.match(text,/not.*whole-task completion proof/);
});

test('completed batch may have a fresh check but cannot replace historical checks or fabricate a source receipt',()=>{
  const checks=[{id:'labels',expected:'The completed branch labels are legible and clear of adjacent equipment.'}];
  const request={view_id:41,capture_mode:'visible_work',checks};
  assert.deepEqual(normalizeVisualReviewRequest(request).checks,checks);
  assert.throws(()=>normalizeVisualReviewRequest({...request,recheck_evidence_id:'ev1_broad_review'}));
  assert.throws(()=>normalizeVisualReviewRequest({...request,reference_attachment_read:{call_id:'',page:1}}));
  assert.deepEqual(normalizeVisualReviewRequest({view_id:41,recheck_evidence_id:'ev1_broad_review'}),{view_id:41,recheck_evidence_id:'ev1_broad_review'});
});
