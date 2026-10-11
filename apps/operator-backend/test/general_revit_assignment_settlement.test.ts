import assert from "node:assert/strict";
import test from "node:test";
import { waitForGeneralRevitAssignmentSettlement } from "../src/benchmark/general_revit_assignment_settlement.js";
import { finishGeneralRevitCampaignCase } from "../src/benchmark/general_revit_campaign_completion.js";

function bundle(version = 287, changes: Record<string, unknown> = {}) {
  return { schema: "revit-operator.benchmark-assignment-kernel-v2/v1", assignment_ids: ["task"], failures: [], assignments: [{
    assignment_id: "task", assignment_version: version, snapshot: {
      schema: "revit-operator.assignment-snapshot/v2", assignment_version: version,
      current_binding: { assignment_id: "task", session_id: "session", run_id: "run", generation: 1,
        principal_id: "principal", document_fingerprint: "doc" },
      outcome: "active", terminal: false, quiescent: true,
      in_flight_operation_ids: [], in_flight_provider_call_ids: [], unresolved_unknown_operation_ids: [], ...changes
    }
  }] };
}
function clock() { let time = 0; return { now: () => time, sleep: async (ms: number) => { time += ms; } }; }
const trace = (b: unknown) => ({ case_id: "timeout-case", context_supplied: { session_id: "session" },
  tool_results: { durable_assignment_kernel_v2: b }, errors_retries_recoveries: { error: "Computer run exceeded 300000ms." },
  success_failure_score: { tier: "failed", completed: false, verified: false } });

test("late timeout cleanup can settle the same task without converting its failure into success", async () => {
  const initial = bundle(), settled = bundle(290, { outcome: "blocked", terminal: true });
  assert.ok(finishGeneralRevitCampaignCase(trace(initial), null));
  const result = await waitForGeneralRevitAssignmentSettlement({ initial, sessionId: "session", ...clock(),
    read: async () => settled });
  assert.equal(result.receipt.stop_reason, "settled"); assert.equal(result.receipt.poll_count, 1);
  assert.deepEqual(result.receipt.initial_bundle, initial);
  const final = trace(result.bundle);
  assert.equal(finishGeneralRevitCampaignCase(final, null), null);
  assert.equal(final.success_failure_score.tier, "failed");
  assert.equal(final.errors_retries_recoveries.error, "Computer run exceeded 300000ms.");
  assert.equal(initial.assignments[0]!.snapshot.outcome, "active");
});

test("settled tasks need no polling and active tasks stop at a bounded deadline", async () => {
  const ready = await waitForGeneralRevitAssignmentSettlement({ initial: bundle(1, { terminal: true }), sessionId: "session",
    read: async () => { throw Error("must not read"); } });
  assert.equal(ready.receipt.poll_count, 0);
  const initial = bundle();
  const active = await waitForGeneralRevitAssignmentSettlement({ initial, sessionId: "session", ...clock(),
    timeoutMs: 20, pollMs: 5, read: async () => initial });
  assert.equal(active.receipt.stop_reason, "deadline"); assert.equal(active.receipt.elapsed_ms, 20);
  assert.ok(finishGeneralRevitCampaignCase(trace(active.bundle), null));
});

test("unknown effects are never polled away, including an unknown discovered during cleanup", async () => {
  const unknown = bundle(288, { terminal: true, unresolved_unknown_operation_ids: ["operation"] });
  let reads = 0;
  for (const initial of [unknown, bundle()]) {
    const r = await waitForGeneralRevitAssignmentSettlement({ initial, sessionId: "session", ...clock(),
      read: async () => { reads++; return unknown; } });
    assert.equal(r.receipt.stop_reason, "unknown_effect_or_missing_settlement");
    assert.ok(finishGeneralRevitCampaignCase(trace(r.bundle), null));
  }
  assert.equal(reads, 1);
});

test("changed identity, regressing publication, missing publication, and read failure cannot release the guard", async () => {
  const initial = bundle(), settled = bundle(290, { terminal: true, outcome: "blocked" });
  const bad: Record<string, unknown>[] = [bundle(286, { terminal: true }), { ...settled, failures: [{}] },
    { ...settled, assignments: [] }, { ...settled, assignments: [...settled.assignments, ...settled.assignments] },
    { ...settled, assignment_ids: ["different"] }];
  for (const key of ["assignment_id", "session_id", "run_id", "generation", "principal_id", "document_fingerprint"]) {
    const changed = structuredClone(settled);
    (changed.assignments[0]!.snapshot.current_binding as Record<string, unknown>)[key] = "different";
    bad.push(changed);
  }
  for (const next of bad) {
    const r = await waitForGeneralRevitAssignmentSettlement({ initial, sessionId: "session", ...clock(), read: async () => next });
    assert.equal(r.receipt.stop_reason, "identity_or_publication_invalid");
    assert.deepEqual(r.bundle, initial); assert.ok(finishGeneralRevitCampaignCase(trace(r.bundle), null));
  }
  const error = await waitForGeneralRevitAssignmentSettlement({ initial, sessionId: "session", ...clock(),
    read: async () => { throw Error("offline"); } });
  assert.equal(error.receipt.stop_reason, "read_failed"); assert.deepEqual(error.bundle, initial);
});

test("in-flight native and provider work stays blocked even with a terminal flag", async () => {
  for (const change of [{ in_flight_operation_ids: ["op"] }, { in_flight_provider_call_ids: ["call"] }, { quiescent: false }]) {
    const initial = bundle(1, { terminal: true, ...change });
    const r = await waitForGeneralRevitAssignmentSettlement({ initial, sessionId: "session", ...clock(),
      timeoutMs: 10, pollMs: 5, read: async () => initial });
    assert.equal(r.receipt.stop_reason, "deadline"); assert.ok(finishGeneralRevitCampaignCase(trace(r.bundle), null));
  }
});
