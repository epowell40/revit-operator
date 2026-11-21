import test from 'node:test';
import assert from 'node:assert/strict';
import {retainedDraftingProgressContinuation} from '../work_report.mjs';

const assignment={kernel_version:2,session_id:'session',goal_id:'assignment',run_id:'run',generation:1};
const ready=calls=>({status:'retained',execution_continuation:{
  schema:'operator.execution-continuation.v1',binding:{session_id:'session',assignment_id:'assignment',run_id:'run',generation:1},
  state:'ready',construction_progress:{calls_since_construction:calls,since:'2026-11-20T20:00:00Z',warn_after:8,stop_after:12}
}});

test('successful tool work receives published pacing without a second hard call budget',()=>{
  const tracker={};
  assert.equal(retainedDraftingProgressContinuation(assignment,ready(7),tracker),null);
  assert.match(retainedDraftingProgressContinuation(assignment,ready(8),tracker).content[0].text,/another ready branch/);
  assert.equal(retainedDraftingProgressContinuation(assignment,ready(9),tracker),null);
  assert.match(retainedDraftingProgressContinuation(assignment,ready(12),tracker).content[0].text,/exact blocker/);
  assert.equal(retainedDraftingProgressContinuation(assignment,ready(24),tracker),null);
  assert.match(retainedDraftingProgressContinuation(assignment,ready(24),{}).content[0].text,/exact blocker/);
  const configured=ready(4);configured.execution_continuation.construction_progress.warn_after=4;
  configured.execution_continuation.construction_progress.stop_after=6;
  assert(retainedDraftingProgressContinuation(assignment,configured,{}));
  configured.execution_continuation.construction_progress.calls_since_construction=6;
  assert.match(retainedDraftingProgressContinuation(assignment,configured,{}).content[0].text,/exact blocker/);
});

test('holds and foreign or malformed progress cannot be turned into execution advice',()=>{
  for(const reason of ['paused','unsettled_model_effect','pending_usage','input_or_review_pending','budget_exhausted']){
    const held=ready(24);held.execution_continuation.state='hold';held.execution_continuation.reason=reason;
    assert.equal(retainedDraftingProgressContinuation(assignment,held,{}),null);
  }
  const foreign=ready(8);foreign.execution_continuation.binding.run_id='foreign';
  assert.throws(()=>retainedDraftingProgressContinuation(assignment,foreign,{}),/binding_mismatch/);
  const malformed=ready(-1);
  assert.throws(()=>retainedDraftingProgressContinuation(assignment,malformed,{}),/progress_invalid/);
  for(const thresholds of [{warn_after:undefined},{stop_after:8},{stop_after:NaN},{warn_after:0}]){
    const bad=ready(8);Object.assign(bad.execution_continuation.construction_progress,thresholds);
    assert.throws(()=>retainedDraftingProgressContinuation(assignment,bad,{}),/progress_invalid/);
  }
});

test('fresh canonical construction opens another work window while replay cannot reset it',()=>{
  const tracker={};
  retainedDraftingProgressContinuation(assignment,ready(8),tracker);
  const fresh=ready(0);fresh.execution_continuation.construction_progress.since='2026-11-20T20:02:00Z';
  assert.equal(retainedDraftingProgressContinuation(assignment,fresh,tracker),null);
  fresh.execution_continuation.construction_progress.calls_since_construction=8;
  assert(retainedDraftingProgressContinuation(assignment,fresh,tracker));
  assert.equal(retainedDraftingProgressContinuation(assignment,fresh,tracker),null);
});
