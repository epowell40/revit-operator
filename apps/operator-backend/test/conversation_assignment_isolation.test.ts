import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { prepareAssignmentTurn, bindPreparedAssignmentToRequest } from "../src/assignments/turn_preparation.js";
import { createAssignmentKernelForGoalV2 } from "../src/assignments/assignment_kernel_v2_factory.js";
import { getAssignmentKernelSnapshotV2 } from "../src/assignments/assignment_kernel_v2_store.js";
import { controlAssignmentExecutionV2 } from "../src/assignments/assignment_kernel_v2_controls.js";
import { __testOnlyResetGoalListCache, getGoal, getCurrentGoalForSession, setAgentGoal } from "../src/goals/service.js";
import { buildTeammateTurnContract, beginTeammateLoopOwner, endTeammateLoopOwner } from "../src/teammate_loop_runtime.js";
import { handleCodexDynamicToolCall } from "../src/brains/codex_dynamic_tool_handler.js";
import { createOperatorBackendAuth } from "../src/operator_backend_auth.js";
import { runWithRequestContext } from "../src/request_context.js";
import { recordAssignmentProviderCallStateV2 } from "../src/assignments/assignment_kernel_v2_progress.js";
import { openAssignmentKernelOperationV2, markAssignmentKernelOperationDispatchStartedV2, failAssignmentKernelOperationV2 } from "../src/assignments/assignment_kernel_v2_execution.js";
import { isIndependentAssistantTurn } from "../src/goals/assistant_turn.js";
import { formatCodexRequestEnvelope } from "../src/brains/codex_turn_profile.js";

const context = { revit: { source: { live: true }, version: "Autodesk Revit 2024", process_id: 4242,
  document: { title: "Disposable", path: "C:\\fixtures\\disposable.rvt", projectIdentity: { fingerprint: "model" } } } };
const oldPrompt = "Turn that into a prioritized five-step plan for this week. Put the missing decisions first, and keep it brief.";
const base = { sessionId: "mixed-conversation", messageId: "new-question", toolResults: [], source: "chat_stream", createdBy: null, requestContext: context };

test("empty provider continuations and explicit saved-work requests are not independent conversation", () => {
  for (const user_text of ["", "Continue the existing conditions reconstruction one stage at a time.", "Resume the saved task.", "Keep going."]) {
    assert.equal(isIndependentAssistantTurn({ user_text }), false, user_text);
    assert.equal(isIndependentAssistantTurn({ user_text, context }), false, user_text);
  }
});

async function workspace(run: () => Promise<void> | void) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "operator-conversation-isolation-"));
  const previous = [process.env.OPERATOR_WORKSPACE_ROOT, process.env.OPERATOR_ASSIGNMENT_KERNEL_V2];
  process.env.OPERATOR_WORKSPACE_ROOT = root;
  process.env.OPERATOR_ASSIGNMENT_KERNEL_V2 = "1";
  __testOnlyResetGoalListCache();
  try { await runWithRequestContext({ operator_backend_auth: createOperatorBackendAuth("shared_token", "test-token") }, run); }
  finally {
    for (const [index, key] of ["OPERATOR_WORKSPACE_ROOT", "OPERATOR_ASSIGNMENT_KERNEL_V2"].entries()) {
      if (previous[index] === undefined) delete process.env[key]; else process.env[key] = previous[index];
    }
    __testOnlyResetGoalListCache();
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function seedPriorAutomaticTask(objective = oldPrompt, effect = "read") {
  // Exact persisted state from the old admission bug, not admission under the fix.
  const goal = setAgentGoal(base.sessionId, { objective, title: objective, success_criteria: ["Return the requested result."],
    work_budget: { mode: "auto_goal", requested_effect: effect, source_user_request: objective, document_fingerprint: "model" } });
  const binding = createAssignmentKernelForGoalV2({ goal, run_id: "chat:old-question" });
  return { goal, binding };
}

test("a document follow-up cannot replace a later selected-duct question at the MCP boundary", () => workspace(async () => {
  const old = seedPriorAutomaticTask();
  const prompt = "What is the diameter of the selected duct?";
  const prepared = prepareAssignmentTurn({ ...base, userText: prompt })!;
  assert.notEqual(prepared.assignmentId, old.goal.id);
  const snapshot = getAssignmentKernelSnapshotV2(prepared.assignmentId)!;
  assert.equal(snapshot.spec.source_user_request, prompt);
  assert.equal(snapshot.spec.requested_effect, "read");
  const oldSnapshot = getAssignmentKernelSnapshotV2(old.goal.id)!;
  assert.equal(oldSnapshot.spec.source_user_request, oldPrompt);
  assert.equal(oldSnapshot.execution_control?.state, "paused");
  assert.equal(oldSnapshot.terminal, false);
  assert.equal(getGoal(old.goal.id)!.status, "paused");
  assert.equal(getCurrentGoalForSession(base.sessionId)!.id, prepared.assignmentId);
  const request = bindPreparedAssignmentToRequest({ version: "operator.backend.v1", session_id: base.sessionId,
    message_id: base.messageId, user_text: prompt, context }, prepared);
  assert.equal(buildTeammateTurnContract(request).turn_kind, "inspection");
  let calls = 0;
  const runtime = { assignmentKernelV2Binding: () => prepared.bindingV2, queueAssignmentKernelV2TurnStop: () => {},
    callTool: async (_tool: unknown, _args: unknown, callContext: any) => {
      calls++; assert.equal(callContext.assignmentKernelV2.binding.assignment_id, prepared.assignmentId);
      throw new Error("Selected-duct read reached the MCP test boundary");
    } };
  const owner = beginTeammateLoopOwner(runtime, request);
  try {
    const result = await handleCodexDynamicToolCall(runtime as any, { id: "diameter-read", method: "item/tool/call",
      params: { namespace: "revit_operator", turnId: "diameter-turn", tool: "revit_call_tool",
        arguments: { method: "POST", path: "/revit/get-parameters", requireKnownPath: true,
          body: { elementIds: [1452987], names: ["Diameter", "Size"], writableOnly: false, includeEmpty: true } } } } as any);
    assert.equal(calls, 1, JSON.stringify(result));
    assert.match(JSON.stringify(result), /Selected-duct read reached/);
    assert.doesNotMatch(JSON.stringify(result), /conceptual turn does not require/);
  } finally { endTeammateLoopOwner(owner); }
}));

test("general engineering and answer drafting preserve a prior task without acquiring its authority", () => workspace(() => {
  const old = seedPriorAutomaticTask("Inspect the current duct system.");
  const before = getAssignmentKernelSnapshotV2(old.goal.id)!;
  for (const userText of [oldPrompt, "What is static pressure in an HVAC duct? Keep it to two sentences.", "How does a VAV box work?"]) {
    assert.equal(prepareAssignmentTurn({ ...base, userText }), null, userText);
    assert.equal(buildTeammateTurnContract({ user_text: userText, context }).turn_kind, "conversation");
    const request = { version: "operator.backend.v1" as const, session_id: base.sessionId, message_id: "question", user_text: userText, context };
    assert.equal(isIndependentAssistantTurn(request), true);
    assert.match(formatCodexRequestEnvelope(request), /STANDALONE ASSISTANT TURN/);
    assert.equal(isIndependentAssistantTurn({ ...request, assignment_id: old.goal.id }), false);
    assert.equal(isIndependentAssistantTurn({ ...request, tool_results: [{}] as any }), false);
    const rebound = bindPreparedAssignmentToRequest({ ...request, context: { ...context,
      ui: { authoritative_user_text: "Delete the selected duct." } } }, null);
    assert.equal(buildTeammateTurnContract(rebound).turn_kind, "conversation");
    assert.equal(buildTeammateTurnContract(rebound).intent_summary, userText);
  }
  assert.deepEqual(getAssignmentKernelSnapshotV2(old.goal.id), before);
}));

for (const state of ["provider_running", "native_running", "unknown_effect"] as const) {
  test(`a new model request cannot bypass ${state} in the previous automatic task`, () => workspace(() => {
    const old = seedPriorAutomaticTask("Replace selected note with exact literal 'Verified text'.", "apply");
    if (state === "provider_running") {
      recordAssignmentProviderCallStateV2({ binding: old.binding, call_id: "provider", state: "admitted", provider: "test", model: "test",
        gap_ids: ["criterion:test"], criterion_ids: [getAssignmentKernelSnapshotV2(old.goal.id)!.spec.criteria[0]!.criterion_id], expected_information: ["Resolve the current task"] });
    } else {
      const lease = openAssignmentKernelOperationV2({ snapshot: getAssignmentKernelSnapshotV2(old.goal.id)!, provider_turn_id: "provider",
        controller_request_id: "edit", capability_id: "revit_call_tool", classified_effect: "apply",
        arguments: { method: "POST", path: "/revit/replace-text-note", body: { elementId: 1, newText: "Verified text", dryRun: false } } });
      markAssignmentKernelOperationDispatchStartedV2(lease);
      if (state === "unknown_effect") failAssignmentKernelOperationV2(lease, new Error("response lost"), "dispatched");
    }
    const before = getAssignmentKernelSnapshotV2(old.goal.id)!;
    assert.throws(() => prepareAssignmentTurn({ ...base, userText: "What is the diameter of the selected duct?" }), /earlier task still has work running or an unconfirmed model change/);
    assert.deepEqual(getAssignmentKernelSnapshotV2(old.goal.id), before);
    assert.equal(prepareAssignmentTurn({ ...base, userText: "What is static pressure?" }), null);
    assert.deepEqual(getAssignmentKernelSnapshotV2(old.goal.id), before);
  }));
}

test("successive read and edit requests get their own effects while an explicit resume retains exact saved inputs", () => workspace(() => {
  const old = seedPriorAutomaticTask("Inspect the current duct system.");
  const prompt = "Set Comments on the selected duct to QA REVIEW.";
  const prepared = prepareAssignmentTurn({ ...base, userText: prompt })!;
  assert.equal(getAssignmentKernelSnapshotV2(prepared.assignmentId)!.spec.requested_effect, "apply");
  assert.equal(getAssignmentKernelSnapshotV2(old.goal.id)!.spec.requested_effect, "read");
  const paused = getAssignmentKernelSnapshotV2(old.goal.id)!;
  controlAssignmentExecutionV2({ binding: old.binding, command_id: "explicit-resume", expected_command_id: paused.execution_control!.command_id, action: "resume" });
  const continued = prepareAssignmentTurn({ ...base, userText: "Continue saved work", suppliedBinding: {
    assignment_id: old.binding.assignment_id, assignment_run_id: old.binding.run_id, assignment_generation: old.binding.generation } })!;
  assert.equal(continued.assignmentId, old.goal.id);
  const bound = bindPreparedAssignmentToRequest({ user_text: "Continue saved work", context } as any, continued);
  assert.equal(buildTeammateTurnContract(bound).intent_summary, "Inspect the current duct system.");
  assert.throws(() => prepareAssignmentTurn({ ...base, userText: "Continue", suppliedBinding: {
    assignment_id: old.binding.assignment_id, assignment_run_id: old.binding.run_id, assignment_generation: 999 } }), /stale_or_mismatched/);
}));
