type JsonRecord = Record<string, unknown>;

function asRecord(value: unknown): JsonRecord {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonRecord : {};
}

function numberValue(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function percent(value: unknown): string {
  return `${(numberValue(value) * 100).toFixed(1)}%`;
}

function nullableNumber(value: unknown): string {
  return typeof value === "number" && Number.isFinite(value) ? value.toLocaleString() : "unknown";
}

function durationSeconds(value: unknown): string {
  return typeof value === "number" && Number.isFinite(value) ? `${(value / 1000).toFixed(1)}s` : "unknown";
}

function delta(current: unknown, previous: unknown): string {
  const change = (numberValue(current) - numberValue(previous)) * 100;
  return `${change >= 0 ? "+" : ""}${change.toFixed(1)} pp`;
}

export function markdownReport(report: JsonRecord): string {
  const summary = asRecord(report.summary);
  const baseline = asRecord(report.baseline_comparison);
  const baselineSummary = asRecord(baseline.summary);
  const traces = Array.isArray(report.task_traces) ? report.task_traces.map(asRecord) : [];
  const computerAgent = asRecord(asRecord(report.suite_context).computer_agent);
  const requestedComputerAgent = asRecord(computerAgent.requested);
  const observedProviderCalls = asRecord(computerAgent.observed_provider_calls);
  const observedRoles = Array.isArray(observedProviderCalls.roles) ? observedProviderCalls.roles.map(asRecord) : [];
  const suiteTiming = asRecord(report.suite_timing);
  const lines = [
    "# General Revit benchmark result",
    "",
    `- Run: \`${String(report.run_id || "")}\``,
    `- Label: ${String(report.label || "unlabeled")}`,
    `- Generated: ${String(report.generated_at || "")}`,
    `- Mode: ${asRecord(report.suite_context).mutation_policy || "unknown"}`,
    `- Execution surface: ${asRecord(report.suite_context).execution_surface || "unknown"}`,
    `- Suite start: ${String(suiteTiming.started_at_utc || "unknown")}`,
    `- Suite finish: ${String(suiteTiming.finished_at_utc || "unknown")}`,
    `- Suite wall clock: ${durationSeconds(suiteTiming.wall_clock_ms)}`,
    `- Cases: ${numberValue(summary.total)}`,
    `- Non-refusal: ${percent(summary.non_refusal_rate)} (${numberValue(summary.non_refusal_count)}/${numberValue(summary.total)})`,
    `- Completion: ${percent(summary.completion_rate)} (${numberValue(summary.completed_count)}/${numberValue(summary.total)})`,
    `- Verification: ${percent(summary.verification_rate)} (${numberValue(summary.verified_count)}/${numberValue(summary.total)})`,
    `- Refused: ${numberValue(summary.refusal_count)}`,
    `- Failed: ${numberValue(summary.failure_count)}`,
    `- Wrong sample fixture: ${numberValue(report.fixture_mismatch_count)}`,
    `- Fixture unverifiable: ${numberValue(report.fixture_unverifiable_count)}`,
    `- Fixture-grounded answer checks: ${numberValue(report.selected_answer_assertion_case_count)}/${numberValue(summary.total)}`,
    "",
    "## Model configuration and usage",
    "",
    "Requested configuration comes from benchmark CLI flags. Observed models come only from provider receipts; a request is not treated as proof that the provider used it.",
    "",
    "| Role | Requested | Observed | Calls | Provider duration | Tokens | Cost |",
    "|---|---|---|---:|---:|---:|---|"
  ];
  for (const roleName of ["planner", "executor", "outer"]) {
    const role = observedRoles.find((entry) => entry.role === roleName) || {};
    const requestedModel = requestedComputerAgent[`${roleName}_model`] ?? computerAgent[`${roleName}_model`] ?? "unspecified";
    const requestedEffort = requestedComputerAgent[`${roleName}_reasoning_effort`] ?? computerAgent[`${roleName}_reasoning_effort`] ?? "unspecified";
    const models = Array.isArray(role.observed_models) ? role.observed_models.map(String) : [];
    const efforts = Array.isArray(role.observed_reasoning_efforts) ? role.observed_reasoning_efforts.map(String) : [];
    const observed = models.length > 0 ? `${models.join(", ")} / ${efforts.join(", ") || "unknown"}` : "no receipt";
    lines.push(`| ${roleName} | ${String(requestedModel)} / ${String(requestedEffort)} | ${observed} | ${numberValue(role.call_count)} | ${durationSeconds(role.provider_duration_ms)} | ${nullableNumber(role.total_tokens)} | missing pricing |`);
  }
  lines.push("", `Configuration drift detected: ${observedProviderCalls.configuration_drift_detected === true ? "yes" : "no"}. Cost is \`null\` until an authoritative versioned price is available for every observed model.`, "");
  if (baseline.path) {
    lines.push(
      "## Baseline comparison",
      "",
      `Baseline: \`${String(baseline.path)}\``,
      "",
      "| Metric | Current | Baseline | Change |",
      "|---|---:|---:|---:|",
      `| Non-refusal | ${percent(summary.non_refusal_rate)} | ${percent(baselineSummary.non_refusal_rate)} | ${delta(summary.non_refusal_rate, baselineSummary.non_refusal_rate)} |`,
      `| Completion | ${percent(summary.completion_rate)} | ${percent(baselineSummary.completion_rate)} | ${delta(summary.completion_rate, baselineSummary.completion_rate)} |`,
      `| Verification | ${percent(summary.verification_rate)} | ${percent(baselineSummary.verification_rate)} | ${delta(summary.verification_rate, baselineSummary.verification_rate)} |`,
      ""
    );
    const caseDeltas = Array.isArray(report.baseline_case_deltas) ? report.baseline_case_deltas.map(asRecord) : [];
    if (caseDeltas.length > 0) {
      lines.push("### Changed cases", "", "| Case | Before | After |", "|---|---|---|");
      for (const row of caseDeltas) lines.push(`| ${String(row.case_id || "")} | ${String(row.from_tier || "not_run")} | ${String(row.to_tier || "not_run")} |`);
      lines.push("");
    }
  }
  const bySpecificity = asRecord(report.summary_by_specificity);
  lines.push("## Prompt specificity", "", "| Specificity | Cases | Non-refusal | Completion | Verification |", "|---|---:|---:|---:|---:|");
  for (const [specificity, value] of Object.entries(bySpecificity)) {
    const row = asRecord(value);
    lines.push(`| ${specificity} | ${numberValue(row.total)} | ${percent(row.non_refusal_rate)} | ${percent(row.completion_rate)} | ${percent(row.verification_rate)} |`);
  }
  lines.push("");
  const byFixture = asRecord(report.summary_by_fixture);
  lines.push("## Preferred sample fixture", "", "| Fixture | Cases | Non-refusal | Completion | Verification |", "|---|---:|---:|---:|---:|");
  for (const [fixture, value] of Object.entries(byFixture)) {
    const row = asRecord(value);
    lines.push(`| ${fixture} | ${numberValue(row.total)} | ${percent(row.non_refusal_rate)} | ${percent(row.completion_rate)} | ${percent(row.verification_rate)} |`);
  }
  lines.push("");
  const byVerificationBasis = asRecord(report.summary_by_verification_basis);
  lines.push("## Verification basis", "", "| Basis | Cases |", "|---|---:|");
  for (const [basis, count] of Object.entries(byVerificationBasis)) lines.push(`| ${basis} | ${numberValue(count)} |`);
  lines.push("", "These labels describe the strongest recorded evidence for each case; they do not make generic receipts equivalent to fixture-grounded semantic or target-bound model-state proof.", "");
  const byCorpusType = asRecord(report.summary_by_corpus_task_type);
  lines.push("## Results by redline task type", "", "| Corpus task type | Cases | Non-refusal | Completion | Verification |", "|---|---:|---:|---:|---:|");
  for (const [taskType, value] of Object.entries(byCorpusType)) {
    const row = asRecord(value);
    lines.push(`| ${taskType} | ${numberValue(row.total)} | ${percent(row.non_refusal_rate)} | ${percent(row.completion_rate)} | ${percent(row.verification_rate)} |`);
  }
  lines.push("");
  const coverage = asRecord(report.corpus_coverage);
  const taskTypes = Array.isArray(coverage.task_types) ? coverage.task_types.map(asRecord) : [];
  lines.push(
    "## Frozen redline-corpus coverage",
    "",
    `The benchmark maps ${numberValue(coverage.covered_task_type_count)}/${numberValue(coverage.top_task_type_count)} frozen top task types, representing ${numberValue(coverage.mapped_comment_total).toLocaleString()} comments (${percent(coverage.mapped_actionable_comment_rate)} of ${numberValue(coverage.actionable_comment_total).toLocaleString()} actionable comments). Coverage is a task-selection measure, not a performance claim.`,
    "",
    "| Rank | Corpus task type | Comments | Mapping | Benchmark cases |",
    "|---:|---|---:|---|---|"
  );
  for (const row of taskTypes) {
    const ids = Array.isArray(row.case_ids) ? row.case_ids.map(String) : [];
    lines.push(`| ${numberValue(row.rank)} | ${String(row.task_type_id || "")} | ${numberValue(row.corpus_count).toLocaleString()} | ${String(row.coverage_kind || "gap")} | ${ids.join(", ")} |`);
  }
  lines.push("");
  lines.push("## Cases", "", "| Case | Source | Operation | Tier | Verification basis | Duration |", "|---|---|---|---|---|---:|");
  for (const trace of traces) {
    const score = asRecord(trace.success_failure_score);
    const efficiency = asRecord(trace.efficiency);
    const evaluation = asRecord(asRecord(trace.verification_results).evaluation);
    lines.push(`| ${String(trace.case_id || "").replaceAll("|", "\\|")} | ${String(trace.source || "")} | ${String(trace.operation_family || "")} | ${String(score.tier || "not_run")} | ${String(evaluation.verification_basis || "none")} | ${(numberValue(efficiency.duration_ms) / 1000).toFixed(1)}s |`);
  }
  lines.push("", "The suite is representative regression coverage, not a Revit capability allowlist. Non-refusal is not completion, and assistant prose alone is not verification.", "");
  return lines.join("\n");
}
