import assert from "node:assert/strict";
import test from "node:test";
import {
  ASSIGNMENT_KERNEL_PUBLICATION_V2_SCHEMA,
  ASSIGNMENT_PROVIDER_CALL_V2_SCHEMA,
  ASSIGNMENT_PROVIDER_LEDGER_V2_SCHEMA,
  ASSIGNMENT_SNAPSHOT_V2_SCHEMA
} from "@revitoperator/assignment-kernel-v2-contracts";
import {
  BENCHMARK_ASSIGNMENT_KERNEL_V2_BUNDLE_SCHEMA,
  modelCallReceiptsFromAssignmentKernelPublicationsV2
} from "../src/benchmark/assignment_kernel_v2_collection.js";
import {
  aggregateModelCallReceipts,
  modelCallReceiptsFromSources,
  modelCallReceiptsFromTraces,
  modelTelemetryCaseCoverage,
  requestedComputerAgentConfig,
  requestedVsObservedComputerAgent,
  speedSettingsForRequestedConfig
} from "../src/benchmark/general_revit_model_telemetry.js";
import { createCodexRawModelCallReceipt } from "../src/model_call_telemetry.js";

function receipt(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schema: "revit-operator.model-call-receipt.v1", call_id: "resp_1", provider: "openai",
    route: "codex_agent", requested_model: "gpt-5.6-luna", model: "gpt-5.6-luna",
    reasoning_effort: "max", duration_ms: null, success: true,
    tokens: { input_tokens: 100, cached_input_tokens: 60, cache_write_input_tokens: 10,
      output_tokens: 40, reasoning_output_tokens: 20, total_tokens: 140 },
    ...overrides
  };
}

function providerCall(callId: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schema: ASSIGNMENT_PROVIDER_CALL_V2_SCHEMA,
    call_id: callId,
    controller_turn_id: "turn-canonical",
    state: "completed",
    provider: "openai",
    model: "gpt-5.6-sol",
    reasoning_effort: "medium",
    admitted_at: "2026-09-02T00:00:00.000Z",
    completed_at: "2026-09-02T00:00:01.000Z",
    success: true,
    ...overrides
  };
}

function telemetryPublicationBundle(
  callsInput: Record<string, Record<string, unknown>>,
  assignmentId: string,
  assignmentVersion: number
): Record<string, unknown> {
  const binding = {
    assignment_id: assignmentId,
    run_id: `run-${assignmentId}`,
    generation: 1,
    session_id: `session-${assignmentId}`,
    principal_id: "principal-telemetry"
  };
  const calls = Object.fromEntries(Object.entries(callsInput).map(([callId, call]) => [callId, {
    ...call,
    schema: ASSIGNMENT_PROVIDER_CALL_V2_SCHEMA,
    call_id: callId,
    binding,
    gap_ids: ["gap:provider-telemetry"],
    criterion_ids: ["criterion-provider-telemetry"],
    expected_information: ["provider response and usage"]
  }]));
  const callIds = Object.keys(calls);
  const publication = {
    schema: ASSIGNMENT_KERNEL_PUBLICATION_V2_SCHEMA,
    assignment_id: assignmentId,
    assignment_version: assignmentVersion,
    snapshot: {
      schema: ASSIGNMENT_SNAPSHOT_V2_SCHEMA,
      assignment_version: assignmentVersion,
      current_binding: binding,
      provider_call_ids: callIds,
      provider_calls: calls,
      in_flight_provider_call_ids: []
    },
    provider_ledger: {
      schema: ASSIGNMENT_PROVIDER_LEDGER_V2_SCHEMA,
      assignment_id: assignmentId,
      run_id: binding.run_id,
      generation: binding.generation,
      call_ids: callIds,
      calls,
      in_flight_call_ids: []
    }
  };
  return {
    schema: BENCHMARK_ASSIGNMENT_KERNEL_V2_BUNDLE_SCHEMA,
    assignment_ids: [assignmentId],
    assignments: [publication],
    failures: []
  };
}

test("benchmark CLI accepts one model pair and rejects removed split flags", () => {
  const requested = requestedComputerAgentConfig(["--agent-model", "gpt-5.6-luna", "--agent-effort", "max"]);
  assert.deepEqual(requested, { agent_model: "gpt-5.6-luna", agent_reasoning_effort: "max" });
  assert.deepEqual(speedSettingsForRequestedConfig(requested), {
    speed_mode: true, agent_model: "gpt-5.6-luna", agent_reasoning_effort: "max"
  });
  assert.throws(() => requestedComputerAgentConfig(["--planner-model", "gpt-5.6-sol"]), /removed split-agent option/);
});

test("model comparison coverage fails closed when any delegated case lacks receipts", () => {
  const covered = { case_id: "covered", model_call_receipts: [receipt()] };
  assert.deepEqual(modelTelemetryCaseCoverage([covered]), {
    schema: "revit-operator.model-telemetry-case-coverage.v1",
    expected_case_count: 1,
    cases_with_model_receipts: 1,
    cases_missing_model_receipts: 0,
    missing_case_ids: [],
    complete: true
  });
  const partial = modelTelemetryCaseCoverage([covered, { case_id: "timed_out", model_call_receipts: [] }]);
  assert.equal(partial.complete, false);
  assert.deepEqual(partial.missing_case_ids, ["timed_out"]);
});

test("raw Codex completion becomes an exact content-free provider receipt", () => {
  const value = createCodexRawModelCallReceipt({
    params: { responseId: "resp_codex", usage: { inputTokens: 1000, cachedInputTokens: 600,
      cacheWriteInputTokens: 100, outputTokens: 200, reasoningOutputTokens: 150, totalTokens: 1200 } },
    requested_model: "gpt-5.6-sol", reasoning_effort: "medium",
    started_at_utc: "2026-08-21T00:00:00.000Z", turn_id: "turn_1"
  });
  assert.equal(value?.route, "codex_agent");
  assert.equal(value?.duration_ms, null);
  assert.equal(value?.usage_source, "responses_api_raw_completion");
  assert.equal(value?.tokens.cache_write_input_tokens, 100);
  assert.equal(value?.tokens.total_tokens, 1200);
});

test("deduplication, exact pricing, and unified configuration comparison are complete", () => {
  const receipts = modelCallReceiptsFromSources(
    { modelCallReceipts: [receipt(), receipt({ call_id: "resp_outer", route: "desktop_computer", duration_ms: 1200 })] },
    { model_call_receipts: [receipt({ response_status: "completed" })] }
  );
  assert.equal(receipts.length, 2);
  const summary = aggregateModelCallReceipts(receipts);
  assert.equal(summary.call_count, 2);
  assert.equal(summary.total_tokens, 280);
  assert.equal(summary.cost_status, "estimated_from_exact_provider_tokens");
  assert.ok(typeof summary.cost_usd === "number" && summary.cost_usd > 0);
  const comparison = requestedVsObservedComputerAgent(
    requestedComputerAgentConfig(["--agent-model", "gpt-5.6-luna", "--agent-effort", "max"]), summary
  );
  assert.equal(comparison.configuration_drift_detected, false);
  assert.equal(comparison.codex_agent_observed, true);
  assert.equal(comparison.desktop_computer_observed, true);
  assert.equal(comparison.comparable_configuration, true);
});

test("duplicate provider receipts merge missing fields but reject contradictory accounting", () => {
  const merged = modelCallReceiptsFromSources(
    { model_call_receipts: [receipt({ duration_ms: 250 })] },
    { model_call_receipts: [receipt({ duration_ms: null, canonical_source: "assignment_kernel_v2_provider_ledger" })] }
  );
  assert.equal(merged.length, 1);
  assert.equal(merged[0]?.duration_ms, 250);
  assert.equal(merged[0]?.canonical_source, "assignment_kernel_v2_provider_ledger");
  assert.throws(() => modelCallReceiptsFromSources(
    { model_call_receipts: [receipt()] },
    { model_call_receipts: [receipt({
      tokens: { input_tokens: 100, cached_input_tokens: null, output_tokens: 40,
        reasoning_output_tokens: 20, total_tokens: 141 }
    })] }
  ), /model_call_receipt_conflict:openai:resp_1:total_tokens/);
});

test("missing usage remains unknown and never becomes zero cost", () => {
  const summary = aggregateModelCallReceipts(modelCallReceiptsFromTraces([{ model_call_receipts: [receipt({
    tokens: { input_tokens: null, cached_input_tokens: null, output_tokens: null,
      reasoning_output_tokens: null, total_tokens: null }
  })] }]));
  assert.equal(summary.total_tokens, null);
  assert.equal(summary.cost_usd, null);
  assert.equal(summary.cost_status, "incomplete");
});

test("benchmark telemetry recovers every provider call from the exact V2 publication ledger", () => {
  const calls = Object.fromEntries([1, 2, 3].map((index) => [`resp_${index}`, providerCall(`resp_${index}`, {
    admitted_at: `2026-09-02T00:00:0${index}.000Z`,
    completed_at: `2026-09-02T00:00:0${index}.250Z`,
    provider_duration_ms: 250,
    usage: { input_tokens: index * 100, output_tokens: index * 10, reasoning_tokens: index * 5, total_tokens: index * 110 }
  })]));
  const recovered = modelCallReceiptsFromAssignmentKernelPublicationsV2(
    telemetryPublicationBundle(calls, "assignment-telemetry", 40)
  );
  assert.deepEqual(recovered.map((entry) => entry.call_id), ["resp_1", "resp_2", "resp_3"]);
  assert.equal(recovered[0]?.canonical_source, "assignment_kernel_v2_provider_ledger");
  assert.equal((recovered[2]?.tokens as Record<string, unknown>).reasoning_output_tokens, 15);
  assert.equal(recovered[2]?.duration_ms, 250);
  assert.equal(aggregateModelCallReceipts(recovered).call_count, 3);
});

test("benchmark telemetry retains provider calls after downstream response transport completes", () => {
  const recovered = modelCallReceiptsFromAssignmentKernelPublicationsV2(
    telemetryPublicationBundle({
      "resp-transported": providerCall("resp-transported", {
        state: "response_transport_completed",
        response_transport_completed_at: "2026-09-02T00:00:02.000Z"
      })
    }, "assignment-transported", 41)
  );
  assert.deepEqual(recovered.map((entry) => entry.call_id), ["resp-transported"]);
});

test("V2 telemetry never fabricates per-call provider durations from shared controller-turn admission", () => {
  const calls = Object.fromEntries([1, 2].map((index) => [`resp_shared_${index}`, providerCall(`resp_shared_${index}`, {
    controller_turn_id: "turn-shared",
    admitted_at: "2026-09-02T00:00:00.000Z",
    completed_at: `2026-09-02T00:00:${index}0.000Z`,
    usage: { input_tokens: 100, output_tokens: 10, reasoning_tokens: 5, total_tokens: 110 }
  })]));
  const recovered = modelCallReceiptsFromAssignmentKernelPublicationsV2(
    telemetryPublicationBundle(calls, "assignment-shared-admission", 20)
  );
  assert.deepEqual(recovered.map((entry) => entry.duration_ms), [null, null]);
});

test("malformed V2 telemetry publication fails explicitly instead of impersonating an absent provider ledger", () => {
  const bundle = telemetryPublicationBundle({
    "resp-bound": providerCall("resp-bound")
  }, "assignment-bound", 7) as { assignments: Array<Record<string, unknown>> } & Record<string, unknown>;
  const publication = bundle.assignments[0]!;
  const ledger = publication.provider_ledger as Record<string, unknown>;
  assert.throws(() => modelCallReceiptsFromAssignmentKernelPublicationsV2({
    ...bundle,
    assignments: [{ ...publication, provider_ledger: { ...ledger, run_id: "run-foreign" } }]
  }), /assignment_kernel_v2_telemetry_invalid:publication:0:assignment_kernel_v2_publication_invalid:provider_ledger_binding/);
});
