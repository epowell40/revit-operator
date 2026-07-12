import assert from "node:assert/strict";
import test from "node:test";
import { OPERATOR_BACKEND_CONTRACT_VERSION, type ChatRequest, type ToolResult } from "../src/contracts.js";
import { __testOnlyRoomReceptacleIntent, maybeRunDeterministicRoomReceptacleAnalog } from "../src/deterministic/room_receptacle_analog.js";

function request(userText = "", toolResults: ToolResult[] = []): ChatRequest {
  return { version: OPERATOR_BACKEND_CONTRACT_VERSION, session_id: "room-403-demo", message_id: "message-1", user_text: userText, tool_results: toolResults };
}

test("office-standard Room 403 intent enters the native preview path without model discovery chatter", () => {
  const response = maybeRunDeterministicRoomReceptacleAnalog(request("Lay out the receptacles in Room 403 based on our office standards."));
  assert.equal(response?.actions.length, 1);
  assert.equal(response?.actions[0]?.path, "/revit/plan-room-receptacles-from-analog");
  assert.deepEqual(response?.actions[0]?.body, { targetRoomNumber: "403", includePreviewImage: true });
  assert.equal(__testOnlyRoomReceptacleIntent("lay out the outlets in room 403 per our office standard"), "403");
  assert.equal(__testOnlyRoomReceptacleIntent("lay out the receptacles in room 403 and room 405 per our office standard"), null);
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
    result_json: {
      status: "applied",
      applied: true,
      source: { number: "405" },
      target: { number: "403" },
      createdIds,
      readback: createdIds.map(id => ({ id })),
      typeCounts: [
        { familyType: "Duplex Receptacle|Standard", count: 7 },
        { familyType: "Duplex Receptacle|GFCI", count: 4 },
        { familyType: "Duplex Receptacle|Counter Top", count: 1 },
        { familyType: "High Voltage Receptacle|Standard", count: 2 }
      ]
    }
  }]));
  assert.deepEqual(response?.actions, []);
  assert.match(response?.assistant_message ?? "", /Room 403 is complete/);
  assert.match(response?.assistant_message ?? "", /verified 14 receptacles/);
  assert.match(response?.assistant_message ?? "", /Room 405/);
});

test("applied receipt keeps success truthful while surfacing post-commit preview warnings", () => {
  const createdIds = [1700001, 1700002];
  const previewUnavailable = maybeRunDeterministicRoomReceptacleAnalog(request("", [{
    action_id: "apply-warning",
    method: "POST",
    path: "/revit/apply-room-receptacles-from-analog",
    status: "done",
    result_json: {
      status: "applied", applied: true, source: { number: "405" }, target: { number: "403" },
      createdIds, readback: createdIds.map(id => ({ id })),
      warnings: ["post_apply_preview_unavailable:InvalidOperationException"]
    }
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
    result_json: {
      status: "applied", applied: true, source: { number: "405" }, target: { number: "403" },
      createdIds, readback: createdIds.map(id => ({ id })),
      warnings: ["post_apply_preview_cleanup_failed:cleanup_not_proven"]
    }
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
