import crypto from "node:crypto";
import path from "node:path";
import {
  evaluateGeneralRevitCapabilityAttempt,
  loadGeneralRevitCapabilityCorpus,
  summarizeGeneralRevitCapabilityReport,
  type GeneralRevitCapabilityCase,
  type GeneralRevitAttempt
} from "../benchmark/general_revit_capability_acceptance.js";
import { nowIso, writeJsonFile } from "../benchmark/files.js";

type JsonRecord = Record<string, unknown>;

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
    const response = await fetch(new URL(pathname, `${baseUrl}/`), {
      ...options,
      headers: { "content-type": "application/json", ...(options.headers || {}) },
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
  const requestedIds = new Set(flagValues("--case"));
  const requestedSources = new Set(flagValues("--source"));
  const unknownIds = [...requestedIds].filter((caseId) => !cases.some((entry) => entry.case_id === caseId));
  if (unknownIds.length > 0) throw new Error(`Unknown case id(s): ${unknownIds.join(", ")}`);
  const filtered = cases.filter((entry) => (requestedIds.size === 0 || requestedIds.has(entry.case_id))
    && (requestedSources.size === 0 || requestedSources.has(entry.source)));
  const limit = Number.parseInt(flag("--limit", `${filtered.length}`), 10);
  return filtered.slice(0, Number.isFinite(limit) && limit >= 0 ? limit : filtered.length);
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

async function runCase(baseUrl: string, testCase: GeneralRevitCapabilityCase, suiteContext: JsonRecord): Promise<JsonRecord> {
  const startedAt = nowIso();
  const startedMs = Date.now();
  const initialState = await requestJson(baseUrl, "/api/revit/health", {}, 30_000);
  const session = await requestJson(baseUrl, "/api/session/new", { method: "POST", body: "{}" }, 30_000);
  const sessionId = String(session.session_id || "").trim();
  if (!sessionId) throw new Error("Sidecar did not create a backend session.");
  let attempt: JsonRecord;
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
  const [finalState, assignmentProjection] = await Promise.all([
    requestJson(baseUrl, "/api/revit/health", {}, 30_000).catch((error) => ({ ok: false, error: String(error) })),
    requestJson(baseUrl, `/api/assignments?limit=10&session_id=${encodeURIComponent(sessionId)}`, {}, 30_000)
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
      "npm run probe:general-revit-capabilities -- [--sidecar URL] [--case ID[,ID]] [--source SOURCE] [--limit N] [--output FILE] [--apply] [--require-completion]",
      "",
      "The corpus is representative regression coverage, not a capability allowlist. By default the runner sends non-mutating probe_prompt. --apply sends the production prompt and permits model mutation."
    ].join("\n"));
    return;
  }
  const corpus = loadGeneralRevitCapabilityCorpus();
  const applyRequested = process.argv.includes("--apply");
  const selected = selectCases(corpus.cases);
  if (selected.length === 0) throw new Error("No cases matched the requested filters.");
  const sidecar = flag("--sidecar", "http://127.0.0.1:3908").replace(/\/$/, "");
  const output = path.resolve(flag("--output", `general-revit-capability-report-${Date.now()}.json`));
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
  const report = {
    schema: "revit-operator.general-revit-capability-report/v1",
    generated_at: nowIso(),
    suite_id: corpus.suite_id,
    representative_not_exhaustive: true,
    suite_context: suiteContext,
    summary,
    task_traces: traces,
    report_sha256: sha256({ suiteContext, summary, traces })
  };
  writeJsonFile(output, report);
  console.log(JSON.stringify({ output, summary }, null, 2));
  const requireCompletion = process.argv.includes("--require-completion");
  if (summary.refusal_count > 0 || summary.failure_count > 0 || (requireCompletion && summary.completed_count !== summary.total)) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  process.exitCode = 1;
});
