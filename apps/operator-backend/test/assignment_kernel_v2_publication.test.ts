import assert from "node:assert/strict";
import test from "node:test";
import {
  ASSIGNMENT_EVENT_V2_SCHEMA,
  ASSIGNMENT_SPEC_V2_SCHEMA,
  PROVIDER_CALL_V2_SCHEMA,
  AssignmentJournalV2,
  type AssignmentBindingV2,
  type AssignmentEventV2,
  type AssignmentSpecV2
} from "../src/domain/assignment-kernel/index.js";
import {
  ASSIGNMENT_KERNEL_PUBLICATION_V2_SCHEMA,
  ASSIGNMENT_PROVIDER_LEDGER_V2_SCHEMA,
  buildAssignmentKernelPublicationV2
} from "../src/assignments/assignment_kernel_v2_publication.js";

const binding: AssignmentBindingV2 = {
  assignment_id: "assignment-publication",
  run_id: "run-publication",
  generation: 1,
  session_id: "session-publication",
  principal_id: "principal-publication"
};

const spec: AssignmentSpecV2 = {
  schema: ASSIGNMENT_SPEC_V2_SCHEMA,
  binding,
  source_user_request: "Return an authoritative inventory.",
  requested_effect: "read",
  criteria: [{
    criterion_id: "criterion-inventory",
    requirement: "Inventory is returned.",
    required: true,
    semantic_fact_requirements: ["inventory.total"],
    accepted_evaluator_authority_ids: ["deterministic-controller"],
    accepted_observation_authority_ids: ["native-host"]
  }],
  input_variables: [],
  work_units: [{
    work_unit_id: "work-primary",
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
  created_at: "2026-08-27T12:00:00.000Z"
};

function event(version: number, body: Record<string, unknown>): AssignmentEventV2 {
  return {
    schema: ASSIGNMENT_EVENT_V2_SCHEMA,
    event_id: `event-${version}`,
    assignment_id: binding.assignment_id,
    assignment_version: version,
    binding,
    occurred_at: `2026-08-27T12:00:0${version}.000Z`,
    actor: "test",
    ...body
  } as AssignmentEventV2;
}

test("V2 publication retains the canonical provider ledger after downstream chat transport loss", () => {
  const journal = new AssignmentJournalV2();
  journal.append(event(1, { event_type: "assignment_created", spec }));
  journal.append(event(2, {
    event_type: "provider_call_receipt_recorded",
    call: {
      schema: PROVIDER_CALL_V2_SCHEMA,
      call_id: "provider-call-1",
      binding,
      state: "completed",
      provider: "openai",
      model: "gpt-5.6-sol",
      reasoning_effort: "medium",
      gap_ids: ["criterion:criterion-inventory"],
      criterion_ids: ["criterion-inventory"],
      expected_information: ["inventory.total"],
      admitted_at: "2026-08-27T12:00:01.000Z",
      dispatched_at: "2026-08-27T12:00:01.100Z",
      response_started_at: "2026-08-27T12:00:02.000Z",
      usage_received_at: "2026-08-27T12:00:02.100Z",
      completed_at: "2026-08-27T12:00:02.200Z",
      usage: { input_tokens: 100, output_tokens: 25, reasoning_tokens: 50, total_tokens: 175 },
      success: true
    }
  }));
  const publication = buildAssignmentKernelPublicationV2(journal.snapshot());
  assert.equal(publication.schema, ASSIGNMENT_KERNEL_PUBLICATION_V2_SCHEMA);
  assert.equal(publication.provider_ledger.schema, ASSIGNMENT_PROVIDER_LEDGER_V2_SCHEMA);
  assert.deepEqual(publication.provider_ledger.call_ids, ["provider-call-1"]);
  assert.equal(publication.provider_ledger.calls["provider-call-1"]?.usage?.total_tokens, 175);
  assert.equal(publication.provider_ledger.calls["provider-call-1"]?.response_transport_completed_at, undefined);
  assert.deepEqual(publication.provider_ledger.in_flight_call_ids, []);
});
