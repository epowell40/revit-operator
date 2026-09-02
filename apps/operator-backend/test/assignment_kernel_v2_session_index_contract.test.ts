import assert from "node:assert/strict";
import test from "node:test";
import {
  ASSIGNMENT_KERNEL_V2_CONTROL_CAPABILITY_IDS,
  ASSIGNMENT_KERNEL_V2_DURABLE_CONTROL_EVIDENCE_PRODUCER_IDS,
  ASSIGNMENT_KERNEL_V2_SESSION_INDEX_FIELD,
  ASSIGNMENT_KERNEL_V2_SESSION_INDEX_RESPONSE_SCHEMA,
  assignmentKernelControlEvidenceFactsV2,
  assignmentKernelSessionIndexResponseV2,
  isAssignmentKernelControlCapabilityV2,
  isAssignmentKernelDurableControlEvidenceProducerV2,
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

test("shared V2 session-index response is the only new producer/consumer contract", async () => {
  const response = assignmentKernelSessionIndexResponseV2(index);
  assert.equal(response.schema, ASSIGNMENT_KERNEL_V2_SESSION_INDEX_RESPONSE_SCHEMA);
  assert.deepEqual(parseAssignmentKernelSessionIndexResponseV2(response)[ASSIGNMENT_KERNEL_V2_SESSION_INDEX_FIELD], index);

  const publication = {
    schema: "revit-operator.assignment-kernel-publication/v2",
    assignment_id: "assignment-v2",
    assignment_version: 29,
    snapshot: { provider_call_ids: ["call-1", "call-2", "call-3"] },
    provider_ledger: { call_ids: ["call-1", "call-2", "call-3"] }
  };
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
  const publication = {
    schema: "revit-operator.assignment-kernel-publication/v2",
    assignment_id: "assignment-v2",
    assignment_version: 29,
    snapshot: { schema: "revit-operator.assignment-snapshot/v2", terminal: true, outcome: "complete" },
    provider_ledger: { schema: "revit-operator.assignment-provider-ledger/v2", call_ids: ["call-1"] }
  };
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
