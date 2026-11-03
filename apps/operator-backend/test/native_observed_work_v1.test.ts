import test from'node:test';import assert from'node:assert/strict';import{createHash}from'node:crypto';
import{nativeObservedPhysicalTargetsV1}from'../src/verification/native_observed_work_v1.js';
import{observedFixture}from'./observed_work_fixture.js';import{canonicalJsonV2}from'../src/domain/assignment-kernel/canonical.js';
const rehash=(f:ReturnType<typeof observedFixture>)=>{f.result.raw_payload_hash=createHash('sha256').update(canonicalJsonV2(f.payload)).digest('hex');};
test('actual native changed physical owners may be observed together without claiming a postcondition or platform collateral',()=>{
 const f=observedFixture(),before=JSON.stringify(f);assert.deepEqual(nativeObservedPhysicalTargetsV1(f.s,f.read,f.result,f.payload),['element_id:11','element_id:12']);assert.equal(JSON.stringify(f),before);
});
const negatives:Record<string,(f:ReturnType<typeof observedFixture>)=>void>={
 'old-policy':f=>f.s.spec.execution_policy.progress_allowance.mode='verified_native_changes_v1',
 'read-only-objective':f=>f.s.spec.requested_effect='read',
 paused:f=>f.s.execution_control={state:'paused'},unknown:f=>f.s.unresolved_unknown_operation_ids=['uncertain'],
 'other-inflight':f=>f.s.in_flight_operation_ids=['other'],'provider-pending':f=>f.s.in_flight_provider_call_ids=['pending'],
 'usage-hold':f=>f.s.provider_usage_hold=true,'input-question':f=>f.s.pending_input_variable_ids=['need-input'],
 'review-pending':f=>f.s.pending_review_ids=['review'],'terminal':f=>f.s.terminal=true,
 'invalidated-read':f=>f.s.input_invalidated_operation_ids=['read'],
 'foreign-read':f=>f.read.binding={...f.read.binding,principal_id:'other'},'foreign-native':f=>f.result.binding={...f.result.binding,generation:2},
 'non-native':f=>f.result.authority='caller','failed-read':f=>f.result.status='failed','unknown-read':f=>f.result.persistent_effect='unknown',
 'missing-receipt':f=>f.result.receipt_id=null,'missing-correlation':f=>f.result.native_correlation_id=null,
 'wrong-result-operation':f=>f.result.operation_id='another','wrong-method':f=>f.read.input.method='GET',
 'wrong-path':f=>f.read.input.path='/revit/other','wrong-signature':f=>f.result.request_identity={...f.result.request_identity,request_signature:'x'},
 'wrong-digest':f=>f.result.raw_payload_hash='f'.repeat(64),'wrong-doc':f=>f.read.target.document_fingerprint='elsewhere',
 'early-read':f=>f.read.opened_at='2026-11-02T00:00:00Z',
 'no-mutation':f=>delete f.s.operations.mutation,'read-only-mutation':f=>f.s.operations.mutation.requested_effect='read',
 'unsettled-mutation':f=>f.s.operations.mutation.settlement_state='open','unknown-mutation':f=>f.s.operations.mutation.persistent_effect='unknown',
 'foreign-mutation':f=>f.s.operations.mutation.result.authority='mcp','wrong-mutation-signature':f=>f.s.operations.mutation.result.request_identity={request_signature:'wrong'},
 'unobserved-mutation':f=>f.s.operations.mutation.observation_ids=[],
 'invalidated-mutation':f=>f.s.input_invalidated_operation_ids=['mutation'],
 'non-success-mutation':f=>f.s.observations['mutation-observed'].facts[0].value=false,
 'empty-changes':f=>f.s.operations.mutation.result.affected_target_identities=[],
 'failed-scan':f=>{f.payload.failedElementCount=1;rehash(f);},'truncated-scan':f=>{f.payload.connectorScanTruncatedElementCount=1;rehash(f);},
 'failed-native-status':f=>{f.payload.status='Failed';rehash(f);},
 'duplicate-row':f=>{f.payload.results[1]=structuredClone(f.payload.results[0]);rehash(f);},
 'missing-row':f=>{f.payload.results.pop();rehash(f);},
 'nonfinite-position':f=>{for(const r of f.payload.results)r.connectors[0].origin[0]=Infinity;rehash(f);},
 'missing-geometry':f=>{for(const r of f.payload.results)r.connectors=[];rehash(f);},
 'incomplete-ref':f=>{for(const r of f.payload.results)r.connectors[0].referenceScanComplete=false;rehash(f);},
 'platform-collateral':f=>{for(const r of f.payload.results)r.category='OST_Schedules';rehash(f);},
 'unrelated-physical':f=>{f.s.operations.mutation.result.affected_target_identities=['element_id:900'];},
};
for(const[name,change]of Object.entries(negatives))test('observed-work producer refuses '+name,()=>{const f=observedFixture();change(f);assert.deepEqual(nativeObservedPhysicalTargetsV1(f.s,f.read,f.result,f.payload),[]);});
