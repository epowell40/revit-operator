import assert from "node:assert/strict";
import test from "node:test";
import { markdownReport } from "../src/benchmark/general_revit_capability_report.js";

test("General Revit markdown keeps requested configuration distinct from observed provider receipts", () => {
  const markdown = markdownReport({
    run_id: "fixture-run",
    label: "Luna comparison",
    generated_at: "2026-08-21T20:00:00.000Z",
    suite_timing: {
      started_at_utc: "2026-08-21T19:00:00.000Z",
      finished_at_utc: "2026-08-21T20:00:00.000Z",
      wall_clock_ms: 3_600_000
    },
    suite_context: {
      mutation_policy: "safe probe prompts only; no apply requested",
      execution_surface: "operator_computer_general_agent",
      computer_agent: {
        requested: {
          agent_model: "gpt-5.6-luna",
          agent_reasoning_effort: "max"
        },
        observed_provider_calls: {
          configuration_drift_detected: false,
          roles: [{
            role: "agent",
            observed_models: ["gpt-5.6-luna"],
            observed_reasoning_efforts: ["max"],
            call_count: 3,
            provider_duration_ms: 2_500,
            total_tokens: 360,
            cost_usd: 0.0123
          }]
        }
      }
    },
    summary: {
      total: 1,
      non_refusal_rate: 1,
      non_refusal_count: 1,
      completion_rate: 1,
      completed_count: 1,
      verification_rate: 1,
      verified_count: 1,
      refusal_count: 0,
      failure_count: 0
    },
    fixture_mismatch_count: 0,
    fixture_unverifiable_count: 0,
    selected_answer_assertion_case_count: 1,
    model_call_telemetry: {
      by_route_model_effort: [{
        route: "codex_agent",
        model: "gpt-5.6-luna",
        reasoning_effort: "max",
        call_count: 3,
        provider_duration_ms: 2_500,
        total_tokens: 360,
        cost_usd: 0.0123
      }]
    },
    model_telemetry_coverage: {
      expected_case_count: 1,
      cases_with_model_receipts: 1
    },
    telemetry_valid_for_model_comparison: true,
    summary_by_specificity: {},
    summary_by_fixture: {},
    summary_by_verification_basis: { fixture_grounded_semantic: 1 },
    summary_by_corpus_task_type: {},
    corpus_coverage: { task_types: [] },
    task_traces: [{
      case_id: "q01_air_device_inventory",
      source: "baseline",
      operation_family: "query",
      success_failure_score: { tier: "verified" },
      verification_results: { evaluation: { verification_basis: "fixture_grounded_semantic" } },
      efficiency: { duration_ms: 1_234 }
    }]
  });

  assert.match(markdown, /\| agent \| gpt-5\.6-luna \/ max \| gpt-5\.6-luna \/ max \| 3 \| 2\.5s \| 360 \| \$0\.0123 \|/);
  assert.match(markdown, /Telemetry coverage: 1\/1 cases; valid for model comparison: yes/);
  assert.match(markdown, /\| codex_agent \| gpt-5\.6-luna \| max \| 3 \| 2\.5s \| 360 \| \$0\.0123 \|/);
  assert.match(markdown, /not an invoice or account-credit measurement/);
  assert.match(markdown, /fixture_grounded_semantic/);
  assert.match(markdown, /assistant prose alone is not verification/);
});
