import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

type HttpMethod = "GET" | "POST";
type ToolKey = `${HttpMethod} ${string}`;

type LiveProbeReceipt = {
  name: string;
  key: ToolKey;
  duration_ms: number | null;
  transport_ok: boolean;
  useful: boolean;
};

type LiveProbeEvidence = {
  generated_at: string | null;
  receipts: LiveProbeReceipt[];
};

type ManifestTool = {
  key: ToolKey;
  method: HttpMethod;
  path: string;
  group: string;
  title: string;
  risk: string;
};

type HandlerMap = Map<string, string[]>;

const PANE_BACKEND_PATHS = new Set([
  "/revit/batch-control",
  "/revit/batch-job",
  "/revit/capture-screenshare"
]);

export type ToolAuditRow = {
  key: ToolKey;
  method: HttpMethod;
  path: string;
  group: string;
  title: string;
  risk: string;
  surface_kind: "revit_bridge" | "pane_backend" | "ui_host";
  handlers: {
    operator_action_runner: string[];
    direct_http: string[];
    pane_intercept: boolean;
  };
  contracts: {
    backend_allowlisted: boolean;
    addin_allowlisted: boolean;
    manifest: boolean;
    examples_count: number;
    specific_request_schema: boolean;
    request_schema_source: "none" | "explicit" | "reflected" | "generic";
    schema_validator_reference: boolean;
  };
  mcp: {
    generic_call_available: boolean;
    typed_tools: string[];
  };
  live: {
    advertised: boolean | null;
    metadata_matches_source: boolean | null;
  };
  public_parity: boolean | null;
  evidence: {
    advertised: boolean | null;
    contract_valid: boolean;
    live_safe: boolean | null;
    useful: boolean | null;
    quarantined: boolean;
  };
  live_probes: {
    receipt_count: number;
    transport_successes: number;
    useful_successes: number;
    names: string[];
    max_duration_ms: number | null;
  };
  issues: string[];
};

export type ToolRegistryAudit = {
  version: "revit-operator.tool-registry-audit.v1";
  generated_at: string;
  repo_root: string;
  live_source: string | null;
  live_probe_source: string | null;
  live_probe_generated_at: string | null;
  summary: Record<string, number>;
  public_summary: Record<string, number> | null;
  tools: ToolAuditRow[];
};

type Layout = {
  repoRoot: string;
  backendRoot: string;
  addinRoot: string;
  mcpRoot: string;
};

type Catalog = {
  manifest: Map<ToolKey, ManifestTool>;
  backendAllowlist: Set<ToolKey>;
  addinAllowlist: Set<ToolKey>;
  examples: Map<ToolKey, number>;
  actionHandlers: HandlerMap;
  httpHandlers: HandlerMap;
  directRunnerPaths: Set<string>;
  directHttpPaths: Set<string>;
  panePaths: Set<string>;
  explicitSchemaPaths: Set<string>;
  reflectedSchemaPaths: Set<string>;
  schemaValidatorPaths: Set<string>;
  mcpWrappersByPath: Map<string, string[]>;
  mcpGenericAvailable: boolean;
};

function toolKey(method: string, toolPath: string): ToolKey | null {
  const normalizedMethod = method.trim().toUpperCase();
  const normalizedPath = toolPath.trim();
  if ((normalizedMethod !== "GET" && normalizedMethod !== "POST") || (!normalizedPath.startsWith("/revit/") && !normalizedPath.startsWith("/ui/"))) return null;
  return `${normalizedMethod} ${normalizedPath}` as ToolKey;
}

export function findRepoRoot(startDir: string): string {
  let current = path.resolve(startDir);
  for (let i = 0; i < 10; i++) {
    const direct = fs.existsSync(path.join(current, "operator-backend", "src", "allowlist.ts"));
    const apps = fs.existsSync(path.join(current, "apps", "operator-backend", "src", "allowlist.ts"));
    if (direct || apps) return current;
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  throw new Error(`Could not locate RevitOperator repo root from ${startDir}`);
}

function resolveLayout(repoRoot: string): Layout {
  const appsLayout = fs.existsSync(path.join(repoRoot, "apps", "operator-backend", "src", "allowlist.ts"));
  return {
    repoRoot,
    backendRoot: appsLayout ? path.join(repoRoot, "apps", "operator-backend") : path.join(repoRoot, "operator-backend"),
    addinRoot: appsLayout ? path.join(repoRoot, "apps", "revit-bridge-addin") : path.join(repoRoot, "revit-bridge-addin"),
    mcpRoot: appsLayout ? path.join(repoRoot, "apps", "mcp-server") : path.join(repoRoot, "mcp-server")
  };
}

function read(filePath: string): string {
  return fs.readFileSync(filePath, "utf8");
}

function parseAllowlist(filePath: string): Set<ToolKey> {
  const result = new Set<ToolKey>();
  let mode: HttpMethod | null = null;
  for (const rawLine of read(filePath).split(/\r?\n/)) {
    const line = rawLine.trim();
    if (/\bGET\s*:\s*new Set|\{\s*"GET"\s*,\s*new HashSet/.test(line)) mode = "GET";
    if (/\bPOST\s*:\s*new Set|\{\s*"POST"\s*,\s*new HashSet/.test(line)) mode = "POST";
    if (!mode) continue;
    for (const match of line.matchAll(/"(\/(?:revit|ui)\/[^"\s]+)"/g)) {
      const key = toolKey(mode, match[1] ?? "");
      if (key) result.add(key);
    }
  }
  return result;
}

function parseManifest(filePath: string): Map<ToolKey, ManifestTool> {
  const result = new Map<ToolKey, ManifestTool>();
  const text = read(filePath);
  const pattern = /new OperatorToolInfo\(\s*"([^"]+)"\s*,\s*"(GET|POST)"\s*,\s*"([^"]+)"\s*,\s*"([^"]*)"\s*,\s*OperatorActionRisk\.([A-Za-z]+)/g;
  for (const match of text.matchAll(pattern)) {
    const key = toolKey(match[2] ?? "", match[3] ?? "");
    if (!key) continue;
    result.set(key, {
      key,
      group: match[1] ?? "",
      method: (match[2] ?? "GET") as HttpMethod,
      path: match[3] ?? "",
      title: match[4] ?? "",
      risk: (match[5] ?? "").toLowerCase()
    });
  }
  return result;
}

function parseExamples(filePath: string): Map<ToolKey, number> {
  const raw = JSON.parse(read(filePath)) as { tools?: Array<{ method?: string; path?: string; examples?: unknown[] }> };
  const result = new Map<ToolKey, number>();
  for (const item of raw.tools ?? []) {
    const key = toolKey(item.method ?? "GET", item.path ?? "");
    if (key) result.set(key, Array.isArray(item.examples) ? item.examples.length : 0);
  }
  return result;
}

function parseHandlerMap(filePath: string): HandlerMap {
  const result: HandlerMap = new Map();
  for (const match of read(filePath).matchAll(/\{\s*"(\/(?:revit|ui)\/[^"\s]+)"\s*,\s*new\s+([A-Za-z0-9_.]+)/g)) {
    const toolPath = match[1] ?? "";
    const handlers = result.get(toolPath) ?? [];
    handlers.push(match[2] ?? "unknown");
    result.set(toolPath, [...new Set(handlers)].sort());
  }
  return result;
}

function parseComparedPaths(filePath: string, variableName = "path"): Set<string> {
  const result = new Set<string>();
  const escaped = variableName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(`(?:string\\.Equals\\(\\s*${escaped}\\s*,\\s*|${escaped}\\s*==\\s*)"(\\/(?:revit|ui)\\/[^"\\s]+)"`, "g");
  for (const match of read(filePath).matchAll(pattern)) result.add(match[1] ?? "");
  return result;
}

function parseSchemaPaths(filePath: string): { explicit: Set<string>; reflected: Set<string> } {
  const text = read(filePath);
  const reflected = new Set<string>();
  for (const match of text.matchAll(/\{\s*"(\/revit\/[^"\s]+)"\s*,\s*typeof\(/g)) reflected.add(match[1] ?? "");
  const start = text.indexOf("public static object? BuildRequestSchema");
  const end = text.indexOf("public static object? BuildResponseSchema", start);
  const requestBuilder = start >= 0 ? text.slice(start, end >= 0 ? end : undefined) : "";
  const explicit = new Set<string>();
  for (const match of requestBuilder.matchAll(/string\.Equals\(\s*p\s*,\s*"(\/revit\/[^"\s]+)"/g)) explicit.add(match[1] ?? "");
  return { explicit, reflected };
}

function parseMcpWrappers(filePath: string): { byPath: Map<string, string[]>; genericAvailable: boolean } {
  const text = read(filePath);
  const starts = [...text.matchAll(/server\.tool\(\s*"([^"]+)"/g)];
  const byPath = new Map<string, string[]>();
  for (let i = 0; i < starts.length; i++) {
    const match = starts[i]!;
    const name = match[1] ?? "";
    const start = match.index ?? 0;
    const end = i + 1 < starts.length ? (starts[i + 1]!.index ?? text.length) : text.length;
    const block = text.slice(start, end);
    for (const pathMatch of block.matchAll(/callRevit(?:<[^>]+>)?\(\s*"(\/revit\/[^"\s]+)"/g)) {
      const toolPath = pathMatch[1] ?? "";
      const names = byPath.get(toolPath) ?? [];
      names.push(name);
      byPath.set(toolPath, [...new Set(names)].sort());
    }
  }
  return { byPath, genericAvailable: /server\.tool\(\s*"revit_call_tool"/.test(text) };
}

function loadCatalog(layout: Layout): Catalog {
  const addinOperator = path.join(layout.addinRoot, "RevitBridge", "Operator");
  const mcp = parseMcpWrappers(path.join(layout.mcpRoot, "src", "server.ts"));
  const schemas = parseSchemaPaths(path.join(addinOperator, "OperatorToolIntrospection.cs"));
  return {
    manifest: parseManifest(path.join(addinOperator, "OperatorToolManifest.cs")),
    backendAllowlist: parseAllowlist(path.join(layout.backendRoot, "src", "allowlist.ts")),
    addinAllowlist: parseAllowlist(path.join(addinOperator, "OperatorActionAllowlist.cs")),
    examples: parseExamples(path.join(layout.addinRoot, "RevitBridge", "Tooling", "tool_examples.json")),
    actionHandlers: parseHandlerMap(path.join(addinOperator, "OperatorActionRunner.cs")),
    httpHandlers: parseHandlerMap(path.join(layout.addinRoot, "RevitBridge", "Server", "RevitHttpServer.cs")),
    directRunnerPaths: parseComparedPaths(path.join(addinOperator, "OperatorActionRunner.cs")),
    directHttpPaths: parseComparedPaths(path.join(layout.addinRoot, "RevitBridge", "Server", "RevitHttpServer.cs")),
    panePaths: parseComparedPaths(path.join(addinOperator, "OperatorPaneControl.cs")),
    explicitSchemaPaths: schemas.explicit,
    reflectedSchemaPaths: schemas.reflected,
    schemaValidatorPaths: new Set([...read(path.join(addinOperator, "OperatorActionSchemaValidator.cs")).matchAll(/"(\/revit\/[^"\s]+)"/g)].map(match => match[1] ?? "")),
    mcpWrappersByPath: mcp.byPath,
    mcpGenericAvailable: mcp.genericAvailable
  };
}

function liveTools(raw: unknown): Map<ToolKey, Record<string, unknown>> {
  const root = raw && typeof raw === "object" ? raw as Record<string, unknown> : {};
  const tools = Array.isArray(root.tools) ? root.tools : [];
  const result = new Map<ToolKey, Record<string, unknown>>();
  for (const item of tools) {
    if (!item || typeof item !== "object") continue;
    const record = item as Record<string, unknown>;
    const key = toolKey(String(record.Method ?? record.method ?? ""), String(record.Path ?? record.path ?? ""));
    if (key) result.set(key, record);
  }
  return result;
}

function liveProbeEvidence(raw: unknown): LiveProbeEvidence {
  const root = raw && typeof raw === "object" ? raw as Record<string, unknown> : {};
  const rawReceipts = Array.isArray(root.receipts) ? root.receipts : [];
  const receipts: LiveProbeReceipt[] = [];
  for (const item of rawReceipts) {
    if (!item || typeof item !== "object") continue;
    const receipt = item as Record<string, unknown>;
    const key = toolKey(String(receipt.method ?? ""), String(receipt.path ?? ""));
    if (!key) continue;
    receipts.push({
      name: String(receipt.name ?? key),
      key,
      duration_ms: typeof receipt.duration_ms === "number" ? receipt.duration_ms : null,
      transport_ok: receipt.transport_ok === true,
      useful: receipt.useful === true
    });
  }
  return {
    generated_at: typeof root.generated_at === "string" ? root.generated_at : null,
    receipts
  };
}

function compareManifestTool(a: ManifestTool, b: ManifestTool | undefined): boolean {
  return Boolean(b && a.method === b.method && a.path === b.path && a.group === b.group && a.risk === b.risk && a.title === b.title);
}

function summary(rows: ToolAuditRow[]): Record<string, number> {
  return {
    manifest_entries: rows.length,
    advertised: rows.filter(row => row.evidence.advertised === true).length,
    contract_valid: rows.filter(row => row.evidence.contract_valid).length,
    explicit_request_schemas: rows.filter(row => row.contracts.request_schema_source === "explicit").length,
    reflected_schemas_unverified: rows.filter(row => row.issues.includes("reflected_request_schema_unverified")).length,
    generic_schema_only: rows.filter(row => row.issues.includes("generic_request_schema_only")).length,
    missing_action_runtime: rows.filter(row => row.issues.includes("missing_operator_action_runtime")).length,
    missing_http_runtime: rows.filter(row => row.issues.includes("missing_direct_http_runtime")).length,
    typed_mcp: rows.filter(row => row.mcp.typed_tools.length > 0).length,
    generic_mcp_reachable: rows.filter(row => row.mcp.generic_call_available).length,
    live_probed: rows.filter(row => row.live_probes.receipt_count > 0).length,
    live_safe: rows.filter(row => row.evidence.live_safe === true).length,
    live_useful: rows.filter(row => row.evidence.useful === true).length,
    live_probe_failed: rows.filter(row => row.evidence.live_safe === false).length,
    live_probe_not_useful: rows.filter(row => row.evidence.useful === false).length,
    public_parity: rows.filter(row => row.public_parity === true).length,
    with_issues: rows.filter(row => row.issues.length > 0).length
  };
}

export function buildRegistryAudit(options: { repoRoot: string; liveCapabilities?: unknown; liveSource?: string | null; liveProbeReport?: unknown; liveProbeSource?: string | null; compareRepoRoot?: string | null }): ToolRegistryAudit {
  const layout = resolveLayout(options.repoRoot);
  const catalog = loadCatalog(layout);
  const live = options.liveCapabilities === undefined ? null : liveTools(options.liveCapabilities);
  const probeEvidence = options.liveProbeReport === undefined ? { generated_at: null, receipts: [] } : liveProbeEvidence(options.liveProbeReport);
  const probesByKey = new Map<ToolKey, LiveProbeReceipt[]>();
  for (const receipt of probeEvidence.receipts) probesByKey.set(receipt.key, [...(probesByKey.get(receipt.key) ?? []), receipt]);
  const compareCatalog = options.compareRepoRoot ? loadCatalog(resolveLayout(options.compareRepoRoot)) : null;

  const rows: ToolAuditRow[] = [];
  for (const manifest of [...catalog.manifest.values()].sort((a, b) => a.key.localeCompare(b.key))) {
    const examplesCount = catalog.examples.get(manifest.key) ?? 0;
    const actionHandlers = catalog.actionHandlers.get(manifest.path) ?? [];
    const httpHandlers = catalog.httpHandlers.get(manifest.path) ?? [];
    const paneIntercept = catalog.panePaths.has(manifest.path);
    const surfaceKind = manifest.path.startsWith("/ui/") ? "ui_host" : PANE_BACKEND_PATHS.has(manifest.path) ? "pane_backend" : "revit_bridge";
    const runnerRuntime = actionHandlers.length > 0 || catalog.directRunnerPaths.has(manifest.path);
    const httpRuntime = httpHandlers.length > 0 || catalog.directHttpPaths.has(manifest.path);
    const requestSchemaSource = manifest.method === "GET" ? "none" : catalog.explicitSchemaPaths.has(manifest.path) ? "explicit" : catalog.reflectedSchemaPaths.has(manifest.path) ? "reflected" : "generic";
    const schemaSpecific = requestSchemaSource === "explicit" || requestSchemaSource === "reflected" || manifest.method === "GET";
    const schemaVerified = manifest.method === "GET" || requestSchemaSource === "explicit";
    const runtimeValid = surfaceKind === "ui_host" ? true : surfaceKind === "pane_backend" ? paneIntercept : runnerRuntime && httpRuntime;
    const baseContracts = catalog.backendAllowlist.has(manifest.key) && catalog.addinAllowlist.has(manifest.key) && (surfaceKind === "ui_host" || examplesCount > 0);
    const contractValid = baseContracts && runtimeValid && (surfaceKind === "ui_host" || schemaVerified);
    const liveItem = live?.get(manifest.key);
    const liveAdvertised = live === null ? null : Boolean(liveItem);
    const probeReceipts = probesByKey.get(manifest.key) ?? [];
    const liveSafe = probeReceipts.length > 0 ? probeReceipts.every(receipt => receipt.transport_ok) : null;
    const useful = probeReceipts.length > 0 ? probeReceipts.some(receipt => receipt.useful) : null;
    const liveMatches = liveItem
      ? String(liveItem.Group ?? liveItem.group ?? "") === manifest.group && String(liveItem.Risk ?? liveItem.risk ?? "").toLowerCase() === manifest.risk
      : live === null ? null : false;
    const issues: string[] = [];
    if (!catalog.backendAllowlist.has(manifest.key)) issues.push("missing_backend_allowlist");
    if (!catalog.addinAllowlist.has(manifest.key)) issues.push("missing_addin_allowlist");
    if (surfaceKind !== "ui_host" && examplesCount === 0) issues.push("missing_examples");
    if (surfaceKind !== "ui_host" && manifest.method === "POST" && !schemaSpecific) issues.push("generic_request_schema_only");
    if (surfaceKind !== "ui_host" && requestSchemaSource === "reflected") issues.push("reflected_request_schema_unverified");
    if (surfaceKind === "revit_bridge" && !runnerRuntime) issues.push("missing_operator_action_runtime");
    if (surfaceKind === "revit_bridge" && !httpRuntime) issues.push("missing_direct_http_runtime");
    if (surfaceKind === "pane_backend" && !paneIntercept) issues.push("missing_pane_backend_intercept");
    if (surfaceKind === "pane_backend" && catalog.mcpGenericAvailable) issues.push("pane_backend_not_generic_mcp_reachable");
    if (liveAdvertised === false) issues.push("missing_live_advertisement");
    if (liveMatches === false) issues.push("live_metadata_mismatch");
    if (surfaceKind === "revit_bridge" && manifest.path.startsWith("/revit/tool-") && httpHandlers.length > 0 && !catalog.directHttpPaths.has(manifest.path)) issues.push("metadata_routed_through_external_event");

    const compareManifest = compareCatalog?.manifest.get(manifest.key);
    const publicParity = compareCatalog ? compareManifestTool(manifest, compareManifest) : null;
    if (publicParity === false) issues.push("public_manifest_mismatch");

    rows.push({
      key: manifest.key,
      method: manifest.method,
      path: manifest.path,
      group: manifest.group,
      title: manifest.title,
      risk: manifest.risk,
      surface_kind: surfaceKind,
      handlers: { operator_action_runner: actionHandlers, direct_http: httpHandlers, pane_intercept: paneIntercept },
      contracts: {
        backend_allowlisted: catalog.backendAllowlist.has(manifest.key),
        addin_allowlisted: catalog.addinAllowlist.has(manifest.key),
        manifest: true,
        examples_count: examplesCount,
        specific_request_schema: schemaSpecific,
        request_schema_source: requestSchemaSource,
        schema_validator_reference: catalog.schemaValidatorPaths.has(manifest.path)
      },
      mcp: {
        generic_call_available: surfaceKind === "revit_bridge" && catalog.mcpGenericAvailable,
        typed_tools: catalog.mcpWrappersByPath.get(manifest.path) ?? []
      },
      live: { advertised: liveAdvertised, metadata_matches_source: liveMatches },
      public_parity: publicParity,
      evidence: { advertised: liveAdvertised, contract_valid: contractValid, live_safe: liveSafe, useful, quarantined: false },
      live_probes: {
        receipt_count: probeReceipts.length,
        transport_successes: probeReceipts.filter(receipt => receipt.transport_ok).length,
        useful_successes: probeReceipts.filter(receipt => receipt.useful).length,
        names: probeReceipts.map(receipt => receipt.name),
        max_duration_ms: probeReceipts.reduce<number | null>((maximum, receipt) => receipt.duration_ms === null ? maximum : Math.max(maximum ?? 0, receipt.duration_ms), null)
      },
      issues
    });
  }

  const publicRows = compareCatalog ? [...compareCatalog.manifest.values()] : null;
  return {
    version: "revit-operator.tool-registry-audit.v1",
    generated_at: new Date().toISOString(),
    repo_root: layout.repoRoot,
    live_source: options.liveSource ?? null,
    live_probe_source: options.liveProbeSource ?? null,
    live_probe_generated_at: probeEvidence.generated_at,
    summary: summary(rows),
    public_summary: publicRows ? { manifest_entries: publicRows.length, missing_from_private: publicRows.filter(tool => !catalog.manifest.has(tool.key)).length } : null,
    tools: rows
  };
}

function csvEscape(value: unknown): string {
  const text = Array.isArray(value) ? value.join("|") : String(value ?? "");
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export function renderAuditCsv(audit: ToolRegistryAudit): string {
  const headings = ["key", "group", "risk", "surface_kind", "advertised", "contract_valid", "live_safe", "useful", "probe_receipts", "probe_names", "probe_max_ms", "schema_source", "specific_schema", "examples", "action_handlers", "http_handlers", "typed_mcp_tools", "generic_mcp", "public_parity", "issues"];
  const lines = [headings.join(",")];
  for (const row of audit.tools) {
    lines.push([
      row.key, row.group, row.risk, row.surface_kind, row.evidence.advertised, row.evidence.contract_valid, row.evidence.live_safe, row.evidence.useful,
      row.live_probes.receipt_count, row.live_probes.names, row.live_probes.max_duration_ms,
      row.contracts.request_schema_source, row.contracts.specific_request_schema, row.contracts.examples_count, row.handlers.operator_action_runner,
      row.handlers.direct_http, row.mcp.typed_tools, row.mcp.generic_call_available, row.public_parity, row.issues
    ].map(csvEscape).join(","));
  }
  return `${lines.join("\n")}\n`;
}

export function renderAuditMarkdown(audit: ToolRegistryAudit): string {
  const issueCounts = new Map<string, number>();
  for (const row of audit.tools) for (const issue of row.issues) issueCounts.set(issue, (issueCounts.get(issue) ?? 0) + 1);
  const issueLines = [...issueCounts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([issue, count]) => `- ${issue}: ${count}`);
  return [
    "# Revit Operator tool-registry audit",
    "",
    `Generated: ${audit.generated_at}`,
    `Live source: ${audit.live_source ?? "not supplied"}`,
    `Live probe source: ${audit.live_probe_source ?? "not supplied"}`,
    `Live probe generated: ${audit.live_probe_generated_at ?? "not supplied"}`,
    "",
    "## Summary",
    "",
    ...Object.entries(audit.summary).map(([name, count]) => `- ${name}: ${count}`),
    "",
    "## Issue counts",
    "",
    ...(issueLines.length > 0 ? issueLines : ["- none"]),
    "",
    "## Evidence warning",
    "",
    "`contract_valid` is source/contract parity only. `live_safe=true` means every attached bounded read-only receipt completed at the transport layer; it is not write-safety proof. `useful=true` means at least one attached receipt returned the expected structure in the open model. Unprobed tools remain null.",
    ""
  ].join("\n");
}

async function loadLiveCapabilities(): Promise<{ raw: unknown; source: string }> {
  const localAppData = process.env.LOCALAPPDATA;
  if (!localAppData) throw new Error("LOCALAPPDATA is unavailable; cannot discover the live bridge.");
  const bridgeUrl = read(path.join(localAppData, "RevitOperator", "bridge_url.txt")).trim().replace(/\/+$/, "");
  const token = read(path.join(localAppData, "RevitOperator", "Workspace", "operator_token.txt")).trim();
  const response = await fetch(`${bridgeUrl}/revit/capabilities`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-operator-token": token },
    body: "{}",
    signal: AbortSignal.timeout(5_000)
  });
  if (!response.ok) throw new Error(`Live capabilities failed: HTTP ${response.status}`);
  return { raw: await response.json(), source: `${bridgeUrl}/revit/capabilities` };
}

async function runCli(): Promise<void> {
  const args = new Set(process.argv.slice(2));
  const repoRoot = findRepoRoot(process.cwd());
  const compareRepoRoot = fs.existsSync(path.join(repoRoot, "public", "apps", "operator-backend")) ? path.join(repoRoot, "public") : null;
  const live = args.has("--live") ? await loadLiveCapabilities() : null;
  const outputArgIndex = process.argv.indexOf("--output-dir");
  const outputDir = path.resolve(outputArgIndex >= 0 && process.argv[outputArgIndex + 1] ? process.argv[outputArgIndex + 1]! : path.join(repoRoot, "local-work", "tool-registry-audit"));
  const probeArgIndex = process.argv.indexOf("--probe-receipts");
  const defaultProbePath = path.join(outputDir, "live_read_probe_receipts.json");
  const probePath = path.resolve(probeArgIndex >= 0 && process.argv[probeArgIndex + 1] ? process.argv[probeArgIndex + 1]! : defaultProbePath);
  const probeReport = fs.existsSync(probePath) ? JSON.parse(read(probePath)) as unknown : undefined;
  const audit = buildRegistryAudit({ repoRoot, liveCapabilities: live?.raw, liveSource: live?.source, liveProbeReport: probeReport, liveProbeSource: probeReport === undefined ? null : probePath, compareRepoRoot });
  fs.mkdirSync(outputDir, { recursive: true });
  fs.writeFileSync(path.join(outputDir, "tool_registry_audit.json"), `${JSON.stringify(audit, null, 2)}\n`);
  fs.writeFileSync(path.join(outputDir, "tool_registry_audit.csv"), renderAuditCsv(audit));
  fs.writeFileSync(path.join(outputDir, "tool_registry_audit.md"), renderAuditMarkdown(audit));
  console.log(renderAuditMarkdown(audit));
  console.log(`Artifacts: ${outputDir}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runCli().catch(error => {
    console.error(error instanceof Error ? error.stack ?? error.message : String(error));
    process.exitCode = 1;
  });
}
