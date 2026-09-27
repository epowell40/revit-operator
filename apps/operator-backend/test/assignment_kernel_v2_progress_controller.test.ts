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
import { buildAssignmentKernelPublicationV2 } from "../src/assignments/assignment_kernel_v2_publication.js";
import { finalCodexAssignmentMessageV2, codexAssignmentControllerStopMessage } from "../src/brains/codex_assignment_progress.js";
import { criteriaPendingEvaluationV2, deriveProgressGapsV2 } from "../src/domain/assignment-kernel/progress/controller.js";
import { assignmentActiveExecutionTimeMsV2 } from "../src/domain/assignment-kernel/progress/execution_time.js";
import { observationAdmissibilityForCriterionV2 } from "../src/domain/assignment-kernel/semantic_admissibility.js";
import { DEFAULT_ASSIGNMENT_PROGRESS_BUDGET_V2 } from "../src/assignments/assignment_kernel_v2_progress.js";
import { defaultAssignmentWorkBudgetV2 } from "../src/assignments/assignment_work_allowance_v2.js";
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

test("ordinary long-running work permits three distinct correction epochs but stops at four", () => {
  const j = journal();
  let before = j.snapshot();
  assert.equal(DEFAULT_ASSIGNMENT_PROGRESS_BUDGET_V2.max_no_progress_epochs, 4);
  for (let index = 0; index < 4; index += 1) {
    j.append(event(j, {
      event_type: "provider_call_recorded",
      call_id: `pdf-correction-${index}`,
      provider: "openai",
      model: "model",
      reasoning_effort: "medium",
      success: true
    }));
    const after = j.snapshot();
    const epoch = buildProgressEpochV2({ before, after, stated_gap_ids: ["criterion:criterion-inventory"], recorded_at: `2026-08-26T20:00:0${index + 2}.000Z` });
    assert.equal(epoch.genuine_progress, false);
    j.append(event(j, { event_type: "progress_epoch_recorded", epoch }));
    before = j.snapshot();
    const decision = decideAssignmentProgressV2({ snapshot: before, budget: DEFAULT_ASSIGNMENT_PROGRESS_BUDGET_V2, now: "2026-08-26T20:00:10.000Z" });
    if (index < 3) assert.equal(decision.decision, "admit_reasoning_turn");
    else assert.equal(decision.reason, "no_progress_budget_exhausted");
  }
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

test("committed model edit receives a truthful pending handoff without granting verified completion", () => {
  const base=journal().snapshot();
  const snapshot={...base,spec:{...base.spec,requested_effect:"apply" as const},operations:{edit:{operation_id:"edit",binding:base.current_binding,
    requested_effect:"apply",persistent_effect:"applied",settlement_state:"settled",result:{binding:base.current_binding,
      status:"succeeded",authority:"native-host",native_transaction_state:"committed"}}}} as any;
  assert.equal(finalCodexAssignmentMessageV2(snapshot,"Everything is complete."),"Applied one model edit. Final verification is incomplete; the task and remaining checks are saved.");
  assert.equal(snapshot.terminal,false);
  for(const change of ["unknown","none"]){const copy=structuredClone(snapshot);copy.operations.edit.persistent_effect=change;
    assert.doesNotMatch(finalCodexAssignmentMessageV2(copy,"Everything is complete."),/Applied one/);}
  const foreign=structuredClone(snapshot);foreign.operations.edit.result.binding={...foreign.current_binding,generation:foreign.current_binding.generation+1};
  assert.doesNotMatch(finalCodexAssignmentMessageV2(foreign,"Everything is complete."),/Applied one/);
  assert.match(finalCodexAssignmentMessageV2({...snapshot,unresolved_unknown_operation_ids:["other-edit"]},""),/could not confirm/);
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
  const requested = { ...snapshot, spec: { ...snapshot.spec, requested_effect: "apply" as const, result_delivery_required: true, result_assessment_required: true } };
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

test("C99 progress controller admits completion after a same-binding native route dry run at the ordinary call limit", () => {
  const base = journal(false).snapshot();
  const ready = { ...operation("route-preview"), requested_effect: "preview" as const,
    operation_role: "root" as const, fulfillment_role: "supporting_control" as const,
    settlement_state: "settled" as const, observation_ids: ["route-ready"],
    result: { ...result("route-preview"), native_transaction_state: "rolled_back" as const } };
  const observed = { ...observation("route-preview", "route-ready"),
    facts: [{ fact_id: "control.field.status", fact_class: "control" as const, value: "DryRunReady" }] };
  const calls = Object.fromEntries(Array.from({ length: 32 }, (_, i) => [`call-${i}`, {
    state: "completed", admitted_at: "2026-08-26T20:00:03.000Z",
    completed_at: "2026-08-26T20:00:03.100Z", provider_duration_ms: 100,
    usage: { total_tokens: 130_000 }
  }]));
  const snapshot = { ...base,
    spec: { ...base.spec, requested_effect: "apply" as const },
    work_plan: { schema: "revit-operator.assignment-work-plan/v2" as const, assumptions: [], items: [
      { item_id: "branch", description: "Connect a duct branch", source_basis: "drawing", declared_at: "2026-08-26T20:00:00.000Z", operation_ids: [] },
      { item_id: "inspect", kind: "inspection" as const, description: "Verify the connection", source_basis: "model", declared_at: "2026-08-26T20:00:00.000Z", operation_ids: [], depends_on: ["branch"] }
    ] },
    operations: { ...base.operations, [ready.operation_id]: ready },
    observations: { ...base.observations, [observed.observation_id]: observed },
    provider_calls: calls
  } as unknown as typeof base;
  const now = "2026-08-26T20:00:08.000Z";
  assert.equal(decideAssignmentProgressV2({ snapshot, budget: DEFAULT_ASSIGNMENT_PROGRESS_BUDGET_V2, now }).reason,
    "provider_call_budget_exhausted");
  const extended = defaultAssignmentWorkBudgetV2(snapshot, DEFAULT_ASSIGNMENT_PROGRESS_BUDGET_V2);
  assert.equal(extended.max_provider_calls, 48);
  assert.equal(extended.max_total_tokens, 6_000_000);
  assert.match(deriveProgressGapsV2(snapshot).find(gap => gap.kind === "work_plan_required")!.reason,
    /make the authorized matching apply call now/);
  const decision = decideAssignmentProgressV2({ snapshot, budget: extended, now });
  assert.equal(decision.decision, "admit_reasoning_turn", decision.reason);
  const invalidated = { ...snapshot, input_invalidated_operation_ids: [ready.operation_id] };
  assert.doesNotMatch(deriveProgressGapsV2(invalidated).find(gap => gap.kind === "work_plan_required")!.reason,
    /matching apply call now/);
});

test("C120 progress controller preserves verified edit credit after steering invalidates its completion evidence", () => {
  const base = journal(false).snapshot();
  const edited = { ...operation("duct-edit"), requested_effect: "apply" as const,
    persistent_effect: "applied" as const, settlement_state: "settled" as const,
    opened_at: "2026-08-26T20:00:02.000Z",
    request_identity: { method: "POST" as const, path: "/revit/duct", request_signature: "duct-edit-signature" },
    verification_operation_ids: ["duct-read"],
    result: { ...result("duct-edit"), native_transaction_state: "committed" as const,
      affected_target_identities: ["element_id:42"] } };
  const read = { ...operation("duct-read"), requested_effect: "read" as const,
    purpose: "verification" as const, persistent_effect: "none" as const,
    settlement_state: "settled" as const, verification_of_operation_id: "duct-edit",
    target: { target_id: "id:42" }, observation_ids: ["duct-proof"],
    result: { ...result("duct-read"), authority: "native-host" as const } };
  const proof = { ...observation("duct-read", "duct-proof"),
    facts: [{ fact_id: "verification.postcondition_satisfied", fact_class: "verification" as const, value: true }] };
  const calls = Object.fromEntries(Array.from({ length: 64 }, (_, i) => [`call-${i}`, {
    state: "completed", admitted_at: "2026-08-26T20:00:03.000Z",
    completed_at: "2026-08-26T20:00:03.100Z", provider_duration_ms: 100,
    usage: { total_tokens: 1000 }
  }]));
  const snapshot = { ...base, spec: { ...base.spec, requested_effect: "apply" as const },
    work_plan: { schema: "revit-operator.assignment-work-plan/v2" as const, assumptions: [], items: [
      { item_id: "first", description: "Connect first branch", source_basis: "drawing", declared_at: "2026-08-26T20:00:00.000Z", operation_ids: ["duct-edit"] },
      { item_id: "second", description: "Connect second branch", source_basis: "drawing", declared_at: "2026-08-26T20:00:00.000Z", operation_ids: [] }
    ] }, operations: { ...base.operations, [edited.operation_id]: edited, [read.operation_id]: read },
    observations: { ...base.observations, [proof.observation_id]: proof },
    input_invalidated_operation_ids: [edited.operation_id], provider_calls: calls
  } as unknown as typeof base;
  const now = "2026-08-26T20:00:08.000Z";
  assert.equal(decideAssignmentProgressV2({ snapshot, budget: DEFAULT_ASSIGNMENT_PROGRESS_BUDGET_V2, now }).reason,
    "provider_call_budget_exhausted");
  const extended = defaultAssignmentWorkBudgetV2(snapshot, DEFAULT_ASSIGNMENT_PROGRESS_BUDGET_V2);
  assert.equal(extended.max_provider_calls, 72);
  assert.notEqual(decideAssignmentProgressV2({ snapshot, budget: extended, now }).reason,
    "provider_call_budget_exhausted");
});

test("C106 wrapped native stage preview guides apply and survives the ordinary call limit", () => {
  const base = journal(false).snapshot();
  const route = "/revit/existing-conditions-mep-draft-workflow";
  const parent = { ...operation("mcp-root"), capability_id: "revit_call_tool",
    requested_effect: "preview" as const, operation_role: "root" as const,
    request_identity: { method: "POST" as const, path: route, request_signature: "mcp-request" },
    settlement_state: "settled" as const,
    result: { ...result("mcp-root"), status: "completed_without_native_dispatch" as const,
      dispatch_state: "not_dispatched" as const, native_transaction_state: "not_applicable" as const,
      authority: "operator-mcp-transport" as const, observation_required: false } };
  const child = { ...operation("native-stage"), requested_effect: "preview" as const,
    operation_role: "child" as const, parent_operation_id: parent.operation_id,
    root_operation_id: parent.operation_id,
    request_identity: { method: "POST" as const, path: route, request_signature: "native-request" },
    settlement_state: "settled" as const, observation_ids: ["stage-ready"],
    result: { ...result("native-stage"), native_transaction_state: "rolled_back" as const } };
  const observed = { ...observation("native-stage", "stage-ready"),
    facts: [{ fact_id: "control.field.status", fact_class: "control" as const, value: "DryRunReady" }] };
  const calls = Object.fromEntries(Array.from({ length: 32 }, (_, i) => [`call-${i}`, {
    state: "completed", admitted_at: "2026-08-26T20:00:03.000Z",
    completed_at: "2026-08-26T20:00:03.100Z", provider_duration_ms: 100,
    usage: { total_tokens: 130_000 }
  }]));
  const snapshot = { ...base, spec: { ...base.spec, requested_effect: "apply" as const },
    work_plan: { schema: "revit-operator.assignment-work-plan/v2" as const, assumptions: [], items: [
      { item_id: "branch", description: "Connect the duct", source_basis: "drawing", declared_at: "2026-08-26T20:00:00.000Z", operation_ids: [] },
      { item_id: "inspect", kind: "inspection" as const, description: "Read connectors", source_basis: "model", declared_at: "2026-08-26T20:00:00.000Z", operation_ids: [], depends_on: ["branch"] }
    ] }, operations: { ...base.operations, [parent.operation_id]: parent, [child.operation_id]: child },
    observations: { ...base.observations, [observed.observation_id]: observed }, provider_calls: calls
  } as unknown as typeof base;
  const extended = defaultAssignmentWorkBudgetV2(snapshot, DEFAULT_ASSIGNMENT_PROGRESS_BUDGET_V2);
  assert.equal(extended.max_provider_calls, 48);
  assert.match(deriveProgressGapsV2(snapshot).find(gap => gap.kind === "work_plan_required")!.reason,
    /make the authorized matching apply call now/);
  const wrongParent = structuredClone(snapshot);
  wrongParent.operations[parent.operation_id]!.request_identity!.path = "/revit/other";
  assert.equal(defaultAssignmentWorkBudgetV2(wrongParent, DEFAULT_ASSIGNMENT_PROGRESS_BUDGET_V2).max_provider_calls, 32);
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

test("multi-chunk apply keeps its generic result criterion open after the first model edit", () => {
  const j = journal();
  settleObservation(j);
  const base = j.snapshot();
  const original = base.operations["operation-inventory"]!;
  const originalObservation = base.observations["observation-inventory"]!;
  const originalCriterion = base.spec.criteria[0]!;
  assert(originalCriterion.evidence_policy);
  const criterion: AssignmentSpecV2["criteria"][number] = {
    ...originalCriterion,
    semantic_fact_requirements: ["task.result_available"],
    evidence_policy: {
      ...originalCriterion.evidence_policy,
      required_fact_ids: ["task.result_available"]
    }
  };
  const operation = { ...original, requested_effect: "apply" as const, persistent_effect: "applied" as const,
    result: { ...original.result!, persistent_effect: "applied" as const, native_transaction_state: "committed" as const } };
  const observation = { ...originalObservation,
    facts: [{ fact_id: "task.result_available", fact_class: "domain" as const, value: true }] };
  const snapshot: typeof base = { ...base,
    spec: { ...base.spec, requested_effect: "apply" as const, work_plan_required: true, criteria: [criterion] },
    operations: { ...base.operations, [operation.operation_id]: operation },
    observations: { ...base.observations, [observation.observation_id]: observation },
    work_plan: { schema: "revit-operator.assignment-work-plan/v2" as const, assumptions: [], items: [
      { item_id: "equipment", description: "Place equipment", source_basis: "source", declared_at: "2026-08-26T20:00:00.000Z", operation_ids: [operation.operation_id] },
      { item_id: "duct_network", description: "Connect the duct network", source_basis: "source", declared_at: "2026-08-26T20:00:00.000Z", operation_ids: [] }
    ] }
  };
  assert.equal(observationAdmissibilityForCriterionV2({ snapshot, criterion, observation }).admissible, true);
  assert.deepEqual(criteriaPendingEvaluationV2(snapshot), {});
  assert.deepEqual(Object.keys(criteriaPendingEvaluationV2({ ...snapshot, spec: { ...snapshot.spec, work_plan_required: false }, work_plan: undefined })), [criterion.criterion_id]);
});

test("C59 retained interpretation and registration advance the open result gap once each", () => {
  const evidence = { evidence_id: `ev1_${"a".repeat(32)}`, content_hash: `sha256:${"b".repeat(64)}`, trust_level: "host_observed" };
  const interpretation = { schema_version: 1, source_binding_sha256: "c".repeat(64),
    interpretation_sha256: "d".repeat(64), native_write_allowed: false, evidence_ref: evidence };
  const registration = { schema_version: 1, interpretation_evidence_id: evidence.evidence_id,
    frame_observation_id: `obsv2_${"e".repeat(64)}`, registration: { verified: true },
    native_write_allowed: false, evidence_ref: { ...evidence, content_hash: `sha256:${"f".repeat(64)}` } };
  let before = journal().snapshot();
  const step = (id: string, tool: string, payload: unknown, expected: boolean) => {
    const obs: ObservationV2 = { ...observation(id, `obs-${id}`),
      authority: "operator-mcp-transport", result_schema_id: `operator-capability/${tool}/v2`,
      facts: assignmentKernelControlEvidenceFactsV2(tool, payload),
      verification_relevance: ["control"], fulfillment_role: "supporting_control",
      evidence_class: "control", capability_id: tool, eligible_criterion_ids: [] };
    const op: OperationV2 = { ...operation(id), capability_id: tool, purpose: "work",
      fulfillment_role: "supporting_control", delegation_authority_id: undefined,
      advances_criterion_ids: [], eligible_criterion_ids: [], resolves_gap_ids: ["result:delivery"],
      dispatch_state: "dispatched", dispatch_authority: "mcp", settlement_state: "settled",
      observation_ids: [obs.observation_id], result: { ...result(id), authority: obs.authority,
        result_schema_id: obs.result_schema_id }, settled_at: "2026-08-26T20:00:05.000Z" };
    const after = { ...before, operations: { ...before.operations, [id]: op },
      observations: { ...before.observations, [obs.observation_id]: obs },
      observation_versions: { ...before.observation_versions, [obs.observation_id]: 2 },
      in_flight_operation_ids: [], quiescent: true };
    const epoch = buildProgressEpochV2({ before, after, stated_gap_ids: ["result:delivery"],
      admitted_operation_ids: [id], recorded_at: "2026-08-26T20:00:06.000Z" });
    assert.equal(epoch.genuine_progress, expected, id);
    assert.equal(obs.facts.every(fact => fact.fact_class === "control"), true);
    before = { ...after, progress_epochs: [...before.progress_epochs, epoch] };
  };
  step("interpretation", "operator_validate_existing_conditions_interpretation", interpretation, true);
  step("interpretation-repeat", "operator_validate_existing_conditions_interpretation", interpretation, false);
  step("registration", "operator_register_existing_conditions_interpretation", registration, true);
  step("registration-repeat", "operator_register_existing_conditions_interpretation", registration, false);
});

test("seven retained room pages progress through the real store and controller but overlapping rereads stop", { concurrency: false }, () => {
  const prior = process.env.OPERATOR_WORKSPACE_ROOT;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "operator-page-progress-"));
  process.env.OPERATOR_WORKSPACE_ROOT = root;
  try {
    const fixture = JSON.parse(fs.readFileSync(path.resolve("test/fixtures/evidence-seven-spaces.json"), "utf8"));
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

test("uncertain workbook effect never claims that a Revit model edit happened",()=>{
  const snapshot={...journal().snapshot(),unresolved_unknown_operation_ids:["export"]};
  const message=finalCodexAssignmentMessageV2(snapshot,"");
  assert.match(message,/could not confirm.*requested change/);
  assert.match(message,/verify the result before retrying/);
  assert.doesNotMatch(message,/model edit|completed successfully/);
});

function advisoryHandoffJournal(proposal: { claimed_completed: string[]; remaining_work: string[]; uncertainties: string[] }) {
  const j = new AssignmentJournalV2();
  j.append(event(j, { event_type: "assignment_created", spec: { ...spec(), execution_policy: {
    mode: "local_advisory_v1", selected_by: "trusted_local_host", session_id: binding.session_id,
    document_fingerprint: binding.document_fingerprint!, max_turns: 8, max_provider_calls: 64,
    max_operations: 128, max_total_tokens: 1_000_000, max_wall_clock_ms: 600_000
  } } }));
  j.append({ ...event(j, { event_type: "review_requested", review_id: "handoff-review", work_unit_ids: [],
    reason: "User review", completion_proposal: proposal }), actor: "operator-work-plan" });
  return j;
}

test("advisory handoff shows bounded whole items while canonical Details retains the complete proposal", () => {
  const proposal = {
    claimed_completed: ["Prepared the comparison table without changing source records.", "Saved the draft for review.", "Included the supplied appendix."],
    remaining_work: ["Check the final figures.", "Review the appendix.", "Obtain the missing source."],
    uncertainties: ["The latest figures are estimates, not confirmed values.", "Coverage excludes the missing source.", "The appendix date is unclear."]
  };
  const j = advisoryHandoffJournal(proposal), snapshot = j.snapshot();
  const before = JSON.stringify(snapshot), events = structuredClone(j.events());
  const message = finalCodexAssignmentMessageV2(snapshot, "Everything is verified.");
  assert.match(message, /^Ready for review \(not independently verified\)\./);
  assert.equal((message.match(/not independently verified/g) ?? []).length, 1);
  const summary = message.split("\n\n## Details\n\n")[0]!;
  for (const items of Object.values(proposal)) {
    assert.ok(summary.includes(items[0]!)); assert.ok(summary.includes(items[1]!));
    assert.ok(!summary.includes(items[2]!));
    for (const item of items) assert.ok(message.includes(`- ${item}`), "full wording is retained below Details");
  }
  assert.match(message, /Full handoff in Details below\./);
  assert.equal((summary.match(/1 more in Details/g) ?? []).length, 3);
  assert.doesNotMatch(message, /Reported work:|Everything is verified/);
  assert.equal(JSON.stringify(snapshot), before); assert.deepEqual(j.events(), events);
  const publication = buildAssignmentKernelPublicationV2(j.snapshot());
  for (const key of ["claimed_completed", "remaining_work", "uncertainties"] as const)
    assert.deepEqual(publication.snapshot.completion_proposal![key], proposal[key]);
  assert.equal(publication.snapshot.completion_proposal!.verified, false);
  assert.equal(publication.snapshot.outcome, "awaiting_user_review"); assert.equal(publication.snapshot.terminal, false);
});

test("advisory handoff does not truncate a long item before its qualification or skip to a shorter later item", () => {
  const long = "Prepared a provisional comparison using the retained inputs. ".repeat(8) + "This does not establish correctness or permission to publish.";
  const proposal = { claimed_completed: [long, "Saved a copy."], remaining_work: [], uncertainties: [long] };
  const snapshot = advisoryHandoffJournal(proposal).snapshot();
  const message = finalCodexAssignmentMessageV2(snapshot, "All done.");
  const summary = message.split("\n\n## Details\n\n")[0]!;
  assert.doesNotMatch(summary, /Prepared a provisional|Saved a copy|All done/);
  assert.match(summary, /Work: 2 items in Details/); assert.match(summary, /Newly reported uncertainty: 1 item in Details/);
  assert.match(summary, /1 saved unfinished report remains/);
  assert.ok(message.includes(long)); assert.ok(message.includes("Saved a copy."));
  assert.ok(summary.length < 400); assert.deepEqual(snapshot.completion_proposal!.claimed_completed, proposal.claimed_completed);
  assert.deepEqual(buildAssignmentKernelPublicationV2(snapshot).snapshot.completion_proposal!.uncertainties, [long]);
});

test("advisory handoff with no completed work does not invent success or certainty", () => {
  const snapshot = advisoryHandoffJournal({ claimed_completed: [], remaining_work: ["Wait for the corrected source."], uncertainties: [] }).snapshot();
  const message = finalCodexAssignmentMessageV2(snapshot, "Completed everything.");
  assert.match(message, /No completed work was reported/); assert.match(message, /Wait for the corrected source/);
  assert.doesNotMatch(message, /Completed everything|Nothing remains|No uncertainties|Work:/);
  assert.equal(snapshot.terminal, false); assert.equal(snapshot.completion_proposal!.verified, false);
});

test("advisory handoff cannot hide unknown effects, Pause, failure, budget, missing input or unsettled work", () => {
  const snapshot = advisoryHandoffJournal({ claimed_completed: ["Prepared the draft."], remaining_work: [], uncertainties: [] }).snapshot();
  const cases: [string, Record<string, unknown>, RegExp][] = [
    ["unknown", { unresolved_unknown_operation_ids: ["uncertain-change"] }, /could not confirm/],
    ["pause", { execution_control: { state: "paused", command_id: "pause", changed_at: snapshot.spec.created_at } }, /Task paused/],
    ["terminal failure", { terminal: true, outcome: "failed", terminal_reason: "execution_failed" }, /did not complete/],
    ["terminal blocker", { terminal: true, outcome: "blocked", terminal_reason: "reconciliation_required" }, /did not complete/],
    ["late failure", { execution_failure_ids: ["failed-call"] }, /stopped/],
    ["work limit", { provider_budget_exhausted: true }, /limit/],
    ["blocker", { progress_blocker: { code: "operation_budget_exhausted", gap_ids: [], recorded_at: snapshot.spec.created_at } }, /stopped/],
    ["input", { outcome: "awaiting_user_input", pending_input_variable_ids: ["source"], clarifications: {
      source: { clarification_id: "source", variable_id: "source", question: "Which source should I use?", requested_at: snapshot.spec.created_at }
    } }, /Which source should I use/],
    ["native settling", { in_flight_operation_ids: ["native"], quiescent: false }, /settling/],
    ["provider settling", { in_flight_provider_call_ids: ["provider"], quiescent: false }, /settling/]
  ];
  for (const [name, change, expected] of cases) {
    const state = { ...structuredClone(snapshot), ...change } as typeof snapshot, before = JSON.stringify(state);
    const message = finalCodexAssignmentMessageV2(state, "Everything completed successfully.");
    assert.match(message, expected, name); assert.doesNotMatch(message, /Ready for review|Prepared the draft|Everything completed successfully/, name);
    assert.equal(JSON.stringify(state), before, name);
  }
});
