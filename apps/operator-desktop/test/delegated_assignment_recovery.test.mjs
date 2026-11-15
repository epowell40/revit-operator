import test from 'node:test';
import assert from 'node:assert/strict';
import { delegatedAssignmentRecoveryDeadline as deadline, delegatedAssignmentFailureMetadata as metadata } from '../delegated_assignment_recovery.mjs';
const now=Date.parse('2026-10-12T01:20:33Z');
const binding={assignment_id:'binder',assignment_run_id:'sidecar:run',assignment_generation:1,session_id:'session'};
const original=()=>({current_binding:{assignment_id:'binder',run_id:'sidecar:run',generation:1,session_id:'session',document_fingerprint:'doc'},
  outcome:'active',terminal:false,unresolved_unknown_operation_ids:[],spec:{created_at:'2026-10-12T01:13:34Z',execution_policy:{
    mode:'local_advisory_v1',selected_by:'trusted_local_host',session_id:'session',document_fingerprint:'doc',max_wall_clock_ms:7_200_000}}});
test('lost outer response retains backend effects and never invites duplicate active work',()=>{
  const active={quiescent:false,in_flight_provider_call_ids:['call'],in_flight_operation_ids:[],
    unresolved_unknown_operation_ids:[],operations:{write:{persistent_effect:'applied',dispatch_state:'dispatched'}}};
  assert.deepEqual(metadata(active),{effect_state:'applied',outcome_unknown:false,reconciliation_required:false,
    backend_work_running:true,retryable:false,unresolved_unknown_operation_ids:[]});
  assert.equal(metadata({...active,quiescent:true,in_flight_provider_call_ids:[]}).retryable,false);
  const blocked=metadata({...active,quiescent:true,in_flight_provider_call_ids:[],unresolved_unknown_operation_ids:['preview']});
  assert.equal(blocked.effect_state,'unknown'); assert.equal(blocked.reconciliation_required,true);
  assert.deepEqual(blocked.unresolved_unknown_operation_ids,['preview']);
});
test('long binder recovery uses frozen original deadline and never renews on polling',()=>{
 const fallback=now+900_000;const frozen=Date.parse('2026-10-12T03:13:34Z');
 assert.equal(deadline(original(),binding,fallback,now),frozen);
 assert.equal(deadline(original(),binding,fallback,now+600_000),frozen);
});

test('authenticated task review recovers the exact original deadline without foreign or expanded policy',()=>{
 const s=original(),fallback=now+60_000;
 s.current_binding.principal_id='principal';s.spec.binding={...s.current_binding};
 Object.assign(s.spec.execution_policy,{mode:'single_actor_review_v1',selected_by:'trusted_runtime_host',principal_id:'principal',max_wall_clock_ms:1800000});
 const frozen=Date.parse(s.spec.created_at)+1800000;assert.equal(deadline(s,binding,fallback,now),frozen);assert.equal(deadline(s,binding,fallback,now+10_000),frozen);
 for(const mutate of [x=>x.spec.execution_policy.principal_id='foreign',x=>x.spec.execution_policy.selected_by='agent',x=>x.spec.execution_policy.max_wall_clock_ms=1800001,x=>x.spec.binding.generation=2,x=>x.unresolved_unknown_operation_ids=['unknown'],x=>x.terminal=true]){
  const bad=structuredClone(s);mutate(bad);assert.equal(deadline(bad,binding,fallback,now),fallback);
 }
});
test('different assignment, session, run or generation cannot extend recovery',()=>{
 for(const [key,value] of [['assignment_id','other'],['run_id','other'],['session_id','other'],['generation',2]]){
  const s=original();s.current_binding[key]=value;assert.throws(()=>deadline(s,binding,now,now),/binding_mismatch/);
 }
});
test('invalid, stopped, unknown or untrusted allowance retains bounded fallback',()=>{
 for(const mutate of [s=>s.outcome='blocked',s=>s.terminal=true,s=>s.unresolved_unknown_operation_ids=['old'],
  s=>s.spec.execution_policy.selected_by='agent',s=>s.spec.execution_policy.session_id='other',
  s=>s.spec.execution_policy.document_fingerprint='other',s=>s.spec.execution_policy.max_wall_clock_ms=7_200_001,
  s=>s.spec.created_at='2026-10-12T03:00:00Z',s=>delete s.spec.execution_policy]){
  const s=original();mutate(s);assert.equal(deadline(s,binding,now+900_000,now),now+900_000);
 }
});
