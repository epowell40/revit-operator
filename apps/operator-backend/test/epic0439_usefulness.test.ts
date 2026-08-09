import test from "node:test";
import assert from "node:assert/strict";
import {
  EPIC0439_REQUIRED_DOMAINS,
  buildEpic0439UsefulnessReport,
  loadEpic0439UsefulnessManifest,
  materializeEpic0439Cases,
  validateEpic0439DynamicSelection,
  validateEpic0439Result,
  type Epic0439Result
} from "../src/benchmark/epic0439_usefulness.js";

const manifest = loadEpic0439UsefulnessManifest();

function result(overrides: Partial<Epic0439Result> = {}): Epic0439Result {
  return {
    schema_version: "epic0439_result/v1",
    case_id: "u01_parameter_simple--implementation--0--abc",
    task_id: "u01_parameter_simple",
    config_id: "epic0439_typed_v1",
    representation: "typed_capability_chain",
    evidence_tier: "source_only",
    metrics: {
      completion: true,
      correctness: 1,
      changed_element_precision: 1,
      model_turns: 2,
      tool_rpc_calls: 4,
      generated_code_bytes: 0,
      execution_time_ms: 500,
      estimated_cost_usd: 0.02,
      input_tokens: 100,
      output_tokens: 50,
      preview_repairs: 0,
      verification_quality: 1,
      special_purpose_product_code_bytes: 1200,
      recovery_attempts: 0,
      recovery_outcome: "not_needed"
    },
    failure: null,
    notes: ["Source inspection only; not a live Revit outcome."],
    ...overrides
  };
}

test("EPIC-0439 usefulness manifest covers all 16 required task domains with paired configurations", () => {
  assert.equal(manifest.tasks.length, 16);
  assert.deepEqual(new Set(manifest.tasks.map((task) => task.domain)), new Set(EPIC0439_REQUIRED_DOMAINS));
  assert.deepEqual(
    new Set(manifest.execution_configs.map((config) => config.representation)),
    new Set(["typed_capability_chain", "dynamic_program"])
  );
  for (const task of manifest.tasks) {
    assert.ok(task.implementation_wording.length > 0);
    assert.ok(task.holdout_wording.length > 0);
    assert.ok(task.rule_pool.length >= 2);
    assert.match(task.selection_query, /query|discover|enumerate|graph|evidence|inspect/i);
  }
});

test("case materialization is deterministic, seed-sensitive, and reserves unseen wording", () => {
  const first = materializeEpic0439Cases(manifest, { seed: "review-freeze-01", variants_per_task: 2 });
  const second = materializeEpic0439Cases(manifest, { seed: "review-freeze-01", variants_per_task: 2 });
  const other = materializeEpic0439Cases(manifest, { seed: "review-freeze-02", variants_per_task: 2 });
  const holdout = materializeEpic0439Cases(manifest, { seed: "review-freeze-01", wording_partition: "holdout" });
  assert.deepEqual(first, second);
  assert.equal(first.length, 32);
  assert.notDeepEqual(first.map((entry) => entry.randomized_inputs), other.map((entry) => entry.randomized_inputs));
  assert.ok(holdout.every((entry) => entry.wording_partition === "holdout"));
  assert.ok(holdout.every((entry) => !manifest.tasks.find((task) => task.task_id === entry.task_id)!.implementation_wording.includes(entry.user_prompt)));
});

test("post-freeze reviewer wording can replace selected holdout slots without changing source", () => {
  const cases = materializeEpic0439Cases(manifest, {
    seed: "independent-reviewer",
    wording_partition: "reviewer_holdout",
    reviewer_wording: {
      u16_novel_egress_overlay: ["Independent challenge: analyze {{count}} rooms in {{view_context}} under {{rule}} and call the overlay {{label}}."]
    }
  });
  const novel = cases.find((entry) => entry.task_id === "u16_novel_egress_overlay")!;
  assert.equal(novel.wording_partition, "reviewer_holdout");
  assert.match(novel.user_prompt, /^Independent challenge:/);
  assert.doesNotMatch(novel.user_prompt, /\{\{/);
});

test("materialized prompts do not disclose randomized fixture target ids", () => {
  const cases = materializeEpic0439Cases(manifest, { seed: "anti-demo", variants_per_task: 3, wording_partition: "holdout" });
  for (const benchmarkCase of cases) {
    for (const candidate of benchmarkCase.fixture_evidence.candidates) {
      assert.equal(benchmarkCase.user_prompt.includes(candidate.element_id), false);
    }
    assert.equal(benchmarkCase.target_selection.required_strategy, "live_evidence_query");
    assert.equal(benchmarkCase.target_selection.generated_source_may_contain_fixture_ids, false);
  }
});

test("dynamic target selection rejects fixture constants and unobserved operated ids", () => {
  const benchmarkCase = materializeEpic0439Cases(manifest, { seed: "selector" })[0]!;
  const targetId = benchmarkCase.evaluator_ground_truth.expected_target_ids[0]!;
  assert.doesNotThrow(() => validateEpic0439DynamicSelection(benchmarkCase, {
    strategy: "live_evidence_query",
    generated_source: "var targets = await sdk.Elements.QueryAsync(predicate);",
    observed_element_ids: [targetId],
    operated_element_ids: [targetId]
  }));
  assert.throws(() => validateEpic0439DynamicSelection(benchmarkCase, {
    strategy: "live_evidence_query",
    generated_source: `await sdk.Parameters.SetAsync(\"${targetId}\", \"QA Status\", value);`,
    observed_element_ids: [targetId],
    operated_element_ids: [targetId]
  }), /fixture element id/);
  assert.throws(() => validateEpic0439DynamicSelection(benchmarkCase, {
    strategy: "live_evidence_query",
    generated_source: "var targets = await sdk.Elements.QueryAsync(predicate);",
    observed_element_ids: [],
    operated_element_ids: [targetId]
  }), /not present in live evidence/);
});

test("evidence tiers cannot mislabel source or mock results as live Revit", () => {
  assert.doesNotThrow(() => validateEpic0439Result(result(), manifest));
  assert.throws(() => validateEpic0439Result(result({ evidence_tier: "live_revit" }), manifest), /requires a live Revit receipt/);
  assert.throws(() => validateEpic0439Result(result({
    evidence_tier: "mocked",
    live_revit_receipt: {
      receipt_id: "r",
      revit_version: "2025",
      document_session_id: "d",
      admission_hash: "a",
      preview_receipt_hash: "p",
      apply_receipt_hash: "x",
      verification_receipt_hash: "v"
    }
  }), manifest), /must not carry a live Revit receipt/);
});

test("report compares paired metrics and keeps source-only evidence non-live", () => {
  const typed = result();
  const dynamic = result({
    config_id: "epic0439_dynamic_v1",
    representation: "dynamic_program",
    metrics: {
      ...result().metrics,
      tool_rpc_calls: 2,
      generated_code_bytes: 2400,
      special_purpose_product_code_bytes: 0,
      input_tokens: 130,
      output_tokens: 90
    }
  });
  const report = buildEpic0439UsefulnessReport(manifest, [typed, dynamic]);
  assert.equal(report.live_revit_result_count, 0);
  assert.equal(report.source_only_result_count, 2);
  assert.equal(report.live_acceptance_claimable, false);
  assert.match(report.evidence_warning ?? "", /not live acceptance/i);
  assert.equal(report.paired_deltas.length, 1);
  assert.equal(report.paired_deltas[0]!.tool_calls_dynamic_minus_typed, -2);
  assert.equal(report.paired_deltas[0]!.product_code_bytes_dynamic_minus_typed, -1200);
});
