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

function productFixture(): AssignmentSnapshotV2 {
  const s=fixture();
  const binding={assignment_id:'product',run_id:'run',generation:1,session_id:'session',principal_id:'principal',document_fingerprint:'model'};
  s.current_binding={...binding};s.spec.binding={...binding};
  s.spec.execution_policy={mode:'single_actor_review_v1',selected_by:'trusted_runtime_host',principal_id:'principal',
    session_id:'session',document_fingerprint:'model',ready_work_handoff:'continue_ready_work_v1',max_turns:8,
    max_provider_calls:32,max_operations:128,max_total_tokens:4_000_000,max_wall_clock_ms:1_800_000};
  s.provider_calls=Object.fromEntries(Object.entries(s.provider_calls).slice(0,32));
  return s;
}

test('authenticated product checkpoint can explicitly renew calls and tokens without enabling automatic credit',()=>{
  const s=productFixture(),original=structuredClone(s),request={provider_calls:64,total_tokens:16_000_000};
  assert.equal(allocateAuthenticatedFollowupV1(s,'ordinary',now),s,'Ordinary direction cannot mint product allowance');
  const renewed=allocateAuthenticatedFollowupV1(s,'approved',now,request),b=budget(renewed);
  assert.equal(b.max_provider_calls,96);assert.equal(b.max_total_tokens,19_200_000);
  assert.equal(b.max_operations,128);assert.equal(b.max_wall_clock_ms,1_800_000);
  assert.deepEqual(s,original);assert.deepEqual(renewed.spec,s.spec);assert.deepEqual(renewed.provider_calls,s.provider_calls);
  assert.deepEqual(renewed.operations,s.operations);assert.equal(renewed.spec.execution_policy!.progress_allowance,undefined);
  assert.deepEqual(budget(JSON.parse(JSON.stringify(renewed))),b);
  assert.deepEqual(budget(allocateAuthenticatedFollowupV1(renewed,'idle',now,request)),b);
  assert.deepEqual(budget(allocateAuthenticatedFollowupV1(renewed,'ordinary-again',now)),b);
});

test('product renewal rejects untrusted policy or binding and keeps usage, Pause and finite resource guards',()=>{
  const request={provider_calls:64,total_tokens:16_000_000};
  for(const mutate of [
    (s:any)=>s.spec.execution_policy.selected_by='agent',
    (s:any)=>s.spec.execution_policy.principal_id='foreign',
    (s:any)=>s.spec.execution_policy.document_fingerprint='foreign',
    (s:any)=>s.spec.execution_policy.max_provider_calls=33,
    (s:any)=>s.current_binding.generation=2,(s:any)=>s.current_binding.session_id='foreign',
    (s:any)=>s.current_binding.principal_id='foreign',(s:any)=>s.current_binding.document_fingerprint='foreign',
    (s:any)=>s.spec.requested_effect='read',(s:any)=>s.execution_control={state:'paused'},
    (s:any)=>delete s.provider_calls['call-0'].usage,
    (s:any)=>s.provider_calls['call-0'].admitted_at='bad'
  ]) { const s=productFixture();mutate(s);assert.throws(()=>allocateAuthenticatedFollowupV1(s,'bad',now,request)); }
});
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

test('explicit active-time renewal continues an exhausted clock without resetting any usage',()=>{
  const s=fixture();s.spec.created_at='2026-10-18T06:00:00.000Z';s.spec.execution_policy!.max_wall_clock_ms=7_200_000;
  Object.assign(s.provider_calls['call-0'],{admitted_at:s.spec.created_at,completed_at:now});
  const original=structuredClone(s),old=budget(s),request={provider_calls:64,total_tokens:16_000_000,active_execution_ms:1_200_000};
  const renewed=allocateAuthenticatedFollowupV1(s,'time-renewal',now,request as any),next=budget(renewed);
  assert.equal(next.max_wall_clock_ms,8_400_000);assert.equal(next.max_provider_calls,152);
  assert.equal(next.max_total_tokens,24_800_000);assert.equal(next.max_operations,old.max_operations);
  assert.deepEqual(renewed.spec,original.spec);assert.deepEqual(renewed.provider_calls,original.provider_calls);
  assert.deepEqual(budget(JSON.parse(JSON.stringify(renewed))),next);
  assert.deepEqual(budget(allocateAuthenticatedFollowupV1(renewed,'idle',now,request as any)),next);
  assert.deepEqual(budget(allocateAuthenticatedFollowupV1(renewed,'ordinary',now)),next);
  for(const bad of [{active_execution_ms:0},{active_execution_ms:1_800_001},{active_execution_ms:NaN},
    {active_execution_ms:1.5},{active_execution_ms:1,authority:'native'}])
    assert.throws(()=>allocateAuthenticatedFollowupV1(s,'bad',now,{provider_calls:64,total_tokens:16_000_000,...bad} as any));
});

test('time renewal remains explicit, bounded and subject to existing usage and Pause fences',()=>{
 const request={provider_calls:64,total_tokens:16_000_000,active_execution_ms:1_200_000};
 for(const mutate of [(s:any)=>s.execution_control={state:'paused'},(s:any)=>delete s.provider_calls['call-0'].usage,
   (s:any)=>s.provider_calls['call-0'].admitted_at='invalid',(s:any)=>s.spec.requested_effect='read']){
   const s=fixture();mutate(s);assert.throws(()=>allocateAuthenticatedFollowupV1(s,'bad',now,request));
 }
 const s=fixture();s.spec.created_at='2026-10-18T00:00:00.000Z';
 Object.assign(s.provider_calls['call-0'],{admitted_at:s.spec.created_at,completed_at:now});
 assert.throws(()=>allocateAuthenticatedFollowupV1(s,'ceiling',now,request),/eight-hour/);
 const product=productFixture(),renewed=allocateAuthenticatedFollowupV1(product,'product-time',now,request);
 assert.equal(budget(renewed).max_wall_clock_ms,1_800_000,'idle renewal does not accumulate time');
 assert.deepEqual(renewed.spec,product.spec);
});
