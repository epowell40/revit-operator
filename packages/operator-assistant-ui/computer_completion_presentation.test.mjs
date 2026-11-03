import test from'node:test';import assert from'node:assert/strict';
import{computerCompletionPresentation}from'./computer_completion_presentation.mjs';
const assignment={kernel_version:2,goal_id:'assignment',run_id:'run',generation:1};
const workReturn={assignment_id:'assignment',run_id:'run',generation:1,status:'blocked',deviations_or_open_items:['Q5: Which equipment is intended to serve this area? This is not a proven source-document absence.']};
test('a normal transport return with canonical failure retains bound followups without claiming completion',()=>{
 const settlement={kernel_version:2,work_return:workReturn},before=JSON.stringify(settlement);
 const p=computerCompletionPresentation(settlement,null,assignment);
 assert.equal(p.disposition,'explicit_failure');assert.equal(p.phase,'blocked');
 assert.match(p.retained_failure_message,/Q5: Which equipment/);
 assert.match(p.retained_failure_message,/not verified results or supplied answers/);
 assert.equal(JSON.stringify(settlement),before);
});
test('foreign, missing, active, complete and malformed work returns do not add a stopped report',()=>{
 for(const patch of[{run_id:'other'},{generation:2},{assignment_id:'other'},{status:'active'},{status:'complete'},{deviations_or_open_items:[]}]){
  const p=computerCompletionPresentation({kernel_version:2,work_return:{...workReturn,...patch}},null,assignment);
  assert.equal(p.retained_failure_message,undefined);
 }
 assert.equal(computerCompletionPresentation({kernel_version:2,work_return:workReturn}).retained_failure_message,undefined);
});
