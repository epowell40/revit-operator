import assert from "node:assert/strict";
import test from "node:test";
import { normalizeAssignmentInputsV2 } from "../src/assignments/assignment_kernel_v2_input_adapter.js";
import {
  ASSIGNMENT_EVENT_V2_SCHEMA,
  ASSIGNMENT_SPEC_V2_SCHEMA,
  OPERATION_RESULT_V2_SCHEMA,
  OPERATION_V2_SCHEMA,
  AssignmentJournalV2,
  AssignmentKernelErrorV2,
  canonicalJsonV2,
  evaluateCriterionV2,
  type AssignmentBindingV2,
  type AssignmentEventV2,
  type AssignmentSpecV2,
  type CriterionEvaluationV2,
  type OperationResultV2,
  type OperationV2
} from "../src/domain/assignment-kernel/index.js";
import {
  ObservationDecoderRegistryV2,
  canonicalPayloadHashV2,
  observationFromOperationResultV2,
  readAliasedSourceFieldV2,
  unwrapOperationResultV2,
  type OperationResultTransportV2
} from "../src/execution_truth/assignment_kernel_v2_result_adapter.js";

const binding: AssignmentBindingV2 = {
  assignment_id: "assignment-1",
  run_id: "run-1",
  generation: 1,
  session_id: "session-1",
  principal_id: "principal-1",
  document_fingerprint: "document-1"
};

function spec(effect: "read" | "preview" | "apply" = "read", needsInput = false): AssignmentSpecV2 {
  return {
    schema: ASSIGNMENT_SPEC_V2_SCHEMA,
    binding,
    source_user_request: effect === "apply" ? "Update the selected note." : "Report the selected inventory.",
    requested_effect: effect,
    criteria: [{
      criterion_id: "criterion-result",
      requirement: "Requested result is authoritatively established.",
      required: true,
      semantic_fact_requirements: ["result.total"],
      accepted_evaluator_authority_ids: ["deterministic-test"],
      accepted_observation_authority_ids: ["native-host"]
    }],
    input_variables: needsInput ? [{ variable_id: "replacement_text", value_state: "needs_input", required: true, sensitive: false }] : [],
    work_units: [{
      work_unit_id: "work-1",
      requested_effect: effect,
      execution_class: "independent",
      dependency_ids: [],
      criterion_ids: ["criterion-result"],
      input_variable_ids: needsInput ? ["replacement_text"] : [],
      independently_useful: true,
      safe_to_retain: true,
      rollback_scope: effect === "apply" ? "operation" : "none"
    }],
    authorization_policy_id: "policy-1",
    created_at: "2026-08-26T12:00:00.000Z"
  };
}

type EventBodyV2<T> = T extends unknown
  ? Omit<T, "schema" | "event_id" | "assignment_id" | "assignment_version" | "binding" | "occurred_at" | "actor">
  : never;

function event(journal: AssignmentJournalV2, body: EventBodyV2<AssignmentEventV2>, eventBinding = binding): AssignmentEventV2 {
  const version = journal.events().length + 1;
  return {
    schema: ASSIGNMENT_EVENT_V2_SCHEMA,
    event_id: `event-${version}`,
    assignment_id: eventBinding.assignment_id,
    assignment_version: version,
    binding: eventBinding,
    occurred_at: `2026-08-26T12:00:${String(version).padStart(2, "0")}.000Z`,
    actor: "test",
    ...body
  } as AssignmentEventV2;
}

function createJournal(assignmentSpec = spec()): AssignmentJournalV2 {
  const journal = new AssignmentJournalV2();
  journal.append(event(journal, { event_type: "assignment_created", spec: assignmentSpec }));
  return journal;
}

function operation(effect: "read" | "preview" | "apply" = "read", purpose: OperationV2["purpose"] = "work"): OperationV2 {
  return {
    schema: OPERATION_V2_SCHEMA,
    operation_id: "operation-1",
    binding,
    work_unit_id: "work-1",
    capability_id: effect === "read" ? "inventory.read" : "element.update",
    requested_effect: effect,
    purpose,
    advances_criterion_ids: ["criterion-result"],
    resolves_gap_ids: ["criterion:criterion-result"],
    target: { target_id: "target-1", document_fingerprint: binding.document_fingerprint },
    input: {},
    admission_state: "admitted",
    dispatch_state: "not_dispatched",
    persistent_effect: "none",
    settlement_state: "open",
    observation_ids: [],
    verification_operation_ids: [],
    opened_at: "2026-08-26T12:00:02.000Z",
    deadline_at: "2026-08-26T12:01:02.000Z"
  };
}

function result(rawPayload: unknown, effect: "read" | "preview" | "apply" = "read"): OperationResultV2 {
  return {
    schema: OPERATION_RESULT_V2_SCHEMA,
    result_id: "result-1",
    operation_id: "operation-1",
    binding,
    status: "succeeded",
    dispatch_state: "dispatched",
    persistent_effect: effect === "apply" ? "applied" : "none",
    native_transaction_state: effect === "apply" ? "committed" : effect === "preview" ? "rolled_back" : "not_applicable",
    authority: "native-host",
    result_schema_id: "inventory-result/v1",
    observation_required: true,
    raw_payload_hash: canonicalPayloadHashV2(rawPayload),
    receipt_id: "receipt-1",
    native_correlation_id: "native-1",
    completed_at: "2026-08-26T12:00:04.000Z"
  };
}

function registry(): ObservationDecoderRegistryV2 {
  const output = new ObservationDecoderRegistryV2();
  output.register("inventory-result/v1", (raw) => {
    const value = raw as { total: number };
    return [{ fact_id: "result.total", value: value.total }];
  });
  return output;
}

function retainResult(journal: AssignmentJournalV2, rawPayload: unknown, effect: "read" | "preview" | "apply" = "read"): void {
  const nativeResult = result(rawPayload, effect);
  journal.append(event(journal, { event_type: "operation_result_recorded", result: nativeResult }));
  const observation = observationFromOperationResultV2({
    result: nativeResult,
    expected_binding: binding,
    observation_id: "observation-1",
    raw_payload_ref: "evidence://sha256/result",
    raw_payload: rawPayload,
    registry: registry()
  });
  journal.append(event(journal, { event_type: "observation_retained", observation }));
}

function passingEvaluation(basis: CriterionEvaluationV2["basis"] = "observation"): CriterionEvaluationV2 {
  return {
    criterion_id: "criterion-result",
    status: "pass",
    basis,
    supporting_operation_ids: ["operation-1"],
    supporting_facts: [{ observation_id: "observation-1", fact_id: "result.total" }],
    evaluator_authority: "deterministic-test",
    reason: "The requested semantic fact is present.",
    evaluated_at: "2026-08-26T12:00:06.000Z"
  };
}

test("read operation remains in flight until the authoritative observation is retained", () => {
  const journal = createJournal();
  journal.append(event(journal, { event_type: "operation_admitted", operation: operation() }));
  journal.append(event(journal, { event_type: "native_dispatch_recorded", operation_id: "operation-1", native_correlation_id: "native-1" }));
  const nativeResult = result({ total: 509 });
  const afterResult = journal.append(event(journal, { event_type: "operation_result_recorded", result: nativeResult }));
  assert.equal(afterResult.quiescent, false);
  assert.equal(afterResult.operations["operation-1"].settlement_state, "retaining_observation");
  assert.equal(afterResult.outcome, "active");

  const observation = observationFromOperationResultV2({ result: nativeResult, expected_binding: binding, observation_id: "observation-1", raw_payload_ref: "evidence://sha256/result", raw_payload: { total: 509 }, registry: registry() });
  const afterObservation = journal.append(event(journal, { event_type: "observation_retained", observation }));
  assert.equal(afterObservation.quiescent, true);
  assert.equal(afterObservation.operations["operation-1"].settlement_state, "settled");
  assert.equal(afterObservation.outcome, "active", "quiescence and a read alone do not prove task completion");

  const completed = journal.append(event(journal, { event_type: "criterion_evaluated", evaluation: passingEvaluation() }));
  assert.equal(completed.outcome, "complete");
  const terminal = journal.append(event(journal, { event_type: "assignment_terminal", outcome: "complete", reason: "criteria_satisfied" }));
  assert.equal(terminal.terminal, true);
  assert.ok(terminal.finished_at);
});

test("discovery-only quiescence and assistant claims cannot complete an Assignment", () => {
  const journal = createJournal();
  journal.append(event(journal, { event_type: "operation_admitted", operation: operation("read", "discovery") }));
  journal.append(event(journal, { event_type: "native_dispatch_recorded", operation_id: "operation-1" }));
  retainResult(journal, { total: 509 });
  assert.equal(journal.snapshot().outcome, "active");
  assert.throws(() => journal.append(event(journal, { event_type: "assignment_terminal", outcome: "complete", reason: "assistant_said_complete" })), (error: unknown) => error instanceof AssignmentKernelErrorV2 && error.code === "assignment_terminal_outcome_invalid");
});

test("ambiguous desired mutation state is awaiting input and cannot become verified no-op", () => {
  const journal = createJournal(spec("apply", true));
  assert.equal(journal.snapshot().outcome, "awaiting_user_input");
  assert.throws(() => journal.append(event(journal, { event_type: "assignment_terminal", outcome: "verified_noop", reason: "two_reads" })), (error: unknown) => error instanceof AssignmentKernelErrorV2 && error.code === "assignment_terminal_outcome_invalid");
  journal.append(event(journal, { event_type: "input_requested", variable_id: "replacement_text", clarification_id: "clarification-1", question: "What exact text should replace the current note?" }));
  journal.append(event(journal, { event_type: "input_supplied", variable_id: "replacement_text", clarification_id: "clarification-1", value: "Current issue wording" }));
  assert.equal(journal.snapshot().outcome, "active");
});

test("apply stays unknown after dispatch until authoritative settlement or reconciliation", () => {
  const journal = createJournal(spec("apply"));
  journal.append(event(journal, { event_type: "operation_admitted", operation: operation("apply") }));
  const dispatched = journal.append(event(journal, { event_type: "native_dispatch_recorded", operation_id: "operation-1" }));
  assert.deepEqual(dispatched.unresolved_unknown_operation_ids, ["operation-1"]);
  assert.equal(dispatched.quiescent, false);
  assert.throws(() => journal.append(event(journal, { event_type: "assignment_terminal", outcome: "failed", reason: "timeout" })), (error: unknown) => error instanceof AssignmentKernelErrorV2 && error.code === "assignment_terminal_not_quiescent");
});

test("pre-dispatch rejection settles none without consuming apply truth", () => {
  const journal = createJournal(spec("apply"));
  journal.append(event(journal, { event_type: "operation_admitted", operation: operation("apply") }));
  const rejected: OperationResultV2 = {
    ...result({}, "apply"),
    result_id: "result-rejected",
    status: "failed_before_dispatch",
    dispatch_state: "not_dispatched",
    persistent_effect: "none",
    native_transaction_state: "not_applicable",
    observation_required: false,
    raw_payload_hash: undefined,
    error_code: "confirmation_required"
  };
  const settled = journal.append(event(journal, { event_type: "operation_result_recorded", result: rejected }));
  assert.equal(settled.operations["operation-1"].persistent_effect, "none");
  assert.equal(settled.operations["operation-1"].settlement_state, "settled");
  assert.equal(settled.quiescent, true);
});

test("controller acceptance cannot masquerade as native dispatch or settlement", () => {
  const journal = createJournal();
  journal.append(event(journal, { event_type: "operation_admitted", operation: operation() }));
  assert.throws(() => journal.append(event(journal, { event_type: "operation_result_recorded", result: result({ total: 1 }) })), (error: unknown) => error instanceof AssignmentKernelErrorV2 && error.code === "operation_result_dispatch_unproven");
});

test("a blocking prerequisite is a child operation and its receipt cannot dispatch or settle the parent", () => {
  const journal = createJournal();
  const parent = {
    ...operation(),
    operation_id: "operation-parent",
    capability_id: "revit_call_tool",
    operation_role: "root",
    request_identity: {
      capability_id: "revit_call_tool",
      method: "POST",
      path: "/revit/quantify",
      request_signature: "request-quantify"
    }
  } as OperationV2;
  const child = {
    ...operation("read", "discovery"),
    operation_id: "operation-registry-child",
    capability_id: "native:GET:/revit/tool-registry",
    operation_role: "prerequisite",
    parent_operation_id: parent.operation_id,
    root_operation_id: parent.operation_id,
    blocks_parent_settlement: true,
    request_identity: {
      capability_id: "native:GET:/revit/tool-registry",
      method: "GET",
      path: "/revit/tool-registry",
      request_signature: "request-registry"
    }
  } as OperationV2;
  journal.append(event(journal, { event_type: "operation_admitted", operation: parent }));
  journal.append(event(journal, { event_type: "operation_admitted", operation: child }));

  assert.throws(
    () => journal.append(event(journal, {
      event_type: "native_dispatch_recorded",
      operation_id: parent.operation_id,
      native_correlation_id: "registry-courier-job"
    })),
    (error: unknown) => error instanceof AssignmentKernelErrorV2
      && error.code === "operation_parent_blocked_by_child"
  );

  journal.append(event(journal, {
    event_type: "native_dispatch_recorded",
    operation_id: child.operation_id,
    native_correlation_id: "registry-courier-job"
  }));
  const childResult = {
    ...result({ tools: [{ path: "/revit/quantify" }] }),
    result_id: "result-registry-child",
    operation_id: child.operation_id,
    request_identity: child.request_identity
  } as OperationResultV2;
  journal.append(event(journal, { event_type: "operation_result_recorded", result: childResult }));

  const parentAfterChildResult = journal.snapshot().operations[parent.operation_id];
  assert.equal(parentAfterChildResult.dispatch_state, "not_dispatched");
  assert.equal(parentAfterChildResult.settlement_state, "open");
});

test("Candidate 1 shape rejects a prerequisite receipt relabeled with the parent operation identity", () => {
  const journal = createJournal();
  const parent = {
    ...operation(),
    capability_id: "revit_call_tool",
    request_identity: {
      capability_id: "revit_call_tool",
      method: "POST",
      path: "/revit/quantify",
      request_signature: "request-quantify"
    }
  } as OperationV2;
  journal.append(event(journal, { event_type: "operation_admitted", operation: parent }));
  journal.append(event(journal, { event_type: "operation_dispatch_started", operation_id: parent.operation_id }));
  journal.append(event(journal, { event_type: "native_dispatch_recorded", operation_id: parent.operation_id }));
  const relabeledPrerequisite = {
    ...result({ tools: [] }),
    request_identity: {
      capability_id: "native:GET:/revit/tool-registry",
      method: "GET",
      path: "/revit/tool-registry",
      request_signature: "request-registry"
    }
  } as OperationResultV2;
  assert.throws(
    () => journal.append(event(journal, { event_type: "operation_result_recorded", result: relabeledPrerequisite })),
    (error: unknown) => error instanceof AssignmentKernelErrorV2
      && error.code === "operation_result_request_identity_mismatch"
  );
});

test("all supported transport wrappers unwrap to one exact OperationResultV2", () => {
  const nativeResult = result({ total: 509 });
  const transports: OperationResultTransportV2[] = [
    { transport: "direct_native", operation_result_v2: nativeResult },
    { transport: "typed_mcp", structured_content: { operation_result_v2: nativeResult } },
    { transport: "generic_mcp", structured_content: { operation_result_v2: nativeResult } },
    { transport: "legacy_mcp_text", content: [{ type: "text", text: JSON.stringify({ operation_result_v2: nativeResult }) }] },
    { transport: "courier", completion: { operation_result_v2: nativeResult } },
    { transport: "dynamic_runtime", settlement: { operation_result_v2: nativeResult } }
  ];
  const canonical = transports.map((transport) => canonicalJsonV2(unwrapOperationResultV2(transport)));
  assert.equal(new Set(canonical).size, 1);
  assert.throws(() => unwrapOperationResultV2({ transport: "legacy_mcp_text", content: [{ type: "text", text: JSON.stringify({ payload: { operation_result_v2: nativeResult } }) }] }), /wrap exactly one/);
});

test("transport choice produces the same operation and snapshot projection", () => {
  const snapshots = (["direct_native", "typed_mcp", "generic_mcp", "courier", "dynamic_runtime"] as const).map((transport) => {
    const journal = createJournal();
    journal.append(event(journal, { event_type: "operation_admitted", operation: operation() }));
    journal.append(event(journal, { event_type: "native_dispatch_recorded", operation_id: "operation-1" }));
    const nativeResult = result({ total: 509 });
    const envelope: OperationResultTransportV2 = transport === "direct_native"
      ? { transport, operation_result_v2: nativeResult }
      : transport === "typed_mcp" || transport === "generic_mcp"
        ? { transport, structured_content: { operation_result_v2: nativeResult } }
        : transport === "courier"
          ? { transport, completion: { operation_result_v2: nativeResult } }
          : { transport, settlement: { operation_result_v2: nativeResult } };
    const decoded = unwrapOperationResultV2(envelope);
    journal.append(event(journal, { event_type: "operation_result_recorded", result: decoded }));
    journal.append(event(journal, { event_type: "observation_retained", observation: observationFromOperationResultV2({ result: decoded, expected_binding: binding, observation_id: "observation-1", raw_payload_ref: "evidence://sha256/result", raw_payload: { total: 509 }, registry: registry() }) }));
    return canonicalJsonV2(journal.snapshot());
  });
  assert.equal(new Set(snapshots).size, 1);
});

test("external input spelling normalizes once to a stable variable and rejects lifecycle fields", () => {
  const assignmentSpec = spec("apply", true);
  const aliases = { replacement_text: ["replacementText", "replacement-text"] };
  for (const key of ["replacement_text", "replacementText", "replacement-text"]) {
    assert.deepEqual(normalizeAssignmentInputsV2({ spec: assignmentSpec, external_values: { [key]: "New text" }, aliases }), { replacement_text: "New text" });
  }
  assert.throws(() => normalizeAssignmentInputsV2({ spec: assignmentSpec, external_values: { assignment_id: "foreign" }, aliases }), (error: unknown) => error instanceof AssignmentKernelErrorV2 && error.code === "trusted_binding_input_forbidden");
});

test("source field styles normalize once at the result edge to identical semantic facts", () => {
  const decoder = new ObservationDecoderRegistryV2();
  decoder.register("styled-inventory/v1", (raw) => [{ fact_id: "inventory.total", value: Number(readAliasedSourceFieldV2(raw, "total_count", ["totalCount", "total-count"])) }]);
  const facts = [
    { total_count: 509 },
    { totalCount: 509 },
    { "total-count": 509 }
  ].map((payload) => canonicalJsonV2(decoder.decode("styled-inventory/v1", payload)));
  assert.equal(new Set(facts).size, 1);
  assert.throws(() => readAliasedSourceFieldV2({ total_count: 509, totalCount: 510 }, "total_count", ["totalCount"]), (error: unknown) => error instanceof AssignmentKernelErrorV2 && error.code === "semantic_source_field_conflict");
});

test("stale and cross-Assignment events are rejected before changing truth", () => {
  const journal = createJournal();
  for (const foreign of [
    { ...binding, generation: 2 },
    { ...binding, assignment_id: "assignment-2" },
    { ...binding, principal_id: "principal-2" }
  ]) {
    assert.throws(() => journal.append(event(journal, { event_type: "operation_admitted", operation: { ...operation(), binding: foreign } }, foreign)), AssignmentKernelErrorV2);
  }
  assert.equal(journal.events().length, 1);
});

test("journal replay, response-loss reread, and duplicate delivery are deterministic", () => {
  const journal = createJournal();
  const admission = event(journal, { event_type: "operation_admitted", operation: operation() });
  journal.append(admission);
  const afterDuplicate = journal.append(structuredClone(admission));
  assert.equal(journal.events().length, 2);
  assert.equal(afterDuplicate.assignment_version, 2);
  const recovered = new AssignmentJournalV2(journal.events());
  assert.equal(canonicalJsonV2(recovered.snapshot()), canonicalJsonV2(journal.snapshot()));
  assert.throws(() => journal.append({ ...admission, actor: "conflicting-delivery" }), (error: unknown) => error instanceof AssignmentKernelErrorV2 && error.code === "assignment_event_id_conflict");
});

test("out-of-order event versions and terminal resurrection are rejected", () => {
  const journal = createJournal();
  assert.throws(() => journal.append({ ...event(journal, { event_type: "operation_admitted", operation: operation() }), assignment_version: 4 }), (error: unknown) => error instanceof AssignmentKernelErrorV2 && error.code === "assignment_event_out_of_order");
  journal.append(event(journal, { event_type: "operation_admitted", operation: operation() }));
  journal.append(event(journal, { event_type: "native_dispatch_recorded", operation_id: "operation-1" }));
  retainResult(journal, { total: 509 });
  journal.append(event(journal, { event_type: "criterion_evaluated", evaluation: passingEvaluation() }));
  journal.append(event(journal, { event_type: "assignment_terminal", outcome: "complete", reason: "criteria_satisfied" }));
  assert.throws(() => journal.append(event(journal, { event_type: "outcome_derived", outcome: "complete", reason: "again" })), (error: unknown) => error instanceof AssignmentKernelErrorV2 && error.code === "assignment_terminal_immutable");
});

test("criterion fact identity is scoped by Observation rather than a relative selector", () => {
  const left = { observation_id: "observation-left", fact_id: "inventory.total" };
  const right = { observation_id: "observation-right", fact_id: "inventory.total" };
  assert.notEqual(canonicalJsonV2(left), canonicalJsonV2(right));
});

test("the pure criterion evaluator passes required facts and detects contradictions", () => {
  const journal = createJournal();
  journal.append(event(journal, { event_type: "operation_admitted", operation: operation() }));
  journal.append(event(journal, { event_type: "native_dispatch_recorded", operation_id: "operation-1" }));
  retainResult(journal, { total: 509 });
  const snapshot = journal.snapshot();
  const evaluation = evaluateCriterionV2({
    snapshot,
    criterion_id: "criterion-result",
    observation_ids: ["observation-1"],
    evaluator_authority: "deterministic-test",
    evaluated_at: "2026-08-26T12:00:07.000Z"
  });
  assert.equal(evaluation.status, "pass");

  const original = snapshot.observations["observation-1"];
  const conflictingSnapshot = {
    ...snapshot,
    operations: {
      ...snapshot.operations,
      "operation-2": { ...snapshot.operations["operation-1"], operation_id: "operation-2", observation_ids: ["observation-2"] }
    },
    observations: {
      ...snapshot.observations,
      "observation-2": { ...original, observation_id: "observation-2", operation_id: "operation-2", facts: [{ fact_id: "result.total", value: 510 }] }
    }
  };
  const conflicting = evaluateCriterionV2({
    snapshot: conflictingSnapshot,
    criterion_id: "criterion-result",
    observation_ids: ["observation-1", "observation-2"],
    evaluator_authority: "deterministic-test",
    evaluated_at: "2026-08-26T12:00:08.000Z"
  });
  assert.equal(conflicting.status, "uncertain");
});

test("criterion events reject untrusted evaluators and incomplete semantic support", () => {
  const journal = createJournal();
  journal.append(event(journal, { event_type: "operation_admitted", operation: operation() }));
  journal.append(event(journal, { event_type: "native_dispatch_recorded", operation_id: "operation-1" }));
  retainResult(journal, { total: 509 });
  assert.throws(() => journal.append(event(journal, {
    event_type: "criterion_evaluated",
    evaluation: { ...passingEvaluation(), evaluator_authority: "assistant-prose" }
  })), (error: unknown) => error instanceof AssignmentKernelErrorV2 && error.code === "criterion_evaluator_untrusted");
  assert.throws(() => journal.append(event(journal, {
    event_type: "criterion_evaluated",
    evaluation: { ...passingEvaluation(), supporting_facts: [] }
  })), (error: unknown) => error instanceof AssignmentKernelErrorV2 && error.code === "criterion_required_fact_missing");
});

test("apply completion requires a committed native result and task-level criterion support", () => {
  const assignmentSpec: AssignmentSpecV2 = {
    ...spec("apply"),
    work_units: [
      ...spec("apply").work_units,
      { ...spec("read").work_units[0], work_unit_id: "work-verification" }
    ]
  };
  const journal = createJournal(assignmentSpec);
  journal.append(event(journal, { event_type: "operation_admitted", operation: operation("apply") }));
  journal.append(event(journal, { event_type: "native_dispatch_recorded", operation_id: "operation-1", native_correlation_id: "native-apply" }));
  retainResult(journal, { total: 1 }, "apply");
  assert.equal(journal.snapshot().operations["operation-1"].persistent_effect, "applied");
  assert.equal(journal.snapshot().outcome, "active");
  const verification = {
    ...operation("read", "verification"),
    operation_id: "operation-verification",
    work_unit_id: "work-verification",
    verification_of_operation_id: "operation-1"
  };
  journal.append(event(journal, { event_type: "operation_admitted", operation: verification }));
  journal.append(event(journal, { event_type: "native_dispatch_recorded", operation_id: verification.operation_id }));
  const raw = { total: 1 };
  const verificationResult = {
    ...result(raw), result_id: "result-verification", operation_id: verification.operation_id
  };
  journal.append(event(journal, { event_type: "operation_result_recorded", result: verificationResult }));
  const verificationObservation = observationFromOperationResultV2({
    result: verificationResult, expected_binding: binding, observation_id: "observation-verification",
    raw_payload_ref: "evidence://sha256/verification", raw_payload: raw, registry: registry()
  });
  journal.append(event(journal, { event_type: "observation_retained", observation: verificationObservation }));
  const completed = journal.append(event(journal, {
    event_type: "criterion_evaluated",
    evaluation: {
      ...passingEvaluation("execution"),
      supporting_operation_ids: [verification.operation_id],
      supporting_facts: [{ observation_id: verificationObservation.observation_id, fact_id: "result.total" }]
    }
  }));
  assert.equal(completed.outcome, "complete");
  assert.deepEqual(completed.operations["operation-1"].verification_operation_ids, [verification.operation_id]);
});

test("apply timeout settles native work but remains unresolved until target-bound reconciliation", () => {
  const journal = createJournal(spec("apply"));
  journal.append(event(journal, { event_type: "operation_admitted", operation: operation("apply") }));
  journal.append(event(journal, { event_type: "native_dispatch_recorded", operation_id: "operation-1" }));
  const timeout: OperationResultV2 = {
    ...result({}, "apply"),
    result_id: "result-timeout",
    status: "timed_out",
    persistent_effect: "unknown",
    native_transaction_state: "unknown",
    observation_required: false,
    raw_payload_hash: undefined,
    error_code: "native_deadline"
  };
  const timedOut = journal.append(event(journal, { event_type: "operation_result_recorded", result: timeout }));
  assert.equal(timedOut.operations["operation-1"].settlement_state, "settled");
  assert.equal(timedOut.quiescent, true);
  assert.equal(timedOut.outcome, "active");
  assert.deepEqual(timedOut.unresolved_unknown_operation_ids, ["operation-1"]);
});

test("read timeout settles effect none but cannot claim the missing answer", () => {
  const journal = createJournal();
  journal.append(event(journal, { event_type: "operation_admitted", operation: operation() }));
  journal.append(event(journal, { event_type: "native_dispatch_recorded", operation_id: "operation-1" }));
  const timeout: OperationResultV2 = {
    ...result({}, "read"),
    result_id: "result-read-timeout",
    status: "timed_out",
    persistent_effect: "none",
    native_transaction_state: "not_applicable",
    observation_required: false,
    raw_payload_hash: undefined,
    error_code: "native_deadline"
  };
  const settled = journal.append(event(journal, { event_type: "operation_result_recorded", result: timeout }));
  assert.equal(settled.quiescent, true);
  assert.equal(settled.outcome, "active");
});

test("native truth survives observation-retention failure and the operation becomes quiescent without completing", () => {
  const journal = createJournal();
  journal.append(event(journal, { event_type: "operation_admitted", operation: operation() }));
  journal.append(event(journal, { event_type: "operation_dispatch_started", operation_id: "operation-1" }));
  journal.append(event(journal, { event_type: "native_dispatch_recorded", operation_id: "operation-1", native_correlation_id: "native-1" }));
  const nativeResult = result({ total: 509 });
  const retaining = journal.append(event(journal, { event_type: "operation_result_recorded", result: nativeResult }));
  assert.equal(retaining.operations["operation-1"]!.settlement_state, "retaining_observation");
  assert.equal(retaining.quiescent, false);

  const settled = journal.append(event(journal, {
    event_type: "observation_retention_failed",
    operation_id: "operation-1",
    error_code: "evidence_store_unavailable"
  }));
  assert.equal(settled.operations["operation-1"]!.settlement_state, "settled");
  assert.equal(settled.operations["operation-1"]!.observation_retention_error, "evidence_store_unavailable");
  assert.equal(settled.operations["operation-1"]!.result?.receipt_id, "receipt-1");
  assert.equal(settled.quiescent, true);
  assert.equal(Object.keys(settled.observations).length, 0);
  assert.equal(settled.criteria["criterion-result"], undefined);
  assert.equal(settled.outcome, "active");
  assert.equal(settled.terminal, false);
});

test("run supersession fences old events and preserves the same Assignment identity", () => {
  const journal = createJournal(spec("apply", true));
  journal.append(event(journal, { event_type: "input_requested", variable_id: "replacement_text", clarification_id: "clarification-1", question: "What exact replacement text should be used?" }));
  journal.append(event(journal, { event_type: "run_superseded", superseded_by_generation: 2 }));
  assert.throws(() => journal.append(event(journal, { event_type: "input_supplied", variable_id: "replacement_text", clarification_id: "clarification-1", value: "late" })), (error: unknown) => error instanceof AssignmentKernelErrorV2 && error.code === "assignment_run_superseded");
  const nextBinding = { ...binding, run_id: "run-2", generation: 2 };
  journal.append(event(journal, { event_type: "run_started" }, nextBinding));
  const resumed = journal.append(event(journal, { event_type: "input_supplied", variable_id: "replacement_text", clarification_id: "clarification-1", value: "Current wording" }, nextBinding));
  assert.equal(resumed.current_binding.assignment_id, binding.assignment_id);
  assert.equal(resumed.current_binding.generation, 2);
  assert.equal(resumed.input_values.replacement_text, "Current wording");
});

test("verified no-op is derived from authenticated desired-state equivalence, not repeated reads", () => {
  const assignmentSpec: AssignmentSpecV2 = {
    ...spec("apply", true),
    input_variables: [{ variable_id: "replacement_text", value_state: "known", value: "Current wording", required: true, sensitive: false }],
    criteria: [{
      criterion_id: "criterion-result",
      requirement: "Selected note already has the desired wording.",
      required: true,
      semantic_fact_requirements: ["note.text"],
      accepted_evaluator_authority_ids: ["deterministic-test"],
      accepted_observation_authority_ids: ["native-host"],
      desired_state_comparisons: [{ fact_id: "note.text", input_variable_id: "replacement_text", target_id: "target-1" }]
    }],
    work_units: [{ ...spec("read").work_units[0], input_variable_ids: ["replacement_text"] }]
  };
  const journal = createJournal(assignmentSpec);
  journal.append(event(journal, { event_type: "operation_admitted", operation: operation("read", "discovery") }));
  journal.append(event(journal, { event_type: "native_dispatch_recorded", operation_id: "operation-1" }));
  const raw = { text: "Current wording" };
  const nativeResult = { ...result(raw), result_schema_id: "note-result/v1" };
  journal.append(event(journal, { event_type: "operation_result_recorded", result: nativeResult }));
  const decoder = new ObservationDecoderRegistryV2();
  decoder.register("note-result/v1", (payload) => [{ fact_id: "note.text", value: String((payload as { text: string }).text), target_id: "target-1" }]);
  journal.append(event(journal, { event_type: "observation_retained", observation: observationFromOperationResultV2({ result: nativeResult, expected_binding: binding, observation_id: "observation-1", raw_payload_ref: "evidence://sha256/note", raw_payload: raw, registry: decoder }) }));
  const evaluation = evaluateCriterionV2({ snapshot: journal.snapshot(), criterion_id: "criterion-result", observation_ids: ["observation-1"], evaluator_authority: "deterministic-test", evaluated_at: "2026-08-26T12:00:08.000Z", basis: "desired_state_equivalence" });
  assert.equal(evaluation.status, "pass");
  const projected = journal.append(event(journal, { event_type: "criterion_evaluated", evaluation }));
  assert.equal(projected.outcome, "verified_noop");
  assert.equal(Object.values(projected.operations).some((candidate) => candidate.requested_effect === "apply"), false);
});

test("independent completed work remains retained while another work unit needs input", () => {
  const assignmentSpec: AssignmentSpecV2 = {
    ...spec("read", true),
    criteria: [
      { ...spec().criteria[0], criterion_id: "criterion-complete" },
      { ...spec().criteria[0], criterion_id: "criterion-pending" }
    ],
    work_units: [
      { ...spec().work_units[0], work_unit_id: "work-complete", criterion_ids: ["criterion-complete"], input_variable_ids: [] },
      { ...spec().work_units[0], work_unit_id: "work-pending", criterion_ids: ["criterion-pending"], input_variable_ids: ["replacement_text"] }
    ]
  };
  const journal = createJournal(assignmentSpec);
  const completedOperation = {
    ...operation(),
    operation_id: "operation-complete",
    work_unit_id: "work-complete",
    advances_criterion_ids: ["criterion-complete"],
    resolves_gap_ids: ["criterion:criterion-complete"]
  };
  journal.append(event(journal, { event_type: "operation_admitted", operation: completedOperation }));
  journal.append(event(journal, { event_type: "native_dispatch_recorded", operation_id: "operation-complete" }));
  const raw = { total: 1 };
  const completedResult = { ...result(raw), result_id: "result-complete", operation_id: "operation-complete" };
  journal.append(event(journal, { event_type: "operation_result_recorded", result: completedResult }));
  const retainedObservation = observationFromOperationResultV2({ result: completedResult, expected_binding: binding, observation_id: "observation-complete", raw_payload_ref: "evidence://sha256/complete", raw_payload: raw, registry: registry() });
  journal.append(event(journal, { event_type: "observation_retained", observation: retainedObservation }));
  journal.append(event(journal, { event_type: "work_unit_state_changed", work_unit_id: "work-complete", state: "retained", reason: "independently useful" }));
  const evaluation = { ...passingEvaluation(), criterion_id: "criterion-complete", supporting_operation_ids: ["operation-complete"], supporting_facts: [{ observation_id: "observation-complete", fact_id: "result.total" }] };
  const projected = journal.append(event(journal, { event_type: "criterion_evaluated", evaluation }));
  assert.equal(projected.outcome, "awaiting_user_input");
  assert.equal(projected.work_unit_states["work-complete"], "complete");
  assert.equal(projected.operations["operation-complete"].persistent_effect, "none");
});

test("retry admission requires a settled no-effect predecessor and typed material change", () => {
  const journal = createJournal(spec("apply"));
  journal.append(event(journal, { event_type: "operation_admitted", operation: operation("apply") }));
  const rejected: OperationResultV2 = { ...result({}, "apply"), result_id: "result-rejected", status: "failed_before_dispatch", dispatch_state: "not_dispatched", persistent_effect: "none", native_transaction_state: "not_applicable", observation_required: false, raw_payload_hash: undefined };
  journal.append(event(journal, { event_type: "operation_result_recorded", result: rejected }));
  const retry = { ...operation("apply"), operation_id: "operation-2", retry_of_operation_id: "operation-1" };
  assert.throws(() => journal.append(event(journal, { event_type: "operation_admitted", operation: retry })), (error: unknown) => error instanceof AssignmentKernelErrorV2 && error.code === "operation_retry_basis_missing");
  const accepted = journal.append(event(journal, { event_type: "operation_admitted", operation: { ...retry, retry_basis: "corrected_admission" } }));
  assert.equal(accepted.operations["operation-2"].retry_of_operation_id, "operation-1");
});
