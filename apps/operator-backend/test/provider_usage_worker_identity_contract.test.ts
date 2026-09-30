import assert from "node:assert/strict";
import test from "node:test";
import * as shared from "@revitoperator/assignment-kernel-v2-contracts";
import { validProviderUsageWorkerIdentityV1 as validDomainIdentity } from "../src/domain/assignment-kernel/provider_usage_hold.js";

const identity = () => ({ provider: "openai_codex", configured_billing_mode: "unknown", requested_model: null,
  requested_reasoning_effort: null, reported_model: null, reported_model_source: null });
const hold = (worker: unknown) => ({ schema: "revit-operator.provider-usage-hold/v1", hold_id: "hold", attempt_id: "attempt",
  binding: { assignment_id: "assignment", session_id: "session", run_id: "run", generation: 1, principal_id: "owner" },
  provider_thread_id: "thread", provider_turn_id: "turn", code: "usageLimitExceeded", recorded_at: "2026-09-27T17:00:00Z",
  resume_budget: { max_reasoning_turns: 1, max_provider_calls: 1, max_operations: 1, max_equivalent_operations: 1,
    max_no_progress_epochs: 1, max_reconciliation_attempts: 1, max_wall_clock_ms: 1, max_total_tokens: 1 }, worker_identity: worker });

const valid: unknown[] = [identity()];
for (const billing of ["chatgpt", "api_key", "unknown"])
  for (const effort of [null, "none", "low", "medium", "high", "xhigh", "max"])
    for (const source of [null, "raw_response", "rerouted"])
      valid.push({ ...identity(), configured_billing_mode: billing, requested_reasoning_effort: effort,
        requested_model: "A" + "a".repeat(159), reported_model: source ? "gpt-6-astra" : null, reported_model_source: source });
valid.push({ ...identity(), requested_model: "A._:/-0" });

const invalid: unknown[] = [null, undefined, true, 1, "identity", [], {}, new Date(0)];
for (const key of Object.keys(identity())) {
  const missing: any = identity(); delete missing[key]; invalid.push(missing);
}
for (const key of ["token", "api_key", "account_id", "email", "auth_path", "extra"])
  invalid.push({ ...identity(), [key]: "not allowed" });
for (const provider of ["openai", "unknown", "OPENAI_CODEX", "openai_codex ", null, 1]) invalid.push({ ...identity(), provider });
for (const configured_billing_mode of ["apikey", "subscription", "ChatGPT", "", null, 1]) invalid.push({ ...identity(), configured_billing_mode });
for (const requested_reasoning_effort of ["ultra", "minimal", "MEDIUM", " medium", "", 1, {}]) invalid.push({ ...identity(), requested_reasoning_effort });
for (const key of ["requested_model", "reported_model"])
  for (const value of ["", " gpt", "gpt ", "gpt 6", "bad\u0000model", "bad\u007fmodel", "A".repeat(161), "_model", "<model>", "a@b", true, {}, []])
    invalid.push({ ...identity(), [key]: value, ...(key === "reported_model" ? { reported_model_source: "raw_response" } : {}) });
for (const source of ["requested_fallback", "configured", "", 1, {}, undefined])
  invalid.push({ ...identity(), reported_model: "gpt-6-astra", reported_model_source: source });
invalid.push({ ...identity(), reported_model: "gpt-6-astra", reported_model_source: null },
  { ...identity(), reported_model_source: "raw_response" }, { ...identity(), reported_model_source: "rerouted" });

test("domain and publication retain every valid bounded worker identity", () => {
  for (const value of valid) {
    assert.equal(validDomainIdentity(value), true, JSON.stringify(value));
    const publication = shared.parseProviderUsageHoldV1(hold(value));
    assert.deepEqual(publication.worker_identity, value);
    assert.notEqual(publication.worker_identity, value, "publication must return its own display copy");
  }
});

test("domain and publication reject the same missing, unsafe and contradictory worker identities", () => {
  for (const value of invalid) {
    assert.equal(validDomainIdentity(value), false, JSON.stringify(value));
    if (value === undefined) continue; // The hold's worker field is optional; the worker validator itself is strict.
    assert.throws(() => shared.parseProviderUsageHoldV1(hold(value)), /worker_identity/, JSON.stringify(value));
  }
});

test("one shared strict worker validator is available to both admission and publication", () => {
  assert.equal(typeof shared.validProviderUsageWorkerIdentityV1, "function");
  for (const value of valid) assert.equal(shared.validProviderUsageWorkerIdentityV1(value), true);
  for (const value of invalid) assert.equal(shared.validProviderUsageWorkerIdentityV1(value), false);
});
