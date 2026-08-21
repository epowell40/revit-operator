import assert from "node:assert/strict";
import test from "node:test";
import {
  aggregateModelCallReceipts,
  modelCallReceiptsFromSources,
  modelCallReceiptsFromTraces,
  requestedComputerAgentConfig,
  requestedVsObservedComputerAgent,
  speedSettingsForRequestedConfig
} from "../src/benchmark/general_revit_model_telemetry.js";

function receipt(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schema: "revit-operator.model-call-receipt.v1",
    call_id: "resp_1",
    provider: "openai",
    route: "executor",
    requested_model: "gpt-5.6-luna",
    model: "gpt-5.6-luna",
    reasoning_effort: "max",
    duration_ms: 1200,
    success: true,
    tokens: {
      input_tokens: 100,
      cached_input_tokens: 60,
      output_tokens: 40,
      reasoning_output_tokens: 20,
      total_tokens: 140
    },
    ...overrides
  };
}

test("benchmark CLI preserves explicit outer, planner, and Luna max executor configuration", () => {
  const requested = requestedComputerAgentConfig([
    "--outer-model", "gpt-5.6-terra",
    "--outer-reasoning-effort", "high",
    "--planner-model", "gpt-5.6-sol",
    "--planner-effort", "medium",
    "--executor-model", "gpt-5.6-luna",
    "--executor-reasoning-effort", "max"
  ]);
  assert.deepEqual(requested, {
    outer_model: "gpt-5.6-terra",
    outer_reasoning_effort: "high",
    split_planner_executor: true,
    planner_model: "gpt-5.6-sol",
    planner_reasoning_effort: "medium",
    executor_model: "gpt-5.6-luna",
    executor_reasoning_effort: "max"
  });
  assert.deepEqual(speedSettingsForRequestedConfig(requested), {
    speed_mode: true,
    split_planner_executor: true,
    outer_model: "gpt-5.6-terra",
    outer_reasoning_effort: "high",
    planner_model: "gpt-5.6-sol",
    planner_reasoning_effort: "medium",
    executor_model: "gpt-5.6-luna",
    executor_reasoning_effort: "max"
  });
});

test("camelCase Sidecar receipts are authoritative while snake_case replay duplicates are merged once", () => {
  const first = receipt();
  const duplicateWithMoreTruth = receipt({ response_status: "completed" });
  const planner = receipt({
    call_id: "resp_2",
    route: "planner",
    requested_model: "gpt-5.6-sol",
    model: "gpt-5.6-sol",
    reasoning_effort: "medium",
    duration_ms: 800,
    tokens: {
      input_tokens: 50,
      cached_input_tokens: 20,
      output_tokens: 10,
      reasoning_output_tokens: 5,
      total_tokens: 60
    }
  });
  const receipts = modelCallReceiptsFromSources(
    { modelCallReceipts: [first, planner] },
    { model_call_receipts: [duplicateWithMoreTruth] }
  );
  assert.equal(receipts.length, 2);
  assert.equal(receipts.find((entry) => entry.call_id === "resp_1")?.response_status, "completed");
  const summary = aggregateModelCallReceipts(receipts);
  assert.equal(summary.call_count, 2);
  assert.equal(summary.provider_duration_ms, 2000);
  assert.equal(summary.input_tokens, 150);
  assert.equal(summary.cached_input_tokens, 80);
  assert.equal(summary.output_tokens, 50);
  assert.equal(summary.reasoning_output_tokens, 25);
  assert.equal(summary.total_tokens, 200);
  assert.equal(summary.cost_usd, null);
  assert.equal(summary.cost_status, "missing_pricing");
});

test("resumed trace aggregation deduplicates provider calls and reports requested-versus-observed drift", () => {
  const executor = receipt();
  const receipts = modelCallReceiptsFromTraces([
    { case_id: "first", model_call_receipts: [executor] },
    { case_id: "checkpoint-replay", model_call_receipts: [executor] },
    { case_id: "outer", model_call_receipts: [receipt({
      call_id: "resp_outer",
      route: "desktop_computer",
      requested_model: "gpt-5.6-terra",
      model: "gpt-5.6-terra",
      reasoning_effort: "medium",
      tokens: { input_tokens: null, cached_input_tokens: null, output_tokens: null, reasoning_output_tokens: null, total_tokens: null }
    })] }
  ]);
  assert.equal(receipts.length, 2);
  const telemetry = aggregateModelCallReceipts(receipts);
  assert.equal(telemetry.call_count, 2);
  assert.equal(telemetry.total_tokens, null);
  assert.equal(telemetry.known_total_tokens, 140);
  assert.equal(telemetry.token_status, "partial");
  const requested = requestedComputerAgentConfig([
    "--outer-model", "gpt-5.6-sol",
    "--outer-effort", "medium",
    "--planner-model", "gpt-5.6-sol",
    "--planner-effort", "medium",
    "--executor-model", "gpt-5.6-luna",
    "--executor-effort", "max"
  ]);
  const comparison = requestedVsObservedComputerAgent(requested, telemetry);
  assert.equal(comparison.configuration_drift_detected, true);
  const roles = comparison.roles as Array<Record<string, unknown>>;
  assert.equal(roles.find((role) => role.role === "executor")?.configuration_match, true);
  assert.equal(roles.find((role) => role.role === "outer")?.configuration_match, false);
  assert.equal(roles.find((role) => role.role === "planner")?.configuration_match, null);
});

test("missing token usage remains unknown and missing pricing is never represented as zero cost", () => {
  const summary = aggregateModelCallReceipts([receipt({
    tokens: {
      input_tokens: null,
      cached_input_tokens: null,
      output_tokens: null,
      reasoning_output_tokens: null,
      total_tokens: null
    }
  })]);
  assert.equal(summary.total_tokens, null);
  assert.equal(summary.input_tokens, null);
  assert.equal(summary.cost_usd, null);
  assert.notEqual(summary.cost_usd, 0);
  assert.equal(summary.cost_status, "missing_pricing");
});
