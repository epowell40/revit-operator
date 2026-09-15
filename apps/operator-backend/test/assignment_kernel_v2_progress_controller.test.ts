import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { assignmentKernelControlEvidenceFactsV2 } from "@revitoperator/assignment-kernel-v2-contracts";
import { storeEvidence, retrieveEvidence } from "../src/evidence/evidence_store.js";
import { __closeForTests } from "../src/memory/sqlite_store.js";
import {
  ASSIGNMENT_EVENT_V2_SCHEMA,
  ASSIGNMENT_SPEC_V2_SCHEMA,
  OBSERVATION_V2_SCHEMA,
  OPERATION_RESULT_V2_SCHEMA,
  OPERATION_V2_SCHEMA,
  AssignmentJournalV2,
  assertOperationAdvancesProgressV2,
  buildProgressEpochV2 as buildKernelProgressEpochV2,
  decideAssignmentProgressV2,
  type AssignmentBindingV2,
  type AssignmentEventV2,
  type AssignmentProgressBudgetV2,
  type AssignmentSpecV2,
  type CriterionEvaluationV2,
  type ObservationV2,
  type OperationResultV2,
  type OperationV2
} from "../src/domain/assignment-kernel/index.js";
import { finalCodexAssignmentMessageV2, codexAssignmentControllerStopMessage } from "../src/brains/codex_assignment_progress.js";
import { deriveProgressGapsV2 } from "../src/domain/assignment-kernel/progress/controller.js";
import { assignmentActiveExecutionTimeMsV2 } from "../src/domain/assignment-kernel/progress/execution_time.js";
import { observationAdmissibilityForCriterionV2 } from "../src/domain/assignment-kernel/semantic_admissibility.js";
import { DEFAULT_ASSIGNMENT_PROGRESS_BUDGET_V2 } from "../src/assignments/assignment_kernel_v2_progress.js";
import { buildHostProgressEpochV2 as buildProgressEpochV2 } from "../src/assignments/supporting_discovery_progress.js";

const binding: AssignmentBindingV2 = {
  assignment_id: "assignment-progress",
  run_id: "run-progress",
  generation: 1,
  session_id: "session-progress",
  principal_id: "principal-progress",
  document_fingerprint: "document-progress"
};

const budget: AssignmentProgressBudgetV2 = {
  max_reasoning_turns: 8,
  max_provider_calls: 10,
  max_operations: 12,
  max_equivalent_operations: 1,
  max_no_progress_epochs: 2,
  max_reconciliation_attempts: 1,
  max_wall_clock_ms: 600_000,
  max_total_tokens: 100_000
};

function spec(criteria = true): AssignmentSpecV2 {
  return {
    schema: ASSIGNMENT_SPEC_V2_SCHEMA,
    binding,
    source_user_request: "Return a grouped inventory.",
    requested_effect: "read",
    semantic_evidence_contract: "revit-operator.semantic-evidence-contract/v2",
    criteria: criteria ? [{
      criterion_id: "criterion-inventory",
      requirement: "Requested inventory is authoritatively returned.",
      required: true,
      semantic_fact_requirements: ["inventory.total", "inventory.group"],
      accepted_evaluator_authority_ids: ["deterministic-controller"],
      accepted_observation_authority_ids: ["native-host"],
      evidence_policy: {
        schema: "revit-operator.criterion-evidence-policy/v2",
        allowed_evidence_classes: ["task_result"],
        allowed_fulfillment_roles: ["delegated_task_execution"],
        allowed_fact_classes: ["domain"],
        allowed_capability_ids: ["inventory.read"],
        allowed_result_schema_ids: ["inventory/v1"],
        required_fact_ids: ["inventory.total", "inventory.group"],
        require_native_dispatch: true,
        require_current_generation: true
      }
    }] : [],
    input_variables: [],
    work_units: [{
      work_unit_id: "work-inventory",
      requested_effect: "read",
      execution_class: "analysis",
      dependency_ids: [],
      criterion_ids: criteria ? ["criterion-inventory"] : [],
      input_variable_ids: [],
      independently_useful: true,
      safe_to_retain: true,
      rollback_scope: "none"
    }],
    authorization_policy_id: "policy",
    created_at: "2026-08-26T20:00:00.000Z"
  };
}

type EventBodyOf<T> = T extends unknown
  ? Omit<T, "schema" | "event_id" | "assignment_id" | "assignment_version" | "binding" | "occurred_at" | "actor">
  : never;
type EventBody = EventBodyOf<AssignmentEventV2>;

function event(journal: AssignmentJournalV2, body: EventBody, at?: string): AssignmentEventV2 {
  const version = journal.events().length + 1;
  return {
    schema: ASSIGNMENT_EVENT_V2_SCHEMA,
    event_id: `event-${version}`,
    assignment_id: binding.assignment_id,
    assignment_version: version,
    binding,
    occurred_at: at ?? `2026-08-26T20:00:${String(version).padStart(2, "0")}.000Z`,
    actor: "test",
    ...body
  } as AssignmentEventV2;
}

function journal(withCriteria = true): AssignmentJournalV2 {
  const result = new AssignmentJournalV2();
  result.append(event(result, { event_type: "assignment_created", spec: spec(withCriteria) }));
  return result;
}

function operation(id = "operation-inventory"): OperationV2 {
  return {
    schema: OPERATION_V2_SCHEMA,
    operation_id: id,
    binding,
    work_unit_id: "work-inventory",
    capability_id: "inventory.read",
    requested_effect: "read",
    purpose: "work",
    fulfillment_role: "delegated_task_execution",
    delegation_authority_id: `delegation:${id}`,
    advances_criterion_ids: ["criterion-inventory"],
    eligible_criterion_ids: ["criterion-inventory"],
    resolves_gap_ids: ["criterion:criterion-inventory"],
    target: { document_fingerprint: binding.document_fingerprint },
    input: { category: "devices" },
    admission_state: "admitted",
    dispatch_state: "not_dispatched",
    persistent_effect: "none",
    settlement_state: "open",
    observation_ids: [],
    verification_operation_ids: [],
    opened_at: "2026-08-26T20:00:02.000Z",
    deadline_at: "2026-08-26T20:01:02.000Z"
  };
}

function result(operationId = "operation-inventory"): OperationResultV2 {
  return {
    schema: OPERATION_RESULT_V2_SCHEMA,
    result_id: `result-${operationId}`,
    operation_id: operationId,
    binding,
    status: "succeeded",
    dispatch_state: "dispatched",
    persistent_effect: "none",
    native_transaction_state: "not_applicable",
    authority: "native-host",
    result_schema_id: "inventory/v1",
    observation_required: true,
    raw_payload_hash: `hash-${operationId}`,
    receipt_id: `receipt-${operationId}`,
    completed_at: "2026-08-26T20:00:05.000Z"
  };
}

function observation(operationId = "operation-inventory", observationId = "observation-inventory"): ObservationV2 {
  return {
    schema: OBSERVATION_V2_SCHEMA,
    observation_id: observationId,
    operation_id: operationId,
    binding,
    authority: "native-host",
    result_schema_id: "inventory/v1",
    raw_payload_ref: `evidence://${observationId}`,
    raw_payload_hash: `hash-${operationId}`,
    facts: [
      { fact_id: "inventory.total", fact_class: "domain", value: 3, cardinality: "one" },
      { fact_id: "inventory.group", fact_class: "domain", value: 2, cardinality: "many", identity_dimensions: ["family", "type"], dimensions: { family: "A", type: "A" } },
      { fact_id: "inventory.group", fact_class: "domain", value: 1, cardinality: "many", identity_dimensions: ["family", "type"], dimensions: { family: "B", type: "B" } }
    ],
    target_scope: {},
    observed_at: "2026-08-26T20:00:05.000Z",
    verification_relevance: ["task_result"],
    fulfillment_role: "delegated_task_execution",
    evidence_class: "task_result",
    capability_id: "inventory.read",
    eligible_criterion_ids: ["criterion-inventory"]
  };
}

function settleObservation(j: AssignmentJournalV2): void {
  j.append(event(j, { event_type: "operation_admitted", operation: operation() }));
  j.append(event(j, { event_type: "native_dispatch_recorded", operation_id: "operation-inventory", native_correlation_id: "native-1" }));
  j.append(event(j, { event_type: "operation_result_recorded", result: result() }));
  j.append(event(j, { event_type: "observation_retained", observation: observation() }));
}

function evaluation(): CriterionEvaluationV2 {
  return {
    criterion_id: "criterion-inventory",
    status: "pass",
    basis: "observation",
    supporting_operation_ids: ["operation-inventory"],
    supporting_facts: [
      { observation_id: "observation-inventory", fact_id: "inventory.total" },
      { observation_id: "observation-inventory", fact_id: "inventory.group" }
    ],
    evaluator_authority: "deterministic-controller",
    reason: "All requested inventory facts are available.",
    evaluated_at: "2026-08-26T20:00:07.000Z"
  };
}

test("29-observation historical shape schedules criterion evaluation before another reasoning turn", () => {
  const j = journal();
  settleObservation(j);
  const decision = decideAssignmentProgressV2({ snapshot: j.snapshot(), budget, now: "2026-08-26T20:00:08.000Z" });
  assert.equal(decision.decision, "evaluate_criteria");
  if (decision.decision === "evaluate_criteria") {
    assert.deepEqual(decision.criterion_ids, ["criterion-inventory"]);
    assert.deepEqual(decision.observation_ids, ["observation-inventory"]);
  }
});

test("all required criteria pass and controller terminates immediately", () => {
  const j = journal();
  settleObservation(j);
  j.append(event(j, { event_type: "criterion_evaluated", evaluation: evaluation() }));
  const decision = decideAssignmentProgressV2({ snapshot: j.snapshot(), budget, now: "2026-08-26T20:00:09.000Z" });
  assert.deepEqual({ decision: decision.decision, outcome: decision.decision === "terminal" ? decision.outcome : null }, { decision: "terminal", outcome: "complete" });
});

test("terminal handoff replaces stale provider prose with the canonical useful result", () => {
  const j = journal();
  settleObservation(j);
  j.append(event(j, { event_type: "criterion_evaluated", evaluation: evaluation() }));
  const terminal = {
    ...j.snapshot(),
    terminal: true,
    outcome: "complete" as const,
    terminal_reason: "criteria_satisfied",
    finished_at: "2026-08-26T20:00:09.000Z"
  };
  const message = finalCodexAssignmentMessageV2(terminal, "Provider says it may continue reasoning.");
  assert.match(message, /Inventory total: 3/);
  assert.doesNotMatch(message, /continue reasoning/);
});

test("active operation suppresses another reasoning turn", () => {
  const j = journal();
  j.append(event(j, { event_type: "operation_admitted", operation: operation() }));
  const decision = decideAssignmentProgressV2({ snapshot: j.snapshot(), budget, now: "2026-08-26T20:00:03.000Z" });
  assert.equal(decision.decision, "await_operation");
});

test("quiescent incomplete criteria admit reasoning only for explicit fact gaps", () => {
  const decision = decideAssignmentProgressV2({ snapshot: journal().snapshot(), budget, now: "2026-08-26T20:00:01.000Z" });
  assert.equal(decision.decision, "admit_reasoning_turn");
  if (decision.decision === "admit_reasoning_turn") {
    assert.deepEqual(decision.gap_ids, ["criterion:criterion-inventory"]);
    assert.deepEqual(decision.expected_information, ["inventory.group", "inventory.total"]);
  }
});

test("active quiescent Assignment with no criteria cannot run indefinitely", () => {
  const decision = decideAssignmentProgressV2({ snapshot: journal(false).snapshot(), budget, now: "2026-08-26T20:00:01.000Z" });
  assert.equal(decision.decision, "blocked");
});

test("durable provider ledger distinguishes provider truth from downstream response transport", () => {
  const j = journal();
  const admitted = j.append(event(j, {
    event_type: "provider_call_state_recorded",
    call_id: "provider-1",
    state: "admitted",
    provider: "openai",
    model: "model",
    reasoning_effort: "medium",
    gap_ids: ["criterion:criterion-inventory"],
    criterion_ids: ["criterion-inventory"],
    expected_information: ["inventory.total"]
  }));
  assert.equal(admitted.quiescent, false);
  const waiting = decideAssignmentProgressV2({ snapshot: admitted, budget, now: "2026-08-26T20:00:02.000Z" });
  assert.equal(waiting.decision, "await_provider");
  j.append(event(j, { event_type: "provider_call_state_recorded", call_id: "provider-1", state: "dispatched" }));
  j.append(event(j, { event_type: "provider_call_state_recorded", call_id: "provider-1", state: "response_started" }));
  j.append(event(j, {
    event_type: "provider_call_state_recorded",
    call_id: "provider-1",
    state: "usage_received",
    usage: { input_tokens: 10, output_tokens: 5, reasoning_tokens: 2, total_tokens: 17, estimated_cost_usd: 0.01 }
  }));
  const completed = j.append(event(j, { event_type: "provider_call_state_recorded", call_id: "provider-1", state: "completed", success: true }));
  assert.equal(completed.provider_calls["provider-1"].state, "completed");
  assert.equal(completed.provider_calls["provider-1"].usage?.total_tokens, 17);
  assert.equal(completed.provider_calls["provider-1"].response_transport_completed_at, undefined);
  const restarted = new AssignmentJournalV2(j.events()).snapshot();
  assert.equal(restarted.provider_calls["provider-1"].state, "completed");
});

test("durable provider ledger accepts late lifecycle enrichment without regressing completion", () => {
  const j = journal();
  j.append(event(j, {
    event_type: "provider_call_state_recorded",
    call_id: "provider-out-of-order",
    state: "admitted",
    provider: "openai",
    model: "model",
    reasoning_effort: "medium",
    gap_ids: ["criterion:criterion-inventory"],
    criterion_ids: ["criterion-inventory"],
    expected_information: ["inventory.total"]
  }));
  j.append(event(j, { event_type: "provider_call_state_recorded", call_id: "provider-out-of-order", state: "completed", success: true }));
  j.append(event(j, { event_type: "provider_call_state_recorded", call_id: "provider-out-of-order", state: "response_started" }));
  const enriched = j.append(event(j, {
    event_type: "provider_call_state_recorded",
    call_id: "provider-out-of-order",
    state: "usage_received",
    usage: { input_tokens: 10, output_tokens: 5, reasoning_tokens: 2, total_tokens: 17, estimated_cost_usd: 0.01 }
  }));
  assert.equal(enriched.provider_calls["provider-out-of-order"].state, "completed");
  assert.equal(enriched.provider_calls["provider-out-of-order"].usage?.total_tokens, 17);
  assert.ok(enriched.provider_calls["provider-out-of-order"].response_started_at);
  assert.throws(() => j.append(event(j, {
    event_type: "provider_call_state_recorded",
    call_id: "provider-out-of-order",
    state: "completed",
    success: false,
    error_class: "provider"
  })), /replayed provider completion must agree/i);
});

test("provider admission without a criterion gap fails closed", () => {
  const j = journal();
  assert.throws(() => j.append(event(j, {
    event_type: "provider_call_state_recorded",
    call_id: "provider-unbound",
    state: "admitted",
    provider: "openai",
    model: "model",
    gap_ids: [], criterion_ids: [], expected_information: []
  })), /provider admission requires unresolved gap/i);
});

test("equivalent operation repetition requires an explicit material basis", () => {
  const j = journal();
  const first = operation();
  j.append(event(j, { event_type: "operation_admitted", operation: first }));
  assert.throws(() => assertOperationAdvancesProgressV2({ snapshot: j.snapshot(), operation: { ...operation("operation-repeat") }, budget }), /equivalent_budget_exhausted/);
});

test("progress epochs do not count repeated known facts or provider prose as progress", () => {
  const before = journal().snapshot();
  const afterJournal = journal();
  afterJournal.append(event(afterJournal, {
    event_type: "provider_call_recorded",
    call_id: "legacy-provider",
    provider: "openai",
    model: "model",
    reasoning_effort: "medium",
    success: true
  }));
  const epoch = buildProgressEpochV2({ before, after: afterJournal.snapshot(), stated_gap_ids: ["criterion:criterion-inventory"], admitted_reasoning_call_ids: ["legacy-provider"], recorded_at: "2026-08-26T20:00:02.000Z" });
  assert.equal(epoch.genuine_progress, false);
  assert.deepEqual(epoch.progress_reasons, []);
});

test("repeated no-progress epochs exhaust liveness without creating success", () => {
  const j = journal();
  let before = j.snapshot();
  for (let index = 0; index < 2; index += 1) {
    j.append(event(j, {
      event_type: "provider_call_recorded",
      call_id: `legacy-${index}`,
      provider: "openai",
      model: "model",
      reasoning_effort: "medium",
      success: true
    }));
    const after = j.snapshot();
    const epoch = buildProgressEpochV2({ before, after, stated_gap_ids: ["criterion:criterion-inventory"], recorded_at: `2026-08-26T20:00:0${index + 2}.000Z` });
    j.append(event(j, { event_type: "progress_epoch_recorded", epoch }));
    before = j.snapshot();
  }
  const decision = decideAssignmentProgressV2({ snapshot: j.snapshot(), budget, now: "2026-08-26T20:00:10.000Z" });
  assert.equal(decision.decision, "blocked");
  if (decision.decision === "blocked") assert.equal(decision.reason, "no_progress_budget_exhausted");
});

test("Candidate 25 flight 3 gives one bounded execution opportunity after the first structured strategy selection", () => {
  const initial = journal().snapshot();
  const searchOperation: OperationV2 = {
    ...operation("operation-search"),
    capability_id: "revit_search_tools",
    purpose: "discovery",
    fulfillment_role: "supporting_control",
    delegation_authority_id: undefined,
    advances_criterion_ids: [],
    eligible_criterion_ids: [],
    input: { query: "inventory air terminals" },
    dispatch_state: "not_dispatched",
    settlement_state: "settled",
    result: {
      ...result("operation-search"),
      status: "completed_without_native_dispatch",
      dispatch_state: "not_dispatched",
      authority: "operator-mcp-transport",
      result_schema_id: "operator-capability/revit_search_tools/v2",
      observation_required: false,
      raw_payload_hash: undefined
    },
    settled_at: "2026-08-26T20:00:02.000Z"
  };
  const afterSearch = {
    ...initial,
    operations: { [searchOperation.operation_id]: searchOperation },
    in_flight_operation_ids: [],
    quiescent: true
  };
  const searchEpoch = buildProgressEpochV2({
    before: initial,
    after: afterSearch,
    stated_gap_ids: ["criterion:criterion-inventory"],
    admitted_operation_ids: [searchOperation.operation_id],
    recorded_at: "2026-08-26T20:00:02.000Z"
  });
  assert.equal(searchEpoch.genuine_progress, false);

  const beforeStrategy = { ...afterSearch, progress_epochs: [searchEpoch] };
  const strategyOperation: OperationV2 = {
    ...operation("operation-strategy"),
    capability_id: "operator_record_execution_strategy",
    purpose: "discovery",
    fulfillment_role: "supporting_control",
    delegation_authority_id: undefined,
    advances_criterion_ids: [],
    eligible_criterion_ids: [],
    input: {
      schema: "revit-operator.execution-strategy-evidence.v1",
      selected_substrate: "typed_capability",
      reason: "One typed read capability can return the requested inventory."
    },
    dispatch_state: "not_dispatched",
    settlement_state: "settled",
    result: {
      ...result("operation-strategy"),
      status: "completed_without_native_dispatch",
      dispatch_state: "not_dispatched",
      authority: "operator-mcp-transport",
      result_schema_id: "operator-capability/operator_record_execution_strategy/v2",
      observation_required: false,
      raw_payload_hash: undefined
    },
    settled_at: "2026-08-26T20:00:03.000Z"
  };
  const afterStrategy = {
    ...beforeStrategy,
    operations: {
      ...beforeStrategy.operations,
      [strategyOperation.operation_id]: strategyOperation
    }
  };
  const strategyEpoch = buildProgressEpochV2({
    before: beforeStrategy,
    after: afterStrategy,
    stated_gap_ids: ["criterion:criterion-inventory"],
    admitted_operation_ids: [strategyOperation.operation_id],
    recorded_at: "2026-08-26T20:00:03.000Z"
  });
  const finalSnapshot = { ...afterStrategy, progress_epochs: [searchEpoch, strategyEpoch] };
  const decision = decideAssignmentProgressV2({ snapshot: finalSnapshot, budget, now: "2026-08-26T20:00:04.000Z" });

  assert.equal(strategyEpoch.genuine_progress, true);
  assert.deepEqual(strategyEpoch.progress_reasons, ["execution_strategy_selected"]);
  assert.equal(decision.decision, "admit_reasoning_turn");

  const repeatedStrategy: OperationV2 = {
    ...strategyOperation,
    operation_id: "operation-strategy-repeat",
    input: {
      ...strategyOperation.input,
      reason: "Different prose cannot turn the same strategy selection into new progress."
    },
    result: {
      ...strategyOperation.result!,
      result_id: "result-operation-strategy-repeat",
      operation_id: "operation-strategy-repeat"
    }
  };
  const beforeRepeat = finalSnapshot;
  const afterRepeat = {
    ...beforeRepeat,
    operations: {
      ...beforeRepeat.operations,
      [repeatedStrategy.operation_id]: repeatedStrategy
    }
  };
  const repeatedEpoch = buildProgressEpochV2({
    before: beforeRepeat,
    after: afterRepeat,
    stated_gap_ids: ["criterion:criterion-inventory"],
    admitted_operation_ids: [repeatedStrategy.operation_id],
    recorded_at: "2026-08-26T20:00:04.000Z"
  });
  assert.equal(repeatedEpoch.genuine_progress, false);
  assert.deepEqual(repeatedEpoch.progress_reasons, []);
});

test("unknown mutation suppresses provider success even after dispatch settlement", () => {
  const j = journal();
  const snapshot = { ...j.snapshot(), unresolved_unknown_operation_ids: ["duplicate-view"] };
  for (const state of [snapshot, { ...snapshot, terminal: true, outcome: "blocked" as const, terminal_reason: "reconciliation_required" }]) {
    const message = finalCodexAssignmentMessageV2(state, "Created M-COORDINATION COPY with annotations.");
    assert.match(message, /could not confirm|not confirmed/i);
    assert.doesNotMatch(message, /Created M-COORDINATION COPY/);
  }
});

test("pending apply cannot pass unverified completion prose while clarification retains its question", () => {
  const j = journal();
  const snapshot = { ...j.snapshot(), spec: { ...j.snapshot().spec, requested_effect: "apply" as const } };
  assert.doesNotMatch(finalCodexAssignmentMessageV2(snapshot, "Created the view."), /Created the view/);
  assert.equal(finalCodexAssignmentMessageV2({ ...snapshot, outcome: "awaiting_user_input" }, "Which plan?"), "Which plan?");
});

test("input stop shows only unanswered questions and never hides an uncertain model effect", () => {
  const snapshot = { ...journal().snapshot(), outcome: "awaiting_user_input" as const, clarifications: {
    old: { clarification_id: "old", variable_id: "old", question: "Answered already?", requested_at: "2026-09-01T00:00:00Z", resolved_at: "2026-09-01T01:00:00Z" },
    floor: { clarification_id: "floor", variable_id: "floor", question: "Which floor should I use?", requested_at: "2026-09-15T07:49:10Z" }
  } };
  assert.equal(codexAssignmentControllerStopMessage(snapshot, "assignment_progress_controller_stop"), "Which floor should I use?");
  assert.match(codexAssignmentControllerStopMessage({ ...snapshot, unresolved_unknown_operation_ids: ["edit"] }, "stop"), /could not confirm/);
  assert.doesNotMatch(codexAssignmentControllerStopMessage({ ...snapshot, clarifications: {} }, "assignment_progress_controller_stop"), /canonical|controller|assignment_progress/);
});

test("assessment guidance describes remaining obligations without claiming an uncreated artifact exists", () => {
  const snapshot = journal().snapshot();
  const requested = { ...snapshot, spec: { ...snapshot.spec, result_delivery_required: true, result_assessment_required: true } };
  const guidance = deriveProgressGapsV2(requested).find(g => g.kind === "result_delivery_required")!.reason;
  assert.doesNotMatch(guidance, /The exported file is verified/);
  assert.match(guidance, /If export is still outstanding, complete that work first/);
  assert.match(guidance, /Never repeat an export that already has an applied or uncertain effect/);
  const plain = deriveProgressGapsV2({ ...requested, spec: { ...requested.spec, result_assessment_required: false } })[0]!.reason;
  assert.doesNotMatch(plain, /export is still outstanding/);
});

test("blocked terminal result keeps failure visible when partial inventory evidence exists", () => {
  const j = journal();
  settleObservation(j);
  j.append(event(j, { event_type: "criterion_evaluated", evaluation: evaluation() }));
  const message = finalCodexAssignmentMessageV2({ ...j.snapshot(), terminal: true,
    outcome: "blocked", terminal_reason: "reconciliation_required" }, "Everything completed.");
  assert.match(message, /did not complete/);
  assert.match(message, /Inventory total: 3/);
});

test("idle Assignments remain admissible days later without resetting their cumulative budgets", () => {
  const snapshot = journal().snapshot();
  const now = "2026-08-29T20:00:00.000Z";
  assert.equal(assignmentActiveExecutionTimeMsV2(snapshot, now), 0);
  assert.equal(decideAssignmentProgressV2({ snapshot, budget, now }).decision, "admit_reasoning_turn");
  assert.equal(decideAssignmentProgressV2({ snapshot, budget: { ...budget, max_provider_calls: 0 }, now }).reason, "provider_call_budget_exhausted");
});

test("execution time survives journal replay while completed work excludes the offline wait", () => {
  const j = journal();
  j.append(event(j, {
    event_type: "provider_call_state_recorded", call_id: "timed-provider", state: "admitted",
    provider: "test", model: "test", reasoning_effort: null, gap_ids: ["criterion:criterion-inventory"],
    criterion_ids: ["criterion-inventory"], expected_information: ["inventory.total"]
  }, "2026-08-26T20:00:00.000Z"));
  const now = "2026-08-29T20:00:00.000Z";
  assert.equal(assignmentActiveExecutionTimeMsV2(new AssignmentJournalV2(j.events()).snapshot(), now), 3 * 86_400_000,
    "process loss cannot forgive unresolved admitted work");
  j.append(event(j, { event_type: "provider_call_state_recorded", call_id: "timed-provider", state: "completed", success: true }, "2026-08-26T20:00:30.000Z"));
  const snapshot = new AssignmentJournalV2(j.events()).snapshot();
  assert.equal(assignmentActiveExecutionTimeMsV2(snapshot, now), 30_000);
  const delayed = structuredClone(snapshot);
  delayed.provider_calls["timed-provider"].completed_at = now;
  delayed.provider_calls["timed-provider"].provider_duration_ms = 30_000;
  assert.equal(assignmentActiveExecutionTimeMsV2(delayed, now), 30_000, "known provider duration excludes delayed receipt delivery");
  const imported = structuredClone(snapshot);
  imported.provider_calls["timed-provider"].admitted_at = "2026-08-20T20:00:00.000Z";
  assert.equal(assignmentActiveExecutionTimeMsV2(imported, now), 30_000, "imported receipt cannot charge history before task creation");
  const kernelUrl = new URL("../src/domain/assignment-kernel/index.js", import.meta.url).href;
  const child = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", `
    import fs from 'node:fs';
    import { reduceAssignmentEventsV2, decideAssignmentProgressV2 } from ${JSON.stringify(kernelUrl)};
    const input = JSON.parse(fs.readFileSync(0, 'utf8'));
    console.log(JSON.stringify(decideAssignmentProgressV2({ snapshot: reduceAssignmentEventsV2(input.events), budget: input.budget, now: input.now })));
  `], { input: JSON.stringify({ events: j.events(), budget, now }), encoding: "utf8", timeout: 20_000 });
  assert.equal(child.status, 0, child.stderr || child.error?.message);
  assert.deepEqual(JSON.parse(child.stdout), decideAssignmentProgressV2({ snapshot, budget, now }));
  assert.equal(decideAssignmentProgressV2({ snapshot, budget, now }).decision, "admit_reasoning_turn");
  assert.equal(decideAssignmentProgressV2({ snapshot, budget: { ...budget, max_wall_clock_ms: 30_000 }, now }).reason, "execution_lease_exhausted");
});

test("overlapping execution intervals consume wall time once and invalid timestamps cannot waive the limit", () => {
  const snapshot = journal().snapshot();
  snapshot.operations = {
    first: { ...operation("first"), opened_at: "2026-08-26T20:00:00.000Z", settled_at: "2026-08-26T20:00:20.000Z" },
    second: { ...operation("second"), opened_at: "2026-08-26T20:00:10.000Z", settled_at: "2026-08-26T20:00:30.000Z" }
  };
  assert.equal(assignmentActiveExecutionTimeMsV2(snapshot, "2026-08-27T20:00:00.000Z"), 30_000);
  snapshot.operations.second.opened_at = "invalid";
  assert.equal(assignmentActiveExecutionTimeMsV2(snapshot, "2026-08-27T20:00:00.000Z"), Infinity);
});

test("Candidate 50 durable capability knowledge advances once and equivalent search output does not reset liveness", () => {
  const initial = journal().snapshot();
  const searchOperation: OperationV2 = {
    ...operation("operation-search-control"),
    capability_id: "revit_search_tools",
    purpose: "discovery",
    fulfillment_role: "supporting_control",
    delegation_authority_id: undefined,
    advances_criterion_ids: [],
    eligible_criterion_ids: [],
    input: { query: "find and replace one text note" },
    dispatch_state: "dispatched",
    dispatch_authority: "mcp",
    settlement_state: "settled",
    observation_ids: ["observation-search-control"],
    result: {
      ...result("operation-search-control"),
      authority: "operator-mcp-transport",
      result_schema_id: "operator-capability/revit_search_tools/v2",
      raw_payload_hash: "hash-search-control"
    },
    settled_at: "2026-08-26T20:00:02.000Z"
  };
  const searchObservation: ObservationV2 = {
    ...observation("operation-search-control", "observation-search-control"),
    authority: "operator-mcp-transport",
    result_schema_id: "operator-capability/revit_search_tools/v2",
    raw_payload_hash: "hash-search-control",
    facts: [
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
    fulfillment_role: "supporting_control",
    evidence_class: "control",
    capability_id: "revit_search_tools",
    eligible_criterion_ids: []
  };
  const afterSearch = {
    ...initial,
    operations: { [searchOperation.operation_id]: searchOperation },
    observations: { [searchObservation.observation_id]: searchObservation },
    observation_versions: { [searchObservation.observation_id]: 2 },
    in_flight_operation_ids: [],
    quiescent: true
  };
  const searchEpoch = buildProgressEpochV2({
    before: initial,
    after: afterSearch,
    stated_gap_ids: ["criterion:criterion-inventory"],
    admitted_operation_ids: [searchOperation.operation_id],
    recorded_at: "2026-08-26T20:00:02.000Z"
  });
  assert.equal(searchEpoch.genuine_progress, true);
  assert.deepEqual(searchEpoch.progress_reasons, ["controller_knowledge_added"]);
  assert.equal(afterSearch.criteria["criterion-inventory"], undefined);
  assert.equal(decideAssignmentProgressV2({
    snapshot: { ...afterSearch, progress_epochs: [searchEpoch] },
    budget,
    now: "2026-08-26T20:00:03.000Z"
  }).decision, "admit_reasoning_turn");

  const repeatedOperation: OperationV2 = {
    ...searchOperation,
    operation_id: "operation-search-control-repeat",
    observation_ids: ["observation-search-control-repeat"],
    result: {
      ...searchOperation.result!,
      result_id: "result-operation-search-control-repeat",
      operation_id: "operation-search-control-repeat",
      raw_payload_hash: "hash-search-control-repeat"
    }
  };
  const repeatedObservation: ObservationV2 = {
    ...searchObservation,
    observation_id: "observation-search-control-repeat",
    operation_id: repeatedOperation.operation_id,
    raw_payload_hash: "hash-search-control-repeat"
  };
  const beforeRepeat = { ...afterSearch, progress_epochs: [searchEpoch] };
  const afterRepeat = {
    ...beforeRepeat,
    operations: { ...beforeRepeat.operations, [repeatedOperation.operation_id]: repeatedOperation },
    observations: { ...beforeRepeat.observations, [repeatedObservation.observation_id]: repeatedObservation },
    observation_versions: { ...beforeRepeat.observation_versions, [repeatedObservation.observation_id]: 3 }
  };
  const repeatedEpoch = buildProgressEpochV2({
    before: beforeRepeat,
    after: afterRepeat,
    stated_gap_ids: ["criterion:criterion-inventory"],
    admitted_operation_ids: [repeatedOperation.operation_id],
    recorded_at: "2026-08-26T20:00:04.000Z"
  });
  assert.equal(repeatedEpoch.genuine_progress, false);
  assert.deepEqual(repeatedEpoch.progress_reasons, []);
});

test("Candidate 55 a new focused evidence selection resets liveness once while an unrelated next step does not", () => {
  const initial = journal().snapshot();
  const evidenceOperation: OperationV2 = {
    ...operation("operation-focused-evidence"),
    capability_id: "operator_retrieve_evidence",
    purpose: "evidence_read",
    fulfillment_role: "supporting_control",
    delegation_authority_id: undefined,
    advances_criterion_ids: [],
    eligible_criterion_ids: [],
    input: { evidenceId: "ev1_BE1x2Z1tkNa3F6VVtnPi_cEvu7lCs-MG", fields: ["payload.items"] },
    dispatch_state: "dispatched",
    dispatch_authority: "mcp",
    settlement_state: "settled",
    observation_ids: ["observation-focused-evidence"],
    result: {
      ...result("operation-focused-evidence"),
      authority: "operator-evidence-store",
      result_schema_id: "operator-capability/operator_retrieve_evidence/v2",
      raw_payload_hash: "hash-focused-evidence"
    },
    settled_at: "2026-08-26T20:00:02.000Z"
  };
  const evidenceObservation: ObservationV2 = {
    ...observation("operation-focused-evidence", "observation-focused-evidence"),
    authority: "operator-evidence-store",
    result_schema_id: "operator-capability/operator_retrieve_evidence/v2",
    raw_payload_hash: "hash-focused-evidence",
    facts: [{
      fact_id: "control.evidence_selection_available",
      fact_class: "control",
      value: true,
      cardinality: "many",
      identity_dimensions: ["capability_id", "evidence_id", "selection_path"],
      dimensions: {
        capability_id: "operator_retrieve_evidence",
        evidence_id: "ev1_BE1x2Z1tkNa3F6VVtnPi_cEvu7lCs-MG",
        selection_path: "payload.items"
      }
    }],
    verification_relevance: ["control"],
    fulfillment_role: "supporting_control",
    evidence_class: "control",
    capability_id: "operator_retrieve_evidence",
    eligible_criterion_ids: []
  };
  const afterEvidence = {
    ...initial,
    operations: { [evidenceOperation.operation_id]: evidenceOperation },
    observations: { [evidenceObservation.observation_id]: evidenceObservation },
    observation_versions: { [evidenceObservation.observation_id]: 2 },
    in_flight_operation_ids: [],
    quiescent: true
  };
  const evidenceEpoch = buildProgressEpochV2({
    before: initial,
    after: afterEvidence,
    stated_gap_ids: ["criterion:criterion-inventory"],
    admitted_operation_ids: [evidenceOperation.operation_id],
    recorded_at: "2026-08-26T20:00:02.000Z"
  });
  assert.equal(evidenceEpoch.genuine_progress, true);
  assert.deepEqual(evidenceEpoch.progress_reasons, ["controller_knowledge_added"]);

  const supportRead = {
    ...operation("operation-duplicate-check"),
    purpose: "discovery" as const,
    fulfillment_role: "supporting_control" as const,
    delegation_authority_id: undefined,
    advances_criterion_ids: [],
    eligible_criterion_ids: [],
    settlement_state: "settled" as const,
    result: result("operation-duplicate-check"),
    settled_at: "2026-08-26T20:00:03.000Z"
  };
  const afterSupportRead = {
    ...afterEvidence,
    operations: { ...afterEvidence.operations, [supportRead.operation_id]: supportRead }
  };
  const supportEpoch = buildProgressEpochV2({
    before: afterEvidence,
    after: afterSupportRead,
    stated_gap_ids: ["criterion:criterion-inventory"],
    admitted_operation_ids: [supportRead.operation_id],
    recorded_at: "2026-08-26T20:00:03.000Z"
  });
  assert.equal(supportEpoch.genuine_progress, false);
  const decision = decideAssignmentProgressV2({
    snapshot: { ...afterSupportRead, progress_epochs: [evidenceEpoch, supportEpoch] },
    budget,
    now: "2026-08-26T20:00:04.000Z"
  });
  assert.equal(decision.decision, "admit_reasoning_turn",
    "one later support step must leave a bounded turn for the exact task-effect operation");
});

test("Candidate 13 flight 3 preserves one correction turn when a structured schema gap follows unrelated no-progress", () => {
  const initial = journal().snapshot();
  const scheduleOperation: OperationV2 = {
    ...operation("operation-schedule"),
    capability_id: "revit_list_schedules",
    input: { action: "list", max: 200 },
    settlement_state: "settled",
    result: {
      schema: OPERATION_RESULT_V2_SCHEMA,
      result_id: "result-operation-schedule",
      operation_id: "operation-schedule",
      binding,
      status: "failed_before_dispatch",
      dispatch_state: "not_dispatched",
      persistent_effect: "none",
      native_transaction_state: "not_applicable",
      authority: "operator-mcp-transport",
      result_schema_id: "operator-capability/revit_list_schedules/v2",
      observation_required: false,
      error_code: "mcp_tool_failed",
      completed_at: "2026-08-26T20:00:02.000Z"
    },
    settled_at: "2026-08-26T20:00:02.000Z"
  };
  const afterSchedule = {
    ...initial,
    operations: { [scheduleOperation.operation_id]: scheduleOperation },
    in_flight_operation_ids: [],
    quiescent: true
  };
  const scheduleEpoch = buildProgressEpochV2({
    before: initial,
    after: afterSchedule,
    stated_gap_ids: ["criterion:criterion-inventory"],
    admitted_operation_ids: [scheduleOperation.operation_id],
    recorded_at: "2026-08-26T20:00:02.000Z"
  });
  assert.equal(scheduleEpoch.genuine_progress, false);

  const beforeInvalid = { ...afterSchedule, progress_epochs: [scheduleEpoch] };
  const invalidOperation: OperationV2 = {
    ...operation("operation-invalid-quantify"),
    capability_id: "revit_call_tool",
    request_identity: {
      capability_id: "revit_call_tool",
      method: "POST",
      path: "/revit/quantify",
      request_signature: "invalid-quantify-signature"
    },
    input: {
      method: "POST",
      path: "/revit/quantify",
      body: { intent: "Count every air terminal" }
    },
    settlement_state: "settled",
    result: {
      schema: OPERATION_RESULT_V2_SCHEMA,
      result_id: "result-operation-invalid-quantify",
      operation_id: "operation-invalid-quantify",
      binding,
      status: "failed_before_dispatch",
      dispatch_state: "not_dispatched",
      persistent_effect: "none",
      native_transaction_state: "not_applicable",
      authority: "operator-mcp-transport",
      result_schema_id: "operator-capability/revit_call_tool/v2",
      observation_required: false,
      error_code: "mcp_tool_failed",
      input_schema_gap: {
        schema: "revit-operator.operation-input-schema-gap/v2",
        gap_id: "input-schema:operation-invalid-quantify",
        operation_id: "operation-invalid-quantify",
        capability_id: "revit_call_tool",
        input_schema_id: "operator-native/POST:/revit/quantify/input/v1",
        input_schema_digest: "quantify-input-schema-digest",
        method: "POST",
        path: "/revit/quantify",
        request_signature: "invalid-quantify-signature",
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
      completed_at: "2026-08-26T20:00:03.000Z"
    },
    settled_at: "2026-08-26T20:00:03.000Z"
  };
  const afterInvalid = {
    ...beforeInvalid,
    operations: {
      ...beforeInvalid.operations,
      [invalidOperation.operation_id]: invalidOperation
    }
  };
  const invalidEpoch = buildProgressEpochV2({
    before: beforeInvalid,
    after: afterInvalid,
    stated_gap_ids: ["criterion:criterion-inventory"],
    admitted_operation_ids: [invalidOperation.operation_id],
    recorded_at: "2026-08-26T20:00:03.000Z"
  });
  const finalSnapshot = { ...afterInvalid, progress_epochs: [scheduleEpoch, invalidEpoch] };
  const decision = decideAssignmentProgressV2({ snapshot: finalSnapshot, budget, now: "2026-08-26T20:00:04.000Z" });

  assert.equal(invalidEpoch.genuine_progress, true);
  assert.deepEqual(invalidEpoch.progress_reasons, ["correction_gap_identified"]);
  assert.equal(decision.decision, "admit_reasoning_turn");
  if (decision.decision === "admit_reasoning_turn") {
    assert.deepEqual(decision.gap_ids, ["criterion:criterion-inventory", "input-schema:operation-invalid-quantify"]);
    assert.ok(decision.expected_information.some((information) => information.includes("body.intent:enum")
      && information.includes("count")
      && information.includes("count_and_list")),
    "Candidate 28 replay: the bounded correction turn must receive the exact enum choices already known to the controller");
  }
});

test("an identical schema-invalid proposal cannot mint another correction gap", () => {
  const rejected: OperationV2 = {
    ...operation("operation-rejected"),
    capability_id: "revit_call_tool",
    request_identity: {
      capability_id: "revit_call_tool",
      method: "POST",
      path: "/revit/quantify",
      request_signature: "same-invalid-signature"
    },
    settlement_state: "settled",
    result: {
      schema: OPERATION_RESULT_V2_SCHEMA,
      result_id: "result-operation-rejected",
      operation_id: "operation-rejected",
      binding,
      status: "failed_before_dispatch",
      dispatch_state: "not_dispatched",
      persistent_effect: "none",
      native_transaction_state: "not_applicable",
      authority: "operator-mcp-transport",
      result_schema_id: "operator-capability/revit_call_tool/v2",
      observation_required: false,
      error_code: "mcp_tool_failed",
      input_schema_gap: {
        schema: "revit-operator.operation-input-schema-gap/v2",
        gap_id: "input-schema:operation-rejected",
        operation_id: "operation-rejected",
        capability_id: "revit_call_tool",
        input_schema_id: "operator-native/POST:/revit/quantify/input/v1",
        input_schema_digest: "quantify-input-schema-digest",
        method: "POST",
        path: "/revit/quantify",
        request_signature: "same-invalid-signature",
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
      completed_at: "2026-08-26T20:00:02.000Z"
    },
    settled_at: "2026-08-26T20:00:02.000Z"
  };
  const snapshot = {
    ...journal().snapshot(),
    operations: { [rejected.operation_id]: rejected },
    in_flight_operation_ids: [],
    quiescent: true
  };
  const identical: OperationV2 = {
    ...operation("operation-identical-retry"),
    capability_id: "revit_call_tool",
    request_identity: structuredClone(rejected.request_identity),
    resolves_gap_ids: ["criterion:criterion-inventory", "input-schema:operation-rejected"]
  };
  assert.throws(
    () => assertOperationAdvancesProgressV2({ snapshot, operation: identical, budget }),
    /identical_input_schema_retry/
  );
});

test("unknown effect blocks truthfully when bounded reconciliation is exhausted", () => {
  const base = journal().snapshot();
  const unknownOperation: OperationV2 = {
    ...operation("operation-unknown"),
    requested_effect: "apply",
    dispatch_state: "dispatched",
    persistent_effect: "unknown",
    settlement_state: "settled",
    result: {
      ...result("operation-unknown"),
      status: "timed_out",
      persistent_effect: "unknown",
      native_transaction_state: "unknown",
      observation_required: false,
      raw_payload_hash: undefined
    }
  };
  const reconciliation: OperationV2 = {
    ...operation("operation-reconciliation"),
    purpose: "reconciliation",
    settlement_state: "settled",
    dispatch_state: "dispatched"
  };
  const snapshot = {
    ...base,
    operations: { [unknownOperation.operation_id]: unknownOperation, [reconciliation.operation_id]: reconciliation },
    unresolved_unknown_operation_ids: [unknownOperation.operation_id],
    in_flight_operation_ids: [],
    quiescent: true
  };
  const decision = decideAssignmentProgressV2({ snapshot, budget, now: "2026-08-26T20:00:10.000Z" });
  assert.equal(decision.decision, "blocked");
  if (decision.decision === "blocked") assert.equal(decision.reason, "reconciliation_budget_exhausted");
});

function discoveryStep(before: ReturnType<AssignmentJournalV2["snapshot"]>, id: string, path: string, body: unknown = null) {
  const op: OperationV2 = { ...operation(id), capability_id: `native:GET:${path}`, purpose: "discovery",
    fulfillment_role: "supporting_control", delegation_authority_id: undefined, advances_criterion_ids: [], eligible_criterion_ids: [],
    input: { method: "GET", path, body }, dispatch_state: "dispatched", settlement_state: "settled",
    observation_ids: [`obs-${id}`], result: result(id) };
  const obs: ObservationV2 = { ...observation(id, `obs-${id}`), capability_id: op.capability_id,
    fulfillment_role: "supporting_control", evidence_class: "control", eligible_criterion_ids: [],
    facts: [{ fact_id: "control.result_available", fact_class: "control", value: true },
      { fact_id: "control.domain_succeeded", fact_class: "control", value: true },
      { fact_id: "control.native_call_count", fact_class: "control", value: 1 },
      { fact_id: "control.payload_hash", fact_class: "control", value: `hash-${id}` }] };
  return { ...before, operations: { ...before.operations, [id]: op }, observations: { ...before.observations, [obs.observation_id]: obs } };
}

test("seven retained room pages progress through the real store and controller but overlapping rereads stop", { concurrency: false }, () => {
  const prior = process.env.OPERATOR_WORKSPACE_ROOT;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "operator-page-progress-"));
  process.env.OPERATOR_WORKSPACE_ROOT = root;
  try {
    const fixture = JSON.parse(fs.readFileSync(new URL("./fixtures/evidence-seven-spaces.json", import.meta.url), "utf8"));
    const stored = storeEvidence({ scope: binding, source: "regression:seven-space-pages", trust_level: "authoritative_native",
      raw: { ok: true, result: fixture.rooms } }, 4096);
    let snapshot = journal().snapshot();
    for (let step = 0; step < 9; step += 1) {
      const start = step < 7 ? step : 1;
      const count = step < 7 ? 1 : step - 6;
      const retrieved = retrieveEvidence({ scope: binding, evidence_id: stored.ref.evidence_id,
        purpose: `Review room page ${step}`, item_range: { path: "payload.result", start, count }, max_bytes: 50000 });
      const id = `page-${step}`;
      const obs: ObservationV2 = { ...observation(id, `observation-${id}`), authority: "operator-evidence-store",
        result_schema_id: "operator-capability/operator_retrieve_evidence/v2",
        facts: assignmentKernelControlEvidenceFactsV2("operator_retrieve_evidence", { ok: true, result: retrieved }),
        verification_relevance: ["control"], fulfillment_role: "supporting_control", evidence_class: "control",
        capability_id: "operator_retrieve_evidence", eligible_criterion_ids: [] };
      const op: OperationV2 = { ...operation(id), capability_id: "operator_retrieve_evidence", purpose: "evidence_read",
        fulfillment_role: "supporting_control", delegation_authority_id: undefined, advances_criterion_ids: [], eligible_criterion_ids: [],
        input: { evidenceId: stored.ref.evidence_id, itemRange: { path: "payload.result", start, count }, purpose: `page ${step}` },
        dispatch_state: "dispatched", dispatch_authority: "mcp", settlement_state: "settled", observation_ids: [obs.observation_id],
        result: { ...result(id), authority: obs.authority, result_schema_id: obs.result_schema_id }, settled_at: "2026-08-26T20:00:05.000Z" };
      const after = { ...snapshot, operations: { ...snapshot.operations, [id]: op },
        observations: { ...snapshot.observations, [obs.observation_id]: obs },
        observation_versions: { ...snapshot.observation_versions, [obs.observation_id]: step + 2 }, in_flight_operation_ids: [], quiescent: true };
      const epoch = buildProgressEpochV2({ before: snapshot, after, stated_gap_ids: ["criterion:criterion-inventory"],
        admitted_operation_ids: [id], recorded_at: `2026-08-26T20:00:${String(step + 6).padStart(2, "0")}.000Z` });
      assert.equal(epoch.genuine_progress, step < 7, `page ${step}`);
      assert.ok(obs.facts.every(fact => fact.fact_class === "control"));
      snapshot = { ...after, progress_epochs: [...snapshot.progress_epochs, epoch] };
      const decision = decideAssignmentProgressV2({ snapshot, budget, now: "2026-08-26T20:00:20.000Z" });
      assert.equal(decision.decision, step < 8 ? "admit_reasoning_turn" : "blocked");
      if (step === 8) assert.match(JSON.stringify(decision), /no_progress_budget_exhausted/);
    }
    assert.equal(snapshot.terminal, false);
    assert.deepEqual(snapshot.criteria, {});
  } finally {
    __closeForTests();
    if (prior === undefined) delete process.env.OPERATOR_WORKSPACE_ROOT;
    else process.env.OPERATOR_WORKSPACE_ROOT = prior;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("continued drawing task retains raw token costs without exhausting the default budget during SDK discovery", () => {
  const j = journal();
  for (let i = 0; i < 8; i++) {
    const call_id = `large-context-${i}`;
    j.append(event(j, { event_type: "provider_call_state_recorded", call_id, state: "admitted", provider: "openai", model: "gpt-5.6-sol",
      reasoning_effort: "medium", gap_ids: ["criterion:criterion-inventory"], criterion_ids: ["criterion-inventory"], expected_information: ["inventory.total"] }));
    j.append(event(j, { event_type: "provider_call_state_recorded", call_id, state: "dispatched" }));
    j.append(event(j, { event_type: "provider_call_state_recorded", call_id, state: "usage_received",
      usage: { input_tokens: 82_297, cached_input_tokens: 76_800, output_tokens: 155, reasoning_tokens: 50, total_tokens: 82_452, estimated_cost_usd: null } }));
    j.append(event(j, { event_type: "provider_call_state_recorded", call_id, state: "completed", success: true }));
  }
  const snapshot = j.snapshot();
  assert.equal(Object.values(snapshot.provider_calls).reduce((n, c) => n + (c.usage?.total_tokens ?? 0), 0), 659_616);
  const decision = decideAssignmentProgressV2({ snapshot, budget: DEFAULT_ASSIGNMENT_PROGRESS_BUDGET_V2, now: "2026-08-26T20:01:00Z" });
  assert.notEqual(decision.decision, "blocked");
  assert.equal(decideAssignmentProgressV2({ snapshot, budget: { ...DEFAULT_ASSIGNMENT_PROGRESS_BUDGET_V2, max_total_tokens: 500_000 }, now: "2026-08-26T20:01:00Z" }).reason, "token_budget_exhausted");
});

test("b09 registry then evidence reads then native views discovery adds progress once without fulfilling the edit", () => {
  const initial = journal().snapshot();
  initial.spec = { ...initial.spec, requested_effect: "apply" };
  const registry = discoveryStep(initial, "registry", "/revit/tool-registry");
  // Both evidence retrievals in the retained b09 precede the typed list wrapper.
  // Evidence-store results cannot lend native authority to later reads.
  const evidence = discoveryStep(registry, "evidence", "/revit/tool-registry");
  evidence.observations["obs-evidence"] = { ...evidence.observations["obs-evidence"]!, authority: "operator-evidence-store" };
  const evidenceRepeat = discoveryStep(evidence, "evidence-repeat", "/revit/tool-registry");
  evidenceRepeat.observations["obs-evidence-repeat"] = { ...evidenceRepeat.observations["obs-evidence-repeat"]!, authority: "operator-evidence-store" };
  const after = discoveryStep(evidenceRepeat, "views", "/revit/views");
  after.operations.wrapper = { ...operation("wrapper"), purpose: "discovery", fulfillment_role: "supporting_control", capability_id: "revit_list_views" };
  after.operations.views = { ...after.operations.views!, resolves_gap_ids: [], parent_operation_id: "wrapper" };
  const input = { before: evidenceRepeat, after, stated_gap_ids: ["criterion:criterion-inventory"], recorded_at: "2026-08-26T20:00:10.000Z" };
  const epoch = buildProgressEpochV2(input);
  assert.equal(buildKernelProgressEpochV2(input).genuine_progress, false, "kernel cannot infer tool semantics without host-derived identities");
  assert.deepEqual(epoch.new_fact_identities, []);
  assert.deepEqual(epoch.progress_reasons, ["controller_knowledge_added"]);
  assert.equal(epoch.genuine_progress, true);
  assert.equal(observationAdmissibilityForCriterionV2({ snapshot: after, criterion: after.spec.criteria[0]!, observation: after.observations["obs-views"]! }).admissible, false);
  assert.deepEqual(after.criteria, initial.criteria);
  assert.deepEqual(buildProgressEpochV2(JSON.parse(JSON.stringify(input))), epoch, "restart re-derives the same progress without a replayed read");
  const repeated = discoveryStep(after, "views-repeat", "/revit/views");
  repeated.operations["views-repeat"]!.input = { path: "/revit/views", method: "POST", requireKnownPath: false,
    body: { limit: 200, maxBytes: 9999, timestamp: "later", requestId: "new" } };
  assert.equal(buildProgressEpochV2({ ...input, before: after, after: repeated }).genuine_progress, false);
  const forged = { ...input, before: after, after: repeated,
    supporting_discovery_read_identities: { before: {}, after: { "views-repeat": "provider-invented-new-identity" } } };
  assert.equal(buildProgressEpochV2(forged).genuine_progress, false, "host adapter replaces externally supplied identity maps");
  const resumed = structuredClone(after);
  resumed.current_binding = { ...resumed.current_binding, generation: 2 };
  const reread = discoveryStep(resumed, "views-resumed", "/revit/views");
  reread.operations["views-resumed"]!.binding = resumed.current_binding;
  reread.operations["views-resumed"]!.result!.binding = resumed.current_binding;
  reread.observations["obs-views-resumed"]!.binding = resumed.current_binding;
  assert.equal(buildProgressEpochV2({ ...input, before: resumed, after: reread }).genuine_progress, false,
    "generation changes must not forget successful historical discovery identities");
});

test("supporting discovery counts changed selectors but rejects unbound, failed, stale, or nonnative observations", () => {
  const initial = journal().snapshot();
  const before = discoveryStep(initial, "filtered", "/revit/views", { action: "list", levelNames: ["Level 2"], semanticGroups: ["hvac"] });
  const after = discoveryStep(before, "broader", "/revit/views", { action: "list", semanticGroups: ["hvac"] });
  const compare = (candidate: typeof after) => buildProgressEpochV2({ before, after: candidate,
    stated_gap_ids: ["criterion:criterion-inventory"], recorded_at: "2026-08-26T20:00:10.000Z" });
  assert.equal(compare(after).genuine_progress, true);
  for (const variant of ["failed", "not_dispatched", "missing_result", "unlinked", "nonnative", "stale", "no_gap", "domain_failed", "oversized_selector"]) {
    const bad = structuredClone(after), op = bad.operations.broader!, obs = bad.observations["obs-broader"]!;
    if (variant === "failed") op.result = { ...op.result!, status: "failed_after_dispatch" };
    if (variant === "not_dispatched") op.dispatch_state = "not_dispatched";
    if (variant === "missing_result") op.result = undefined;
    if (variant === "unlinked") op.observation_ids = [];
    if (variant === "nonnative") obs.authority = "operator-mcp-transport";
    if (variant === "stale") obs.binding = { ...obs.binding, generation: 0 };
    if (variant === "no_gap") op.resolves_gap_ids = [];
    if (variant === "domain_failed") obs.facts = obs.facts.map(f => f.fact_id === "control.domain_succeeded" ? { ...f, value: false } : f);
    if (variant === "oversized_selector") op.input = { path: "/revit/views", body: { viewIds: Array(257).fill(9948) } };
    assert.equal(compare(bad).genuine_progress, false, variant);
  }
  const reordered = discoveryStep(after, "reordered", "/revit/views", { semanticGroups: ["hvac"], action: "list", limit: 1 });
  assert.equal(buildProgressEpochV2({ before: after, after: reordered, stated_gap_ids: ["criterion:criterion-inventory"], recorded_at: "2026-08-26T20:00:11.000Z" }).genuine_progress, false);
});
