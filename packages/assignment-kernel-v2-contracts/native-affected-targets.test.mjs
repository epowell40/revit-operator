import test from 'node:test';
import assert from 'node:assert/strict';
import { MAX_NATIVE_AFFECTED_TARGETS_V2, isCanonicalNativeAffectedTargetSetV2 } from './native-affected-targets.js';
import { nativeCompletionReconciliationEffectV1 } from './native-completion.js';

test('native receipt bound is shared, ordinal and lossless for dependent changes',()=>{
  for(const count of [0,256,257,400,MAX_NATIVE_AFFECTED_TARGETS_V2]){
    const ids=Array.from({length:count},(_,i)=>'element_id:'+(1000000+i)).sort();
    assert(isCanonicalNativeAffectedTargetSetV2(ids));
  }
  for(const value of [null,{},['a','a'],['b','a'],[' bad'],['x\u0000y'],['x'.repeat(501)],
    Array.from({length:MAX_NATIVE_AFFECTED_TARGETS_V2+1},(_,i)=>'element_id:'+(1000000+i))])
    assert.equal(isCanonicalNativeAffectedTargetSetV2(value),false);
});

test('large late-completion semantics keep the same exact request and effect checks',()=>{
  const hash='sha256:'+'a'.repeat(64),requestId='b'.repeat(64),fingerprint='c'.repeat(64),at='2026-10-16T20:40:00Z';
  const binding={document_fingerprint:fingerprint},admitted={method:'POST',path:'/revit/link-cad',request_signature:'signature'};
  const native={request_id:requestId,request_nonce_sha256:hash,server_epoch:'e'.repeat(43),method:'POST',path:admitted.path,
    body_present:true,source_body_sha256:hash,channel:'generic_call',alias:'revit_call_tool',transport_receipt_sha256:hash,expected_document_fingerprint:fingerprint};
  const operation={operation_id:'operation',binding,request_identity:admitted,requested_effect:'apply',settlement_state:'settled',
    result:{result_id:'timeout',authority:'native-host',persistent_effect:'unknown',dispatch_state:'dispatched',binding,request_identity:admitted,native_correlation_id:requestId}};
  const completion={schema:'revit-operator.native-completion-reconciliation/v1',original_result_id:'timeout',
    dispatch:{schema:'revit-operator.native-completion-dispatch/v1',identity:{operation_id:'operation',binding,request_identity:admitted},native},
    record_sha256:hash,evidence_id:'ev1_'+'0'.repeat(32),receipt:{schema:'revit-operator.native-terminal-completion/v1',dispatch_started_at_utc:at,completed_at_utc:at,
      request:{...native,authorized_body_sha256:hash,dispatched_body_sha256:hash},
      document:{document_fingerprint:fingerprint,document_session_id:'native-session',after_document_fingerprint:fingerprint,after_document_session_id:'native-session'},
      authorization:{authorization_hash:hash,exposure_profile:'laboratory',certification_envelope_hash:null,authorized_at_utc:at},terminal:{body_sha256:hash,status_code:200}},
    proof:{transaction:{status:'committed',committed:true},canonical_attempt_settlement:{schema:'revit-operator.native-attempt-settlement.v1',method:'POST',path:admitted.path,
      requested_effect:'apply',request_dispatched:true,effect_state:'applied',effect_authority:'native_transaction',effect_reason:'native_transaction_committed',
      affected_target_identities:Array.from({length:400},(_,i)=>'element_id:'+(1000000+i))}}};
  assert.equal(nativeCompletionReconciliationEffectV1(completion,operation),'applied');
  for(const mutate of [p=>p.dispatch.native.request_id='foreign',p=>p.proof.transaction.committed=false,
    p=>p.receipt.document.document_fingerprint='foreign',p=>p.proof.canonical_attempt_settlement.affected_target_identities=Array.from({length:4097},(_,i)=>'id:'+i)]){
    const changed=structuredClone(completion);mutate(changed);assert.equal(nativeCompletionReconciliationEffectV1(changed,operation),null);
  }
  assert.equal(operation.result.persistent_effect,'unknown','pure check never clears a historical result');
});
