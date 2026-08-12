import crypto from "node:crypto";
import path from "node:path";
import {
  evaluateGeneralRevitCapabilityAttempt,
  loadGeneralRevitCapabilityCorpus,
  summarizeGeneralRevitCapabilityReport,
  type GeneralRevitCapabilityCase,
  type GeneralRevitAttempt
} from "../benchmark/general_revit_capability_acceptance.js";
import { nowIso, readJsonFile, writeJsonFile, writeTextFile } from "../benchmark/files.js";

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

function sha256(value: unknown): string {
  return crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function id(prefix: string): string {
  return `${prefix}-${crypto.randomUUID()}`;
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
  if (!["smoke", "redline", "long-horizon", "production", "code-execution", "full"].includes(suite)) {
    throw new Error(`Unknown suite '${suite}'. Expected smoke, redline, long-horizon, production, code-execution, or full.`);
  }
  const requestedIds = new Set(flagValues("--case"));
  const requestedSources = new Set(flagValues("--source"));
  const unknownIds = [...requestedIds].filter((caseId) => !cases.some((entry) => entry.case_id === caseId));
  if (unknownIds.length > 0) throw new Error(`Unknown case id(s): ${unknownIds.join(", ")}`);
  const filtered = cases.filter((entry) => (suite !== "smoke" || SMOKE_CASE_IDS.has(entry.case_id))
    && (suite !== "redline" || entry.source === "redline_corpus")
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

function markdownReport(report: JsonRecord): string {
  const summary = asRecord(report.summary);
  const baseline = asRecord(report.baseline_comparison);
  const baselineSummary = asRecord(baseline.summary);
  const traces = Array.isArray(report.task_traces) ? report.task_traces.map(asRecord) : [];
  const lines = [
    "# General Revit benchmark result",
    "",
    `- Run: \`${String(report.run_id || "")}\``,
    `- Label: ${String(report.label || "unlabeled")}`,
    `- Generated: ${String(report.generated_at || "")}`,
    `- Mode: ${asRecord(report.suite_context).mutation_policy || "unknown"}`,
    `- Cases: ${numberValue(summary.total)}`,
    `- Non-refusal: ${percent(summary.non_refusal_rate)} (${numberValue(summary.non_refusal_count)}/${numberValue(summary.total)})`,
    `- Completion: ${percent(summary.completion_rate)} (${numberValue(summary.completed_count)}/${numberValue(summary.total)})`,
    `- Verification: ${percent(summary.verification_rate)} (${numberValue(summary.verified_count)}/${numberValue(summary.total)})`,
    `- Refused: ${numberValue(summary.refusal_count)}`,
    `- Failed: ${numberValue(summary.failure_count)}`,
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
  }
  lines.push("## Cases", "", "| Case | Source | Operation | Tier | Duration |", "|---|---|---|---|---:|");
  for (const trace of traces) {
    const score = asRecord(trace.success_failure_score);
    const efficiency = asRecord(trace.efficiency);
    lines.push(`| ${String(trace.case_id || "").replaceAll("|", "\\|")} | ${String(trace.source || "")} | ${String(trace.operation_family || "")} | ${String(score.tier || "not_run")} | ${(numberValue(efficiency.duration_ms) / 1000).toFixed(1)}s |`);
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

async function runComputerCase(baseUrl: string, testCase: GeneralRevitCapabilityCase): Promise<{ attempt: JsonRecord; sessionId: string }> {
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
  const actions = dynamicReceiptActions(state);
  const successfulActions = actions.filter((action) => action.request_dispatched === true);
  const applySucceeded = successfulActions.some((action) => action.request_effect === "apply");
  const receiptSucceeded = successfulActions.length > 0;
  const receiptsPresent = actions.length > 0;
  const receiptExpectationMet = !receiptsPresent
    || (testCase.expected_effect === "apply" ? applySucceeded : receiptSucceeded);
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
    verification_results: successfulActions.map((action) => ({
      path: action.path,
      status: action.status,
      receipt: action.receipt
    })),
    computer_state: state
  };
  return { attempt, sessionId: String(state.backendSessionId || "").trim() };
}

async function runCase(baseUrl: string, testCase: GeneralRevitCapabilityCase, suiteContext: JsonRecord): Promise<JsonRecord> {
  const startedAt = nowIso();
  const startedMs = Date.now();
  const initialState = await requestJson(baseUrl, "/api/revit/health", {}, 30_000);
  const useComputer = process.argv.includes("--ui")
    || ["long_horizon", "document_production", "code_execution"].includes(testCase.source);
  let sessionId = "";
  let attempt: JsonRecord;
  if (useComputer) {
    const computerResult = await runComputerCase(baseUrl, testCase);
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
          user_text: process.argv.includes("--apply") ? testCase.prompt : testCase.probe_prompt,
          context: { ui: { client: "operator-desktop", surface: "general-revit-capability-acceptance" } }
        })
      }, Number.parseInt(flag("--timeout-ms", "180000"), 10) || 180_000);
    } catch (error) {
      attempt = { ok: false, error: error instanceof Error ? error.message : String(error), effect_state: "not_dispatched" };
    }
  }
  const [finalState, assignmentProjection] = await Promise.all([
    requestJson(baseUrl, "/api/revit/health", {}, 30_000).catch((error) => ({ ok: false, error: String(error) })),
    (sessionId
      ? requestJson(baseUrl, `/api/assignments?limit=10&session_id=${encodeURIComponent(sessionId)}`, {}, 30_000)
      : Promise.resolve({ ok: false, error: "Computer run did not expose a backend session id." }))
      .catch((error) => ({ ok: false, error: String(error) }))
  ]);
  const evaluatedAttempt = { ...attempt, assignment_projection: assignmentProjection };
  const evaluation = evaluateGeneralRevitCapabilityAttempt(testCase, evaluatedAttempt as GeneralRevitAttempt);
  const toolCalls = extractToolCalls(attempt);
  const finishedAt = nowIso();
  return {
    schema: "revit-operator.task-trace/v1",
    trace_id: id("trace"),
    case_id: testCase.case_id,
    source: testCase.source,
    operation_family: testCase.operation_family,
    started_at: startedAt,
    finished_at: finishedAt,
    user_intent: {
      production_prompt: testCase.prompt,
      safe_probe_prompt: testCase.probe_prompt,
      executed_prompt: process.argv.includes("--apply") ? testCase.prompt : testCase.probe_prompt,
      mutation_requested: process.argv.includes("--apply")
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
      expected_paths: testCase.dispatch_any_of,
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
      round_count: Array.isArray(attempt.rounds) ? attempt.rounds.length : 0
    }
  };
}

async function main(): Promise<void> {
  if (process.argv.includes("--help")) {
    console.log([
      "General Revit capability acceptance runner",
      "",
      "npm run probe:general-revit-capabilities -- [--suite smoke|redline|long-horizon|production|code-execution|full] [--sidecar URL] [--case ID[,ID]] [--source SOURCE] [--limit N] [--output FILE | --output-dir DIR] [--baseline FILE] [--label TEXT] [--list-cases] [--ui] [--apply] [--require-completion]",
      "",
      "The corpus is representative regression coverage, not a capability allowlist. By default the runner sends non-mutating probe_prompt. --apply sends the production prompt and permits model mutation. Long-horizon, document-production, and code-execution suites use the same computer-agent lane as the Sidecar UI; --ui opts any other suite into that lane."
    ].join("\n"));
    return;
  }
  const corpus = loadGeneralRevitCapabilityCorpus();
  const applyRequested = process.argv.includes("--apply");
  const selected = selectCases(corpus.cases);
  if (selected.length === 0) throw new Error("No cases matched the requested filters.");
  if (process.argv.includes("--list-cases")) {
    console.log(JSON.stringify(selected.map((entry) => ({
      case_id: entry.case_id,
      source: entry.source,
      operation_family: entry.operation_family,
      prompt: entry.prompt
    })), null, 2));
    return;
  }
  const sidecar = flag("--sidecar", "http://127.0.0.1:3908").replace(/\/$/, "");
  const suite = flag("--suite", "full").toLowerCase();
  const runId = `${fileStamp()}-${suite}-${applyRequested ? "apply" : "safe"}`;
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
  const [config, grant] = await Promise.all([
    requestJson(sidecar, "/api/config", {}, 30_000),
    requestJson(sidecar, "/api/revit/write-grant", {}, 30_000)
  ]);
  const runtimeProfile = asRecord(config.runtimeProfile);
  if (runtimeProfile.general_agent !== true) throw new Error("General Agent is unavailable; refusing to misreport a capability run.");
  const suiteContext = {
    sidecar,
    runtime_profile: runtimeProfile,
    write_grant: safeGrant(grant),
    corpus_schema: corpus.schema_version,
    corpus_sha256: sha256(corpus),
    mutation_policy: applyRequested
      ? "production prompts; mutation explicitly requested by the test operator"
      : "safe probe prompts only; no apply requested"
  };
  const traces: JsonRecord[] = [];
  for (const testCase of selected) {
    console.log(`[${traces.length + 1}/${selected.length}] ${testCase.case_id}`);
    traces.push(await runCase(sidecar, testCase, suiteContext));
  }
  const evaluations = traces.map((trace) => asRecord(asRecord(trace.verification_results).evaluation));
  const summary = summarizeGeneralRevitCapabilityReport(evaluations as never);
  const baselinePath = flag("--baseline");
  const baselineReport = baselinePath ? readJsonFile<JsonRecord>(path.resolve(baselinePath)) : null;
  const baselineComparison = baselineReport ? {
    path: path.resolve(baselinePath),
    run_id: baselineReport.run_id ?? null,
    generated_at: baselineReport.generated_at ?? null,
    summary: asRecord(baselineReport.summary)
  } : null;
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
    baseline_comparison: baselineComparison,
    task_traces: traces,
    report_sha256: sha256({ suiteContext, summary, traces })
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
