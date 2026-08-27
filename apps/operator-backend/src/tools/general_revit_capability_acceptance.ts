import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  evaluateGeneralRevitCapabilityAttempt,
  generalRevitExecutionCase,
  generalRevitGroundingDemand,
  generalRevitPromptSpecificity,
  generalRevitResearchDemand,
  summarizeGeneralRevitCapabilityReport,
  type GeneralRevitCapabilityCase,
  type GeneralRevitAttempt
} from "../benchmark/general_revit_capability_acceptance.js";
import { nowIso, readJsonFile, writeJsonFile, writeTextFile } from "../benchmark/files.js";
import { generalRevitFixtureForCase } from "../benchmark/general_revit_sample_fixtures.js";
import { loadDurableToolEvidence } from "../benchmark/durable_tool_evidence.js";
import {
  revitHealthDocumentTitle,
  waitForExactRevitFixtureHealth,
  type ExactRevitFixtureHealthResult
} from "../benchmark/revit_fixture_readiness.js";
import { localRevitProcessGuardTarget,
  type LocalRevitProcessGuardTarget } from "../benchmark/local_revit_process_liveness.js";
import { aggregateModelCallReceipts, modelCallReceiptsFromSources, modelCallReceiptsFromTraces,
  modelTelemetryCaseCoverage, requestedComputerAgentConfig, requestedVsObservedComputerAgent,
  speedSettingsForRequestedConfig } from "../benchmark/general_revit_model_telemetry.js";
import { summarizeGeneralRevitLatency } from "../benchmark/general_revit_latency.js";
import { summarizeGeneralRevitFixturePreconditionCoverage } from "../benchmark/general_revit_fixture_preconditions.js";
import { loadVerifiedWorkPackets } from "../benchmark/work_packet_collection.js";
import { loadAssignmentKernelPublicationsV2 } from "../benchmark/assignment_kernel_v2_collection.js";
import { markdownReport } from "../benchmark/general_revit_capability_report.js";
import { selectReleaseCanaryCasesV2 } from "../benchmark/protocol_v2_canary.js";
import { bindComputerClarificationResponse, executeGeneralRevitComputerTurn, modelCallReceiptsFromComputerTurns, pendingComputerClarification } from "../benchmark/general_revit_computer_turn.js";
import { benchmarkInteractionCaseV1, benchmarkInteractionTraceV1, loadBenchmarkInteractionManifestV1,
  type BenchmarkInteractionCaseV1, type BenchmarkInteractionManifestV1 } from "../benchmark/protocol_v2_interaction.js";
import { assertGeneralRevitProtocolOutputV2, generalRevitProtocolCorpusCoverageV2, generalRevitProtocolFixtureRootV2, loadGeneralRevitProtocolInputsV2, resolveGeneralRevitProtocolRunV2, writeGeneralRevitProtocolReportV2 } from "../benchmark/protocol_v2_general_revit.js";
import { baselineCaseDeltas, computerPerformanceSummary, groupedMultiSummary,
  groupedSummary } from "../benchmark/general_revit_trace_reporting.js";

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
  return revitHealthDocumentTitle(health);
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

function fixtureReadinessTimeoutMs(): number {
  const parsed = Number.parseInt(flag("--fixture-readiness-timeout-ms", "45000"), 10);
  return Number.isFinite(parsed) ? Math.max(5_000, Math.min(2 * 60_000, parsed)) : 45_000;
}

async function readExactFixtureHealth(
  baseUrl: string,
  expectedDocumentTitle: string,
  preferCached = false
): Promise<ExactRevitFixtureHealthResult> {
  return waitForExactRevitFixtureHealth({
    expectedDocumentTitle,
    timeoutMs: fixtureReadinessTimeoutMs(),
    pollIntervalMs: 2_000,
    requiredConsecutiveMatches: 3,
    readHealth: (remainingMs) => requestJson(
      baseUrl,
      preferCached ? "/api/revit/health?prefer_cached=1" : "/api/revit/health",
      {},
      Math.max(1_000, Math.min(healthTimeoutMs(), remainingMs))
    )
  });
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
  const sampleEvery = Number.parseInt(flag("--sample-every", "1"), 10);
  const sampleOffset = Number.parseInt(flag("--sample-offset", "0"), 10);
  if (!Number.isInteger(sampleEvery) || sampleEvery < 1) throw new Error("--sample-every must be a positive integer.");
  if (!Number.isInteger(sampleOffset) || sampleOffset < 0 || sampleOffset >= sampleEvery) {
    throw new Error("--sample-offset must be an integer from zero through sample-every minus one.");
  }
  const sampled = sampleEvery === 1
    ? filtered
    : filtered.filter((_entry, index) => index % sampleEvery === sampleOffset);
  const limit = Number.parseInt(flag("--limit", `${sampled.length}`), 10);
  return sampled.slice(0, Number.isFinite(limit) && limit >= 0 ? limit : sampled.length);
}

function fileStamp(): string {
  return nowIso().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}

function numberValue(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
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
  const modelCallReceipts = modelCallReceiptsFromSources(rawAttempt, rawAttempt.computer_state, trace);
  const modelCallSummary = aggregateModelCallReceipts(modelCallReceipts);
  return {
    ...trace,
    model_call_receipts: modelCallReceipts,
    efficiency: {
      ...asRecord(trace.efficiency),
      token_count: modelCallSummary.total_tokens,
      model_call_summary: modelCallSummary
    },
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

function computerStateHasMessage(state: JsonRecord, messageId: string): boolean {
  return Array.isArray(state.messages)
    && state.messages.some((value) => String(asRecord(value).id || "") === messageId);
}

async function waitForComputerIdle(baseUrl: string, timeoutMs: number, label: string): Promise<JsonRecord> {
  const deadline = Date.now() + timeoutMs;
  let state = await requestJson(baseUrl, "/api/computer/state", {}, 30_000);
  while (state.running === true && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 500));
    state = await requestJson(baseUrl, "/api/computer/state", {}, 30_000);
  }
  if (state.running === true) throw new Error(`${label} could not start because the prior computer-use run did not become idle within ${timeoutMs}ms.`);
  return state;
}

function persistedRecoveryMessageId(state: JsonRecord): string {
  const events = Array.isArray(state.events) ? state.events.map(asRecord) : [];
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const match = String(events[index].text || "").match(/recovering message ([A-Za-z0-9._:-]{1,300}) from its persisted result/i);
    if (match) return match[1];
  }
  return "";
}

async function recoverTimedOutModelTelemetry(baseUrl: string, state: JsonRecord): Promise<JsonRecord> {
  const sessionId = String(state.backendSessionId || "").trim();
  const messageId = persistedRecoveryMessageId(state);
  if (!sessionId || !messageId) {
    return { status: "unavailable", reason: "persisted_result_identity_missing", model_call_receipts: [] };
  }
  const deadline = Date.now() + 30_000;
  let last: JsonRecord = {};
  while (Date.now() < deadline) {
    last = await requestJson(baseUrl, "/api/computer/model-telemetry/recover", {
      method: "POST",
      body: JSON.stringify({ session_id: sessionId, message_id: messageId })
    }, Math.min(15_000, Math.max(1_000, deadline - Date.now())));
    const receipts = modelCallReceiptsFromSources(last);
    if (String(last.status || "") !== "pending") {
      return { ...last, session_id: sessionId, message_id: messageId, model_call_receipts: receipts };
    }
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  return { ...last, status: "pending_timeout", session_id: sessionId, message_id: messageId, model_call_receipts: [] };
}

async function ensureFixtureActive(
  baseUrl: string,
  fixtureKey: string,
  fixture: { document_title: string; sample_filename: string },
  fixtureRoot: string,
  speedSettings: JsonRecord | null,
  forceReopen = false
): Promise<JsonRecord> {
  const startedAt = nowIso();
  const startedMs = Date.now();
  let before: JsonRecord;
  try {
    before = await requestJson(baseUrl, "/api/revit/health", {}, healthTimeoutMs());
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!/REVIT_CONTEXT_HOST_STARTING|no fully opened model|no active document/i.test(message)) throw error;
    // Revit Home is a valid fixture-transition starting point. Preserve the
    // cold-start observation, then let the deterministic fixture opener create
    // the first authoritative document context instead of requiring a person
    // to open a model before `run the benchmark` can begin.
    before = {
      ok: false,
      cold_start: true,
      code: "REVIT_CONTEXT_HOST_STARTING",
      error: message
    };
  }
  if (healthDocumentTitle(before) === fixture.document_title && !forceReopen) {
    const stable = await readExactFixtureHealth(baseUrl, fixture.document_title);
    return {
      fixture: fixtureKey,
      expected_document_title: fixture.document_title,
      action: "already_active",
      started_at: startedAt,
      finished_at: nowIso(),
      duration_ms: Date.now() - startedMs,
      before,
      after: stable.health,
      readiness_attempts: stable.attempts
    };
  }
  const samplePath = path.resolve(fixtureRoot, fixture.sample_filename);
  if (!fs.existsSync(samplePath)) throw new Error(`Fixture file does not exist: ${samplePath}`);
  await waitForComputerIdle(baseUrl, Math.min(fixtureTimeoutMs(), 60_000), `Fixture transition ${fixtureKey}`);
  const deterministicDeadline = startedMs + fixtureTimeoutMs();
  let deterministicConflictRetries = 0;
  try {
    let deterministic: JsonRecord;
    while (true) {
      try {
        deterministic = await requestJson(baseUrl, "/api/benchmark/revit-fixture/open", {
          method: "POST",
          body: JSON.stringify({
            fixture: fixtureKey,
            sample_path: samplePath,
            expected_document_title: fixture.document_title,
            force_reopen: forceReopen
          })
        }, Math.max(1_000, deterministicDeadline - Date.now()));
        break;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const actionStillDraining = /POST \/api\/benchmark\/revit-fixture\/open returned 502:[\s\S]*409[\s\S]*(?:action in flight|Retry after that action completes)/i.test(message);
        if (!actionStillDraining || Date.now() + 1_000 >= deterministicDeadline) throw error;
        deterministicConflictRetries += 1;
        await new Promise((resolve) => setTimeout(resolve, 1_000));
      }
    }
    const after = asRecord(deterministic.health);
    if (healthDocumentTitle(after) !== fixture.document_title) {
      throw new Error(`Deterministic fixture transition ${fixtureKey} returned without the exact authoritative target title.`);
    }
    const stable = await readExactFixtureHealth(baseUrl, fixture.document_title);
    return {
      fixture: fixtureKey,
      expected_document_title: fixture.document_title,
      sample_path: samplePath,
      action: "opened_deterministically",
      started_at: startedAt,
      finished_at: nowIso(),
      duration_ms: Date.now() - startedMs,
      before,
      after: stable.health,
      readiness_attempts: stable.attempts,
      action_in_flight_retries: deterministicConflictRetries,
      deterministic_response: deterministic
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!/POST \/api\/benchmark\/revit-fixture\/open returned 404:/.test(message)) throw error;
  }
  const prompt = [
    "Benchmark fixture transition. The user explicitly authorized opening, saving, or discarding changes in Autodesk sample models for this test campaign; do not ask for confirmation.",
    `In the currently running Revit instance, use the Revit bridge primitive revit_open_model to open and activate exactly: ${samplePath}`,
    `Use audit=false, detach=false, discardExistingOpenDocument=true, and continueOnUnresolvedReferences=true. ${forceReopen ? "Close the active sample without saving and reopen this exact target even if it is already active; this resets the disposable fixture between benchmark cases." : "If that exact target document is already open but inactive, you are explicitly authorized to close it without saving and reopen it so it becomes active."} If Revit reports unresolved references, you are explicitly authorized to ignore that warning and continue opening this disposable sample fixture. Do not modify model content. Do not launch another Revit process and do not use Windows file association.`,
    `Finish only after the authoritative active document title is exactly '${fixture.document_title}'.`
  ].join("\n");
  let runResponse: JsonRecord = {};
  let transportError = "";
  const messageId = id(`fixture-${fixtureKey}`);
  try {
    runResponse = await requestJson(baseUrl, "/api/computer/run", {
      method: "POST",
      body: JSON.stringify({
        prompt,
        message_id: messageId,
        ...(speedSettings ? { speed_settings: speedSettings } : {})
      })
    }, Math.min(fixtureTimeoutMs(), 30_000));
  } catch (error) {
    transportError = error instanceof Error ? error.message : String(error);
  }
  const deadline = Date.now() + fixtureTimeoutMs();
  let computerState = await requestJson(baseUrl, "/api/computer/state", {}, 30_000);
  let after: JsonRecord | null = null;
  let targetVerifiedWhileAgentRunning = false;
  const healthObservationErrors: string[] = [];
  let nextHealthObservationAt = Date.now() + 5_000;
  while (computerState.running === true && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    computerState = await requestJson(baseUrl, "/api/computer/state", {}, 30_000);
    if (computerState.running === true && Date.now() >= nextHealthObservationAt) {
      nextHealthObservationAt = Date.now() + 5_000;
      const remainingMs = Math.max(1_000, deadline - Date.now());
      try {
        after = await requestJson(baseUrl, "/api/revit/health", {}, Math.min(45_000, remainingMs));
      } catch (error) {
        healthObservationErrors.push(error instanceof Error ? error.message : String(error));
      }
      if (after && healthDocumentTitle(after) === fixture.document_title) {
        // Opening a document invalidates the old document-bound teammate turn.
        // Once an independent live health read proves the exact new title, stop
        // the now-redundant turn instead of waiting for it to verify against its
        // stale pre-open binding until the fixture timeout expires.
        targetVerifiedWhileAgentRunning = true;
        await stopComputerRunBestEffort(baseUrl);
        computerState = await waitForComputerIdle(baseUrl, Math.min(30_000, remainingMs), `Fixture transition ${fixtureKey}`);
        break;
      }
    }
  }
  if (computerState.running === true) {
    await stopComputerRunBestEffort(baseUrl);
    throw new Error(`Fixture transition ${fixtureKey} exceeded ${fixtureTimeoutMs()}ms; the abandoned Operator turn was stopped.`);
  }
  if (!computerStateHasMessage(computerState, messageId)) {
    throw new Error(`Fixture transition ${fixtureKey} did not own the observed computer-use run; refusing to grade another runner's state.`);
  }
  if (transportError && !String(computerState.error || "").trim()) transportError = "";
  after = after && healthDocumentTitle(after) === fixture.document_title
    ? after
    : await requestJson(baseUrl, "/api/revit/health", {}, healthTimeoutMs());
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
  const stable = await readExactFixtureHealth(baseUrl, fixture.document_title);
  after = stable.health;
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
    transport_error: transportError || null,
    target_verified_while_agent_running: targetVerifiedWhileAgentRunning,
    health_observation_errors: healthObservationErrors,
    readiness_attempts: stable.attempts
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

async function runComputerCase(
  baseUrl: string,
  testCase: GeneralRevitCapabilityCase,
  processGuard: LocalRevitProcessGuardTarget | null,
  speedSettings: JsonRecord | null,
  interaction: BenchmarkInteractionCaseV1 | null,
  directVariant: boolean
): Promise<{ attempt: JsonRecord; sessionId: string }> {
  const timeoutMs = Number.parseInt(flag("--timeout-ms", "600000"), 10) || 600_000;
  await waitForComputerIdle(baseUrl, Math.min(timeoutMs, 60_000), `Case ${testCase.case_id}`);
  await requestJson(baseUrl, "/api/computer/reset", { method: "POST", body: "{}" }, 30_000);
  const basePrompt = process.argv.includes("--apply") ? testCase.prompt : testCase.probe_prompt;
  const firstPrompt = directVariant ? interaction!.direct_variant!.candidate_visible_user_text : basePrompt;
  const first = await executeGeneralRevitComputerTurn({
    baseUrl, caseId: testCase.case_id, prompt: firstPrompt, messageId: id(`capability-${testCase.case_id}-turn-1`), processGuard, speedSettings,
    timeoutMs, requestJson, recoverTimedOutModelTelemetry
  });
  const firstAssistant = assistantTextFromComputerState(first.state);
  let finalTurn = first;
  let clarificationId = "";
  if (interaction && !directVariant) {
    const clarification = pendingComputerClarification(first.state);
    clarificationId = String(clarification.clarification_id || clarification.id || "").trim();
    if (!clarificationId) {
      first.transportError = first.transportError
        ? `${first.transportError} Interactive case did not expose a structured pending clarification.`
        : "Interactive case did not expose a structured pending clarification; candidate-visible user input was not supplied.";
    } else {
      try {
        finalTurn = await executeGeneralRevitComputerTurn({
          baseUrl, caseId: testCase.case_id,
          prompt: interaction.clarification_response.candidate_visible_user_text, messageId: id(`capability-${testCase.case_id}-turn-2`),
          processGuard, speedSettings, timeoutMs, requestJson, recoverTimedOutModelTelemetry,
          clarificationResponse: bindComputerClarificationResponse(clarification, interaction.clarification_response.supplied_values)
        });
      } catch (error) {
        first.transportError = [first.transportError, error instanceof Error ? error.message : String(error)].filter(Boolean).join(" ");
      }
    }
  }
  const turns = finalTurn === first ? [first] : [first, finalTurn]; const interactionModelCallReceipts = modelCallReceiptsFromComputerTurns(turns);
  const state = interactionModelCallReceipts.length > 0 ? { ...finalTurn.state, modelCallReceipts: interactionModelCallReceipts } : finalTurn.state;
  let transportError = [first.transportError, finalTurn === first ? "" : finalTurn.transportError].filter(Boolean).join(" ");
  const ownsObservedRun = computerStateHasMessage(state, finalTurn.messageId);
  if (!ownsObservedRun) {
    transportError = transportError
      ? `${transportError} The final computer state did not contain this case's message id.`
      : `The final computer state did not contain this case's message id; refusing to grade another runner's state.`;
  } else if (transportError && state.running !== true && !String(state.error || "").trim()) {
    transportError = "";
  }
  const actions = [...sidecarFunctionReceiptActions(state), ...dynamicReceiptActions(state)];
  const teammateLoopReceipt = teammateLoopReceiptFromFunctionState(state);
  const successfulActions = actions.filter((action) => action.request_dispatched === true);
  const applySucceeded = successfulActions.some((action) => action.request_effect === "apply");
  const receiptSucceeded = successfulActions.length > 0;
  const stateError = String(state.error || "").trim();
  const attempt = {
    ...finalTurn.runResponse,
    // Transport success and requested-effect success are separate facts. The
    // evaluator below owns effect truth because it can also inspect the durable
    // assignment and recognize a server-verified no-op without inventing a write.
    ok: transportError === "" && stateError === "" && finalTurn.runResponse.ok !== false,
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
    harness_timeout_settlement: finalTurn.timeoutSettlement,
    harness_context_loss_settlement: finalTurn.contextLossSettlement,
    harness_model_telemetry_recovery: finalTurn.modelTelemetryRecovery,
    model_call_receipts: interactionModelCallReceipts,
    protocol_v2_interaction: interaction ? benchmarkInteractionTraceV1({
      interaction, directVariant, firstMessageId: first.messageId, firstPrompt, firstAssistant,
      finalMessageId: finalTurn.messageId, finalAssistant: assistantTextFromComputerState(state), clarificationId
    }) : undefined,
    computer_state: state
  };
  return { attempt, sessionId: String(state.backendSessionId || "").trim() };
}

async function runCase(
  baseUrl: string,
  testCase: GeneralRevitCapabilityCase,
  suiteContext: JsonRecord,
  corpusTaskTypes: string[],
  preferredFixture: string,
  preferredDocumentTitle: string,
  interaction: BenchmarkInteractionCaseV1 | null,
  directVariant: boolean
): Promise<JsonRecord> {
  const startedAt = nowIso();
  const startedMs = Date.now();
  const applyRequested = suiteContext.apply_requested === true;
  const executionCase = generalRevitExecutionCase(testCase, applyRequested);
  const executionExpectedEffect = executionCase.expected_effect;
  const requestedSpeedSettings = asRecord(suiteContext.requested_speed_settings);
  const speedSettings = Object.keys(requestedSpeedSettings).length > 0 ? requestedSpeedSettings : null;
  // Hosted production uses the durable Revit courier. A healthy background or
  // minimized workstation can legitimately need more than 30 seconds to claim,
  // execute, and settle the certified context job. Treat that as benchmark
  // transport latency, not a model failure, while keeping the wait bounded.
  const initialHealthStartedAt = Date.now();
  const initialReadiness = suiteContext.fixture_health_is_authoritative === true
    // The fixture orchestrator has just established exact live document
    // identity. Reuse that coordinated health snapshot between cases instead
    // of serializing another slow native bridge health job. Tool execution and
    // effect verification remain live and authoritative.
    ? await readExactFixtureHealth(baseUrl, preferredDocumentTitle, true)
    : { health: await requestJson(baseUrl, "/api/revit/health", {}, healthTimeoutMs()), attempts: 1 };
  const initialState = initialReadiness.health;
  const initialHealthDurationMs = Date.now() - initialHealthStartedAt;
  const useComputer = executionSurface() === "operator_computer_general_agent";
  let sessionId = "";
  let attempt: JsonRecord;
  if (useComputer) {
    const computerResult = await runComputerCase(
      baseUrl,
      testCase,
      localRevitProcessGuardTarget(baseUrl, initialState),
      speedSettings,
      interaction,
      directVariant
    );
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
          context: {
            ui: {
              client: "operator-desktop",
              surface: "general-revit-capability-acceptance",
              ...(speedSettings ? { speed_settings: speedSettings } : {})
            }
          }
        })
      }, Number.parseInt(flag("--timeout-ms", "180000"), 10) || 180_000);
    } catch (error) {
      attempt = { ok: false, error: error instanceof Error ? error.message : String(error), effect_state: "not_dispatched" };
    }
  }
  let finalHealthDurationMs = 0;
  const finalHealthStartedAt = Date.now();
  const finalHealthPath = applyRequested ? "/api/revit/health" : "/api/revit/health?prefer_cached=1";
  const finalHealthPromise = requestJson(baseUrl, finalHealthPath, {}, healthTimeoutMs())
    .catch((error) => ({ ok: false, error: String(error) }))
    .finally(() => { finalHealthDurationMs = Date.now() - finalHealthStartedAt; });
  const [finalState, assignmentProjection, assignmentKernelV2] = await Promise.all([
    finalHealthPromise,
    (sessionId
      ? requestJson(baseUrl, `/api/assignments?limit=10&session_id=${encodeURIComponent(sessionId)}`, {}, 30_000)
      : Promise.resolve({ ok: false, error: "Computer run did not expose a backend session id." }))
      .catch((error) => ({ ok: false, error: String(error) })),
    loadAssignmentKernelPublicationsV2(baseUrl, sessionId, requestJson)
  ]);
  const durableWorkPackets = await loadVerifiedWorkPackets(baseUrl, assignmentProjection, requestJson);
  const executedPrompt = applyRequested ? testCase.prompt : testCase.probe_prompt;
  const durableToolEvidence = await loadDurableToolEvidence(baseUrl, assignmentProjection, executedPrompt, {
    session_id: sessionId,
    started_at: startedAt
  });
  const evaluatedAttempt = {
    ...attempt,
    assignment_projection: assignmentProjection,
    durable_tool_evidence: durableToolEvidence
  };
  const evaluation = evaluateGeneralRevitCapabilityAttempt(executionCase, evaluatedAttempt as GeneralRevitAttempt);
  const toolCalls = extractToolCalls(attempt);
  const modelCallReceipts = modelCallReceiptsFromSources(attempt, attempt.computer_state);
  const modelCallSummary = aggregateModelCallReceipts(modelCallReceipts);
  const computerState = asRecord(attempt.computer_state);
  const sidecarRequestedSpeedSettings = asRecord(computerState.requestedSpeedSettings);
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
    context_supplied: {
      session_id: sessionId,
      ui_surface: "general-revit-capability-acceptance",
      requested_speed_settings: speedSettings,
      sidecar_requested_speed_settings: Object.keys(sidecarRequestedSpeedSettings).length > 0
        ? sidecarRequestedSpeedSettings
        : asRecord(computerState.requested_speed_settings),
      suite: suiteContext
    },
    agent_reasoning_plan_representation: Array.isArray(attempt.rounds) ? attempt.rounds : [],
    model_call_receipts: modelCallReceipts,
    tool_calls: toolCalls,
    tool_results: {
      response_effect_state: attempt.effect_state ?? "not_dispatched",
      outcome_unknown: attempt.outcome_unknown === true,
      reconciliation_required: attempt.reconciliation_required === true,
      durable_assignment_projection: assignmentProjection,
      durable_assignment_kernel_v2: assignmentKernelV2,
      durable_tool_evidence: durableToolEvidence,
      durable_work_packets: durableWorkPackets,
      raw_sidecar_response_sha256: sha256(evaluatedAttempt),
      raw_sidecar_response: evaluatedAttempt
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
    ...(asRecord(attempt.protocol_v2_interaction).transformation_id
      ? { protocol_v2_interaction: attempt.protocol_v2_interaction }
      : {}),
    final_model_state: finalState,
    success_failure_score: {
      tier: evaluation.tier,
      non_refusal: evaluation.non_refusal,
      completed: evaluation.completed,
      verified: evaluation.verified
    },
    efficiency: {
      duration_ms: Date.now() - startedMs,
      token_count: modelCallSummary.total_tokens,
      model_call_summary: modelCallSummary,
      tool_call_count: toolCalls.length,
      round_count: Array.isArray(attempt.rounds) ? attempt.rounds.length : 0,
      harness_health_ms: {
        initial: initialHealthDurationMs,
        initial_attempts: initialReadiness.attempts,
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
      "npm run probe:general-revit-capabilities -- [--suite smoke|redline|challenge|terse|research|long-horizon|production|code-execution|full] [--fixture snowdon_hvac|snowdon_plumbing|snowdon_electrical | --orchestrate-fixtures] [--fixture-root DIR] [--case ID[,ID] | --release-canary] [--protocol-v2-envelope FILE --lane controlled_capability|ambient_context|safe_readiness|committed_apply] [--interaction-manifest FILE] [--direct-variant] [--sidecar URL] [--source SOURCE] [--limit N] [--timeout-ms N] [--health-timeout-ms N] [--fixture-readiness-timeout-ms N] [--fixture-timeout-ms N] [--agent-model MODEL] [--agent-effort none|low|medium|high|xhigh|max] [--sample-every N] [--sample-offset N] [--isolate-cases | --reuse-fixture-state] [--output FILE | --output-dir DIR] [--resume CHECKPOINT] [--rescore-only] [--allow-corpus-drift] [--baseline FILE] [--label TEXT] [--list-cases] [--legacy-chat] [--apply] [--require-completion]",
      "",
      "The corpus is representative regression coverage, not a capability allowlist. By default every case uses the same General Agent computer lane as the Operator UI and sends the non-mutating probe_prompt; --apply sends and scores the production mutation. --legacy-chat is retained only for transport diagnostics and does not represent the product General Agent. Each completed case is durably checkpointed, and --resume continues an interrupted run. --rescore-only requires --resume and rebuilds reports from recorded flight data without contacting Sidecar or Revit. Use --allow-corpus-drift only with --rescore-only to audit historical traces against the current compatible case IDs and truth policy."
    ].join("\n"));
    return;
  }
  const invocationStartedMs = Date.now();
  const invocationStartedAt = nowIso();
  const externalHoldoutPath = flag("--external-holdout");
  const protocolInputs = loadGeneralRevitProtocolInputsV2(externalHoldoutPath);
  const { corpus, fixtureConfig, externalHoldout } = protocolInputs;
  const interactionManifestPath = flag("--interaction-manifest");
  const interactionManifest: BenchmarkInteractionManifestV1 | null = interactionManifestPath
    ? loadBenchmarkInteractionManifestV1(interactionManifestPath)
    : null;
  const interactionManifestSha256 = interactionManifestPath
    ? crypto.createHash("sha256").update(fs.readFileSync(path.resolve(interactionManifestPath))).digest("hex")
    : "";
  const directVariant = process.argv.includes("--direct-variant");
  if (directVariant && !interactionManifest) throw new Error("--direct-variant requires --interaction-manifest.");
  const requestedFixture = flag("--fixture").trim().toLowerCase();
  const orchestrateFixtures = process.argv.includes("--orchestrate-fixtures");
  if (requestedFixture && orchestrateFixtures) throw new Error("Use either --fixture or --orchestrate-fixtures, not both.");
  if (requestedFixture && !fixtureConfig.fixtures[requestedFixture]) {
    throw new Error(`Unknown General Revit sample fixture '${requestedFixture}'.`);
  }
  const applyRequested = process.argv.includes("--apply");
  if (directVariant && !applyRequested) throw new Error("--direct-variant requires the committed --apply lane.");
  if (process.argv.includes("--isolate-cases") && process.argv.includes("--reuse-fixture-state")) {
    throw new Error("Use either --isolate-cases or --reuse-fixture-state, not both.");
  }
  const isolateCases = process.argv.includes("--isolate-cases")
    || (applyRequested && !process.argv.includes("--reuse-fixture-state"));
  let selected = selectCases(corpus.cases).filter((entry) => !requestedFixture
    || generalRevitFixtureForCase(fixtureConfig, entry.case_id) === requestedFixture);
  const releaseCanary = process.argv.includes("--release-canary");
  if (releaseCanary) {
    if (flagValues("--case").length > 0 || process.argv.includes("--resume")) throw new Error("Release canary uses the frozen ten-case selector and is non-resumed by default.");
    selected = selectReleaseCanaryCasesV2(corpus.cases).filter((entry) => !requestedFixture
      || generalRevitFixtureForCase(fixtureConfig, entry.case_id) === requestedFixture);
  }
  const selectedFixtureKeys = new Set(selected.map((entry) => generalRevitFixtureForCase(fixtureConfig, entry.case_id)));
  if (orchestrateFixtures) {
    const fixtureOrder = Object.keys(fixtureConfig.fixtures);
    selected = [...selected].sort((left, right) => fixtureOrder.indexOf(generalRevitFixtureForCase(fixtureConfig, left.case_id))
      - fixtureOrder.indexOf(generalRevitFixtureForCase(fixtureConfig, right.case_id)));
  }
  if (selected.length === 0) throw new Error("No cases matched the requested filters.");
  const unknownInteractionCases = interactionManifest?.cases
    .filter(entry => !corpus.cases.some(candidate => candidate.case_id === entry.source_case_id))
    .map(entry => entry.source_case_id) ?? [];
  if (unknownInteractionCases.length > 0) throw new Error(`Interaction manifest references unknown source case(s): ${unknownInteractionCases.join(", ")}.`);
  if (directVariant) {
    const unavailable = selected.filter(entry => !benchmarkInteractionCaseV1(interactionManifest, entry.case_id)?.direct_variant);
    if (unavailable.length > 0) throw new Error(`Direct variant is unavailable for selected case(s): ${unavailable.map(entry => entry.case_id).join(", ")}.`);
  }
  if (process.argv.includes("--list-cases")) {
    console.log(JSON.stringify(selected.map((entry) => ({
      case_id: entry.case_id,
      source: entry.source,
      operation_family: entry.operation_family,
      preferred_fixture: generalRevitFixtureForCase(fixtureConfig, entry.case_id),
      prompt_specificity: generalRevitPromptSpecificity(entry),
      ...(externalHoldout ? {} : { prompt: entry.prompt })
    })), null, 2));
    return;
  }
  const sidecar = flag("--sidecar", "http://127.0.0.1:3907").replace(/\/$/, "");
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
  const protocolEnvelopePath = flag("--protocol-v2-envelope");
  const protocolRun = resolveGeneralRevitProtocolRunV2({ envelopePath: protocolEnvelopePath, releaseCanary,
    legacyProtocol: process.argv.includes("--legacy-protocol-v1"), proposedRunId: runId, applyRequested,
    requestedFixture, orchestrateFixtures, laneFlag: flag("--lane"), inputs: protocolInputs });
  const protocolDraft = protocolRun.draft;
  const boundInteractionHash = String(protocolDraft?.feature_flags.benchmark_interaction_manifest_sha256 || "").trim();
  if (protocolDraft && interactionManifest && boundInteractionHash !== interactionManifestSha256) {
    throw new Error("Protocol V2 envelope does not bind the exact benchmark interaction manifest hash.");
  }
  if (protocolDraft && !interactionManifest && boundInteractionHash) {
    throw new Error("Protocol V2 envelope requires the bound benchmark interaction manifest.");
  }
  runId = protocolRun.runId;
  const explicitOutput = flag("--output");
  const outputDir = flag("--output-dir");
  if (explicitOutput && outputDir) throw new Error("Use either --output or --output-dir, not both.");
  const resolvedOutputDir = outputDir ? path.resolve(outputDir) : "";
  const output = explicitOutput
    ? path.resolve(explicitOutput)
    : resolvedOutputDir
      ? path.join(resolvedOutputDir, runId, "report.json")
      : path.resolve(`general-revit-capability-report-${Date.now()}.json`);
  assertGeneralRevitProtocolOutputV2(protocolInputs, output, protocolDraft !== null);
  const summaryOutput = resolvedOutputDir ? path.join(resolvedOutputDir, runId, "summary.md") : output.replace(/\.json$/i, ".md");
  const priorSuiteContext = asRecord(resumedCheckpoint?.suite_context);
  const priorComputerAgent = asRecord(priorSuiteContext.computer_agent);
  const priorSuiteTiming = asRecord(resumedCheckpoint?.suite_timing);
  const requestedComputerAgent = requestedComputerAgentConfig(process.argv, priorComputerAgent);
  const requestedSpeedSettings = speedSettingsForRequestedConfig(requestedComputerAgent);
  const suiteStartedAt = String(priorSuiteTiming.started_at_utc || invocationStartedAt);
  const priorActiveWallClockMs = numberValue(priorSuiteTiming.active_wall_clock_ms);
  const [config, grant] = rescoreOnly
    ? [{
      runtimeProfile: asRecord(priorSuiteContext.runtime_profile),
      computerModel: requestedComputerAgent.agent_model
    }, asRecord(priorSuiteContext.write_grant)]
    : await Promise.all([
      requestJson(sidecar, "/api/config", {}, 30_000),
      requestJson(sidecar, "/api/revit/write-grant", {}, 30_000)
    ]);
  const runtimeProfile = asRecord(config.runtimeProfile);
  if (runtimeProfile.general_agent !== true) throw new Error("General Agent is unavailable; refusing to misreport a capability run.");
  let fixturePreflight: JsonRecord = {};
  let fixturePreflightAttempts = 0;
  if (requestedFixture && !rescoreOnly) {
    const expectedTitle = fixtureConfig.fixtures[requestedFixture].document_title;
    const readiness = await readExactFixtureHealth(sidecar, expectedTitle);
    fixturePreflight = readiness.health;
    fixturePreflightAttempts = readiness.attempts;
  }
  const suiteContext = {
    sidecar,
    execution_surface: executionSurface(),
    runtime_profile: runtimeProfile,
    write_grant: safeGrant(grant),
    computer_agent: {
      configuration_source: requestedSpeedSettings ? (resumedCheckpoint ? "resume_or_cli" : "benchmark_cli") : "unspecified",
      requested: requestedComputerAgent,
      observed_provider_calls: null,
      agent_model: requestedComputerAgent.agent_model,
      agent_reasoning_effort: requestedComputerAgent.agent_reasoning_effort
    },
    requested_speed_settings: requestedSpeedSettings,
    corpus_schema: corpus.schema_version,
    corpus_sha256: sha256(corpus),
    fixture_schema: fixtureConfig.schema,
    fixture_config_sha256: sha256(fixtureConfig),
    fixture_selection: requestedFixture || (orchestrateFixtures ? "orchestrated" : "single_fixture_unpinned"),
    fixture_health_is_authoritative: Boolean(requestedFixture || orchestrateFixtures),
    fixture_root: orchestrateFixtures ? path.resolve(flag("--fixture-root", "C:\\Program Files\\Autodesk\\Revit 2024\\Samples")) : null,
    fixture_transitions: (Array.isArray(priorSuiteContext.fixture_transitions)
      ? priorSuiteContext.fixture_transitions.map(asRecord)
      : []) as JsonRecord[],
    fixture_preconditions: (Array.isArray(priorSuiteContext.fixture_preconditions) ? priorSuiteContext.fixture_preconditions.map(asRecord) : []) as JsonRecord[],
    fixture_preflight: requestedFixture ? {
      document_title: asRecord(asRecord(fixturePreflight.context).document).title ?? null,
      document_path: asRecord(asRecord(fixturePreflight.context).document).path ?? null,
      preferred_fixture: requestedFixture,
      readiness_attempts: fixturePreflightAttempts
    } : null,
    apply_requested: applyRequested,
    benchmark_interaction: interactionManifest ? {
      schema: interactionManifest.schema,
      manifest_id: interactionManifest.manifest_id,
      manifest_sha256: interactionManifestSha256,
      selected_interactive_case_ids: selected.filter(entry => benchmarkInteractionCaseV1(interactionManifest, entry.case_id)).map(entry => entry.case_id),
      execution_mode: directVariant ? "direct_variant" : "interactive_when_configured",
      evaluator_oracle_hashes: Object.fromEntries(selected.flatMap(entry => {
        const interaction = benchmarkInteractionCaseV1(interactionManifest, entry.case_id);
        return interaction ? [[entry.case_id, interaction.evaluator_oracle.sha256]] : [];
      }))
    } : null,
    fixture_isolation: {
      enabled: isolateCases,
      policy: isolateCases
        ? "close without saving and reopen the canonical sample before every case"
        : "fixture state may be reused across cases"
    },
    mutation_policy: applyRequested
      ? "production prompts; mutation explicitly requested by the test operator"
      : "safe probe prompts only; no apply requested",
    sampling: {
      every: Number.parseInt(flag("--sample-every", "1"), 10),
      offset: Number.parseInt(flag("--sample-offset", "0"), 10),
      selected_case_count: selected.length
    }
  };
  if (resumedCheckpoint) {
    const priorContext = asRecord(resumedCheckpoint.suite_context);
    const priorRequested = requestedComputerAgentConfig([], asRecord(priorContext.computer_agent));
    if (String(priorContext.corpus_sha256 || "") !== String(suiteContext.corpus_sha256) && !allowCorpusDrift) {
      throw new Error("Resume checkpoint was produced from a different benchmark corpus.");
    }
    if (String(resumedCheckpoint.suite || "") !== suite || priorContext.apply_requested !== applyRequested) {
      throw new Error("Resume checkpoint suite or mutation mode does not match this invocation.");
    }
    if (JSON.stringify(priorRequested) !== JSON.stringify(requestedComputerAgent)) {
      throw new Error("Resume checkpoint requested a different unified agent model configuration.");
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
  const fixtureRoot = generalRevitProtocolFixtureRootV2(protocolInputs, flag("--fixture-root", "C:\\Program Files\\Autodesk\\Revit 2024\\Samples"));
  const suiteTimingSnapshot = (finishedAt: string | null = null): JsonRecord => {
    const nowMs = Date.now();
    const parsedStart = Date.parse(suiteStartedAt);
    return {
      schema: "revit-operator.benchmark-suite-timing.v1",
      started_at_utc: suiteStartedAt,
      finished_at_utc: finishedAt,
      last_checkpoint_at_utc: finishedAt || nowIso(),
      wall_clock_ms: Number.isFinite(parsedStart) ? Math.max(0, nowMs - parsedStart) : null,
      active_wall_clock_ms: priorActiveWallClockMs + Math.max(0, nowMs - invocationStartedMs),
      resumed: resumedCheckpoint !== null
    };
  };
  for (const testCase of rescoreOnly ? [] : selected.filter((entry) => !completedIds.has(entry.case_id))) {
    const preferredFixture = generalRevitFixtureForCase(fixtureConfig, testCase.case_id);
    if ((orchestrateFixtures || requestedFixture) && (isolateCases || preferredFixture !== activeFixtureKey)) {
      console.log(`[fixture] ${preferredFixture}`);
      const transition = await ensureFixtureActive(
        sidecar,
        preferredFixture,
        fixtureConfig.fixtures[preferredFixture],
        fixtureRoot,
        requestedSpeedSettings,
        isolateCases
      );
      (suiteContext.fixture_transitions as JsonRecord[]).push(transition);
      activeFixtureKey = preferredFixture;
    }
    if (testCase.fixture_precondition) {
      console.log(`[fixture-precondition] ${testCase.case_id}`);
      const prepared = await requestJson(sidecar, "/api/benchmark/revit-fixture/prepare-case", {
        method: "POST",
        body: JSON.stringify({ fixture: preferredFixture, expected_document_title: fixtureConfig.fixtures[preferredFixture].document_title,
          case_id: testCase.case_id, precondition: testCase.fixture_precondition })
      }, fixtureTimeoutMs());
      (suiteContext.fixture_preconditions as JsonRecord[]).push(prepared);
    }
    console.log(`[${traces.length + 1}/${selected.length}] ${testCase.case_id}`);
    traces.push(await runCase(
      sidecar,
      testCase,
      suiteContext,
      corpusTaskTypesByCase.get(testCase.case_id) || [],
      preferredFixture,
      fixtureConfig.fixtures[preferredFixture].document_title,
      benchmarkInteractionCaseV1(interactionManifest, testCase.case_id),
      directVariant
    ));
    writeJsonFile(checkpointOutput, {
      schema: "revit-operator.general-revit-capability-checkpoint/v1",
      run_id: runId,
      suite,
      updated_at: nowIso(),
      suite_timing: suiteTimingSnapshot(),
      suite_context: suiteContext,
      selected_case_ids: [...selectedIds],
      completed_case_ids: traces.map((trace) => trace.case_id),
      task_traces: traces
    });
  }
  const suiteModelCallReceipts = modelCallReceiptsFromTraces(traces);
  const modelCallTelemetry = aggregateModelCallReceipts(suiteModelCallReceipts);
  const modelTelemetryCoverage = modelTelemetryCaseCoverage(traces);
  const requestedVsObserved = requestedVsObservedComputerAgent(requestedComputerAgent, modelCallTelemetry);
  const latencyTelemetry = summarizeGeneralRevitLatency(traces, suiteContext);
  const fixturePreconditionCoverage = summarizeGeneralRevitFixturePreconditionCoverage(
    selected,
    suiteContext.fixture_preconditions as JsonRecord[]
  );
  asRecord(suiteContext.computer_agent).observed_provider_calls = requestedVsObserved;
  const suiteTiming = rescoreOnly && Object.keys(priorSuiteTiming).length > 0
    ? priorSuiteTiming
    : suiteTimingSnapshot(nowIso());
  const evaluations = traces.map((trace) => asRecord(asRecord(trace.verification_results).evaluation));
  const summary = summarizeGeneralRevitCapabilityReport(evaluations as never);
  const summaryByVerificationBasis = Object.fromEntries([...new Set(evaluations.map((entry) => String(entry.verification_basis || "none")))]
    .sort().map((basis) => [basis, evaluations.filter((entry) => String(entry.verification_basis || "none") === basis).length]));
  const summaryByOperationFamily = groupedSummary(traces, "operation_family");
  const summaryBySpecificity = groupedSummary(traces, "prompt_specificity");
  const summaryByFixture = groupedSummary(traces, "preferred_fixture");
  const summaryByCorpusTaskType = groupedMultiSummary(traces, "corpus_task_types");
  const corpusCoverage = generalRevitProtocolCorpusCoverageV2(protocolInputs);
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
    suite_timing: suiteTiming,
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
    model_call_telemetry: modelCallTelemetry,
    model_telemetry_coverage: modelTelemetryCoverage,
    fixture_precondition_coverage: fixturePreconditionCoverage,
    latency_telemetry: latencyTelemetry,
    telemetry_valid_for_model_comparison: requestedSpeedSettings !== null
      && requestedVsObserved.comparable_configuration === true
      && modelTelemetryCoverage.complete === true
      && fixturePreconditionCoverage.complete === true
      && modelCallTelemetry.token_status === "complete"
      && modelCallTelemetry.cost_status === "estimated_from_exact_provider_tokens",
    task_traces: traces,
    report_sha256: sha256({ suiteContext, suiteTiming, summary, summaryByOperationFamily, summaryBySpecificity, summaryByFixture, summaryByVerificationBasis, summaryByCorpusTaskType, corpusCoverage, fixtureMismatchCount, fixtureUnverifiableCount, answerAssertionCaseCount, selectedAnswerAssertionCaseCount, caseDeltas, modelCallTelemetry, modelTelemetryCoverage, fixturePreconditionCoverage, latencyTelemetry, traces })
  };
  writeJsonFile(output, report);
  writeTextFile(summaryOutput, markdownReport(report));
  const protocolV2Output = rescoreOnly ? null : writeGeneralRevitProtocolReportV2({ draft: protocolDraft,
    envelopePath: protocolEnvelopePath, legacyReportPath: output, corpus, inputs: protocolInputs, releaseCanary });
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
  console.log(JSON.stringify({ output, protocol_v2_output: protocolV2Output, summary_output: summaryOutput, latest: resolvedOutputDir ? path.join(resolvedOutputDir, "latest.md") : null, summary }, null, 2));
  const requireCompletion = process.argv.includes("--require-completion");
  if (requestedSpeedSettings && report.telemetry_valid_for_model_comparison !== true) process.exitCode = 1;
  if (summary.refusal_count > 0 || summary.failure_count > 0 || (requireCompletion && summary.completed_count !== summary.total)) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  process.exitCode = 1;
});
