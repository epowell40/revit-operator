import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { decide, decideStreaming } from "../src/brain.js";
import { decideCodexStreaming } from "../src/brains/codex_brain.js";
import { OPERATOR_BACKEND_CONTRACT_VERSION } from "../src/contracts.js";
import { createAssignmentKernelForGoalV2 } from "../src/assignments/assignment_kernel_v2_factory.js";
import {
  classifyAssignmentKernelExecutionFailureV2,
  settleAssignmentKernelExecutionFailureV2
} from "../src/assignments/assignment_kernel_v2_execution_failure.js";
import {
  failAssignmentKernelOperationV2,
  markAssignmentKernelOperationDispatchStartedV2,
  openAssignmentKernelOperationV2
} from "../src/assignments/assignment_kernel_v2_execution.js";
import { appendCurrentAssignmentKernelEventV2, getAssignmentKernelSnapshotV2 } from "../src/assignments/assignment_kernel_v2_store.js";
import { __testOnlyResetGoalListCache, createGoal, getGoal } from "../src/goals/service.js";
import { listVerifiedWorkPackets } from "../src/work_packets/store.js";
import { listWorkReturns } from "../src/work_returns/store.js";
import { __closeForTests as closeMemoryStoreForTests } from "../src/memory/sqlite_store.js";

function workspace(fn: () => void): void {
  const previous = process.env.OPERATOR_WORKSPACE_ROOT;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "revitoperator-kernel-v2-provider-failure-"));
  process.env.OPERATOR_WORKSPACE_ROOT = root;
  __testOnlyResetGoalListCache();
  try { fn(); }
  finally {
    __testOnlyResetGoalListCache();
    if (previous === undefined) delete process.env.OPERATOR_WORKSPACE_ROOT;
    else process.env.OPERATOR_WORKSPACE_ROOT = previous;
    fs.rmSync(root, { recursive: true, force: true });
  }
}

async function asyncWorkspace(fn: () => Promise<void>): Promise<void> {
  const previousRoot = process.env.OPERATOR_WORKSPACE_ROOT;
  const previousTransport = process.env.OPERATOR_REVIT_TRANSPORT;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "revitoperator-kernel-v2-execution-failure-"));
  process.env.OPERATOR_WORKSPACE_ROOT = root;
  process.env.OPERATOR_REVIT_TRANSPORT = "courier";
  __testOnlyResetGoalListCache();
  try { await fn(); }
  finally {
    closeMemoryStoreForTests();
    __testOnlyResetGoalListCache();
    if (previousRoot === undefined) delete process.env.OPERATOR_WORKSPACE_ROOT;
    else process.env.OPERATOR_WORKSPACE_ROOT = previousRoot;
    if (previousTransport === undefined) delete process.env.OPERATOR_REVIT_TRANSPORT;
    else process.env.OPERATOR_REVIT_TRANSPORT = previousTransport;
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function setup(effect: "read" | "apply" = "read") {
  const goal = createGoal({
    title: "Candidate 65 provider-boundary replay",
    objective: effect === "read" ? "Return the requested Revit inventory." : "Apply the requested model update.",
    acceptance_criteria: ["The requested inventory is authoritatively established."],
    status: "active",
    related_session_id: "candidate-65-flight-2",
    created_by: "principal-candidate-65",
    work_budget: { requested_effect: effect, document_fingerprint: "snowdon-hvac-pristine" }
  });
  const binding = createAssignmentKernelForGoalV2({
    goal,
    run_id: "epic0460-candidate65-local-q01-flight-2"
  });
  return { goal, binding };
}

test("Candidate 65 pre-provider transport failure settles the exact quiescent V2 Assignment without invented work", () => workspace(() => {
  const { goal, binding } = setup();
  const before = getAssignmentKernelSnapshotV2(goal.id)!;
  assert.equal(before.assignment_version, 1);
  assert.equal(before.terminal, false);
  assert.equal(before.quiescent, true);
  assert.equal(before.provider_call_ids.length, 0);
  assert.equal(Object.keys(before.operations).length, 0);

  const settled = settleAssignmentKernelExecutionFailureV2({
    binding,
    failure_id: "message-candidate-65-flight-2",
    error_class: "transport",
    phase: "provider_turn",
    occurred_at: "2026-09-03T14:44:20.000Z"
  });

  assert.equal(settled.disposition, "terminal_failure");
  assert.equal(settled.snapshot.terminal, true);
  assert.equal(settled.snapshot.outcome, "blocked");
  assert.equal(settled.snapshot.terminal_reason, "provider_transport_failed");
  assert.equal(settled.snapshot.execution_failure_ids.length, 1);
  assert.equal(settled.snapshot.provider_call_ids.length, 0, "a failed transport is not manufactured into a provider receipt");
  assert.equal(Object.keys(settled.snapshot.operations).length, 0);
  assert.equal(Object.keys(settled.snapshot.observations).length, 0);
  assert.equal(getGoal(goal.id)?.status, "blocked");
  const workReturns = listWorkReturns(goal.id);
  const packets = listVerifiedWorkPackets(goal.id);
  assert.equal(workReturns.length, 1);
  assert.equal(packets.length, 1);
  assert.ok(workReturns[0]!.deviations_or_open_items.includes(
    "Execution stopped at provider_turn: provider_transport_failed."
  ));
  assert.ok(packets[0]!.issues.some(issue => issue.kind === "execution_failure"
    && issue.summary === "Execution stopped at provider_turn: provider_transport_failed."));

  __testOnlyResetGoalListCache();
  const replay = settleAssignmentKernelExecutionFailureV2({
    binding,
    failure_id: "message-candidate-65-flight-2",
    error_class: "transport",
    phase: "provider_turn",
    occurred_at: "2026-09-03T14:44:20.000Z"
  });
  assert.equal(replay.disposition, "terminal_preserved");
  assert.equal(replay.snapshot.assignment_version, settled.snapshot.assignment_version);
  assert.equal(listWorkReturns(goal.id).length, 1);
  assert.equal(listVerifiedWorkPackets(goal.id).length, 1);
}));

test("provider-boundary error classification is bounded and does not persist raw upstream detail", () => {
  assert.equal(classifyAssignmentKernelExecutionFailureV2(
    new Error("unexpected status 404 Not Found: Unknown error, url: https://chatgpt.com/backend-api/codex/responses")
  ), "transport");
  assert.equal(classifyAssignmentKernelExecutionFailureV2(new Error("HTTP 429 rate limit")), "resource_exhausted");
  assert.equal(classifyAssignmentKernelExecutionFailureV2(new Error("provider rejected the request")), "provider");
  assert.equal(classifyAssignmentKernelExecutionFailureV2(new Error("requested tool not found")), "provider",
    "semantic provider text is not evidence of a transport failure without a status or transport signal");
  assert.equal(classifyAssignmentKernelExecutionFailureV2(new Error("anything"), { canceled: true }), "canceled");
  assert.equal(classifyAssignmentKernelExecutionFailureV2(new Error("internal serialization error"), { runtime: true }), "runtime");
});

test("a pre-provider request rejection cannot orphan an already-admitted V2 Assignment", async () => asyncWorkspace(async () => {
  const { goal, binding } = setup();
  let delivered = "";
  const response = await decideCodexStreaming({
    version: OPERATOR_BACKEND_CONTRACT_VERSION,
    session_id: binding.session_id,
    message_id: "malformed-courier-boundary",
    assignment_id: binding.assignment_id,
    assignment_run_id: binding.run_id,
    assignment_generation: binding.generation,
    user_text: "Return the requested Revit inventory.",
    context: {
      revit: {
        courier_executor_id: "malformed\nexecutor",
        document: { title: "Snowdon Towers Sample HVAC", path: "C:\\fixtures\\Snowdon.rvt" }
      }
    }
  }, { onDone: (message) => { delivered = message; } });

  assert.match(response.assistant_message, /context integrity.*stopped before planning/i);
  assert.equal(delivered, response.assistant_message);
  assert.deepEqual(response.actions, []);
  assert.equal(response.assignment_snapshot_v2?.terminal, true);
  assert.equal(response.assignment_snapshot_v2?.outcome, "failed");
  assert.equal(response.assignment_snapshot_v2?.terminal_reason, "assignment_runtime_failed");
  assert.equal(response.assignment_snapshot_v2?.execution_failure_ids.length, 1);
  assert.equal(response.assignment_snapshot_v2?.provider_call_ids.length, 0);
  assert.equal(Object.keys(response.assignment_snapshot_v2?.operations ?? {}).length, 0);
  assert.equal(response.terminal_result_v2?.assignment_id, goal.id);
  assert.equal(getGoal(goal.id)?.status, "failed");
}));

test("an exact V2 binding bypasses legacy deterministic shortcuts in both chat modes", async () => asyncWorkspace(async () => {
  const { binding } = setup();
  const request = {
    version: OPERATOR_BACKEND_CONTRACT_VERSION,
    session_id: binding.session_id,
    message_id: "v2-must-not-enter-legacy-shortcut",
    assignment_id: binding.assignment_id,
    assignment_run_id: binding.run_id,
    assignment_generation: binding.generation,
    user_text: "Is the Revit bridge connected?"
  } as const;
  let ordinaryCalls = 0;
  const ordinary = await decide(request, {
    codexBrain: async () => {
      ordinaryCalls += 1;
      return { version: OPERATOR_BACKEND_CONTRACT_VERSION, assistant_message: "canonical-v2", actions: [] };
    }
  });
  assert.equal(ordinaryCalls, 1);
  assert.equal(ordinary.assistant_message, "canonical-v2");
  assert.deepEqual(ordinary.actions, [], "the legacy bridge-status action must not escape V2 operation ownership");

  let streamingCalls = 0;
  const streaming = await decideStreaming(request, {}, {
    codexStreamingBrain: async () => {
      streamingCalls += 1;
      return { version: OPERATOR_BACKEND_CONTRACT_VERSION, assistant_message: "canonical-v2-stream", actions: [] };
    }
  });
  assert.equal(streamingCalls, 1);
  assert.equal(streaming.assistant_message, "canonical-v2-stream");
  assert.deepEqual(streaming.actions, []);
}));

test("provider failure remains pending behind an unknown mutation effect and terminalizes only after reconciliation", () => workspace(() => {
  const { goal, binding } = setup("apply");
  const lease = openAssignmentKernelOperationV2({
    snapshot: getAssignmentKernelSnapshotV2(goal.id)!,
    controller_request_id: "apply-before-provider-failure",
    provider_turn_id: "provider-turn-with-apply",
    capability_id: "element.update",
    classified_effect: "apply",
    arguments: { target_id: "selected-element", value: "new value" }
  });
  markAssignmentKernelOperationDispatchStartedV2(lease);
  const unknown = failAssignmentKernelOperationV2(lease, new Error("native response lost"), "dispatching");
  assert.deepEqual(unknown.unresolved_unknown_operation_ids, [lease.operation_id]);

  const pending = settleAssignmentKernelExecutionFailureV2({
    binding,
    failure_id: "provider-turn-with-unknown-effect",
    error_class: "transport",
    phase: "provider_turn"
  });
  assert.equal(pending.disposition, "recovery_pending");
  assert.equal(pending.snapshot.terminal, false);
  assert.equal(pending.snapshot.outcome, "active");
  assert.deepEqual(pending.snapshot.unresolved_unknown_operation_ids, [lease.operation_id]);
  assert.throws(() => settleAssignmentKernelExecutionFailureV2({
    binding,
    failure_id: "provider-turn-with-unknown-effect",
    error_class: "provider",
    phase: "provider_turn"
  }), /execution_failure_identity_conflict/);

  appendCurrentAssignmentKernelEventV2({
    goal_id: goal.id,
    binding: pending.snapshot.current_binding,
    event_id: `reconciliation:${lease.operation_id}:none`,
    actor: "operator-recovery",
    body: {
      event_type: "reconciliation_recorded",
      operation_id: lease.operation_id,
      resolved_effect: "none",
      observation_ids: []
    }
  });
  const terminal = settleAssignmentKernelExecutionFailureV2({
    binding,
    failure_id: "provider-turn-with-unknown-effect",
    error_class: "transport",
    phase: "provider_turn"
  });
  assert.equal(terminal.snapshot.terminal, true);
  assert.equal(terminal.snapshot.outcome, "blocked");
  assert.equal(terminal.snapshot.terminal_reason, "provider_transport_failed");
  assert.equal(terminal.snapshot.operations[lease.operation_id]!.persistent_effect, "none");
}));
