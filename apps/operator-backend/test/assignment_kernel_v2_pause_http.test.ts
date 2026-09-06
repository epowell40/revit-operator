import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createServer } from "node:http";
import test from "node:test";
import { createGoal, getGoal, __testOnlyResetGoalListCache } from "../src/goals/service.js";
import { createAssignmentKernelForGoalV2 } from "../src/assignments/assignment_kernel_v2_factory.js";
import { appendCurrentAssignmentKernelEventV2, getAssignmentKernelSnapshotV2 } from "../src/assignments/assignment_kernel_v2_store.js";
import { handleVerifiedWorkPacketHttpRoute } from "../src/work_packets/http_routes.js";
import { loadVerifiedWorkPackets } from "../src/benchmark/work_packet_collection.js";
import { listVerifiedWorkPackets } from "../src/work_packets/store.js";
import { verifyVerifiedWorkPacketHash } from "../src/work_packets/generator.js";
import type { VerifiedWorkPacketV1 } from "../src/work_packets/contract.js";

test("paused clarification survives authenticated HTTP collection and never returns its stale packet after input resumes work", async () => {
  const previous = process.env.OPERATOR_WORKSPACE_ROOT;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "revitoperator-pause-http-"));
  process.env.OPERATOR_WORKSPACE_ROOT = root;
  __testOnlyResetGoalListCache();
  let authorized = false;
  const server = createServer((req, res) => {
    const handled = handleVerifiedWorkPacketHttpRoute(req, res, new URL(req.url!, "http://127.0.0.1"), sessionId => {
      if (authorized && sessionId === "pause-http-session") return true;
      res.writeHead(403).end(); return false;
    });
    if (!handled) res.writeHead(404).end();
  });
  try {
    const goal = createGoal({ title: "Replace selected note", objective: "Replace the selected note with approved wording.",
      acceptance_criteria: ["The supplied wording is applied and verified."], status: "active", created_by: "pause-http-principal",
      related_session_id: "pause-http-session", work_budget: { requested_effect: "apply", required_user_inputs: ["replacement_text"] } });
    createAssignmentKernelForGoalV2({ goal, run_id: "pause-http-run" });
    const binding = getAssignmentKernelSnapshotV2(goal.id)!.current_binding;
    const requested = appendCurrentAssignmentKernelEventV2({ goal_id: goal.id, binding, event_id: "pause-http-request", actor: "test-runtime",
      body: { event_type: "input_requested", variable_id: "replacement_text", clarification_id: "pause-http-question", question: "What exact replacement text should I use?" } });
    assert.equal(requested.accepted, true);
    assert.equal(getGoal(goal.id)!.status, "paused");
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const address = server.address(); assert(address && typeof address === "object");
    const base = `http://127.0.0.1:${address.port}`;
    const endpoint = `/api/assignments/${goal.id}/verified-work-packet`;
    assert.equal((await fetch(base + endpoint)).status, 403);
    authorized = true;
    const collected = await loadVerifiedWorkPackets(base, null, {
      schema: "revit-operator.benchmark-assignment-kernel-v2/v1", assignment_ids: [goal.id]
    }, async (url, pathname) => {
      const response = await fetch(url + pathname);
      assert.equal(response.status, 200);
      return await response.json() as Record<string, unknown>;
    });
    assert.deepEqual(collected.failures, []);
    const packets = collected.packets as VerifiedWorkPacketV1[];
    assert.equal(packets.length, 1);
    assert.equal(packets[0]!.status, "awaiting_clarification");
    assert.equal(packets[0]!.identity.run_id, binding.run_id);
    assert.equal(verifyVerifiedWorkPacketHash(packets[0]!), true);
    const repeated = await (await fetch(base + endpoint)).json() as { packet: VerifiedWorkPacketV1 };
    assert.equal(repeated.packet.packet_id, packets[0]!.packet_id);
    assert.equal(listVerifiedWorkPackets(goal.id).length, 1);
    const supplied = appendCurrentAssignmentKernelEventV2({ goal_id: goal.id, binding, event_id: "pause-http-supply", actor: "test-user",
      body: { event_type: "input_supplied", variable_id: "replacement_text", clarification_id: "pause-http-question", value: "Approved replacement" } });
    assert.equal(supplied.accepted, true);
    assert.equal(getAssignmentKernelSnapshotV2(goal.id)!.outcome, "active");
    assert.equal((await fetch(base + endpoint)).status, 409);
    assert.equal(listVerifiedWorkPackets(goal.id).length, 1, "Previously published pause remains immutable.");
  } finally {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    __testOnlyResetGoalListCache();
    if (previous === undefined) delete process.env.OPERATOR_WORKSPACE_ROOT; else process.env.OPERATOR_WORKSPACE_ROOT = previous;
    assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
    assert(path.basename(root).startsWith("revitoperator-pause-http-"));
    fs.rmSync(root, { recursive: true, force: true });
  }
});
