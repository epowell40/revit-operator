import test from 'node:test';import assert from 'node:assert/strict';
import{observedFixture}from'./observed_work_fixture.js';
import{validLocalAdvisoryPolicyV1}from'../src/domain/assignment-kernel/execution_policy.js';
import{assignmentWorkAllowanceV2,defaultAssignmentWorkBudgetV2,assignmentWorkBudgetStatusV2}from'../src/assignments/assignment_work_allowance_v2.js';
import{DEFAULT_ASSIGNMENT_PROGRESS_BUDGET_V2 as ordinary}from'../src/assignments/assignment_kernel_v2_progress.js';
test('explicit observed-work policy separates resource progress from strict verification',()=>{
 const{s}=observedFixture();assert.equal(validLocalAdvisoryPolicyV1(s.spec),true);
 const before=JSON.stringify(s),allowance:any=assignmentWorkAllowanceV2(s);
 assert.equal(allowance.observed_targets,2);assert.equal(allowance.verified_targets,0);assert.equal(allowance.verified_changes,0);
 const budget=defaultAssignmentWorkBudgetV2(s,ordinary);assert.equal(budget.max_provider_calls,40);assert.equal(budget.max_total_tokens,3500000);
 const status:any=assignmentWorkBudgetStatusV2(s,ordinary,'2026-11-02T01:01:00Z');
 assert.equal(status.allocation.observed_distinct_physical_targets,2);assert.equal(status.allocation.verified_distinct_targets,0);
 assert.equal(status.allocation.earned_credit_unit,'distinct_observed_physical_targets_v1');assert.match(status.allocation.basis,/not.*completion/i);
 assert.equal(JSON.stringify(s),before);assert.equal(Object.values(s.observations).some((o:any)=>o.facts.some((f:any)=>f.fact_id==='verification.postcondition_satisfied')),false);
});
const negatives:Record<string,(s:any)=>void>={
 'no-native-mutation':s=>delete s.operations.mutation,
 'read-only-mutation':s=>s.operations.mutation.requested_effect='read',
 'failed-mutation':s=>s.operations.mutation.result.status='failed',
 'foreign-native-mutation':s=>s.operations.mutation.result.authority='caller',
 'mutation-observation-missing':s=>s.operations.mutation.observation_ids=[],
 'wrong-read-hash':s=>s.observations['read-observed'].raw_payload_hash='d'.repeat(64),
 'foreign-read-observation':s=>s.observations['read-observed'].binding={...s.current_binding,generation:2},
 'wrong-fact-class':s=>s.observations['read-observed'].facts[1].fact_class='verification',
 'malformed-target-list':s=>s.observations['read-observed'].facts[1].value='11,12',
 'duplicate-targets':s=>s.observations['read-observed'].facts[1].value=['element_id:11','element_id:11'],
 'conflicting-facts':s=>s.observations['read-observed'].facts.push(structuredClone(s.observations['read-observed'].facts[1])),
 'missing-read-scope':s=>s.operations.read.target={document_fingerprint:s.current_binding.document_fingerprint},
 'bad-read-time':s=>s.operations.read.result.completed_at='not-a-time',
 'before-mutation':s=>s.operations.read.opened_at='2026-11-02T00:00:00Z',
 'wrong-read-signature':s=>s.operations.read.result.request_identity={request_signature:'different'},
 'failed-read':s=>s.operations.read.result.status='failed',
 'unrelated-physical':s=>s.operations.mutation.result.affected_target_identities=['element_id:900'],
};
for(const[name,change]of Object.entries(negatives))test('observed allowance excludes '+name,()=>{const{s}=observedFixture();change(s);assert.equal((assignmentWorkAllowanceV2(s)as any).observed_targets,0);});
test('repeated observations and later direction cannot mint duplicate targets or erase already observed work',()=>{
 const{s}=observedFixture();const next=structuredClone(s.operations.read);next.operation_id='read-again';next.result.operation_id=next.operation_id;next.observation_ids=['again'];
 s.operations[next.operation_id]=next;s.observations.again={...structuredClone(s.observations['read-observed']),operation_id:next.operation_id,observation_id:'again'};
 assert.equal((assignmentWorkAllowanceV2(s)as any).observed_targets,2);
 s.input_invalidated_operation_ids=['mutation','read','read-again'];
 assert.equal((assignmentWorkAllowanceV2(s)as any).observed_targets,2,'historical resource work is not current verification');
});
test('observed targets never exceed frozen resource ceilings or change no-progress and reconciliation controls',()=>{
 const{s}=observedFixture(),targets=Array.from({length:500},(_,i)=>'element_id:'+(1000+i));
 s.operations.mutation.result.affected_target_identities=targets;s.operations.read.target.semantic_scope=Object.fromEntries(targets.map((id,i)=>['target_'+i,id]));
 s.observations['read-observed'].facts[1].value=targets;
 const budget=defaultAssignmentWorkBudgetV2(s,ordinary);assert.equal(budget.max_total_tokens,25500000);assert.equal(budget.max_provider_calls,216);assert.equal(budget.max_wall_clock_ms,7200000);assert.equal(budget.max_operations,1024);
 assert.equal(budget.max_no_progress_epochs,ordinary.max_no_progress_epochs);assert.equal(budget.max_reconciliation_attempts,ordinary.max_reconciliation_attempts);
});
test('historical strict allowance cannot acquire observed-work credit or change its frozen limits',()=>{
 const{s}=observedFixture();Object.assign(s.spec.execution_policy.progress_allowance,{mode:'verified_native_changes_v1',credit_unit:'distinct_verified_targets_v1'});
 assert.equal(validLocalAdvisoryPolicyV1(s.spec),true);assert.equal(defaultAssignmentWorkBudgetV2(s,ordinary).max_total_tokens,1500000);
 assert.equal((assignmentWorkAllowanceV2(s) as any).observed_targets,undefined);
});
test('observed policy cannot opt read/foreign/mismatched-unit or excessive limits into this allowance',()=>{
 for(const change of [
  (s:any)=>s.spec.requested_effect='read',(s:any)=>s.spec.execution_policy.selected_by='caller',
  (s:any)=>s.spec.execution_policy.document_fingerprint='foreign',
  (s:any)=>delete s.spec.execution_policy.ready_work_handoff,
  (s:any)=>s.spec.execution_policy.progress_allowance.credit_unit='distinct_verified_targets_v1',
  (s:any)=>s.spec.execution_policy.progress_allowance.max_provider_calls=99999,
  (s:any)=>{s.spec.execution_policy.progress_allowance.mode='verified_native_changes_v1';}
 ]){const{s}=observedFixture();change(s);assert.equal(validLocalAdvisoryPolicyV1(s.spec),false);}
});
