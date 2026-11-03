import test from 'node:test';
import assert from 'node:assert/strict';
import {assignmentWorkAllowanceV2,defaultAssignmentWorkBudgetV2} from '../src/assignments/assignment_work_allowance_v2.js';
import {DEFAULT_ASSIGNMENT_PROGRESS_BUDGET_V2 as ordinary} from '../src/assignments/assignment_kernel_v2_progress.js';
import {operationScopeRequestHash} from '../src/domain/assignment-kernel/operation_scope.js';
import {declareWorkPlanV2} from '../src/domain/assignment-kernel/work_plan.js';
import {assignmentProgressBudgetBlockerV2} from '../src/domain/assignment-kernel/progress/controller.js';
import {requiresDurableWorkPlan} from '../src/assignments/work_plan_intent.js';

function fixture(source='Adjust all equipment tags on the selected sheet. Check the result. Do not save the model.'):any {
  const binding={assignment_id:'source-plan',run_id:'run',generation:1,session_id:'session',principal_id:'owner',document_fingerprint:'model'};
  return {current_binding:binding,spec:{schema:'revit-operator.assignment-spec/v2',binding,
    source_user_request:source,requested_effect:'apply',work_plan_required:requiresDurableWorkPlan(source),
    created_at:'2026-10-20T00:00:00Z',input_variables:[],work_units:[],
    interpreted_scope:{source_message_id:'message',source_request_sha256:operationScopeRequestHash(source),
      scope:{schema:'revit-operator.interpreted-operation-scope/v1',requested_effect:'apply',model_effect:'apply',
        protected_clauses:source.includes('Do not save the model.')?['Do not save the model.']:[],prerequisites:[]}}},
    operations:{},observations:{},provider_calls:{},progress_epochs:[]};
}
function retainPlan(s:any,implicitEdit=false) {
  s.work_plan=declareWorkPlanV2(s,{items:[
    {item_id:'batch',...(implicitEdit?{}:{kind:'edit' as const}),description:'Apply the requested property to the grounded scoped cohort.',source_basis:'Original request plus native inventory.'},
    {item_id:'check',kind:'inspection',depends_on:['batch'],description:'Read back the scoped cohort and inspect its appearance.',source_basis:'Original request asks for checking the result.'}
  ],assumptions:[]},'2026-10-20T00:00:01Z');
  return s;
}

test('source-required batch plus inspection receives the existing bounded planning window without artificial edit splitting',()=>{
  for(const source of [
    'Adjust all equipment tags on the selected sheet. Check the result. Do not save the model.',
    'Review and update all branch circuits and their wire parameters. Check the result.'
  ]) {
    const s=fixture(source);
    assert.equal(assignmentWorkAllowanceV2(s).provider_calls,32,'A source clause alone is not a retained plan.');
    retainPlan(s);
    const before=JSON.stringify(s),allowance=assignmentWorkAllowanceV2(s);
    assert.equal(allowance.broad,true);
    assert.equal(allowance.provider_calls,64);
    assert.equal(allowance.verified_changes,0,'Planning never becomes checked model work.');
    assert.equal(defaultAssignmentWorkBudgetV2(s,ordinary).max_provider_calls,64);
    assert.equal(JSON.stringify(s),before,'No mutation of specification, usage, plan or proof.');
    assert.deepEqual(assignmentWorkAllowanceV2(JSON.parse(before)),allowance,'Cold derivation is identical.');
    for(let i=0;i<5;i++)s.work_plan.items.push({...s.work_plan.items[1],item_id:'extra-check-'+i});
    assert.equal(assignmentWorkAllowanceV2(s).provider_calls,64,'Repeated inspection cannot accumulate planning windows.');
  }
});

test('omitted edit kind has the same bounded planning semantics as explicit edit at resource admission',()=>{
  const source='Adjust the equipment tags on E101 so all the new equipment tags are underlined. Check the result. Do not save the model.';
  const implicit=retainPlan(fixture(source),true),explicit=retainPlan(fixture(source));
  assert.equal(implicit.work_plan.items[0].kind,undefined,'Retain actual accepted declaration bytes; do not rewrite history.');
  for(const s of [implicit,explicit])for(let i=0;i<32;i++)s.provider_calls['used-'+i]={state:'completed',usage:{total_tokens:100},admitted_at:'2026-10-20T00:00:02Z',completed_at:'2026-10-20T00:00:03Z'};
  const before=JSON.stringify(implicit),allowance=assignmentWorkAllowanceV2(implicit);
  assert.equal(allowance.source_required_plan,true);
  assert.deepEqual(allowance,assignmentWorkAllowanceV2(explicit));
  assert.equal(allowance.provider_calls,64,'The existing planning window is unchanged.');
  assert.equal(allowance.verified_changes,0,'Defaulted kinds do not create native evidence.');
  assert.equal(assignmentProgressBudgetBlockerV2(implicit,defaultAssignmentWorkBudgetV2(implicit,ordinary),'2026-10-20T00:00:04Z'),null);
  assert.equal(JSON.stringify(implicit),before,'No usage, plan, outcome or proof mutation.');
  assert.deepEqual(assignmentWorkAllowanceV2(JSON.parse(before)),allowance,'Cold derivation retains optional-kind semantics.');
  for(let i=32;i<64;i++)implicit.provider_calls['used-'+i]={state:'completed',usage:{total_tokens:100},admitted_at:'2026-10-20T00:00:02Z',completed_at:'2026-10-20T00:00:03Z'};
  assert.equal(assignmentProgressBudgetBlockerV2(implicit,defaultAssignmentWorkBudgetV2(implicit,ordinary),'2026-10-20T00:00:04Z'),'provider_call_budget_exhausted');
});

test('ordinary single edits, source mismatches and incomplete plans retain the short-work allowance',()=>{
  for(const change of [
    (s:any)=>s.spec.work_plan_required=false,
    (s:any)=>delete s.spec.interpreted_scope,
    (s:any)=>s.spec.interpreted_scope.source_request_sha256='0'.repeat(64),
    (s:any)=>s.spec.source_user_request+=' Modified source.',
    (s:any)=>s.spec.interpreted_scope.scope.model_effect='read',
    (s:any)=>s.spec.requested_effect='read',
    (s:any)=>s.spec.created_at='not-a-date',
    (s:any)=>s.work_plan.items[0].declared_at='2020-01-01T00:00:00Z',
    (s:any)=>s.work_plan.items[1].kind='unrecognized',
    (s:any)=>s.work_plan.items[1].depends_on=['foreign'],
    (s:any)=>s.work_plan.items.splice(1,1),
    (s:any)=>s.work_plan.items[0].kind='inspection',
    (s:any)=>delete s.work_plan
  ]) {
    const s=retainPlan(fixture());change(s);
    assert.equal(assignmentWorkAllowanceV2(s).provider_calls,32);
  }
  const one=retainPlan(fixture('Adjust the selected equipment tag.'));
  assert.equal(one.spec.work_plan_required,false);
  assert.equal(assignmentWorkAllowanceV2(one).provider_calls,32);
  const fixed=retainPlan(fixture());
  fixed.spec.execution_policy={mode:'local_advisory_v1',max_provider_calls:32,max_operations:128,max_total_tokens:1_000_000,max_wall_clock_ms:600_000};
  assert.equal(defaultAssignmentWorkBudgetV2(fixed,ordinary).max_provider_calls,32,'An explicit historical fixed policy stays fixed.');
});

test('actual progress resource admission retains cumulative calls, enforces the existing ceiling and credits no completion',()=>{
  const s=retainPlan(fixture());
  for(let i=0;i<32;i++)s.provider_calls['used-'+i]={state:'completed',usage:{total_tokens:100},admitted_at:'2026-10-20T00:00:02Z',completed_at:'2026-10-20T00:00:03Z'};
  const before=JSON.stringify(s);
  assert.equal(assignmentProgressBudgetBlockerV2(s,ordinary,'2026-10-20T00:00:04Z'),'provider_call_budget_exhausted','Reproduces short-work stop.');
  assert.equal(assignmentProgressBudgetBlockerV2(s,defaultAssignmentWorkBudgetV2(s,ordinary),'2026-10-20T00:00:04Z'),null);
  assert.equal(JSON.stringify(s),before);
  assert(s.work_plan.items.every((i:any)=>!i.completed_at&&i.operation_ids.length===0));
  assert.equal(Object.keys(s.provider_calls).length,32,'No receipt is dropped or reset.');
  for(let i=32;i<64;i++)s.provider_calls['used-'+i]={state:'completed',usage:{total_tokens:100}};
  assert.equal(assignmentProgressBudgetBlockerV2(s,defaultAssignmentWorkBudgetV2(s,ordinary),'2026-10-20T00:00:04Z'),'provider_call_budget_exhausted');
  assert.equal(assignmentWorkAllowanceV2(s).verified_changes,0);
});
