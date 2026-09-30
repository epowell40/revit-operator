import assert from "node:assert/strict";
import test from "node:test";
import { parseAssignmentKernelPublicationV2 } from "./index.js";

function fixture() {
  const binding = { assignment_id: "assignment", session_id: "session", run_id: "run", generation: 1, principal_id: "principal", document_fingerprint: "model" };
  const resume_budget = { max_reasoning_turns: 10, max_provider_calls: 20, max_operations: 30, max_equivalent_operations: 3,
    max_no_progress_epochs: 4, max_reconciliation_attempts: 2, max_wall_clock_ms: 60000, max_total_tokens: 5000 };
  return { schema: "revit-operator.assignment-kernel-publication/v2", assignment_id: "assignment", assignment_version: 3,
    snapshot: { schema: "revit-operator.assignment-snapshot/v2", assignment_version: 3, current_binding: binding,
      provider_call_ids: [], in_flight_provider_call_ids: [], provider_calls: {},
      provider_usage_hold: { schema: "revit-operator.provider-usage-hold/v1", hold_id: "hold", binding: { ...binding }, attempt_id: "issued-attempt",
        provider_thread_id: "thread", provider_turn_id: "turn", code: "usageLimitExceeded", recorded_at: "2026-09-27T16:01:00Z", resume_budget,
        worker_identity: { provider: "openai_codex", configured_billing_mode: "unknown", requested_model: null, requested_reasoning_effort: null,
          reported_model: null, reported_model_source: null } } },
    provider_ledger: { schema: "revit-operator.assignment-provider-ledger/v2", assignment_id: "assignment", run_id: "run", generation: 1,
      call_ids: [], in_flight_call_ids: [], calls: {} } };
}

test("a zero-response usage hold round-trips as bounded canonical data; older no-hold publications remain valid", () => {
  const p = fixture(); assert.deepEqual(parseAssignmentKernelPublicationV2(JSON.parse(JSON.stringify(p))), p);
  for (const key of ["hold_id", "attempt_id", "provider_thread_id", "provider_turn_id"]) p.snapshot.provider_usage_hold[key] = "a".repeat(240);
  for (const key of Object.keys(p.snapshot.provider_usage_hold.resume_budget)) p.snapshot.provider_usage_hold.resume_budget[key] = 2_147_483_647;
  p.snapshot.provider_usage_hold.worker_identity.requested_model = "A" + "a._:/-0".repeat(22) + "aaabz";
  assert.equal(p.snapshot.provider_usage_hold.worker_identity.requested_model.length, 160);
  assert.deepEqual(parseAssignmentKernelPublicationV2(p), p);
  delete p.snapshot.provider_usage_hold; assert.deepEqual(parseAssignmentKernelPublicationV2(p), p);
});

test("foreign hold bindings and unsafe hold metadata fail at the shared publication boundary", () => {
  for (const mutate of [
    h => { h.binding.assignment_id = "other"; }, h => { h.binding.session_id = "other"; }, h => { h.binding.run_id = "other"; },
    h => { h.binding.generation = 2; }, h => { h.binding.principal_id = "other"; }, h => { h.binding.document_fingerprint = "other"; },
    h => { h.hold_id = ""; }, h => { h.code = "httpConnectionFailed"; }, h => { h.resume_budget.max_operations = 1.5; },
    h => { h.worker_identity.token = "never expose"; }, h => { h.recorded_at = "unconfirmed"; }, h => { h.attempt_id = "x".repeat(241); },
    ...["hold_id", "attempt_id", "provider_thread_id", "provider_turn_id"].flatMap(key => [
      h => { h[key] = "bad\u007fidentity"; }, h => { h[key] = "x".repeat(241); }
    ]),
    ...Object.keys(fixture().snapshot.provider_usage_hold.resume_budget).flatMap(key => [
      h => { h.resume_budget[key] = 0; }, h => { h.resume_budget[key] = 2_147_483_648; }
    ]),
    ...["requested_model", "reported_model"].flatMap(key => ["<model>", "gpt 6", "bad\u007fmodel", "m".repeat(161), "_model"].map(value => h => {
      h.worker_identity[key] = value;
      if (key === "reported_model") h.worker_identity.reported_model_source = "raw_response";
    }))
  ]) { const p = fixture(); mutate(p.snapshot.provider_usage_hold); assert.throws(() => parseAssignmentKernelPublicationV2(p), /provider_usage_hold/); }
});

test("model fallback cannot be presented as provider-reported without matching supported provenance", () => {
  const p = fixture(), worker = p.snapshot.provider_usage_hold.worker_identity;
  worker.requested_model = "gpt-6-astra"; worker.requested_reasoning_effort = "medium"; worker.configured_billing_mode = "chatgpt";
  assert.equal(parseAssignmentKernelPublicationV2(p).snapshot.provider_usage_hold.worker_identity.reported_model, null);
  worker.reported_model = "gpt-5.6-sol"; assert.throws(() => parseAssignmentKernelPublicationV2(p), /worker_identity/);
  worker.reported_model_source = "requested_fallback"; assert.throws(() => parseAssignmentKernelPublicationV2(p), /worker_identity/);
  worker.reported_model_source = "rerouted";
  assert.equal(parseAssignmentKernelPublicationV2(p).snapshot.provider_usage_hold.worker_identity.reported_model, "gpt-5.6-sol");
});
