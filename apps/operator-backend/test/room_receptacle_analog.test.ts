import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after, before } from "node:test";
import { OPERATOR_BACKEND_CONTRACT_VERSION, type ChatRequest, type ToolResult } from "../src/contracts.js";
import { __testOnlyVerifiedAnalogApplyReceipt, maybeRunDeterministicRoomReceptacleAnalog } from "../src/deterministic/room_receptacle_analog.js";
import { AEC_TASK_INTENT_V1_SCHEMA, type AecTaskIntentV1 } from "../src/aec_task_intent.js";
import { getActiveGoalForSession, setAgentGoal } from "../src/goals/service.js";

const previousWorkspace = process.env.OPERATOR_WORKSPACE_ROOT;
let testWorkspace = "";
before(() => {
  testWorkspace = fs.mkdtempSync(path.join(os.tmpdir(), "room-receptacle-goal-"));
  process.env.OPERATOR_WORKSPACE_ROOT = testWorkspace;
});
after(() => {
  if (previousWorkspace === undefined) delete process.env.OPERATOR_WORKSPACE_ROOT;
  else process.env.OPERATOR_WORKSPACE_ROOT = previousWorkspace;
  fs.rmSync(testWorkspace, { recursive: true, force: true });
});

function request(userText = "", toolResults: ToolResult[] = []): ChatRequest {
  return { version: OPERATOR_BACKEND_CONTRACT_VERSION, session_id: "room-403-demo", message_id: "message-1", user_text: userText, tool_results: toolResults };
}

function sessionRequest(sessionId: string, userText = "", toolResults: ToolResult[] = []): ChatRequest {
  return { ...request(userText, toolResults), session_id: sessionId, message_id: `${sessionId}-${toolResults[0]?.action_id ?? "start"}` };
}

function layoutIntent(targetRoom = "403", sourceRoom: string | null = null): AecTaskIntentV1 {
  return {
    schema: AEC_TASK_INTENT_V1_SCHEMA,
    operation: "layout",
    object_class: "receptacle",
    target: { document: null, view: null, room_number: targetRoom, element_ids: [] },
    reference: { kind: sourceRoom ? "room" : "office_standard", room_number: sourceRoom },
    mutation: { kind: "create", requested: true },
    spatial_constraints: [],
    confidence: { value: 0.98, ambiguity: "none", reasons: ["explicit target and layout request"] },
    evidence: { user_text: "fixture" }
  };
}

function appliedReceipt(createdIds: number[], typeCounts: Array<{ familyType: string; count: number }>, warnings: string[] = []) {
  return {
    status: "applied", applied: true, planHash: "hash-405-403", source: { number: "405" }, target: { number: "403" },
    createdIds, typeCounts, warnings,
    readback: createdIds.map(id => ({
      id, family: "Duplex Receptacle", type: "Standard", point: { x: id, y: 2, z: 3 }, targetRoomNumber: "403",
      orientation: { hand: { x: 1, y: 0, z: 0 }, expected: { x: 1, y: 0, z: 0 }, agreement: 1, facingAgreement: 1 },
      physicalHost: { linkInstanceId: 10, linkedElementId: 20, faceFingerprint: `face-${id}` },
      semanticAnchor: { source: `source-${id}`, target: `target-${id}` }
    }))
  };
}

test("office-standard Room 403 intent enters the native preview path without model discovery chatter", () => {
  const response = maybeRunDeterministicRoomReceptacleAnalog(request("Lay out the receptacles in Room 403 based on our office standards."), layoutIntent());
  assert.equal(response?.actions.length, 1);
  assert.equal(response?.actions[0]?.path, "/revit/plan-room-receptacles-from-analog");
  assert.deepEqual(response?.actions[0]?.body, { targetRoomNumber: "403", includePreviewImage: true });
  const explicit = maybeRunDeterministicRoomReceptacleAnalog(request("Design Room 403 from Room 405."), layoutIntent("403", "405"));
  assert.deepEqual(explicit?.actions[0]?.body, { targetRoomNumber: "403", sourceRoomNumber: "405", includePreviewImage: true });
});

test("explicit circuit intent binds strict source-system matching through preview and apply", () => {
  const intent = layoutIntent("403", "405");
  intent.evidence.user_text = "Lay out Room 403 from Room 405 and match the same circuits.";
  const initial = maybeRunDeterministicRoomReceptacleAnalog(request(intent.evidence.user_text), intent);
  assert.deepEqual(initial?.actions[0]?.body, {
    targetRoomNumber: "403",
    sourceRoomNumber: "405",
    circuitMode: "match_source_system",
    includePreviewImage: true
  });

  const continuation = maybeRunDeterministicRoomReceptacleAnalog(request("", [{
    action_id: "preview-circuits",
    method: "POST",
    path: "/revit/plan-room-receptacles-from-analog",
    status: "done",
    result_json: {
      status: "ready", ready: true, planHash: "hash-circuit-405-403",
      source: { number: "405" }, target: { number: "403" },
      circuitValidation: { mode: "match_source_system", verified: true }
    }
  }]));
  assert.deepEqual(continuation?.actions[0]?.body, {
    targetRoomNumber: "403",
    sourceRoomNumber: "405",
    planHash: "hash-circuit-405-403",
    circuitMode: "match_source_system",
    includePreviewImage: true
  });
});

test("verified rollback preview advances to the exact hash-bound analog apply", () => {
  const response = maybeRunDeterministicRoomReceptacleAnalog(request("", [{
    action_id: "preview",
    method: "POST",
    path: "/revit/plan-room-receptacles-from-analog",
    status: "done",
    result_json: { status: "ready", ready: true, planHash: "hash-405-403", source: { number: "405" }, target: { number: "403" } }
  }]));
  assert.equal(response?.actions.length, 1);
  assert.equal(response?.actions[0]?.path, "/revit/apply-room-receptacles-from-analog");
  assert.deepEqual(response?.actions[0]?.body, {
    targetRoomNumber: "403",
    sourceRoomNumber: "405",
    planHash: "hash-405-403",
    includePreviewImage: true
  });
});

test("native persistent readback produces one compact completion report", () => {
  const createdIds = Array.from({ length: 14 }, (_, index) => 1700000 + index);
  const response = maybeRunDeterministicRoomReceptacleAnalog(request("", [{
    action_id: "apply",
    method: "POST",
    path: "/revit/apply-room-receptacles-from-analog",
    status: "done",
    result_json: appliedReceipt(createdIds, [
        { familyType: "Duplex Receptacle|Standard", count: 7 },
        { familyType: "Duplex Receptacle|GFCI", count: 4 },
        { familyType: "Duplex Receptacle|Counter Top", count: 1 },
        { familyType: "High Voltage Receptacle|Standard", count: 2 }
      ])
  }]));
  assert.deepEqual(response?.actions, []);
  assert.match(response?.assistant_message ?? "", /Room 403 is complete/);
  assert.match(response?.assistant_message ?? "", /verified 14 receptacles/);
  assert.match(response?.assistant_message ?? "", /Room 405/);
});

test("room design persists target, selected precedent, exact apply evidence, and queued visual QA", () => {
  const session = "room-407-persistent-goal";
  const intent = layoutIntent("407");
  intent.evidence.user_text = "Lay out receptacles in Room 407.";
  maybeRunDeterministicRoomReceptacleAnalog(sessionRequest(session, intent.evidence.user_text), intent);
  const started = getActiveGoalForSession(session);
  assert.equal(started?.work_items.find(item => item.id === "precedent.resolve")?.status, "ready");
  assert.equal(started?.work_budget?.conversational_permission_loops, 0);

  maybeRunDeterministicRoomReceptacleAnalog(sessionRequest(session, "", [{
    action_id: "preview-407", method: "POST", path: "/revit/plan-room-receptacles-from-analog", status: "done",
    result_json: { status: "ready", ready: true, planHash: "hash-409-407", source: { number: "409" }, target: { number: "407" } }
  }]));
  const previewed = getActiveGoalForSession(session);
  assert.equal(previewed?.assumptions.find(item => item.id === "precedent.room")?.statement, "Room 409 is the selected current-project analog for target Room 407.");
  assert.equal(previewed?.work_items.find(item => item.id === "layout.preview")?.status, "complete");
  assert.equal(previewed?.work_items.find(item => item.id === "layout.apply")?.status, "ready");
  assert.deepEqual(previewed?.work_items.find(item => item.id === "layout.apply")?.scope, { target_room_number: "407", source_room_number: "409" });
  assert.deepEqual(previewed?.work_items.find(item => item.id === "layout.apply")?.depends_on, ["layout.preview"]);
  assert.equal(previewed?.current_phase, "layout_execution");

  const receipt = appliedReceipt([1700407], [{ familyType: "Duplex Receptacle|Standard", count: 1 }]);
  receipt.target.number = "407";
  receipt.source.number = "409";
  receipt.readback[0]!.targetRoomNumber = "407";
  maybeRunDeterministicRoomReceptacleAnalog(sessionRequest(session, "", [{ action_id: "apply-407", method: "POST", path: "/revit/apply-room-receptacles-from-analog", status: "done", result_json: receipt }]));
  const completed = getActiveGoalForSession(session);
  assert.equal(completed?.work_items.find(item => item.id === "layout.apply")?.status, "complete");
  assert.equal(completed?.work_items.find(item => item.id === "layout.verify")?.status, "complete");
  assert.equal(completed?.work_items.find(item => item.id === "verify.visual")?.status, "ready");
  assert.deepEqual(completed?.work_items.find(item => item.id === "layout.verify")?.scope, { target_room_number: "407", source_room_number: "409" });
  assert.deepEqual(completed?.work_items.find(item => item.id === "verify.visual")?.scope, { room_number: "407" });
  assert.deepEqual(completed?.work_items.find(item => item.id === "verify.visual")?.planned_actions, ["focused Revit inspection", "bounded repair if needed"]);
  assert.equal(completed?.current_phase, "visual_verification");
  assert.equal(completed?.current_step, "Perform focused visual QA in Room 407");
  assert.match(completed?.progress_summary ?? "", /Room 407 apply and native persistent readback passed/);
});

test("authoritative room request replaces only an empty model-expanded auto goal", () => {
  const session = "room-authoritative-auto-goal";
  const prompt = "Layout receptacles in room 403.";
  setAgentGoal(session, {
    title: "Expanded room plan",
    objective: "Inspect Room 403, place and circuit devices, save the model, and report all locations.",
    success_criteria: ["Complete or block truthfully."],
    created_by: "auto_goal:chat",
    current_phase: "observe",
    current_step: "preflight"
  } as any);
  const req = sessionRequest(session, prompt);
  req.context = { ui: { authoritative_user_text: prompt } };
  const intent = layoutIntent();
  intent.evidence.user_text = prompt;
  const response = maybeRunDeterministicRoomReceptacleAnalog(req, intent);
  assert.deepEqual(response?.actions.map(action => action.path), ["/revit/plan-room-receptacles-from-analog"]);
  const goal = getActiveGoalForSession(session);
  assert.equal(goal?.objective, prompt);
  assert.equal(goal?.work_budget?.mode, "room_receptacle_design");
  assert.equal(goal?.work_budget?.conversational_permission_loops, 0);
  assert.equal(goal?.work_items.find(item => item.id === "target.inspect")?.scope?.room_number, "403");
});

test("completion receipt requires exact current-run ids plus type, room, host, position, and orientation evidence", () => {
  const valid = appliedReceipt([1700001], [{ familyType: "Duplex Receptacle|Standard", count: 1 }]);
  assert.ok(__testOnlyVerifiedAnalogApplyReceipt(valid));
  const mutate = (change: (copy: any) => void) => { const copy = JSON.parse(JSON.stringify(valid)); change(copy); return copy; };
  for (const invalid of [
    mutate(copy => { copy.planHash = ""; }),
    mutate(copy => { copy.createdIds.push(copy.createdIds[0]); }),
    mutate(copy => { copy.readback[0].targetRoomNumber = "405"; }),
    mutate(copy => { copy.readback[0].orientation.agreement = 0.5; }),
    mutate(copy => { delete copy.readback[0].physicalHost.faceFingerprint; }),
    mutate(copy => { delete copy.readback[0].semanticAnchor; }),
    mutate(copy => { copy.typeCounts[0].count = 2; })
  ]) assert.equal(__testOnlyVerifiedAnalogApplyReceipt(invalid), null);

  const circuitValid = appliedReceipt([1700001], [{ familyType: "Duplex Receptacle|Standard", count: 1 }]) as any;
  circuitValid.circuitValidation = { mode: "match_source_system", verified: true, assignments: [{ exactMatch: true }] };
  assert.ok(__testOnlyVerifiedAnalogApplyReceipt(circuitValid));
  circuitValid.circuitValidation.assignments[0].exactMatch = false;
  assert.equal(__testOnlyVerifiedAnalogApplyReceipt(circuitValid), null);
});

test("applied receipt keeps success truthful while surfacing post-commit preview warnings", () => {
  const createdIds = [1700001, 1700002];
  const previewUnavailable = maybeRunDeterministicRoomReceptacleAnalog(request("", [{
    action_id: "apply-warning",
    method: "POST",
    path: "/revit/apply-room-receptacles-from-analog",
    status: "done",
    result_json: appliedReceipt(createdIds, [{ familyType: "Duplex Receptacle|Standard", count: 2 }], ["post_apply_preview_unavailable:InvalidOperationException"])
  }]));
  assert.deepEqual(previewUnavailable?.actions, []);
  assert.match(previewUnavailable?.assistant_message ?? "", /Room 403 is complete/);
  assert.match(previewUnavailable?.assistant_message ?? "", /optional post-apply preview image was unavailable/);
  assert.match(previewUnavailable?.assistant_message ?? "", /visual confirmation remains a follow-up/);

  const cleanupUnproven = maybeRunDeterministicRoomReceptacleAnalog(request("", [{
    action_id: "apply-cleanup-warning",
    method: "POST",
    path: "/revit/apply-room-receptacles-from-analog",
    status: "done",
    result_json: appliedReceipt(createdIds, [{ familyType: "Duplex Receptacle|Standard", count: 2 }], ["post_apply_preview_cleanup_failed:cleanup_not_proven"])
  }]));
  assert.match(cleanupUnproven?.assistant_message ?? "", /cleanup could not be proven/);
  assert.match(cleanupUnproven?.assistant_message ?? "", /inspect the current view/);
});

test("failed or incomplete preview/apply receipts fail closed without asking the user to steer recovery", () => {
  const failed = maybeRunDeterministicRoomReceptacleAnalog(request("", [{
    action_id: "preview",
    method: "POST",
    path: "/revit/plan-room-receptacles-from-analog",
    status: "failed",
    error: "analog_source_selection_failed"
  }]));
  assert.deepEqual(failed?.actions, []);
  assert.match(failed?.assistant_message ?? "", /No model changes were made/);

  const failedApply = maybeRunDeterministicRoomReceptacleAnalog(request("", [{
    action_id: "apply",
    method: "POST",
    path: "/revit/apply-room-receptacles-from-analog",
    status: "failed",
    error: "optional preview export failed after commit"
  }]));
  assert.deepEqual(failedApply?.actions, []);
  assert.match(failedApply?.assistant_message ?? "", /must be read back before any retry/);
  assert.doesNotMatch(failedApply?.assistant_message ?? "", /no (additional )?model changes were made/i);

  const incomplete = maybeRunDeterministicRoomReceptacleAnalog(request("", [{
    action_id: "apply",
    method: "POST",
    path: "/revit/apply-room-receptacles-from-analog",
    status: "done",
    result_json: { status: "applied", applied: true, createdIds: [1], readback: [] }
  }]));
  assert.deepEqual(incomplete?.actions, []);
  assert.match(incomplete?.assistant_message ?? "", /cannot claim/);
});
