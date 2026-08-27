import assert from "node:assert/strict";
import test from "node:test";
import {
  ASSIGNMENT_EVENT_V2_SCHEMA,
  ASSIGNMENT_SPEC_V2_SCHEMA,
  OBSERVATION_V2_SCHEMA,
  PAYLOAD_PROVENANCE_V2_SCHEMA,
  PROGRESS_DECISION_V2_SCHEMA,
  PROGRESS_EPOCH_V2_SCHEMA,
  PROGRESS_REPLAY_V2_SCHEMA,
  replayProviderProgressV2,
  semanticFactIdentityV2,
  normalizeSemanticFactSetV2,
  type AssignmentBindingV2,
  type AssignmentEventV2,
  type AssignmentSpecV2,
  type ObservationV2,
  type OperationV2
} from "../src/domain/assignment-kernel/index.js";
import { payloadProvenanceFromJsonV2 } from "../src/execution_truth/assignment_kernel_v2_payload_provenance.js";

const binding: AssignmentBindingV2 = {
  assignment_id: "assignment-liveness",
  run_id: "run-liveness",
  generation: 1,
  session_id: "session-liveness",
  principal_id: "principal-liveness",
  document_fingerprint: "document-liveness"
};

const spec: AssignmentSpecV2 = {
  schema: ASSIGNMENT_SPEC_V2_SCHEMA,
  binding,
  source_user_request: "Return a grouped inventory.",
  requested_effect: "read",
  criteria: [{
    criterion_id: "criterion-inventory",
    requirement: "A grouped inventory is authoritatively available.",
    required: true,
    semantic_fact_requirements: ["inventory.total", "inventory.group"],
    accepted_evaluator_authority_ids: ["deterministic-controller"],
    accepted_observation_authority_ids: ["native-host"]
  }],
  input_variables: [],
  work_units: [{
    work_unit_id: "work-inventory",
    requested_effect: "read",
    execution_class: "analysis",
    dependency_ids: [],
    criterion_ids: ["criterion-inventory"],
    input_variable_ids: [],
    independently_useful: true,
    safe_to_retain: true,
    rollback_scope: "none"
  }],
  authorization_policy_id: "policy",
  created_at: "2026-08-26T20:00:00.000Z"
};

function envelope(version: number, body: Record<string, unknown>): AssignmentEventV2 {
  return {
    schema: ASSIGNMENT_EVENT_V2_SCHEMA,
    event_id: `event-${version}`,
    assignment_id: binding.assignment_id,
    assignment_version: version,
    binding,
    occurred_at: `2026-08-26T20:00:${String(version).padStart(2, "0")}.000Z`,
    actor: "test",
    ...body
  } as AssignmentEventV2;
}

function operation(): OperationV2 {
  return {
    schema: "revit-operator.operation/v2",
    operation_id: "operation-inventory",
    binding,
    work_unit_id: "work-inventory",
    capability_id: "inventory.read",
    requested_effect: "read",
    purpose: "work",
    advances_criterion_ids: ["criterion-inventory"],
    resolves_gap_ids: ["gap-inventory"],
    target: { document_fingerprint: binding.document_fingerprint },
    input: {},
    admission_state: "admitted",
    dispatch_state: "not_dispatched",
    persistent_effect: "none",
    settlement_state: "open",
    observation_ids: [],
    verification_operation_ids: [],
    opened_at: "2026-08-26T20:00:03.000Z",
    deadline_at: "2026-08-26T20:01:03.000Z"
  };
}

function observation(): ObservationV2 {
  return {
    schema: OBSERVATION_V2_SCHEMA,
    observation_id: "observation-inventory",
    operation_id: "operation-inventory",
    binding,
    authority: "native-host",
    result_schema_id: "inventory/v1",
    raw_payload_ref: "evidence://inventory",
    raw_payload_hash: "hash-inventory",
    facts: [
      { fact_id: "inventory.total", value: 3, cardinality: "one" },
      { fact_id: "inventory.group", value: 2, cardinality: "many", identity_dimensions: ["family", "type"], dimensions: { family: "Family A", type: "Type A" } },
      { fact_id: "inventory.group", value: 1, cardinality: "many", identity_dimensions: ["family", "type"], dimensions: { family: "Family B", type: "Type B" } }
    ],
    target_scope: {},
    observed_at: "2026-08-26T20:00:06.000Z",
    verification_relevance: ["task_result"]
  };
}

test("progress and provenance contracts have independent versioned schemas", () => {
  assert.equal(PROGRESS_DECISION_V2_SCHEMA, "revit-operator.assignment-progress-decision/v2");
  assert.equal(PROGRESS_EPOCH_V2_SCHEMA, "revit-operator.assignment-progress-epoch/v2");
  assert.equal(PROGRESS_REPLAY_V2_SCHEMA, "revit-operator.assignment-progress-replay/v2");
  assert.equal(PAYLOAD_PROVENANCE_V2_SCHEMA, "revit-operator.payload-provenance/v2");
});

test("semantic fact cardinality many preserves dimensional members and removes only exact duplicates", () => {
  const facts = observation().facts;
  const normalized = normalizeSemanticFactSetV2([...facts, structuredClone(facts[1])]);
  assert.equal(normalized.length, 3);
  const groups = normalized.filter((fact) => fact.fact_id === "inventory.group");
  assert.equal(groups.length, 2);
  assert.notEqual(semanticFactIdentityV2(groups[0]), semanticFactIdentityV2(groups[1]));
});

test("singular fact identity remains stable so contradictory values can be evaluated as uncertainty", () => {
  assert.equal(
    semanticFactIdentityV2({ fact_id: "inventory.total", value: 3 }),
    semanticFactIdentityV2({ fact_id: "inventory.total", value: 4 })
  );
});

test("payload provenance distinguishes native JSON bytes from normalized canonical JSON", () => {
  const left = payloadProvenanceFromJsonV2({
    source_json_bytes: Buffer.from('{"total":3,"groups":[1,2]}', "utf8"),
    normalized_payload: { groups: [1, 2], total: 3 },
    transformation_id: "native-json-normalization",
    transformation_version: "1"
  });
  const right = payloadProvenanceFromJsonV2({
    source_json_bytes: Buffer.from('{ "groups" : [1,2], "total" : 3 }', "utf8"),
    normalized_payload: { total: 3, groups: [1, 2] },
    transformation_id: "native-json-normalization",
    transformation_version: "1"
  });
  assert.notEqual(left.source.digest, right.source.digest);
  assert.equal(left.normalized.digest, right.normalized.digest);
  assert.equal(left.transformation_id, right.transformation_id);
});

test("historical replay exposes absent provider justification and missing criterion evaluation", () => {
  const events: AssignmentEventV2[] = [
    envelope(1, { event_type: "assignment_created", spec }),
    envelope(2, { event_type: "provider_call_recorded", call_id: "call-1", provider: "openai", model: "model", reasoning_effort: "medium", success: true }),
    envelope(3, { event_type: "operation_admitted", operation: operation() }),
    envelope(4, { event_type: "observation_retained", observation: observation() }),
    envelope(5, { event_type: "provider_call_recorded", call_id: "call-2", provider: "openai", model: "model", reasoning_effort: "medium", success: true })
  ];
  const replay = replayProviderProgressV2({ events, provider_receipts: [{ call_id: "call-1", total_tokens: 100 }] });
  assert.equal(replay.provider_calls.length, 2);
  assert.equal(replay.provider_calls[0].justification.status, "absent_from_historical_journal");
  assert.deepEqual(replay.provider_calls[0].actual_information.semantic_fact_ids, ["inventory.group", "inventory.total"]);
  assert.equal(replay.provider_calls[0].actual_information.semantic_facts.length, 3);
  assert.equal(replay.provider_calls[0].operations[0].input && typeof replay.provider_calls[0].operations[0].input, "object");
  assert.deepEqual(replay.provider_calls[0].affected_criterion_ids, ["criterion-inventory"]);
  assert.equal(replay.provider_calls[0].missing_evaluation_reason, "evaluation_not_recorded_before_next_provider_call");
  assert.equal(replay.provider_calls[0].next_provider_call_admission?.justified_by_historical_journal, false);
});
