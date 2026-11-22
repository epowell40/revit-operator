import test from 'node:test';
import assert from 'node:assert/strict';
import {singleExecutionInstructions} from './desktop_native_tools.mjs';
import {VISUAL_WORK_REVIEW_TOOL,normalizeVisualReviewRequest} from './visual_work_review.mjs';

test('existing partial drawing starts with discrepancy selection without a mandatory pre-edit review',()=>{
  const text=singleExecutionInstructions('Preserve native authorization, Pause and unknown effects.','Current native contracts.','single_actor_review_v1');
  assert.match(text,/existing partial drawing/);
  assert.match(text,/before broad connector, family or type inventories/);
  assert.match(text,/If you cannot identify a clear discrepancy.*area_backcheck/);
  assert.match(text,/not a mandatory pre-edit review/);
  assert.match(text,/explicit connection or system audit still needs its requested scope/);
  assert.match(text,/Preserve native authorization, Pause and unknown effects/);
  assert.match(text,/Keep native readbacks, required independent visual\/code review and save\/file evidence/);
});

test('drawing pixels and in-memory reads are distinguished from UI and independent saved-file proof',()=>{
  const instructions=singleExecutionInstructions('base','catalog','single_actor_review_v1');
  assert.match(instructions,/Reading the same open Document after Save As is not an independent saved-file check/);
  assert.match(instructions,/Do not repeat an unchanged in-memory read just to claim file persistence/);
  assert.match(instructions,/Required independent reopen checks remain required/);
  assert.match(VISUAL_WORK_REVIEW_TOOL.description,/For drawing content, prefer native_visible_region/);
  assert.doesNotMatch(VISUAL_WORK_REVIEW_TOOL.description,/Prefer visible_work for an active sheet or drawing/);
  // This is actor guidance, not an automatic fallback or relaxed capture contract.
  assert.match(VISUAL_WORK_REVIEW_TOOL.description,/No automatic capture fallback/);
  assert.equal(normalizeVisualReviewRequest({view_id:41,checks:[{id:'q',expected:'Legible note'}],capture_mode:'visible_work'}).capture_mode,'visible_work');
  assert.equal(normalizeVisualReviewRequest({view_id:41,checks:[{id:'q',expected:'Legible note'}],capture_mode:'native_visible_region'}).capture_mode,'native_visible_region');
});
