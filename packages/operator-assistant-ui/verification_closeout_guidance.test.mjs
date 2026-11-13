import test from 'node:test';
import assert from 'node:assert/strict';
import {missingWorkReportContinuation} from './work_report.mjs';
import {singleExecutionInstructions} from './desktop_native_tools.mjs';
import {CANONICAL_NATIVE_TASK_GUIDANCE} from './native_task_routing.mjs';

const binding={kernel_version:2,session_id:'session',goal_id:'task',run_id:'run',generation:1};
test('strict closeout in the unified actor uses exposed tools rather than an absent delegate',async()=>{
 let requests=0;
 const result=await missingWorkReportContinuation(binding,async()=>{requests++;return {ok:true,verification_policy:'strict',outcome:'active'};},0,{}, {unifiedNative:true});
 const text=result.input.content[0].text;
 assert.doesNotMatch(text,/delegate_revit_task|inspect_revit_context/);
 assert.match(text,/operator_evaluate_assignment_criteria/);
 assert.match(text,/operator_manage_work_plan/);
 assert.match(text,/not.*user clarification/i);
 assert.equal(requests,1);
 assert.equal(result.kind,'continue');
});
test('legacy closeout and bounded stopping remain unchanged',async()=>{
 const request=async()=>({ok:true,verification_policy:'strict',outcome:'active'});
 assert.match((await missingWorkReportContinuation(binding,request)).input.content[0].text,/delegate_revit_task/);
 await assert.rejects(missingWorkReportContinuation(binding,request,2,{}, {unifiedNative:true}),/task_outcome_required/);
 for(const outcome of ['paused','blocked','awaiting_user_input','complete'])
  assert.equal(await missingWorkReportContinuation(binding,async()=>({ok:true,verification_policy:'strict',outcome}),0,{}, {unifiedNative:true}),null);
});
test('assembled owner instructions avoid before-image ceremony for an existing fixed-position property edit',()=>{
 const text=singleExecutionInstructions(CANONICAL_NATIVE_TASK_GUIDANCE,'Current native tool contracts.');
 assert.match(text,/fixed-position text or property edit/);
 assert.match(text,/Do not activate.*before-image.*solely/);
 assert.match(text,/one post-edit contextual image/);
 assert.match(text,/Never undo.*verification.*incomplete/);
 assert.match(text,/unknown effects.*reconcil/i);
 assert.match(text,/Final visual review and correction remain required/);
});
