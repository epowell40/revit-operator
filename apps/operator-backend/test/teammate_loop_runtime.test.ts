import assert from "node:assert/strict";
import test from "node:test";
import { OPERATOR_BACKEND_CONTRACT_VERSION, type ChatRequest, type ChatResponse } from "../src/contracts.js";
import {
  __testOnlyResetTeammateLoopState,
  beginTeammateLoopOwner,
  bindTeammateLoopOwnerTurn,
  buildTeammateTurnContract,
  endTeammateLoopOwner,
  guardGenericTeammateDecision,
  guardTeammateMcpCall,
  recordTeammateMcpResult,
  teammateLoopReceiptForOwner
} from "../src/teammate_loop_runtime.js";

const liveContext = {
  revit: {
    schema: "revit-operator.context.v1",
    source: { live: true },
    process_id: 70412,
    courier_executor_id: "executor-1",
    document: {
      title: "Duke B200",
      path: "C:\\models\\duke-b200.rvt",
      projectIdentity: { fingerprint: "abc123" }
    }
  }
};

function request(user_text: string, tool_results?: ChatRequest["tool_results"]): ChatRequest {
  return {
    version: OPERATOR_BACKEND_CONTRACT_VERSION,
    session_id: "session-1",
    message_id: "message-1",
    user_text,
    context: liveContext,
    ...(tool_results ? { tool_results } : {})
  };
}

function response(actions: ChatResponse["actions"], assistant_message = "Working on it."): ChatResponse {
  return { version: OPERATOR_BACKEND_CONTRACT_VERSION, assistant_message, actions };
}

test("structured contract distinguishes teammate modes and fails closed on stale canonical context", () => {
  const conceptual = buildTeammateTurnContract(request("What does a shock arrestor do?"));
  const location = buildTeammateTurnContract(request("Where are the shock arrestors? Provide a room number for each device."));
  const action = buildTeammateTurnContract(request("Add a shock arrestor to the domestic water piping serving the toilet in room 2968T."));
  const stale = buildTeammateTurnContract({
    user_text: "Add a shock arrestor in room 2968T.",
    context: { revit: { source: { live: false, error: "bridge offline" }, process_id: 70412, document: { title: "Duke", path: "C:\\duke.rvt" } }, ui: { revit_document: { title: "fallback", path: "C:\\fallback.rvt", process_id: 1 } } }
  });
  assert.equal(conceptual.turn_kind, "conversation");
  assert.equal(conceptual.context_state, "not_required");
  assert.equal(location.turn_kind, "inspection");
  assert.equal(action.turn_kind, "mutation");
  assert.equal(action.context_state, "live");
  assert.equal(action.max_apply_attempts, 1);
  assert.equal(action.write_authorized, true);
  assert.equal(buildTeammateTurnContract(request("How can I change the expansion tank size?")).write_authorized, false);
  assert.equal(buildTeammateTurnContract(request("Preview only: update the expansion tank size.")).write_authorized, false);
  assert.equal(stale.context_state, "invalid");
});

test("transaction-plan is preview-only to the teammate loop", () => {
  __testOnlyResetTeammateLoopState();
  const preview = guardGenericTeammateDecision(request("Preview the transaction plan before applying it."), response([{
    action_id: "transaction-plan-preview",
    method: "POST",
    path: "/revit/transaction-plan",
    body: { actions: [{ method: "POST", path: "/revit/set-parameters" }] }
  }]));

  assert.equal(preview.actions.length, 1);
  assert.equal(preview.teammate_loop_receipt?.stage, "preview");
});

test("generic provider loop binds preview to one apply and requires post-apply verification", () => {
  __testOnlyResetTeammateLoopState();
  const text = "Set element 42 Manufacturer to WATTS and keep the model consistent.";
  const preview = guardGenericTeammateDecision(request(text), response([{
    action_id: "preview-1",
    method: "POST",
    path: "/revit/set-parameters",
    body: { elementIds: [42], parameters: { Manufacturer: "WATTS" }, apply: false, dryRun: true }
  }]));
  assert.equal(preview.actions.length, 1);
  assert.equal(preview.teammate_loop_receipt?.stage, "preview");

  const apply = guardGenericTeammateDecision(request(text, [{
    action_id: "preview-1", method: "POST", path: "/revit/set-parameters", status: "done", result_json: { ok: true, dryRun: true }
  }]), response([{
    action_id: "apply-1",
    method: "POST",
    path: "/revit/set-parameters",
    body: { elementIds: [42], parameters: { Manufacturer: "WATTS" }, apply: true, dryRun: false, expectedPlanHash: "plan-1" }
  }]));
  assert.equal(apply.actions.length, 1);
  assert.equal(apply.teammate_loop_receipt?.apply_attempts, 1);

  const verify = guardGenericTeammateDecision(request(text, [{
    action_id: "apply-1", method: "POST", path: "/revit/set-parameters", status: "done", result_json: { ok: true }
  }]), response([{
    action_id: "verify-1",
    method: "POST",
    path: "/revit/get-parameters",
    body: { elementIds: [42], parameterNames: ["Manufacturer"] }
  }]));
  assert.equal(verify.actions.length, 1);
  assert.equal(verify.teammate_loop_receipt?.stage, "verify");

  const complete = guardGenericTeammateDecision(request(text, [{
    action_id: "verify-1", method: "POST", path: "/revit/get-parameters", status: "done", result_json: { ok: true, values: ["WATTS"] }
  }]), response([], "Updated and verified."));
  assert.equal(complete.teammate_loop_receipt?.verified, true);
  assert.equal(complete.teammate_loop_receipt?.stage, "report");
});

test("generic provider loop blocks direct apply, mismatched apply, retry, and no-write mutation", () => {
  __testOnlyResetTeammateLoopState();
  const text = "Set element 42 Manufacturer to WATTS.";
  const direct = guardGenericTeammateDecision(request(text), response([{
    action_id: "apply-direct", method: "POST", path: "/revit/set-parameters",
    body: { elementIds: [42], parameters: { Manufacturer: "WATTS" }, apply: true, dryRun: false }
  }]));
  assert.equal(direct.actions.length, 0);
  assert.equal(direct.teammate_loop_receipt?.blocked_reason, "matching_successful_preview_required");

  __testOnlyResetTeammateLoopState();
  const noWrite = guardGenericTeammateDecision(request("Show what would be affected before deleting element 42."), response([{
    action_id: "delete-apply", method: "POST", path: "/revit/delete", body: { ids: [42], apply: true }
  }]));
  assert.equal(noWrite.actions.length, 0);
  assert.equal(noWrite.teammate_loop_receipt?.apply_attempts, 0);

  __testOnlyResetTeammateLoopState();
  const ambiguous = guardGenericTeammateDecision(request("Fix it"), response([{
    action_id: "read-1", method: "POST", path: "/revit/get-parameters", body: { elementIds: [42] }
  }]));
  assert.equal(ambiguous.actions.length, 0);
  assert.equal(ambiguous.teammate_loop_receipt?.blocked_reason, "material_ambiguity_requires_clarification");
});

test("Codex MCP host guard enforces preview, one apply attempt, and readback", () => {
  __testOnlyResetTeammateLoopState();
  const owner = {};
  const lease = beginTeammateLoopOwner(owner, request("Set element 42 Manufacturer to WATTS."));
  try {
    const preview = guardTeammateMcpCall(owner, {
      tool: "revit_call_tool",
      arguments: { method: "POST", path: "/revit/set-parameters", body: { elementIds: [42], parameters: { Manufacturer: "WATTS" }, apply: false, dryRun: true } }
    });
    assert.equal(preview.allowed, true);
    recordTeammateMcpResult(owner, preview, { content: [{ type: "text", text: JSON.stringify({ ok: true, dryRun: true }) }] });

    const apply = guardTeammateMcpCall(owner, {
      tool: "revit_call_tool",
      arguments: { method: "POST", path: "/revit/set-parameters", body: { elementIds: [42], parameters: { Manufacturer: "WATTS" }, apply: true, dryRun: false, expectedPlanHash: "plan-1" } }
    });
    assert.equal(apply.allowed, true);
    recordTeammateMcpResult(owner, apply, { content: [{ type: "text", text: JSON.stringify({ ok: true }) }] });

    const retry = guardTeammateMcpCall(owner, {
      tool: "revit_call_tool",
      arguments: { method: "POST", path: "/revit/set-parameters", body: { elementIds: [42], parameters: { Manufacturer: "WATTS" }, apply: true, dryRun: false } }
    });
    assert.equal(retry.allowed, false);
    assert.match(retry.message || "", /single apply attempt/i);

    const readback = guardTeammateMcpCall(owner, {
      tool: "revit_call_tool",
      arguments: { method: "POST", path: "/revit/get-parameters", body: { elementIds: [42], parameterNames: ["Manufacturer"] } }
    });
    assert.equal(readback.allowed, true);
    recordTeammateMcpResult(owner, readback, { content: [{ type: "text", text: JSON.stringify({ ok: true, values: ["WATTS"] }) }] });
    assert.equal(teammateLoopReceiptForOwner(owner)?.verified, true);
  } finally {
    endTeammateLoopOwner(lease);
  }
});

test("Codex MCP host guard classifies conditional route bodies by their actual effect", () => {
  __testOnlyResetTeammateLoopState();
  const inspectionOwner = {};
  const inspectionLease = beginTeammateLoopOwner(inspectionOwner, request("Inspect the current audit and type data."));
  try {
    for (const [path, body] of [
      ["/revit/fire-damper-audit", { command: "audit" }],
      ["/revit/lighting-audit", { command: "photometrics", visualize: false }],
      ["/revit/list-element-types", { action: "list", category: "OST_Doors" }]
    ] as const) {
      const gate = guardTeammateMcpCall(inspectionOwner, {
        tool: "revit_call_tool",
        arguments: { method: "POST", path, body }
      });
      assert.equal(gate.allowed, true, `${path} read mode should be allowed`);
      assert.equal(gate.call?.effect, "read");
    }

    for (const [path, body] of [
      ["/revit/fire-damper-audit", { command: "fix", dryRun: true }],
      ["/revit/lighting-audit", { command: "validate_ies", fix: true, dryRun: true }],
      ["/revit/lighting-audit", { command: "photometrics", visualize: true, apply: false }],
      ["/revit/list-element-types", { action: "purge_unused_in_family", familyName: "Air Device", apply: false }]
    ] as const) {
      const gate = guardTeammateMcpCall(inspectionOwner, {
        tool: "revit_call_tool",
        arguments: { method: "POST", path, body }
      });
      assert.equal(gate.allowed, false, `${path} mutation mode should be blocked on an inspection turn`);
      assert.equal(gate.call?.effect, "apply");
      assert.match(gate.message || "", /does not authorize model mutation/i);
    }
  } finally {
    endTeammateLoopOwner(inspectionLease);
  }

  __testOnlyResetTeammateLoopState();
  const mutationOwner = {};
  const mutationLease = beginTeammateLoopOwner(mutationOwner, request("Rename the Air Device family types."));
  try {
    const preview = guardTeammateMcpCall(mutationOwner, {
      tool: "revit_call_tool",
      arguments: {
        method: "POST",
        path: "/revit/list-element-types",
        body: { action: "rename_types", familyName: "Air Device", searchPattern: "^SUP-", dryRun: true }
      }
    });
    assert.equal(preview.allowed, true);
    assert.equal(preview.call?.effect, "preview");
    recordTeammateMcpResult(mutationOwner, preview, {
      content: [{ type: "text", text: JSON.stringify({ ok: true, action: "rename_types", dryRun: true, planned: [{ typeId: 42 }] }) }]
    });

    const apply = guardTeammateMcpCall(mutationOwner, {
      tool: "revit_call_tool",
      arguments: {
        method: "POST",
        path: "/revit/list-element-types",
        body: { action: "rename_types", familyName: "Air Device", searchPattern: "^SUP-", dryRun: false }
      }
    });
    assert.equal(apply.allowed, true);
    assert.equal(apply.call?.effect, "apply");
  } finally {
    endTeammateLoopOwner(mutationLease);
  }
});

test("empty-text continuation preserves the original turn and tool docs are bounded to one call", () => {
  __testOnlyResetTeammateLoopState();
  const text = "Set element 42 Manufacturer to WATTS.";
  const preview = guardGenericTeammateDecision(request(text), response([{
    action_id: "preview-empty",
    method: "POST",
    path: "/revit/set-parameters",
    body: { elementIds: [42], parameters: { Manufacturer: "WATTS" }, apply: false, dryRun: true }
  }]));
  assert.equal(preview.actions.length, 1);
  const continuation = request("", [{
    action_id: "preview-empty", method: "POST", path: "/revit/set-parameters", status: "done", result_json: { ok: true, dryRun: true }
  }]);
  const apply = guardGenericTeammateDecision(continuation, response([{
    action_id: "apply-empty",
    method: "POST",
    path: "/revit/set-parameters",
    body: { elementIds: [42], parameters: { Manufacturer: "WATTS" }, apply: true, dryRun: false }
  }]));
  assert.equal(apply.actions.length, 1);

  __testOnlyResetTeammateLoopState();
  const owner = {};
  const lease = beginTeammateLoopOwner(owner, request("Find the exact tool for the shock arrestor action."));
  try {
    const first = guardTeammateMcpCall(owner, { tool: "revit_tool_doc", arguments: { method: "POST", path: "/revit/set-parameters" } });
    assert.equal(first.allowed, true);
    recordTeammateMcpResult(owner, first, { content: [{ type: "text", text: "{}" }] });
    const second = guardTeammateMcpCall(owner, { tool: "revit_tool_doc", arguments: { method: "POST", path: "/revit/set-parameters" } });
    assert.equal(second.allowed, false);
    assert.match(second.message || "", /already used/i);
  } finally {
    endTeammateLoopOwner(lease);
  }
});

test("verification must read back the applied target and concurrent Codex turns stay isolated", () => {
  __testOnlyResetTeammateLoopState();
  const text = "Set element 42 Manufacturer to WATTS.";
  guardGenericTeammateDecision(request(text), response([{
    action_id: "preview-target", method: "POST", path: "/revit/set-parameters",
    body: { elementIds: [42], parameters: { Manufacturer: "WATTS" }, apply: false, dryRun: true }
  }]));
  guardGenericTeammateDecision(request(text, [{
    action_id: "preview-target", method: "POST", path: "/revit/set-parameters", status: "done", result_json: { ok: true }
  }]), response([{
    action_id: "apply-target", method: "POST", path: "/revit/set-parameters",
    body: { elementIds: [42], parameters: { Manufacturer: "WATTS" }, apply: true, dryRun: false }
  }]));
  guardGenericTeammateDecision(request(text, [{
    action_id: "apply-target", method: "POST", path: "/revit/set-parameters", status: "done", result_json: { ok: true }
  }]), response([{
    action_id: "unrelated-read", method: "POST", path: "/revit/get-parameters", body: { elementIds: [99], parameterNames: ["Manufacturer"] }
  }]));
  const unrelated = guardGenericTeammateDecision(request(text, [{
    action_id: "unrelated-read", method: "POST", path: "/revit/get-parameters", status: "done", result_json: { ok: true }
  }]), response([], "Done."));
  assert.equal(unrelated.teammate_loop_receipt?.verified, false);
  assert.equal(unrelated.teammate_loop_receipt?.blocked_reason, "post_apply_verification_required");

  __testOnlyResetTeammateLoopState();
  const owner = {};
  const leaseA = beginTeammateLoopOwner(owner, { ...request("Preview element 42 before changing it."), message_id: "message-a" });
  const leaseB = beginTeammateLoopOwner(owner, { ...request("Preview element 99 before changing it."), message_id: "message-b" });
  try {
    bindTeammateLoopOwnerTurn(leaseA, "turn-a");
    bindTeammateLoopOwnerTurn(leaseB, "turn-b");
    const gateA = guardTeammateMcpCall(owner, { turnId: "turn-a", tool: "revit_call_tool", arguments: { method: "POST", path: "/revit/delete", body: { ids: [42], apply: false, dryRun: true } } });
    const gateB = guardTeammateMcpCall(owner, { turnId: "turn-b", tool: "revit_call_tool", arguments: { method: "POST", path: "/revit/delete", body: { ids: [99], apply: false, dryRun: true } } });
    assert.equal(gateA.allowed, true);
    assert.equal(gateB.allowed, true);
    assert.notEqual(gateA.state, gateB.state);
  } finally {
    endTeammateLoopOwner(leaseA);
    endTeammateLoopOwner(leaseB);
  }
});

test("continuation identity, transaction binding, and expected-value verification fail closed", () => {
  __testOnlyResetTeammateLoopState();
  const text = "Set element 42 Manufacturer to WATTS.";
  guardGenericTeammateDecision(request(text), response([{
    action_id: "preview-identity", method: "POST", path: "/revit/set-parameters",
    body: { elementIds: [42], parameters: { Manufacturer: "WATTS" }, apply: false, dryRun: true }
  }]));
  const changedContext = {
    ...request("", [{ action_id: "preview-identity", method: "POST" as const, path: "/revit/set-parameters", status: "done" as const, result_json: { ok: true } }]),
    context: { revit: { source: { live: true }, process_id: 70412, document: { title: "Other Model", path: "C:\\models\\other.rvt" } } }
  };
  const changedApply = guardGenericTeammateDecision(changedContext, response([{
    action_id: "apply-identity", method: "POST", path: "/revit/set-parameters",
    body: { elementIds: [42], parameters: { Manufacturer: "WATTS" }, apply: true, dryRun: false }
  }]));
  assert.equal(changedApply.actions.length, 0);
  assert.equal(changedApply.teammate_loop_receipt?.context_state, "invalid");

  __testOnlyResetTeammateLoopState();
  const owner = {};
  const lease = beginTeammateLoopOwner(owner, request("Delete element 42."));
  try {
    const plan = guardTeammateMcpCall(owner, { tool: "revit_transaction_plan", arguments: { actions: [{ kind: "delete", ids: [42] }] } });
    assert.equal(plan.allowed, true);
    recordTeammateMcpResult(owner, plan, { content: [{ type: "text", text: JSON.stringify({ ok: true, status: "Dry Run" }) }] });
    const apply = guardTeammateMcpCall(owner, { tool: "revit_transaction_apply", arguments: { actions: [{ kind: "delete", ids: [42] }] } });
    assert.equal(apply.allowed, true);
  } finally {
    endTeammateLoopOwner(lease);
  }

  __testOnlyResetTeammateLoopState();
  guardGenericTeammateDecision(request(text), response([{
    action_id: "preview-value", method: "POST", path: "/revit/set-parameters",
    body: { elementIds: [42], parameters: { Manufacturer: "WATTS" }, apply: false, dryRun: true }
  }]));
  guardGenericTeammateDecision(request(text, [{ action_id: "preview-value", method: "POST", path: "/revit/set-parameters", status: "done", result_json: { ok: true } }]), response([{
    action_id: "apply-value", method: "POST", path: "/revit/set-parameters",
    body: { elementIds: [42], parameters: { Manufacturer: "WATTS" }, apply: true, dryRun: false }
  }]));
  guardGenericTeammateDecision(request(text, [{ action_id: "apply-value", method: "POST", path: "/revit/set-parameters", status: "done", result_json: { ok: true } }]), response([{
    action_id: "wrong-value", method: "POST", path: "/revit/get-parameters", body: { elementIds: [42], parameterNames: ["Manufacturer"] }
  }]));
  const wrongValue = guardGenericTeammateDecision(request(text, [{ action_id: "wrong-value", method: "POST", path: "/revit/get-parameters", status: "done", result_json: { ok: true, values: ["JOSAM"] } }]), response([], "Verified."));
  assert.equal(wrongValue.teammate_loop_receipt?.verified, false);
});
