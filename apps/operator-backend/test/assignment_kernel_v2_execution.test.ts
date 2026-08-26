import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  ASSIGNMENT_KERNEL_MCP_RESULT_V2_SCHEMA,
  failAssignmentKernelOperationV2,
  markAssignmentKernelOperationDispatchStartedV2,
  openAssignmentKernelOperationV2,
  recoverAssignmentKernelOperationsV2,
  settleAssignmentKernelOperationV2
} from "../src/assignments/assignment_kernel_v2_execution.js";
import { createAssignmentKernelForGoalV2 } from "../src/assignments/assignment_kernel_v2_factory.js";
import { getAssignmentKernelSnapshotV2 } from "../src/assignments/assignment_kernel_v2_store.js";
import {
  OPERATION_RESULT_V2_SCHEMA,
  canonicalJsonV2,
  type OperationResultV2
} from "../src/domain/assignment-kernel/index.js";
import { createHash } from "node:crypto";
import { __testOnlyResetGoalListCache, createGoal, getGoal, transitionGoal } from "../src/goals/service.js";
import { ASSIGNMENT_ABSOLUTE_MODEL_CALL_LIMIT } from "../src/assignments/model_call_budget.js";
import {
  assignmentKernelV2ModelReceiptObserver,
  settleAssignmentKernelProviderBudgetAtQuiescenceV2
} from "../src/assignments/assignment_kernel_v2_provider_budget.js";

function workspace(fn: () => void): void {
  const previous = process.env.OPERATOR_WORKSPACE_ROOT;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "revitoperator-kernel-v2-execution-"));
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

function setup(effect: "read" | "apply" = "read") {
  const goal = createGoal({
    title: effect === "read" ? "Inventory elements" : "Update selected element",
    objective: effect === "read" ? "Return the requested inventory." : "Update the selected element.",
    acceptance_criteria: ["The requested result is authoritatively established."],
    status: "active",
    related_session_id: "session-execution",
    created_by: "principal-execution",
    work_budget: { requested_effect: effect, document_fingerprint: "document-execution" }
  });
  createAssignmentKernelForGoalV2({ goal, run_id: "run-execution" });
  return { goal, snapshot: getAssignmentKernelSnapshotV2(goal.id)! };
}

function hash(value: unknown): string {
  return createHash("sha256").update(canonicalJsonV2(value), "utf8").digest("hex");
}

function envelope(operationId: string, binding: any, payload: unknown, effect: "none" | "applied" = "none") {
  const result: OperationResultV2 = {
    schema: OPERATION_RESULT_V2_SCHEMA,
    result_id: `result-${operationId}`,
    operation_id: operationId,
    binding,
    status: "succeeded",
    dispatch_state: "dispatched",
    persistent_effect: effect,
    native_transaction_state: effect === "applied" ? "committed" : "not_applicable",
    authority: "native-host",
    result_schema_id: "operator-capability/inventory.read/v2",
    observation_required: true,
    raw_payload_hash: hash(payload),
    receipt_id: `receipt-${operationId}`,
    native_correlation_id: `native-${operationId}`,
    completed_at: "2026-08-26T16:00:05.000Z"
  };
  return {
    content: [{ type: "text", text: "bounded model projection" }],
    structuredContent: {
      schema: ASSIGNMENT_KERNEL_MCP_RESULT_V2_SCHEMA,
      operation_result_v2: result,
      observation: {
        raw_payload: payload,
        semantic_facts: [
          { fact_id: "result.available", value: true },
          { fact_id: "inventory.total", value: 2 }
        ],
        verification_relevance: ["task_result"]
      }
    }
  };
}

test("V2 operation identity survives admission, MCP acceptance, native result, evidence, and restart", () => workspace(() => {
  const { goal, snapshot } = setup();
  const lease = openAssignmentKernelOperationV2({
    snapshot,
    controller_request_id: "jsonrpc-17",
    provider_turn_id: "turn-17",
    capability_id: "inventory.read",
    classified_effect: "read",
    target_tokens: ["document-execution"],
    arguments: { category: "Air Terminals", assignmentId: "model-owned-spoof" },
    opened_at: "2026-08-26T16:00:00.000Z"
  });
  assert.ok(getAssignmentKernelSnapshotV2(goal.id)!.in_flight_operation_ids.includes(lease.operation_id));
  markAssignmentKernelOperationDispatchStartedV2(lease);
  const payload = { totalCount: 2, items: [{ familyName: "A", typeName: "B" }, { family_name: "A", type_name: "B" }] };
  const settled = settleAssignmentKernelOperationV2(lease, envelope(lease.operation_id, lease.binding, payload));
  assert.equal(settled.snapshot.operations[lease.operation_id]!.settlement_state, "settled");
  assert.equal(settled.snapshot.operations[lease.operation_id]!.dispatch_authority, "native");
  assert.equal(settled.snapshot.operations[lease.operation_id]!.persistent_effect, "none");
  assert.equal(settled.snapshot.observations[settled.observation!.observation_id]!.operation_id, lease.operation_id);
  assert.equal(settled.evidence_refs[0]!.attempt_id, lease.operation_id);
  assert.equal(settled.snapshot.quiescent, true);
  assert.equal(getGoal(goal.id)!.assignment_control_plane!.events.length, 0);
  __testOnlyResetGoalListCache();
  assert.deepEqual(getAssignmentKernelSnapshotV2(goal.id), settled.snapshot);
}));

test("duplicate native delivery is idempotent and does not create a second operation or observation", () => workspace(() => {
  const { goal, snapshot } = setup();
  const lease = openAssignmentKernelOperationV2({
    snapshot, controller_request_id: 3, provider_turn_id: "turn-3", capability_id: "inventory.read",
    classified_effect: "read", arguments: {}
  });
  markAssignmentKernelOperationDispatchStartedV2(lease);
  const result = envelope(lease.operation_id, lease.binding, { total: 1 });
  const first = settleAssignmentKernelOperationV2(lease, result);
  const second = settleAssignmentKernelOperationV2(lease, result);
  assert.deepEqual(second.snapshot, first.snapshot);
  assert.equal(Object.keys(second.snapshot.operations).length, 1);
  assert.equal(Object.keys(second.snapshot.observations).length, 1);
}));

test("MCP acceptance without a native read result settles no effect honestly", () => workspace(() => {
  const { snapshot } = setup();
  const lease = openAssignmentKernelOperationV2({
    snapshot, controller_request_id: 4, provider_turn_id: "turn-4", capability_id: "inventory.read",
    classified_effect: "read", arguments: {}
  });
  markAssignmentKernelOperationDispatchStartedV2(lease);
  const failed = failAssignmentKernelOperationV2(lease, new Error("transport_response_lost"), "dispatching");
  assert.equal(failed.operations[lease.operation_id]!.persistent_effect, "none");
  assert.equal(failed.operations[lease.operation_id]!.settlement_state, "settled");
  assert.equal(failed.quiescent, true);
}));

test("MCP acceptance without an apply settlement remains unknown and cannot be replayed", () => workspace(() => {
  const { snapshot } = setup("apply");
  const lease = openAssignmentKernelOperationV2({
    snapshot, controller_request_id: 5, provider_turn_id: "turn-5", capability_id: "element.update",
    classified_effect: "apply", arguments: { value: "new" }
  });
  markAssignmentKernelOperationDispatchStartedV2(lease);
  const failed = failAssignmentKernelOperationV2(lease, new Error("transport_response_lost"), "dispatching");
  assert.equal(failed.operations[lease.operation_id]!.persistent_effect, "unknown");
  assert.deepEqual(failed.unresolved_unknown_operation_ids, [lease.operation_id]);
  assert.equal(failed.quiescent, false);
  assert.throws(() => openAssignmentKernelOperationV2({
    snapshot: failed, controller_request_id: 6, provider_turn_id: "turn-6", capability_id: "element.update",
    classified_effect: "apply", arguments: { value: "new" }
  }), /unknown|operation/i);
  const reconciliation = openAssignmentKernelOperationV2({
    snapshot: failed, controller_request_id: 7, provider_turn_id: "turn-7", capability_id: "element.read",
    classified_effect: "read", arguments: { target_id: "selected" }
  });
  assert.equal(reconciliation.purpose, "reconciliation");
  assert.equal(getAssignmentKernelSnapshotV2(snapshot.spec.binding.assignment_id)!
    .operations[reconciliation.operation_id]!.reconciliation_of_operation_id, lease.operation_id);
}));

test("operation identity is derived from trusted controller identity, never a typed alias/native route pairing", () => workspace(() => {
  const { snapshot } = setup();
  const left = openAssignmentKernelOperationV2({
    snapshot, controller_request_id: "same-request", provider_turn_id: "same-turn", capability_id: "inventory.read",
    classified_effect: "read", arguments: { path: "/mcp/fake" }
  });
  assert.equal(left.operation_id.includes("revit"), false);
  assert.equal(left.operation_id.includes("mcp"), false);
  assert.equal(getAssignmentKernelSnapshotV2(snapshot.spec.binding.assignment_id)!.operations[left.operation_id]!.capability_id, "inventory.read");
}));

test("captured V2 operation binding settles after the legacy Goal envelope is paused", () => workspace(() => {
  const { goal, snapshot } = setup();
  const lease = openAssignmentKernelOperationV2({
    snapshot, controller_request_id: "paused-result", provider_turn_id: "paused-turn",
    capability_id: "inventory.read", classified_effect: "read", arguments: {}
  });
  markAssignmentKernelOperationDispatchStartedV2(lease);
  transitionGoal(goal.id, "paused", "Waiting for a separate user decision.");
  const settled = settleAssignmentKernelOperationV2(lease, envelope(lease.operation_id, lease.binding, { total: 1 }));
  assert.equal(settled.snapshot.operations[lease.operation_id]!.settlement_state, "settled");
  assert.equal(settled.snapshot.quiescent, true);
  assert.equal(settled.snapshot.current_binding.assignment_id, goal.id);
}));

test("read after committed apply is canonically a verification operation", () => workspace(() => {
  const { snapshot } = setup("apply");
  const applyLease = openAssignmentKernelOperationV2({
    snapshot, controller_request_id: "apply-request", provider_turn_id: "apply-turn",
    capability_id: "element.update", classified_effect: "apply", target_tokens: ["elementid:1478627", "id:1478627"], arguments: { value: "new" }
  });
  markAssignmentKernelOperationDispatchStartedV2(applyLease);
  const applied = settleAssignmentKernelOperationV2(
    applyLease,
    envelope(applyLease.operation_id, applyLease.binding, { updated: true }, "applied")
  ).snapshot;
  const verificationLease = openAssignmentKernelOperationV2({
    snapshot: applied, controller_request_id: "verify-request", provider_turn_id: "verify-turn",
    capability_id: "element.read", classified_effect: "read", target_tokens: ["elementid:1478627", "id:1478627"], arguments: { target_id: "1478627" }
  });
  assert.equal(verificationLease.purpose, "verification");
  assert.equal(verificationLease.requested_effect, "read");
  assert.equal(getAssignmentKernelSnapshotV2(snapshot.spec.binding.assignment_id)!
    .operations[verificationLease.operation_id]!.work_unit_id, "work-verification");
  assert.equal(getAssignmentKernelSnapshotV2(snapshot.spec.binding.assignment_id)!
    .operations[verificationLease.operation_id]!.verification_of_operation_id, applyLease.operation_id);
  assert.equal(getAssignmentKernelSnapshotV2(snapshot.spec.binding.assignment_id)!
    .operations[applyLease.operation_id]!.target.target_id, "id:1478627");
}));

test("restart resumes the same durable courier operation without opening or replaying a second operation", async () => {
  const previous = process.env.OPERATOR_WORKSPACE_ROOT;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "revitoperator-kernel-v2-recovery-"));
  process.env.OPERATOR_WORKSPACE_ROOT = root;
  __testOnlyResetGoalListCache();
  try {
    const { goal, snapshot } = setup();
    const lease = openAssignmentKernelOperationV2({
      snapshot, controller_request_id: "lost-response", provider_turn_id: "turn-before-restart",
      capability_id: "inventory.read", classified_effect: "read", arguments: { category: "Air Terminals" }
    });
    markAssignmentKernelOperationDispatchStartedV2(lease);
    __testOnlyResetGoalListCache();
    let calls = 0;
    const recovered = await recoverAssignmentKernelOperationsV2({
      snapshot: getAssignmentKernelSnapshotV2(goal.id)!,
      transport: "courier",
      runtime: {
        async callTool(tool, args, binding) {
          calls += 1;
          assert.equal(tool, "inventory.read");
          assert.deepEqual(args, { category: "Air Terminals" });
          assert.equal(binding.assignmentKernelV2.operation_id, lease.operation_id);
          return envelope(lease.operation_id, lease.binding, { total: 1 });
        }
      }
    });
    assert.equal(calls, 1);
    assert.equal(Object.keys(recovered.operations).length, 1);
    assert.equal(recovered.operations[lease.operation_id]!.settlement_state, "settled");
    assert.equal(Object.values(recovered.observations)[0]!.operation_id, lease.operation_id);
  } finally {
    __testOnlyResetGoalListCache();
    if (previous === undefined) delete process.env.OPERATOR_WORKSPACE_ROOT;
    else process.env.OPERATOR_WORKSPACE_ROOT = previous;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("restart never replays a possibly dispatched direct apply and preserves unknown effect", async () => {
  const previous = process.env.OPERATOR_WORKSPACE_ROOT;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "revitoperator-kernel-v2-direct-recovery-"));
  process.env.OPERATOR_WORKSPACE_ROOT = root;
  __testOnlyResetGoalListCache();
  try {
    const { goal, snapshot } = setup("apply");
    const lease = openAssignmentKernelOperationV2({
      snapshot, controller_request_id: "direct-lost", provider_turn_id: "direct-turn",
      capability_id: "element.update", classified_effect: "apply", arguments: { value: "new" }
    });
    markAssignmentKernelOperationDispatchStartedV2(lease);
    let calls = 0;
    const recovered = await recoverAssignmentKernelOperationsV2({
      snapshot: getAssignmentKernelSnapshotV2(goal.id)!,
      transport: "direct",
      runtime: { async callTool() { calls += 1; throw new Error("must not run"); } }
    });
    assert.equal(calls, 0);
    assert.equal(recovered.operations[lease.operation_id]!.settlement_state, "settled");
    assert.equal(recovered.operations[lease.operation_id]!.persistent_effect, "unknown");
    assert.deepEqual(recovered.unresolved_unknown_operation_ids, [lease.operation_id]);
  } finally {
    __testOnlyResetGoalListCache();
    if (previous === undefined) delete process.env.OPERATOR_WORKSPACE_ROOT;
    else process.env.OPERATOR_WORKSPACE_ROOT = previous;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("V2 provider budget is durable resource truth and cannot terminalize an in-flight operation", () => workspace(() => {
  const { goal, snapshot } = setup();
  const lease = openAssignmentKernelOperationV2({
    snapshot, controller_request_id: "budget-call", provider_turn_id: "budget-turn",
    capability_id: "inventory.read", classified_effect: "read", arguments: {}
  });
  markAssignmentKernelOperationDispatchStartedV2(lease);
  let interruptions = 0;
  const observe = assignmentKernelV2ModelReceiptObserver(lease.binding, () => { interruptions += 1; });
  for (let index = 0; index < ASSIGNMENT_ABSOLUTE_MODEL_CALL_LIMIT; index += 1) {
    observe({
      schema: "revit-operator.model-call-receipt.v1", call_id: `provider-${index}`, provider: "openai",
      route: "codex_agent", requested_model: "gpt-test", model: "gpt-test", reasoning_effort: "medium",
      started_at_utc: "2026-08-26T16:00:00.000Z", duration_ms: null, success: true,
      response_status: "completed", error_code: null,
      tokens: { input_tokens: null, cached_input_tokens: null, output_tokens: null, reasoning_output_tokens: null, total_tokens: null }
    });
  }
  const exhausted = getAssignmentKernelSnapshotV2(goal.id)!;
  assert.equal(exhausted.provider_call_ids.length, ASSIGNMENT_ABSOLUTE_MODEL_CALL_LIMIT);
  assert.equal(exhausted.provider_budget_exhausted, true);
  assert.equal(exhausted.quiescent, false);
  assert.equal(exhausted.terminal, false);
  assert.equal(interruptions, 1);
  assert.equal(settleAssignmentKernelProviderBudgetAtQuiescenceV2(lease.binding)?.terminal, false);

  failAssignmentKernelOperationV2(lease, new Error("provider interrupted at hard cap"), "dispatching");
  const terminal = settleAssignmentKernelProviderBudgetAtQuiescenceV2(lease.binding)!;
  assert.equal(terminal.quiescent, true);
  assert.equal(terminal.outcome, "failed");
  assert.equal(terminal.terminal, true);
  assert.equal(terminal.terminal_reason, "absolute_model_call_limit_reached");
}));
