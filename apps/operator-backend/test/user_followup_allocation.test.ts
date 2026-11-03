import test from 'node:test';
import assert from 'node:assert/strict';
import { allocateAuthenticatedFollowupV1, assignmentWorkAllowanceV2, defaultAssignmentWorkBudgetV2 } from '../src/domain/assignment-kernel/effective_work_budget.js';
import { applyUserFollowupAllocationV1 } from '../src/domain/assignment-kernel/user_followup_allocation.js';
import { DEFAULT_ASSIGNMENT_PROGRESS_BUDGET_V2 } from '../src/assignments/assignment_kernel_v2_progress.js';
import type { AssignmentSnapshotV2 } from '../src/domain/assignment-kernel/snapshot.js';

const now='2026-10-18T08:00:00.000Z';
function fixture(): AssignmentSnapshotV2 {
  return {spec:{created_at:now,requested_effect:'apply',execution_policy:{mode:'local_advisory_v1',
    max_provider_calls:64,max_operations:256,max_total_tokens:8_000_000,max_wall_clock_ms:1_200_000,
    progress_allowance:{mode:'verified_native_changes_v1',credit_unit:'distinct_verified_targets_v1',
      max_provider_calls:256,max_operations:1024,max_total_tokens:32_000_000,max_wall_clock_ms:7_200_000}}},
    provider_calls:Object.fromEntries(Array.from({length:88},(_,i)=>[`call-${i}`,{admitted_at:now,completed_at:now,
      usage:{total_tokens:100_000,cached_input_tokens:90_000}}])),operations:{},observations:{},current_binding:{}} as unknown as AssignmentSnapshotV2;
}
const budget=(snapshot:AssignmentSnapshotV2)=>defaultAssignmentWorkBudgetV2(snapshot,DEFAULT_ASSIGNMENT_PROGRESS_BUDGET_V2);
test('settled user work allocation preserves every cumulative resource and frozen policy, with no idle accumulation',()=>{
  const s=fixture(), before=structuredClone(s), allocated=allocateAuthenticatedFollowupV1(s,'user-one',now);
  assert.equal(budget(s).max_provider_calls,64);assert.equal(budget(allocated).max_provider_calls,152);
  assert.equal(assignmentWorkAllowanceV2(allocated).provider_calls,152);
  assert.equal(budget(allocated).max_total_tokens,16_800_000,'cached tokens remain charged');
  assert.deepEqual(s,before);assert.deepEqual(allocated.provider_calls,s.provider_calls);assert.deepEqual(allocated.spec,s.spec);
  assert.deepEqual(budget(allocateAuthenticatedFollowupV1(allocated,'idle-two',now)),budget(allocated));
  assert.deepEqual(budget(JSON.parse(JSON.stringify(allocated))),budget(allocated));
});
test('later genuine progress earns its delta once, never old progress again, and all limits remain capped',()=>{
  const s=allocateAuthenticatedFollowupV1(fixture(),'user-one',now), earned=budget(fixture());
  const progressed=applyUserFollowupAllocationV1(s,{...earned,max_provider_calls:72,max_reasoning_turns:72,max_operations:288,
    max_total_tokens:9_000_000,max_wall_clock_ms:1_500_000});
  assert.equal(progressed.max_provider_calls,160);assert.equal(progressed.max_total_tokens,17_800_000);
  const huge=applyUserFollowupAllocationV1(s,{...earned,max_provider_calls:1000,max_operations:10000,max_total_tokens:1e9,max_wall_clock_ms:1e9});
  assert.equal(huge.max_provider_calls,256);assert.equal(huge.max_reasoning_turns,256);assert.equal(huge.max_total_tokens,32_000_000);
  assert.equal(huge.max_operations,1024);assert.equal(huge.max_wall_clock_ms,7_200_000);
});
test('paused, old non-progress and preview tasks gain no allocation; missing usage cannot be treated as free',()=>{
  const paused=fixture();paused.execution_control={state:'paused',command_id:'pause',changed_at:now};
  assert.equal(allocateAuthenticatedFollowupV1(paused,'direction',now),paused);
  const old=fixture();delete old.spec.execution_policy!.progress_allowance;
  assert.equal(allocateAuthenticatedFollowupV1(old,'direction',now),old);
  const preview=fixture();(preview.spec as any).requested_effect='preview';assert.equal(allocateAuthenticatedFollowupV1(preview,'direction',now),preview);
  const missing=fixture();delete (missing.provider_calls['call-0'] as any).usage;
  assert.throws(()=>allocateAuthenticatedFollowupV1(missing,'direction',now),/usage must be known/);
  const unknownTime=fixture();(unknownTime.provider_calls['call-0'] as any).admitted_at='invalid';
  assert.throws(()=>allocateAuthenticatedFollowupV1(unknownTime,'direction',now),/usage must be known/);
});
test('legacy policy without an explicit time ceiling cannot gain more time',()=>{
  const s=fixture();delete s.spec.execution_policy!.progress_allowance!.max_wall_clock_ms;
  const result=allocateAuthenticatedFollowupV1(s,'direction',now);
  assert.equal(budget(result).max_wall_clock_ms,budget(s).max_wall_clock_ms);
});

test('explicit bounded renewal extends the same task without replacing policy, usage, operations or time',()=>{
  const s=fixture();s.provider_calls=Object.fromEntries(Array.from({length:166},(_,i)=>['call-'+i,
    {admitted_at:now,completed_at:now,usage:{total_tokens:i===0?29_460_846:0,cached_input_tokens:0}}])) as any;
  const original=structuredClone(s),before=budget(s),request={provider_calls:64,total_tokens:16_000_000};
  const renewed=allocateAuthenticatedFollowupV1(s,'explicit-renewal',now,request),b=budget(renewed);
  assert.equal(b.max_provider_calls,230);assert.equal(b.max_total_tokens,45_460_846);
  assert.equal(b.max_operations,before.max_operations);assert.equal(b.max_wall_clock_ms,before.max_wall_clock_ms);
  assert.deepEqual(s,original);assert.deepEqual(renewed.spec,s.spec);assert.deepEqual(renewed.provider_calls,s.provider_calls);
  assert.deepEqual(renewed.operations,s.operations);assert.deepEqual(budget(JSON.parse(JSON.stringify(renewed))),b);
  assert.deepEqual(budget(allocateAuthenticatedFollowupV1(renewed,'idle-renewal',now,request)),b,'idle approvals do not stockpile');
  assert.deepEqual(budget(allocateAuthenticatedFollowupV1(renewed,'ordinary-followup',now)),b,'ordinary followup retains the prior explicit ceiling');
});

test('renewal rejects malformed windows and retains Pause, preview, missing-usage and absolute cumulative fences',()=>{
  for(const renewal of [null,[],{provider_calls:0,total_tokens:1},{provider_calls:65,total_tokens:1},
    {provider_calls:1,total_tokens:16_000_001},{provider_calls:1.5,total_tokens:1},
    {provider_calls:1,total_tokens:NaN},{provider_calls:1,total_tokens:1,authority:'native'}])
    assert.throws(()=>allocateAuthenticatedFollowupV1(fixture(),'bad',now,renewal as any));
  const request={provider_calls:64,total_tokens:16_000_000};
  const paused=fixture();paused.execution_control={state:'paused',command_id:'pause',changed_at:now};
  assert.throws(()=>allocateAuthenticatedFollowupV1(paused,'paused',now,request),/unpaused/);
  const preview=fixture();(preview.spec as any).requested_effect='preview';assert.throws(()=>allocateAuthenticatedFollowupV1(preview,'preview',now,request));
  const missing=fixture();delete(missing.provider_calls['call-0']as any).usage;
  assert.throws(()=>allocateAuthenticatedFollowupV1(missing,'unknown-usage',now,request),/usage must be known/);
  const huge=fixture();huge.provider_calls['call-0'].usage!.total_tokens=250_000_000;
  assert.throws(()=>allocateAuthenticatedFollowupV1(huge,'ceiling',now,request),/cumulative advisory/);
});
