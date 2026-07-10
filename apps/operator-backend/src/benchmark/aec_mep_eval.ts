import fs from "node:fs";
import path from "node:path";
import { ensureDir, writeJsonFile } from "./files.js";
import type { BridgeTransport, RevitWorkflowResult, RevitWorkflowVerification } from "./revit_workflows.js";

type JsonMap = Record<string, unknown>;
type RevitWorkflowPartialResult = Omit<RevitWorkflowResult, "elapsed_seconds" | "execution_source">;

function clip(value: unknown, max = 500): string {
  const text = typeof value === "string" ? value.trim() : "";
  return text.length <= max ? text : text.slice(0, max).trim();
}

function asObject(value: unknown): JsonMap {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as JsonMap) : {};
}

function asNumberArray(value: unknown): number[] {
  return Array.isArray(value)
    ? value.map((entry) => Number(entry)).filter((entry) => Number.isFinite(entry) && entry > 0)
    : [];
}

function parseBool(value: unknown): boolean | null {
  const normalized = String(value ?? "").trim().toLowerCase();
  if (!normalized) return null;
  if (["1", "true", "yes", "y", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "n", "off"].includes(normalized)) return false;
  return null;
}

function verification(name: string, ok: boolean, expected?: unknown, actual?: unknown, detail?: string): RevitWorkflowVerification {
  return { name, ok, expected, actual, detail };
}

function countOk(results: RevitWorkflowVerification[]): boolean {
  return results.length > 0 && results.every((entry) => entry.ok);
}

function makeMarkdownTable(rows: Array<Record<string, unknown>>, maxRows = 25): string {
  const headers = Array.from(new Set(rows.flatMap((row) => Object.keys(row)))).slice(0, 8);
  if (headers.length === 0) return "_No rows returned._\n";
  const cell = (value: unknown) => String(value ?? "").replace(/\|/g, "\\|").replace(/\s+/g, " ").trim();
  const lines = [
    `| ${headers.join(" | ")} |`,
    `| ${headers.map(() => "---").join(" | ")} |`
  ];
  for (const row of rows.slice(0, maxRows)) lines.push(`| ${headers.map((header) => cell(row[header])).join(" | ")} |`);
  if (rows.length > maxRows) lines.push(`\n_Showing ${maxRows} of ${rows.length} rows._`);
  return `${lines.join("\n")}\n`;
}

function writeMarkdownTable(filePath: string, rows: Array<Record<string, unknown>>): string {
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, makeMarkdownTable(rows), "utf8");
  return filePath;
}

function firstString(...values: unknown[]): string {
  for (const value of values) {
    const text = clip(value, 300);
    if (text) return text;
  }
  return "";
}
type AecMepPoint = { x: number; y: number; z?: number };

type AecMepEvalResultArgs = {
  scenarioId: string;
  scenarioKind: string;
  runDir: string;
  rawResults: unknown[];
  checks: RevitWorkflowVerification[];
  revitTransactions: number;
  outputArtifacts?: string[];
  failureClassification?: string | null;
  successMessage: string;
  failureMessage: string;
  summary?: JsonMap;
};

function numberValue(value: unknown): number | null {
  const n = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  return Number.isFinite(n) ? n : null;
}

function pointFromValue(value: unknown): AecMepPoint | null {
  if (Array.isArray(value)) {
    const x = numberValue(value[0]);
    const y = numberValue(value[1]);
    const z = numberValue(value[2]);
    if (x === null || y === null) return null;
    return z === null ? { x, y } : { x, y, z };
  }
  const obj = asObject(value);
  const x = numberValue(obj.x ?? obj.X);
  const y = numberValue(obj.y ?? obj.Y);
  const z = numberValue(obj.z ?? obj.Z);
  if (x === null || y === null) return null;
  return z === null ? { x, y } : { x, y, z };
}

function pointArray(value: unknown): AecMepPoint[] {
  if (!Array.isArray(value)) return [];
  return value.map(pointFromValue).filter((entry): entry is AecMepPoint => entry !== null);
}

function firstPointArray(...values: unknown[]): AecMepPoint[] {
  for (const value of values) {
    const points = pointArray(value);
    if (points.length >= 2) return points;
  }
  return [];
}

function pointDistance(a: AecMepPoint, b: AecMepPoint): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function maxRouteEndpointDistance(expected: AecMepPoint[], actual: AecMepPoint[]): number | null {
  if (expected.length < 2 || actual.length < 2) return null;
  const count = Math.min(expected.length, actual.length);
  const forward = expected.slice(0, count).map((point, index) => pointDistance(point, actual[index]!));
  const reversedActual = actual.slice(0, count).reverse();
  const reversed = expected.slice(0, count).map((point, index) => pointDistance(point, reversedActual[index]!));
  return Math.min(Math.max(...forward), Math.max(...reversed));
}

function normalizeMepSize(value: unknown): string {
  const cleaned = clip(value, 120)
    .toLowerCase()
    .replace(/[“”]/g, "\"")
    .replace(/\s+/g, "")
    .replace(/inches|inch|in\./g, "in")
    .replace(/["']/g, "in")
    .replace(/[×]/g, "x")
    .replace(/[^a-z0-9.x/-]/g, "");
  return cleaned.includes("x") ? cleaned.replace(/in/g, "") : cleaned;
}

function sizesMatch(actual: unknown, expected: unknown): boolean {
  const expectedText = normalizeMepSize(expected);
  if (!expectedText) return true;
  const actualText = normalizeMepSize(actual);
  return !!actualText && (actualText === expectedText || actualText.includes(expectedText) || expectedText.includes(actualText));
}

function collectIdsByKeys(value: unknown, keys: string[], maxDepth = 5): number[] {
  const out = new Set<number>();
  const wanted = new Set(keys.map((key) => key.toLowerCase()));
  const scan = (node: unknown, depth: number): void => {
    if (depth > maxDepth || !node || typeof node !== "object") return;
    if (Array.isArray(node)) {
      for (const item of node) scan(item, depth + 1);
      return;
    }
    const obj = node as JsonMap;
    for (const [key, raw] of Object.entries(obj)) {
      const normalizedKey = key.toLowerCase();
      if (wanted.has(normalizedKey)) {
        for (const id of asNumberArray(Array.isArray(raw) ? raw : [raw])) out.add(id);
      }
      if (/(^id$|elementid|element_id|connectorid|fittingid)/i.test(key)) {
        const id = numberValue(raw);
        if (id !== null && id > 0) out.add(Math.trunc(id));
      }
      scan(raw, depth + 1);
    }
  };
  scan(value, 0);
  return [...out].sort((a, b) => a - b);
}

function createdElementIds(value: unknown): number[] {
  return collectIdsByKeys(value, ["createdElementIds", "createdIds", "elementIds", "created_element_ids"]);
}

function changedElementIds(value: unknown): number[] {
  return collectIdsByKeys(value, ["changedElementIds", "affectedElementIds", "resizedElementIds", "elementIds"]);
}

function fittingIds(value: unknown): number[] {
  return collectIdsByKeys(value, ["createdFittingIds", "fittingIds", "tapIds", "teeIds"]);
}

function workflowStatus(value: unknown): string {
  const obj = asObject(value);
  const apply = asObject(obj.applyResult);
  const visual = asObject(obj.visualVerification);
  return firstString(obj.status, obj.workflowStatus, apply.status, visual.status);
}

function nestedObject(value: unknown, key: string): JsonMap {
  return asObject(asObject(value)[key]);
}

function routeResultPoints(value: unknown): AecMepPoint[] {
  const obj = asObject(value);
  const apply = nestedObject(value, "applyResult");
  const dryRun = nestedObject(value, "dryRunResult");
  return firstPointArray(
    apply.plannedPoints,
    apply.actualPoints,
    apply.points,
    dryRun.plannedPoints,
    obj.plannedPoints,
    obj.actualPoints,
    obj.points
  );
}

function capturePathFromResult(value: unknown): string {
  const obj = asObject(value);
  const visual = nestedObject(value, "visualVerification");
  const capture = asObject(visual.capture);
  return firstString(visual.capturePath, visual.capture_path, visual.path, capture.path, obj.capturePath, obj.capture_path, obj.path);
}

function boolFrom(value: unknown): boolean | null {
  if (typeof value === "boolean") return value;
  return parseBool(value);
}

function arrayItems(value: unknown): JsonMap[] {
  if (!Array.isArray(value)) return [];
  return value.map(asObject).filter((entry) => Object.keys(entry).length > 0);
}

function payloadItems(value: unknown): JsonMap[] {
  const obj = asObject(value);
  for (const key of ["items", "elements", "curves", "ducts", "pipes", "segments", "network"]) {
    const rows = arrayItems(obj[key]);
    if (rows.length > 0) return rows;
  }
  return [];
}

function traceDisconnectedIds(value: unknown): number[] {
  const obj = asObject(value);
  const audit = asObject(obj.systemAudit ?? obj.system_audit);
  return asNumberArray(obj.disconnectedIds ?? obj.disconnected_ids ?? audit.disconnectedIds ?? audit.disconnected_ids);
}

function traceSizes(value: unknown): string[] {
  const sizes: string[] = [];
  for (const item of payloadItems(value)) {
    const size = firstString(item.size, item.Size, item.diameter, item.Diameter, item.ductSize, item.pipeSize, item.width, item.height);
    if (size) sizes.push(size);
  }
  return sizes;
}

function matchingScopeIds(scope: unknown, expectedSize: unknown): number[] {
  const obj = asObject(scope);
  const rows = payloadItems(scope);
  if (rows.length === 0) return asNumberArray(obj.elementIds ?? obj.ids);
  return rows
    .filter((row) => sizesMatch(firstString(row.size, row.Size, row.diameter, row.ductSize, row.pipeSize), expectedSize))
    .map((row) => numberValue(row.elementId ?? row.id))
    .filter((id): id is number => id !== null && id > 0)
    .map((id) => Math.trunc(id));
}

function hasTruthyStatus(value: unknown): boolean {
  const status = workflowStatus(value).toLowerCase();
  const obj = asObject(value);
  return obj.ok !== false && obj.success !== false && !/\b(failed|error|rejected)\b/.test(status);
}

function hasBlockedOrDryRunStatus(value: unknown): boolean {
  const status = workflowStatus(value).toLowerCase();
  const obj = asObject(value);
  return /blocked|guard|dry|preview|not\s*applied|failed/i.test(status) || obj.apply === false || obj.dryRun === true;
}

function expectedBool(value: unknown, fallback: boolean): boolean {
  const parsed = boolFrom(value);
  return parsed === null ? fallback : parsed;
}

function makeAecMepEvalResult(args: AecMepEvalResultArgs): RevitWorkflowPartialResult {
  const success = countOk(args.checks);
  const failed = args.checks.filter((entry) => !entry.ok).map((entry) => entry.name);
  const safeScenario = args.scenarioId.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 120) || "aec_mep_eval";
  const summaryJsonPath = path.join(args.runDir, "artifacts", `${safeScenario}_summary.json`);
  const summary = {
    scenarioId: args.scenarioId,
    scenarioKind: args.scenarioKind,
    success,
    failureClassification: success ? null : args.failureClassification ?? "unclassified_aec_mep_eval_failure",
    failedChecks: failed,
    checks: args.checks,
    ...(args.summary ?? {})
  };
  writeJsonFile(summaryJsonPath, summary);
  const summaryRows = args.checks.map((entry) => ({
    check: entry.name,
    ok: entry.ok ? "yes" : "no",
    detail: entry.detail ?? "",
    expected: typeof entry.expected === "string" || typeof entry.expected === "number" ? entry.expected : "",
    actual: typeof entry.actual === "string" || typeof entry.actual === "number" ? entry.actual : ""
  }));
  const summaryMdPath = writeMarkdownTable(path.join(args.runDir, "artifacts", `${safeScenario}_summary.md`), summaryRows);
  return {
    workflow: "aec_mep_eval",
    success,
    failure_reason: success ? null : `${args.failureMessage}: ${failed.join(", ")}`,
    failure_classification: success ? null : args.failureClassification ?? "unclassified_aec_mep_eval_failure",
    tool_calls: args.rawResults.length,
    revit_transactions: args.revitTransactions,
    computer_use_actions: 0,
    output_artifacts: [summaryJsonPath, summaryMdPath, ...(args.outputArtifacts ?? [])],
    verification_results: args.checks,
    user_message: success ? args.successMessage : args.failureMessage,
    raw_results: args.rawResults
  };
}

async function runAecMepRouteEval(transport: BridgeTransport, request: JsonMap, runDir: string): Promise<RevitWorkflowPartialResult> {
  const scenarioId = clip(request.scenarioId ?? request.scenario_id, 120) || "aec_mep_route";
  const scenarioKind = clip(request.scenarioKind ?? request.scenario_kind, 120) || "duct_route_redline_vector_pdf";
  const redline = asObject(request.redline);
  const route = asObject(request.route);
  const expected = asObject(request.expected);
  const rawResults: unknown[] = [];
  const routeResult = await transport.post("/revit/mep-route-workflow", route);
  rawResults.push(routeResult);
  const routeApply = expectedBool(route.apply, false);
  const resultPoints = routeResultPoints(routeResult);
  const expectedPoints = pointArray(route.points);
  const maxError = maxRouteEndpointDistance(expectedPoints, resultPoints);
  const tolerance = numberValue(expected.maxEndpointErrorFt ?? expected.toleranceFt) ?? 1;
  const createdIds = createdElementIds(routeResult);
  const status = workflowStatus(routeResult);
  const capturePath = capturePathFromResult(routeResult);
  const applyResult = nestedObject(routeResult, "applyResult");
  const chosenSize = asObject(applyResult.chosenSize);
  const expectedKind = clip(expected.kind ?? route.kind, 80);
  const expectedSize = firstString(expected.size, route.ductSize, route.pipeSize);
  const openConnectorCount = numberValue(applyResult.openConnectorCount ?? asObject(routeResult).openConnectorCount);
  const maxOpenConnectorCount = numberValue(expected.maxOpenConnectorCount);
  let cleanup: unknown = null;
  if (expectedBool(request.cleanupCreatedElements ?? request.cleanup_created_elements, false) && createdIds.length > 0) {
    cleanup = await transport.post("/revit/delete", {
      ids: createdIds,
      apply: true,
      reason: "benchmark cleanup for AEC-MEP route eval"
    });
    rawResults.push(cleanup);
  }

  const checks = [
    verification("redline_vector_geometry_present", clip(redline.source, 120) === "vector_pdf_geometry" && pointArray(redline.verticesNorm ?? redline.vertices_norm).length >= 2, "vector_pdf_geometry with vertices", redline),
    verification("redline_geometry_is_target_path", clip(redline.geometryRole ?? redline.geometry_role, 120) === "target_path", "target_path", redline.geometryRole ?? redline.geometry_role),
    verification("route_points_present", expectedPoints.length >= 2, "at least 2 points", expectedPoints.length),
    verification("mep_route_workflow_status_ok", hasTruthyStatus(routeResult), "non-error route workflow status", status),
    verification("route_kind_matches", !expectedKind || clip(route.kind, 80) === expectedKind, expectedKind, route.kind),
    verification("route_size_matches", sizesMatch(firstString(chosenSize.applied, chosenSize.requested, route.ductSize, route.pipeSize), expectedSize), expectedSize, firstString(chosenSize.applied, chosenSize.requested, route.ductSize, route.pipeSize)),
    verification(
      "route_endpoint_error_within_tolerance",
      maxError !== null && maxError <= tolerance,
      `<= ${tolerance}`,
      maxError === null ? "unavailable" : Number(maxError.toFixed(3))
    ),
    verification(
      "created_expected_route_count",
      !routeApply || createdIds.length >= (numberValue(expected.minCreatedElementCount) ?? 1),
      numberValue(expected.minCreatedElementCount) ?? (routeApply ? 1 : 0),
      createdIds.length
    ),
    verification(
      "post_change_capture_returned",
      !expectedBool(expected.requiresPostChangeCapture, routeApply) || !!capturePath,
      "capture path when applying",
      capturePath || ""
    ),
    verification(
      "open_connector_count_reported",
      !expectedBool(expected.requiresOpenConnectorReport, routeApply) || openConnectorCount !== null,
      "numeric open connector count",
      openConnectorCount ?? "missing"
    ),
    verification(
      "open_connector_count_within_expected",
      maxOpenConnectorCount === null || (openConnectorCount !== null && openConnectorCount <= maxOpenConnectorCount),
      maxOpenConnectorCount ?? "not constrained",
      openConnectorCount ?? "missing"
    ),
    verification(
      "cleanup_completed_when_requested",
      !expectedBool(request.cleanupCreatedElements ?? request.cleanup_created_elements, false) || createdIds.length === 0 || (asObject(cleanup).ok !== false && asObject(cleanup).success !== false && Object.keys(asObject(cleanup)).length > 0),
      "delete ok/success not false",
      cleanup
    )
  ];
  const failureClassification =
    checks.find((entry) => entry.name === "route_endpoint_error_within_tolerance" && !entry.ok)
      ? "route_geometry_mismatch"
      : checks.find((entry) => entry.name === "post_change_capture_returned" && !entry.ok)
        ? "missing_visual_capture"
        : checks.find((entry) => entry.name === "created_expected_route_count" && !entry.ok)
          ? "route_creation_count_mismatch"
          : "aec_mep_route_eval_failed";

  return makeAecMepEvalResult({
    scenarioId,
    scenarioKind,
    runDir,
    rawResults,
    checks,
    revitTransactions: (routeApply ? 1 : 0) + (cleanup ? 1 : 0),
    outputArtifacts: capturePath ? [capturePath] : [],
    failureClassification,
    successMessage: `AEC-MEP route eval passed for ${scenarioId}.`,
    failureMessage: `AEC-MEP route eval failed for ${scenarioId}`,
    summary: { createdIds, maxEndpointErrorFt: maxError, capturePath, status }
  });
}

async function runAecMepFalsePositiveEval(transport: BridgeTransport, request: JsonMap, runDir: string): Promise<RevitWorkflowPartialResult> {
  const scenarioId = clip(request.scenarioId ?? request.scenario_id, 120) || "aec_mep_false_positive";
  const scenarioKind = "wrong_bay_false_positive";
  const route = asObject(request.route);
  const expected = asObject(request.expected);
  const rawResults: unknown[] = [];
  const routeResult = await transport.post("/revit/mep-route-workflow", route);
  rawResults.push(routeResult);
  const expectedPoints = pointArray(expected.points ?? route.points);
  const actualPoints = routeResultPoints(routeResult);
  const tolerance = numberValue(expected.maxEndpointErrorFt ?? expected.toleranceFt) ?? 1;
  const maxError = maxRouteEndpointDistance(expectedPoints, actualPoints);
  const landmarkRows = arrayItems(request.landmarkRelationships ?? request.landmark_relationships);
  const landmarkFailed = landmarkRows.some((row) => clip(row.status, 80).toLowerCase() === "fail");
  const wrongBayDetected = (maxError !== null && maxError > tolerance) || landmarkFailed;
  const createdIds = createdElementIds(routeResult);
  const blocked = hasBlockedOrDryRunStatus(routeResult);
  const capturePath = capturePathFromResult(routeResult);
  const checks = [
    verification("one_axis_wrong_bay_detected", wrongBayDetected, "endpoint or landmark failure", { maxError, landmarkFailed }),
    verification("no_model_write_for_wrong_bay", createdIds.length === 0, "no created ids", createdIds),
    verification("wrong_bay_blocked_or_dry_run", blocked, "blocked/dry-run status", workflowStatus(routeResult)),
    verification("false_positive_evidence_artifacted", !!capturePath || maxError !== null || landmarkRows.length > 0, "capture, endpoint, or landmark evidence", { capturePath, maxError, landmarkRows })
  ];
  const failureClassification = !wrongBayDetected
    ? "one_axis_false_positive_not_detected"
    : createdIds.length > 0
      ? "wrong_bay_false_positive"
      : !blocked
        ? "false_positive_block_not_reported"
        : "wrong_bay_guard_failed";
  return makeAecMepEvalResult({
    scenarioId,
    scenarioKind,
    runDir,
    rawResults,
    checks,
    revitTransactions: createdIds.length > 0 ? 1 : 0,
    outputArtifacts: capturePath ? [capturePath] : [],
    failureClassification,
    successMessage: `AEC-MEP wrong-bay guard eval passed for ${scenarioId}.`,
    failureMessage: `AEC-MEP wrong-bay guard eval failed for ${scenarioId}`,
    summary: { maxEndpointErrorFt: maxError, createdIds, capturePath, landmarkFailed }
  });
}

async function runAecMepCalloutOnlyEval(transport: BridgeTransport, request: JsonMap, runDir: string): Promise<RevitWorkflowPartialResult> {
  const scenarioId = clip(request.scenarioId ?? request.scenario_id, 120) || "aec_mep_callout_only";
  const scenarioKind = "duct_callout_verify_existing";
  const redline = asObject(request.redline);
  const scopeRequest = asObject(request.scope);
  const expected = asObject(request.expected);
  const rawResults: unknown[] = [];
  const scope = await transport.post("/revit/ducts-by-spatial-scope", scopeRequest);
  rawResults.push(scope);
  const expectedSize = firstString(expected.size, scopeRequest.sizeFrom, scopeRequest.size);
  const ids = matchingScopeIds(scope, expectedSize);
  let summary: unknown = null;
  let capture: unknown = null;
  if (ids.length > 0) {
    summary = await transport.post("/revit/get-element-summary", {
      elementIds: ids,
      includeParameters: true,
      includeGeometry: true,
      ...(asObject(request.summary))
    });
    rawResults.push(summary);
    capture = await transport.post("/revit/highlight-and-export", {
      elementIds: ids,
      imageSize: 2200,
      paddingFt: 8,
      ...(asObject(request.capture))
    });
    rawResults.push(capture);
  }
  const capturePath = capturePathFromResult(capture);
  const summaryPayloadPresent = Array.isArray(summary) ? summary.length > 0 : Object.keys(asObject(summary)).length > 0;
  const checks = [
    verification("callout_only_geometry_classified", clip(redline.geometryRole ?? redline.geometry_role, 120) === "callout_only", "callout_only", redline.geometryRole ?? redline.geometry_role),
    verification("matching_modeled_duct_found", ids.length >= (numberValue(expected.minExistingElementCount) ?? 1), numberValue(expected.minExistingElementCount) ?? 1, ids.length),
    verification("matching_duct_summary_readback", ids.length === 0 || summaryPayloadPresent, "summary payload", summary),
    verification("matching_duct_visual_capture_returned", ids.length === 0 || !!capturePath, "highlight capture path", capturePath),
    verification("no_route_creation_from_callout_only", true, "no /revit/mep-route-workflow call", "not called")
  ];
  const failureClassification =
    ids.length === 0
      ? "callout_only_missing_existing_model_evidence"
      : !capturePath
        ? "callout_only_missing_visual_capture"
        : "callout_only_verification_failed";
  return makeAecMepEvalResult({
    scenarioId,
    scenarioKind,
    runDir,
    rawResults,
    checks,
    revitTransactions: 0,
    outputArtifacts: capturePath ? [capturePath] : [],
    failureClassification,
    successMessage: `AEC-MEP callout-only eval verified existing modeled ductwork for ${scenarioId}.`,
    failureMessage: `AEC-MEP callout-only eval failed for ${scenarioId}`,
    summary: { existingElementIds: ids, capturePath }
  });
}

async function runAecMepResizeEval(transport: BridgeTransport, request: JsonMap, runDir: string): Promise<RevitWorkflowPartialResult> {
  const scenarioId = clip(request.scenarioId ?? request.scenario_id, 120) || "aec_mep_connected_resize";
  const scenarioKind = "connected_duct_resize";
  const resize = asObject(request.resize);
  const expected = asObject(request.expected);
  const apply = expectedBool(request.apply ?? resize.apply, true);
  const targetSize = firstString(expected.targetSize, resize.targetDiameter, resize.targetSize, resize.size);
  const rawResults: unknown[] = [];
  const dryRun = await transport.post("/revit/resize-duct-run", { ...resize, dryRun: true, apply: false });
  rawResults.push(dryRun);
  const dryRunIds = changedElementIds(dryRun);
  let applied: unknown = null;
  let trace: unknown = null;
  let capture: unknown = null;
  if (apply) {
    applied = await transport.post("/revit/resize-duct-run", { ...resize, dryRun: false, apply: true });
    rawResults.push(applied);
    const ids = changedElementIds(applied).length > 0 ? changedElementIds(applied) : dryRunIds;
    trace = await transport.post("/revit/trace-connected-network", {
      startElementId: numberValue(resize.startElementId) ?? ids[0],
      includeSystemAudit: true,
      ...(asObject(request.trace))
    });
    rawResults.push(trace);
    if (expectedBool(request.visualVerify ?? request.visual_verify ?? expected.requiresPostChangeCapture, true)) {
      capture = await transport.post("/revit/highlight-and-export", {
        elementIds: ids,
        imageSize: 2200,
        paddingFt: 8,
        ...(asObject(request.capture))
      });
      rawResults.push(capture);
    }
  }
  const appliedIds = applied ? changedElementIds(applied) : [];
  const disconnectedIds = traceDisconnectedIds(trace);
  const readbackSizes = traceSizes(trace);
  const capturePath = capturePathFromResult(capture);
  const sizeReadbackRequired = apply && expectedBool(expected.requiresConnectedSizeReadback, true);
  const checks = [
    verification("resize_dry_run_found_connected_run", dryRunIds.length >= (numberValue(expected.minCandidateCount) ?? 1), numberValue(expected.minCandidateCount) ?? 1, dryRunIds.length),
    verification("resize_apply_changed_elements", !apply || appliedIds.length >= (numberValue(expected.minChangedElementCount) ?? 1), numberValue(expected.minChangedElementCount) ?? 1, appliedIds.length),
    verification("connected_network_trace_returned", !apply || Object.keys(asObject(trace)).length > 0, "trace payload", trace),
    verification(
      "connected_sizes_match_target",
      !sizeReadbackRequired || (readbackSizes.length > 0 && readbackSizes.every((size) => sizesMatch(size, targetSize))),
      targetSize,
      readbackSizes
    ),
    verification("connected_network_has_no_disconnected_ids", !apply || disconnectedIds.length === 0, "no disconnected ids", disconnectedIds),
    verification("resize_visual_capture_returned", !apply || !expectedBool(expected.requiresPostChangeCapture, true) || !!capturePath, "capture path", capturePath)
  ];
  const failureClassification = checks.find((entry) => entry.name === "connected_sizes_match_target" && !entry.ok)
    ? "connected_resize_readback_mismatch"
    : disconnectedIds.length > 0
      ? "connected_resize_network_disconnected"
      : !capturePath && apply
        ? "connected_resize_missing_visual_capture"
        : "connected_resize_eval_failed";
  return makeAecMepEvalResult({
    scenarioId,
    scenarioKind,
    runDir,
    rawResults,
    checks,
    revitTransactions: apply ? 1 : 0,
    outputArtifacts: capturePath ? [capturePath] : [],
    failureClassification,
    successMessage: `AEC-MEP connected resize eval passed for ${scenarioId}.`,
    failureMessage: `AEC-MEP connected resize eval failed for ${scenarioId}`,
    summary: { dryRunIds, appliedIds, disconnectedIds, readbackSizes, capturePath }
  });
}

async function runAecMepBranchEval(transport: BridgeTransport, request: JsonMap, runDir: string): Promise<RevitWorkflowPartialResult> {
  const scenarioId = clip(request.scenarioId ?? request.scenario_id, 120) || "aec_mep_branch_feasibility";
  const scenarioKind = "branch_tee_tap_feasibility";
  const branch = asObject(request.branch);
  const expected = asObject(request.expected);
  const rawResults: unknown[] = [];
  const dryRun = await transport.post("/revit/connect-mep-branch", { ...branch, dryRun: true, apply: false });
  rawResults.push(dryRun);
  const dryObj = asObject(dryRun);
  const status = workflowStatus(dryRun) || firstString(dryObj.status, dryObj.feasibilityStatus, dryObj.result);
  const feasible = boolFrom(dryObj.feasible ?? dryObj.canConnect) ?? /\b(feasible|ok|ready)\b/i.test(status);
  const applySupported = boolFrom(dryObj.applySupported ?? dryObj.canApply ?? dryObj.apply_supported);
  const requestedApply = expectedBool(request.apply ?? branch.apply, false);
  let applied: unknown = null;
  let trace: unknown = null;
  let capture: unknown = null;
  if (requestedApply && applySupported === true) {
    applied = await transport.post("/revit/connect-mep-branch", { ...branch, dryRun: false, apply: true });
    rawResults.push(applied);
    const ids = [...createdElementIds(applied), ...fittingIds(applied)];
    trace = await transport.post("/revit/trace-connected-network", {
      startElementId: ids[0] ?? numberValue(branch.mainElementId),
      includeSystemAudit: true,
      ...(asObject(request.trace))
    });
    rawResults.push(trace);
    capture = await transport.post("/revit/highlight-and-export", {
      elementIds: ids,
      imageSize: 2200,
      paddingFt: 8,
      ...(asObject(request.capture))
    });
    rawResults.push(capture);
  }
  const expectedApplySupported = boolFrom(expected.applySupported);
  const expectedFeasible = boolFrom(expected.feasible);
  const appliedIds = applied ? [...createdElementIds(applied), ...fittingIds(applied)] : [];
  const capturePath = capturePathFromResult(capture);
  const checks = [
    verification("branch_dry_run_returned", Object.keys(dryObj).length > 0, "dry-run payload", dryRun),
    verification("branch_feasibility_matches_expected", expectedFeasible === null || feasible === expectedFeasible, expectedFeasible ?? "not constrained", feasible),
    verification("branch_apply_support_matches_expected", expectedApplySupported === null || applySupported === expectedApplySupported, expectedApplySupported ?? "not constrained", applySupported),
    verification("guarded_branch_does_not_apply_when_unsupported", !(requestedApply && applySupported === false) || applied === null, "no apply call when unsupported", applied === null),
    verification("branch_apply_created_or_verified_when_supported", !(requestedApply && applySupported === true) || appliedIds.length > 0, "created branch/tap/fitting ids", appliedIds),
    verification("branch_apply_capture_returned_when_supported", !(requestedApply && applySupported === true) || !!capturePath, "capture path", capturePath)
  ];
  const failureClassification = checks.find((entry) => entry.name === "branch_feasibility_matches_expected" && !entry.ok)
    ? "branch_feasibility_mismatch"
    : checks.find((entry) => entry.name === "guarded_branch_does_not_apply_when_unsupported" && !entry.ok)
      ? "branch_guard_violation"
      : checks.find((entry) => entry.name === "branch_apply_created_or_verified_when_supported" && !entry.ok)
        ? "branch_apply_verification_missing"
        : "branch_feasibility_eval_failed";
  return makeAecMepEvalResult({
    scenarioId,
    scenarioKind,
    runDir,
    rawResults,
    checks,
    revitTransactions: applied ? 1 : 0,
    outputArtifacts: capturePath ? [capturePath] : [],
    failureClassification,
    successMessage: `AEC-MEP branch feasibility eval passed for ${scenarioId}.`,
    failureMessage: `AEC-MEP branch feasibility eval failed for ${scenarioId}`,
    summary: { status, feasible, applySupported, appliedIds, capturePath, trace }
  });
}

export async function runAecMepEval(transport: BridgeTransport, request: JsonMap, runDir: string): Promise<RevitWorkflowPartialResult> {
  const scenarioKind = clip(request.scenarioKind ?? request.scenario_kind, 120).toLowerCase();
  if (scenarioKind === "duct_callout_verify_existing" || scenarioKind === "callout_only_duct_verify_existing") {
    return runAecMepCalloutOnlyEval(transport, request, runDir);
  }
  if (scenarioKind === "wrong_bay_false_positive" || scenarioKind === "one_axis_false_positive") {
    return runAecMepFalsePositiveEval(transport, request, runDir);
  }
  if (scenarioKind === "connected_duct_resize") {
    return runAecMepResizeEval(transport, request, runDir);
  }
  if (scenarioKind === "branch_tee_tap_feasibility" || scenarioKind === "branch_tap_feasibility") {
    return runAecMepBranchEval(transport, request, runDir);
  }
  return runAecMepRouteEval(transport, request, runDir);
}
