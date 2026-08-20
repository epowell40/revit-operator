import crypto from "node:crypto";

type JsonRecord = Record<string, unknown>;

function asRecord(value: unknown): JsonRecord {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonRecord : {};
}

function numberValue(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function sha256(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function canonicalRevitToolPath(server: string, toolName: string): string {
  if (server !== "revit_operator"
    || toolName === "revit_call_tool"
    || !/^revit_[a-z0-9_]+$/.test(toolName)) return "";
  return `/revit/${toolName.slice("revit_".length).replaceAll("_", "-")}`;
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
  const successfulPaths = new Set<string>();
  const failedPaths = new Set<string>();
  const successfulTools = new Set<string>();
  const failedTools = new Set<string>();
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
      const tool = asRecord(details.tool);
      const argumentsRecord = asRecord(tool.arguments);
      const requestBody = asRecord(argumentsRecord.body);
      const toolServer = String(tool.server || "").trim();
      const toolName = String(tool.tool || "").trim();
      const explicitPath = String(argumentsRecord.path || "").trim();
      const path = explicitPath || canonicalRevitToolPath(toolServer, toolName);
      const status = String(tool.status || "").trim().toLowerCase();
      if (path && status === "completed") successfulPaths.add(path);
      if (path && status === "failed") failedPaths.add(path);
      if (toolName && status === "completed") successfulTools.add(toolName);
      if (toolName && status === "failed") failedTools.add(toolName);
      const contents = Array.isArray(tool.result) ? tool.result.map(asRecord) : [];
      const resultText = contents.map((content) => String(content.text || "")).find(Boolean) || "";
      if (!resultText || !path) continue;
      let parsed: JsonRecord = {};
      try { parsed = asRecord(JSON.parse(resultText)); } catch { /* receipt still records the bounded digest */ }
      const elementIds = Array.isArray(parsed.elementIds) ? parsed.elementIds : [];
      if (path === "/revit/find-elements") {
        maximumFindElementIds = Math.max(maximumFindElementIds, elementIds.length);
        maximumFindCount = Math.max(maximumFindCount, numberValue(parsed.count));
        if (parsed.truncated === false) observedUntruncatedFind = true;
      }
      const results = Array.isArray(parsed.results) ? parsed.results.map(asRecord) : [];
      if (path === "/revit/get-connectors") {
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
        status,
        duration_ms: numberValue(tool.duration_ms),
        result_text_bytes: Buffer.byteLength(resultText, "utf8"),
        result_sha256: sha256(resultText),
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
    successful_tools: [...successfulTools].sort(),
    failed_tools: [...failedTools].sort(),
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
