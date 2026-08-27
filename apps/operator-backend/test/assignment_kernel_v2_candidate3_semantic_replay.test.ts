import assert from "node:assert/strict";
import test from "node:test";
import {
  ASSIGNMENT_EVENT_V2_SCHEMA,
  ASSIGNMENT_SPEC_V2_SCHEMA,
  OBSERVATION_V2_SCHEMA,
  OPERATION_RESULT_V2_SCHEMA,
  OPERATION_V2_SCHEMA,
  AssignmentJournalV2,
  evaluateCriterionV2,
  type AssignmentBindingV2,
  type AssignmentEventV2,
  type AssignmentSpecV2,
  type ObservationV2,
  type OperationResultV2,
  type OperationV2
} from "../src/domain/assignment-kernel/index.js";

// Sanitized, identity-bound replay of Candidate 3 Assignment
// b459ca20-cc2d-424d-a6c5-da222302c0ad. Payload values are reduced to the
// semantic facts that caused the canonical false-completion transition.
const binding: AssignmentBindingV2 = {
  assignment_id: "b459ca20-cc2d-424d-a6c5-da222302c0ad",
  run_id: "epic0458-candidate3-q01-flight-1-20260827T214009199Z-sol-medium",
  generation: 1,
  session_id: "candidate3-semantic-replay",
  principal_id: "candidate3-sanitized-principal",
  document_fingerprint: "candidate3-sanitized-fixture"
};

const criterionId = "criterion-bcd7a9ecadf186542ce5";
const quantifyRootId = "opv2_5e738f1e8842d842a02c86635b8aa77a6b7ee63f8b517d5b7f868612c122e883";
const registryChildId = "opv2_deb7b63895cb600f221384972d0b025f98482d592c5fb71eee0003e57c1c34ea";
const toolDocRootId = "opv2_b1178dc4654d5fa95800e9f3b13f692a0592820956646c5fdf6cb30222996017";
const toolDocChildId = "opv2_391e6890f11b6b8d91ec2bd0d2d6bfe73b3b0a6274b2a9e81e1b5c832bab56d0";

const spec: AssignmentSpecV2 = {
  schema: ASSIGNMENT_SPEC_V2_SCHEMA,
  binding,
  source_user_request: "Return a grouped inventory of air terminals by family and type.",
  requested_effect: "read",
  criteria: [{
    criterion_id: criterionId,
    requirement: "The requested grouped Revit inventory result is available.",
    required: true,
    semantic_fact_requirements: ["result.available"],
    accepted_evaluator_authority_ids: ["operator-runtime"],
    accepted_observation_authority_ids: ["native-host"]
  }],
  input_variables: [],
  work_units: [{
    work_unit_id: "work-primary",
    requested_effect: "read",
    execution_class: "analysis",
    dependency_ids: [],
    criterion_ids: [criterionId],
    input_variable_ids: [],
    independently_useful: true,
    safe_to_retain: true,
    rollback_scope: "none"
  }],
  authorization_policy_id: "operator-default",
  created_at: "2026-08-27T21:40:09.199Z"
};

function operation(input: Readonly<{
  operation_id: string;
  capability_id: string;
  purpose: OperationV2["purpose"];
  role: NonNullable<OperationV2["operation_role"]>;
  parent_operation_id?: string;
  root_operation_id?: string;
  advances_criterion_ids?: readonly string[];
  resolves_gap_ids?: readonly string[];
}>): OperationV2 {
  return {
    schema: OPERATION_V2_SCHEMA,
    operation_id: input.operation_id,
    binding,
    work_unit_id: "work-primary",
    capability_id: input.capability_id,
    requested_effect: "read",
    purpose: input.purpose,
    operation_role: input.role,
    ...(input.parent_operation_id ? { parent_operation_id: input.parent_operation_id } : {}),
    ...(input.root_operation_id ? { root_operation_id: input.root_operation_id } : {}),
    ...(input.role === "root" ? {} : { blocks_parent_settlement: true }),
    advances_criterion_ids: input.advances_criterion_ids ?? [],
    resolves_gap_ids: input.resolves_gap_ids ?? [],
    target: { document_fingerprint: binding.document_fingerprint },
    input: {},
    admission_state: "admitted",
    dispatch_state: "not_dispatched",
    persistent_effect: "none",
    settlement_state: "open",
    observation_ids: [],
    verification_operation_ids: [],
    opened_at: "2026-08-27T21:42:00.000Z",
    deadline_at: "2026-08-27T21:46:00.000Z"
  };
}

function result(input: Readonly<{
  operation_id: string;
  result_id: string;
  result_schema_id: string;
  status: OperationResultV2["status"];
  dispatch_state: OperationResultV2["dispatch_state"];
  observation_required: boolean;
  authority: string;
  hash?: string;
  error_code?: string;
}>): OperationResultV2 {
  return {
    schema: OPERATION_RESULT_V2_SCHEMA,
    result_id: input.result_id,
    operation_id: input.operation_id,
    binding,
    status: input.status,
    dispatch_state: input.dispatch_state,
    persistent_effect: "none",
    native_transaction_state: "not_applicable",
    authority: input.authority,
    result_schema_id: input.result_schema_id,
    observation_required: input.observation_required,
    ...(input.hash ? { raw_payload_hash: input.hash } : {}),
    ...(input.error_code ? { error_code: input.error_code } : {}),
    completed_at: "2026-08-27T21:43:00.000Z"
  };
}

function observation(input: Readonly<{
  observation_id: string;
  operation_id: string;
  result_schema_id: string;
  hash: string;
  facts: ObservationV2["facts"];
}>): ObservationV2 {
  return {
    schema: OBSERVATION_V2_SCHEMA,
    observation_id: input.observation_id,
    operation_id: input.operation_id,
    binding,
    authority: "native-host",
    result_schema_id: input.result_schema_id,
    raw_payload_ref: `evidence://candidate3/${input.observation_id}`,
    raw_payload_hash: input.hash,
    facts: input.facts,
    target_scope: {},
    observed_at: "2026-08-27T21:43:00.000Z",
    verification_relevance: ["task_result"]
  };
}

test("Candidate 3 support evidence cannot false-complete the inventory criterion", () => {
  const journal = new AssignmentJournalV2();
  let version = 0;
  const append = (body: Record<string, unknown>): void => {
    version += 1;
    journal.append({
      schema: ASSIGNMENT_EVENT_V2_SCHEMA,
      event_id: `candidate3-event-${version}`,
      assignment_id: binding.assignment_id,
      assignment_version: version,
      binding,
      occurred_at: `2026-08-27T21:42:${String(version).padStart(2, "0")}.000Z`,
      actor: "candidate3-replay",
      ...body
    } as AssignmentEventV2);
  };

  append({ event_type: "assignment_created", spec });
  append({ event_type: "operation_admitted", operation: operation({
    operation_id: quantifyRootId,
    capability_id: "revit_call_tool",
    purpose: "work",
    role: "root",
    advances_criterion_ids: [criterionId],
    resolves_gap_ids: [`criterion:${criterionId}`]
  }) });
  append({ event_type: "operation_admitted", operation: operation({
    operation_id: registryChildId,
    capability_id: "native:GET:/revit/tool-registry",
    purpose: "discovery",
    role: "prerequisite",
    parent_operation_id: quantifyRootId,
    root_operation_id: quantifyRootId
  }) });
  append({ event_type: "native_dispatch_recorded", operation_id: registryChildId, native_correlation_id: "candidate3-registry" });
  const registryHash = "candidate3-registry-normalized-digest";
  append({ event_type: "operation_result_recorded", result: result({
    operation_id: registryChildId,
    result_id: "candidate3-registry-result",
    result_schema_id: "operator-native/GET:/revit/tool-registry/v2",
    status: "succeeded",
    dispatch_state: "dispatched",
    observation_required: true,
    authority: "native-host",
    hash: registryHash
  }) });
  append({ event_type: "observation_retained", observation: observation({
    observation_id: "obsv2_68bbc16f42044c614b83dac2017309f616a7dbb2921e527d15164c30b8790b8a",
    operation_id: registryChildId,
    result_schema_id: "operator-native/GET:/revit/tool-registry/v2",
    hash: registryHash,
    facts: [{ fact_id: "result.available", value: true }, { fact_id: "result.field.version", value: "2" }]
  }) });
  append({ event_type: "operation_result_recorded", result: result({
    operation_id: quantifyRootId,
    result_id: "candidate3-quantify-invalid-result",
    result_schema_id: "operator-capability/revit_call_tool/v2",
    status: "failed_before_dispatch",
    dispatch_state: "not_dispatched",
    observation_required: false,
    authority: "operator-mcp",
    error_code: "mcp_tool_failed"
  }) });

  append({ event_type: "operation_admitted", operation: operation({
    operation_id: toolDocRootId,
    capability_id: "revit_tool_doc",
    purpose: "discovery",
    role: "root",
    advances_criterion_ids: [criterionId],
    resolves_gap_ids: [`criterion:${criterionId}`]
  }) });
  append({ event_type: "operation_dispatch_started", operation_id: toolDocRootId });
  append({ event_type: "operation_admitted", operation: operation({
    operation_id: toolDocChildId,
    capability_id: "native:POST:/revit/tool-doc",
    purpose: "work",
    role: "child",
    parent_operation_id: toolDocRootId,
    root_operation_id: toolDocRootId,
    advances_criterion_ids: [criterionId],
    resolves_gap_ids: [`criterion:${criterionId}`]
  }) });
  append({ event_type: "native_dispatch_recorded", operation_id: toolDocChildId, native_correlation_id: "candidate3-tool-doc" });
  const toolDocHash = "candidate3-tool-doc-normalized-digest";
  append({ event_type: "operation_result_recorded", result: result({
    operation_id: toolDocChildId,
    result_id: "candidate3-tool-doc-result",
    result_schema_id: "operator-native/POST:/revit/tool-doc/v2",
    status: "succeeded",
    dispatch_state: "dispatched",
    observation_required: true,
    authority: "native-host",
    hash: toolDocHash
  }) });
  const toolDocObservation = observation({
    observation_id: "obsv2_39286c1852a7dddf4085582fe62ac7feeaf6f2b2f4f8436e91ba653780310231",
    operation_id: toolDocChildId,
    result_schema_id: "operator-native/POST:/revit/tool-doc/v2",
    hash: toolDocHash,
    facts: [
      { fact_id: "result.available", value: true },
      { fact_id: "result.field.path", value: "/revit/quantify" },
      { fact_id: "result.field.method", value: "POST" }
    ]
  });
  append({ event_type: "observation_retained", observation: toolDocObservation });
  append({ event_type: "operation_result_recorded", result: result({
    operation_id: toolDocRootId,
    result_id: "candidate3-tool-doc-root-result",
    result_schema_id: "operation-transport-failure/v2",
    status: "failed_after_dispatch",
    dispatch_state: "dispatching",
    observation_required: false,
    authority: "operator-mcp",
    error_code: "operation_result_invalid"
  }) });

  const evaluation = evaluateCriterionV2({
    snapshot: journal.snapshot(),
    criterion_id: criterionId,
    observation_ids: [toolDocObservation.observation_id],
    evaluator_authority: "operator-runtime",
    evaluated_at: "2026-08-27T21:43:07.000Z"
  });
  append({ event_type: "criterion_evaluated", evaluation });
  if (journal.snapshot().outcome === "complete") {
    append({ event_type: "assignment_terminal", outcome: "complete", reason: "criteria_satisfied" });
  }

  const replay = journal.snapshot();
  assert.notEqual(evaluation.status, "pass", "tool-documentation control facts must not pass the inventory criterion");
  assert.equal(replay.terminal, false, "the Assignment must remain incomplete because quantify never dispatched");
});
