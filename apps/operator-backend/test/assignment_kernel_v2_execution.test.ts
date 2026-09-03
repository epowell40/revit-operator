import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  ASSIGNMENT_KERNEL_MCP_RESULT_V2_SCHEMA,
  commitAssignmentKernelObservationV2,
  failAssignmentKernelOperationV2,
  leaseFromOperation,
  markAssignmentKernelOperationDispatchStartedV2,
  openAssignmentKernelChildOperationV2,
  openAssignmentKernelOperationV2,
  recoverAssignmentKernelOperationsV2,
  settleAssignmentKernelOperationV2
} from "../src/assignments/assignment_kernel_v2_execution.js";
import { createAssignmentKernelForGoalV2 } from "../src/assignments/assignment_kernel_v2_factory.js";
import { appendCurrentAssignmentKernelEventV2, getAssignmentKernelSnapshotV2 } from "../src/assignments/assignment_kernel_v2_store.js";
import {
  OPERATION_RESULT_V2_SCHEMA,
  canonicalJsonV2,
  deriveProgressGapsV2,
  type OperationResultV2
} from "../src/domain/assignment-kernel/index.js";
import { createHash } from "node:crypto";
import { storeEvidence } from "../src/evidence/evidence_store.js";
import { __testOnlyResetGoalListCache, createGoal, getGoal, transitionGoal } from "../src/goals/service.js";
import { ASSIGNMENT_ABSOLUTE_MODEL_CALL_LIMIT } from "../src/assignments/model_call_budget.js";
import { listVerifiedWorkPackets } from "../src/work_packets/store.js";
import {
  assignmentKernelV2ModelReceiptObserver,
  createAssignmentKernelV2ModelReceiptRecorder,
  settleAssignmentKernelProviderBudgetAtQuiescenceV2
} from "../src/assignments/assignment_kernel_v2_provider_budget.js";
import {
  assignmentKernelTerminalSettlementDeferredV2,
  beginAssignmentKernelTerminalBarrierV2,
  endAssignmentKernelTerminalBarrierV2
} from "../src/assignments/assignment_kernel_v2_terminal_barrier.js";
import {
  advanceAssignmentKernelProgressV2,
  recordAssignmentProgressEpochV2
} from "../src/assignments/assignment_kernel_v2_progress.js";
import { prepareCodexAssignmentProgressV2 } from "../src/brains/codex_assignment_progress.js";

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

function setup(effect: "read" | "preview" | "apply" = "read") {
  const read = effect === "read";
  const preview = effect === "preview";
  const goal = createGoal({
    title: read ? "Inventory elements" : preview ? "Preview selected element update" : "Update selected element",
    objective: read ? "Return the requested inventory."
      : preview ? "Preview the selected element update without applying it."
        : "Update the selected element.",
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
  const admitted = getAssignmentKernelSnapshotV2(binding.assignment_id)?.operations[operationId];
  const semanticFacts = admitted?.fulfillment_role === "supporting_control" || admitted?.fulfillment_role === "prerequisite"
    ? [{ fact_id: "control.result_available", fact_class: "control", value: true }]
    : admitted?.fulfillment_role === "verification"
      ? [{ fact_id: "verification.result_available", fact_class: "verification", value: true }]
      : [
          { fact_id: "task.result_available", fact_class: "domain", value: true },
          { fact_id: "inventory.complete", fact_class: "domain", value: true },
          { fact_id: "inventory.total", fact_class: "domain", value: 2 }
        ];
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
    request_identity: getAssignmentKernelSnapshotV2(binding.assignment_id)?.operations[operationId]?.request_identity,
    completed_at: "2026-08-26T16:00:05.000Z"
  };
  return {
    content: [{ type: "text", text: "bounded model projection" }],
    structuredContent: {
      schema: ASSIGNMENT_KERNEL_MCP_RESULT_V2_SCHEMA,
      operation_result_v2: result,
      observation: {
        raw_payload: payload,
        semantic_facts: semanticFacts,
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

test("native dispatch settlement preserves the causal pre-call start time", () => workspace(() => {
  const { goal, snapshot } = setup();
  const lease = openAssignmentKernelOperationV2({
    snapshot,
    controller_request_id: "candidate54-dispatch-clock",
    provider_turn_id: "candidate54-provider-turn",
    capability_id: "inventory.read",
    classified_effect: "read",
    arguments: {}
  });
  const dispatchStartedAt = "2026-09-02T14:00:00.000Z";
  appendCurrentAssignmentKernelEventV2({
    goal_id: goal.id,
    binding: lease.binding,
    event_id: `operation-dispatch-started:${lease.operation_id}`,
    actor: "mcp-client",
    occurred_at: dispatchStartedAt,
    body: { event_type: "operation_dispatch_started", operation_id: lease.operation_id }
  });
  const resultEnvelope = envelope(lease.operation_id, lease.binding, { total: 1 });
  resultEnvelope.structuredContent.operation_result_v2.completed_at = "2026-09-02T14:00:01.000Z";
  const settled = settleAssignmentKernelOperationV2(lease, resultEnvelope);
  const operation = settled.snapshot.operations[lease.operation_id]!;
  assert.equal(operation.dispatched_at, dispatchStartedAt);
  assert.ok(Date.parse(operation.dispatched_at!) <= Date.parse(operation.result!.completed_at));
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

test("Candidate 50 non-native capability result commits durable control evidence without advancing the task criterion", () => workspace(() => {
  const { goal, snapshot } = setup();
  const lease = openAssignmentKernelOperationV2({
    snapshot,
    controller_request_id: "candidate50-tool-search",
    provider_turn_id: "candidate50-provider-turn",
    capability_id: "revit_search_tools",
    classified_effect: "discovery",
    arguments: { query: "find and replace one text note" }
  });
  assert.equal(lease.fulfillment_role, "supporting_control");
  assert.deepEqual(lease.eligible_criterion_ids, []);
  const rawPayload = {
    content: [{
      type: "text",
      text: JSON.stringify({
        status: "available",
        matches: [
          { method: "GET", path: "/revit/find-text-notes" },
          { method: "POST", path: "/revit/replace-text-note" }
        ]
      })
    }]
  };
  const result: OperationResultV2 = {
    schema: OPERATION_RESULT_V2_SCHEMA,
    result_id: `result-${lease.operation_id}`,
    operation_id: lease.operation_id,
    binding: lease.binding,
    status: "succeeded",
    dispatch_state: "dispatched",
    persistent_effect: "none",
    native_transaction_state: "not_applicable",
    authority: "operator-mcp-transport",
    result_schema_id: "operator-capability/revit_search_tools/v2",
    observation_required: true,
    raw_payload_hash: hash(rawPayload),
    request_identity: lease.request_identity,
    completed_at: "2026-09-02T07:30:00.000Z"
  };
  const settled = settleAssignmentKernelOperationV2(lease, {
    content: rawPayload.content,
    structuredContent: {
      schema: ASSIGNMENT_KERNEL_MCP_RESULT_V2_SCHEMA,
      operation_result_v2: result,
      observation: {
        raw_payload: rawPayload,
        semantic_facts: [
          { fact_id: "control.result_available", fact_class: "control", value: true },
          {
            fact_id: "control.capability_available",
            fact_class: "control",
            value: true,
            cardinality: "many",
            identity_dimensions: ["capability_id", "method", "path"],
            dimensions: { capability_id: "revit_search_tools", method: "GET", path: "/revit/find-text-notes" }
          },
          {
            fact_id: "control.capability_available",
            fact_class: "control",
            value: true,
            cardinality: "many",
            identity_dimensions: ["capability_id", "method", "path"],
            dimensions: { capability_id: "revit_search_tools", method: "POST", path: "/revit/replace-text-note" }
          }
        ],
        verification_relevance: ["control"],
        evidence_class: "control"
      }
    }
  });

  assert.equal(settled.snapshot.operations[lease.operation_id]!.dispatch_authority, "mcp");
  assert.equal(settled.snapshot.operations[lease.operation_id]!.settlement_state, "settled");
  assert.equal(settled.observation?.authority, "operator-mcp-transport");
  assert.equal(settled.observation?.evidence_class, "control");
  assert.deepEqual(settled.observation?.eligible_criterion_ids, []);
  assert.equal(settled.snapshot.criteria[settled.snapshot.spec.criteria[0]!.criterion_id], undefined);
  assert.equal(settled.snapshot.observations[settled.observation!.observation_id]!.facts.some(
    fact => fact.fact_class === "domain"), false);
  __testOnlyResetGoalListCache();
  assert.deepEqual(getAssignmentKernelSnapshotV2(goal.id), settled.snapshot,
    "restart must recover the same controller knowledge without rerunning Revit");
}));

test("Candidate 55 effect causality admits preview support reads without task eligibility and reserves fulfillment for preview", () => workspace(() => {
  const { goal, snapshot } = setup("preview");
  const criterionId = snapshot.spec.criteria[0]!.criterion_id;
  const prepared = prepareCodexAssignmentProgressV2(snapshot.current_binding);
  assert.match(prepared.prompt, /Requested Assignment effect: preview/);
  assert.match(prepared.prompt, /Only an explicitly eligible preview task operation may fulfill a task criterion/);
  assert.match(prepared.prompt, /Supporting control, discovery, and evidence-read operations[\s\S]*cannot replace task fulfillment/);
  const read = openAssignmentKernelOperationV2({
    snapshot,
    controller_request_id: "candidate55-find-note",
    provider_turn_id: "candidate55-provider-find-note",
    capability_id: "revit_call_tool",
    classified_effect: "read",
    arguments: { method: "POST", path: "/revit/find-text-notes", body: { max: 1 } }
  });

  assert.equal(read.requested_effect, "read");
  assert.equal(read.purpose, "discovery");
  assert.equal(read.fulfillment_role, "supporting_control");
  assert.deepEqual(read.eligible_criterion_ids, []);
  assert.equal(read.delegation_authority_id, undefined);

  markAssignmentKernelOperationDispatchStartedV2(read);
  const readPayload = {
    ok: true,
    itemsComplete: false,
    elementIds: [1421361],
    textSamples: ["Existing note"],
    items: [{ elementId: 1421361, text: "Existing note" }]
  };
  const readEnvelope = envelope(read.operation_id, read.binding, readPayload) as any;
  readEnvelope.structuredContent.operation_result_v2.result_schema_id = "operator-native/POST:/revit/find-text-notes/v2";
  readEnvelope.structuredContent.observation.verification_relevance = ["control"];
  readEnvelope.structuredContent.observation.evidence_class = "control";
  const afterRead = settleAssignmentKernelOperationV2(read, readEnvelope).snapshot;
  assert.equal(afterRead.criteria[criterionId], undefined,
    "a successful support read must not evaluate or satisfy the preview criterion");
  assert.equal(afterRead.observations[afterRead.operations[read.operation_id]!.observation_ids[0]!]!.evidence_class, "control");

  const previewLease = openAssignmentKernelOperationV2({
    snapshot: afterRead,
    controller_request_id: "candidate55-preview-note",
    provider_turn_id: "candidate55-provider-preview-note",
    capability_id: "revit_call_tool",
    classified_effect: "preview",
    arguments: {
      method: "POST",
      path: "/revit/replace-text-note",
      body: { elementId: 1421361, newText: "Replacement", expectedOldText: "Existing note", dryRun: true, apply: false }
    }
  });
  assert.equal(previewLease.requested_effect, "preview");
  assert.equal(previewLease.purpose, "work");
  assert.equal(previewLease.fulfillment_role, "delegated_task_execution");
  assert.deepEqual(previewLease.eligible_criterion_ids, [criterionId]);
  assert.equal(previewLease.delegation_authority_id, `delegation:${previewLease.operation_id}`);
}));

test("Candidate 3 repaired sequence resolves only the schema gap before one corrected quantify task result", () => workspace(() => {
  const { goal, snapshot } = setup();
  const invalid = openAssignmentKernelOperationV2({
    snapshot,
    controller_request_id: "invalid-quantify",
    provider_turn_id: "turn-invalid",
    capability_id: "revit_call_tool",
    classified_effect: "read",
    arguments: { method: "POST", path: "/revit/quantify", body: { categories: "OST_DuctTerminal" } }
  });
  const failedResult: OperationResultV2 = {
    schema: OPERATION_RESULT_V2_SCHEMA,
    result_id: `result-${invalid.operation_id}`,
    operation_id: invalid.operation_id,
    binding: invalid.binding,
    status: "failed_before_dispatch",
    dispatch_state: "not_dispatched",
    persistent_effect: "none",
    native_transaction_state: "not_applicable",
    authority: "operator-mcp-transport",
    result_schema_id: "operation-transport-failure/v2",
    observation_required: false,
    completed_at: "2026-08-26T16:00:01.000Z",
    error_code: "mcp_request_validation_failed",
    request_identity: invalid.request_identity,
    input_schema_gap: {
      schema: "revit-operator.operation-input-schema-gap/v2",
      gap_id: `input-schema:${invalid.operation_id}`,
      operation_id: invalid.operation_id,
      capability_id: invalid.capability_id,
      input_schema_id: "operator-native/POST:/revit/quantify/input/v1",
      input_schema_digest: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      method: "POST",
      path: "/revit/quantify",
      request_signature: invalid.request_identity.request_signature,
      dispatch: false,
      effect: "none",
      issues: [{
        field_path: "body.categories",
        expected_type: "array",
        actual_type: "string",
        safe_correction_eligibility: "provider_corrected_arguments_required",
        correction_action: "provider_resubmit",
        expected_constraint: { kind: "json_type", type: "array" }
      }]
    }
  };
  settleAssignmentKernelOperationV2(invalid, {
    content: [],
    structuredContent: { schema: ASSIGNMENT_KERNEL_MCP_RESULT_V2_SCHEMA, operation_result_v2: failedResult }
  });
  __testOnlyResetGoalListCache();
  const afterInvalid = getAssignmentKernelSnapshotV2(goal.id)!;
  const inputGapId = `input-schema:${invalid.operation_id}`;
  assert.equal(afterInvalid.operations[invalid.operation_id]!.dispatch_state, "not_dispatched");
  assert.equal(afterInvalid.operations[invalid.operation_id]!.persistent_effect, "none");
  assert.equal(afterInvalid.operations[invalid.operation_id]!.observation_ids.length, 0);
  assert.deepEqual(afterInvalid.operations[invalid.operation_id]!.result?.input_schema_gap?.issues[0]?.expected_constraint,
    { kind: "json_type", type: "array" }, "the actionable schema constraint must survive restart replay");
  assert.ok(deriveProgressGapsV2(afterInvalid).some(gap => gap.gap_id === inputGapId
    && gap.kind === "operation_input_schema_invalid"));

  for (const [capabilityId, args] of [
    ["operator_discover_capabilities", { need: "inventory" }],
    ["revit_search_tools", { query: "inventory" }],
    ["operator_record_execution_strategy", { strategy: "inspect schema" }]
  ] as const) {
    assert.throws(() => openAssignmentKernelOperationV2({
      snapshot: getAssignmentKernelSnapshotV2(goal.id)!,
      controller_request_id: `unrelated-control-${capabilityId}`,
      provider_turn_id: `turn-unrelated-control-${capabilityId}`,
      capability_id: capabilityId,
      classified_effect: "discovery",
      arguments: args
    }), /input_schema_gap_requires_corrected_operation_or_exact_schema_docs/,
    `Candidate 28 replay: ${capabilityId} must not claim or consume an exact route input-schema correction gap`);
  }
  assert.ok(deriveProgressGapsV2(getAssignmentKernelSnapshotV2(goal.id)!).some(gap => gap.gap_id === inputGapId),
    "rejected generic discovery must leave the exact input-schema gap intact");

  const docs = openAssignmentKernelOperationV2({
    snapshot: getAssignmentKernelSnapshotV2(goal.id)!,
    controller_request_id: "tool-doc",
    provider_turn_id: "turn-doc",
    capability_id: "revit_tool_doc",
    classified_effect: "discovery",
    arguments: { method: "POST", path: "/revit/quantify" }
  });
  assert.equal(docs.fulfillment_role, "supporting_control");
  assert.deepEqual(docs.eligible_criterion_ids, []);
  assert.ok(getAssignmentKernelSnapshotV2(goal.id)!.operations[docs.operation_id]!.resolves_gap_ids.includes(inputGapId));
  markAssignmentKernelOperationDispatchStartedV2(docs);
  settleAssignmentKernelOperationV2(docs, envelope(docs.operation_id, docs.binding, { schema_available: true }));
  const afterDocs = getAssignmentKernelSnapshotV2(goal.id)!;
  assert.equal(deriveProgressGapsV2(afterDocs).some(gap => gap.gap_id === inputGapId), false);
  assert.equal(afterDocs.criteria[afterDocs.spec.criteria[0]!.criterion_id], undefined,
    "tool documentation must not evaluate or pass the inventory criterion");
  const docsObservation = afterDocs.observations[afterDocs.operations[docs.operation_id]!.observation_ids[0]!]!;
  assert.equal(docsObservation.evidence_class, "control");
  assert.deepEqual(docsObservation.eligible_criterion_ids, []);

  const corrected = openAssignmentKernelOperationV2({
    snapshot: afterDocs,
    controller_request_id: "corrected-quantify",
    provider_turn_id: "turn-corrected",
    capability_id: "revit_call_tool",
    classified_effect: "read",
    arguments: { method: "POST", path: "/revit/quantify", body: { categories: ["OST_DuctTerminal"] } }
  });
  const correctedOperation = getAssignmentKernelSnapshotV2(goal.id)!.operations[corrected.operation_id]!;
  assert.equal(correctedOperation.retry_of_operation_id, invalid.operation_id);
  assert.equal(correctedOperation.retry_basis, "corrected_input");
  assert.equal(corrected.fulfillment_role, "delegated_task_execution");
  markAssignmentKernelOperationDispatchStartedV2(corrected);
  const settled = settleAssignmentKernelOperationV2(corrected,
    envelope(corrected.operation_id, corrected.binding, { total: 2, groups: [{ family: "A", type: "B", count: 2 }] }));
  assert.equal(settled.observation?.evidence_class, "task_result");
  const decision = advanceAssignmentKernelProgressV2({ binding: corrected.binding });
  assert.equal(decision.decision.decision, "terminal",
    "the deterministic controller must evaluate the new task evidence before deriving completion");
  assert.equal(getAssignmentKernelSnapshotV2(goal.id)!.criteria[afterDocs.spec.criteria[0]!.criterion_id]?.status, "pass");
}));

test("Observation persistence retries only the durable commit and never repeats native work", async () => {
  const previous = process.env.OPERATOR_WORKSPACE_ROOT;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "revitoperator-kernel-v2-observation-retry-"));
  process.env.OPERATOR_WORKSPACE_ROOT = root;
  __testOnlyResetGoalListCache();
  try {
    const { goal, snapshot } = setup();
    const lease = openAssignmentKernelOperationV2({
      snapshot, controller_request_id: "commit-retry", provider_turn_id: "turn-commit-retry",
      capability_id: "inventory.read", classified_effect: "read", arguments: {}
    });
    markAssignmentKernelOperationDispatchStartedV2(lease);
    let persistenceAttempts = 0;
    assert.throws(() => settleAssignmentKernelOperationV2(
      lease,
      envelope(lease.operation_id, lease.binding, { total: 1 }),
      { storeEvidence() { persistenceAttempts += 1; throw new Error("simulated_evidence_store_unavailable"); } }
    ), /simulated_evidence_store_unavailable/);
    const pending = getAssignmentKernelSnapshotV2(goal.id)!;
    assert.equal(pending.operations[lease.operation_id]!.settlement_state, "retaining_observation");
    assert.equal(pending.operations[lease.operation_id]!.observation_commit_attempts, 1);
    assert.equal(pending.operations[lease.operation_id]!.result?.result_id, `result-${lease.operation_id}`);
    assert.deepEqual(pending.operations[lease.operation_id]!.observation_commit?.raw_payload, { total: 1 });
    assert.equal(advanceAssignmentKernelProgressV2({ binding: lease.binding }).decision.decision, "await_operation");

    let nativeCalls = 0;
    const recovered = await recoverAssignmentKernelOperationsV2({
      snapshot: pending,
      transport: "courier",
      runtime: { async callTool() { nativeCalls += 1; throw new Error("native_must_not_be_called"); } },
      observation_commit_runtime: { storeEvidence }
    });
    assert.equal(nativeCalls, 0);
    assert.equal(persistenceAttempts, 1);
    assert.equal(recovered.operations[lease.operation_id]!.settlement_state, "settled");
    assert.equal(recovered.operations[lease.operation_id]!.observation_ids.length, 1);
    assert.equal(Object.keys(recovered.operations).length, 1);
  } finally {
    __testOnlyResetGoalListCache();
    if (previous === undefined) delete process.env.OPERATOR_WORKSPACE_ROOT;
    else process.env.OPERATOR_WORKSPACE_ROOT = previous;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("bounded Observation commit failure terminalizes specifically without provider or native retry", async () => {
  const previousRoot = process.env.OPERATOR_WORKSPACE_ROOT;
  const previousLimit = process.env.OPERATOR_OBSERVATION_COMMIT_MAX_ATTEMPTS;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "revitoperator-kernel-v2-observation-failed-"));
  process.env.OPERATOR_WORKSPACE_ROOT = root;
  process.env.OPERATOR_OBSERVATION_COMMIT_MAX_ATTEMPTS = "3";
  __testOnlyResetGoalListCache();
  try {
    const { goal, snapshot } = setup();
    const lease = openAssignmentKernelOperationV2({
      snapshot, controller_request_id: "commit-failed", provider_turn_id: "turn-commit-failed",
      capability_id: "inventory.read", classified_effect: "read", arguments: {}
    });
    markAssignmentKernelOperationDispatchStartedV2(lease);
    const unavailable = { storeEvidence(): never { throw new Error("simulated_evidence_store_unavailable"); } };
    assert.throws(() => settleAssignmentKernelOperationV2(
      lease, envelope(lease.operation_id, lease.binding, { total: 1 }), unavailable
    ), /simulated_evidence_store_unavailable/);
    let nativeCalls = 0;
    for (let attempt = 2; attempt <= 3; attempt += 1) {
      await recoverAssignmentKernelOperationsV2({
        snapshot: getAssignmentKernelSnapshotV2(goal.id)!,
        transport: "courier",
        runtime: { async callTool() { nativeCalls += 1; throw new Error("native_must_not_be_called"); } },
        observation_commit_runtime: unavailable
      });
    }
    const failed = getAssignmentKernelSnapshotV2(goal.id)!;
    assert.equal(nativeCalls, 0);
    assert.equal(failed.operations[lease.operation_id]!.settlement_state, "observation_commit_failed");
    assert.equal(failed.operations[lease.operation_id]!.observation_commit_attempts, 3);
    assert.equal(failed.operations[lease.operation_id]!.result?.status, "succeeded");
    assert.equal(failed.progress_blocker?.code, "observation_commit_failed");
    assert.equal(failed.outcome, "blocked");
    assert.equal(failed.terminal, true);
  } finally {
    __testOnlyResetGoalListCache();
    if (previousRoot === undefined) delete process.env.OPERATOR_WORKSPACE_ROOT;
    else process.env.OPERATOR_WORKSPACE_ROOT = previousRoot;
    if (previousLimit === undefined) delete process.env.OPERATOR_OBSERVATION_COMMIT_MAX_ATTEMPTS;
    else process.env.OPERATOR_OBSERVATION_COMMIT_MAX_ATTEMPTS = previousLimit;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("restart fails a legacy pending Observation commit specifically instead of replaying Revit", async () => {
  const previous = process.env.OPERATOR_WORKSPACE_ROOT;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "revitoperator-kernel-v2-legacy-observation-pending-"));
  process.env.OPERATOR_WORKSPACE_ROOT = root;
  __testOnlyResetGoalListCache();
  try {
    const { goal, snapshot } = setup();
    const lease = openAssignmentKernelOperationV2({
      snapshot, controller_request_id: "legacy-pending", provider_turn_id: "turn-legacy-pending",
      capability_id: "inventory.read", classified_effect: "read", arguments: {}
    });
    markAssignmentKernelOperationDispatchStartedV2(lease);
    const raw = envelope(lease.operation_id, lease.binding, { total: 1 });
    const result = raw.structuredContent.operation_result_v2;
    appendCurrentAssignmentKernelEventV2({
      goal_id: goal.id,
      binding: lease.binding,
      event_id: `native-dispatch:${lease.operation_id}`,
      actor: "native-host",
      body: { event_type: "native_dispatch_recorded", operation_id: lease.operation_id }
    });
    appendCurrentAssignmentKernelEventV2({
      goal_id: goal.id,
      binding: lease.binding,
      event_id: `operation-result:${result.result_id}`,
      actor: "native-host",
      body: { event_type: "operation_result_recorded", result }
    });
    let nativeCalls = 0;
    const recovered = await recoverAssignmentKernelOperationsV2({
      snapshot: getAssignmentKernelSnapshotV2(goal.id)!,
      transport: "courier",
      runtime: { async callTool() { nativeCalls += 1; throw new Error("native_must_not_be_called"); } }
    });
    assert.equal(nativeCalls, 0);
    assert.equal(recovered.operations[lease.operation_id]!.result?.status, "succeeded");
    assert.equal(recovered.operations[lease.operation_id]!.settlement_state, "observation_commit_failed");
    assert.equal(recovered.operations[lease.operation_id]!.observation_retention_error, "observation_commit_payload_missing");
    assert.equal(recovered.outcome, "blocked");
    assert.equal(recovered.terminal, true);
  } finally {
    __testOnlyResetGoalListCache();
    if (previous === undefined) delete process.env.OPERATOR_WORKSPACE_ROOT;
    else process.env.OPERATOR_WORKSPACE_ROOT = previous;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("same result identity with a changed payload fails as an integrity conflict", () => workspace(() => {
  const { snapshot } = setup();
  const lease = openAssignmentKernelOperationV2({
    snapshot, controller_request_id: "conflict", provider_turn_id: "turn-conflict",
    capability_id: "inventory.read", classified_effect: "read", arguments: {}
  });
  markAssignmentKernelOperationDispatchStartedV2(lease);
  const first = envelope(lease.operation_id, lease.binding, { total: 1 });
  settleAssignmentKernelOperationV2(lease, first);
  const conflict = envelope(lease.operation_id, lease.binding, { total: 2 });
  (conflict.structuredContent.operation_result_v2 as OperationResultV2).raw_payload_hash = hash({ total: 2 });
  assert.throws(() => settleAssignmentKernelOperationV2(lease, conflict), /conflict|immutable|event/i);
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
  assert.equal(failed.quiescent, true);
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

test("Candidate 22 support reads cannot inherit inventory fulfillment while the exact quantify route can", () => workspace(() => {
  const { snapshot } = setup();
  const schedule = openAssignmentKernelOperationV2({
    snapshot, controller_request_id: "candidate22-schedule", provider_turn_id: "candidate22-turn-schedule",
    capability_id: "revit_list_schedules", classified_effect: "read",
    arguments: { action: "list", query: "air terminal" }
  });
  assert.equal(schedule.fulfillment_role, "supporting_control");
  assert.deepEqual(schedule.eligible_criterion_ids, []);
  const findElements = openAssignmentKernelOperationV2({
    snapshot: getAssignmentKernelSnapshotV2(snapshot.spec.binding.assignment_id)!,
    controller_request_id: "candidate22-find-elements", provider_turn_id: "candidate22-turn-find-elements",
    capability_id: "revit_call_tool", classified_effect: "read",
    arguments: { method: "POST", path: "/revit/find-elements", body: { category: "Air Terminals" } }
  });
  assert.equal(findElements.fulfillment_role, "supporting_control");
  assert.deepEqual(findElements.eligible_criterion_ids, []);
  const quantify = openAssignmentKernelOperationV2({
    snapshot: getAssignmentKernelSnapshotV2(snapshot.spec.binding.assignment_id)!,
    controller_request_id: "candidate22-quantify", provider_turn_id: "candidate22-turn-quantify",
    capability_id: "revit_call_tool", classified_effect: "read",
    arguments: { method: "POST", path: "/revit/quantify", body: { categories: ["OST_DuctTerminal"] } }
  });
  assert.equal(quantify.fulfillment_role, "delegated_task_execution");
  assert.deepEqual(quantify.eligible_criterion_ids, snapshot.spec.criteria.map(criterion => criterion.criterion_id));
}));

test("operation admission rejects an identical retry of structured schema-invalid input", () => workspace(() => {
  const { goal, snapshot } = setup();
  const invalidArguments = {
    method: "POST",
    path: "/revit/quantify",
    body: { intent: "Count every air terminal" }
  };
  const first = openAssignmentKernelOperationV2({
    snapshot,
    controller_request_id: "schema-invalid-first",
    provider_turn_id: "schema-invalid-turn",
    capability_id: "revit_call_tool",
    classified_effect: "read",
    arguments: invalidArguments
  });
  const rejectedResult: OperationResultV2 = {
    schema: OPERATION_RESULT_V2_SCHEMA,
    result_id: `result-${first.operation_id}`,
    operation_id: first.operation_id,
    binding: first.binding,
    status: "failed_before_dispatch",
    dispatch_state: "not_dispatched",
    persistent_effect: "none",
    native_transaction_state: "not_applicable",
    authority: "operator-mcp-transport",
    result_schema_id: "operator-capability/revit_call_tool/v2",
    observation_required: false,
    request_identity: first.request_identity,
    error_code: "mcp_tool_failed",
    input_schema_gap: {
      schema: "revit-operator.operation-input-schema-gap/v2",
      gap_id: `input-schema:${first.operation_id}`,
      operation_id: first.operation_id,
      capability_id: "revit_call_tool",
      input_schema_id: "operator-native/POST:/revit/quantify/input/v1",
      input_schema_digest: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      method: "POST",
      path: "/revit/quantify",
      request_signature: first.request_identity.request_signature,
      dispatch: false,
      effect: "none",
      issues: [{
        field_path: "body.intent",
        expected_type: "enum",
        actual_type: "string",
        safe_correction_eligibility: "provider_corrected_arguments_required",
        correction_action: "provider_resubmit",
        expected_constraint: { kind: "enum", allowed_values: ["count", "list", "count_and_list"] }
      }]
    },
    completed_at: "2026-08-28T21:27:05.927Z"
  };
  settleAssignmentKernelOperationV2(first, {
    content: [],
    structuredContent: { schema: ASSIGNMENT_KERNEL_MCP_RESULT_V2_SCHEMA, operation_result_v2: rejectedResult }
  });
  const rejectedSnapshot = getAssignmentKernelSnapshotV2(goal.id)!;

  assert.throws(() => openAssignmentKernelOperationV2({
    snapshot: rejectedSnapshot,
    controller_request_id: "schema-invalid-identical-retry",
    provider_turn_id: "schema-invalid-turn",
    capability_id: "revit_call_tool",
    classified_effect: "read",
    arguments: invalidArguments
  }), /identical_input_schema_retry/);
  assert.equal(Object.keys(getAssignmentKernelSnapshotV2(goal.id)!.operations).length, 1);
}));

test("Candidate 1 registry prerequisite settles only its child before the quantify parent", () => workspace(() => {
  const { goal, snapshot } = setup();
  const parent = openAssignmentKernelOperationV2({
    snapshot,
    controller_request_id: "candidate-1-parent",
    provider_turn_id: "candidate-1-turn",
    capability_id: "revit_call_tool",
    classified_effect: "read",
    arguments: { method: "POST", path: "/revit/quantify", body: { category: "Air Terminals" } },
    opened_at: "2026-08-27T12:30:00.000Z"
  });
  markAssignmentKernelOperationDispatchStartedV2(parent);
  const child = openAssignmentKernelChildOperationV2({
    binding: parent.binding,
    parent_operation_id: parent.operation_id,
    child_ordinal: 0,
    operation_role: "prerequisite",
    capability_id: "native:GET:/revit/tool-registry",
    classified_effect: "read",
    method: "GET",
    path: "/revit/tool-registry",
    arguments: { method: "GET", path: "/revit/tool-registry", body: null },
    opened_at: "2026-08-27T12:30:00.100Z"
  });
  assert.notEqual(child.operation_id, parent.operation_id);
  assert.equal(child.parent_operation_id, parent.operation_id);
  assert.equal(child.root_operation_id, parent.operation_id);
  assert.deepEqual(getAssignmentKernelSnapshotV2(goal.id)!.operations[child.operation_id]!.advances_criterion_ids, []);
  const nestedWait = advanceAssignmentKernelProgressV2({ binding: parent.binding });
  assert.equal(nestedWait.decision.decision, "await_operation");
  assert.deepEqual(new Set((nestedWait.decision as any).operation_ids), new Set([parent.operation_id, child.operation_id]));
  markAssignmentKernelOperationDispatchStartedV2(child);
  const childSettled = settleAssignmentKernelOperationV2(
    child,
    envelope(child.operation_id, child.binding, { tools: [{ method: "POST", path: "/revit/quantify" }] })
  ).snapshot;
  assert.equal(childSettled.operations[child.operation_id]!.settlement_state, "settled");
  assert.equal(childSettled.operations[parent.operation_id]!.settlement_state, "awaiting_result");
  assert.equal(childSettled.operations[parent.operation_id]!.result, undefined);
  assert.equal(childSettled.terminal, false);
  assert.deepEqual(childSettled.blocking_child_operation_ids, []);
  const parentWait = advanceAssignmentKernelProgressV2({ binding: parent.binding });
  assert.equal(parentWait.decision.decision, "await_operation");
  assert.deepEqual((parentWait.decision as any).operation_ids, [parent.operation_id]);

  const parentLease = leaseFromOperation(childSettled.operations[parent.operation_id]!);
  const completed = settleAssignmentKernelOperationV2(
    parentLease,
    envelope(parent.operation_id, parent.binding, { total: 509 })
  ).snapshot;
  assert.equal(completed.operations[parent.operation_id]!.settlement_state, "settled");
  assert.equal(completed.operations[parent.operation_id]!.result?.receipt_id, `receipt-${parent.operation_id}`);
  assert.equal(completed.operations[child.operation_id]!.result?.receipt_id, `receipt-${child.operation_id}`);
  assert.notEqual(
    completed.operations[parent.operation_id]!.result?.native_correlation_id,
    completed.operations[child.operation_id]!.result?.native_correlation_id
  );
  const progressed = advanceAssignmentKernelProgressV2({ binding: parent.binding });
  assert.equal(progressed.snapshot.terminal, true);
  assert.equal(progressed.snapshot.outcome, "complete");
  const evaluation = progressed.snapshot.criteria[progressed.snapshot.spec.criteria[0]!.criterion_id]!;
  assert.equal(evaluation.status, "pass");
  assert.ok(evaluation.supporting_facts.every((fact) => fact.observation_id
    === completed.operations[parent.operation_id]!.observation_ids[0]));
  assert.ok(!evaluation.supporting_facts.some((fact) => fact.observation_id
    === completed.operations[child.operation_id]!.observation_ids[0]));
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
  const readyForVerification = advanceAssignmentKernelProgressV2({ binding: applied.current_binding }).snapshot;
  assert.equal(readyForVerification.criteria[readyForVerification.spec.criteria[0]!.criterion_id]?.status, "pass");
  assert.equal(readyForVerification.outcome, "active",
    "a passing task-result criterion must not terminalize an apply before postcondition verification");
  assert.ok(deriveProgressGapsV2(readyForVerification).some((gap) =>
    gap.kind === "verification_required" && gap.gap_id === `verification:${applyLease.operation_id}`));
  assert.equal(readyForVerification.work_unit_states["work-verification"], "pending");
  const verificationLease = openAssignmentKernelOperationV2({
    snapshot: readyForVerification, controller_request_id: "verify-request", provider_turn_id: "verify-turn",
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
  markAssignmentKernelOperationDispatchStartedV2(verificationLease);
  const verificationPayload = { elementId: 1478627, value: "new" };
  assert.throws(() => settleAssignmentKernelOperationV2(
    verificationLease,
    envelope(verificationLease.operation_id, verificationLease.binding, verificationPayload),
    undefined,
    {
      schema: "revit-operator.teammate-verification-assertion/v2",
      operation_id: verificationLease.operation_id,
      action_id: "mcp:verification-readback",
      mode: "target_bound_readback",
      evidence_sha256: `sha256:${"a".repeat(64)}`
    }
  ), /assignment_kernel_v2_trusted_verification_evidence_mismatch/,
  "a controller assertion must not mint proof for different Observation bytes");
  const contradictoryPayload = { elementId: 1478627, value: "old" };
  assert.throws(() => settleAssignmentKernelOperationV2(
    verificationLease,
    envelope(verificationLease.operation_id, verificationLease.binding, contradictoryPayload),
    undefined,
    {
      schema: "revit-operator.teammate-verification-assertion/v2",
      operation_id: verificationLease.operation_id,
      action_id: "mcp:verification-readback",
      mode: "target_bound_readback",
      evidence_sha256: `sha256:${hash(contradictoryPayload)}`
    }
  ), /assignment_kernel_v2_trusted_verification_postcondition_not_satisfied/,
  "a verifier assertion may cite exact bytes but cannot override contradictory postcondition semantics");
  const verified = settleAssignmentKernelOperationV2(
    verificationLease,
    envelope(verificationLease.operation_id, verificationLease.binding, verificationPayload),
    undefined,
    {
      schema: "revit-operator.teammate-verification-assertion/v2",
      operation_id: verificationLease.operation_id,
      action_id: "mcp:verification-readback",
      mode: "target_bound_readback",
      evidence_sha256: `sha256:${hash(verificationPayload)}`
    }
  );
  assert.ok(verified.observation?.facts.some((fact) => fact.fact_id === "verification.postcondition_satisfied"
    && fact.fact_class === "verification" && fact.value === true));
  assert.equal(verified.snapshot.outcome, "complete");
  assert.equal(verified.snapshot.work_unit_states["work-verification"], "complete");
}));

test("authoritative affected identity from a targetless create binds its verification read", () => workspace(() => {
  const { snapshot } = setup("apply");
  const applyLease = openAssignmentKernelOperationV2({
    snapshot,
    controller_request_id: "create-with-native-target",
    provider_turn_id: "create-turn",
    capability_id: "revit_call_tool",
    classified_effect: "apply",
    arguments: {
      method: "POST",
      path: "/revit/create-text-note",
      body: { text: "Created by bounded verification test", apply: true }
    }
  });
  assert.equal(getAssignmentKernelSnapshotV2(snapshot.spec.binding.assignment_id)!
    .operations[applyLease.operation_id]!.target.target_id, undefined);
  markAssignmentKernelOperationDispatchStartedV2(applyLease);
  const appliedEnvelope = envelope(
    applyLease.operation_id,
    applyLease.binding,
    { createdElementId: 4242, text: "Created by bounded verification test" },
    "applied"
  );
  (appliedEnvelope.structuredContent.operation_result_v2 as any).affected_target_identities = ["element_id:4242"];
  const applied = settleAssignmentKernelOperationV2(applyLease, appliedEnvelope).snapshot;
  assert.deepEqual(applied.operations[applyLease.operation_id]!.result?.affected_target_identities, ["element_id:4242"]);
  const readyForVerification = advanceAssignmentKernelProgressV2({ binding: applied.current_binding }).snapshot;

  assert.throws(() => openAssignmentKernelOperationV2({
    snapshot: readyForVerification,
    controller_request_id: "wrong-created-target-read",
    provider_turn_id: "verification-turn",
    capability_id: "revit_call_tool",
    classified_effect: "read",
    target_tokens: ["id:9999"],
    arguments: { method: "POST", path: "/revit/find-text-notes", body: { elementIds: [9999] } }
  }), /verification_target_unbound/);

  const verificationLease = openAssignmentKernelOperationV2({
    snapshot: readyForVerification,
    controller_request_id: "created-target-read",
    provider_turn_id: "verification-turn",
    capability_id: "revit_call_tool",
    classified_effect: "read",
    target_tokens: ["elementid:4242", "id:4242"],
    arguments: { method: "POST", path: "/revit/find-text-notes", body: { elementIds: [4242] } }
  });
  assert.equal(getAssignmentKernelSnapshotV2(snapshot.spec.binding.assignment_id)!
    .operations[verificationLease.operation_id]!.verification_of_operation_id, applyLease.operation_id);
}));

test("operation admission cannot overtake retained evidence awaiting criterion evaluation", () => workspace(() => {
  const { goal, snapshot } = setup();
  const first = openAssignmentKernelOperationV2({
    snapshot,
    controller_request_id: "candidate49-first-quantify",
    provider_turn_id: "candidate49-provider-turn",
    capability_id: "inventory.read",
    classified_effect: "read",
    arguments: { categories: ["OST_DuctTerminal"], group_by: ["family", "type"] }
  });
  markAssignmentKernelOperationDispatchStartedV2(first);
  settleAssignmentKernelOperationV2(first, envelope(
    first.operation_id,
    first.binding,
    { total: 509, groups: [{ family: "A", type: "B", count: 509 }] }
  ));
  const retained = getAssignmentKernelSnapshotV2(goal.id)!;
  assert.equal(retained.criteria[retained.spec.criteria[0]!.criterion_id], undefined,
    "this regression deliberately captures the commit boundary before deterministic evaluation");
  assert.throws(() => openAssignmentKernelOperationV2({
    snapshot: retained,
    controller_request_id: "candidate49-redundant-quantify",
    provider_turn_id: "candidate49-provider-turn",
    capability_id: "inventory.read",
    classified_effect: "read",
    arguments: { categories: ["OST_DuctTerminal"], group_by: ["family", "type"], include_parameters: true }
  }), /criterion_evaluation_pending/,
  "an adapter may not bypass the deterministic evaluate-before-act decision");
  assert.equal(Object.keys(getAssignmentKernelSnapshotV2(goal.id)!.operations).length, 1);

  const progressed = advanceAssignmentKernelProgressV2({ binding: first.binding }).snapshot;
  assert.equal(progressed.criteria[progressed.spec.criteria[0]!.criterion_id]?.status, "pass");
  assert.equal(progressed.outcome, "complete");
}));

test("verification recovery re-derives the exact postcondition from durable apply input and readback", async () => {
  const previous = process.env.OPERATOR_WORKSPACE_ROOT;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "revitoperator-kernel-v2-verification-recovery-"));
  process.env.OPERATOR_WORKSPACE_ROOT = root;
  __testOnlyResetGoalListCache();
  try {
    const { goal, snapshot } = setup("apply");
    const applyLease = openAssignmentKernelOperationV2({
      snapshot, controller_request_id: "apply-before-restart", provider_turn_id: "apply-turn",
      capability_id: "revit_call_tool", classified_effect: "apply",
      target_tokens: ["id:1478627"],
      arguments: { method: "POST", path: "/revit/replace-text-note", body: { elementId: 1478627, newText: "new durable value" } }
    });
    markAssignmentKernelOperationDispatchStartedV2(applyLease);
    const applied = settleAssignmentKernelOperationV2(
      applyLease,
      envelope(applyLease.operation_id, applyLease.binding, { elementId: 1478627, changed: true }, "applied")
    ).snapshot;
    const readyForVerification = advanceAssignmentKernelProgressV2({ binding: applied.current_binding }).snapshot;
    assert.equal(readyForVerification.outcome, "active");
    const verificationLease = openAssignmentKernelOperationV2({
      snapshot: readyForVerification, controller_request_id: "verification-before-restart", provider_turn_id: "verification-turn",
      capability_id: "revit_call_tool", classified_effect: "read", target_tokens: ["id:1478627"],
      arguments: { method: "GET", path: "/revit/find-text-notes", body: { elementIds: [1478627] } }
    });
    markAssignmentKernelOperationDispatchStartedV2(verificationLease);

    __testOnlyResetGoalListCache();
    let calls = 0;
    const recovered = await recoverAssignmentKernelOperationsV2({
      snapshot: getAssignmentKernelSnapshotV2(goal.id)!,
      transport: "courier",
      runtime: {
        async callTool() {
          calls += 1;
          return envelope(verificationLease.operation_id, verificationLease.binding,
            { items: [{ elementId: 1478627, text: "new durable value" }] });
        }
      }
    });

    assert.equal(calls, 1);
    assert.equal(recovered.operations[verificationLease.operation_id]!.verification_of_operation_id, applyLease.operation_id);
    const observationId = recovered.operations[verificationLease.operation_id]!.observation_ids[0]!;
    assert.ok(recovered.observations[observationId]!.facts.some(fact =>
      fact.fact_id === "verification.postcondition_satisfied" && fact.fact_class === "verification" && fact.value === true));
  } finally {
    __testOnlyResetGoalListCache();
    if (previous === undefined) delete process.env.OPERATOR_WORKSPACE_ROOT;
    else process.env.OPERATOR_WORKSPACE_ROOT = previous;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("Candidate 59 Revit TextNote readback normalizes native paragraph delimiters without weakening value verification", () => workspace(() => {
  const { snapshot } = setup("apply");
  const replacement = "ISSUE 04 - COORDINATION SET - 2026-08-09\nVERIFY AGAINST CURRENT SHEET INDEX";
  const applyLease = openAssignmentKernelOperationV2({
    snapshot, controller_request_id: "candidate59-text-apply", provider_turn_id: "candidate59-apply-turn",
    capability_id: "revit_call_tool", classified_effect: "apply", target_tokens: ["id:1478627"],
    arguments: {
      method: "POST", path: "/revit/replace-text-note",
      body: { elementId: 1478627, newText: replacement, expectedOldText: "Chase for Electrical Conduit\r", apply: true }
    }
  });
  markAssignmentKernelOperationDispatchStartedV2(applyLease);
  const applied = settleAssignmentKernelOperationV2(
    applyLease,
    envelope(applyLease.operation_id, applyLease.binding, {
      status: "Applied", elementId: 1478627, before: "Chase for Electrical Conduit\r", after: replacement, changed: true
    }, "applied")
  ).snapshot;
  const readyForVerification = advanceAssignmentKernelProgressV2({ binding: applied.current_binding }).snapshot;
  const verificationLease = openAssignmentKernelOperationV2({
    snapshot: readyForVerification,
    controller_request_id: "candidate59-text-readback",
    provider_turn_id: "candidate59-verification-turn",
    capability_id: "revit_call_tool",
    classified_effect: "read",
    target_tokens: ["id:1478627"],
    arguments: { method: "POST", path: "/revit/find-text-notes", body: { elementId: 1478627, max: 1 } }
  });
  markAssignmentKernelOperationDispatchStartedV2(verificationLease);
  const verified = settleAssignmentKernelOperationV2(
    verificationLease,
    envelope(verificationLease.operation_id, verificationLease.binding, {
      ok: true,
      requestedElementIds: [1478627],
      exactElementFilterApplied: true,
      itemsComplete: true,
      items: [{ elementId: 1478627, text: replacement.replace(/\n/g, "\r") + "\r" }]
    })
  );
  assert.ok(verified.observation?.facts.some(fact => fact.fact_id === "verification.postcondition_satisfied"
    && fact.fact_class === "verification" && fact.value === true));
  assert.equal(verified.snapshot.outcome, "complete");
}));

test("Candidate 66 rejects a verification route whose result contract cannot expose the required TextNote value", () => workspace(() => {
  const { snapshot } = setup("apply");
  const replacement = "ISSUE 04 - COORDINATION SET - 2026-08-09\nVERIFY AGAINST CURRENT SHEET INDEX";
  const applyLease = openAssignmentKernelOperationV2({
    snapshot,
    controller_request_id: "candidate66-text-apply",
    provider_turn_id: "candidate66-apply-turn",
    capability_id: "revit_call_tool",
    classified_effect: "apply",
    target_tokens: ["elementid:1478627", "id:1478627"],
    arguments: {
      method: "POST",
      path: "/revit/replace-text-note",
      body: { elementId: 1478627, newText: replacement, apply: true }
    }
  });
  markAssignmentKernelOperationDispatchStartedV2(applyLease);
  const applied = settleAssignmentKernelOperationV2(
    applyLease,
    envelope(applyLease.operation_id, applyLease.binding, {
      status: "Applied", elementId: 1478627, before: "Chase for Electrical Conduit\r", after: replacement, changed: true
    }, "applied")
  ).snapshot;
  const readyForVerification = advanceAssignmentKernelProgressV2({ binding: applied.current_binding }).snapshot;

  assert.throws(() => openAssignmentKernelOperationV2({
    snapshot: readyForVerification,
    controller_request_id: "candidate66-incapable-summary-readback",
    provider_turn_id: "candidate66-verification-turn",
    capability_id: "revit_call_tool",
    classified_effect: "read",
    target_tokens: ["elementid:1478627", "id:1478627"],
    arguments: {
      method: "POST",
      path: "/revit/get-element-summary",
      body: { elementIds: [1478627] }
    }
  }), /assignment_kernel_v2_verification_capability_inadmissible:text_note_value_unavailable.*\/revit\/find-text-notes/);
  const retained = getAssignmentKernelSnapshotV2(snapshot.spec.binding.assignment_id)!;
  assert.equal(Object.values(retained.operations).filter(operation => operation.fulfillment_role === "verification").length, 0,
    "an incapable read must not consume an OperationV2 identity or native dispatch opportunity");
  const gap = deriveProgressGapsV2(retained).find(candidate => candidate.gap_id === `verification:${applyLease.operation_id}`);
  assert.ok(gap);
  assert.match(gap.reason, /Required semantic outputs: text_note\.value/);
  assert.match(gap.reason, /\/revit\/find-text-notes/);
}));

test("a successful verification read with the wrong value cannot mint a postcondition fact", () => workspace(() => {
  const { snapshot } = setup("apply");
  const applyLease = openAssignmentKernelOperationV2({
    snapshot, controller_request_id: "wrong-value-apply", provider_turn_id: "wrong-value-apply-turn",
    capability_id: "revit_call_tool", classified_effect: "apply", target_tokens: ["id:1478627"],
    arguments: { method: "POST", path: "/revit/replace-text-note", body: { elementId: 1478627, newText: "expected" } }
  });
  markAssignmentKernelOperationDispatchStartedV2(applyLease);
  const applied = settleAssignmentKernelOperationV2(
    applyLease, envelope(applyLease.operation_id, applyLease.binding, { elementId: 1478627, changed: true }, "applied")
  ).snapshot;
  const readyForVerification = advanceAssignmentKernelProgressV2({ binding: applied.current_binding }).snapshot;
  assert.equal(readyForVerification.outcome, "active");
  const verificationLease = openAssignmentKernelOperationV2({
    snapshot: readyForVerification, controller_request_id: "wrong-value-read", provider_turn_id: "wrong-value-read-turn",
    capability_id: "revit_call_tool", classified_effect: "read", target_tokens: ["id:1478627"],
    arguments: { method: "GET", path: "/revit/find-text-notes", body: { elementIds: [1478627] } }
  });
  markAssignmentKernelOperationDispatchStartedV2(verificationLease);
  const settled = settleAssignmentKernelOperationV2(
    verificationLease,
    envelope(verificationLease.operation_id, verificationLease.binding, { items: [{ elementId: 1478627, text: "wrong" }] })
  );
  assert.ok(!settled.observation?.facts.some(fact => fact.fact_id === "verification.postcondition_satisfied"));
}));

test("request echoes and metadata cannot impersonate an authoritative postcondition readback", () => workspace(() => {
  const { snapshot } = setup("apply");
  const applyLease = openAssignmentKernelOperationV2({
    snapshot, controller_request_id: "echo-apply", provider_turn_id: "echo-apply-turn",
    capability_id: "revit_call_tool", classified_effect: "apply", target_tokens: ["id:1478627"],
    arguments: { method: "POST", path: "/revit/replace-text-note", body: { elementId: 1478627, newText: "expected" } }
  });
  markAssignmentKernelOperationDispatchStartedV2(applyLease);
  const applied = settleAssignmentKernelOperationV2(
    applyLease, envelope(applyLease.operation_id, applyLease.binding, { elementId: 1478627, changed: true }, "applied")
  ).snapshot;
  const readyForVerification = advanceAssignmentKernelProgressV2({ binding: applied.current_binding }).snapshot;
  assert.equal(readyForVerification.outcome, "active");
  const verificationLease = openAssignmentKernelOperationV2({
    snapshot: readyForVerification, controller_request_id: "echo-read", provider_turn_id: "echo-read-turn",
    capability_id: "revit_call_tool", classified_effect: "read", target_tokens: ["id:1478627"],
    arguments: { method: "GET", path: "/revit/find-text-notes", body: { elementIds: [1478627] } }
  });
  markAssignmentKernelOperationDispatchStartedV2(verificationLease);
  const settled = settleAssignmentKernelOperationV2(
    verificationLease,
    envelope(verificationLease.operation_id, verificationLease.binding, {
      items: [{ elementId: 1478627, text: "wrong" }],
      metadata: { request: { body: { newText: "expected" } } }
    })
  );
  assert.ok(!settled.observation?.facts.some(fact => fact.fact_id === "verification.postcondition_satisfied"));
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
  assert.equal(exhausted.provider_budget_exhausted, false,
    "reaching the cap stops new reasoning but must not pre-judge an admitted operation still in flight");
  assert.equal(exhausted.quiescent, false);
  assert.equal(exhausted.terminal, false);
  assert.equal(interruptions, 1);
  assert.equal(settleAssignmentKernelProviderBudgetAtQuiescenceV2(lease.binding)?.terminal, false);

  failAssignmentKernelOperationV2(lease, new Error("provider interrupted at hard cap"), "dispatching");
  const terminal = settleAssignmentKernelProviderBudgetAtQuiescenceV2(lease.binding)!;
  assert.equal(terminal.quiescent, true);
  assert.equal(terminal.outcome, "failed");
  assert.equal(terminal.provider_budget_exhausted, true);
  assert.equal(terminal.terminal, true);
  assert.equal(terminal.terminal_reason, "absolute_model_call_limit_reached");
}));

test("provider cap cannot invalidate a successful final admitted operation", () => workspace(() => {
  const { goal, snapshot } = setup();
  const lease = openAssignmentKernelOperationV2({
    snapshot,
    controller_request_id: "budget-final-success",
    provider_turn_id: "budget-final-turn",
    capability_id: "inventory.read",
    classified_effect: "read",
    arguments: {}
  });
  markAssignmentKernelOperationDispatchStartedV2(lease);
  const observe = assignmentKernelV2ModelReceiptObserver(lease.binding, () => {});
  for (let index = 0; index < ASSIGNMENT_ABSOLUTE_MODEL_CALL_LIMIT; index += 1) {
    observe({
      schema: "revit-operator.model-call-receipt.v1",
      call_id: `provider-final-success-${index}`,
      provider: "openai",
      route: "codex_agent",
      requested_model: "gpt-test",
      model: "gpt-test",
      reasoning_effort: "medium",
      started_at_utc: "2026-08-26T16:00:00.000Z",
      duration_ms: null,
      success: true,
      response_status: "completed",
      error_code: null,
      tokens: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1, reasoning_output_tokens: 0, total_tokens: 2 }
    });
  }
  assert.equal(getAssignmentKernelSnapshotV2(goal.id)!.provider_budget_exhausted, false);
  settleAssignmentKernelOperationV2(lease, envelope(
    lease.operation_id,
    lease.binding,
    { result: "authoritative" }
  ));
  const terminal = settleAssignmentKernelProviderBudgetAtQuiescenceV2(lease.binding)!;
  assert.equal(terminal.terminal, true);
  assert.equal(terminal.outcome, "complete");
  assert.equal(terminal.provider_budget_exhausted, false);
  assert.equal(terminal.provider_call_ids.length, ASSIGNMENT_ABSOLUTE_MODEL_CALL_LIMIT);
}));

test("late provider receipt evaluates an already-retained Observation instead of admitting another reasoning turn", () => workspace(() => {
  const { goal, snapshot } = setup();
  const lease = openAssignmentKernelOperationV2({
    snapshot,
    controller_request_id: "late-provider-receipt",
    provider_turn_id: "turn-late-receipt",
    capability_id: "inventory.read",
    classified_effect: "read",
    arguments: {}
  });
  markAssignmentKernelOperationDispatchStartedV2(lease);
  const settled = settleAssignmentKernelOperationV2(lease, envelope(
    lease.operation_id,
    lease.binding,
    { result: "authoritative" }
  ));
  const epoch = recordAssignmentProgressEpochV2({
    before: snapshot,
    after: settled.snapshot,
    stated_gap_ids: deriveProgressGapsV2(snapshot).map(gap => gap.gap_id),
    admitted_operation_ids: [lease.operation_id]
  });
  assert.equal(epoch.terminal, false);
  assert.equal(Object.keys(epoch.criteria).length, 0);

  let stops = 0;
  assignmentKernelV2ModelReceiptObserver(lease.binding, () => { stops += 1; })({
    schema: "revit-operator.model-call-receipt.v1",
    call_id: "provider-late-receipt",
    provider: "openai",
    route: "codex_agent",
    requested_model: "gpt-test",
    model: "gpt-test",
    reasoning_effort: "medium",
    started_at_utc: "2026-08-26T16:00:00.000Z",
    duration_ms: null,
    success: true,
    response_status: "completed",
    error_code: null,
    tokens: {
      input_tokens: 100,
      cached_input_tokens: 0,
      output_tokens: 20,
      reasoning_output_tokens: 5,
      total_tokens: 120
    },
    turn_id: "turn-late-receipt"
  });
  const terminal = getAssignmentKernelSnapshotV2(goal.id)!;
  assert.equal(terminal.terminal, true);
  assert.equal(terminal.outcome, "complete");
  assert.equal(stops, 1);
  const provider = terminal.provider_calls["provider-late-receipt"]!;
  assert.equal(provider.controller_turn_id, "turn-late-receipt");
  assert.equal(provider.dispatched_at, provider.admitted_at);
  assert.equal(provider.response_started_at, provider.admitted_at);
  assert.equal(provider.usage?.total_tokens, 120);
}));

test("Candidate 46 provider receipt cannot be overtaken by terminal settlement", () => workspace(() => {
  const { goal, snapshot } = setup();
  const barrier = beginAssignmentKernelTerminalBarrierV2({
    binding: snapshot.current_binding,
    barrier_id: "candidate46-provider-turn"
  });
  try {
    const recorder = createAssignmentKernelV2ModelReceiptRecorder({
      binding: snapshot.current_binding,
      admission_snapshot: snapshot,
      onStop: () => {}
    });
    for (let index = 1; index <= 4; index += 1) {
      recorder.observe({
        schema: "revit-operator.model-call-receipt.v1",
        call_id: `candidate46-prior-${index}`,
        provider: "openai",
        route: "codex_agent",
        requested_model: "gpt-test",
        model: "gpt-test",
        reasoning_effort: "medium",
        started_at_utc: "2026-09-02T00:46:17.390Z",
        duration_ms: null,
        success: true,
        response_status: "completed",
        error_code: null,
        tokens: { input_tokens: 10, cached_input_tokens: 0, output_tokens: 2, reasoning_output_tokens: 1, total_tokens: 12 },
        turn_id: "candidate46-turn"
      });
    }

    const beforeOperation = getAssignmentKernelSnapshotV2(goal.id)!;
    const lease = openAssignmentKernelOperationV2({
      snapshot: beforeOperation,
      controller_request_id: "candidate46-quantify",
      provider_turn_id: "candidate46-turn",
      capability_id: "inventory.read",
      classified_effect: "read",
      arguments: {}
    });
    markAssignmentKernelOperationDispatchStartedV2(lease);
    const settled = settleAssignmentKernelOperationV2(lease, envelope(
      lease.operation_id,
      lease.binding,
      { result: "authoritative" }
    ));
    const epoch = recordAssignmentProgressEpochV2({
      before: beforeOperation,
      after: settled.snapshot,
      stated_gap_ids: deriveProgressGapsV2(beforeOperation).map(gap => gap.gap_id),
      admitted_operation_ids: [lease.operation_id]
    });
    const candidate = advanceAssignmentKernelProgressV2({ binding: epoch.current_binding });
    assert.equal(candidate.snapshot.outcome, "complete");
    assert.equal(candidate.snapshot.terminal, false,
      "terminal commit must wait for receipts from the active provider turn");

    const currentReceipt = {
      schema: "revit-operator.model-call-receipt.v1" as const,
      call_id: "candidate46-current-response",
      provider: "openai" as const,
      route: "codex_agent" as const,
      requested_model: "gpt-test",
      model: "gpt-test",
      reasoning_effort: "medium" as const,
      started_at_utc: "2026-09-02T00:46:17.390Z",
      duration_ms: null,
      success: true,
      response_status: "completed",
      error_code: null,
      tokens: { input_tokens: 33_175, cached_input_tokens: 0, output_tokens: 92, reasoning_output_tokens: 10, total_tokens: 33_267 },
      turn_id: "candidate46-turn"
    };
    // Simulate a delayed raw-response notification: the end-of-turn ledger is
    // the independent second sink and must recover the receipt exactly once.
    recorder.reconcile([currentReceipt]);
    const retained = getAssignmentKernelSnapshotV2(goal.id)!;
    assert.equal(retained.provider_call_ids.length, 5);
    assert.ok(retained.provider_calls[currentReceipt.call_id]);
    assert.equal(retained.terminal, false);
    assert.throws(() => openAssignmentKernelOperationV2({
      snapshot: retained,
      controller_request_id: "candidate46-obsolete-follow-up",
      provider_turn_id: "candidate46-turn",
      capability_id: "inventory.read",
      classified_effect: "read",
      arguments: {}
    }), /operation_admission_after_terminal_outcome/,
    "a receipt-complete but barrier-delayed terminal outcome cannot admit more work");
    assert.throws(() => recorder.reconcile([{
      ...currentReceipt,
      tokens: { ...currentReceipt.tokens, total_tokens: currentReceipt.tokens.total_tokens + 1 }
    }]), /provider_receipt_conflict/,
    "a duplicate response identity with different usage must fail closed");
  } finally {
    endAssignmentKernelTerminalBarrierV2(barrier);
  }
  const terminal = advanceAssignmentKernelProgressV2({ binding: snapshot.current_binding }).snapshot;
  assert.equal(terminal.terminal, true);
  assert.equal(terminal.outcome, "complete");
  assert.equal(terminal.provider_call_ids.length, 5);
  const packet = listVerifiedWorkPackets(goal.id).at(-1);
  assert.equal(packet?.performance.model_calls, 5,
    "terminal artifacts must be generated from the receipt-complete snapshot");
}));

test("terminal barriers are exclusive per request and all independent provider turns must release", () => workspace(() => {
  const { snapshot } = setup();
  const first = beginAssignmentKernelTerminalBarrierV2({
    binding: snapshot.current_binding,
    barrier_id: "concurrent-provider-request-1"
  });
  assert.throws(() => beginAssignmentKernelTerminalBarrierV2({
    binding: snapshot.current_binding,
    barrier_id: "concurrent-provider-request-1"
  }), /terminal_barrier_already_active/,
  "a duplicate live request must fail closed instead of sharing a releasable lease");
  const second = beginAssignmentKernelTerminalBarrierV2({
    binding: snapshot.current_binding,
    barrier_id: "concurrent-provider-request-2"
  });
  assert.equal(assignmentKernelTerminalSettlementDeferredV2(snapshot.current_binding), true);
  endAssignmentKernelTerminalBarrierV2(first);
  assert.equal(assignmentKernelTerminalSettlementDeferredV2(snapshot.current_binding), true,
    "one completed provider turn cannot release another provider turn's barrier");
  endAssignmentKernelTerminalBarrierV2(second);
  assert.equal(assignmentKernelTerminalSettlementDeferredV2(snapshot.current_binding), false);
}));

test("process loss at the provider terminal barrier recovers without replaying completed work", () => workspace(() => {
  const { goal, snapshot } = setup();
  const barrier = beginAssignmentKernelTerminalBarrierV2({
    binding: snapshot.current_binding,
    barrier_id: "provider-request-before-restart"
  });
  const recorder = createAssignmentKernelV2ModelReceiptRecorder({
    binding: snapshot.current_binding,
    admission_snapshot: snapshot,
    onStop: () => {}
  });
  const lease = openAssignmentKernelOperationV2({
    snapshot,
    controller_request_id: "restart-final-operation",
    provider_turn_id: "restart-provider-turn",
    capability_id: "inventory.read",
    classified_effect: "read",
    arguments: {}
  });
  markAssignmentKernelOperationDispatchStartedV2(lease);
  const settled = settleAssignmentKernelOperationV2(lease, envelope(
    lease.operation_id,
    lease.binding,
    { result: "authoritative-before-restart" }
  ));
  recordAssignmentProgressEpochV2({
    before: snapshot,
    after: settled.snapshot,
    stated_gap_ids: deriveProgressGapsV2(snapshot).map(gap => gap.gap_id),
    admitted_operation_ids: [lease.operation_id]
  });
  recorder.reconcile([{
    schema: "revit-operator.model-call-receipt.v1",
    call_id: "restart-final-receipt",
    provider: "openai",
    route: "codex_agent",
    requested_model: "gpt-test",
    model: "gpt-test",
    reasoning_effort: "medium",
    started_at_utc: "2026-09-02T00:46:17.390Z",
    duration_ms: null,
    success: true,
    response_status: "completed",
    error_code: null,
    tokens: { input_tokens: 40, cached_input_tokens: 0, output_tokens: 8, reasoning_output_tokens: 2, total_tokens: 48 },
    turn_id: "restart-provider-turn"
  }]);
  const beforeLoss = advanceAssignmentKernelProgressV2({ binding: snapshot.current_binding }).snapshot;
  assert.equal(beforeLoss.outcome, "complete");
  assert.equal(beforeLoss.terminal, false);
  assert.equal(Object.keys(beforeLoss.operations).length, 1);
  assert.equal(beforeLoss.provider_call_ids.length, 1);

  // A process loss drops only the in-memory lease. Canonical result,
  // Observation, criterion, and receipt events are reloaded from disk.
  endAssignmentKernelTerminalBarrierV2(barrier);
  __testOnlyResetGoalListCache();
  const recovered = advanceAssignmentKernelProgressV2({ binding: snapshot.current_binding }).snapshot;
  assert.equal(recovered.terminal, true);
  assert.equal(recovered.outcome, "complete");
  assert.equal(Object.keys(recovered.operations).length, 1);
  assert.equal(recovered.operations[lease.operation_id]!.result?.result_id, `result-${lease.operation_id}`);
  assert.equal(Object.keys(recovered.observations).length, 1);
  assert.equal(recovered.provider_call_ids.length, 1);
  assert.equal(listVerifiedWorkPackets(goal.id).at(-1)?.performance.model_calls, 1);
}));

test("provider receipt without a tool result is durable but waits for the quiescent turn checkpoint", () => workspace(() => {
  const { goal, snapshot } = setup();
  let stops = 0;
  assignmentKernelV2ModelReceiptObserver(snapshot.current_binding, () => { stops += 1; })({
    schema: "revit-operator.model-call-receipt.v1",
    call_id: "provider-no-tool",
    provider: "openai",
    route: "codex_agent",
    requested_model: "gpt-test",
    model: "gpt-test",
    reasoning_effort: "medium",
    started_at_utc: "2026-08-26T16:00:00.000Z",
    duration_ms: null,
    success: true,
    response_status: "completed",
    error_code: null,
    tokens: { input_tokens: 20, cached_input_tokens: 0, output_tokens: 5, reasoning_output_tokens: 1, total_tokens: 25 },
    turn_id: "turn-no-tool"
  });
  const retained = getAssignmentKernelSnapshotV2(goal.id)!;
  assert.equal(retained.terminal, false);
  assert.equal(retained.progress_epochs.length, 0);
  assert.equal(stops, 0);
  const checkpoint = recordAssignmentProgressEpochV2({
    before: snapshot,
    after: retained,
    stated_gap_ids: deriveProgressGapsV2(snapshot).map(gap => gap.gap_id),
    admitted_reasoning_call_ids: ["provider-no-tool"]
  });
  const continued = advanceAssignmentKernelProgressV2({ binding: checkpoint.current_binding });
  assert.equal(continued.decision.decision, "admit_reasoning_turn");
  assert.equal(continued.snapshot.progress_epochs[0]!.genuine_progress, false);
}));
