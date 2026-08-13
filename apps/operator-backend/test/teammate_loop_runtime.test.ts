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
  reconcileTeammateReceiptWithAssistant,
  recordTeammateMcpResult,
  teammateLoopReceiptForOwner
} from "../src/teammate_loop_runtime.js";

test("verified mutation stages may continue while retries and unverified chaining remain blocked", () => {
  __testOnlyResetTeammateLoopState();
  const owner = {};
  const lease = beginTeammateLoopOwner(owner, request("Set element 42 Manufacturer to WATTS, then set element 43 Manufacturer to JOSAM."));
  try {
    const run = (argumentsValue: Record<string, unknown>) => guardTeammateMcpCall(owner, { tool: "revit_call_tool", arguments: argumentsValue });
    const record = (gate: ReturnType<typeof run>, body: unknown) => recordTeammateMcpResult(owner, gate, { content: [{ type: "text", text: JSON.stringify(body) }] });
    const firstPreview = run({ method: "POST", path: "/revit/set-parameters", body: { elementIds: [42], parameters: { Manufacturer: "WATTS" }, dryRun: true } });
    assert.equal(firstPreview.allowed, true);
    record(firstPreview, { ok: true, dryRun: true });
    const firstApply = run({ method: "POST", path: "/revit/set-parameters", body: { elementIds: [42], parameters: { Manufacturer: "WATTS" }, dryRun: false, apply: true } });
    assert.equal(firstApply.allowed, true);
    record(firstApply, { ok: true, elementIds: [42] });
    const firstRead = run({ method: "POST", path: "/revit/get-parameters", body: { elementIds: [42], parameterNames: ["Manufacturer"] } });
    record(firstRead, { ok: true, elementIds: [42], values: ["WATTS"] });
    assert.equal(teammateLoopReceiptForOwner(owner)?.verified, true);

    const secondPreview = run({ method: "POST", path: "/revit/set-parameters", body: { elementIds: [43], parameters: { Manufacturer: "JOSAM" }, dryRun: true } });
    assert.equal(secondPreview.allowed, true);
    record(secondPreview, { ok: true, dryRun: true });
    const secondApply = run({ method: "POST", path: "/revit/set-parameters", body: { elementIds: [43], parameters: { Manufacturer: "JOSAM" }, dryRun: false, apply: true } });
    assert.equal(secondApply.allowed, true);
    record(secondApply, { ok: true, elementIds: [43] });
    const secondRead = run({ method: "POST", path: "/revit/get-parameters", body: { elementIds: [43], parameterNames: ["Manufacturer"] } });
    record(secondRead, { ok: true, elementIds: [43], values: ["JOSAM"] });
    const finalReceipt = teammateLoopReceiptForOwner(owner);
    assert.equal(finalReceipt?.apply_attempts, 2);
    assert.equal(finalReceipt?.verified, true);
  } finally {
    endTeammateLoopOwner(lease);
  }
});

test("an assistant report of an incomplete mutation overrides an optimistic receipt", () => {
  const receipt = reconcileTeammateReceiptWithAssistant({
    schema: "revit-operator.teammate-loop-receipt.v1",
    turn_kind: "mutation",
    context_state: "live",
    stage: "report",
    preview_action_ids: ["mcp:1"],
    apply_action_id: "mcp:2",
    verification_action_ids: ["mcp:3"],
    apply_attempts: 1,
    verified: true,
    blocked_reason: null
  }, "The assignment is blocked. The requested new assignment is not yet complete.");
  assert.equal(receipt?.stage, "blocked");
  assert.equal(receipt?.verified, false);
  assert.equal(receipt?.blocked_reason, "assistant_reported_incomplete");
});

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
  assert.equal(action.max_apply_attempts, 32);
  assert.equal(action.write_authorized, true);
  assert.equal(buildTeammateTurnContract(request("For EPIC-0443 acceptance testing in this sample model, change sheet M000 from Cover Sheet to Test Cover Sheet.")).write_authorized, true);
  assert.equal(buildTeammateTurnContract(request("How can I change the expansion tank size?")).write_authorized, false);
  assert.equal(buildTeammateTurnContract(request("For planning, explain how to change the expansion tank size.")).write_authorized, false);
  assert.equal(buildTeammateTurnContract(request("Preview only: update the expansion tank size.")).write_authorized, false);
  assert.equal(stale.context_state, "invalid");
});

test("ordinary Revit mutation verbs authorize writes instead of silently forcing inspection", () => {
  const prompts = [
    "Duplicate sheet M000 and give the new sheet the next available temporary number.",
    "Apply the TEST HVAC COORDINATION TEMPLATE to the coordination view.",
    "Hide Rooms in the active view and leave every other category unchanged.",
    "Filter the equipment schedule so Mark begins with AHU.",
    "Sort the schedule by Level and then Family and Type.",
    "Rotate the selected annotation ninety degrees.",
    "Offset the selected duct around the obstruction.",
    "Reload the edited equipment family and assign its TEST-ONLY type.",
    "Reduce the selected duct after the takeoff.",
    "In the active view, make existing ductwork halftone.",
    "In this disposable Snowdon test model, duplicate sheet M000 as Z-OP-001; otherwise create it with the same title block and explain the difference."
  ];
  for (const prompt of prompts) {
    const contract = buildTeammateTurnContract(request(prompt));
    assert.equal(contract.turn_kind, "mutation", prompt);
    assert.equal(contract.write_authorized, true, prompt);
    assert.equal(contract.preview_required, false, prompt);
    assert.equal(contract.verification_required, true, prompt);
  }
  assert.equal(buildTeammateTurnContract(request("Show me sheet M000.")).turn_kind, "navigation");
  assert.equal(buildTeammateTurnContract(request("How should we duplicate sheets?")).write_authorized, false);
});

test("benchmark-safe read and preview prompts remain live Revit work, not conceptual conversation", () => {
  const prompts = [
    "Count all air devices in the project and break the total down by family and type. You may inspect an existing air-device schedule. Do not change the model.",
    "Find one mechanical-equipment instance whose Mark is writable, preview changing only that instance's Mark to TEST-AHU-01, and report the exact target and readback plan. Do not apply the change."
  ];
  for (const prompt of prompts) {
    const contract = buildTeammateTurnContract(request(prompt));
    assert.equal(contract.turn_kind, "inspection", prompt);
    assert.equal(contract.context_state, "live", prompt);
    assert.equal(contract.no_write, true, prompt);
    assert.equal(contract.stage, "discover", prompt);
  }
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

test("generic provider loop permits atomic direct apply while retaining explicit no-write and ambiguity limits", () => {
  __testOnlyResetTeammateLoopState();
  const text = "Set element 42 Manufacturer to WATTS.";
  const direct = guardGenericTeammateDecision(request(text), response([{
    action_id: "apply-direct", method: "POST", path: "/revit/set-parameters",
    body: { elementIds: [42], parameters: { Manufacturer: "WATTS" }, apply: true, dryRun: false }
  }]));
  assert.equal(direct.actions.length, 1);
  assert.equal(direct.teammate_loop_receipt?.apply_attempts, 1);
  assert.equal(direct.teammate_loop_receipt?.blocked_reason, null);

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

test("atomic Revit primitives may advance through distinct verified writes without preview twins", () => {
  __testOnlyResetTeammateLoopState();
  const owner = {};
  const lease = beginTeammateLoopOwner(owner, request("Duplicate view 9948 as OPERATOR SMOKE HVAC PLAN."));
  try {
    const apply = guardTeammateMcpCall(owner, {
      tool: "revit_call_tool",
      arguments: {
        method: "POST",
        path: "/revit/duplicate-view",
        body: { viewId: 9948, newName: "OPERATOR SMOKE HVAC PLAN", withDetailing: false }
      }
    });
    assert.equal(apply.allowed, true);
    assert.equal(apply.call?.effect, "apply");
    recordTeammateMcpResult(owner, apply, {
      content: [{ type: "text", text: JSON.stringify({ status: "Success", sourceViewId: 9948, view: { id: 1543100, name: "OPERATOR SMOKE HVAC PLAN" } }) }]
    });
    assert.equal(teammateLoopReceiptForOwner(owner)?.verified, true);

    const hideRooms = guardTeammateMcpCall(owner, {
      tool: "revit_call_tool",
      arguments: {
        method: "POST",
        path: "/revit/visibility",
        body: { action: "hide_category", viewId: 1543100, categoryName: "Rooms", dryRun: false }
      }
    });
    assert.equal(hideRooms.allowed, true);
    assert.equal(hideRooms.call?.effect, "apply");
    recordTeammateMcpResult(owner, hideRooms, {
      content: [{ type: "text", text: JSON.stringify({ status: "Success", view: { id: 1543100 }, category: { name: "Rooms", hidden: true } }) }]
    });
    assert.equal(teammateLoopReceiptForOwner(owner)?.apply_attempts, 2);
    assert.equal(teammateLoopReceiptForOwner(owner)?.verified, true);

    const verify = guardTeammateMcpCall(owner, {
      tool: "revit_list_views",
      arguments: { viewId: 1543100, includeTemplates: true }
    });
    assert.equal(verify.allowed, true);
    recordTeammateMcpResult(owner, verify, {
      content: [{ type: "text", text: JSON.stringify({ status: "Ok", views: [{ id: 1543100, name: "OPERATOR SMOKE HVAC PLAN", viewType: "FloorPlan" }] }) }]
    });
    assert.equal(teammateLoopReceiptForOwner(owner)?.verified, true);
  } finally {
    endTeammateLoopOwner(lease);
  }
});

test("Codex MCP host guard supports preview while blocking an unverified repeated apply", () => {
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
    assert.match(retry.message || "", /prior apply verification/i);

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

test("Codex MCP host guard treats serialized HTTP bodies like object bodies", () => {
  __testOnlyResetTeammateLoopState();
  const owner = {};
  const lease = beginTeammateLoopOwner(owner, request("Set element 42 Manufacturer to WATTS."));
  try {
    const preview = guardTeammateMcpCall(owner, {
      tool: "revit_call_tool",
      arguments: {
        method: "POST",
        path: "/revit/set-parameters",
        body: JSON.stringify({ elementIds: [42], parameters: { Manufacturer: "WATTS" }, apply: false, dryRun: true })
      }
    });
    assert.equal(preview.allowed, true);
    assert.equal(preview.call?.effect, "preview");
    recordTeammateMcpResult(owner, preview, { content: [{ type: "text", text: JSON.stringify({ ok: true, dryRun: true }) }] });

    const apply = guardTeammateMcpCall(owner, {
      tool: "revit_call_tool",
      arguments: {
        method: "POST",
        path: "/revit/set-parameters",
        body: JSON.stringify({ elementIds: [42], parameters: { Manufacturer: "WATTS" }, apply: true, dryRun: false })
      }
    });
    assert.equal(apply.allowed, true);
    assert.equal(apply.call?.effect, "apply");
  } finally {
    endTeammateLoopOwner(lease);
  }
});

test("Codex MCP host guard accepts independently returned target identity during readback", () => {
  __testOnlyResetTeammateLoopState();
  const owner = {};
  const lease = beginTeammateLoopOwner(owner, request("Set element 42 Manufacturer to WATTS."));
  try {
    const preview = guardTeammateMcpCall(owner, {
      tool: "revit_set_parameters",
      arguments: { changes: [{ elementId: 42, parameterName: "Manufacturer", value: "WATTS" }], dryRun: true, apply: false }
    });
    assert.equal(preview.allowed, true);
    recordTeammateMcpResult(owner, preview, { content: [{ type: "text", text: JSON.stringify({ ok: true, dryRun: true }) }] });

    const apply = guardTeammateMcpCall(owner, {
      tool: "revit_set_parameters",
      arguments: { changes: [{ elementId: 42, parameterName: "Manufacturer", value: "WATTS" }], dryRun: false, apply: true }
    });
    assert.equal(apply.allowed, true);
    recordTeammateMcpResult(owner, apply, { content: [{ type: "text", text: JSON.stringify({ ok: true }) }] });

    const readback = guardTeammateMcpCall(owner, {
      tool: "revit_list_elements",
      arguments: { query: "target element" }
    });
    assert.equal(readback.allowed, true);
    recordTeammateMcpResult(owner, readback, {
      content: [{ type: "text", text: JSON.stringify({ ok: true, elements: [{ elementId: 42, Manufacturer: "WATTS" }] }) }]
    });
    assert.equal(teammateLoopReceiptForOwner(owner)?.verified, true);
  } finally {
    endTeammateLoopOwner(lease);
  }
});

test("Codex MCP host guard admits host-owned discovery and strategy tools", () => {
  __testOnlyResetTeammateLoopState();
  const owner = {};
  const lease = beginTeammateLoopOwner(owner, request("Count the air devices in this project by type."));
  try {
    for (const tool of ["operator_discover_capabilities", "operator_record_execution_strategy"]) {
      const gate = guardTeammateMcpCall(owner, { tool, arguments: { need: "air device inventory" } });
      assert.equal(gate.allowed, true, `${tool} should be admitted as host-owned discovery`);
      assert.equal(gate.call?.effect, "discovery");
      recordTeammateMcpResult(owner, gate, { content: [{ type: "text", text: "{}" }] });
    }
  } finally {
    endTeammateLoopOwner(lease);
  }
});

test("a successful live context discovery repairs an initially missing turn context", () => {
  __testOnlyResetTeammateLoopState();
  const owner = {};
  const lease = beginTeammateLoopOwner(owner, { ...request("Count the air devices in this project by type."), context: {} });
  try {
    const initiallyBlocked = guardTeammateMcpCall(owner, {
      tool: "revit_call_tool",
      arguments: { method: "POST", path: "/revit/find-elements", body: { category: "OST_DuctTerminal", limit: 10000 } }
    });
    assert.equal(initiallyBlocked.allowed, false);
    assert.match(initiallyBlocked.message || "", /live revit context required/i);

    const contextGate = guardTeammateMcpCall(owner, { tool: "revit_get_context", arguments: {} });
    assert.equal(contextGate.allowed, true);
    recordTeammateMcpResult(owner, contextGate, {
      content: [{ type: "text", text: JSON.stringify({
        version: "Autodesk Revit 2024",
        process_id: 15096,
        courier_executor_id: "DESKTOP-LE40HOT-revit-courier-15096",
        document: {
          title: "Snowdon Towers Sample HVAC",
          path: "C:\\models\\snowdon-hvac.rvt",
          projectIdentity: { fingerprint: "bda089a9" }
        }
      }) }]
    });

    assert.equal(teammateLoopReceiptForOwner(owner)?.context_state, "live");
    const recoveredQuery = guardTeammateMcpCall(owner, {
      tool: "revit_call_tool",
      arguments: { method: "POST", path: "/revit/find-elements", body: { category: "OST_DuctTerminal", limit: 10000 } }
    });
    assert.equal(recoveredQuery.allowed, true);
    assert.equal(recoveredQuery.call?.effect, "read");
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

test("empty-text continuation preserves the original turn and tool discovery may inspect multiple contracts", () => {
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
    assert.equal(second.allowed, true);
    assert.equal(second.call?.effect, "discovery");
  } finally {
    endTeammateLoopOwner(lease);
  }
});

test("native mutation rollback preview binds the matching commit call", () => {
  __testOnlyResetTeammateLoopState();
  const owner = {};
  const lease = beginTeammateLoopOwner(owner, request("Duplicate sheet M000 with its eligible placed views."));
  const operations = [
    { id: "active_view", op: "get_property", target: "doc", property: "ActiveView" },
    { id: "new_sheet_id", op: "call", memberId: "method:Autodesk.Revit.DB.ViewSheet.Duplicate(Autodesk.Revit.DB.SheetDuplicateOption)", target: "$active_view", args: ["DuplicateSheetWithViewsOnly"] }
  ];
  try {
    const preview = guardTeammateMcpCall(owner, {
      tool: "revit_call_tool",
      arguments: {
        method: "POST", path: "/revit/native-api-mutation-ops",
        body: { operations, returns: ["new_sheet_id"], transaction: { mode: "rollback", name: "Preview duplicate", maxAffectedElements: 64, allowCreate: true, allowedExistingElementIds: [1420963] } }
      }
    });
    assert.equal(preview.allowed, true);
    assert.equal(preview.call?.effect, "preview");
    recordTeammateMcpResult(owner, preview, {
      content: [{ type: "text", text: JSON.stringify({ ok: true, transaction: { status: "rolled_back", committed: false }, results: { new_sheet_id: 1543000 } }) }]
    });

    const apply = guardTeammateMcpCall(owner, {
      tool: "revit_call_tool",
      arguments: {
        method: "POST", path: "/revit/native-api-mutation-ops",
        body: { operations, returns: ["new_sheet_id"], transaction: { mode: "commit", name: "Duplicate M000", maxAffectedElements: 64, allowCreate: true, allowedExistingElementIds: [1420963] } }
      }
    });
    assert.equal(apply.allowed, true);
    assert.equal(apply.call?.effect, "apply");
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

test("created resource identity from apply binds a substantive post-apply readback", () => {
  __testOnlyResetTeammateLoopState();
  const owner = {};
  const lease = beginTeammateLoopOwner(owner, request("Create schedule TEST MECHANICAL EQUIPMENT."));
  try {
    const preview = guardTeammateMcpCall(owner, {
      tool: "revit_call_tool",
      arguments: { method: "POST", path: "/revit/create-schedule", body: { name: "TEST MECHANICAL EQUIPMENT", dryRun: true } }
    });
    assert.equal(preview.allowed, true);
    recordTeammateMcpResult(owner, preview, { content: [{ type: "text", text: JSON.stringify({ status: "Dry Run" }) }] });
    const apply = guardTeammateMcpCall(owner, {
      tool: "revit_call_tool",
      arguments: { method: "POST", path: "/revit/create-schedule", body: { name: "TEST MECHANICAL EQUIPMENT", dryRun: false } }
    });
    assert.equal(apply.allowed, true);
    recordTeammateMcpResult(owner, apply, { content: [{ type: "text", text: JSON.stringify({ status: "Success", schedule: { id: 1542917, name: "TEST MECHANICAL EQUIPMENT" } }) }] });
    const verify = guardTeammateMcpCall(owner, {
      tool: "revit_list_schedules",
      arguments: { action: "detail", scheduleId: 1542917, includeFields: true }
    });
    assert.equal(verify.allowed, true);
    recordTeammateMcpResult(owner, verify, { content: [{ type: "text", text: JSON.stringify({ status: "Ok", schedule: { id: 1542917, name: "TEST MECHANICAL EQUIPMENT", fieldCount: 4 } }) }] });
    const receipt = teammateLoopReceiptForOwner(owner);
    assert.equal(receipt?.verified, true);
    assert.equal(receipt?.stage, "report");
    assert.equal(receipt?.blocked_reason, null);
  } finally {
    endTeammateLoopOwner(lease);
  }
});

test("focused exported-view capture filename verifies a newly created view", () => {
  __testOnlyResetTeammateLoopState();
  const owner = {};
  const lease = beginTeammateLoopOwner(owner, request("Duplicate L2 and create a view template from the duplicate."));
  try {
    const apply = guardTeammateMcpCall(owner, {
      tool: "revit_call_tool",
      arguments: { method: "POST", path: "/revit/duplicate-view", body: { viewId: 9948, newName: "VISIBILITY TEST - L2", withDetailing: true } }
    });
    assert.equal(apply.allowed, true);
    recordTeammateMcpResult(owner, apply, {
      content: [{ type: "text", text: JSON.stringify({ success: true, viewId: 1542985, name: "VISIBILITY TEST - L2" }) }]
    });

    const capture = guardTeammateMcpCall(owner, {
      tool: "revit_call_tool",
      arguments: { method: "POST", path: "/revit/export-image", body: { fileName: "Visibility Test After" } }
    });
    assert.equal(capture.allowed, true);
    assert.equal(capture.call?.effect, "read");
    recordTeammateMcpResult(owner, capture, {
      content: [{ type: "text", text: JSON.stringify({ status: "Success", imagePath: "artifacts/captures/Revit_1542985_20260812081613 - Floor Plan - VISIBILITY TEST - L2.jpg" }) }]
    });

    const receipt = teammateLoopReceiptForOwner(owner);
    assert.equal(receipt?.verified, true);
    assert.equal(receipt?.stage, "report");
  } finally {
    endTeammateLoopOwner(lease);
  }
});

test("read-only native API ops are admitted as inspection evidence", () => {
  __testOnlyResetTeammateLoopState();
  const owner = {};
  const lease = beginTeammateLoopOwner(owner, request("Inspect the active view range."));
  try {
    const read = guardTeammateMcpCall(owner, {
      tool: "revit_native_api_ops",
      arguments: { operations: [{ id: "view", op: "get_property", target: "uidoc", property: "ActiveView" }], returns: ["view"] }
    });
    assert.equal(read.allowed, true);
    assert.equal(read.call?.effect, "read");
  } finally {
    endTeammateLoopOwner(lease);
  }
});

test("read-only native API operations verify an applied target without consuming a second apply slot", () => {
  __testOnlyResetTeammateLoopState();
  const owner = {};
  const lease = beginTeammateLoopOwner(owner, request("Enable striped rows on schedule 1542984."));
  try {
    const apply = guardTeammateMcpCall(owner, {
      tool: "revit_call_tool",
      arguments: {
        method: "POST", path: "/revit/configure-schedule",
        body: { scheduleId: 1542984, appearance: { stripedRows: true }, dryRun: false }
      }
    });
    assert.equal(apply.allowed, true);
    assert.equal(apply.call?.effect, "apply");
    recordTeammateMcpResult(owner, apply, {
      content: [{ type: "text", text: JSON.stringify({ status: "Success", scheduleId: 1542984 }) }]
    });

    const verify = guardTeammateMcpCall(owner, {
      tool: "revit_call_tool",
      arguments: {
        method: "POST", path: "/revit/native-api-ops",
        body: {
          operations: [{ id: "schedule", op: "call", target: "doc", args: [1542984] }],
          returns: ["$schedule"]
        }
      }
    });
    assert.equal(verify.allowed, true);
    assert.equal(verify.call?.effect, "read");
    recordTeammateMcpResult(owner, verify, {
      content: [{ type: "text", text: JSON.stringify({ status: "Ok", results: { schedule: { id: 1542984, HasStripedRows: true } } }) }]
    });
    const verified = teammateLoopReceiptForOwner(owner);
    assert.equal(verified?.verified, true);
    assert.equal(verified?.stage, "report");
    assert.equal(verified?.blocked_reason, null);

    const distinctApply = guardTeammateMcpCall(owner, {
      tool: "revit_call_tool",
      arguments: {
        method: "POST", path: "/revit/configure-schedule",
        body: { scheduleId: 1542984, filters: [{ field: "Mark", op: "begins_with", value: "HRU2" }], dryRun: false }
      }
    });
    assert.equal(distinctApply.allowed, true);
    assert.equal(distinctApply.call?.effect, "apply");
  } finally {
    endTeammateLoopOwner(lease);
  }
});

test("schedule filter predicates do not masquerade as exact written values during verification", () => {
  __testOnlyResetTeammateLoopState();
  const owner = {};
  const lease = beginTeammateLoopOwner(owner, request("Filter schedule OPERATOR SMOKE ME EQUIPMENT where Mark begins with OPERATOR-SMOKE."));
  const body = {
    query: "OPERATOR SMOKE ME EQUIPMENT",
    exact: true,
    filters: [{ field: "Mark", op: "begins_with", value: "OPERATOR-SMOKE" }],
    replaceFilters: true,
    dryRun: true
  };
  try {
    const preview = guardTeammateMcpCall(owner, {
      tool: "revit_call_tool",
      arguments: { method: "POST", path: "/revit/configure-schedule", body }
    });
    assert.equal(preview.allowed, true);
    recordTeammateMcpResult(owner, preview, { content: [{ type: "text", text: JSON.stringify({ status: "Dry Run" }) }] });

    const apply = guardTeammateMcpCall(owner, {
      tool: "revit_call_tool",
      arguments: { method: "POST", path: "/revit/configure-schedule", body: { ...body, dryRun: false } }
    });
    assert.equal(apply.allowed, true);
    recordTeammateMcpResult(owner, apply, {
      content: [{ type: "text", text: JSON.stringify({ status: "Success", schedule: { id: 1543072, name: "OPERATOR SMOKE ME EQUIPMENT" } }) }]
    });

    const verify = guardTeammateMcpCall(owner, {
      tool: "revit_list_schedules",
      arguments: { action: "detail", scheduleId: 1543072, includeFields: true, includeData: true }
    });
    assert.equal(verify.allowed, true);
    recordTeammateMcpResult(owner, verify, {
      content: [{ type: "text", text: JSON.stringify({
        status: "Ok",
        schedule: { id: 1543072, name: "OPERATOR SMOKE ME EQUIPMENT", fieldCount: 3 },
        table: { body: { rows: [{ cells: ["HeatRecoveryUnit", "OPERATOR-SMOKE-001", "L2"] }] } }
      }) }]
    });

    const receipt = teammateLoopReceiptForOwner(owner);
    assert.equal(receipt?.verified, true);
    assert.equal(receipt?.stage, "report");
    assert.equal(receipt?.blocked_reason, null);
  } finally {
    endTeammateLoopOwner(lease);
  }
});

test("a later dry-run inspection does not erase already verified Revit work", () => {
  __testOnlyResetTeammateLoopState();
  const owner = {};
  const lease = beginTeammateLoopOwner(owner, request("Create and verify a filtered schedule, then inspect its matching rows."));
  try {
    const create = guardTeammateMcpCall(owner, {
      tool: "revit_call_tool",
      arguments: { method: "POST", path: "/revit/create-schedule", body: { name: "TEST", category: "OST_MechanicalEquipment", dryRun: false } }
    });
    assert.equal(create.allowed, true);
    recordTeammateMcpResult(owner, create, {
      content: [{ type: "text", text: JSON.stringify({ status: "Success", schedule: { id: 1542996, name: "TEST" } }) }]
    });
    assert.equal(teammateLoopReceiptForOwner(owner)?.verified, true);

    const inspect = guardTeammateMcpCall(owner, {
      tool: "revit_replace_schedule_values",
      arguments: {
        scheduleIds: [1542996], fieldNames: ["Mark"], valueContains: "HRU2",
        replaceFrom: "__NO_MATCH__", replaceTo: "__NO_CHANGE__", dryRun: true, apply: false
      }
    });
    assert.equal(inspect.allowed, true);
    recordTeammateMcpResult(owner, inspect, {
      content: [{ type: "text", text: JSON.stringify({ status: "Dry Run", changes: [] }) }]
    });

    const receipt = teammateLoopReceiptForOwner(owner);
    assert.equal(receipt?.verified, true);
    assert.equal(receipt?.blocked_reason, null);
  } finally {
    endTeammateLoopOwner(lease);
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
