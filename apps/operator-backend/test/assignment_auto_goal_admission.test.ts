import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { prepareAssignmentTurn, bindPreparedAssignmentToRequest } from "../src/assignments/turn_preparation.js";
import { classifyAutoGoalRequest } from "../src/goals/auto_goal.js";
import { getAssignmentKernelSnapshotV2 } from "../src/assignments/assignment_kernel_v2_store.js";
import { __testOnlyResetGoalListCache } from "../src/goals/service.js";
import { createOperatorBackendAuth } from "../src/operator_backend_auth.js";
import { runWithRequestContext } from "../src/request_context.js";
import { beginTeammateLoopOwner, endTeammateLoopOwner } from "../src/teammate_loop_runtime.js";
import { handleCodexDynamicToolCall } from "../src/brains/codex_dynamic_tool_handler.js";
import { OPERATOR_BACKEND_CONTRACT_VERSION } from "../src/contracts.js";
import { normalizeExternalAssignmentRequest, startExternalAssignmentRun } from "../src/assignments/external_assignment_start.js";
import { setAgentGoal } from "../src/goals/service.js";
import { buildTeammateTurnContract } from "../src/teammate_loop_runtime.js";

for (const [effect, prompt, facts] of [
  ["read", "Is Revit connected?", ["task.result_available"]],
  ["read", "Are these ducts connected?", ["task.result_available"]],
  ["read", "Does this model contain mechanical equipment?", ["task.result_available"]],
  ["apply", "Is Revit connected? Then delete the selected duct.", ["task.result_available"]],
  ["read", "Please check the drafting view we just created. Keep the existing view and report its name and scale.", ["task.result_available"]],
  ["read", "Inspect the current view scale.", ["task.result_available"]],
  ["read", "Use custom C# to count a sample of up to twenty ducts by type. Make no model changes.", ["task.result_available"]],
  ["read", "Exercise C# compile repair and group the sampled ducts by TypeName. Use snapshot_limit 20. Make no model changes.", ["task.result_available"]],
  ["read", "Count all ducts by type in this sample model.", ["inventory.complete", "inventory.total", "inventory.group"]],
  ["read", "Inspect a sample, then count all ducts in the model by type.", ["inventory.complete", "inventory.total", "inventory.group"]],
  ["apply", "Check the view scale, then set it to 100.", ["task.result_available"]],
  ["apply", "Report its name and scale the view to 100.", ["task.result_available"]],
  ["read", "Count all air devices in the project and break the total down by family and type. Do not change the model.", ["inventory.complete", "inventory.total", "inventory.group"]],
  ["read", "Tell me what is selected in Revit, its size, and which system it belongs to. Leave the model unchanged.", ["task.result_available"]],
  ["read", "What size is this?", ["task.result_available"]],
  ["read", "Which system does this belong to?", ["task.result_available"]],
  ["read", "Give me a CSV of the Level 4 equipment: name, family/type, level, and location in feet.", ["task.result_available"]],
  ["read", "Our Revit add-in uses ElementId.IntegerValue. Find out what needs to change for Revit 2026 while keeping Revit 2023 support. Explain the fix; do not edit the add-in.", ["task.result_available"]],
  ["preview", "Run a rollback preview moving the selected device one foot east. Do not commit.", ["task.preview_valid"]],
  ["preview", "Pick an accessory on this plan and show me what would be removed or disconnected if we deleted it. Leave it in place for now.", ["task.preview_valid"]],
  ["preview", "Show me what would change if we moved this equipment. Leave it unchanged.", ["task.preview_valid"]],
  ["apply", "Turn off the architectural room stuff on the Level 4 mechanical plans. Leave the MEP spaces alone.", ["task.result_available"]],
  ["apply", "Put QA REVIEW in Comments for this pipe.", ["task.result_available"]],
  ["apply", 'Local development qualification: duplicate the existing M000 cover sheet with its views and detailing. Use POST /revit/duplicate-sheet with {"sourceSheetNumber":"M000","option":"views_and_detailing","newNumber":"TEMP-M000-CHECK","newName":"Cover Sheet - Working Copy","dryRun":false,"verify":true}. M000 exists and TEMP-M000-CHECK was just confirmed available. Then read back the created sheet to verify its identity and contents.', ["task.result_available"]],
  ["apply", "Duplicate sheet M000 with dryRun=false.", ["task.result_available"]],
  ["preview", 'Preview only: duplicate sheet M000. The example includes {"dryRun":false}; do not commit.', ["task.preview_valid"]],
  ["preview", 'Duplicate sheet M000 with {"dryRun":true}. Do not commit.', ["task.preview_valid"]],
  ["read", 'Read-only: inspect sheet M000. The sample request uses {"dryRun":false}. Do not change the model.', ["task.result_available"]],
  ["apply", "Show the supply ducts in red on this plan.", ["task.result_available"]],
  ["apply", "Center this device between the two next to it.", ["task.result_available"]],
  ["apply", "Save the settings from this plan as TEST COORDINATION TEMPLATE.", ["task.result_available"]],
  ["apply", "Tidy up the crowded tags without changing what they label.", ["task.result_available"]],
  ["apply", "Show me what would change if we moved this equipment, then apply the move.", ["task.result_available"]],
  ["apply", "Replace the selected note text with the exact literal 'Issued for Construction'.", ["task.result_available"]]
] as const) {
  test(`normal chat admits ${effect} auto-goals with a native evidence contract under V2`, () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "operator-auto-admission-"));
    const previousRoot = process.env.OPERATOR_WORKSPACE_ROOT;
    const previousV2 = process.env.OPERATOR_ASSIGNMENT_KERNEL_V2;
    process.env.OPERATOR_WORKSPACE_ROOT = root;
    process.env.OPERATOR_ASSIGNMENT_KERNEL_V2 = "1";
    __testOnlyResetGoalListCache();
    try {
      runWithRequestContext({ operator_backend_auth: createOperatorBackendAuth("shared_token", "test-token") }, () => {
        // Same admission edge as /chat and /chat/stream; no hand-made Goal or
        // benchmark-only acceptance criteria bypass the normal UI producer.
        const prepared = prepareAssignmentTurn({
          sessionId: "normal-ui-session", messageId: "normal-ui-message",
          userText: prompt, toolResults: [], source: "chat", createdBy: null,
          requestContext: { revit: { document: { projectIdentity: { fingerprint: "test-model" } } } }
        });
        assert.equal(prepared?.kernelVersion, 2);
        const snapshot = getAssignmentKernelSnapshotV2(prepared!.assignmentId)!;
        assert.equal(snapshot.spec.requested_effect, effect);
        assert.equal(snapshot.current_binding.principal_id, "local:shared-token");
        assert.equal(snapshot.current_binding.document_fingerprint, "test-model");
        assert.equal(snapshot.spec.source_user_request, prompt);
        assert.equal(snapshot.spec.criteria.length, 1);
        assert.deepEqual(snapshot.spec.criteria[0]!.semantic_fact_requirements, facts);
        assert.equal(snapshot.spec.criteria[0]!.evidence_policy?.require_native_dispatch, true);
        assert.equal(snapshot.spec.criteria[0]!.evidence_policy?.require_current_generation, true);
        assert.equal(snapshot.terminal, false, "admission must not certify completion");
        assert.deepEqual(snapshot.criteria, {}, "no criterion passes before native evidence");
        const bound = bindPreparedAssignmentToRequest({ session_id: "normal-ui-session", user_text: prompt } as any, prepared);
        assert.equal(bound.assignment_id, snapshot.current_binding.assignment_id);
        assert.equal(bound.assignment_run_id, snapshot.current_binding.run_id);
        assert.equal(bound.assignment_generation, snapshot.current_binding.generation);
        assert.throws(() => prepareAssignmentTurn({ sessionId: "different-session", messageId: "foreign",
          userText: prompt, toolResults: [], source: "chat", createdBy: null, suppliedBinding: bound }), /stale_or_mismatched/);
        const external = normalizeExternalAssignmentRequest({ objective: prompt, start_assignment_run: true,
          success_criteria: ["Return the requested result with evidence."], work_budget: {
            mode: "sidecar_computer", source: "operator_desktop", source_user_request: prompt,
            requested_effect: effect === "apply" ? "read" : "apply", document_fingerprint: "test-model"
          } });
        const externalGoal = setAgentGoal("external-session", external as any);
        const externalRun = startExternalAssignmentRun({ goal: externalGoal, sessionId: "external-session", actor: "test" });
        assert.equal(getAssignmentKernelSnapshotV2(externalRun.assignmentId)!.spec.requested_effect, effect,
          "external controller and ordinary chat must create the same immutable effect contract");
        const guard = buildTeammateTurnContract(bound);
        assert.equal(guard.write_authorized, effect === "apply", prompt);
        if (effect === "preview") assert.equal(guard.preview_required, true, prompt);
      });
    } finally {
      if (previousRoot === undefined) delete process.env.OPERATOR_WORKSPACE_ROOT;
      else process.env.OPERATOR_WORKSPACE_ROOT = previousRoot;
      if (previousV2 === undefined) delete process.env.OPERATOR_ASSIGNMENT_KERNEL_V2;
      else process.env.OPERATOR_ASSIGNMENT_KERNEL_V2 = previousV2;
      __testOnlyResetGoalListCache();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
}

test("context admission does not turn empty input, tool continuations, or unrelated conversation into new work", () => {
  const base = { sessionId: "no-admission", messageId: "no-admission", toolResults: [], source: "chat", createdBy: null };
  assert.equal(classifyAutoGoalRequest("What size is this?").shouldStart, false, "the regression requires contextual admission");
  assert.equal(prepareAssignmentTurn({ ...base, userText: "What size is this?" }), null);
  assert.equal(prepareAssignmentTurn({ ...base, userText: "", requestContext: { revit: {} } }), null);
  assert.equal(prepareAssignmentTurn({ ...base, userText: "What size is this?", toolResults: [{}] as any, requestContext: { revit: {} } }), null);
});

test("external source/objective mismatch is rejected while explicit structured assignments keep their contract", () => {
  const structured = { objective: "Structured work", work_budget: { requested_effect: "preview" }, start_assignment_run: true };
  assert.equal(normalizeExternalAssignmentRequest(structured), structured);
  assert.throws(() => normalizeExternalAssignmentRequest({ objective: "Read only", start_assignment_run: true,
    work_budget: { mode: "sidecar_computer", source: "operator_desktop", source_user_request: "Delete the branch" } }), /source_request_mismatch/);
});

test("a short UI read reaches the MCP boundary only with its admitted canonical binding", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "operator-context-mcp-"));
  const previous = [process.env.OPERATOR_WORKSPACE_ROOT, process.env.OPERATOR_ASSIGNMENT_KERNEL_V2];
  process.env.OPERATOR_WORKSPACE_ROOT = root;
  process.env.OPERATOR_ASSIGNMENT_KERNEL_V2 = "1";
  __testOnlyResetGoalListCache();
  try {
    await runWithRequestContext({ operator_backend_auth: createOperatorBackendAuth("shared_token", "test-token") }, async () => {
      const prompt = "What size is this?";
      const context = { revit: { source: { live: true }, document: { title: "Disposable", projectIdentity: { fingerprint: "model" } } } };
      const prepared = prepareAssignmentTurn({ sessionId: "short-read", messageId: "read", userText: prompt,
        toolResults: [], source: "chat_stream", createdBy: null, requestContext: context })!;
      let calls = 0;
      let binding = prepared.bindingV2;
      const runtime = { assignmentKernelV2Binding: () => binding, queueAssignmentKernelV2TurnStop: () => {},
        callTool: async (_tool: unknown, _args: unknown, callContext: any) => {
          calls += 1;
          assert.equal(callContext.assignmentKernelV2.binding.assignment_id, prepared.assignmentId);
          throw new Error("MCP test boundary reached before native dispatch");
        } };
      const owner = beginTeammateLoopOwner(runtime, bindPreparedAssignmentToRequest({ version: OPERATOR_BACKEND_CONTRACT_VERSION,
        session_id: "short-read", message_id: "read", user_text: prompt, context }, prepared));
      try {
        const request = { id: "context-read", method: "item/tool/call", params: { namespace: "revit_operator",
          turnId: "short-read-turn", tool: "revit_get_context", arguments: {} } } as any;
        const result = await handleCodexDynamicToolCall(runtime as any, request) as any;
        assert.equal(calls, 1, JSON.stringify(result));
        assert.match(JSON.stringify(result), /MCP test boundary reached/);
        assert.equal(getAssignmentKernelSnapshotV2(prepared.assignmentId)!.terminal, false);
        binding = undefined;
        const denied = await handleCodexDynamicToolCall(runtime as any, { ...request, id: "unbound-read" }) as any;
        assert.equal(calls, 1);
        assert.equal(denied.success, false);
      } finally { endTeammateLoopOwner(owner); }
    });
  } finally {
    for (const [index, key] of ["OPERATOR_WORKSPACE_ROOT", "OPERATOR_ASSIGNMENT_KERNEL_V2"].entries()) {
      if (previous[index] === undefined) delete process.env[key]; else process.env[key] = previous[index];
    }
    __testOnlyResetGoalListCache();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
