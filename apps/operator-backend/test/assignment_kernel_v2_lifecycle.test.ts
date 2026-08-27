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
  settleAssignmentKernelOperationV2
} from "../src/assignments/assignment_kernel_v2_execution.js";
import { createAssignmentKernelForGoalV2 } from "../src/assignments/assignment_kernel_v2_factory.js";
import {
  evaluateAssignmentObservationCriteriaV2,
  requestAssignmentInputV2,
  supplyAssignmentInputV2
} from "../src/assignments/assignment_kernel_v2_lifecycle.js";
import { getAssignmentKernelSnapshotV2 } from "../src/assignments/assignment_kernel_v2_store.js";
import { OPERATION_RESULT_V2_SCHEMA, canonicalJsonV2 } from "../src/domain/assignment-kernel/index.js";
import { createHash } from "node:crypto";
import { __testOnlyResetGoalListCache, createGoal, getGoal } from "../src/goals/service.js";
import { listVerifiedWorkPackets } from "../src/work_packets/store.js";
import { listWorkReturns } from "../src/work_returns/store.js";
import { generateVerifiedWorkPacketFromKernelV2 } from "../src/work_packets/assignment_kernel_v2_generator.js";
import { generateWorkReturnFromKernelV2 } from "../src/work_returns/assignment_kernel_v2_generator.js";
import { projectGoalAssignment } from "../src/assignments/projection.js";
import { assertCompleteProtocolV2Receipts } from "../src/benchmark/protocol_v2_runner.js";
import {
  DEFAULT_ASSIGNMENT_PROGRESS_BUDGET_V2,
  advanceAssignmentKernelProgressV2,
  assignmentEfficiencyTraceV2,
  recordAssignmentProviderCallStateV2
} from "../src/assignments/assignment_kernel_v2_progress.js";

function workspace(fn: () => void): void {
  const previous = process.env.OPERATOR_WORKSPACE_ROOT;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "revitoperator-kernel-v2-lifecycle-"));
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

function setup(effect: "read" | "apply" = "read", requiredInputs: string[] = []) {
  const goal = createGoal({
    title: "Assignment Kernel V2 lifecycle",
    objective: effect === "read" ? "Return the requested inventory." : "Replace the selected note text.",
    acceptance_criteria: ["The requested result is authoritatively established."],
    status: "active",
    related_session_id: "session-v2-life",
    created_by: "principal-v2-life",
    work_budget: { requested_effect: effect, required_user_inputs: requiredInputs, document_fingerprint: "document-v2-life" }
  });
  const binding = createAssignmentKernelForGoalV2({ goal, run_id: "run-v2-life" });
  return { goal, binding, snapshot: getAssignmentKernelSnapshotV2(goal.id)! };
}

function resultEnvelope(operationId: string, binding: any, requestIdentity: any, payload: unknown) {
  const hash = createHash("sha256").update(canonicalJsonV2(payload), "utf8").digest("hex");
  return {
    content: [{ type: "text", text: "bounded projection" }],
    structuredContent: {
      schema: ASSIGNMENT_KERNEL_MCP_RESULT_V2_SCHEMA,
      operation_result_v2: {
        schema: OPERATION_RESULT_V2_SCHEMA,
        result_id: `result-${operationId}`,
        operation_id: operationId,
        binding,
        status: "succeeded",
        dispatch_state: "dispatched",
        persistent_effect: "none",
        native_transaction_state: "not_applicable",
        authority: "native-host",
        result_schema_id: "operator-capability/inventory.read/v2",
        observation_required: true,
        raw_payload_hash: hash,
        receipt_id: `receipt-${operationId}`,
        request_identity: requestIdentity,
        completed_at: "2026-08-26T18:00:01.000Z"
      },
      observation: {
        raw_payload: payload,
        semantic_facts: [{ fact_id: "result.available", value: true }],
        verification_relevance: ["task_result"]
      }
    }
  };
}

function settleRead(goalId: string) {
  const snapshot = getAssignmentKernelSnapshotV2(goalId)!;
  const lease = openAssignmentKernelOperationV2({
    snapshot,
    controller_request_id: "request-1",
    provider_turn_id: "turn-1",
    capability_id: "inventory.read",
    classified_effect: "read",
    arguments: { category: "Air Terminals" }
  });
  markAssignmentKernelOperationDispatchStartedV2(lease);
  const settled = settleAssignmentKernelOperationV2(lease, resultEnvelope(
    lease.operation_id, lease.binding, lease.request_identity, { total: 509 }
  ));
  return { lease, settled };
}

test("stable criterion plus authoritative Observation terminally settles V2 and projects packet/return exactly once", () => workspace(() => {
  const { goal, binding } = setup();
  const { settled } = settleRead(goal.id);
  const observationId = settled.observation!.observation_id;
  const criterionId = settled.snapshot.spec.criteria[0]!.criterion_id;
  const terminal = evaluateAssignmentObservationCriteriaV2({
    binding,
    claims: [{ criterion_id: criterionId, observation_ids: [observationId] }]
  });
  assert.equal(terminal.terminal, true);
  assert.equal(terminal.outcome, "complete");
  assert.equal(terminal.criteria[criterionId]!.status, "pass");
  const persistedGoal = getGoal(goal.id)!;
  assert.equal(persistedGoal.status, "complete");
  assert.ok(persistedGoal.finished_at);
  const packets = listVerifiedWorkPackets(goal.id);
  const returns = listWorkReturns(goal.id);
  assert.equal(packets.length, 1);
  assert.equal(returns.length, 1);
  assert.equal(
    packets[0]!.packet_id,
    generateVerifiedWorkPacketFromKernelV2(persistedGoal, terminal, null).packet_id,
    "Work Packet must be generated from the exact terminal snapshot returned by settlement."
  );
  assert.equal(
    returns[0]!.work_return_id,
    generateWorkReturnFromKernelV2(persistedGoal, terminal, null, packets[0]!).work_return_id,
    "Work Return must be generated from the same exact terminal snapshot as the Work Packet."
  );
  assert.throws(() => evaluateAssignmentObservationCriteriaV2({
    binding, claims: [{ criterion_id: criterionId, observation_ids: [observationId] }]
  }), /terminal_immutable/);
}));

test("Protocol V2 recognizes the same terminal V2 snapshot and native read Observation", () => workspace(() => {
  const { goal, binding } = setup();
  const settled = settleRead(goal.id).settled;
  evaluateAssignmentObservationCriteriaV2({
    binding,
    claims: [{ criterion_id: settled.snapshot.spec.criteria[0]!.criterion_id, observation_ids: [settled.observation!.observation_id] }]
  });
  const assignment = projectGoalAssignment(getGoal(goal.id)!);
  const packet = listVerifiedWorkPackets(goal.id)[0]!;
  assert.doesNotThrow(() => assertCompleteProtocolV2Receipts({
    model_telemetry_coverage: { complete: true, cases_with_model_receipts: 1 },
    task_traces: [{
      case_id: "generic-read",
      execution_expected_effect: "read",
      verification_results: { evaluation: { dispatched: true } },
      tool_results: {
        raw_sidecar_response_sha256: "a".repeat(64),
        durable_assignment_projection: { assignments: [assignment] },
        durable_tool_evidence: { schema: "revit-operator.benchmark-durable-tool-evidence/v1", canonical_attempt_receipts: [] },
        durable_work_packets: { schema: "revit-operator.benchmark-work-packets/v1", packets: [packet] }
      }
    }]
  }, ["generic-read"]));
}));

test("quiescence or assistant claim without authoritative Observation cannot complete", () => workspace(() => {
  const { goal, binding, snapshot } = setup();
  assert.equal(snapshot.quiescent, true);
  assert.throws(() => evaluateAssignmentObservationCriteriaV2({
    binding,
    claims: [{ criterion_id: snapshot.spec.criteria[0]!.criterion_id, observation_ids: ["assistant-prose"] }]
  }), /unknown observation/);
  assert.equal(getAssignmentKernelSnapshotV2(goal.id)!.terminal, false);
  assert.equal(getGoal(goal.id)!.finished_at, null);
}));

test("cross-Assignment Observation is rejected and apply Assignment is not promoted by read evidence", () => workspace(() => {
  const left = setup();
  const right = setup("apply");
  const observationId = settleRead(left.goal.id).settled.observation!.observation_id;
  assert.throws(() => evaluateAssignmentObservationCriteriaV2({
    binding: right.binding,
    claims: [{ criterion_id: right.snapshot.spec.criteria[0]!.criterion_id, observation_ids: [observationId] }]
  }), /unknown observation/);
  const rightRead = settleRead(right.goal.id).settled;
  const evaluated = evaluateAssignmentObservationCriteriaV2({
    binding: right.binding,
    claims: [{ criterion_id: rightRead.snapshot.spec.criteria[0]!.criterion_id, observation_ids: [rightRead.observation!.observation_id] }]
  });
  assert.equal(evaluated.terminal, false);
  assert.equal(evaluated.outcome, "active");
}));

test("stable clarification variable survives aliases and resumes the same Assignment", () => workspace(() => {
  const { goal, binding } = setup("apply", ["replacement_text"]);
  const pending = requestAssignmentInputV2({
    binding,
    clarification_id: "clarification-replacement",
    variable_ids: ["replacement_text"],
    question: "What exact replacement wording should I use?"
  });
  assert.equal(pending.outcome, "awaiting_user_input");
  const resumed = supplyAssignmentInputV2({
    binding,
    clarification_id: "clarification-replacement",
    external_values: { "replacement-text": "Current issue wording" }
  });
  assert.equal(resumed.current_binding.assignment_id, goal.id);
  assert.equal(resumed.input_values.replacement_text, "Current issue wording");
  assert.equal(resumed.pending_input_variable_ids.length, 0);
  assert.equal(resumed.clarifications["clarification-replacement"]!.resolved_at !== undefined, true);
}));

test("durable progress controller evaluates retained observations and terminalizes before another provider turn", () => workspace(() => {
  const { goal, binding } = setup();
  recordAssignmentProviderCallStateV2({
    binding,
    call_id: "provider-inventory",
    state: "admitted",
    provider: "openai",
    model: "gpt-test",
    reasoning_effort: "medium",
    gap_ids: [`criterion:${getAssignmentKernelSnapshotV2(goal.id)!.spec.criteria[0]!.criterion_id}`],
    criterion_ids: [getAssignmentKernelSnapshotV2(goal.id)!.spec.criteria[0]!.criterion_id],
    expected_information: ["result.available"]
  });
  recordAssignmentProviderCallStateV2({ binding, call_id: "provider-inventory", state: "dispatched" });
  recordAssignmentProviderCallStateV2({
    binding,
    call_id: "provider-inventory",
    state: "usage_received",
    usage: { input_tokens: 100, output_tokens: 20, reasoning_tokens: 5, total_tokens: 125, estimated_cost_usd: 0.02 }
  });
  recordAssignmentProviderCallStateV2({ binding, call_id: "provider-inventory", state: "completed", success: true });
  settleRead(goal.id);
  const before = getAssignmentKernelSnapshotV2(goal.id)!;
  assert.equal(Object.keys(before.criteria).length, 0);
  assert.equal(before.quiescent, true);

  const advanced = advanceAssignmentKernelProgressV2({ binding });
  assert.equal(advanced.snapshot.terminal, true);
  assert.equal(advanced.snapshot.outcome, "complete");
  assert.equal(advanced.snapshot.terminal_reason, "criterion_observations_evaluated");

  __testOnlyResetGoalListCache();
  const recovered = getAssignmentKernelSnapshotV2(goal.id)!;
  assert.equal(recovered.terminal, true);
  assert.equal(recovered.provider_calls["provider-inventory"]!.usage?.total_tokens, 125);
  const trace = assignmentEfficiencyTraceV2(goal.id);
  assert.equal(trace.provider_calls, 1);
  assert.equal(trace.criteria_closed, 1);
  assert.equal(trace.provider_call_explanations[0]!.why, `Resolve criterion:${recovered.spec.criteria[0]!.criterion_id} by obtaining result.available.`);
  assert.equal(listVerifiedWorkPackets(goal.id).length, 1);
  assert.equal(listWorkReturns(goal.id).length, 1);
}));

test("bounded reconciliation exhaustion terminalizes an unknown effect as blocked without replay", () => workspace(() => {
  const { goal, binding, snapshot } = setup("apply");
  const applyLease = openAssignmentKernelOperationV2({
    snapshot,
    controller_request_id: "apply-request",
    provider_turn_id: "apply-turn",
    capability_id: "element.update",
    classified_effect: "apply",
    target_tokens: ["id:selected-note"],
    arguments: { value: "new wording" }
  });
  markAssignmentKernelOperationDispatchStartedV2(applyLease);
  const unknown = failAssignmentKernelOperationV2(applyLease, new Error("native response lost"), "dispatching");
  assert.deepEqual(unknown.unresolved_unknown_operation_ids, [applyLease.operation_id]);
  assert.equal(unknown.quiescent, true);

  const reconciliationLease = openAssignmentKernelOperationV2({
    snapshot: unknown,
    controller_request_id: "reconciliation-request",
    provider_turn_id: "reconciliation-turn",
    capability_id: "element.read",
    classified_effect: "read",
    target_tokens: ["id:selected-note"],
    arguments: { target_id: "selected-note" }
  });
  markAssignmentKernelOperationDispatchStartedV2(reconciliationLease);
  const stillUnknown = failAssignmentKernelOperationV2(reconciliationLease, new Error("reconciliation result unavailable"), "dispatching");
  assert.deepEqual(stillUnknown.unresolved_unknown_operation_ids, [applyLease.operation_id]);

  const advanced = advanceAssignmentKernelProgressV2({
    binding,
    budget: { ...DEFAULT_ASSIGNMENT_PROGRESS_BUDGET_V2, max_reconciliation_attempts: 1 }
  });
  assert.equal(advanced.snapshot.terminal, true);
  assert.equal(advanced.snapshot.outcome, "blocked");
  assert.equal(advanced.snapshot.progress_blocker?.code, "reconciliation_budget_exhausted");
  assert.deepEqual(advanced.snapshot.unresolved_unknown_operation_ids, [applyLease.operation_id]);
  assert.equal(Object.keys(advanced.snapshot.operations).length, 2, "the mutation is never replayed");
  assert.equal(listVerifiedWorkPackets(goal.id).length, 1);
}));
