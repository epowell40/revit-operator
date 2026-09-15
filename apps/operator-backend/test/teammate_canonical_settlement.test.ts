import assert from "node:assert/strict";
import test from "node:test";
import { canonicalNativeRollbackForTeammate } from "../src/teammate_canonical_settlement.js";
import { beginTeammateLoopOwner, endTeammateLoopOwner, guardTeammateMcpCall, recordTeammateMcpResult,
  reconcileTeammateCanonicalSettlementV2, teammateLoopReceiptForOwner, __testOnlyResetTeammateLoopState } from "../src/teammate_loop_runtime.js";

const path = "/revit/create-view";
const body = { action: "create_floor_plan", name: "Coordination", levelName: "Level 2", dryRun: false };
function operation(): any {
  const binding = { assignment_id: "assignment", run_id: "run", generation: 1, session_id: "session", principal_id: "principal", document_fingerprint: "model" };
  const identity = { capability_id: "revit_call_tool", method: "POST", path, request_signature: "signature" };
  return { schema: "revit-operator.operation/v2", operation_id: "operation", binding, requested_effect: "apply",
    input: { method: "POST", path, body }, request_identity: identity, admission_state: "admitted", dispatch_state: "dispatched",
    settlement_state: "settled", persistent_effect: "none", result: { schema: "revit-operator.operation-result/v2", operation_id: "operation",
      binding: { ...binding }, request_identity: { ...identity }, status: "failed_after_dispatch", dispatch_state: "dispatched", persistent_effect: "none",
      native_transaction_state: "rolled_back", authority: "native-host", receipt_id: "receipt", native_correlation_id: "receipt" } };
}

test("only a matching retained native rollback can release the compatibility fence", () => {
  assert.equal(canonicalNativeRollbackForTeammate(operation(), "session", path), true);
  const changes: Array<(o: any) => void> = [
    o => { o.persistent_effect = "unknown"; }, o => { o.result.persistent_effect = "unknown"; },
    o => { o.result.native_transaction_state = "committed"; }, o => { o.result.native_transaction_state = "unknown"; },
    o => { o.result.native_transaction_state = "not_applicable"; }, o => { o.result.status = "succeeded"; },
    o => { o.result.status = "timed_out"; }, o => { o.result.authority = "model"; },
    o => { o.settlement_state = "awaiting_result"; }, o => { o.result.operation_id = "foreign"; },
    o => { o.result.binding.generation++; }, o => { o.binding.session_id = "foreign"; },
    o => { o.result.request_identity.request_signature = "foreign"; }, o => { o.result.request_identity.path = "/revit/delete-elements"; },
    o => { delete o.result.receipt_id; }, o => { o.result.native_correlation_id = "foreign"; }
  ];
  for (const change of changes) { const value = operation(); change(value); assert.equal(canonicalNativeRollbackForTeammate(value, "session", path), false); }
});

test("canonical rollback permits corrected arguments, keeps attempts counted and does not verify work", () => {
  __testOnlyResetTeammateLoopState();
  const owner = {};
  const lease = beginTeammateLoopOwner(owner, { version: "operator.backend.v1", session_id: "session", message_id: "message",
    user_text: "Create a mechanical coordination plan called Coordination.",
    context: { revit: { process_id: 4242, source: { live: true }, document: { title: "Model", projectIdentity: { fingerprint: "model" } } } }
  } as any);
  try {
    const first = guardTeammateMcpCall(owner, { tool: "revit_call_tool", arguments: { method: "POST", path, body } });
    assert.equal(first.allowed, true);
    recordTeammateMcpResult(owner, first, { isError: true, content: [{ type: "text", text: '{"transaction":{"status":"rolled_back"}}' }] });
    const otherInput = operation(); otherInput.input = { method: "POST", path, body: { ...body, levelName: "L3" } };
    assert.equal(reconcileTeammateCanonicalSettlementV2(first, otherInput), false);
    assert.equal(reconcileTeammateCanonicalSettlementV2(first, operation()), true);
    assert.equal(reconcileTeammateCanonicalSettlementV2(first, operation()), false, "a stale gate cannot release a later attempt");
    const receipt = teammateLoopReceiptForOwner(owner)!;
    assert.equal(receipt.apply_attempts, 1);
    assert.equal(receipt.verified, false);
    const next = guardTeammateMcpCall(owner, { tool: "revit_call_tool", arguments: { method: "POST", path, body: { ...body, levelName: "L2" } } });
    assert.equal(next.allowed, true);
    assert.equal(teammateLoopReceiptForOwner(owner)!.apply_attempts, 2);
  } finally { endTeammateLoopOwner(lease); }
});

test("raw status success cannot prevent authoritative rollback or release an uncertain neighbor", () => {
  __testOnlyResetTeammateLoopState();
  const owner = {};
  const lease = beginTeammateLoopOwner(owner, { version: "operator.backend.v1", session_id: "session", message_id: "status-only",
    user_text: "Create a mechanical coordination plan called Coordination.",
    context: { revit: { process_id: 4242, source: { live: true }, document: { title: "Model", projectIdentity: { fingerprint: "model" } } } }
  } as any);
  try {
    const first = guardTeammateMcpCall(owner, { tool: "revit_call_tool", arguments: { method: "POST", path, body } });
    assert.equal(first.allowed, true);
    recordTeammateMcpResult(owner, first, { content: [{ type: "text", text: '{"status":"Blocked","transaction":{"status":"rolled_back"}}' }] });
    for (const change of [
      (o: any) => { o.result.native_transaction_state = "unknown"; },
      (o: any) => { o.result.native_transaction_state = "committed"; o.result.persistent_effect = "applied"; },
      (o: any) => { o.result.binding.generation++; },
      (o: any) => { o.result.native_correlation_id = "foreign"; },
      (o: any) => { o.input.body = { ...body, levelName: "another-level" }; }
    ]) {
      const value = operation(); change(value);
      assert.equal(reconcileTeammateCanonicalSettlementV2(first, value), false);
    }
    const corrected = { tool: "revit_call_tool", arguments: { method: "POST", path, body: { ...body, levelName: "L2" } } };
    assert.equal(guardTeammateMcpCall(owner, corrected).allowed, false, "raw rollback prose does not authorize retry");
    assert.equal(reconcileTeammateCanonicalSettlementV2(first, operation()), true);
    assert.equal(teammateLoopReceiptForOwner(owner)!.verified, false);
    const second = guardTeammateMcpCall(owner, corrected);
    assert.equal(second.allowed, true);
    assert.equal(reconcileTeammateCanonicalSettlementV2(first, operation()), false, "stale receipt cannot clear the next operation");
    assert.equal(guardTeammateMcpCall(owner, corrected).allowed, false);
    assert.equal(teammateLoopReceiptForOwner(owner)!.apply_attempts, 2);
  } finally { endTeammateLoopOwner(lease); }
});
