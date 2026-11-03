import test from 'node:test';import assert from 'node:assert/strict';
import * as presentation from './stopped_work_return.mjs';
const assignment={kernel_version:2,goal_id:'a',run_id:'r',generation:1,session_id:'s'};
function fixture(){const work_return={assignment_id:'a',run_id:'r',generation:1,status:'complete',deviations_or_open_items:[],work_return_id:'wr1_a',work_return_hash:'sha256:'+'a'.repeat(64)};
 return {kernel_version:2,work_return,terminal_result_presentation:{work_return_id:work_return.work_return_id,work_return_hash:work_return.work_return_hash,
  binding:{assignment_id:'a',run_id:'r',generation:1,session_id:'s'},terminal_result_v2:{schema:'revit-operator.terminal-result/v2',assignment_id:'a',outcome:'complete',terminal_snapshot_version:12,
  result_summary:'Verified Number width: 1.125 inches.\nVerified file: C:\\workspace\\models\\Result.rvt',supporting_observation_ids:['o'],evidence_refs:['evidence:ev1_a'],warnings:[]}}};}
test('complete result uses existing bound native canonical presentation without a model paraphrase',()=>{
 assert.equal(presentation.canonicalWorkReturnResultMessage(fixture(),assignment),fixture().terminal_result_presentation.terminal_result_v2.result_summary);
 assert.equal(presentation.stoppedWorkReturnResultMessage(fixture(),assignment),null);
});
for(const [name,change] of Object.entries({foreign:f=>f.terminal_result_presentation.binding.run_id='foreign',stale:f=>f.terminal_result_presentation.work_return_hash='old',
 active:f=>{f.work_return.status='active';f.terminal_result_presentation.terminal_result_v2.outcome='active';},unknown:f=>f.work_return.status='unknown',
 missing:f=>delete f.terminal_result_presentation,wrongOutcome:f=>f.terminal_result_presentation.terminal_result_v2.outcome='failed'}))
 test('canonical success presentation excludes '+name,()=>{const f=fixture();change(f);assert.equal(presentation.canonicalWorkReturnResultMessage(f,assignment),null);});
