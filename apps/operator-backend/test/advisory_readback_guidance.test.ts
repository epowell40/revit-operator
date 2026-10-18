import assert from "node:assert/strict";
import test from "node:test";
import { codexAssignmentEvidenceContextV2 } from "../src/brains/codex_assignment_evidence.js";
import {desktopAssignmentFeedbackInputV2} from '../src/desktop_assignment_feedback.js';
const binding = { session_id: "s", assignment_id: "a", run_id: "r", generation: 1, principal_id: "p", document_fingerprint: "d" };
function fixture(): any {
  return { spec: { execution_policy: { mode: "local_advisory_v1" } }, current_binding: binding,
    unresolved_unknown_operation_ids: [], in_flight_operation_ids: [], input_invalidated_operation_ids: [],
    observations: { o: { observation_id: "o", operation_id: "edit", binding, observed_at: "2026-01-01T00:00:00Z", raw_payload_ref: "evidence:retained" } },
    operations: { edit: { operation_id: "edit", binding, requested_effect: "apply", persistent_effect: "applied", settlement_state: "settled",
      verification_operation_ids: [], capability_id: "operator_revit_request", request_identity: { path: "/revit/duplicate-view" }, target: { target_id: "view:23" },
      result: { status: "succeeded", authority: "native-host", native_transaction_state: "committed", affected_target_identities: ["element_id:456"] } } } };
}
test("advisory agent receives exact committed targets and readback guidance without completion authority", () => {
  const s=fixture(),before=JSON.stringify(s),index=JSON.parse(codexAssignmentEvidenceContextV2(s));
  assert.equal(index.schema,"revit-operator.advisory-observation-index/v1");
  assert.deepEqual(index.pending_verification[0].affected_targets,["element_id:456"]);
  assert.match(index.pending_verification[0].guidance,/view-owned-detailing/);
  assert.match(index.usage,/not reapplying/); assert.match(index.usage,/does not certify task completion/);
  assert.equal(index.observations[0].eligible_criterion_ids,undefined);
  assert.equal(JSON.stringify(s),before);
});
test("advisory hints exclude unknown, unsettled, read-only and stale-generation operations",()=>{
  for(const delta of [{persistent_effect:"unknown"},{settlement_state:"open"},{requested_effect:"read"},{binding:{...binding,generation:2}}]){
    const s=fixture();Object.assign(s.operations.edit,delta);
    assert.deepEqual(JSON.parse(codexAssignmentEvidenceContextV2(s)).pending_verification,[]);
  }
});
test("changed intent retains history without prompting restoration of the obsolete edit",()=>{
  const s=fixture();s.input_invalidated_operation_ids=['edit'];const before=JSON.stringify(s);
  const index=JSON.parse(codexAssignmentEvidenceContextV2(s));
  assert.deepEqual(index.pending_verification,[]);assert.equal(index.observations.length,1);
  assert.match(index.usage,/not a request to restore old intent/);assert.equal(JSON.stringify(s),before);
});
test("advisory hints are bounded and require native observation context",()=>{
  const s=fixture();for(let i=0;i<20;i++)s.operations['extra'+i]={...s.operations.edit,operation_id:'extra'+i};
  assert.equal(JSON.parse(codexAssignmentEvidenceContextV2(s)).pending_verification.length,8);
  s.observations={};assert.equal(codexAssignmentEvidenceContextV2(s),'');
});

test('large native transaction inventories stay retrievable without being repeated in every worker and desktop context',()=>{
 const s=fixture();s.provider_calls={};s.spec.created_at='2026-01-01T00:00:00Z';s.spec.requested_effect='apply';
 Object.assign(s.spec.execution_policy,{max_provider_calls:64,max_total_tokens:8000000,max_operations:256,max_wall_clock_ms:1200000});
 Object.assign(s.operations.edit,{opened_at:'2026-01-01T00:00:00Z',settled_at:'2026-01-01T00:00:01Z'});
 s.operations.edit.result.affected_target_identities=Array.from({length:4096},(_,i)=>`element_id:${100000+i}`);
 Object.assign(s.observations.o,{authority:'native-host',raw_payload_hash:'a'.repeat(64)});
 s.operations.edit.result.raw_payload_hash='a'.repeat(64);
 const before=JSON.stringify(s),index=JSON.parse(codexAssignmentEvidenceContextV2(s)),hint=index.pending_verification[0];
 assert.deepEqual(hint.affected_targets,s.operations.edit.result.affected_target_identities.slice(0,16));
 assert.equal(hint.target_id,'view:23');assert.deepEqual(hint.affected_targets_projection,
  {total_count:4096,returned_count:16,complete:false,evidence_id:'retained',usage:'Index sample only when incomplete. Retrieve the retained native result for the full affected inventory; never infer unlisted targets or repeat the edit.'});
 assert(Buffer.byteLength(JSON.stringify(index))<6000);
 const outer=desktopAssignmentFeedbackInputV2([],s),wire=JSON.stringify(outer);
 assert(Buffer.byteLength(wire)<9000);assert.match(wire,/retained/);assert.doesNotMatch(wire,/element_id:104095/);
 assert.equal(s.operations.edit.result.affected_target_identities.length,4096);assert.equal(JSON.stringify(s),before);
 s.observations.o.authority='untrusted-caller';
 const stale=JSON.parse(codexAssignmentEvidenceContextV2(s));
 assert.equal(stale.pending_verification?.[0]?.affected_targets_projection.evidence_id,null);
});
test("schedule guidance separates definition, complete contents and placement evidence",()=>{
  const s=fixture();s.operations.edit.request_identity.path="/revit/create-schedule";
  const hint=JSON.parse(codexAssignmentEvidenceContextV2(s)).pending_verification[0];
  assert.match(hint.guidance,/scheduleId/);assert.match(hint.guidance,/ordered field names and hidden flags/);
  assert.match(hint.guidance,/truncated row sample cannot establish all contents/);
  assert.match(hint.guidance,/does not prove sheet placement/);
  assert.equal(hint.next_inspection,null);
});
