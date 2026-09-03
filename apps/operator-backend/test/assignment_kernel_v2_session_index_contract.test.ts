import assert from "node:assert/strict";
import test from "node:test";
import {
  ASSIGNMENT_KERNEL_V2_CONTROL_CAPABILITY_IDS,
  ASSIGNMENT_KERNEL_V2_DURABLE_CONTROL_EVIDENCE_PRODUCER_IDS,
  ASSIGNMENT_KERNEL_RUNTIME_ATTESTATION_V2_SCHEMA,
  ASSIGNMENT_KERNEL_V2_SESSION_INDEX_FIELD,
  ASSIGNMENT_KERNEL_V2_SESSION_INDEX_RESPONSE_SCHEMA,
  ASSIGNMENT_KERNEL_PUBLICATION_V2_SCHEMA,
  ASSIGNMENT_PROVIDER_LEDGER_V2_SCHEMA,
  ASSIGNMENT_SNAPSHOT_V2_SCHEMA,
  assignmentKernelControlEvidenceFactsV2,
  assignmentKernelRuntimeAttestationV2,
  assignmentKernelSessionIndexResponseV2,
  isAssignmentKernelControlCapabilityV2,
  isAssignmentKernelDurableControlEvidenceProducerV2,
  parseAssignmentKernelPublicationV2,
  parseAssignmentKernelRuntimeAttestationV2,
  parseAssignmentKernelSessionIndexResponseV2
} from "@revitoperator/assignment-kernel-v2-contracts";
import { loadAssignmentKernelPublicationsV2 } from "../src/benchmark/assignment_kernel_v2_collection.js";

const index = {
  schema: "revit-operator.assignment-kernel-session-index/v2" as const,
  session_id: "session-v2",
  assignments: [{
    assignment_id: "assignment-v2",
    assignment_version: 29,
    binding: {
      assignment_id: "assignment-v2",
      run_id: "run-v2",
      generation: 1,
      session_id: "session-v2",
      principal_id: "principal-v2"
    },
    outcome: "complete",
    terminal: true
  }]
};

test("shared runtime attestation binds lifecycle, progression, publication, ledger, and evidence policy", () => {
  const enabled = assignmentKernelRuntimeAttestationV2(true);
  assert.equal(enabled.schema, ASSIGNMENT_KERNEL_RUNTIME_ATTESTATION_V2_SCHEMA);
  assert.equal(enabled.assignment_kernel_v2_enabled, true);
  assert.equal(enabled.lifecycle_owner, "assignment_kernel_v2");
  assert.equal(enabled.progress_owner, "deterministic_progress_controller_v2");
  assert.deepEqual(parseAssignmentKernelRuntimeAttestationV2(JSON.parse(JSON.stringify(enabled))), enabled);

  const disabled = assignmentKernelRuntimeAttestationV2(false);
  assert.equal(disabled.assignment_kernel_v2_enabled, false);
  assert.equal(disabled.lifecycle_owner, "legacy_goal_v1");
  assert.equal(disabled.exact_publication_schema, null);
  assert.deepEqual(parseAssignmentKernelRuntimeAttestationV2(disabled), disabled);

  assert.throws(() => parseAssignmentKernelRuntimeAttestationV2({
    ...enabled,
    lifecycle_owner: "legacy_goal_v1"
  }), /assignment_kernel_v2_runtime_attestation_invalid:coherence/);
  assert.throws(() => parseAssignmentKernelRuntimeAttestationV2({
    ...enabled,
    unreviewed_runtime_claim: true
  }), /assignment_kernel_v2_runtime_attestation_invalid:fields/);
});

function exactPublication(callIds: readonly string[]) {
  const calls = Object.fromEntries(callIds.map(callId => [callId, {
    schema: "revit-operator.provider-call/v2",
    call_id: callId,
    binding: index.assignments[0]!.binding,
    state: "completed",
    provider: "openai",
    model: "test-model",
    reasoning_effort: "medium",
    gap_ids: [],
    criterion_ids: [],
    expected_information: [],
    admitted_at: "2026-09-02T00:00:00.000Z",
    completed_at: "2026-09-02T00:00:01.000Z",
    success: true
  }]));
  return {
    schema: ASSIGNMENT_KERNEL_PUBLICATION_V2_SCHEMA,
    assignment_id: "assignment-v2",
    assignment_version: 29,
    snapshot: {
      schema: ASSIGNMENT_SNAPSHOT_V2_SCHEMA,
      assignment_version: 29,
      current_binding: index.assignments[0]!.binding,
      provider_call_ids: [...callIds],
      provider_calls: calls,
      in_flight_provider_call_ids: []
    },
    provider_ledger: {
      schema: ASSIGNMENT_PROVIDER_LEDGER_V2_SCHEMA,
      assignment_id: "assignment-v2",
      run_id: "run-v2",
      generation: 1,
      call_ids: [...callIds],
      calls,
      in_flight_call_ids: []
    }
  };
}

test("shared V2 session-index response is the only new producer/consumer contract", async () => {
  const response = assignmentKernelSessionIndexResponseV2(index);
  assert.equal(response.schema, ASSIGNMENT_KERNEL_V2_SESSION_INDEX_RESPONSE_SCHEMA);
  assert.deepEqual(parseAssignmentKernelSessionIndexResponseV2(response)[ASSIGNMENT_KERNEL_V2_SESSION_INDEX_FIELD], index);

  const publication = exactPublication(["call-1", "call-2", "call-3"]);
  const collected = await loadAssignmentKernelPublicationsV2("http://operator", "session-v2", async (_base, pathname) =>
    pathname.startsWith("/api/assignments/v2?")
      ? response as unknown as Record<string, unknown>
      : { ok: true, assignment_kernel_v2: publication });
  assert.deepEqual(collected.assignment_ids, ["assignment-v2"]);
  assert.equal((collected.assignments as unknown[]).length, 1);
  assert.deepEqual((collected.session_index as typeof index).assignments, index.assignments);
});

test("V2 publication collection recovers transient session-index and exact-publication fetch failures without replaying work", async () => {
  const response = assignmentKernelSessionIndexResponseV2(index);
  const publication = exactPublication(["call-1"]);
  let indexAttempts = 0;
  let publicationAttempts = 0;
  const collected = await loadAssignmentKernelPublicationsV2(
    "http://operator",
    "session-v2",
    async (_base, pathname) => {
      if (pathname.startsWith("/api/assignments/v2?")) {
        indexAttempts += 1;
        if (indexAttempts === 1) throw new Error("fetch failed");
        return response as unknown as Record<string, unknown>;
      }
      publicationAttempts += 1;
      if (publicationAttempts === 1) throw new Error("fetch failed");
      return { ok: true, assignment_kernel_v2: publication };
    },
    { attempts: 3, retryDelayMs: 0 }
  );

  assert.equal(indexAttempts, 2);
  assert.equal(publicationAttempts, 2);
  assert.deepEqual(collected.assignment_ids, ["assignment-v2"]);
  assert.deepEqual(collected.failures, []);
  assert.deepEqual(collected.assignments, [publication]);
});

test("exact V2 publication contract survives JSON transport and rejects provider-ledger drift", () => {
  const publication = exactPublication(["call-1", "call-2", "call-3"]);
  assert.deepEqual(parseAssignmentKernelPublicationV2(JSON.parse(JSON.stringify(publication))), publication);
  assert.throws(() => parseAssignmentKernelPublicationV2({
    ...publication,
    provider_ledger: { ...publication.provider_ledger, run_id: "another-run" }
  }), /assignment_kernel_v2_publication_invalid:provider_ledger_binding/);
  assert.throws(() => parseAssignmentKernelPublicationV2({
    ...publication,
    snapshot: { ...publication.snapshot, provider_call_ids: ["call-1", "call-2"] }
  }), /assignment_kernel_v2_publication_invalid:provider_ledger_index/);
  assert.throws(() => parseAssignmentKernelPublicationV2({
    ...publication,
    provider_ledger: {
      ...publication.provider_ledger,
      calls: {
        ...publication.provider_ledger.calls,
        "call-1": { ...publication.provider_ledger.calls["call-1"], model: "drifted-model" }
      }
    }
  }), /assignment_kernel_v2_publication_invalid:provider_call_projection/);
  const foreignCall = {
    ...publication.provider_ledger.calls["call-1"],
    binding: { ...index.assignments[0]!.binding, run_id: "foreign-run" }
  };
  assert.throws(() => parseAssignmentKernelPublicationV2({
    ...publication,
    snapshot: {
      ...publication.snapshot,
      provider_calls: { ...publication.snapshot.provider_calls, "call-1": foreignCall }
    },
    provider_ledger: {
      ...publication.provider_ledger,
      calls: { ...publication.provider_ledger.calls, "call-1": foreignCall }
    }
  }), /assignment_kernel_v2_publication_invalid:provider_call_binding/);
  assert.throws(() => parseAssignmentKernelPublicationV2({
    ...publication,
    snapshot: { ...publication.snapshot, in_flight_provider_call_ids: ["call-1"] },
    provider_ledger: { ...publication.provider_ledger, in_flight_call_ids: ["call-1"] }
  }), /assignment_kernel_v2_publication_invalid:provider_call_state/);
});

test("historical or malformed session-index aliases fail explicitly for new V2 traffic", () => {
  assert.throws(() => parseAssignmentKernelSessionIndexResponseV2({
    ok: true,
    assignment_kernel_v2_index: index
  }), /assignment_kernel_v2_session_index_invalid:response_schema/);
  assert.throws(() => parseAssignmentKernelSessionIndexResponseV2({
    schema: ASSIGNMENT_KERNEL_V2_SESSION_INDEX_RESPONSE_SCHEMA,
    ok: true,
    assignment_kernel_v2_session_index: { ...index, schema: "revit-operator.assignment-kernel-v2-index/v1" }
  }), /assignment_kernel_v2_session_index_invalid:schema/);
});

test("shared control-evidence contract separates control roles, durable producers, and bounded semantic facts", () => {
  assert.ok(ASSIGNMENT_KERNEL_V2_CONTROL_CAPABILITY_IDS.includes("operator_record_execution_strategy"));
  assert.equal(isAssignmentKernelControlCapabilityV2("operator_record_execution_strategy"), true);
  assert.equal(isAssignmentKernelDurableControlEvidenceProducerV2("operator_record_execution_strategy"), false,
    "provider-authored strategy prose must not become authoritative result evidence");
  assert.ok(ASSIGNMENT_KERNEL_V2_DURABLE_CONTROL_EVIDENCE_PRODUCER_IDS.includes("operator_discover_capabilities"));
  assert.equal(isAssignmentKernelDurableControlEvidenceProducerV2("revit_search_tools"), true);

  const semanticPayload = {
    status: "available",
    matches: [
      { title: "Replace", path: "/revit/replace-text-note", method: "post" },
      { method: "GET", path: "/revit/find-text-notes" },
      { method: "DELETE", path: "/revit/unsafe" },
      { method: "GET", path: "https://example.invalid/not-revit" },
      { id: "dynamic_revit_program" },
      { method: "GET", path: "/revit/find-text-notes" }
    ]
  };
  const facts = assignmentKernelControlEvidenceFactsV2("revit_search_tools", semanticPayload);
  assert.equal(facts.every(fact => fact.fact_class === "control"), true);
  assert.equal(facts.some(fact => fact.fact_id.startsWith("task.") || fact.fact_id.startsWith("inventory.")), false);
  assert.deepEqual(facts.filter(fact => fact.fact_id === "control.capability_available").map(fact => fact.dimensions), [
    { capability_id: "revit_search_tools", discovered_capability_id: "dynamic_revit_program" },
    { capability_id: "revit_search_tools", method: "GET", path: "/revit/find-text-notes" },
    { capability_id: "revit_search_tools", method: "POST", path: "/revit/replace-text-note" }
  ]);
  assert.deepEqual(
    assignmentKernelControlEvidenceFactsV2("revit_search_tools", JSON.parse(JSON.stringify(semanticPayload))),
    facts,
    "JSON transport must not change controller knowledge identity"
  );
  assert.deepEqual(assignmentKernelControlEvidenceFactsV2("untrusted_tool", semanticPayload), []);
});

test("Candidate 55 focused evidence selections create stable controller knowledge without domain authority", () => {
  const payload = {
    ok: true,
    result: {
      schema: "revit-operator.evidence-retrieval.v1",
      evidence_ref: { evidence_id: "ev1_BE1x2Z1tkNa3F6VVtnPi_cEvu7lCs-MG" },
      selection: {
        "payload.items": [{ elementId: 1421361, text: "Existing note" }],
        "payload.elementIds": [1421361],
        "payload.textSamples": ["Existing note"]
      },
      returned_bytes: 733,
      complete: false
    }
  };
  const facts = assignmentKernelControlEvidenceFactsV2("operator_retrieve_evidence", payload);
  assert.equal(isAssignmentKernelDurableControlEvidenceProducerV2("operator_retrieve_evidence"), true);
  assert.equal(facts.every(fact => fact.fact_class === "control"), true);
  assert.deepEqual(
    facts.filter(fact => String(fact.fact_id) === "control.evidence_selection_available").map(fact => fact.dimensions),
    [
      { capability_id: "operator_retrieve_evidence", evidence_id: "ev1_BE1x2Z1tkNa3F6VVtnPi_cEvu7lCs-MG", selection_path: "payload.elementIds" },
      { capability_id: "operator_retrieve_evidence", evidence_id: "ev1_BE1x2Z1tkNa3F6VVtnPi_cEvu7lCs-MG", selection_path: "payload.items" },
      { capability_id: "operator_retrieve_evidence", evidence_id: "ev1_BE1x2Z1tkNa3F6VVtnPi_cEvu7lCs-MG", selection_path: "payload.textSamples" }
    ]
  );
  assert.equal(facts.some(fact => fact.fact_id.startsWith("task.") || fact.fact_id.startsWith("inventory.")), false);
  assert.deepEqual(assignmentKernelControlEvidenceFactsV2(
    "operator_retrieve_evidence", JSON.parse(JSON.stringify(payload))), facts,
    "JSON transport must preserve focused evidence-selection knowledge identity");
});
