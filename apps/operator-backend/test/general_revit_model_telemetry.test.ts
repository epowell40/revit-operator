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

test("benchmark CLI accepts one model pair and rejects removed split flags", () => {
  const requested = requestedComputerAgentConfig(["--agent-model", "gpt-5.6-luna", "--agent-effort", "max"]);
  assert.deepEqual(requested, { agent_model: "gpt-5.6-luna", agent_reasoning_effort: "max" });
  assert.deepEqual(speedSettingsForRequestedConfig(requested), {
    speed_mode: true, agent_model: "gpt-5.6-luna", agent_reasoning_effort: "max"
  });
  assert.throws(() => requestedComputerAgentConfig(["--planner-model", "gpt-5.6-sol"]), /removed split-agent option/);
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

test("missing usage remains unknown and never becomes zero cost", () => {
  const summary = aggregateModelCallReceipts(modelCallReceiptsFromTraces([{ model_call_receipts: [receipt({
    tokens: { input_tokens: null, cached_input_tokens: null, output_tokens: null,
      reasoning_output_tokens: null, total_tokens: null }
  })] }]));
  assert.equal(summary.total_tokens, null);
  assert.equal(summary.cost_usd, null);
  assert.equal(summary.cost_status, "incomplete");
});
