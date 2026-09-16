import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { hasDeferredProposalOnlyFraming } from "../src/no_write_intent.js";
import { classifyAutoGoalRequest } from "../src/goals/auto_goal.js";
import { beginTeammateLoopOwner, endTeammateLoopOwner, guardTeammateMcpCall } from "../src/teammate_loop_runtime.js";
import { prepareAssignmentTurn } from "../src/assignments/turn_preparation.js";
import { getAssignmentKernelSnapshotV2 } from "../src/assignments/assignment_kernel_v2_store.js";
import { openAssignmentKernelOperationV2 } from "../src/assignments/assignment_kernel_v2_execution.js";
import { __closeForTests } from "../src/memory/sqlite_store.js";
import { __testOnlyResetGoalListCache } from "../src/goals/service.js";

const prompt = "For this sample exercise, use these zoning rules: keep unlike room uses separate, give corner rooms their own zones, and aim for groups no larger than 600 square feet. First prepare a proposed zoning schedule for one floor and identify any rooms where those rules conflict or where you need my input. Do not draw the zones or place VAVs yet.";
const context = { revit: { source: { live: true }, process_id: 42, document: { title: "Rooms", path: "C:/fixture/Rooms.rvt", projectIdentity: { fingerprint: "model" } } } };

test("proposed engineering work with deferred model edits is admitted as read, across domains and wording", () => {
  for (const text of [prompt, "Prepare a proposed device layout for Level 2. Don't place the devices yet.",
    "Review the proposed duct plan. Do not route or connect the ducts for now.",
    "Outline a proposed annotation plan. Do not create the tags yet."]) {
    assert.equal(hasDeferredProposalOnlyFraming(text), true, text);
    assert.equal(classifyAutoGoalRequest(text).requestedEffect, "read", text);
  }
  for (const text of ["Prepare a proposed layout, then place the devices.",
    "Move this diffuser, then prepare a proposed equipment plan. Do not place the VAVs yet.",
    "Create the proposed zoning schedule in Revit. Do not draw the zones yet."]) {
    assert.equal(hasDeferredProposalOnlyFraming(text), false, text);
    assert.equal(classifyAutoGoalRequest(text).requestedEffect, "apply", text);
  }
});

test("a planning request cannot reach native drawing, placement or dynamic apply through either authority boundary", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "operator-proposal-admission-"));
  const previous = [process.env.OPERATOR_WORKSPACE_ROOT, process.env.OPERATOR_ASSIGNMENT_KERNEL_V2];
  process.env.OPERATOR_WORKSPACE_ROOT = root; process.env.OPERATOR_ASSIGNMENT_KERNEL_V2 = "1"; __testOnlyResetGoalListCache();
  try {
    const prepared = prepareAssignmentTurn({ sessionId: "proposal-session", messageId: "proposal", userText: prompt,
      toolResults: [], source: "chat", createdBy: "principal", requestContext: context })!;
    const snapshot = getAssignmentKernelSnapshotV2(prepared.assignmentId)!;
    assert.equal(snapshot.spec.requested_effect, "read"); assert.equal(snapshot.spec.source_user_request, prompt);
    for (const route of ["/revit/create-filled-region", "/revit/create-family-instance", "/revit/create-duct"]) {
      const owner = {}, lease = beginTeammateLoopOwner(owner, { user_text: prompt, context } as any);
      const args = { method: "POST", path: route, body: { dryRun: false } };
      try { assert.equal(guardTeammateMcpCall(owner, { tool: "revit_call_tool", arguments: args }).allowed, false, route); }
      finally { endTeammateLoopOwner(lease); }
      assert.throws(() => openAssignmentKernelOperationV2({ snapshot, controller_request_id: route, provider_turn_id: "turn",
        capability_id: "revit_call_tool", classified_effect: "apply", arguments: args }), /user_no_model_write_limit/);
    }
    assert.throws(() => openAssignmentKernelOperationV2({ snapshot, controller_request_id: "dynamic", provider_turn_id: "turn",
      capability_id: "operator_run_dynamic_revit_program", classified_effect: "apply", arguments: { mode: "apply" } }), /user_no_model_write_limit/);
    assert(openAssignmentKernelOperationV2({ snapshot, controller_request_id: "read", provider_turn_id: "turn",
      capability_id: "revit_call_tool", classified_effect: "read", arguments: { method: "POST", path: "/revit/list-rooms", body: {} } }));
  } finally {
    __closeForTests(); __testOnlyResetGoalListCache();
    for (const [i, key] of ["OPERATOR_WORKSPACE_ROOT", "OPERATOR_ASSIGNMENT_KERNEL_V2"].entries()) {
      if (previous[i] === undefined) delete process.env[key]; else process.env[key] = previous[i];
    }
    fs.rmSync(root, { recursive: true, force: true });
  }
});
