import fs from "node:fs";
import path from "node:path";
import { readJsonFile, writeJsonFileNew, writeTextFileNew } from "./files.js";
import { sha256Value } from "./protocol_v2_hash.js";
import { validateBenchmarkRunEnvelopeV2 } from "./protocol_v2_envelope.js";
import {
  BENCHMARK_LANES,
  BENCHMARK_RAW_REPORT_V2_SCHEMA,
  type BenchmarkCaseResultV2,
  type BenchmarkLaneMetricsV2,
  type BenchmarkRawReportV2,
  type BenchmarkRunEnvelopeV2
} from "./protocol_v2_types.js";

function percentile(values: number[], ratio: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.max(0, Math.ceil(sorted.length * ratio) - 1);
  return sorted[index] ?? null;
}

function sum(values: Array<number | null>): number {
  return values.reduce<number>((total, value) => total + (value ?? 0), 0);
}

export function validateBenchmarkCaseResultV2(value: BenchmarkCaseResultV2): void {
  if (value.schema !== "revit-operator.benchmark-case-result/v2") throw new Error(`Case ${value.case_id} has an invalid V2 schema.`);
  if (!value.case_id || !value.run_id) throw new Error("Benchmark V2 case result requires run_id and case_id.");
  if (!/^[a-f0-9]{64}$/i.test(value.case_sha256) || !/^[a-f0-9]{64}$/i.test(value.raw_trace_sha256)) {
    throw new Error(`Case ${value.case_id} has incomplete immutable hashes.`);
  }
  if (value.stages.length !== 11) throw new Error(`Case ${value.case_id} must contain exactly eleven protocol stages.`);
  const first = value.stages.find((entry) => entry.status === "fail" || entry.status === "uncertain")?.stage ?? null;
  if (first !== value.first_failed_or_uncertain_stage) throw new Error(`Case ${value.case_id} first-failure stage is inconsistent.`);
  if (value.release_blocking !== ["false_completion", "collateral_or_unauthorized_mutation"].includes(value.delivery_verdict)) {
    throw new Error(`Case ${value.case_id} release-blocking flag is inconsistent.`);
  }
}

export function buildBenchmarkRawReportV2(
  envelope: BenchmarkRunEnvelopeV2,
  cases: BenchmarkCaseResultV2[],
  generatedAt: string
): BenchmarkRawReportV2 {
  validateBenchmarkRunEnvelopeV2(envelope);
  if (cases.length === 0) throw new Error("Benchmark Protocol V2 report cannot be empty.");
  for (const result of cases) {
    validateBenchmarkCaseResultV2(result);
    if (result.run_id !== envelope.identity.run_id) throw new Error(`Case ${result.case_id} is bound to another run.`);
    if (envelope.corpus.case_hashes[result.case_id] !== result.case_sha256) throw new Error(`Case ${result.case_id} hash is not bound to the run envelope.`);
  }
  const unsigned = { schema: BENCHMARK_RAW_REPORT_V2_SCHEMA, envelope, cases, generated_at: generatedAt };
  return { ...unsigned, report_sha256: sha256Value(unsigned) };
}

export function validateBenchmarkRawReportV2(report: BenchmarkRawReportV2): void {
  if (report.schema !== BENCHMARK_RAW_REPORT_V2_SCHEMA) throw new Error("Unsupported Benchmark Protocol V2 raw report schema.");
  validateBenchmarkRunEnvelopeV2(report.envelope);
  for (const result of report.cases) validateBenchmarkCaseResultV2(result);
  const { report_sha256: recorded, ...unsigned } = report;
  if (sha256Value(unsigned) !== recorded) throw new Error("Raw report hash does not match immutable report content.");
}

export function summarizeBenchmarkLanesV2(cases: readonly BenchmarkCaseResultV2[]): BenchmarkLaneMetricsV2[] {
  return BENCHMARK_LANES.map((lane) => {
    const selected = cases.filter((entry) => entry.lane === lane);
    const count = (verdict: BenchmarkCaseResultV2["delivery_verdict"]) => selected.filter((entry) => entry.delivery_verdict === verdict).length;
    const firstPass = count("first_pass_verified");
    const recovered = count("recovered_verified");
    const explicitCommitted = count("verified_committed_completion");
    const verifiedCommitted = firstPass + recovered + explicitCommitted;
    const verifiedTaskCount = selected.filter((entry) => entry.current_evaluator_verdict.verdict === "verified").length;
    const durations = selected.map((entry) => entry.metrics.completion_time_ms).filter((value): value is number => value !== null);
    const totalTokens = sum(selected.map((entry) => entry.metrics.input_tokens === null || entry.metrics.output_tokens === null
      ? null : entry.metrics.input_tokens + entry.metrics.output_tokens));
    const totalCost = sum(selected.map((entry) => entry.metrics.estimated_cost_usd));
    const interventions = selected.map((entry) => entry.metrics.human_interventions);
    const knownInterventions = interventions.filter((value): value is number => value !== null);
    return {
      lane,
      case_count: selected.length,
      verified_committed_completion: verifiedCommitted,
      first_pass_verified: firstPass,
      recovered_verified: recovered,
      verified_noop: count("verified_noop"),
      truthful_fixture_blocker: count("truthful_fixture_blocker"),
      truthful_ambiguity_blocker: count("truthful_ambiguity_blocker"),
      genuine_product_limitation_blocker: count("genuine_product_limitation_blocker"),
      avoidable_clarification: count("avoidable_clarification"),
      execution_failure: count("execution_failure"),
      verification_evidence_failure: count("verification_evidence_failure"),
      infrastructure_harness_failure: count("infrastructure_harness_failure"),
      false_completion: count("false_completion"),
      collateral_or_unauthorized_mutation: count("collateral_or_unauthorized_mutation"),
      median_completion_time_ms: percentile(durations, 0.5),
      p95_completion_time_ms: percentile(durations, 0.95),
      model_calls: sum(selected.map((entry) => entry.metrics.model_calls)),
      revit_calls: sum(selected.map((entry) => entry.metrics.revit_calls)),
      repeated_no_progress_calls: sum(selected.map((entry) => entry.metrics.repeated_no_progress_calls)),
      tokens_per_verified_task: verifiedTaskCount > 0 ? totalTokens / verifiedTaskCount : null,
      estimated_cost_per_verified_task_usd: verifiedTaskCount > 0 ? totalCost / verifiedTaskCount : null,
      human_interventions: knownInterventions.length === interventions.length ? sum(knownInterventions) : null,
      primary_delivered_labor_rate: selected.length === 0 ? 0 : verifiedCommitted / selected.length,
      release_blocked: selected.some((entry) => entry.release_blocking)
    };
  });
}

export function benchmarkProtocolV2Markdown(report: BenchmarkRawReportV2): string {
  const lanes = summarizeBenchmarkLanesV2(report.cases);
  const lines = [
    "# Benchmark Protocol V2 report",
    "",
    `- Run: \`${report.envelope.identity.run_id}\``,
    `- Protocol: \`${report.envelope.protocol_version}\``,
    `- Evaluator: \`${report.envelope.evaluator_version}\``,
    `- Raw report SHA-256: \`${report.report_sha256}\``,
    "",
    "## Lane results",
    "",
    "Accepted and safe previews are deliberately excluded from the primary delivered-labor rate.",
    "",
    "| Lane | Cases | Verified committed | First pass | Recovered | Verified no-op | Fixture blocker | Ambiguity blocker | Product limit | Avoidable clarification | Execution fail | Verification fail | Infra fail | False completion | Collateral | Delivered rate | Release blocked |",
    "|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|"
  ];
  for (const lane of lanes) {
    lines.push(`| ${lane.lane} | ${lane.case_count} | ${lane.verified_committed_completion} | ${lane.first_pass_verified} | ${lane.recovered_verified} | ${lane.verified_noop} | ${lane.truthful_fixture_blocker} | ${lane.truthful_ambiguity_blocker} | ${lane.genuine_product_limitation_blocker} | ${lane.avoidable_clarification} | ${lane.execution_failure} | ${lane.verification_evidence_failure} | ${lane.infrastructure_harness_failure} | ${lane.false_completion} | ${lane.collateral_or_unauthorized_mutation} | ${(lane.primary_delivered_labor_rate * 100).toFixed(1)}% | ${lane.release_blocked ? "YES" : "no"} |`);
  }
  lines.push("", "## Efficiency by lane", "",
    "| Lane | Median completion | p95 completion | Model calls | Revit calls | Repeated no-progress calls | Tokens / verified task | Estimated cost / verified task | Human interventions |",
    "|---|---:|---:|---:|---:|---:|---:|---:|---:|");
  for (const lane of lanes) {
    lines.push(`| ${lane.lane} | ${lane.median_completion_time_ms ?? "n/a"} ms | ${lane.p95_completion_time_ms ?? "n/a"} ms | ${lane.model_calls} | ${lane.revit_calls} | ${lane.repeated_no_progress_calls} | ${lane.tokens_per_verified_task ?? "n/a"} | ${lane.estimated_cost_per_verified_task_usd ?? "n/a"} | ${lane.human_interventions ?? "unknown"} |`);
  }
  lines.push("", "## Cases", "", "| Case | Lane | Execution truth | Original evaluator | Current evaluator | Presentation | Delivery | First failed/uncertain stage | Primary cause |", "|---|---|---|---|---|---|---|---|---|");
  for (const result of report.cases) {
    lines.push(`| ${result.case_id} | ${result.lane} | ${result.execution_truth.effect_state} | ${result.original_evaluator_verdict.verdict} | ${result.current_evaluator_verdict.verdict} | ${result.presentation_verdict.verdict} | ${result.delivery_verdict} | ${result.first_failed_or_uncertain_stage ?? "none"} | ${result.primary_failure_cause ?? "none"} |`);
  }
  lines.push("", "False verified completion and unauthorized/collateral mutation are release-blocking categories.", "");
  return lines.join("\n");
}

export function writeBenchmarkRawReportV2(outputPath: string, report: BenchmarkRawReportV2): { json_path: string; markdown_path: string } {
  if (fs.existsSync(outputPath)) throw new Error(`Immutable raw report already exists: ${outputPath}`);
  validateBenchmarkRawReportV2(report);
  const markdownPath = outputPath.replace(/\.json$/i, ".md");
  if (fs.existsSync(markdownPath)) throw new Error(`Immutable report companion already exists: ${markdownPath}`);
  writeJsonFileNew(outputPath, report);
  writeTextFileNew(markdownPath, benchmarkProtocolV2Markdown(report));
  return { json_path: path.resolve(outputPath), markdown_path: path.resolve(markdownPath) };
}

export function readBenchmarkRawReportV2(inputPath: string): BenchmarkRawReportV2 {
  const report = readJsonFile<BenchmarkRawReportV2>(inputPath);
  validateBenchmarkRawReportV2(report);
  return report;
}
