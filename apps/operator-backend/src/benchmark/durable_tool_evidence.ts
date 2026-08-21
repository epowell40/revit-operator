import crypto from "node:crypto";
import { conditionalActionPathEffect, pathLooksWrite } from "../action_path_mutability.js";
import { classifyOutcomeEnvelope, outcomeEnvelopeIsUnsafe } from "../outcome_envelope.js";

type JsonRecord = Record<string, unknown>;

function asRecord(value: unknown): JsonRecord {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonRecord : {};
}

function parsedRecord(value: unknown): JsonRecord {
  const direct = asRecord(value);
  if (Object.keys(direct).length > 0 || typeof value !== "string") return direct;
  try { return asRecord(JSON.parse(value)); } catch { return {}; }
}

function numberValue(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function parsedEnvelopeHasFailure(parsed: JsonRecord): boolean {
  const numericStatus = Number(parsed.status);
  if (Number.isFinite(numericStatus) && numericStatus >= 400) return true;
  if (typeof parsed.error === "string" && parsed.error.trim()) return true;
  const terminal = String(parsed.status || parsed.outcome || "").trim().toLowerCase();
  return ["failed", "error", "blocked", "outcome_unknown", "reconciliation_required"].includes(terminal);
}

function sha256(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as JsonRecord)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => `${JSON.stringify(key)}:${canonicalJson(child)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

const RECOVERY_CONTROL_KEYS = new Set([
  "apply", "dryRun", "dry_run", "preview", "mode", "method", "timeout", "timeoutMs",
  "transaction", "request_effect", "requestEffect", "maxElements", "maxResults", "limit", "offset",
  "page", "pageSize", "continuationToken", "discardExistingOpenDocument"
]);

function recoveryTarget(value: JsonRecord): JsonRecord | null {
  const target = Object.fromEntries(Object.entries(value)
    .filter(([key, child]) => !RECOVERY_CONTROL_KEYS.has(key) && child !== undefined));
  return Object.keys(target).length > 0 ? target : null;
}

function requestEffect(path: string, argumentsRecord: JsonRecord, body: JsonRecord): "read" | "preview" | "apply" {
  const declared = String(argumentsRecord.request_effect || argumentsRecord.requestEffect || "").trim().toLowerCase();
  if (declared === "read" || declared === "preview" || declared === "apply") return declared;
  const conditional = conditionalActionPathEffect(path, body);
  if (conditional) return conditional;
  if (!pathLooksWrite(path, body, String(argumentsRecord.method || "POST"))) return "read";
  const transaction = asRecord(body.transaction);
  const mode = String(transaction.mode || body.mode || "").trim().toLowerCase();
  return body.dryRun === true || body.dry_run === true || body.preview === true || body.apply === false
    || ["rollback", "preview", "dry_run", "dry-run"].includes(mode)
    ? "preview"
    : "apply";
}

function trustedRecoveryKey(path: string, effect: string, argumentsRecord: JsonRecord, body: JsonRecord): string | null {
  if (!path || !["read", "preview", "apply"].includes(effect)) return null;
  const target = recoveryTarget(Object.keys(body).length > 0
    ? body
    : Object.fromEntries(Object.entries(argumentsRecord).filter(([key]) => key !== "path")));
  return target ? `${path}\n${effect}\n${sha256(canonicalJson(target))}` : null;
}

const REVIT_TOOL_PATH_ALIASES: Readonly<Record<string, string>> = Object.freeze({
  revit_list_views: "/revit/views",
  revit_query_views: "/revit/views",
  revit_list_sheets: "/revit/sheets",
  revit_list_schedules: "/revit/schedules",
  revit_query_elements: "/revit/query",
  revit_find_elements: "/revit/find-elements",
  revit_delete_elements: "/revit/delete"
});

export function canonicalBenchmarkRevitPath(pathValue: string): string {
  const path = pathValue.trim().toLowerCase();
  if (!path) return "";
  const aliases: Readonly<Record<string, string>> = {
    "/revit/list-views": "/revit/views",
    "/revit/query-views": "/revit/views",
    "/revit/query-elements": "/revit/query",
    "/revit/list-sheets": "/revit/sheets",
    "/revit/list-schedules": "/revit/schedules",
    "/revit/delete-elements": "/revit/delete"
  };
  return aliases[path] || path;
}

export function benchmarkSemanticCapabilityId(pathValue: string): string {
  const path = canonicalBenchmarkRevitPath(pathValue);
  const known: Readonly<Record<string, string>> = {
    "/revit/views": "revit.views.query",
    "/revit/sheets": "revit.sheets.query",
    "/revit/schedules": "revit.schedules.query",
    "/revit/find-elements": "revit.elements.find",
    "/revit/query": "revit.elements.query",
    "/revit/delete": "revit.elements.delete"
  };
  if (known[path]) return known[path];
  if (!/^\/revit\/[a-z0-9-]+(?:\/[a-z0-9-]+)*$/.test(path)) return "";
  return `revit.route.${path.slice("/revit/".length).replaceAll("/", ".")}`;
}

function canonicalRevitToolPath(server: string, toolName: string): string {
  if (server !== "revit_operator"
    || toolName === "revit_call_tool"
    || !/^revit_[a-z0-9_]+$/.test(toolName)) return "";
  return REVIT_TOOL_PATH_ALIASES[toolName]
    || canonicalBenchmarkRevitPath(`/revit/${toolName.slice("revit_".length).replaceAll("_", "-")}`);
}

async function requestGoal(baseUrl: string, goalId: string): Promise<JsonRecord> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(new Error(`Goal evidence fetch exceeded 30000ms.`)), 30_000);
  try {
    const pathname = `/api/goals/${encodeURIComponent(goalId)}`;
    const origin = new URL(baseUrl).origin;
    const response = await fetch(new URL(pathname, `${baseUrl}/`), {
      headers: { "content-type": "application/json", origin },
      signal: controller.signal
    });
    const text = await response.text();
    let body: unknown = {};
    try { body = text ? JSON.parse(text) : {}; } catch { body = { raw: text }; }
    if (!response.ok) throw new Error(`GET ${pathname} returned ${response.status}: ${text.slice(0, 1000)}`);
    return asRecord(body);
  } finally {
    clearTimeout(timeout);
  }
}

export async function loadDurableToolEvidence(
  baseUrl: string,
  assignmentProjection: JsonRecord,
  executedPrompt: string,
  runContext: { session_id?: string; started_at?: string } = {}
): Promise<JsonRecord> {
  const assignments = Array.isArray(assignmentProjection.assignments)
    ? assignmentProjection.assignments.map(asRecord)
    : [];
  const expectedSessionId = String(runContext.session_id || "").trim();
  const startedAtMs = Date.parse(String(runContext.started_at || ""));
  const goalAssignments = assignments
    .filter((assignment) => assignment.source_kind === "goal")
    .filter((assignment) => {
      if (!expectedSessionId) return true;
      return String(asRecord(assignment.target).session_id || "").trim() === expectedSessionId;
    })
    .filter((assignment) => {
      if (!Number.isFinite(startedAtMs)) return true;
      const createdAtMs = Date.parse(String(assignment.created_at || ""));
      return Number.isFinite(createdAtMs) && createdAtMs >= startedAtMs - 60_000;
    });
  const exactPromptAssignments = goalAssignments.filter((assignment) =>
    [assignment.source_user_request, assignment.objective]
      .some((value) => String(value || "").trim() === executedPrompt.trim()));
  // The Sidecar can add authoritative no-write and fixture grounding before
  // delegation. In that case the durable assignment text is intentionally not
  // byte-identical to the UI prompt. The assignments endpoint is already
  // session-scoped; retain that binding and the run window instead of losing
  // all durable tool evidence because presentation text was expanded.
  const selectedAssignments = exactPromptAssignments.length > 0
    ? exactPromptAssignments
    : goalAssignments;
  const goalIds = [...new Set(selectedAssignments
    .map((assignment) => String(assignment.source_record_id || "").trim())
    .filter(Boolean))];
  type TrustedOutcome = { path: string; tool: string; outcome: "completed" | "failed"; had_failure: boolean };
  const trustedOutcomes = new Map<string, TrustedOutcome>();
  const successfulPaths = new Set<string>();
  const failedPaths = new Set<string>();
  const successfulTools = new Set<string>();
  const failedTools = new Set<string>();
  const recoveredPaths = new Set<string>();
  const recoveredTools = new Set<string>();
  const historicalFailedPaths = new Set<string>();
  const historicalFailedTools = new Set<string>();
  const rejectedNoEffectPaths = new Set<string>();
  const rejectedNoEffectTools = new Set<string>();
  const reportedReceiptPaths = new Set<string>();
  const reportedReceiptTools = new Set<string>();
  const connectorRows = new Map<string, JsonRecord>();
  const compactlyScannedConnectorElementIds = new Set<string>();
  const resultReceipts: JsonRecord[] = [];
  let maximumFindElementIds = 0;
  let maximumFindCount = 0;
  let observedUntruncatedFind = false;
  let compactConnectorFilterUsed = false;
  let connectorScanTruncated = false;
  let maximumConnectorRequestedCount = 0;
  let maximumConnectorScannedCount = 0;
  let maximumConnectorFailedCount = 0;
  let maximumReportedOpenPhysicalConnectors = 0;
  const openPhysicalConnectorOwnerIds = new Set<string>();

  for (const goalId of goalIds) {
    let response: JsonRecord;
    try {
      response = await requestGoal(baseUrl, goalId);
    } catch (error) {
      resultReceipts.push({ goal_id: goalId, status: "fetch_failed", error: String(error) });
      continue;
    }
    const goal = asRecord(response.goal);
    const actions = Array.isArray(goal.action_log) ? goal.action_log.map(asRecord) : [];
    for (const action of actions) {
      const details = asRecord(action.details);
      const operatorDesktopReported = details.source === "operator_desktop_reported";
      const tool = operatorDesktopReported ? details : asRecord(details.tool);
      const argumentsRecord = asRecord(tool.arguments);
      const requestBody = parsedRecord(argumentsRecord.body);
      const toolServer = String(tool.server || "").trim();
      const toolName = String(operatorDesktopReported ? tool.tool_name : tool.tool || "").trim();
      const explicitPath = operatorDesktopReported
        ? String(tool.path || "").trim()
        : toolServer === "revit_operator" && toolName === "revit_call_tool"
          ? String(argumentsRecord.path || "").trim()
          : "";
      const path = canonicalBenchmarkRevitPath(explicitPath || canonicalRevitToolPath(toolServer, toolName));
      const semanticCapabilityId = benchmarkSemanticCapabilityId(path);
      const rawStatus = String(tool.status || "").trim().toLowerCase();
      const status = rawStatus === "success" ? "completed" : rawStatus;
      const contents = Array.isArray(tool.result) ? tool.result.map(asRecord) : [];
      let resultText = contents.map((content) => String(content.text || "")).find(Boolean) || "";
      if (!resultText && tool.result !== undefined && !Array.isArray(tool.result)) {
        if (typeof tool.result === "string") resultText = tool.result;
        else {
          try { resultText = JSON.stringify(tool.result); } catch { /* retain the status-only receipt */ }
        }
      }
      let parsed: JsonRecord = {};
      try { parsed = resultText ? asRecord(JSON.parse(resultText)) : {}; } catch { /* receipt still records the bounded digest */ }
      const reportedOutcomeEnvelope = classifyOutcomeEnvelope({
        request_dispatched: tool.request_dispatched,
        ok: tool.result_ok,
        outcome_unknown: tool.outcome_unknown,
        reconciliation_required: tool.reconciliation_required,
        result: tool.result
      });
      // Native action logs persist MCP content envelopes while the strict
      // benchmark fields live inside the authenticated text payload. Classify
      // the representations independently so neither can hide uncertainty and
      // the combined wrapper itself does not consume the bounded depth budget.
      const parsedOutcomeEnvelope = classifyOutcomeEnvelope(parsed);
      const outcomeEnvelope = {
        ok_false: reportedOutcomeEnvelope.ok_false || parsedOutcomeEnvelope.ok_false,
        outcome_unknown: reportedOutcomeEnvelope.outcome_unknown || parsedOutcomeEnvelope.outcome_unknown,
        reconciliation_required: reportedOutcomeEnvelope.reconciliation_required || parsedOutcomeEnvelope.reconciliation_required,
        request_dispatched_false: reportedOutcomeEnvelope.request_dispatched_false || parsedOutcomeEnvelope.request_dispatched_false,
        request_dispatched_true: reportedOutcomeEnvelope.request_dispatched_true || parsedOutcomeEnvelope.request_dispatched_true,
        classification_incomplete: reportedOutcomeEnvelope.classification_incomplete || parsedOutcomeEnvelope.classification_incomplete,
        completion_ineligible: reportedOutcomeEnvelope.completion_ineligible || parsedOutcomeEnvelope.completion_ineligible,
        blocking_no_effect: reportedOutcomeEnvelope.blocking_no_effect || parsedOutcomeEnvelope.blocking_no_effect
      };
      const requestDispatched = outcomeEnvelope.request_dispatched_false
        ? false
        : outcomeEnvelope.request_dispatched_true ? true : null;
      const unsafeReportedOutcome = outcomeEnvelopeIsUnsafe(outcomeEnvelope);
      const resultEvidenceSha256 = String(tool.result_evidence_sha256 || "").trim().toLowerCase();
      const receiptSha256 = String(tool.receipt_sha256 || "").trim().toLowerCase();
      const hashBoundReportedReceipt = operatorDesktopReported
        && /^sha256:[a-f0-9]{64}$/.test(resultEvidenceSha256)
        && /^sha256:[a-f0-9]{64}$/.test(receiptSha256);
      if (operatorDesktopReported) {
        if (path) reportedReceiptPaths.add(path);
        if (toolName) reportedReceiptTools.add(toolName);
        resultReceipts.push({
          goal_id: goalId, action_id: String(action.id || "") || null,
          tool: toolName || null, path: path || null, status,
          authority: "operator_desktop_reported", request_dispatched: requestDispatched,
          outcome_unknown: outcomeEnvelope.outcome_unknown,
          reconciliation_required: outcomeEnvelope.reconciliation_required,
          result_ok: outcomeEnvelope.ok_false ? false : typeof tool.result_ok === "boolean" ? tool.result_ok : null,
          result_sha256: resultEvidenceSha256 || null,
          receipt_sha256: receiptSha256 || null,
          hash_bound: hashBoundReportedReceipt,
          integrity_only: true
        });
        // Sidecar receipts remain caller-reported integrity artifacts. Even a
        // valid digest cannot promote paths, tools, or parsed result fields into
        // independently authoritative benchmark evidence.
        continue;
      }
      const effect = requestEffect(path, {
        ...argumentsRecord,
        // Only the server-persisted action-local effect is authoritative.
        // Caller-supplied effect aliases must fall through to route/body
        // classification when the action record has no explicit effect.
        request_effect: tool.request_effect,
        requestEffect: undefined
      }, requestBody);
      const requestRecoveryKey = trustedRecoveryKey(path, effect, argumentsRecord, requestBody);
      // Goal action logs are server-persisted append order. Scope the key to the
      // source goal so one assignment can never recover another assignment.
      const recoveryKey = requestRecoveryKey ? `${goalId}\n${requestRecoveryKey}` : null;
      const parsedEnvelopeFailed = parsedEnvelopeHasFailure(parsed);
      const authoritativeSuccess = status === "completed"
        && !outcomeEnvelope.request_dispatched_false
        && !unsafeReportedOutcome
        && !parsedEnvelopeFailed;
      // Uncertainty is a failure even when the envelope also claims it was not
      // dispatched. A contradictory caller report cannot be downgraded to a
      // harmless schema rejection.
      const dispatchedFailure = unsafeReportedOutcome
        || (!outcomeEnvelope.request_dispatched_false && (status === "failed" || parsedEnvelopeFailed));
      const rejectedNoEffect = !unsafeReportedOutcome
        && outcomeEnvelope.request_dispatched_false
        && (status === "failed" || status === "completed" || parsedEnvelopeFailed);
      if (recoveryKey && (authoritativeSuccess || dispatchedFailure)) {
        const prior = trustedOutcomes.get(recoveryKey);
        trustedOutcomes.set(recoveryKey, {
          path,
          tool: toolName,
          outcome: authoritativeSuccess ? "completed" : "failed",
          had_failure: prior?.had_failure === true || dispatchedFailure
        });
      } else {
        if (path && authoritativeSuccess) successfulPaths.add(path);
        if (path && dispatchedFailure) failedPaths.add(path);
        if (toolName && authoritativeSuccess) successfulTools.add(toolName);
        if (toolName && dispatchedFailure) failedTools.add(toolName);
      }
      if (path && dispatchedFailure) historicalFailedPaths.add(path);
      if (toolName && dispatchedFailure) historicalFailedTools.add(toolName);
      if (path && rejectedNoEffect) rejectedNoEffectPaths.add(path);
      if (toolName && rejectedNoEffect) rejectedNoEffectTools.add(toolName);
      if (!resultText || !path) continue;
      const resultSha256 = sha256(resultText);
      const elementIds = Array.isArray(parsed.elementIds) ? parsed.elementIds : [];
      const parsedSemanticFacts: JsonRecord = {};
      if (authoritativeSuccess && semanticCapabilityId) {
        for (const key of [
          "count", "requestedCount", "scannedElementCount", "failedElementCount",
          "openPhysicalConnectorCount", "connectorScanTruncatedElementCount", "truncated"
        ]) {
          if (!Object.prototype.hasOwnProperty.call(parsed, key)) continue;
          const value = parsed[key];
          if (typeof value !== "number" && typeof value !== "boolean" && typeof value !== "string") continue;
          parsedSemanticFacts[key] = value;
        }
      }
      const results = Array.isArray(parsed.results) ? parsed.results.map(asRecord) : [];
      if (authoritativeSuccess && path === "/revit/find-elements") {
        maximumFindElementIds = Math.max(maximumFindElementIds, elementIds.length);
        maximumFindCount = Math.max(maximumFindCount, numberValue(parsed.count));
        if (parsed.truncated === false) observedUntruncatedFind = true;
      }
      if (authoritativeSuccess && path === "/revit/get-connectors") {
        const requestedConnectorIds = Array.isArray(requestBody.elementIds)
          ? requestBody.elementIds.map((value) => String(value ?? "").trim()).filter(Boolean)
          : [];
        const reportedRequestedCount = numberValue(parsed.requestedCount);
        const reportedScannedCount = numberValue(parsed.scannedElementCount);
        const reportedFailedCount = numberValue(parsed.failedElementCount);
        const reportedTruncatedCount = numberValue(parsed.connectorScanTruncatedElementCount);
        const reportedOpenCount = numberValue(parsed.openPhysicalConnectorCount);
        maximumConnectorRequestedCount = Math.max(maximumConnectorRequestedCount, reportedRequestedCount);
        maximumConnectorScannedCount = Math.max(maximumConnectorScannedCount, reportedScannedCount);
        maximumConnectorFailedCount = Math.max(maximumConnectorFailedCount, reportedFailedCount);
        maximumReportedOpenPhysicalConnectors = Math.max(maximumReportedOpenPhysicalConnectors, reportedOpenCount);
        if (reportedTruncatedCount > 0) connectorScanTruncated = true;
        if (String(parsed.filter || "") === "openPhysicalConnectors") {
          compactConnectorFilterUsed = true;
          if (status === "completed"
            && requestedConnectorIds.length > 0
            && reportedRequestedCount === requestedConnectorIds.length
            && reportedScannedCount === requestedConnectorIds.length
            && reportedFailedCount === 0
            && reportedTruncatedCount === 0) {
            for (const elementId of requestedConnectorIds) compactlyScannedConnectorElementIds.add(elementId);
          }
        }
        for (const row of results) {
          const elementId = String(row.id ?? "").trim();
          if (elementId) connectorRows.set(elementId, row);
          const rowOpenConnectorCount = numberValue(row.openPhysicalConnectorCount);
          if (elementId && rowOpenConnectorCount > 0) openPhysicalConnectorOwnerIds.add(elementId);
        }
      }
      resultReceipts.push({
        goal_id: goalId,
        action_id: String(action.id || "") || null,
        tool: String(tool.tool || "") || null,
        path,
        semantic_capability_id: semanticCapabilityId || null,
        request_effect: effect,
        status,
        envelope_succeeded: authoritativeSuccess,
        duration_ms: numberValue(tool.duration_ms),
        result_text_bytes: Buffer.byteLength(resultText, "utf8"),
        result_sha256: resultSha256,
        parsed_ok: typeof parsed.ok === "boolean" ? parsed.ok : null,
        parsed_outcome_unknown: outcomeEnvelope.outcome_unknown,
        parsed_reconciliation_required: outcomeEnvelope.reconciliation_required,
        parsed_error: typeof parsed.error === "string" && parsed.error.trim() ? parsed.error.trim() : null,
        parsed_semantic_facts: parsedSemanticFacts,
        parsed_count: numberValue(parsed.count),
        parsed_element_id_count: elementIds.length,
        parsed_result_count: results.length,
        parsed_truncated: typeof parsed.truncated === "boolean" ? parsed.truncated : null,
        parsed_requested_count: numberValue(parsed.requestedCount),
        parsed_scanned_element_count: numberValue(parsed.scannedElementCount),
        parsed_failed_element_count: numberValue(parsed.failedElementCount),
        parsed_open_physical_connector_count: numberValue(parsed.openPhysicalConnectorCount),
        parsed_connector_scan_truncated_element_count: numberValue(parsed.connectorScanTruncatedElementCount),
        parsed_filter: String(parsed.filter || "") || null
      });
    }
  }

  for (const outcome of trustedOutcomes.values()) {
    const completed = outcome.outcome === "completed";
    if (outcome.path) (completed ? successfulPaths : failedPaths).add(outcome.path);
    if (outcome.tool) (completed ? successfulTools : failedTools).add(outcome.tool);
    if (completed && outcome.had_failure) {
      if (outcome.path) recoveredPaths.add(outcome.path);
      if (outcome.tool) recoveredTools.add(outcome.tool);
    }
  }
  let failedConnectorRows = 0;
  let totalHvacConnectors = 0;
  let openHvacConnectors = 0;
  let physicallyConnectedHvacConnectors = 0;
  for (const row of connectorRows.values()) {
    if (row.ok !== true) failedConnectorRows += 1;
    for (const connector of Array.isArray(row.connectors) ? row.connectors.map(asRecord) : []) {
      if (String(connector.domain || "") !== "DomainHvac") continue;
      totalHvacConnectors += 1;
      if (connector.isPhysicallyConnected === true) physicallyConnectedHvacConnectors += 1;
      else openHvacConnectors += 1;
    }
  }
  return {
    schema: "revit-operator.benchmark-durable-tool-evidence/v1",
    source_goal_ids: goalIds,
    goal_selection: {
      basis: exactPromptAssignments.length > 0
        ? "exact_prompt_session_run_window"
        : goalAssignments.length > 0
          ? "session_run_window"
          : "none",
      expected_session_id: expectedSessionId || null,
      benchmark_started_at: Number.isFinite(startedAtMs) ? new Date(startedAtMs).toISOString() : null,
      candidate_assignment_count: goalAssignments.length
    },
    successful_paths: [...successfulPaths].sort(),
    failed_paths: [...failedPaths].sort(),
    recovered_paths: [...recoveredPaths].sort(),
    historical_failed_paths: [...historicalFailedPaths].sort(),
    rejected_no_effect_paths: [...rejectedNoEffectPaths].sort(),
    reported_receipt_paths: [...reportedReceiptPaths].sort(),
    successful_tools: [...successfulTools].sort(),
    failed_tools: [...failedTools].sort(),
    semantic_capability_ids: [...successfulPaths]
      .map(benchmarkSemanticCapabilityId)
      .filter(Boolean)
      .sort(),
    recovered_tools: [...recoveredTools].sort(),
    historical_failed_tools: [...historicalFailedTools].sort(),
    rejected_no_effect_tools: [...rejectedNoEffectTools].sort(),
    reported_receipt_tools: [...reportedReceiptTools].sort(),
    element_inventory: {
      maximum_element_id_count: maximumFindElementIds,
      maximum_reported_count: maximumFindCount,
      observed_untruncated_result: observedUntruncatedFind
    },
    connector_inventory: {
      unique_element_ids: new Set([...connectorRows.keys(), ...compactlyScannedConnectorElementIds]).size,
      failed_rows: Math.max(failedConnectorRows, maximumConnectorFailedCount),
      total_hvac_connectors: totalHvacConnectors,
      physically_connected_hvac_connectors: physicallyConnectedHvacConnectors,
      open_hvac_connectors: openHvacConnectors,
      compact_filter_used: compactConnectorFilterUsed,
      maximum_reported_requested_count: maximumConnectorRequestedCount,
      maximum_reported_scanned_count: maximumConnectorScannedCount,
      maximum_reported_open_physical_connectors: maximumReportedOpenPhysicalConnectors,
      open_physical_connector_owner_count: openPhysicalConnectorOwnerIds.size,
      open_physical_connector_owner_ids: [...openPhysicalConnectorOwnerIds].sort((left, right) => Number(left) - Number(right)),
      scan_truncated: connectorScanTruncated
    },
    result_receipts: resultReceipts
  };
}
