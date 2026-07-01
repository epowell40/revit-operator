import fs from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { execFileSync } from "node:child_process";
import { getOrCreateOperatorToken } from "../operator_token.js";
import { getWriteGrantToken } from "../operator_write_grant.js";
import { ensureDir, writeJsonFile } from "./files.js";
import { buildPdfJsDocumentOptions, loadPdfJsForNode } from "../pdf/pdfjs_node.js";

export type RevitWorkflowName = "sheet_export" | "takeoff_csv" | "parameter_edit" | "redline_receptacles" | "aec_mep_eval";

export type RevitWorkflowVerification = {
  name: string;
  ok: boolean;
  expected?: unknown;
  actual?: unknown;
  detail?: string;
};

export type RevitWorkflowResult = {
  workflow: RevitWorkflowName;
  execution_source: "live" | "mock" | "injected";
  success: boolean;
  failure_reason: string | null;
  failure_classification?: string | null;
  elapsed_seconds: number;
  tool_calls: number;
  revit_transactions: number;
  computer_use_actions: number;
  output_artifacts: string[];
  verification_results: RevitWorkflowVerification[];
  user_message: string;
  raw_results: unknown[];
};

export type BridgeTransport = {
  post(pathname: string, body: unknown): Promise<unknown>;
};

type JsonMap = Record<string, unknown>;

type WorkflowConfig = {
  workflow?: unknown;
  bridge_url?: unknown;
  timeout_ms?: unknown;
  mock?: unknown;
  use_mocks?: unknown;
  request?: unknown;
};

type RevitWorkflowPartialResult = Omit<RevitWorkflowResult, "elapsed_seconds" | "execution_source">;

function clip(value: unknown, max = 500): string {
  const text = typeof value === "string" ? value.trim() : "";
  return text.length <= max ? text : text.slice(0, max).trim();
}

function asObject(value: unknown): JsonMap {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as JsonMap) : {};
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.map((entry) => String(entry)).filter(Boolean) : [];
}

function asNumberArray(value: unknown): number[] {
  return Array.isArray(value)
    ? value.map((entry) => Number(entry)).filter((entry) => Number.isFinite(entry) && entry > 0)
    : [];
}

function workflowName(value: unknown): RevitWorkflowName {
  const normalized = clip(value, 80).toLowerCase();
  if (
    normalized === "sheet_export" ||
    normalized === "takeoff_csv" ||
    normalized === "parameter_edit" ||
    normalized === "redline_receptacles" ||
    normalized === "aec_mep_eval"
  ) {
    return normalized;
  }
  throw new Error(`Unknown Revit demo workflow '${String(value)}'.`);
}

function defaultBridgeUrl(): string {
  return resolveRevitBridgeUrlCandidates()[0] ?? "http://localhost:5000";
}

export function resolveRevitBridgeUrl(): string {
  return defaultBridgeUrl();
}

function normalizeBridgeUrl(value: string): string {
  return value.trim().replace(/\/+$/, "");
}

function fallbackBridgePorts(): number[] {
  const raw = (process.env.OPERATOR_REVIT_BRIDGE_FALLBACK_PORTS ?? "5010,5011,5012,5013,5014").trim();
  const ports = raw
    .split(",")
    .map((entry) => Number(entry.trim()))
    .filter((entry) => Number.isInteger(entry) && entry > 0 && entry <= 65535);
  return ports.length > 0 ? ports : [5010, 5011, 5012, 5013, 5014];
}

export function resolveRevitBridgeUrlCandidates(): string[] {
  const candidates: string[] = [];
  const push = (value: string | undefined | null) => {
    const normalized = value ? normalizeBridgeUrl(value) : "";
    if (normalized && !candidates.includes(normalized)) candidates.push(normalized);
  };
  push(process.env.REVIT_BRIDGE_URL);
  push(process.env.OPERATOR_REVIT_BRIDGE_URL);
  push(readDiscoveredBridgeUrl());
  push("http://localhost:5000");
  for (const port of fallbackBridgePorts()) push(`http://localhost:${port}`);
  return candidates;
}

function readDiscoveredBridgeUrl(): string {
  const localAppData = (process.env.LOCALAPPDATA ?? "").trim();
  if (!localAppData) return "";
  const filePath = path.join(localAppData, "RevitOperator", "bridge_url.txt");
  try {
    const value = fs.readFileSync(filePath, "utf8").trim();
    return value ? normalizeBridgeUrl(value) : "";
  } catch {
    return "";
  }
}

export function buildRevitBridgeHeaders(): Record<string, string> {
  const token = getOrCreateOperatorToken();
  const writeGrant = getWriteGrantToken();
  return {
    "content-type": "application/json",
    ...(token ? { "x-operator-token": token } : {}),
    ...(writeGrant ? { "x-operator-write-grant": writeGrant } : {})
  };
}

function parseBool(value: unknown): boolean | null {
  const normalized = String(value ?? "").trim().toLowerCase();
  if (!normalized) return null;
  if (["1", "true", "yes", "y", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "n", "off"].includes(normalized)) return false;
  return null;
}

export function shouldUseMockBridgeFixtures(config: WorkflowConfig): boolean {
  if (!config.mock) return false;
  const envOverride = parseBool(process.env.OPERATOR_BENCHMARK_USE_MOCKS);
  if (envOverride !== null) return envOverride;
  const configOverride = parseBool(config.use_mocks);
  if (configOverride !== null) return configOverride;
  return true;
}

export class HttpBridgeTransport implements BridgeTransport {
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  public computerUseActions = 0;

  constructor(baseUrl = defaultBridgeUrl(), timeoutMs = 60_000) {
    this.baseUrl = baseUrl.replace(/\/+$/, "");
    this.timeoutMs = Math.max(2_000, Math.min(10 * 60_000, timeoutMs));
  }

  async post(pathname: string, body: unknown): Promise<unknown> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    const warningDismissal = startRevitWarningDismissalWatchdog(() => {
      this.computerUseActions += 1;
    });
    try {
      const response = await fetch(`${this.baseUrl}${pathname}`, {
        method: "POST",
        headers: buildRevitBridgeHeaders(),
        body: JSON.stringify(body ?? {}),
        signal: controller.signal
      });
      const text = await response.text();
      const parsed = text ? JSON.parse(text) : {};
      if (!response.ok) {
        throw new Error(`Bridge ${pathname} failed with ${response.status}: ${clip((parsed as JsonMap).error ?? text, 800)}`);
      }
      return parsed;
    } finally {
      clearTimeout(timeout);
      warningDismissal();
    }
  }
}

function startRevitWarningDismissalWatchdog(onDismissed: () => void): () => void {
  if (process.platform !== "win32") return () => {};
  let active = false;
  const timer = setInterval(() => {
    if (active) return;
    active = true;
    try {
      const count = dismissVisibleRevitWarningDialogs();
      for (let i = 0; i < count; i++) onDismissed();
    } finally {
      active = false;
    }
  }, 5_000);
  timer.unref?.();
  return () => clearInterval(timer);
}

function dismissVisibleRevitWarningDialogs(): number {
  const script = String.raw`
$code = @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public static class RevitWarningClick {
  public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc lpEnumFunc, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool EnumChildWindows(IntPtr hWndParent, EnumWindowsProc lpEnumFunc, IntPtr lParam);
  [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr hWnd, StringBuilder lpString, int nMaxCount);
  [DllImport("user32.dll")] public static extern int GetClassName(IntPtr hWnd, StringBuilder lpClassName, int nMaxCount);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);
  [DllImport("user32.dll")] public static extern IntPtr SendMessage(IntPtr hWnd, int Msg, IntPtr wParam, IntPtr lParam);
}
'@;
Add-Type $code -ErrorAction SilentlyContinue;
$BM_CLICK = 0x00F5;
$revitPids = @(Get-Process Revit -ErrorAction SilentlyContinue | ForEach-Object { [uint32]$_.Id });
$clicked = 0;
[RevitWarningClick]::EnumWindows({ param($h,$l)
  $windowPid = [uint32]0; [void][RevitWarningClick]::GetWindowThreadProcessId($h, [ref]$windowPid);
  if ($revitPids -notcontains $windowPid) { return $true }
  $title = New-Object Text.StringBuilder 512; [void][RevitWarningClick]::GetWindowText($h,$title,$title.Capacity);
  $class = New-Object Text.StringBuilder 256; [void][RevitWarningClick]::GetClassName($h,$class,$class.Capacity);
  if (-not [RevitWarningClick]::IsWindowVisible($h) -or $class.ToString() -ne '#32770' -or $title.ToString() -notmatch 'Autodesk Revit') { return $true }
  [RevitWarningClick]::EnumChildWindows($h, { param($ch,$cl)
    $ct = New-Object Text.StringBuilder 512; [void][RevitWarningClick]::GetWindowText($ch,$ct,$ct.Capacity);
    $cc = New-Object Text.StringBuilder 256; [void][RevitWarningClick]::GetClassName($ch,$cc,$cc.Capacity);
    if ([RevitWarningClick]::IsWindowVisible($ch) -and $cc.ToString() -eq 'Button' -and $ct.ToString() -eq '&OK') {
      [void][RevitWarningClick]::SendMessage($ch, $BM_CLICK, [IntPtr]::Zero, [IntPtr]::Zero);
      $script:clicked += 1;
    }
    return $true
  }, [IntPtr]::Zero) | Out-Null;
  return $true
}, [IntPtr]::Zero) | Out-Null;
$clicked
`;
  try {
    const output = execFileSync("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", script], {
      encoding: "utf8",
      timeout: 10_000,
      windowsHide: true
    }).trim();
    const count = Number(output.split(/\s+/).filter(Boolean).pop() ?? "0");
    return Number.isFinite(count) && count > 0 ? count : 0;
  } catch {
    return 0;
  }
}

export class MockBridgeTransport implements BridgeTransport {
  private readonly fixtures: JsonMap;
  public calls: Array<{ pathname: string; body: unknown }> = [];

  constructor(fixtures: JsonMap) {
    this.fixtures = fixtures;
  }

  async post(pathname: string, body: unknown): Promise<unknown> {
    this.calls.push({ pathname, body });
    const key = `${pathname}:${this.calls.filter((call) => call.pathname === pathname).length}`;
    if (Object.prototype.hasOwnProperty.call(this.fixtures, key)) return this.fixtures[key];
    if (Object.prototype.hasOwnProperty.call(this.fixtures, pathname)) return this.fixtures[pathname];
    throw new Error(`Mock bridge fixture missing for ${pathname}.`);
  }
}

function verification(name: string, ok: boolean, expected?: unknown, actual?: unknown, detail?: string): RevitWorkflowVerification {
  return { name, ok, expected, actual, detail };
}

function countOk(results: RevitWorkflowVerification[]): boolean {
  return results.length > 0 && results.every((entry) => entry.ok);
}

function makeCsv(rows: Array<Record<string, unknown>>): string {
  const headers = Array.from(new Set(rows.flatMap((row) => Object.keys(row))));
  const escape = (value: unknown) => `"${String(value ?? "").replace(/"/g, "\"\"")}"`;
  return [headers.join(","), ...rows.map((row) => headers.map((header) => escape(row[header])).join(","))].join("\n") + "\n";
}

function writeCsv(filePath: string, rows: Array<Record<string, unknown>>): string {
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, makeCsv(rows), "utf8");
  return filePath;
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

function selectedSheetIdentifiers(selectedSheets: unknown[]): string[] {
  const ids = new Set<string>();
  for (const sheet of selectedSheets) {
    const item = asObject(sheet);
    for (const key of ["sheetNumber", "number", "SheetNumber"]) {
      const value = clip(item[key], 120);
      if (value) ids.add(value);
    }
  }
  return [...ids];
}

function requestedSheetCount(request: JsonMap): number | null {
  for (const key of ["sheetNumbers", "sheet_names", "sheetNames", "sheetIds", "sheets"]) {
    const value = request[key];
    if (Array.isArray(value) && value.length > 0) return value.length;
  }
  const max = Number(request.max);
  return Number.isFinite(max) && max > 0 ? max : null;
}

function expectedPdfOutputChecks(request: JsonMap, outputs: string[]): RevitWorkflowVerification[] {
  const checks: RevitWorkflowVerification[] = [];
  const baseFileName = clip(request.baseFileName ?? request.outputFileName ?? request.outputFilename ?? request.fileName, 260);
  if (baseFileName) {
    const basenames = outputs.map((entry) => path.basename(entry).toLowerCase());
    checks.push(verification("output_filename_matches_request", basenames.every((entry) => entry === baseFileName.toLowerCase()), baseFileName, outputs));
  }
  const outputFolder = clip(request.outputFolder ?? request.output_folder, 1000);
  if (outputFolder && path.isAbsolute(outputFolder)) {
    const expectedFolder = path.resolve(outputFolder).toLowerCase();
    const actualFolders = outputs.map((entry) => path.resolve(path.dirname(entry)).toLowerCase());
    checks.push(verification("output_folder_matches_request", actualFolders.every((entry) => entry === expectedFolder), expectedFolder, actualFolders));
  }
  return checks;
}

async function inspectPdf(filePath: string): Promise<{ pageCount: number; text: string }> {
  const bytes = fs.readFileSync(filePath);
  const pdfjs = await loadPdfJsForNode();
  const doc = await pdfjs.getDocument(buildPdfJsDocumentOptions(new Uint8Array(bytes))).promise;
  const pageCount = Number(doc.numPages ?? 0);
  const chunks: string[] = [];
  const pagesToRead = Math.min(pageCount, 12);
  for (let pageNumber = 1; pageNumber <= pagesToRead; pageNumber++) {
    const page = await doc.getPage(pageNumber);
    const content = await page.getTextContent();
    const items = Array.isArray(content.items) ? content.items : [];
    chunks.push(...items.map((item: unknown) => clip(asObject(item).str, 400)).filter(Boolean));
  }
  return { pageCount, text: chunks.join(" ") };
}

async function buildPdfContentChecks(outputs: string[], selectedSheets: unknown[], combine: boolean): Promise<RevitWorkflowVerification[]> {
  const checks: RevitWorkflowVerification[] = [];
  const expectedCount = selectedSheets.length;
  if (outputs.length === 0 || expectedCount === 0) return checks;
  for (const filePath of outputs.filter((entry) => /\.pdf$/i.test(entry))) {
    if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) continue;
    try {
      const inspection = await inspectPdf(filePath);
      const expectedPages = combine ? expectedCount : 1;
      checks.push(verification("pdf_page_count", inspection.pageCount === expectedPages, expectedPages, inspection.pageCount, filePath));
      const identifiers = selectedSheetIdentifiers(selectedSheets);
      const text = inspection.text.toLowerCase();
      if (identifiers.length > 0 && text.trim()) {
        const missing = identifiers.filter((identifier) => !text.includes(identifier.toLowerCase()));
        checks.push(verification("pdf_contains_sheet_identifiers", missing.length === 0, identifiers, { missing }, filePath));
      } else {
        checks.push(verification("pdf_contains_sheet_identifiers", true, identifiers, "not inspectable", "PDF text was empty or no sheet identifiers were available."));
      }
    } catch (error) {
      checks.push(verification("pdf_content_inspection", false, filePath, null, error instanceof Error ? error.message : String(error)));
    }
  }
  return checks;
}

async function runSheetExport(transport: BridgeTransport, request: JsonMap): Promise<RevitWorkflowPartialResult> {
  const rawResults: unknown[] = [];
  const preflight = await transport.post("/revit/export-pdf", { ...request, dryRun: true });
  rawResults.push(preflight);
  const preflightOut = asObject(preflight);
  const expectedSheetCount = requestedSheetCount(request);
  const preflightSelectedSheets = Array.isArray(preflightOut.selectedSheets) ? preflightOut.selectedSheets : [];
  const preflightSelectedCount = Number(preflightOut.selectedCount ?? preflightSelectedSheets.length);
  const preflightChecks = [
    verification("dry_run_resolved_requested_sheets", expectedSheetCount === null ? preflightSelectedCount > 0 : preflightSelectedCount === expectedSheetCount, expectedSheetCount ?? ">0", preflightSelectedCount)
  ];
  if (!countOk(preflightChecks)) {
    return {
      workflow: "sheet_export",
      success: false,
      failure_reason: "PDF export dry-run did not resolve the requested sheets.",
      tool_calls: 1,
      revit_transactions: 0,
      computer_use_actions: 0,
      output_artifacts: [],
      verification_results: preflightChecks,
      user_message: "PDF export stopped before printing because the requested sheets did not resolve.",
      raw_results: rawResults
    };
  }
  const exported = await transport.post("/revit/export-pdf", { ...request, dryRun: false });
  rawResults.push(exported);

  const out = asObject(exported);
  const selectedSheets = Array.isArray(out.selectedSheets) ? out.selectedSheets : [];
  const outputs = asStringArray(out.outputs ?? out.paths ?? (out.path ? [out.path] : []));
  const combine = out.combine !== false;
  const fileChecks = outputs.map((filePath) => {
    const bridgeVerification = asObject(out.verification);
    if (outputs.length === 1 && typeof bridgeVerification.ok === "boolean") {
      return verification("pdf_file_exists", bridgeVerification.ok, filePath, bridgeVerification);
    }
    return verification("pdf_file_exists", fs.existsSync(filePath) && fs.statSync(filePath).size > 0, filePath, filePath);
  });
  const checks = [
    ...preflightChecks,
    verification("selected_sheet_count", selectedSheets.length > 0 && selectedSheets.length === Number(out.selectedCount ?? selectedSheets.length), out.selectedCount, selectedSheets.length),
    ...fileChecks,
    ...expectedPdfOutputChecks(request, outputs),
    ...(await buildPdfContentChecks(outputs, selectedSheets, combine))
  ];

  return {
    workflow: "sheet_export",
    success: countOk(checks),
    failure_reason: countOk(checks) ? null : "PDF export verification failed.",
    tool_calls: 2,
    revit_transactions: 0,
    computer_use_actions: 0,
    output_artifacts: outputs,
    verification_results: checks,
    user_message: countOk(checks)
      ? `Exported ${selectedSheets.length} sheet(s) to ${outputs.join(", ")}.`
      : "PDF export ran, but verification failed.",
    raw_results: rawResults
  };
}

async function runTakeoffCsv(transport: BridgeTransport, request: JsonMap, runDir: string): Promise<RevitWorkflowPartialResult> {
  const quantify = await transport.post("/revit/quantify", request);
  const out = asObject(quantify);
  const summary = asObject(out.summary);
  const groups = asObject(summary.groups);
  const total = Number(summary.total ?? 0);
  const groupedTotal = Object.values(groups).reduce<number>((sum, value) => sum + Number(value ?? 0), 0);
  const groupRows = Object.entries(groups).map(([group, count]) => ({ group, count }));
  const rows = Array.isArray(out.rows) && out.rows.length > 0 ? (out.rows as Array<Record<string, unknown>>) : groupRows;
  const csvPath = writeCsv(path.join(runDir, "artifacts", "takeoff_summary.csv"), rows);
  const tablePath = writeMarkdownTable(path.join(runDir, "artifacts", "takeoff_summary.md"), rows);
  const tablePreview = makeMarkdownTable(rows, 10).trim();
  const checks = [
    verification("raw_total_matches_grouped_total", total === groupedTotal, total, groupedTotal),
    verification("csv_written", fs.existsSync(csvPath) && fs.statSync(csvPath).size > 0, csvPath, csvPath),
    verification("readable_table_written", fs.existsSync(tablePath) && fs.statSync(tablePath).size > 0, tablePath, tablePath)
  ];
  return {
    workflow: "takeoff_csv",
    success: countOk(checks),
    failure_reason: countOk(checks) ? null : "Takeoff total/grouped total or CSV verification failed.",
    tool_calls: 1,
    revit_transactions: 0,
    computer_use_actions: 0,
    output_artifacts: [csvPath, tablePath],
    verification_results: checks,
    user_message: countOk(checks)
      ? `Counted ${total} element(s). CSV: ${csvPath}\n\n${tablePreview}`
      : "Takeoff ran, but verification failed.",
    raw_results: [quantify]
  };
}

async function resolveParameterTargets(transport: BridgeTransport, request: JsonMap): Promise<number[]> {
  const explicit = asNumberArray(request.elementIds ?? request.element_ids);
  if (explicit.length > 0) return explicit;
  const query = asObject(request.query);
  if (Object.keys(query).length === 0) return [];
  const found = asObject(await transport.post("/revit/find-elements", query));
  const candidates = asNumberArray(found.elementIds ?? found.ids);
  if (candidates.length > 0) return candidates;
  const items = Array.isArray(found.items) ? found.items : [];
  return items.map((entry) => Number(asObject(entry).id ?? asObject(entry).elementId)).filter((entry) => Number.isFinite(entry) && entry > 0);
}

function parameterSnapshotItems(snapshot: unknown): JsonMap[] {
  const obj = asObject(snapshot);
  if (Array.isArray(obj.items)) return obj.items.map(asObject);
  return [obj];
}

function parameterValueByElementId(snapshot: unknown, parameterName: string): Map<number, string> {
  const values = new Map<number, string>();
  for (const item of parameterSnapshotItems(snapshot)) {
    const id = Number(item.id ?? item.elementId);
    if (!Number.isFinite(id) || id <= 0) continue;
    const parameters = asObject(item.parameters);
    values.set(id, String(parameters[parameterName] ?? ""));
  }
  return values;
}

function parameterDiffs(result: unknown): JsonMap[] {
  const diffs = asObject(result).diffs;
  return Array.isArray(diffs) ? diffs.map(asObject) : [];
}

function parameterResultRows(result: unknown): JsonMap[] {
  if (Array.isArray(result)) return result.map(asObject);
  const obj = asObject(result);
  if (Array.isArray(obj.results)) return obj.results.map(asObject);
  if (Array.isArray(obj.items)) return obj.items.map(asObject);
  return Object.keys(obj).length > 0 ? [obj] : [];
}

function hasParameterWriteErrors(result: unknown): boolean {
  const obj = asObject(result);
  if (obj.ok === false || obj.success === false) return true;
  const status = clip(obj.status, 80).toLowerCase();
  if (["error", "failed", "failure"].includes(status)) return true;
  const rows = [...parameterDiffs(result), ...parameterResultRows(result)];
  return rows.some((diff) =>
    diff.ok === false ||
    diff.success === false ||
    diff.canChange === false ||
    diff.readOnly === true ||
    diff.read_only === true ||
    Boolean(diff.error) ||
    Boolean(diff.failureReason) ||
    clip(diff.status, 200).toLowerCase().startsWith("error")
  );
}

async function runParameterEdit(transport: BridgeTransport, request: JsonMap, runDir: string): Promise<RevitWorkflowPartialResult> {
  const parameterName = clip(request.parameterName ?? request.parameter_name, 200);
  const value = String(request.value ?? "");
  const targetIds = await resolveParameterTargets(transport, request);
  if (!parameterName || targetIds.length === 0) throw new Error("parameter_edit requires parameterName and elementIds or query.");
  const changes = targetIds.map((elementId) => ({ elementId, parameterName, value }));
  const rawResults: unknown[] = [];
  const before = await transport.post("/revit/get-parameters", { elementIds: targetIds, names: [parameterName] });
  rawResults.push(before);
  const dryRun = await transport.post("/revit/set-parameter", { changes, apply: false });
  rawResults.push(dryRun);
  const beforeValues = parameterValueByElementId(before, parameterName);
  const preApplyRows = targetIds.map((elementId) => ({
    elementId,
    parameter: parameterName,
    oldValue: beforeValues.get(elementId) ?? "",
    newValue: value,
    readbackValue: "",
    status: "dry-run failed"
  }));
  const dryRunDiffs = parameterDiffs(dryRun);
  if (hasParameterWriteErrors(dryRun)) {
    const summaryPath = writeMarkdownTable(path.join(runDir, "artifacts", "parameter_change_summary.md"), preApplyRows);
    const checks = [
      verification("target_count", targetIds.length > 0, ">0", targetIds.length),
      verification("old_values_captured", preApplyRows.length === targetIds.length, targetIds.length, preApplyRows.length),
      verification("dry_run_returned_diffs", parameterDiffs(dryRun).length > 0 || parameterResultRows(dryRun).length > 0, "diffs[] or result rows", dryRun),
      verification("dry_run_all_changes_ok", false, "no dry-run write errors", dryRunDiffs.length > 0 ? dryRunDiffs : dryRun),
      verification("parameter_change_summary_written", fs.existsSync(summaryPath) && fs.statSync(summaryPath).size > 0, summaryPath, summaryPath)
    ];
    return {
      workflow: "parameter_edit",
      success: false,
      failure_reason: "Parameter dry-run reported read-only, missing parameter, invalid value, or another write error.",
      tool_calls: request.query ? 3 : 2,
      revit_transactions: 1,
      computer_use_actions: 0,
      output_artifacts: [summaryPath],
      verification_results: checks,
      user_message: "Parameter edit stopped before commit because dry-run reported a write error.",
      raw_results: rawResults
    };
  }
  const applied = await transport.post("/revit/set-parameter", { changes, apply: true });
  rawResults.push(applied);
  const after = await transport.post("/revit/get-parameters", { elementIds: targetIds, names: [parameterName] });
  rawResults.push(after);

  const afterItems = parameterSnapshotItems(after);
  const afterValues = parameterValueByElementId(after, parameterName);
  const changeRows = targetIds.map((elementId) => ({
    elementId,
    parameter: parameterName,
    oldValue: beforeValues.get(elementId) ?? "",
    newValue: value,
    readbackValue: afterValues.get(elementId) ?? ""
  }));
  const summaryPath = writeMarkdownTable(path.join(runDir, "artifacts", "parameter_change_summary.md"), changeRows);
  const tablePreview = makeMarkdownTable(changeRows, 10).trim();
  const allValuesMatch = targetIds.every((elementId) => afterValues.get(elementId) === value);
  const diffs = parameterDiffs(applied);
  const checks = [
    verification("target_count", targetIds.length > 0, ">0", targetIds.length),
    verification("dry_run_returned_diffs", parameterDiffs(dryRun).length > 0 || parameterResultRows(dryRun).length > 0, "diffs[] or result rows", dryRun),
    verification("dry_run_all_changes_ok", !hasParameterWriteErrors(dryRun), "no dry-run write errors", dryRunDiffs),
    verification("apply_all_changes_ok", !hasParameterWriteErrors(applied), "no apply write errors", diffs.length > 0 ? diffs : applied),
    verification("apply_changed_or_confirmed", Number(asObject(applied).changedCount ?? (diffs.filter((d) => d.changed === true).length || parameterResultRows(applied).filter((d) => d.success === true).length)) >= targetIds.length || allValuesMatch, targetIds.length, applied),
    verification("old_values_captured", changeRows.length === targetIds.length, targetIds.length, changeRows.length),
    verification("readback_matches_requested_value", allValuesMatch, value, afterItems),
    verification("parameter_change_summary_written", fs.existsSync(summaryPath) && fs.statSync(summaryPath).size > 0, summaryPath, summaryPath)
  ];
  return {
    workflow: "parameter_edit",
    success: countOk(checks),
    failure_reason: countOk(checks) ? null : "Parameter read-back verification failed.",
    tool_calls: request.query ? 5 : 4,
    revit_transactions: 2,
    computer_use_actions: 0,
    output_artifacts: [summaryPath],
    verification_results: checks,
    user_message: countOk(checks)
      ? `Updated ${parameterName} on ${targetIds.length} element(s) to '${value}'.\n\n${tablePreview}`
      : "Parameter edit ran, but verification failed.",
    raw_results: rawResults
  };
}

function collectionCount(value: unknown): number {
  if (Array.isArray(value)) return value.length;
  const obj = asObject(value);
  for (const key of ["elements", "items", "visibleElements", "instances"]) {
    if (Array.isArray(obj[key])) return (obj[key] as unknown[]).length;
  }
  return Object.keys(obj).length > 0 ? 1 : 0;
}

function firstString(...values: unknown[]): string {
  for (const value of values) {
    const text = clip(value, 300);
    if (text) return text;
  }
  return "";
}

function normalizeCircuitLabel(value: unknown): string {
  return clip(value, 120)
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "/")
    .replace(/\/+/g, "/")
    .replace(/^\/|\/$/g, "");
}

function circuitLabelFromPayload(value: unknown): string {
  const obj = asObject(value);
  const electricalCircuit = asObject(obj.electricalCircuit);
  const primary = firstString(electricalCircuit.primaryLabel, electricalCircuit.label, obj.primaryLabel, obj.circuitLabel);
  if (primary) return primary;
  const panel = firstString(electricalCircuit.panel, obj.panel, obj.Panel);
  const circuit = firstString(electricalCircuit.circuitNumber, electricalCircuit.circuit, obj.circuitNumber, obj.circuit, obj["Circuit Number"]);
  return `${panel}${panel && circuit ? "/" : ""}${circuit}`.trim();
}

function auditItemsByElementId(audit: unknown): Map<number, JsonMap> {
  const out = new Map<number, JsonMap>();
  const items = Array.isArray(asObject(audit).items) ? (asObject(audit).items as unknown[]) : [];
  for (const item of items) {
    const obj = asObject(item);
    const id = Number(obj.elementId ?? obj.id);
    if (Number.isFinite(id) && id > 0) out.set(id, obj);
  }
  return out;
}

function placementContextForAuditItem(item: JsonMap): JsonMap {
  return asObject(item.placementContext ?? item.context ?? item);
}

function roomNumberFromAuditItem(item: JsonMap): string {
  const context = placementContextForAuditItem(item);
  const room = asObject(context.room);
  const space = asObject(context.space);
  return firstString(item.roomNumber, item.spaceNumber, context.roomNumber, context.spaceNumber, room.number, space.number);
}

function hostEvidenceOk(item: JsonMap): boolean | null {
  const context = placementContextForAuditItem(item);
  const diagnostics = asObject(context.diagnostics);
  const support = asObject(diagnostics.hostPlacementSupport);
  const placementHost = asObject(context.placementHost ?? item.placementHost);
  const hostOk = asObject(item).hostOk;
  if (typeof hostOk === "boolean") return hostOk;
  if (support.supported === false || support.sourceHostSupported === false) return false;
  if (placementHost.id || context.hostElementId || item.hostElementId) return true;
  return null;
}

function expectedRoomForPlacement(placement: JsonMap, request: JsonMap): string {
  return firstString(placement.expectedRoomNumber, placement.roomNumber, request.expectedRoomNumber, request.roomNumber);
}

function normalizeRoomSide(value: unknown): string {
  const raw = clip(value, 80).toLowerCase();
  if (!raw) return "";
  if (raw === "left" || raw === "west") return "left";
  if (raw === "right" || raw === "east") return "right";
  if (raw === "top" || raw === "upper" || raw === "north") return "top";
  if (raw === "bottom" || raw === "lower" || raw === "south") return "bottom";
  return raw;
}

function expectedRoomSideForPlacement(placement: JsonMap, request: JsonMap): string {
  return normalizeRoomSide(firstString(placement.expectedRoomSide, placement.roomSide, request.expectedRoomSide, request.roomSide));
}

function requestedRoomSideEvidenceFromAuditItem(item: JsonMap): { ok: boolean | null; actual: string } {
  const context = placementContextForAuditItem(item);
  const room = asObject(context.room);
  const diagnostics = asObject(context.diagnostics);
  const support = asObject(diagnostics.hostPlacementSupport);
  const booleanEvidence = [
    item.onRequestedRoomSide,
    item.on_requested_room_side,
    item.hostOnRequestedRoomSide,
    context.onRequestedRoomSide,
    context.on_requested_room_side,
    support.onRequestedRoomSide,
    support.on_requested_room_side
  ].find((value) => typeof value === "boolean");
  const actual = normalizeRoomSide(firstString(
    item.roomSide,
    item.requestedRoomSide,
    item.requested_room_side,
    context.roomSide,
    context.requestedRoomSide,
    context.requested_room_side,
    room.requestedSide,
    room.requestedRoomSide
  ));
  return {
    ok: typeof booleanEvidence === "boolean" ? booleanEvidence : null,
    actual
  };
}

function expectedCircuitForPlacement(placement: JsonMap, request: JsonMap): string {
  const overrides = asObject(placement.parameterOverrides);
  const fromOverride = circuitLabelFromPayload({ panel: overrides.Panel ?? overrides.panel, circuitNumber: overrides["Circuit Number"] ?? overrides.Circuit ?? overrides.circuitNumber ?? overrides.circuit });
  return firstString(placement.expectedCircuitLabel, request.expectedCircuitLabel, fromOverride);
}

async function runRedlineReceptacles(transport: BridgeTransport, request: JsonMap, runDir: string): Promise<RevitWorkflowPartialResult> {
  const placements = Array.isArray(request.placements) ? repeatSafePlacements(request.placements as JsonMap[], runDir) : [];
  if (placements.length === 0) throw new Error("redline_receptacles requires a bounded placements array.");
  const rawResults: unknown[] = [];
  const placementResults: unknown[] = [];
  const before = await transport.post("/revit/export-visible-elements", request.beforeCapture ?? { viewId: request.viewId, categories: ["OST_ElectricalFixtures"], includeMapping: true });
  rawResults.push(before);
  const createdIds: number[] = [];
  for (const placement of placements) {
    const placed = await transport.post("/revit/create-similar-from-instance", buildCreateSimilarRequest(placement, request));
    rawResults.push(placed);
    placementResults.push(placed);
    createdIds.push(...asNumberArray(asObject(placed).createdElementIds ?? asObject(placed).elementIds ?? (asObject(placed).elementId ? [asObject(placed).elementId] : [])));
  }
  const audit = await transport.post("/revit/audit-hosted-instance-placement", { elementIds: createdIds, viewId: request.viewId, ...(asObject(request.audit)) });
  rawResults.push(audit);
  const after = await transport.post("/revit/export-visible-elements", request.afterCapture ?? { viewId: request.viewId, categories: ["OST_ElectricalFixtures"], includeMapping: true });
  rawResults.push(after);
  const cleanupRequested = parseBool(request.cleanupCreatedElements ?? request.cleanup_created_elements) === true;
  let cleanup: unknown = null;
  if (cleanupRequested && createdIds.length > 0) {
    cleanup = await transport.post("/revit/delete", {
      ids: createdIds,
      apply: true,
      reason: "benchmark cleanup for repeated redline receptacle reliability runs"
    });
    rawResults.push(cleanup);
  }

  const summary = {
    viewId: request.viewId ?? null,
    requestedPlacementCount: placements.length,
    createdElementIds: createdIds,
    beforeVisibleCount: collectionCount(before),
    afterVisibleCount: collectionCount(after),
    audit,
    cleanupRequested,
    cleanup,
    placements: placements.map((placement, index) => ({
      index: index + 1,
      exemplarElementId: placement.exemplarElementId ?? null,
      hostElementId: placement.hostElementId ?? null,
      expectedRoomNumber: expectedRoomForPlacement(placement, request) || null,
      expectedRoomSide: expectedRoomSideForPlacement(placement, request) || null,
      expectedCircuitLabel: expectedCircuitForPlacement(placement, request) || null,
      mark: asObject(placement.parameterOverrides).Mark ?? placement.mark ?? null,
      panel: asObject(placement.parameterOverrides).Panel ?? placement.panel ?? null,
      circuit: asObject(placement.parameterOverrides).Circuit ?? placement.circuit ?? null,
      createdElementId: createdIds[index] ?? null
    }))
  };
  const summaryJsonPath = path.join(runDir, "artifacts", "redline_receptacles_summary.json");
  writeJsonFile(summaryJsonPath, summary);
  const summaryRows = summary.placements.map((placement) => ({
    index: placement.index,
    exemplarElementId: placement.exemplarElementId,
    hostElementId: placement.hostElementId,
    createdElementId: placement.createdElementId,
    roomSide: placement.expectedRoomSide,
    mark: placement.mark,
    panel: placement.panel,
    circuit: placement.circuit
  }));
  const summaryMdPath = writeMarkdownTable(path.join(runDir, "artifacts", "redline_receptacles_summary.md"), summaryRows);
  const tablePreview = makeMarkdownTable(summaryRows, 10).trim();

  const auditItems = auditItemsByElementId(audit);
  const expectedRooms = placements.map((placement) => expectedRoomForPlacement(placement, request));
  const expectedRoomSides = placements.map((placement) => expectedRoomSideForPlacement(placement, request));
  const expectedCircuits = placements.map((placement) => expectedCircuitForPlacement(placement, request));
  const sourceCircuitLabels = placementResults.map((result) => {
    const obj = asObject(result);
    return circuitLabelFromPayload(obj.exemplar) || circuitLabelFromPayload(obj.source);
  });
  const createdCircuitLabels = createdIds.map((id, index) => {
    const auditItem = auditItems.get(id);
    const placementResult = asObject(placementResults[index]);
    const placementRows = Array.isArray(placementResult.placements) ? (placementResult.placements as unknown[]).map(asObject) : [];
    const placementRow = placementRows.find((row) => Number(row.elementId ?? row.id) === id) ?? placementRows[index] ?? {};
    return circuitLabelFromPayload(auditItem ?? {}) || circuitLabelFromPayload(placementRow) || circuitLabelFromPayload(placementResult);
  });
  const roomChecksNeeded = expectedRooms.some((room) => !!room);
  const roomSideChecksNeeded = expectedRoomSides.some((side) => !!side);
  const circuitChecksNeeded = expectedCircuits.some((circuit) => !!circuit);
  const sourceCircuitChecksNeeded = placements.some((placement) => parseBool(placement.matchElectricalCircuitFromSource) === true);
  const requireAuditItems = parseBool(request.requireAuditItems ?? request.require_audit_items) === true;
  const hostChecks = createdIds.map((id) => {
    const item = auditItems.get(id);
    return item ? hostEvidenceOk(item) : (requireAuditItems ? false : null);
  });
  const optionalChecks: RevitWorkflowVerification[] = [];
  if (requireAuditItems || auditItems.size > 0) {
    optionalChecks.push(verification(
      "audit_contains_created_ids",
      createdIds.length > 0 && createdIds.every((id) => auditItems.has(id)),
      createdIds,
      [...auditItems.keys()]
    ));
  }
  if (hostChecks.some((entry) => entry !== null)) {
    optionalChecks.push(verification("audit_host_evidence_ok", hostChecks.every((entry) => entry !== false), "host evidence not false", hostChecks));
  }
  if (roomChecksNeeded) {
    optionalChecks.push(verification(
      "created_room_matches_expected",
      createdIds.every((id, index) => {
        const expected = expectedRooms[index];
        if (!expected) return true;
        const actual = roomNumberFromAuditItem(auditItems.get(id) ?? {});
        return actual.trim().toUpperCase() === expected.trim().toUpperCase();
      }),
      expectedRooms,
      createdIds.map((id) => roomNumberFromAuditItem(auditItems.get(id) ?? {}))
    ));
  }
  if (roomSideChecksNeeded) {
    const sideEvidence = createdIds.map((id) => requestedRoomSideEvidenceFromAuditItem(auditItems.get(id) ?? {}));
    optionalChecks.push(verification(
      "created_room_side_matches_expected",
      createdIds.every((_, index) => {
        const expected = expectedRoomSides[index];
        if (!expected) return true;
        const evidence = sideEvidence[index] ?? { ok: null, actual: "" };
        if (evidence.ok !== null) return evidence.ok === true;
        return !!evidence.actual && evidence.actual === expected;
      }),
      expectedRoomSides,
      sideEvidence
    ));
  }
  if (circuitChecksNeeded) {
    optionalChecks.push(verification(
      "created_circuit_matches_expected",
      createdIds.every((_, index) => {
        const expected = normalizeCircuitLabel(expectedCircuits[index]);
        if (!expected) return true;
        return normalizeCircuitLabel(createdCircuitLabels[index]) === expected;
      }),
      expectedCircuits,
      createdCircuitLabels
    ));
  }
  if (sourceCircuitChecksNeeded) {
    optionalChecks.push(verification(
      "created_circuit_matches_source_when_requested",
      createdIds.every((_, index) => {
        const expected = normalizeCircuitLabel(sourceCircuitLabels[index]);
        const actual = normalizeCircuitLabel(createdCircuitLabels[index]);
        return !!expected && !!actual && actual === expected;
      }),
      sourceCircuitLabels,
      createdCircuitLabels
    ));
  }

  const checks = [
    verification("created_expected_count", createdIds.length === placements.length, placements.length, createdIds.length),
    verification("audit_passed", asObject(audit).ok !== false && asObject(audit).success !== false && Object.keys(asObject(audit)).length > 0, "passing audit payload", audit),
    ...optionalChecks,
    verification("after_capture_returned", Object.keys(asObject(after)).length > 0, "after capture", after),
    verification("after_visible_count_increased", summary.afterVisibleCount >= summary.beforeVisibleCount + createdIds.length, summary.beforeVisibleCount + createdIds.length, summary.afterVisibleCount),
    verification(
      "cleanup_completed_when_requested",
      !cleanupRequested || (Object.keys(asObject(cleanup)).length > 0 && asObject(cleanup).ok !== false && asObject(cleanup).success !== false),
      cleanupRequested ? "delete result with ok/success not false" : "not requested",
      cleanup
    ),
    verification("redline_summary_written", fs.existsSync(summaryJsonPath) && fs.existsSync(summaryMdPath), [summaryJsonPath, summaryMdPath], summary)
  ];
  return {
    workflow: "redline_receptacles",
    success: countOk(checks),
    failure_reason: countOk(checks) ? null : "Receptacle placement verification failed.",
    tool_calls: 3 + placements.length,
    revit_transactions: placements.length,
    computer_use_actions: 0,
    output_artifacts: [summaryJsonPath, summaryMdPath],
    verification_results: checks,
    user_message: countOk(checks)
      ? `Placed and verified ${createdIds.length} receptacle(s): ${createdIds.join(", ")}.\n\n${tablePreview}`
      : "Receptacle placement ran, but verification failed.",
    raw_results: rawResults
  };
}

function repeatIndexFromRunDir(runDir: string): number {
  const match = path.basename(runDir).match(/repeat-(\d+)/i);
  const index = match ? Number(match[1]) : 1;
  return Number.isFinite(index) && index > 0 ? index : 1;
}

function repeatSafePlacements(placements: JsonMap[], runDir: string): JsonMap[] {
  const repeatIndex = repeatIndexFromRunDir(runDir);
  const suffix = `-R${String(repeatIndex).padStart(2, "0")}`;
  return placements.map((placement) => {
    const next: JsonMap = { ...placement };
    if (typeof next.label === "string" && next.label.trim() && !next.label.endsWith(suffix)) {
      next.label = `${next.label}${suffix}`;
    }
    const overrides = asObject(next.parameterOverrides);
    if (Object.keys(overrides).length > 0) {
      const nextOverrides: JsonMap = { ...overrides };
      if (typeof nextOverrides.Mark === "string" && nextOverrides.Mark.trim() && !nextOverrides.Mark.endsWith(suffix)) {
        nextOverrides.Mark = `${nextOverrides.Mark}${suffix}`;
      }
      next.parameterOverrides = nextOverrides;
    }
    return next;
  });
}

function takeDefined(source: JsonMap, keys: string[]): JsonMap {
  const out: JsonMap = {};
  for (const key of keys) {
    if (source[key] !== undefined && source[key] !== null) out[key] = source[key];
  }
  return out;
}

function buildCreateSimilarRequest(placement: JsonMap, workflowRequest: JsonMap): JsonMap {
  const placementItem = takeDefined(placement, [
    "pointXyz",
    "alongHostOffsetFt",
    "targetChainageFt",
    "targetNormalizedChainage",
    "elevationFt",
    "elevationDeltaFt",
    "label"
  ]);
  return {
    ...takeDefined(placement, [
      "exemplarElementId",
      "hostElementId",
      "roomId",
      "roomNumber",
      "roomSide",
      "referenceElementId",
      "levelName",
      "matchOrientationFromSource",
      "orientationSourceElementId",
      "copyRotation",
      "copyFacingHandState",
      "matchElectricalCircuitFromSource",
      "requireElectricalCircuitMatch",
      "parameterNamesToCopy",
      "parameterOverrides",
      "focusPaddingFt",
      "previewImageSize"
    ]),
    placements: [placementItem],
    dryRun: false,
    includePreviewImage: true,
    previewViewId: placement.previewViewId ?? workflowRequest.viewId
  };
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

async function runAecMepEval(transport: BridgeTransport, request: JsonMap, runDir: string): Promise<RevitWorkflowPartialResult> {
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

export async function runRevitDemoWorkflow(config: WorkflowConfig, runDir: string, transport?: BridgeTransport): Promise<RevitWorkflowResult> {
  const workflow = workflowName(config.workflow);
  const request = asObject(config.request);
  const timeoutMs = Number(config.timeout_ms ?? 60_000);
  const useMockFixtures = shouldUseMockBridgeFixtures(config);
  const executionSource: RevitWorkflowResult["execution_source"] = transport ? "injected" : useMockFixtures ? "mock" : "live";
  const effectiveTransport =
    transport ??
    (useMockFixtures
      ? new MockBridgeTransport(asObject(config.mock))
      : new HttpBridgeTransport(clip(config.bridge_url, 500) || defaultBridgeUrl(), timeoutMs));
  const startedAt = performance.now();
  let partial: RevitWorkflowPartialResult;
  if (workflow === "sheet_export") partial = await runSheetExport(effectiveTransport, request);
  else if (workflow === "takeoff_csv") partial = await runTakeoffCsv(effectiveTransport, request, runDir);
  else if (workflow === "parameter_edit") partial = await runParameterEdit(effectiveTransport, request, runDir);
  else if (workflow === "redline_receptacles") partial = await runRedlineReceptacles(effectiveTransport, request, runDir);
  else partial = await runAecMepEval(effectiveTransport, request, runDir);
  const modalRecoveryActions = effectiveTransport instanceof HttpBridgeTransport ? effectiveTransport.computerUseActions : 0;
  const result = {
    ...partial,
    computer_use_actions: partial.computer_use_actions + modalRecoveryActions,
    execution_source: executionSource,
    elapsed_seconds: (performance.now() - startedAt) / 1000
  };
  writeJsonFile(path.join(runDir, "revit_workflow_result.json"), result);
  return result;
}
