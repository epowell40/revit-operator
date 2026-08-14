import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  evaluateGeneralRevitCapabilityAttempt,
  generalRevitExecutionCase,
  generalRevitGroundingDemand,
  generalRevitPromptSpecificity,
  generalRevitResearchDemand,
  loadGeneralRevitCapabilityCorpus,
  summarizeGeneralRevitCorpusCoverage,
  summarizeGeneralRevitCapabilityReport,
  type GeneralRevitCapabilityCase,
  type GeneralRevitAttempt
} from "../benchmark/general_revit_capability_acceptance.js";
import { nowIso, readJsonFile, writeJsonFile, writeTextFile } from "../benchmark/files.js";
import {
  generalRevitFixtureForCase,
  loadGeneralRevitSampleFixtures
} from "../benchmark/general_revit_sample_fixtures.js";

type JsonRecord = Record<string, unknown>;

const SMOKE_CASE_IDS = new Set([
  "q01_air_device_inventory",
  "b07_grounded_equipment_rename",
  "b03_create_view",
  "s01_create_schedule",
  "v01_hide_show_category",
  "v06_create_apply_named_view_template",
  "r01_text_note_edit",
  "r04_delete_preview",
  "r07_type_change"
]);

function flagValues(name: string): string[] {
  const values: string[] = [];
  for (let index = 0; index < process.argv.length; index += 1) {
    if (process.argv[index] === name && process.argv[index + 1]) values.push(process.argv[index + 1]);
  }
  return values.flatMap((value) => value.split(",")).map((value) => value.trim()).filter(Boolean);
}

function flag(name: string, fallback = ""): string {
  return flagValues(name)[0] || fallback;
}

function asRecord(value: unknown): JsonRecord {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonRecord : {};
}

function healthDocumentTitle(health: JsonRecord): string {
  return String(asRecord(asRecord(health.context).document).title || "").trim();
}

function fixtureApplicability(preferredFixture: string, preferredDocumentTitle: string, health: JsonRecord): JsonRecord {
  const observedDocumentTitle = healthDocumentTitle(health);
  return {
    preferred_fixture: preferredFixture,
    preferred_document_title: preferredDocumentTitle,
    observed_document_title: observedDocumentTitle || null,
    fixture_match: observedDocumentTitle ? observedDocumentTitle === preferredDocumentTitle : null
  };
}

function sha256(value: unknown): string {
  return crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function id(prefix: string): string {
  return `${prefix}-${crypto.randomUUID()}`;
}

function healthTimeoutMs(): number {
  const parsed = Number.parseInt(flag("--health-timeout-ms", "120000"), 10);
  return Number.isFinite(parsed) ? Math.max(30_000, Math.min(10 * 60_000, parsed)) : 120_000;
}

function fixtureTimeoutMs(): number {
  const parsed = Number.parseInt(flag("--fixture-timeout-ms", "300000"), 10);
  return Number.isFinite(parsed) ? Math.max(60_000, Math.min(15 * 60_000, parsed)) : 300_000;
}

function executionSurface(): "operator_computer_general_agent" | "legacy_chat_diagnostic" {
  return process.argv.includes("--legacy-chat")
    ? "legacy_chat_diagnostic"
    : "operator_computer_general_agent";
}

async function requestJson(baseUrl: string, pathname: string, options: RequestInit = {}, timeoutMs = 120_000): Promise<JsonRecord> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(new Error(`${pathname} exceeded ${timeoutMs}ms.`)), timeoutMs);
  try {
    const origin = new URL(baseUrl).origin;
    const response = await fetch(new URL(pathname, `${baseUrl}/`), {
      ...options,
      headers: { "content-type": "application/json", origin, ...(options.headers || {}) },
      signal: controller.signal
    });
    const text = await response.text();
    let body: unknown = {};
    try { body = text ? JSON.parse(text) : {}; } catch { body = { raw: text }; }
    if (!response.ok) throw new Error(`${options.method || "GET"} ${pathname} returned ${response.status}: ${text.slice(0, 1000)}`);
    return asRecord(body);
  } finally {
    clearTimeout(timeout);
  }
}

function selectCases(cases: GeneralRevitCapabilityCase[]): GeneralRevitCapabilityCase[] {
  const suite = flag("--suite", "full").toLowerCase();
  if (!["smoke", "redline", "challenge", "terse", "research", "long-horizon", "production", "code-execution", "full"].includes(suite)) {
    throw new Error(`Unknown suite '${suite}'. Expected smoke, redline, challenge, terse, research, long-horizon, production, code-execution, or full.`);
  }
  const requestedIds = new Set(flagValues("--case"));
  const requestedSources = new Set(flagValues("--source"));
  const unknownIds = [...requestedIds].filter((caseId) => !cases.some((entry) => entry.case_id === caseId));
  if (unknownIds.length > 0) throw new Error(`Unknown case id(s): ${unknownIds.join(", ")}`);
  const filtered = cases.filter((entry) => (suite !== "smoke" || SMOKE_CASE_IDS.has(entry.case_id))
    && (suite !== "redline" || entry.source === "redline_corpus")
    && (suite !== "challenge" || entry.case_id.startsWith("c"))
    && (suite !== "terse" || entry.prompt.split(/\s+/).length <= 16)
    && (suite !== "research" || entry.operation_family === "research_and_compliance")
    && (suite !== "long-horizon" || entry.source === "long_horizon")
    && (suite !== "production" || entry.source === "document_production")
    && (suite !== "code-execution" || entry.source === "code_execution")
    && (requestedIds.size === 0 || requestedIds.has(entry.case_id))
    && (requestedSources.size === 0 || requestedSources.has(entry.source)));
  const limit = Number.parseInt(flag("--limit", `${filtered.length}`), 10);
  return filtered.slice(0, Number.isFinite(limit) && limit >= 0 ? limit : filtered.length);
}

function fileStamp(): string {
  return nowIso().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}

function numberValue(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function percent(value: unknown): string {
  return `${(numberValue(value) * 100).toFixed(1)}%`;
}

function delta(current: unknown, previous: unknown): string {
  const change = (numberValue(current) - numberValue(previous)) * 100;
  return `${change >= 0 ? "+" : ""}${change.toFixed(1)} pp`;
}

function baselineCaseDeltas(traces: JsonRecord[], baselineReport: JsonRecord | null): JsonRecord[] {
  if (!baselineReport) return [];
  const baselineTraces = new Map((Array.isArray(baselineReport.task_traces) ? baselineReport.task_traces : [])
    .map(asRecord).map((trace) => [String(trace.case_id || ""), trace] as const));
  return traces.flatMap((trace) => {
    const prior = baselineTraces.get(String(trace.case_id || ""));
    if (!prior) return [];
    const currentScore = asRecord(trace.success_failure_score);
    const priorScore = asRecord(prior.success_failure_score);
    if (JSON.stringify(currentScore) === JSON.stringify(priorScore)) return [];
    return [{
      case_id: trace.case_id,
      from_tier: priorScore.tier ?? "not_run",
      to_tier: currentScore.tier ?? "not_run",
      completion_changed: currentScore.completed !== priorScore.completed,
      verification_changed: currentScore.verified !== priorScore.verified
    }];
  });
}

function groupedSummary(traces: JsonRecord[], key: "operation_family" | "prompt_specificity" | "preferred_fixture"): Record<string, unknown> {
  const buckets = new Map<string, JsonRecord[]>();
  for (const trace of traces) {
    const bucket = String(trace[key] || "unknown");
    const rows = buckets.get(bucket) || [];
    rows.push(asRecord(asRecord(trace.verification_results).evaluation));
    buckets.set(bucket, rows);
  }
  return Object.fromEntries([...buckets.entries()].sort(([left], [right]) => left.localeCompare(right))
    .map(([bucket, evaluations]) => [bucket, summarizeGeneralRevitCapabilityReport(evaluations as never)]));
}

function groupedMultiSummary(traces: JsonRecord[], key: "corpus_task_types"): Record<string, unknown> {
  const buckets = new Map<string, JsonRecord[]>();
  for (const trace of traces) {
    const values = Array.isArray(trace[key]) ? trace[key].map(String) : [];
    for (const bucket of values.length > 0 ? values : ["unmapped"]) {
      const rows = buckets.get(bucket) || [];
      rows.push(asRecord(asRecord(trace.verification_results).evaluation));
      buckets.set(bucket, rows);
    }
  }
  return Object.fromEntries([...buckets.entries()].sort(([left], [right]) => left.localeCompare(right))
    .map(([bucket, evaluations]) => [bucket, summarizeGeneralRevitCapabilityReport(evaluations as never)]));
}

function markdownReport(report: JsonRecord): string {
  const summary = asRecord(report.summary);
  const baseline = asRecord(report.baseline_comparison);
  const baselineSummary = asRecord(baseline.summary);
  const traces = Array.isArray(report.task_traces) ? report.task_traces.map(asRecord) : [];
  const computerAgent = asRecord(asRecord(report.suite_context).computer_agent);
  const lines = [
    "# General Revit benchmark result",
    "",
    `- Run: \`${String(report.run_id || "")}\``,
    `- Label: ${String(report.label || "unlabeled")}`,
    `- Generated: ${String(report.generated_at || "")}`,
    `- Mode: ${asRecord(report.suite_context).mutation_policy || "unknown"}`,
    `- Execution surface: ${asRecord(report.suite_context).execution_surface || "unknown"}`,
    `- Computer model: ${String(computerAgent.outer_model || "unknown")}`,
    `- Planner: ${String(computerAgent.planner_model || "unknown")} / ${String(computerAgent.planner_reasoning_effort || "unknown")}`,
    `- Executor: ${String(computerAgent.executor_model || "unknown")} / ${String(computerAgent.executor_reasoning_effort || "unknown")}`,
    `- Cases: ${numberValue(summary.total)}`,
    `- Non-refusal: ${percent(summary.non_refusal_rate)} (${numberValue(summary.non_refusal_count)}/${numberValue(summary.total)})`,
    `- Completion: ${percent(summary.completion_rate)} (${numberValue(summary.completed_count)}/${numberValue(summary.total)})`,
    `- Verification: ${percent(summary.verification_rate)} (${numberValue(summary.verified_count)}/${numberValue(summary.total)})`,
    `- Refused: ${numberValue(summary.refusal_count)}`,
    `- Failed: ${numberValue(summary.failure_count)}`,
    `- Wrong sample fixture: ${numberValue(report.fixture_mismatch_count)}`,
    `- Fixture unverifiable: ${numberValue(report.fixture_unverifiable_count)}`,
    `- Fixture-grounded answer checks: ${numberValue(report.selected_answer_assertion_case_count)}/${numberValue(summary.total)}`,
    ""
  ];
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

function safeGrant(value: JsonRecord): JsonRecord {
  return {
    ok: value.ok === true,
    mode: value.mode ?? null,
    active: value.active === true,
    write_ready: value.write_ready === true,
    expires_at: value.expires_at ?? null
  };
}

function extractToolCalls(attempt: JsonRecord): JsonRecord[] {
  const calls: JsonRecord[] = [];
  for (const round of Array.isArray(attempt.rounds) ? attempt.rounds : []) {
    const row = asRecord(round);
    for (const action of Array.isArray(row.actions) ? row.actions : []) calls.push(asRecord(action));
  }
  return calls;
}

function assistantTextFromComputerState(state: JsonRecord): string {
  const messages = Array.isArray(state.messages) ? state.messages.map(asRecord) : [];
  return messages.filter((message) => message.role === "assistant")
    .map((message) => String(message.text || "").trim())
    .filter(Boolean)
    .at(-1) || "";
}

function dynamicReceiptActions(state: JsonRecord): JsonRecord[] {
  const receipts = Array.isArray(state.dynamicProgramReceipts) ? state.dynamicProgramReceipts.map(asRecord) : [];
  return receipts.map((receipt, index) => {
    const mode = String(receipt.requested_mode || "preview").toLowerCase() === "apply" ? "apply" : "preview";
    return {
      action_id: String(receipt.run_id || `dynamic-${index + 1}`),
      method: "POST",
      path: `/revit/dynamic-runtime/${mode}`,
      request_effect: mode,
      request_dispatched: receipt.execution_ok === true,
      status: receipt.execution_ok === true ? "success" : "failed",
      receipt
    };
  });
}

function rescoreTraceFromFlightRecord(trace: JsonRecord, testCase: GeneralRevitCapabilityCase, applyRequested: boolean): JsonRecord {
  const toolResults = asRecord(trace.tool_results);
  const rawAttempt = asRecord(toolResults.raw_sidecar_response);
  if (Object.keys(rawAttempt).length === 0) return trace;
  const assignmentProjection = asRecord(toolResults.durable_assignment_projection);
  const executionCase = generalRevitExecutionCase(testCase, applyRequested);
  const evaluation = evaluateGeneralRevitCapabilityAttempt(executionCase, {
    ...rawAttempt,
    assignment_projection: assignmentProjection
  } as GeneralRevitAttempt);
  return {
    ...trace,
    verification_results: { ...asRecord(trace.verification_results), evaluation },
    success_failure_score: {
      tier: evaluation.tier,
      non_refusal: evaluation.non_refusal,
      completed: evaluation.completed,
      verified: evaluation.verified
    },
    rescored_from_flight_record: true
  };
}

function sidecarFunctionReceiptActions(state: JsonRecord): JsonRecord[] {
  const receipts = Array.isArray(state.functionToolReceipts) ? state.functionToolReceipts.map(asRecord) : [];
  return receipts.map((receipt, index) => ({
    action_id: String(receipt.call_id || `function-${index + 1}`),
    method: "POST",
    path: String(receipt.path || ""),
    request_effect: String(receipt.request_effect || "read"),
    request_dispatched: receipt.request_dispatched === true,
    status: String(receipt.status || "failed"),
    receipt
  }));
}

function teammateLoopReceiptFromFunctionState(state: JsonRecord): JsonRecord | null {
  const receipts = Array.isArray(state.functionToolReceipts) ? state.functionToolReceipts.map(asRecord) : [];
  for (let index = receipts.length - 1; index >= 0; index -= 1) {
    const result = asRecord(receipts[index].result);
    const receipt = asRecord(result.teammate_loop_receipt);
    if (receipt.schema === "revit-operator.teammate-loop-receipt.v1") return receipt;
  }
  return null;
}

async function ensureFixtureActive(
  baseUrl: string,
  fixtureKey: string,
  fixture: { document_title: string; sample_filename: string },
  fixtureRoot: string
): Promise<JsonRecord> {
  const startedAt = nowIso();
  const startedMs = Date.now();
  const before = await requestJson(baseUrl, "/api/revit/health", {}, healthTimeoutMs());
  if (healthDocumentTitle(before) === fixture.document_title) {
    return {
      fixture: fixtureKey,
      expected_document_title: fixture.document_title,
      action: "already_active",
      started_at: startedAt,
      finished_at: nowIso(),
      duration_ms: Date.now() - startedMs,
      before,
      after: before
    };
  }
  const samplePath = path.resolve(fixtureRoot, fixture.sample_filename);
  if (!fs.existsSync(samplePath)) throw new Error(`Fixture file does not exist: ${samplePath}`);
  const prompt = [
    "Benchmark fixture transition. The user explicitly authorized opening, saving, or discarding changes in Autodesk sample models for this test campaign; do not ask for confirmation.",
    `In the currently running Revit instance, use the Revit bridge primitive revit_open_model to open and activate exactly: ${samplePath}`,
    "Use audit=false, detach=false, discardExistingOpenDocument=true, and continueOnUnresolvedReferences=true. If that exact target document is already open but inactive, you are explicitly authorized to close it without saving and reopen it so it becomes active. If Revit reports unresolved references, you are explicitly authorized to ignore that warning and continue opening this disposable sample fixture. Do not modify model content. Do not launch another Revit process and do not use Windows file association.",
    `Finish only after the authoritative active document title is exactly '${fixture.document_title}'.`
  ].join("\n");
  let runResponse: JsonRecord = {};
  let transportError = "";
  try {
    runResponse = await requestJson(baseUrl, "/api/computer/run", {
      method: "POST",
      body: JSON.stringify({ prompt, message_id: id(`fixture-${fixtureKey}`) })
    }, Math.min(fixtureTimeoutMs(), 30_000));
  } catch (error) {
    transportError = error instanceof Error ? error.message : String(error);
  }
  const deadline = Date.now() + fixtureTimeoutMs();
  let computerState = await requestJson(baseUrl, "/api/computer/state", {}, 30_000);
  while (computerState.running === true && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    computerState = await requestJson(baseUrl, "/api/computer/state", {}, 30_000);
  }
  if (computerState.running === true) {
    await stopComputerRunBestEffort(baseUrl);
    throw new Error(`Fixture transition ${fixtureKey} exceeded ${fixtureTimeoutMs()}ms; the abandoned Operator turn was stopped.`);
  }
  let after = await requestJson(baseUrl, "/api/revit/health", {}, healthTimeoutMs());
  while (healthDocumentTitle(after) !== fixture.document_title && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    after = await requestJson(baseUrl, "/api/revit/health", {}, healthTimeoutMs());
  }
  const observedTitle = healthDocumentTitle(after);
  if (observedTitle !== fixture.document_title) {
    const stateError = String(computerState.error || "").trim();
    throw new Error(
      `Fixture transition ${fixtureKey} failed: expected '${fixture.document_title}', observed '${observedTitle || "none"}'. `
      + (stateError || transportError || "The Operator did not activate the requested model.")
    );
  }
  return {
    fixture: fixtureKey,
    expected_document_title: fixture.document_title,
    sample_path: samplePath,
    action: "opened",
    started_at: startedAt,
    finished_at: nowIso(),
    duration_ms: Date.now() - startedMs,
    before,
    after,
    operator_response: runResponse,
    computer_state: computerState,
    transport_error: transportError || null
  };
}

async function stopComputerRunBestEffort(baseUrl: string): Promise<void> {
  try {
    await requestJson(baseUrl, "/api/computer/stop", { method: "POST" }, 10_000);
  } catch {
    return;
  }

  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    try {
      const state = await requestJson(baseUrl, "/api/computer/state", {}, 5_000);
      if (state.running !== true) return;
    } catch {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

function computerPerformanceSummary(attempt: JsonRecord): JsonRecord {
  const state = asRecord(attempt.computer_state);
  const receipts = Array.isArray(state.performanceReceipts) ? state.performanceReceipts.map(asRecord) : [];
  const byPhase: Record<string, JsonRecord> = {};
  for (const receipt of receipts) {
    const phase = String(receipt.phase || "unknown");
    const current = byPhase[phase] || { count: 0, total_ms: 0, max_ms: 0, request_bytes: 0, response_bytes: 0 };
    const durationMs = numberValue(receipt.duration_ms);
    current.count = numberValue(current.count) + 1;
    current.total_ms = numberValue(current.total_ms) + durationMs;
    current.max_ms = Math.max(numberValue(current.max_ms), durationMs);
    current.request_bytes = numberValue(current.request_bytes) + numberValue(receipt.request_bytes);
    current.response_bytes = numberValue(current.response_bytes) + numberValue(receipt.response_bytes);
    byPhase[phase] = current;
  }
  const progress = asRecord(state.progress);
  const startedAt = Date.parse(String(progress.startedAt || ""));
  const completedAt = Date.parse(String(progress.completedAt || progress.updatedAt || ""));
  return {
    schema: "revit-operator.computer-performance-summary/v1",
    product_run_ms: Number.isFinite(startedAt) && Number.isFinite(completedAt) ? Math.max(0, completedAt - startedAt) : null,
    receipt_count: receipts.length,
    total_request_bytes: receipts.reduce((sum, receipt) => sum + numberValue(receipt.request_bytes), 0),
    total_response_bytes: receipts.reduce((sum, receipt) => sum + numberValue(receipt.response_bytes), 0),
    by_phase: byPhase,
    receipts
  };
}

async function runComputerCase(
  baseUrl: string,
  testCase: GeneralRevitCapabilityCase,
  executionExpectedEffect: GeneralRevitCapabilityCase["expected_effect"]
): Promise<{ attempt: JsonRecord; sessionId: string }> {
  await requestJson(baseUrl, "/api/computer/reset", { method: "POST", body: "{}" }, 30_000);
  let runResponse: JsonRecord = {};
  let transportError = "";
  const timeoutMs = Number.parseInt(flag("--timeout-ms", "600000"), 10) || 600_000;
  try {
    runResponse = await requestJson(baseUrl, "/api/computer/run", {
      method: "POST",
      body: JSON.stringify({
        prompt: process.argv.includes("--apply") ? testCase.prompt : testCase.probe_prompt,
        message_id: id(`capability-${testCase.case_id}`)
      })
    }, Math.min(timeoutMs, 30_000));
  } catch (error) {
    transportError = error instanceof Error ? error.message : String(error);
  }
  const pollingDeadline = Date.now() + timeoutMs;
  let state = await requestJson(baseUrl, "/api/computer/state", {}, 30_000);
  while (state.running === true && Date.now() < pollingDeadline) {
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    state = await requestJson(baseUrl, "/api/computer/state", {}, 30_000);
  }
  if (state.running === true && !transportError) transportError = `Computer run exceeded ${timeoutMs}ms.`;
  const actions = [...sidecarFunctionReceiptActions(state), ...dynamicReceiptActions(state)];
  const teammateLoopReceipt = teammateLoopReceiptFromFunctionState(state);
  const successfulActions = actions.filter((action) => action.request_dispatched === true);
  const applySucceeded = successfulActions.some((action) => action.request_effect === "apply");
  const receiptSucceeded = successfulActions.length > 0;
  const receiptsPresent = actions.length > 0;
  const receiptExpectationMet = !receiptsPresent
    || (executionExpectedEffect === "apply" ? applySucceeded : receiptSucceeded);
  const stateError = String(state.error || "").trim();
  const attempt = {
    ...runResponse,
    ok: transportError === "" && stateError === "" && receiptExpectationMet && runResponse.ok !== false,
    assistant_message: assistantTextFromComputerState(state),
    error: transportError || stateError || null,
    effect_state: applySucceeded ? "apply_dispatched" : receiptSucceeded ? "read_only_dispatched" : "not_dispatched",
    actions,
    rounds: [],
    receipts: successfulActions.map((action) => action.receipt),
    action_results: successfulActions.map((action) => ({
      path: action.path,
      status: action.status,
      receipt: action.receipt
    })),
    ...(teammateLoopReceipt ? { teammate_loop_receipt: teammateLoopReceipt } : {}),
    computer_state: state
  };
  return { attempt, sessionId: String(state.backendSessionId || "").trim() };
}

async function runCase(baseUrl: string, testCase: GeneralRevitCapabilityCase, suiteContext: JsonRecord, corpusTaskTypes: string[], preferredFixture: string, preferredDocumentTitle: string): Promise<JsonRecord> {
  const startedAt = nowIso();
  const startedMs = Date.now();
  const applyRequested = suiteContext.apply_requested === true;
  const executionCase = generalRevitExecutionCase(testCase, applyRequested);
  const executionExpectedEffect = executionCase.expected_effect;
  // Hosted production uses the durable Revit courier. A healthy background or
  // minimized workstation can legitimately need more than 30 seconds to claim,
  // execute, and settle the certified context job. Treat that as benchmark
  // transport latency, not a model failure, while keeping the wait bounded.
  const initialHealthStartedAt = Date.now();
  const initialState = await requestJson(baseUrl, "/api/revit/health", {}, healthTimeoutMs());
  const initialHealthDurationMs = Date.now() - initialHealthStartedAt;
  const useComputer = executionSurface() === "operator_computer_general_agent";
  let sessionId = "";
  let attempt: JsonRecord;
  if (useComputer) {
    const computerResult = await runComputerCase(baseUrl, testCase, executionExpectedEffect);
    attempt = computerResult.attempt;
    sessionId = computerResult.sessionId;
  } else {
    const session = await requestJson(baseUrl, "/api/session/new", { method: "POST", body: "{}" }, 30_000);
    sessionId = String(session.session_id || "").trim();
    if (!sessionId) throw new Error("Sidecar did not create a backend session.");
    try {
      attempt = await requestJson(baseUrl, "/api/chat", {
        method: "POST",
        body: JSON.stringify({
          version: "operator.backend.v1",
          session_id: sessionId,
          message_id: id(`capability-${testCase.case_id}`),
          user_text: applyRequested ? testCase.prompt : testCase.probe_prompt,
          context: { ui: { client: "operator-desktop", surface: "general-revit-capability-acceptance" } }
        })
      }, Number.parseInt(flag("--timeout-ms", "180000"), 10) || 180_000);
    } catch (error) {
      attempt = { ok: false, error: error instanceof Error ? error.message : String(error), effect_state: "not_dispatched" };
    }
  }
  let finalHealthDurationMs = 0;
  const finalHealthStartedAt = Date.now();
  const finalHealthPromise = requestJson(baseUrl, "/api/revit/health", {}, healthTimeoutMs())
    .catch((error) => ({ ok: false, error: String(error) }))
    .finally(() => { finalHealthDurationMs = Date.now() - finalHealthStartedAt; });
  const [finalState, assignmentProjection] = await Promise.all([
    finalHealthPromise,
    (sessionId
      ? requestJson(baseUrl, `/api/assignments?limit=10&session_id=${encodeURIComponent(sessionId)}`, {}, 30_000)
      : Promise.resolve({ ok: false, error: "Computer run did not expose a backend session id." }))
      .catch((error) => ({ ok: false, error: String(error) }))
  ]);
  const evaluatedAttempt = { ...attempt, assignment_projection: assignmentProjection };
  const evaluation = evaluateGeneralRevitCapabilityAttempt(executionCase, evaluatedAttempt as GeneralRevitAttempt);
  const toolCalls = extractToolCalls(attempt);
  const finishedAt = nowIso();
  return {
    schema: "revit-operator.task-trace/v1",
    trace_id: id("trace"),
    case_id: testCase.case_id,
    source: testCase.source,
    operation_family: testCase.operation_family,
    preferred_fixture: preferredFixture,
    fixture_applicability: fixtureApplicability(preferredFixture, preferredDocumentTitle, initialState),
    prompt_specificity: generalRevitPromptSpecificity(testCase),
    corpus_task_type: testCase.corpus_task_type || corpusTaskTypes[0] || testCase.operation_family,
    corpus_task_types: corpusTaskTypes,
    grounding_demand: generalRevitGroundingDemand(testCase),
    research_demand: generalRevitResearchDemand(testCase),
    production_expected_effect: testCase.expected_effect,
    execution_expected_effect: executionExpectedEffect,
    started_at: startedAt,
    finished_at: finishedAt,
    user_intent: {
      production_prompt: testCase.prompt,
      safe_probe_prompt: testCase.probe_prompt,
      executed_prompt: applyRequested ? testCase.prompt : testCase.probe_prompt,
      mutation_requested: applyRequested
    },
    initial_model_state: initialState,
    context_supplied: { session_id: sessionId, ui_surface: "general-revit-capability-acceptance", suite: suiteContext },
    agent_reasoning_plan_representation: Array.isArray(attempt.rounds) ? attempt.rounds : [],
    tool_calls: toolCalls,
    tool_results: {
      response_effect_state: attempt.effect_state ?? "not_dispatched",
      outcome_unknown: attempt.outcome_unknown === true,
      reconciliation_required: attempt.reconciliation_required === true,
      durable_assignment_projection: assignmentProjection,
      raw_sidecar_response_sha256: sha256(attempt),
      raw_sidecar_response: attempt
    },
    model_state_changes: {
      apply_dispatched: evaluation.apply_dispatched,
      claimed_only_when_dispatched: true
    },
    errors_retries_recoveries: {
      error: attempt.error ?? null,
      rounds: Array.isArray(attempt.rounds) ? attempt.rounds.length : 0,
      reconciliation_required: evaluation.outcome_unknown
    },
    verification_results: {
      expected_paths: executionCase.dispatch_any_of,
      observed_paths: evaluation.observed_paths,
      evaluation
    },
    human_corrections: [],
    final_model_state: finalState,
    success_failure_score: {
      tier: evaluation.tier,
      non_refusal: evaluation.non_refusal,
      completed: evaluation.completed,
      verified: evaluation.verified
    },
    efficiency: {
      duration_ms: Date.now() - startedMs,
      token_count: null,
      tool_call_count: toolCalls.length,
      round_count: Array.isArray(attempt.rounds) ? attempt.rounds.length : 0,
      harness_health_ms: {
        initial: initialHealthDurationMs,
        final: finalHealthDurationMs,
        total: initialHealthDurationMs + finalHealthDurationMs
      },
      computer_performance: computerPerformanceSummary(attempt)
    }
  };
}

async function main(): Promise<void> {
  if (process.argv.includes("--help")) {
    console.log([
      "General Revit capability acceptance runner",
      "",
      "npm run probe:general-revit-capabilities -- [--suite smoke|redline|challenge|terse|research|long-horizon|production|code-execution|full] [--fixture snowdon_hvac|snowdon_plumbing|snowdon_electrical | --orchestrate-fixtures] [--fixture-root DIR] [--sidecar URL] [--case ID[,ID]] [--source SOURCE] [--limit N] [--timeout-ms N] [--health-timeout-ms N] [--fixture-timeout-ms N] [--output FILE | --output-dir DIR] [--resume CHECKPOINT] [--rescore-only] [--allow-corpus-drift] [--baseline FILE] [--label TEXT] [--list-cases] [--legacy-chat] [--apply] [--require-completion]",
      "",
      "The corpus is representative regression coverage, not a capability allowlist. By default every case uses the same General Agent computer lane as the Operator UI and sends the non-mutating probe_prompt; --apply sends and scores the production mutation. --legacy-chat is retained only for transport diagnostics and does not represent the product General Agent. Each completed case is durably checkpointed, and --resume continues an interrupted run. --rescore-only requires --resume and rebuilds reports from recorded flight data without contacting Sidecar or Revit. Use --allow-corpus-drift only with --rescore-only to audit historical traces against the current compatible case IDs and truth policy."
    ].join("\n"));
    return;
  }
  const corpus = loadGeneralRevitCapabilityCorpus();
  const fixtureConfig = loadGeneralRevitSampleFixtures(corpus.cases);
  const requestedFixture = flag("--fixture").trim().toLowerCase();
  const orchestrateFixtures = process.argv.includes("--orchestrate-fixtures");
  if (requestedFixture && orchestrateFixtures) throw new Error("Use either --fixture or --orchestrate-fixtures, not both.");
  if (requestedFixture && !fixtureConfig.fixtures[requestedFixture]) {
    throw new Error(`Unknown General Revit sample fixture '${requestedFixture}'.`);
  }
  const applyRequested = process.argv.includes("--apply");
  let selected = selectCases(corpus.cases).filter((entry) => !requestedFixture
    || generalRevitFixtureForCase(fixtureConfig, entry.case_id) === requestedFixture);
  const selectedFixtureKeys = new Set(selected.map((entry) => generalRevitFixtureForCase(fixtureConfig, entry.case_id)));
  if (orchestrateFixtures) {
    const fixtureOrder = Object.keys(fixtureConfig.fixtures);
    selected = [...selected].sort((left, right) => fixtureOrder.indexOf(generalRevitFixtureForCase(fixtureConfig, left.case_id))
      - fixtureOrder.indexOf(generalRevitFixtureForCase(fixtureConfig, right.case_id)));
  }
  if (selected.length === 0) throw new Error("No cases matched the requested filters.");
  if (process.argv.includes("--list-cases")) {
    console.log(JSON.stringify(selected.map((entry) => ({
      case_id: entry.case_id,
      source: entry.source,
      operation_family: entry.operation_family,
      preferred_fixture: generalRevitFixtureForCase(fixtureConfig, entry.case_id),
      prompt_specificity: generalRevitPromptSpecificity(entry),
      prompt: entry.prompt
    })), null, 2));
    return;
  }
  const sidecar = flag("--sidecar", "http://127.0.0.1:3908").replace(/\/$/, "");
  const suite = flag("--suite", "full").toLowerCase();
  const resumePath = flag("--resume");
  const resumedCheckpoint = resumePath ? readJsonFile<JsonRecord>(path.resolve(resumePath)) : null;
  const rescoreOnly = process.argv.includes("--rescore-only");
  const allowCorpusDrift = rescoreOnly && process.argv.includes("--allow-corpus-drift");
  if (rescoreOnly && !resumedCheckpoint) throw new Error("--rescore-only requires --resume CHECKPOINT.");
  if (!rescoreOnly && !requestedFixture && !orchestrateFixtures && selectedFixtureKeys.size > 1) {
    throw new Error("Selected cases span multiple sample models. Use --orchestrate-fixtures or run one explicit --fixture cohort at a time.");
  }
  let runId = String(resumedCheckpoint?.run_id || `${fileStamp()}-${suite}-${applyRequested ? "apply" : "safe"}`);
  const explicitOutput = flag("--output");
  const outputDir = flag("--output-dir");
  if (explicitOutput && outputDir) throw new Error("Use either --output or --output-dir, not both.");
  const resolvedOutputDir = outputDir ? path.resolve(outputDir) : "";
  const output = explicitOutput
    ? path.resolve(explicitOutput)
    : resolvedOutputDir
      ? path.join(resolvedOutputDir, runId, "report.json")
      : path.resolve(`general-revit-capability-report-${Date.now()}.json`);
  const summaryOutput = resolvedOutputDir ? path.join(resolvedOutputDir, runId, "summary.md") : output.replace(/\.json$/i, ".md");
  const priorSuiteContext = asRecord(resumedCheckpoint?.suite_context);
  const priorComputerAgent = asRecord(priorSuiteContext.computer_agent);
  const [config, grant] = rescoreOnly
    ? [{
      runtimeProfile: asRecord(priorSuiteContext.runtime_profile),
      computerModel: priorComputerAgent.outer_model,
      speedDefaults: priorComputerAgent
    }, asRecord(priorSuiteContext.write_grant)]
    : await Promise.all([
      requestJson(sidecar, "/api/config", {}, 30_000),
      requestJson(sidecar, "/api/revit/write-grant", {}, 30_000)
    ]);
  const runtimeProfile = asRecord(config.runtimeProfile);
  const speedDefaults = asRecord(config.speedDefaults);
  if (runtimeProfile.general_agent !== true) throw new Error("General Agent is unavailable; refusing to misreport a capability run.");
  let fixturePreflight: JsonRecord = {};
  if (requestedFixture && !rescoreOnly) {
    fixturePreflight = await requestJson(sidecar, "/api/revit/health", {}, healthTimeoutMs());
    const activeTitle = String(asRecord(asRecord(fixturePreflight.context).document).title || "").trim();
    const expectedTitle = fixtureConfig.fixtures[requestedFixture].document_title;
    if (activeTitle !== expectedTitle) {
      throw new Error(`Fixture ${requestedFixture} requires active document '${expectedTitle}', but Revit reports '${activeTitle || "none"}'.`);
    }
  }
  const suiteContext = {
    sidecar,
    execution_surface: executionSurface(),
    runtime_profile: runtimeProfile,
    write_grant: safeGrant(grant),
    computer_agent: {
      outer_model: String(config.computerModel || speedDefaults.executor_model || "unknown"),
      split_planner_executor: speedDefaults.split_planner_executor === true,
      planner_model: String(speedDefaults.planner_model || "unknown"),
      planner_reasoning_effort: String(speedDefaults.planner_reasoning_effort || "unknown"),
      executor_model: String(speedDefaults.executor_model || config.computerModel || "unknown"),
      executor_reasoning_effort: String(speedDefaults.executor_reasoning_effort || "unknown")
    },
    corpus_schema: corpus.schema_version,
    corpus_sha256: sha256(corpus),
    fixture_schema: fixtureConfig.schema,
    fixture_config_sha256: sha256(fixtureConfig),
    fixture_selection: requestedFixture || (orchestrateFixtures ? "orchestrated" : "single_fixture_unpinned"),
    fixture_root: orchestrateFixtures ? path.resolve(flag("--fixture-root", "C:\\Program Files\\Autodesk\\Revit 2024\\Samples")) : null,
    fixture_transitions: [] as JsonRecord[],
    fixture_preflight: requestedFixture ? {
      document_title: asRecord(asRecord(fixturePreflight.context).document).title ?? null,
      document_path: asRecord(asRecord(fixturePreflight.context).document).path ?? null,
      preferred_fixture: requestedFixture
    } : null,
    apply_requested: applyRequested,
    mutation_policy: applyRequested
      ? "production prompts; mutation explicitly requested by the test operator"
      : "safe probe prompts only; no apply requested"
  };
  if (resumedCheckpoint) {
    const priorContext = asRecord(resumedCheckpoint.suite_context);
    if (String(priorContext.corpus_sha256 || "") !== String(suiteContext.corpus_sha256) && !allowCorpusDrift) {
      throw new Error("Resume checkpoint was produced from a different benchmark corpus.");
    }
    if (String(resumedCheckpoint.suite || "") !== suite || priorContext.apply_requested !== applyRequested) {
      throw new Error("Resume checkpoint suite or mutation mode does not match this invocation.");
    }
  }
  const selectedIds = new Set(selected.map((entry) => entry.case_id));
  const selectedById = new Map(selected.map((entry) => [entry.case_id, entry]));
  const traces: JsonRecord[] = (Array.isArray(resumedCheckpoint?.task_traces) ? resumedCheckpoint.task_traces : [])
    .map(asRecord)
    .filter((trace) => selectedIds.has(String(trace.case_id || "")))
    .map((trace) => ({
      ...rescoreTraceFromFlightRecord(trace, selectedById.get(String(trace.case_id || ""))!, applyRequested),
      preferred_fixture: generalRevitFixtureForCase(fixtureConfig, String(trace.case_id || "")),
      fixture_applicability: fixtureApplicability(
        generalRevitFixtureForCase(fixtureConfig, String(trace.case_id || "")),
        fixtureConfig.fixtures[generalRevitFixtureForCase(fixtureConfig, String(trace.case_id || ""))].document_title,
        asRecord(trace.initial_model_state)
      )
    }));
  const completedIds = new Set(traces.map((trace) => String(trace.case_id || "")));
  const checkpointOutput = resolvedOutputDir
    ? path.join(resolvedOutputDir, runId, "checkpoint.json")
    : output.replace(/\.json$/i, ".checkpoint.json");
  const corpusTaskTypesByCase = new Map<string, string[]>();
  for (const taskType of corpus.corpus_evidence.task_types) {
    for (const caseId of taskType.case_ids) {
      const values = corpusTaskTypesByCase.get(caseId) || [];
      values.push(taskType.task_type_id);
      corpusTaskTypesByCase.set(caseId, values);
    }
  }
  let activeFixtureKey = "";
  const fixtureRoot = path.resolve(flag("--fixture-root", "C:\\Program Files\\Autodesk\\Revit 2024\\Samples"));
  for (const testCase of rescoreOnly ? [] : selected.filter((entry) => !completedIds.has(entry.case_id))) {
    const preferredFixture = generalRevitFixtureForCase(fixtureConfig, testCase.case_id);
    if (orchestrateFixtures && preferredFixture !== activeFixtureKey) {
      console.log(`[fixture] ${preferredFixture}`);
      const transition = await ensureFixtureActive(sidecar, preferredFixture, fixtureConfig.fixtures[preferredFixture], fixtureRoot);
      (suiteContext.fixture_transitions as JsonRecord[]).push(transition);
      activeFixtureKey = preferredFixture;
    }
    console.log(`[${traces.length + 1}/${selected.length}] ${testCase.case_id}`);
    traces.push(await runCase(
      sidecar,
      testCase,
      suiteContext,
      corpusTaskTypesByCase.get(testCase.case_id) || [],
      preferredFixture,
      fixtureConfig.fixtures[preferredFixture].document_title
    ));
    writeJsonFile(checkpointOutput, {
      schema: "revit-operator.general-revit-capability-checkpoint/v1",
      run_id: runId,
      suite,
      updated_at: nowIso(),
      suite_context: suiteContext,
      selected_case_ids: [...selectedIds],
      completed_case_ids: traces.map((trace) => trace.case_id),
      task_traces: traces
    });
  }
  const evaluations = traces.map((trace) => asRecord(asRecord(trace.verification_results).evaluation));
  const summary = summarizeGeneralRevitCapabilityReport(evaluations as never);
  const summaryByVerificationBasis = Object.fromEntries([...new Set(evaluations.map((entry) => String(entry.verification_basis || "none")))]
    .sort().map((basis) => [basis, evaluations.filter((entry) => String(entry.verification_basis || "none") === basis).length]));
  const summaryByOperationFamily = groupedSummary(traces, "operation_family");
  const summaryBySpecificity = groupedSummary(traces, "prompt_specificity");
  const summaryByFixture = groupedSummary(traces, "preferred_fixture");
  const summaryByCorpusTaskType = groupedMultiSummary(traces, "corpus_task_types");
  const corpusCoverage = summarizeGeneralRevitCorpusCoverage(corpus);
  const fixtureMismatchCount = traces.filter((trace) => asRecord(trace.fixture_applicability).fixture_match === false).length;
  const fixtureUnverifiableCount = traces.filter((trace) => asRecord(trace.fixture_applicability).fixture_match == null).length;
  const answerAssertionCaseCount = corpus.cases.filter((entry) => !!entry.answer_assertions).length;
  const selectedAnswerAssertionCaseCount = selected.filter((entry) => !!entry.answer_assertions).length;
  const baselinePath = flag("--baseline");
  const baselineReport = baselinePath ? readJsonFile<JsonRecord>(path.resolve(baselinePath)) : null;
  const baselineComparison = baselineReport ? {
    path: path.resolve(baselinePath),
    run_id: baselineReport.run_id ?? null,
    generated_at: baselineReport.generated_at ?? null,
    summary: asRecord(baselineReport.summary)
  } : null;
  const caseDeltas = baselineCaseDeltas(traces, baselineReport);
  const report = {
    schema: "revit-operator.general-revit-capability-report/v1",
    run_id: runId,
    label: flag("--label") || null,
    generated_at: nowIso(),
    suite_id: corpus.suite_id,
    suite,
    representative_not_exhaustive: true,
    suite_context: suiteContext,
    summary,
    summary_by_operation_family: summaryByOperationFamily,
    summary_by_specificity: summaryBySpecificity,
    summary_by_fixture: summaryByFixture,
    summary_by_verification_basis: summaryByVerificationBasis,
    fixture_mismatch_count: fixtureMismatchCount,
    fixture_unverifiable_count: fixtureUnverifiableCount,
    answer_assertion_case_count: answerAssertionCaseCount,
    selected_answer_assertion_case_count: selectedAnswerAssertionCaseCount,
    summary_by_corpus_task_type: summaryByCorpusTaskType,
    corpus_coverage: corpusCoverage,
    baseline_comparison: baselineComparison,
    baseline_case_deltas: caseDeltas,
    task_traces: traces,
    report_sha256: sha256({ suiteContext, summary, summaryByOperationFamily, summaryBySpecificity, summaryByFixture, summaryByVerificationBasis, summaryByCorpusTaskType, corpusCoverage, fixtureMismatchCount, fixtureUnverifiableCount, answerAssertionCaseCount, selectedAnswerAssertionCaseCount, caseDeltas, traces })
  };
  writeJsonFile(output, report);
  writeTextFile(summaryOutput, markdownReport(report));
  if (resolvedOutputDir) {
    writeJsonFile(path.join(resolvedOutputDir, "latest.json"), {
      schema: "revit-operator.general-revit-capability-latest/v1",
      run_id: runId,
      report_path: output,
      summary_path: summaryOutput,
      summary
    });
    writeTextFile(path.join(resolvedOutputDir, "latest.md"), markdownReport(report));
  }
  console.log(JSON.stringify({ output, summary_output: summaryOutput, latest: resolvedOutputDir ? path.join(resolvedOutputDir, "latest.md") : null, summary }, null, 2));
  const requireCompletion = process.argv.includes("--require-completion");
  if (summary.refusal_count > 0 || summary.failure_count > 0 || (requireCompletion && summary.completed_count !== summary.total)) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  process.exitCode = 1;
});
