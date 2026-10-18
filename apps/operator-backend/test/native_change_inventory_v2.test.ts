import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { canonicalJsonV2 } from '../src/domain/assignment-kernel/canonical.js';
import { COMPLETE_NATIVE_CHANGE_INVENTORY_FACT_V2, nativeChangeInventoryCompleteV2, hasCompleteNativeChangeInventoryV2 } from '../src/verification/native_change_inventory_v2.js';
import { projectWorkReviewV2, workReviewRowsV2 } from '../src/assignments/work_review_handoff.js';
const fixture = () => JSON.parse(fs.readFileSync('test/fixtures/work-review-native-footprints-39.json','utf8'));
const counterId = 'opv2_e8f6cb909ad4ca30087cfeaef8ac4aa7aac7ab7d769fb0ab151752eb0f5de28d';
const typeId = 'opv2_ae19b52577af2c43b3ed23be92fae4584a3c8bd18d495a32889dcb4c71f72449';

test('large change inventories remain exact and do not turn a commit into postcondition proof',()=>{
  const f=fixture(),op=f.snapshot.operations[counterId],p=f.native_applies[counterId];
  const ids=Array.from({length:400},(_,i)=>1000000+i);
  p.transaction={status:'committed',committed:true,added_element_ids:ids,modified_element_ids:[],deleted_element_ids:[],affected_element_ids:ids};
  op.result.affected_target_identities=ids.map(id=>'element_id:'+id).sort();
  op.result.raw_payload_hash=createHash('sha256').update(canonicalJsonV2(p)).digest('hex');
  assert.equal(nativeChangeInventoryCompleteV2(op,op.result,p),true);
  p.transaction.affected_element_ids=p.transaction.affected_element_ids.slice(0,-1);
  op.result.raw_payload_hash=createHash('sha256').update(canonicalJsonV2(p)).digest('hex');
  assert.equal(nativeChangeInventoryCompleteV2(op,op.result,p),false,'no truncation or partial union is exhaustive');
});

function reproject(f: ReturnType<typeof fixture>) {
  // Replay the new host derivation on retained native bytes, not a rewrite of
  // the historical publication or an assertion of a new live qualification.
  for (const [id,payload] of Object.entries(f.native_applies)) {
    const op = f.snapshot.operations[id];
    assert(nativeChangeInventoryCompleteV2(op,op.result,payload),id);
    f.snapshot.observations[op.observation_ids[0]].facts.push({fact_id:COMPLETE_NATIVE_CHANGE_INVENTORY_FACT_V2,fact_class:'control',value:true});
  }
  return f.snapshot;
}

test('retained E107 checks survive unrelated shared-panel changes without closing claimed source scope',()=>{
  const f = fixture();
  assert.equal(projectWorkReviewV2(f.snapshot).checked_edit_count,1,'historical incomplete write footprints remain conservative; exact counter property proof is separate from panel dependents');
  const s = reproject(f), before = JSON.stringify(s), review = projectWorkReviewV2(s);
  assert.equal(review.checked_edit_count,3,'counter type, new type Label and circuit stay current; outdoor Type needs a read after recircuiting');
  assert.deepEqual(workReviewRowsV2(s).map(r=>[r.applied_operation_count,r.checked_operation_count]),[[1,1],[2,1],[1,1]]);
  assert.equal(review.counts.checked,0,'worker claims, dry-run/read IDs and missing annotation proofs do not certify whole comments');
  assert.equal(review.counts.reported_unverified,3);
  assert.equal(JSON.stringify(s),before,'review never reconciles, mutates or clears history');
  assert.deepEqual(projectWorkReviewV2(JSON.parse(before)),review,'restart projection remains identical');
});

test('unassociated native checks remain visible without certifying checklist coverage',()=>{
  const s=reproject(fixture());
  s.work_plan.items=s.work_plan.items.map((item:any)=>({...item,operation_ids:[],completed_at:undefined}));
  s.work_plan_claims=[];
  const before=JSON.stringify(s),report=projectWorkReviewV2(s);
  assert.equal(report.checked_edit_count,3);
  assert.equal(report.checked_edits_without_checklist_item,3);
  assert.equal(report.counts.checked,0);
  assert.equal(report.counts.not_completed,3);
  assert.equal(JSON.stringify(s),before);
  s.input_invalidated_operation_ids=[counterId];
  assert.equal(projectWorkReviewV2(s).checked_edit_count,2,'invalidated proof is still excluded');
  s.unresolved_unknown_operation_ids=[typeId];
  assert.equal(projectWorkReviewV2(s).checked_edit_count,1,'unknown effects are still excluded');
});

test('complete inventory requires exact native diagnostics, complete sets and matching retained hash',()=>{
  const f=fixture(), op=f.snapshot.operations[counterId], payload=f.native_applies[counterId];
  assert(nativeChangeInventoryCompleteV2(op,op.result,payload));
  const corruptions:Record<string,(p:any,r:any,o:any)=>void>={
    noTracking:p=>delete p.changeTracking, notExhaustive:p=>p.changeTracking.exhaustiveChangeInventory=false,
    noEvent:p=>p.changeTracking.matchingEventCount=0, failedCapture:p=>p.changeTracking.captureFailureCount=1,
    contradictoryCount:p=>p.changeTracking.eventCount=0, truncated:p=>p.truncated=true,
    missingSet:p=>delete p.transaction.deleted_element_ids, incompleteUnion:p=>p.transaction.modified_element_ids.pop(),
    duplicate:p=>p.transaction.modified_element_ids.push(p.transaction.modified_element_ids[0]),
    invalidId:p=>p.transaction.modified_element_ids[0]=-1, unknown:p=>p.transaction.status='unknown',
    rollback:p=>p.transaction.committed=false, differentAffected:(_,r)=>r.affected_target_identities.pop(),
    wrongHash:(_,r)=>r.raw_payload_hash='a'.repeat(64), modelAuthority:(_,r)=>r.authority='model',
    wrongBinding:(_,r)=>r.binding.generation++, noReceipt:(_,r)=>delete r.receipt_id,
    wrongSignature:(_,r)=>r.request_identity.request_signature='other', preview:(_,r,o)=>o.requested_effect='preview',
    resultUnknown:(_,r)=>r.persistent_effect='unknown', businessFailure:p=>p.success=false
  };
  for(const [name,mutate] of Object.entries(corruptions)){
    const p=structuredClone(payload),o=structuredClone(op),r=o.result;mutate(p,r,o);
    if(name!=='wrongHash')r.raw_payload_hash=createHash('sha256').update(canonicalJsonV2(p)).digest('hex');
    assert.equal(nativeChangeInventoryCompleteV2(o,r,p),false,name);
  }
});

test('later genuine writes, unknowns, unproven inventories and invalidated proofs still require checking',()=>{
  const s=reproject(fixture());
  const changes:Record<string,(s:any)=>void>={
    sameOwner:s=>{
      const template=structuredClone(s.operations[typeId]);
      s.operations.later={...template,operation_id:'later',opened_at:'2099-01-01T00:00:00Z',result:undefined,
        settlement_state:'open',persistent_effect:'unknown',target:{target_id:'element_id:1494957'}};
      s.unresolved_unknown_operation_ids=['later'];
    },
    inFlight:s=>{
      const template=structuredClone(s.operations[typeId]);
      s.operations.later={...template,operation_id:'later',opened_at:'2099-01-01T00:00:00Z',result:undefined,
        settlement_state:'open',persistent_effect:'none',target:{target_id:'id:1494957'}};
      s.in_flight_operation_ids=['later'];
    },
    olderInFlight:s=>{
      const template=structuredClone(s.operations[typeId]);
      s.operations.later={...template,operation_id:'later',opened_at:'2020-01-01T00:00:00Z',result:undefined,
        settlement_state:'open',persistent_effect:'none',target:{target_id:'id:1494957'}};
      s.in_flight_operation_ids=['later'];
    },
    inputInvalidation:s=>s.input_invalidated_operation_ids=[counterId],
    readInvalidation:s=>s.input_invalidated_operation_ids=[s.operations[counterId].verification_operation_ids[0]],
    foreignRead:s=>s.operations[s.operations[counterId].verification_operation_ids[0]].binding.generation++,
    foreignObservation:s=>s.observations[s.operations[s.operations[counterId].verification_operation_ids[0]].observation_ids[0]].authority='model',
    noInventory:s=>{
      // A shared panel edit need not stale a counter Type, but targeting the
      // counter without a complete inventory cannot assert it was unchanged.
      s.operations[typeId].target.semantic_scope.counter='id:1494957';
      for(const oid of s.operations[typeId].observation_ids)s.observations[oid].facts=[];
    }
  };
  for(const [name,mutate] of Object.entries(changes)){
    const copy=structuredClone(s);mutate(copy);
    assert.equal(workReviewRowsV2(copy)[0]!.checked_operation_count,0,name);
    assert.equal(copy.unresolved_unknown_operation_ids.length,name==='sameOwner'?1:0,'review cannot clear unknowns');
  }
  const corrupt=structuredClone(s),later=corrupt.operations[typeId];
  assert(hasCompleteNativeChangeInventoryV2(corrupt,later));
  corrupt.observations[later.observation_ids[0]].raw_payload_hash='other';
  assert.equal(hasCompleteNativeChangeInventoryV2(corrupt,later),false,'a copied completeness fact is not enough');
});
