import assert from "node:assert/strict";
import test from "node:test";
import {
  ASSIGNMENT_EVENT_V2_SCHEMA,
  ASSIGNMENT_SPEC_V2_SCHEMA,
  OBSERVATION_V2_SCHEMA,
  OPERATION_RESULT_V2_SCHEMA,
  OPERATION_V2_SCHEMA,
  AssignmentJournalV2,
  assertOperationAdvancesProgressV2,
  buildProgressEpochV2,
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
