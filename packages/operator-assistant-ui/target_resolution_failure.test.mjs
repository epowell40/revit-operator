import test from 'node:test';
import assert from 'node:assert/strict';
import {unresolvedSheetTarget,executionFailureMessage} from './target_resolution_failure.mjs';
const assignment={kernel_version:2,goal_id:'task',run_id:'run',generation:1,session_id:'session'};
const settlement={kernel_version:2,work_return:{assignment_id:'task',run_id:'run',generation:1,status:'failed',deviations_or_open_items:['Runtime stopped; completion not verified.']}};

test('lookup detail survives canonical failure without asserting absence or completion',()=>{
 const before=JSON.stringify(settlement);
 const message=executionFailureMessage(unresolvedSheetTarget('M9999'),settlement,assignment,'runtime failed');
 assert.match(message,/M9999/);assert.match(message,/sheet-rename step did not run/);
 assert.match(message,/does not establish.*absent/);assert.match(message,/completion not verified/);
 assert.equal(JSON.stringify(settlement),before);
});
test('foreign canonical return, copied errors and arbitrary provider text cannot acquire lookup authority',()=>{
 const error=unresolvedSheetTarget('M9999');
 assert.doesNotMatch(executionFailureMessage(new Error(error.message),settlement,assignment,error.message),/step did not run/);
 assert.doesNotMatch(executionFailureMessage(error,settlement,{...assignment,run_id:'foreign'},error.message),/Runtime stopped/);
 assert.equal(executionFailureMessage(new Error('transport'),null,assignment,'transport'),'Run failed: transport');
 assert.doesNotMatch(executionFailureMessage({message:error.message},settlement,assignment,'runtime'),/step did not run/);
});
test('diagnostic reference is bounded and does not alter other retained work',()=>{
 const message=executionFailureMessage(unresolvedSheetTarget('X\n'+ 'a'.repeat(500)),null,assignment,'runtime');
 assert(message.length<350);assert.doesNotMatch(message,/X\n/);
 assert.match(message,/lookup failure/);
});

test('draft findings appear before the expandable failure details',()=>{
 const draft='Unverified draft findings from this run. The attachment reports 275 CFM.';
 const message=executionFailureMessage(new Error('missing outcome'),settlement,assignment,'missing outcome',draft);
 assert(message.indexOf(draft)>=0 && message.indexOf(draft)<message.indexOf('## Details'));
 assert.match(message,/completion not verified/);
 assert.equal(settlement.work_return.status,'failed');
});
