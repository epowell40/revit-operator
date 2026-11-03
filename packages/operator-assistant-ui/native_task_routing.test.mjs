import assert from 'node:assert/strict';
import test from 'node:test';
import {requireTrackedNativeTask,CANONICAL_NATIVE_TASK_GUIDANCE} from './native_task_routing.mjs';
import {missingWorkReportContinuation} from './work_report.mjs';
const binding={kernel_version:2,session_id:'session',goal_id:'task',run_id:'run',generation:2};

test('owner keeps corrective readonly work distinct from uncertain action retries',()=>{
 assert.match(CANONICAL_NATIVE_TASK_GUIDANCE,/correct a rejected read-only request/);
 assert.match(CANONICAL_NATIVE_TASK_GUIDANCE,/Do not retry the unchanged invalid request/);
 assert.match(CANONICAL_NATIVE_TASK_GUIDANCE,/unknown effects, uncertain mutations, required-input stops or explicit user stops/);
 assert.match(CANONICAL_NATIVE_TASK_GUIDANCE,/not a reason to ask permission again/);
 assert.match(CANONICAL_NATIVE_TASK_GUIDANCE,/actual collateral.*preservation obligations/);
});

test('spatial readiness keeps rendered context before placement without promoting aggregate bounds to clearance',()=>{
 assert.match(CANONICAL_NATIVE_TASK_GUIDANCE,/rendered.{0,90}before committing/);assert.match(CANONICAL_NATIVE_TASK_GUIDANCE,/aggregate titleblock bounds do not prove unused paper/);
 assert.match(CANONICAL_NATIVE_TASK_GUIDANCE,/Final visual review and correction remain required/);assert.doesNotMatch(CANONICAL_NATIVE_TASK_GUIDANCE,/1420963|0\.9,0\.25|2\.75,0\.65/);
});
test('checkpoint handoff uses the supported tracked save for later edits to the same authorized result',async()=>{
 let text='';
 await assert.rejects(requireTrackedNativeTask(binding,async()=>({ok:true,verification_policy:'strict'}),'run_dynamic_revit_program'),error=>{text=error.message;return true;});
 assert.match(text,/POST \/revit\/save-as/);
 assert.match(text,/same authorized result path/);
 assert.match(text,/overwrite=true/);
 assert.match(text,/only after new committed edits/);
 assert.match(text,/never the original input or an unrelated existing file/);
 assert.match(text,/not a retry of an uncertain save/);
 assert.match(text,/native verification and checkpoint save\/file inspection before handoff/);
 assert.match(text,/visual review pending/);
 assert.match(text,/explicit user review-before-save/);
});
test('missing family content gives the desktop owner a bounded acquisition route rather than another native discovery loop',()=>{
 assert.match(CANONICAL_NATIVE_TASK_GUIDANCE,/family-content prerequisite/);
 assert.match(CANONICAL_NATIVE_TASK_GUIDANCE,/Load Autodesk Family/);
 assert.match(CANONICAL_NATIVE_TASK_GUIDANCE,/Family Editor/);
 assert.match(CANONICAL_NATIVE_TASK_GUIDANCE,/same-category/);
 assert.match(CANONICAL_NATIVE_TASK_GUIDANCE,/associative labels/);
 assert.match(CANONICAL_NATIVE_TASK_GUIDANCE,/not an engineering question/);
 assert.match(CANONICAL_NATIVE_TASK_GUIDANCE,/one bounded content path/);
 assert.match(CANONICAL_NATIVE_TASK_GUIDANCE,/native loading remains workspace-scoped/);
});
test('retained current-project failure gets an executable canonical path, not another unsupported report loop',async()=>{
 const next=await missingWorkReportContinuation(binding,async()=>({ok:true,verification_policy:'strict',outcome:'active'}),0);
 assert.equal(next.kind,'continue');
 const text=next.input.content[0].text;
 assert.match(text,/delegate_revit_task/);
 assert.match(text,/including simple model\/view questions and PDF exports/);
 assert.match(text,/Strict tasks cannot use report_work_for_review/);
 assert.match(text,/never repeat an existing or uncertain/);
 await assert.rejects(missingWorkReportContinuation(binding,async()=>({ok:true,verification_policy:'strict',outcome:'active'}),2),/task_outcome_required/);
});
test('strict native work redirects before dispatch, retaining the exact saved binding and original objective guidance',async()=>{
 for(const tool of ['export_revit_sheets_pdf','run_dynamic_revit_program']){
  let requests=0;
  await assert.rejects(requireTrackedNativeTask(binding,async(path,options)=>{
   requests++;assert.equal(path,'/api/assignments/v2/work-plan');
   assert.deepEqual(JSON.parse(options.body),{action:'status',session_id:'session',assignment_id:'task',run_id:'run',generation:2});
   return {ok:true,verification_policy:'strict'};
  },tool),/canonical_native_task_required: no native work was started.*delegate_revit_task/);
  assert.equal(requests,1);
 }
 assert.match(CANONICAL_NATIVE_TASK_GUIDANCE,/never repeat an existing or uncertain/);
 assert.match(CANONICAL_NATIVE_TASK_GUIDANCE,/computer use available/);
});
test('advisory helpers, non-task controls and unbound legacy helpers keep their existing admission paths',async()=>{
 await requireTrackedNativeTask(binding,async()=>({ok:true,verification_policy:'advisory'}),'export_revit_sheets_pdf');
 const noStatus=()=>{throw Error('unexpected status call');};
 for(const tool of ['inspect_revit_context','review_current_work','activate_revit_view'])await requireTrackedNativeTask(binding,noStatus,tool);
 await requireTrackedNativeTask(null,noStatus,'export_revit_sheets_pdf');
 await requireTrackedNativeTask({...binding,kernel_version:1},noStatus,'export_revit_sheets_pdf');
});
test('missing policy, failed status and invalid bindings never start an untracked native task',async()=>{
 for(const state of [{ok:false},{ok:true},{ok:true,verification_policy:'unknown'}])
  await assert.rejects(requireTrackedNativeTask(binding,async()=>state,'export_revit_sheets_pdf'),/native_task_status_unavailable/);
 await assert.rejects(requireTrackedNativeTask({...binding,generation:0},async()=>{throw Error('must not request');},'export_revit_sheets_pdf'),/native_task_current_binding_required/);
});
