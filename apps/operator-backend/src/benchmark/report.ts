import fs from "node:fs";
import path from "node:path";
import { nowIso, recursiveFindRunJsonFiles, readJsonFile, writeJsonFile, writeTextFile } from "./files.js";
import type {
  BenchmarkConfigAggregate,
  BenchmarkConfigBundle,
  BenchmarkDemoReadinessGate,
  BenchmarkReport,
  BenchmarkRevitWorkflowSummary,
  BenchmarkRunRecord,
  BenchmarkTaskAggregate
} from "./types.js";

function mean(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function percentile(values: number[], ratio: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * ratio) - 1));
  return sorted[index] ?? null;
}

function gradeOf(run: BenchmarkRunRecord): "success" | "partial" | "fail" | "invalid_run" {
  if (run.manual_grade_value) return run.manual_grade_value;
  if (run.success_label === "success") return "success";
  if (run.success_label === "partial") return "partial";
  return "fail";
}

function toConfigAggregate(
  configId: string,
  runs: BenchmarkRunRecord[],
  baselineRuns: BenchmarkRunRecord[]
): BenchmarkConfigAggregate {
  const grades = runs.map((run) => gradeOf(run));
  const successes = grades.filter((grade) => grade === "success").length;
  const partials = grades.filter((grade) => grade === "partial").length;
  const fails = grades.filter((grade) => grade === "fail").length;
  const invalids = grades.filter((grade) => grade === "invalid_run").length;
  const averageWall = mean(runs.map((run) => run.total_wall_clock_seconds));
  const averageCost = mean(runs.map((run) => run.estimated_total_cost_usd));
  const baselineAverageWall = baselineRuns.length > 0 ? mean(baselineRuns.map((run) => run.total_wall_clock_seconds)) : 0;
  const successRate = runs.length > 0 ? successes / runs.length : 0;

  return {
    config_id: configId,
    sample_size: runs.length,
    success_rate: successRate,
    partial_rate: runs.length > 0 ? partials / runs.length : 0,
    fail_rate: runs.length > 0 ? fails / runs.length : 0,
    invalid_rate: runs.length > 0 ? invalids / runs.length : 0,
    average_wall_clock_seconds: averageWall,
    average_model_latency_seconds: mean(runs.map((run) => run.total_model_latency_seconds)),
    average_tool_latency_seconds: mean(runs.map((run) => run.total_tool_latency_seconds)),
    average_cost_usd: averageCost,
    average_steps: mean(runs.map((run) => run.total_steps)),
    average_time_to_first_action_seconds:
      runs.some((run) => run.time_to_first_meaningful_action_seconds !== null)
        ? mean(
            runs
              .map((run) => run.time_to_first_meaningful_action_seconds)
              .filter((value): value is number => value !== null)
          )
        : null,
    average_replanning_seconds: mean(runs.map((run) => run.time_spent_in_replanning_seconds)),
    average_retry_seconds: mean(runs.map((run) => run.time_lost_to_retries_seconds)),
    steps_per_minute: mean(runs.map((run) => run.steps_per_minute)),
    successful_tasks_per_hour_equivalent: averageWall > 0 ? (successRate * 3600) / averageWall : 0,
    p50_latency_seconds: runs.length >= 2 ? percentile(runs.map((run) => run.total_wall_clock_seconds), 0.5) : null,
    p95_latency_seconds: runs.length >= 5 ? percentile(runs.map((run) => run.total_wall_clock_seconds), 0.95) : null,
    latency_normalized_success: averageWall > 0 ? successRate / averageWall : 0,
    cost_normalized_success: averageCost > 0 ? successRate / averageCost : 0,
    relative_speedup_vs_baseline:
      baselineAverageWall > 0 && averageWall > 0 ? baselineAverageWall / averageWall : null
  };
}

function toTaskAggregates(runs: BenchmarkRunRecord[]): BenchmarkTaskAggregate[] {
  const grouped = new Map<string, BenchmarkRunRecord[]>();
  for (const run of runs) {
    const key = `${run.task_id}::${run.config_id}`;
    grouped.set(key, [...(grouped.get(key) ?? []), run]);
  }
  return [...grouped.entries()]
    .map(([key, group]) => {
      const [taskId, configId] = key.split("::");
      const successRate = group.length > 0 ? group.filter((run) => gradeOf(run) === "success").length / group.length : 0;
      return {
        task_id: taskId ?? "",
        config_id: configId ?? "",
        sample_size: group.length,
        success_rate: successRate,
        average_wall_clock_seconds: mean(group.map((run) => run.total_wall_clock_seconds)),
        average_cost_usd: mean(group.map((run) => run.estimated_total_cost_usd))
      };
    })
    .sort((a, b) => `${a.task_id}|${a.config_id}`.localeCompare(`${b.task_id}|${b.config_id}`));
}

function markdownTable(headers: string[], rows: string[][]): string {
  const lines = [
    `| ${headers.join(" | ")} |`,
    `| ${headers.map(() => "---").join(" | ")} |`
  ];
  for (const row of rows) lines.push(`| ${row.join(" | ")} |`);
  return lines.join("\n");
}

function pct(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

function n(value: number): string {
  return value.toFixed(2);
}

function asObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function executionSource(value: unknown): BenchmarkRevitWorkflowSummary["execution_source"] {
  return value === "live" || value === "mock" || value === "injected" ? value : "unknown";
}

function verificationName(entry: Record<string, unknown>): string | null {
  return typeof entry.name === "string" && entry.name.trim() ? entry.name.trim() : null;
}

export function loadRunRecords(artifactsDir: string): BenchmarkRunRecord[] {
  return recursiveFindRunJsonFiles(artifactsDir).map((filePath) => readJsonFile<BenchmarkRunRecord>(filePath));
}

function loadRevitWorkflowSummaries(runs: BenchmarkRunRecord[]): BenchmarkRevitWorkflowSummary[] {
  const summaries: BenchmarkRevitWorkflowSummary[] = [];
  for (const run of runs) {
    const resultPath = path.join(run.artifact_dir, "revit_workflow_result.json");
    if (!fs.existsSync(resultPath)) continue;
    const result = asObject(readJsonFile<unknown>(resultPath));
    const verifications = Array.isArray(result.verification_results) ? result.verification_results.map(asObject) : [];
    const verificationNamesPassed = verifications
      .filter((entry) => entry.ok === true)
      .map(verificationName)
      .filter((name): name is string => name !== null);
    const verificationNamesFailed = verifications
      .filter((entry) => entry.ok !== true)
      .map(verificationName)
      .filter((name): name is string => name !== null);
    summaries.push({
      run_id: run.run_id,
      task_id: run.task_id,
      config_id: run.config_id,
      workflow: String(result.workflow ?? ""),
      execution_source: executionSource(result.execution_source),
      success: result.success === true,
      elapsed_seconds: Number(result.elapsed_seconds ?? 0),
      tool_calls: Number(result.tool_calls ?? 0),
      revit_transactions: Number(result.revit_transactions ?? 0),
      computer_use_actions: Number(result.computer_use_actions ?? 0),
      output_artifact_count: Array.isArray(result.output_artifacts) ? result.output_artifacts.length : 0,
      verification_passed: verifications.filter((entry) => entry.ok === true).length,
      verification_total: verifications.length,
      verification_names_passed: verificationNamesPassed,
      verification_names_failed: verificationNamesFailed,
      failure_reason: typeof result.failure_reason === "string" ? result.failure_reason : null,
      failure_classification: typeof result.failure_classification === "string" ? result.failure_classification : null
    });
  }
  return summaries.sort((a, b) => `${a.task_id}|${a.config_id}|${a.run_id}`.localeCompare(`${b.task_id}|${b.config_id}|${b.run_id}`));
}

const DEMO_READINESS_TARGETS: Record<string, { workflow: string; successRate: number; elapsedSeconds: number; minLiveSamples: number }> = {
  demo_sheet_export: { workflow: "sheet_export", successRate: 0.95, elapsedSeconds: 60, minLiveSamples: 5 },
  demo_takeoff_receptacles: { workflow: "takeoff_csv", successRate: 0.98, elapsedSeconds: 30, minLiveSamples: 5 },
  demo_parameter_edit: { workflow: "parameter_edit", successRate: 0.98, elapsedSeconds: 30, minLiveSamples: 5 },
  demo_redline_receptacles: { workflow: "redline_receptacles", successRate: 0.8, elapsedSeconds: 180, minLiveSamples: 5 }
};

const REDLINE_REQUIRED_LIVE_VERIFICATIONS = [
  "created_expected_count",
  "audit_passed",
  "audit_contains_created_ids",
  "audit_host_evidence_ok",
  "created_room_matches_expected",
  "cleanup_completed_when_requested"
];

const REDLINE_REQUIRED_CIRCUIT_VERIFICATIONS = [
  "created_circuit_matches_expected",
  "created_circuit_matches_source_when_requested"
];

function hasPassedVerification(entry: BenchmarkRevitWorkflowSummary, name: string): boolean {
  return entry.verification_names_passed.includes(name);
}

function missingRedlineEvidence(entry: BenchmarkRevitWorkflowSummary): string[] {
  const missing = REDLINE_REQUIRED_LIVE_VERIFICATIONS.filter((name) => !hasPassedVerification(entry, name));
  if (!REDLINE_REQUIRED_CIRCUIT_VERIFICATIONS.some((name) => hasPassedVerification(entry, name))) {
    missing.push(`one of ${REDLINE_REQUIRED_CIRCUIT_VERIFICATIONS.join("|")}`);
  }
  return missing;
}

function buildDemoReadinessGates(summaries: BenchmarkRevitWorkflowSummary[]): BenchmarkDemoReadinessGate[] {
  return Object.entries(DEMO_READINESS_TARGETS).map(([taskId, target]) => {
    const group = summaries.filter((entry) => entry.task_id === taskId);
    const liveGroup = group.filter((entry) => entry.execution_source === "live");
    const strongEvidenceFailures =
      taskId === "demo_redline_receptacles"
        ? liveGroup
            .map((entry) => ({ entry, missing: missingRedlineEvidence(entry) }))
            .filter(({ missing }) => missing.length > 0)
        : [];
    const successes = group.filter((entry) => entry.success).length;
    const verificationTotal = group.reduce((sum, entry) => sum + entry.verification_total, 0);
    const verificationPassed = group.reduce((sum, entry) => sum + entry.verification_passed, 0);
    const successRate = group.length > 0 ? successes / group.length : 0;
    const averageElapsed = mean(group.map((entry) => entry.elapsed_seconds));
    const verificationPassRate = verificationTotal > 0 ? verificationPassed / verificationTotal : 0;
    const passed =
      group.length > 0 &&
      liveGroup.length >= target.minLiveSamples &&
      successRate >= target.successRate &&
      averageElapsed <= target.elapsedSeconds &&
      verificationPassRate === 1 &&
      strongEvidenceFailures.length === 0;
    const reasons: string[] = [];
    if (group.length === 0) reasons.push("no runs");
    if (group.length > 0 && liveGroup.length === 0) reasons.push("no live Revit runs");
    if (liveGroup.length > 0 && liveGroup.length < target.minLiveSamples) {
      reasons.push(`live runs ${liveGroup.length} < minimum ${target.minLiveSamples}`);
    }
    if (successRate < target.successRate) reasons.push(`success ${pct(successRate)} < target ${pct(target.successRate)}`);
    if (averageElapsed > target.elapsedSeconds) reasons.push(`elapsed ${n(averageElapsed)}s > target ${target.elapsedSeconds}s`);
    if (verificationPassRate < 1) reasons.push(`verification ${pct(verificationPassRate)} < 100.0%`);
    if (strongEvidenceFailures.length > 0) {
      const samples = strongEvidenceFailures
        .slice(0, 3)
        .map(({ entry, missing }) => `${entry.run_id}: missing ${missing.join(", ")}`);
      reasons.push(`redline evidence incomplete (${samples.join("; ")})`);
    }
    return {
      task_id: taskId,
      workflow: target.workflow,
      sample_size: group.length,
      live_sample_size: liveGroup.length,
      min_live_sample_size: target.minLiveSamples,
      success_rate: successRate,
      target_success_rate: target.successRate,
      average_elapsed_seconds: averageElapsed,
      target_elapsed_seconds: target.elapsedSeconds,
      verification_pass_rate: verificationPassRate,
      passed,
      reason: reasons.length > 0 ? reasons.join("; ") : "passed"
    };
  });
}

export function generateBenchmarkReport(artifactsDir: string, bundle: BenchmarkConfigBundle): BenchmarkReport {
  const runs = loadRunRecords(artifactsDir);
  const revitWorkflowSummaries = loadRevitWorkflowSummaries(runs);
  const demoReadinessGates = buildDemoReadinessGates(revitWorkflowSummaries);
  const baselineRuns = runs.filter((run) => run.config_id === bundle.baseline_config_id);
  const groupedByConfig = new Map<string, BenchmarkRunRecord[]>();
  for (const run of runs) groupedByConfig.set(run.config_id, [...(groupedByConfig.get(run.config_id) ?? []), run]);

  const configAggregates = [...groupedByConfig.entries()]
    .map(([configId, group]) => toConfigAggregate(configId, group, baselineRuns))
    .sort((a, b) => a.average_wall_clock_seconds - b.average_wall_clock_seconds);
  const taskAggregates = toTaskAggregates(runs);
  const acceptableConfigs = configAggregates.filter((entry) => entry.success_rate >= bundle.acceptable_success_rate_threshold);
  const fastest = configAggregates[0] ?? null;
  const bestTradeoff = [...configAggregates].sort((a, b) => b.latency_normalized_success - a.latency_normalized_success)[0] ?? null;
  const cheapestAcceptable = [...acceptableConfigs].sort((a, b) => a.average_cost_usd - b.average_cost_usd)[0] ?? null;
  const safestFallback = [...configAggregates].sort((a, b) => b.success_rate - a.success_rate)[0] ?? null;
  const fastestExperimental =
    [...configAggregates]
      .filter((entry) => entry.config_id !== bundle.baseline_config_id)
      .sort((a, b) => a.average_wall_clock_seconds - b.average_wall_clock_seconds)[0] ?? null;

  const lowReasoningTaskFailures = taskAggregates
    .filter((entry) => /mini_(?:low|none)|54mini_(?:low|none)/i.test(entry.config_id) && entry.success_rate < bundle.acceptable_success_rate_threshold)
    .map((entry) => `${entry.task_id} on ${entry.config_id}`);

  const conclusions: string[] = [];
  if (fastest) conclusions.push(`Fastest config overall: ${fastest.config_id}.`);
  if (bestTradeoff) conclusions.push(`Best success/latency tradeoff: ${bestTradeoff.config_id}.`);
  if (cheapestAcceptable) conclusions.push(`Cheapest acceptable config: ${cheapestAcceptable.config_id}.`);
  if (safestFallback) conclusions.push(`Safe fallback config: ${safestFallback.config_id}.`);
  if (lowReasoningTaskFailures.length > 0) {
    conclusions.push(`Tasks that degrade under low/none reasoning: ${lowReasoningTaskFailures.join("; ")}.`);
  }
  const bestSplit = configAggregates.filter((entry) => entry.config_id.includes("split_")).sort((a, b) => a.average_wall_clock_seconds - b.average_wall_clock_seconds)[0] ?? null;
  const baseline = configAggregates.find((entry) => entry.config_id === bundle.baseline_config_id) ?? null;
  if (bestSplit && baseline) {
    const verdict =
      bestSplit.average_wall_clock_seconds < baseline.average_wall_clock_seconds &&
      bestSplit.success_rate >= baseline.success_rate - 0.05
        ? "does"
        : "does not";
    conclusions.push(`Best split config ${verdict} beat the baseline single-loop setup on speed without materially worse success.`);
  }
  if (configAggregates.some((entry) => entry.sample_size < 5)) {
    conclusions.push("Sample sizes are small; treat p95 and recommendation confidence cautiously.");
  }

  return {
    generated_at: nowIso(),
    artifacts_dir: artifactsDir,
    baseline_config_id: bundle.baseline_config_id,
    runs_analyzed: runs.length,
    small_sample_warning: configAggregates.some((entry) => entry.sample_size < 5),
    config_aggregates: configAggregates,
    task_aggregates: taskAggregates,
    revit_workflow_summaries: revitWorkflowSummaries,
    demo_readiness_gates: demoReadinessGates,
    fastest_config_id: fastest?.config_id ?? null,
    best_tradeoff_config_id: bestTradeoff?.config_id ?? null,
    cheapest_acceptable_config_id: cheapestAcceptable?.config_id ?? null,
    safest_fallback_config_id: safestFallback?.config_id ?? null,
    fastest_experimental_config_id: fastestExperimental?.config_id ?? null,
    conclusions
  };
}

export function writeBenchmarkReportArtifacts(
  artifactsDir: string,
  bundle: BenchmarkConfigBundle,
  outputPath?: string
): { report: BenchmarkReport; json_path: string; markdown_path: string } {
  const report = generateBenchmarkReport(artifactsDir, bundle);
  const reportsDir = outputPath ? path.dirname(outputPath) : path.join(artifactsDir, "reports");
  const markdownPath = outputPath || path.join(reportsDir, "summary.md");
  const jsonPath = path.join(reportsDir, "summary.json");

  const latencyRows = report.config_aggregates.map((entry) => [
    entry.config_id,
    String(entry.sample_size),
    n(entry.average_wall_clock_seconds),
    entry.p50_latency_seconds === null ? "n/a" : n(entry.p50_latency_seconds),
    entry.p95_latency_seconds === null ? "n/a" : n(entry.p95_latency_seconds),
    entry.relative_speedup_vs_baseline === null ? "n/a" : `${entry.relative_speedup_vs_baseline.toFixed(2)}x`
  ]);
  const successRows = report.config_aggregates.map((entry) => [
    entry.config_id,
    pct(entry.success_rate),
    pct(entry.partial_rate),
    pct(entry.fail_rate),
    pct(entry.invalid_rate)
  ]);
  const costRows = report.config_aggregates.map((entry) => [
    entry.config_id,
    `$${entry.average_cost_usd.toFixed(4)}`,
    entry.cost_normalized_success.toFixed(4),
    entry.latency_normalized_success.toFixed(4)
  ]);
  const taskRows = report.task_aggregates.map((entry) => [
    entry.task_id,
    entry.config_id,
    String(entry.sample_size),
    pct(entry.success_rate),
    n(entry.average_wall_clock_seconds),
    `$${entry.average_cost_usd.toFixed(4)}`
  ]);
  const revitRows = report.revit_workflow_summaries.map((entry) => [
    entry.task_id,
    entry.config_id,
    entry.workflow,
    entry.execution_source,
    entry.success ? "yes" : "no",
    n(entry.elapsed_seconds),
    String(entry.tool_calls),
    String(entry.revit_transactions),
    String(entry.computer_use_actions),
    `${entry.verification_passed}/${entry.verification_total}`,
    String(entry.output_artifact_count),
    entry.failure_classification ?? "",
    entry.failure_reason ?? ""
  ]);
  const readinessRows = report.demo_readiness_gates.map((entry) => [
    entry.task_id,
    entry.workflow,
    String(entry.sample_size),
    String(entry.live_sample_size),
    String(entry.min_live_sample_size),
    pct(entry.success_rate),
    pct(entry.target_success_rate),
    n(entry.average_elapsed_seconds),
    String(entry.target_elapsed_seconds),
    pct(entry.verification_pass_rate),
    entry.passed ? "yes" : "no",
    entry.reason
  ]);

  const lines: string[] = [];
  lines.push("# Operator Benchmark Report");
  lines.push("");
  lines.push(`- Generated: ${report.generated_at}`);
  lines.push(`- Artifacts: ${artifactsDir}`);
  lines.push(`- Runs analyzed: ${report.runs_analyzed}`);
  lines.push(`- Baseline config: ${report.baseline_config_id}`);
  lines.push(`- Small sample warning: ${report.small_sample_warning ? "yes" : "no"}`);
  lines.push("");
  lines.push("## Leaderboards");
  lines.push("");
  lines.push("### Latency");
  lines.push(markdownTable(["Config", "N", "Avg wall (s)", "p50", "p95", "Speedup vs baseline"], latencyRows));
  lines.push("");
  lines.push("### Success");
  lines.push(markdownTable(["Config", "Success", "Partial", "Fail", "Invalid"], successRows));
  lines.push("");
  lines.push("### Cost");
  lines.push(markdownTable(["Config", "Avg cost", "Cost-normalized success", "Latency-normalized success"], costRows));
  lines.push("");
  lines.push("## Per-Task Comparison");
  lines.push(markdownTable(["Task", "Config", "N", "Success", "Avg wall (s)", "Avg cost"], taskRows));
  lines.push("");
  if (revitRows.length > 0) {
    lines.push("## Revit Workflow Evidence");
    lines.push(markdownTable(
      ["Task", "Config", "Workflow", "Source", "Success", "Elapsed (s)", "Tool calls", "Transactions", "Computer-use", "Verifications", "Artifacts", "Failure class", "Failure"],
      revitRows
    ));
    lines.push("");
  }
  lines.push("## Demo Readiness Gates");
  lines.push(markdownTable(
    ["Task", "Workflow", "N", "Live N", "Min live N", "Success", "Target success", "Avg elapsed (s)", "Target (s)", "Verification", "Passed", "Reason"],
    readinessRows
  ));
  lines.push("");
  lines.push("## Conclusions");
  if (report.conclusions.length === 0) lines.push("- No conclusions available.");
  for (const conclusion of report.conclusions) lines.push(`- ${conclusion}`);
  lines.push("");
  lines.push("## Notes");
  lines.push("- Escalation frequency and retry counts are available in per-run `run.json` and `steps.jsonl`.");
  lines.push("- If sample sizes are below five runs per config, treat ranking differences as directional.");

  writeJsonFile(jsonPath, report);
  writeTextFile(markdownPath, `${lines.join("\n")}\n`);
  return { report, json_path: jsonPath, markdown_path: markdownPath };
}
