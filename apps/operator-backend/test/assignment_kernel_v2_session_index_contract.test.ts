import assert from "node:assert/strict";
import test from "node:test";
import {
  ASSIGNMENT_KERNEL_V2_SESSION_INDEX_FIELD,
  ASSIGNMENT_KERNEL_V2_SESSION_INDEX_RESPONSE_SCHEMA,
  assignmentKernelSessionIndexResponseV2,
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
