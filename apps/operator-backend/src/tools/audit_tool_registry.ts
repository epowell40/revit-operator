import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { assertExactDevelopmentLaboratoryNativeTransport } from "../brains/native_revit_transport.js";

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

type ReconciliationReference = {
  source: string;
  key: string;
};

export type ToolRegistryReconciliation = {
  source_counts: Record<string, number>;
  orphan_references: ReconciliationReference[];
  duplicate_manifest_keys: Array<{ key: ToolKey; occurrences: number }>;
  method_variant_paths: Array<{ path: string; keys: ToolKey[]; risks: string[] }>;
  shared_handler_aliases: Array<{ handler: string; paths: string[]; keys: ToolKey[]; risks: string[] }>;
  control_plane_external_event_routes: ToolKey[];
  private_only_manifest_keys: ToolKey[];
  public_only_manifest_keys: ToolKey[];
};

const PANE_BACKEND_PATHS = new Set([
  "/revit/batch-control",
  "/revit/batch-job",
  "/revit/capture-screenshare"
]);

const CONTROL_PLANE_PATHS = new Set([
  "/revit/capabilities",
  "/revit/native-api-catalog",
  "/revit/native-api-policy",
  "/revit/native-api-search",
  "/revit/ping",
  "/revit/tool-doc",
  "/revit/tool-examples",
  "/revit/tool-registry",
  "/revit/tool-search",
  "/revit/write-grant-status"
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
  reconciliation: ToolRegistryReconciliation;
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
  manifestOccurrences: Map<ToolKey, number>;
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
  mcpWrappersByKey: Map<ToolKey, string[]>;
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

function parseManifest(filePath: string): { tools: Map<ToolKey, ManifestTool>; occurrences: Map<ToolKey, number> } {
  const result = new Map<ToolKey, ManifestTool>();
  const occurrences = new Map<ToolKey, number>();
  const text = read(filePath);
  const pattern = /new OperatorToolInfo\(\s*"([^"]+)"\s*,\s*"(GET|POST)"\s*,\s*"([^"]+)"\s*,\s*"([^"]*)"\s*,\s*OperatorActionRisk\.([A-Za-z]+)/g;
  for (const match of text.matchAll(pattern)) {
    const key = toolKey(match[2] ?? "", match[3] ?? "");
    if (!key) continue;
    occurrences.set(key, (occurrences.get(key) ?? 0) + 1);
    result.set(key, {
      key,
      group: match[1] ?? "",
      method: (match[2] ?? "GET") as HttpMethod,
      path: match[3] ?? "",
      title: match[4] ?? "",
      risk: (match[5] ?? "").toLowerCase()
    });
  }
  return { tools: result, occurrences };
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

type SourceFunction = { body: string };

function findBalancedEnd(text: string, openIndex: number, open = "(", close = ")"): number {
  let depth = 0;
  let quote: "\"" | "'" | "`" | null = null;
  let lineComment = false;
  let blockComment = false;
  for (let index = openIndex; index < text.length; index++) {
    const character = text[index]!;
    const next = text[index + 1] ?? "";
    if (lineComment) {
      if (character === "\n") lineComment = false;
      continue;
    }
    if (blockComment) {
      if (character === "*" && next === "/") { blockComment = false; index++; }
      continue;
    }
    if (quote) {
      if (character === "\\") { index++; continue; }
      if (character === quote) quote = null;
      continue;
    }
    if (character === "/" && next === "/") { lineComment = true; index++; continue; }
    if (character === "/" && next === "*") { blockComment = true; index++; continue; }
    if (character === "\"" || character === "'" || character === "`") { quote = character; continue; }
    if (character === open) depth++;
    if (character === close && --depth === 0) return index + 1;
  }
  return text.length;
}

function splitTopLevelArguments(callText: string): string[] {
  const openIndex = callText.indexOf("(");
  if (openIndex < 0) return [];
  const body = callText.slice(openIndex + 1, -1);
  const result: string[] = [];
  let start = 0;
  let round = 0;
  let square = 0;
  let curly = 0;
  let quote: "\"" | "'" | "`" | null = null;
  for (let index = 0; index < body.length; index++) {
    const character = body[index]!;
    if (quote) {
      if (character === "\\") { index++; continue; }
      if (character === quote) quote = null;
      continue;
    }
    if (character === "\"" || character === "'" || character === "`") { quote = character; continue; }
    if (character === "(") round++;
    else if (character === ")") round--;
    else if (character === "[") square++;
    else if (character === "]") square--;
    else if (character === "{") curly++;
    else if (character === "}") curly--;
    else if (character === "," && round === 0 && square === 0 && curly === 0) {
      result.push(body.slice(start, index).trim());
      start = index + 1;
    }
  }
  result.push(body.slice(start).trim());
  return result;
}

function sourceFiles(root: string): string[] {
  const result: string[] = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const fullPath = path.join(root, entry.name);
    if (entry.isDirectory()) result.push(...sourceFiles(fullPath));
    else if (entry.isFile() && entry.name.endsWith(".ts")) result.push(fullPath);
  }
  return result.sort((a, b) => a.localeCompare(b));
}

function sourceFunctions(texts: string[]): Map<string, SourceFunction> {
  const result = new Map<string, SourceFunction>();
  for (const text of texts) {
    for (const match of text.matchAll(/(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(/g)) {
      const name = match[1] ?? "";
      const parametersOpen = text.indexOf("(", match.index ?? 0);
      const parametersEnd = findBalancedEnd(text, parametersOpen);
      const bodyOpen = text.indexOf("{", parametersEnd);
      if (bodyOpen < 0) continue;
      result.set(name, { body: text.slice(bodyOpen, findBalancedEnd(text, bodyOpen, "{", "}")) });
    }
  }
  return result;
}

function literalObjectNames(texts: string[]): Map<string, string[]> {
  const result = new Map<string, string[]>();
  for (const text of texts) {
    for (const match of text.matchAll(/(?:export\s+)?const\s+([A-Za-z_$][\w$]*)\s*=\s*([\[{])/g)) {
      const variable = match[1] ?? "";
      const open = (match.index ?? 0) + match[0].lastIndexOf(match[2] ?? "");
      const close = match[2] === "[" ? "]" : "}";
      const initializer = text.slice(open, findBalancedEnd(text, open, match[2] ?? "[", close));
      const names = [...initializer.matchAll(/\bname\s*:\s*["']([^"']+)["']/g)].map(item => item[1] ?? "");
      if (names.length > 0) result.set(variable, sortedUnique(names));
    }
  }
  return result;
}

function callRevitKeys(text: string): ToolKey[] {
  const result: ToolKey[] = [];
  for (const match of text.matchAll(/\bcallRevit\b/g)) {
    let cursor = (match.index ?? 0) + match[0].length;
    while (/\s/.test(text[cursor] ?? "")) cursor++;
    if (text[cursor] === "<") {
      let depth = 0;
      while (cursor < text.length) {
        if (text[cursor] === "<") depth++;
        else if (text[cursor] === ">" && --depth === 0) { cursor++; break; }
        cursor++;
      }
      while (/\s/.test(text[cursor] ?? "")) cursor++;
    }
    if (text[cursor] !== "(") continue;
    const args = splitTopLevelArguments(text.slice(cursor, findBalancedEnd(text, cursor)));
    const toolPath = args[0]?.match(/^["'](\/revit\/[^"'\s]+)["']$/)?.[1] ?? "";
    const method = args[1]?.match(/^["'](GET|POST)["']$/)?.[1] ?? "GET";
    const key = toolKey(method, toolPath);
    if (key) result.push(key);
  }
  return [...new Set(result)].sort((a, b) => a.localeCompare(b));
}

function reachableCallRevitKeys(text: string, functions: Map<string, SourceFunction>, visited = new Set<string>()): ToolKey[] {
  const result = new Set<ToolKey>(callRevitKeys(text));
  const calledNames = [...text.matchAll(/\b([A-Za-z_$][\w$]*)\s*\(/g)].map(match => match[1] ?? "");
  const referencedFunction = text.trim().match(/^([A-Za-z_$][\w$]*)$/)?.[1];
  if (referencedFunction) calledNames.push(referencedFunction);
  for (const name of calledNames) {
    if (visited.has(name)) continue;
    const target = functions.get(name);
    if (!target) continue;
    const nextVisited = new Set(visited);
    nextVisited.add(name);
    for (const key of reachableCallRevitKeys(target.body, functions, nextVisited)) result.add(key);
  }
  return [...result].sort((a, b) => a.localeCompare(b));
}

function parseMcpWrappers(mcpRoot: string): { byKey: Map<ToolKey, string[]>; genericAvailable: boolean } {
  const serverPath = path.join(mcpRoot, "src", "server.ts");
  const serverText = read(serverPath);
  const texts = sourceFiles(path.join(mcpRoot, "src")).map(read);
  const serverFunctions = sourceFunctions([serverText]);
  const allFunctions = sourceFunctions(texts);
  const objectNames = literalObjectNames(texts);
  const byKey = new Map<ToolKey, string[]>();
  const add = (name: string, keys: Iterable<ToolKey>) => {
    if (!name) return;
    for (const key of keys) byKey.set(key, sortedUnique([...(byKey.get(key) ?? []), name]));
  };

  const registrationPattern = /\b(?:server\s*\.\s*(?:tool|registerTool)|registerAuditedZodTool)\s*\(/g;
  for (const match of serverText.matchAll(registrationPattern)) {
    const open = serverText.indexOf("(", match.index ?? 0);
    const callText = serverText.slice(match.index ?? 0, findBalancedEnd(serverText, open));
    const args = splitTopLevelArguments(callText);
    const literalName = args[0]?.match(/^["']([^"']+)["']$/)?.[1];
    // The generic dispatcher reads the registry as an implementation detail; it is
    // deliberately represented by generic_call_available, not as a typed wrapper.
    if (literalName && literalName !== "revit_call_tool") add(literalName, reachableCallRevitKeys(args.at(-1) ?? callText, serverFunctions));
  }

  // Audited registrations may use imported metadata objects rather than a literal name.
  for (const match of serverText.matchAll(/\bregisterAuditedZodTool\s*\(\s*([A-Za-z_$][\w$]*)\.name\s*,/g)) {
    const open = serverText.indexOf("(", match.index ?? 0);
    const callText = serverText.slice(match.index ?? 0, findBalancedEnd(serverText, open));
    const keys = reachableCallRevitKeys(splitTopLevelArguments(callText).at(-1) ?? callText, allFunctions);
    for (const name of objectNames.get(match[1] ?? "") ?? []) add(name, keys);
  }

  // Resolve literal metadata arrays used by audited dynamic registration loops.
  for (const match of serverText.matchAll(/\b([A-Za-z_$][\w$]*)\.forEach\s*\(\s*([A-Za-z_$][\w$]*)\s*=>/g)) {
    const collection = match[1] ?? "";
    const item = match[2] ?? "";
    const open = serverText.indexOf("(", match.index ?? 0);
    const loopText = serverText.slice(match.index ?? 0, findBalancedEnd(serverText, open));
    if (!new RegExp(`\\bregisterAuditedZodTool\\s*\\(\\s*${item}\\.name\\s*,`).test(loopText)) continue;
    const keys = reachableCallRevitKeys(loopText, allFunctions);
    for (const name of objectNames.get(collection) ?? []) add(name, keys);
  }

  return { byKey, genericAvailable: /server\s*\.\s*tool\s*\(\s*["']revit_call_tool["']/.test(serverText) };
}

/** SHA-256 over UTF-8 bytes after CRLF and lone CR are normalized to LF. */
export function canonicalRegistryDigestSha256(source: string): string {
  return createHash("sha256").update(source.replace(/\r\n?/g, "\n"), "utf8").digest("hex").toUpperCase();
}

function loadCatalog(layout: Layout): Catalog {
  const addinOperator = path.join(layout.addinRoot, "RevitBridge", "Operator");
  const mcp = parseMcpWrappers(layout.mcpRoot);
  const schemas = parseSchemaPaths(path.join(addinOperator, "OperatorToolIntrospection.cs"));
  const manifest = parseManifest(path.join(addinOperator, "OperatorToolManifest.cs"));
  return {
    manifest: manifest.tools,
    manifestOccurrences: manifest.occurrences,
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
    mcpWrappersByKey: mcp.byKey,
    mcpGenericAvailable: mcp.genericAvailable
  };
}

function sortedUnique(values: Iterable<string>): string[] {
  return [...new Set(values)].sort((a, b) => a.localeCompare(b));
}

function buildReconciliation(
  catalog: Catalog,
  live: Map<ToolKey, Record<string, unknown>> | null,
  compareCatalog: Catalog | null
): ToolRegistryReconciliation {
  const manifestKeys = new Set(catalog.manifest.keys());
  const manifestPaths = new Set([...catalog.manifest.values()].map(tool => tool.path));
  const orphanReferences: ReconciliationReference[] = [];
  const addKeyReferences = (source: string, keys: Iterable<ToolKey>) => {
    for (const key of keys) if (!manifestKeys.has(key)) orphanReferences.push({ source, key });
  };
  const addPathReferences = (source: string, paths: Iterable<string>) => {
    for (const toolPath of paths) if (!manifestPaths.has(toolPath)) orphanReferences.push({ source, key: toolPath });
  };

  addKeyReferences("backend_allowlist", catalog.backendAllowlist);
  addKeyReferences("addin_allowlist", catalog.addinAllowlist);
  addKeyReferences("examples", catalog.examples.keys());
  addPathReferences("operator_action_runner", catalog.actionHandlers.keys());
  addPathReferences("direct_http", catalog.httpHandlers.keys());
  addPathReferences("operator_action_direct_path", catalog.directRunnerPaths);
  addPathReferences("direct_http_path", catalog.directHttpPaths);
  addPathReferences("pane_intercept", catalog.panePaths);
  addPathReferences("explicit_request_schema", catalog.explicitSchemaPaths);
  addPathReferences("reflected_request_schema", catalog.reflectedSchemaPaths);
  addPathReferences("schema_validator", catalog.schemaValidatorPaths);
  addKeyReferences("typed_mcp_wrapper", catalog.mcpWrappersByKey.keys());
  if (live) addKeyReferences("live_advertisement", live.keys());

  const byPath = new Map<string, ManifestTool[]>();
  for (const tool of catalog.manifest.values()) byPath.set(tool.path, [...(byPath.get(tool.path) ?? []), tool]);
  const methodVariantPaths = [...byPath.entries()]
    .filter(([, tools]) => tools.length > 1)
    .map(([toolPath, tools]) => ({
      path: toolPath,
      keys: tools.map(tool => tool.key).sort((a, b) => a.localeCompare(b)),
      risks: sortedUnique(tools.map(tool => tool.risk))
    }))
    .sort((a, b) => a.path.localeCompare(b.path));

  const handlerPaths = new Map<string, Set<string>>();
  for (const [toolPath, handlers] of catalog.actionHandlers) {
    for (const handler of handlers) {
      const paths = handlerPaths.get(handler) ?? new Set<string>();
      paths.add(toolPath);
      handlerPaths.set(handler, paths);
    }
  }
  const sharedHandlerAliases = [...handlerPaths.entries()]
    .filter(([, paths]) => paths.size > 1)
    .map(([handler, paths]) => {
      const aliasPaths = sortedUnique(paths);
      const tools = aliasPaths.flatMap(toolPath => byPath.get(toolPath) ?? []);
      return {
        handler,
        paths: aliasPaths,
        keys: tools.map(tool => tool.key).sort((a, b) => a.localeCompare(b)),
        risks: sortedUnique(tools.map(tool => tool.risk))
      };
    })
    .sort((a, b) => a.handler.localeCompare(b.handler));

  const controlPlaneExternalEventRoutes = [...catalog.manifest.values()]
    .filter(tool => CONTROL_PLANE_PATHS.has(tool.path))
    .filter(tool => {
      const actionRuntime = (catalog.actionHandlers.get(tool.path) ?? []).length > 0;
      return actionRuntime && !catalog.directRunnerPaths.has(tool.path);
    })
    .map(tool => tool.key)
    .sort((a, b) => a.localeCompare(b));

  const compareKeys = new Set(compareCatalog?.manifest.keys() ?? []);
  const privateOnly = compareCatalog ? [...manifestKeys].filter(key => !compareKeys.has(key)).sort((a, b) => a.localeCompare(b)) : [];
  const publicOnly = compareCatalog ? [...compareKeys].filter(key => !manifestKeys.has(key)).sort((a, b) => a.localeCompare(b)) : [];
  const duplicateManifestKeys = [...catalog.manifestOccurrences.entries()]
    .filter(([, occurrences]) => occurrences > 1)
    .map(([key, occurrences]) => ({ key, occurrences }))
    .sort((a, b) => a.key.localeCompare(b.key));
  const operatorActionPaths = new Set([...catalog.actionHandlers.keys(), ...catalog.directRunnerPaths]);
  const directHttpPaths = new Set([...catalog.httpHandlers.keys(), ...catalog.directHttpPaths]);

  orphanReferences.sort((a, b) => a.source.localeCompare(b.source) || a.key.localeCompare(b.key));
  return {
    source_counts: {
      manifest: catalog.manifest.size,
      backend_allowlist: catalog.backendAllowlist.size,
      addin_allowlist: catalog.addinAllowlist.size,
      examples: catalog.examples.size,
      operator_action_paths: operatorActionPaths.size,
      direct_http_paths: directHttpPaths.size,
      explicit_request_schema_paths: catalog.explicitSchemaPaths.size,
      reflected_request_schema_paths: catalog.reflectedSchemaPaths.size,
      schema_validator_paths: catalog.schemaValidatorPaths.size,
      typed_mcp_paths: new Set([...catalog.mcpWrappersByKey.keys()].map(key => key.slice(key.indexOf(" ") + 1))).size,
      typed_mcp_keys: catalog.mcpWrappersByKey.size,
      live_advertisements: live?.size ?? 0,
      compare_manifest: compareCatalog?.manifest.size ?? 0
    },
    orphan_references: orphanReferences,
    duplicate_manifest_keys: duplicateManifestKeys,
    method_variant_paths: methodVariantPaths,
    shared_handler_aliases: sharedHandlerAliases,
    control_plane_external_event_routes: controlPlaneExternalEventRoutes,
    private_only_manifest_keys: privateOnly,
    public_only_manifest_keys: publicOnly
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
  const reconciliation = buildReconciliation(catalog, live, compareCatalog);

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
        typed_tools: catalog.mcpWrappersByKey.get(manifest.key) ?? []
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
    reconciliation,
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
  const aliasLines = audit.reconciliation.shared_handler_aliases.map(alias => `- ${alias.handler}: ${alias.keys.join(" | ")}${alias.risks.length > 1 ? ` (risk variance: ${alias.risks.join(", ")})` : ""}`);
  const methodVariantLines = audit.reconciliation.method_variant_paths.map(alias => `- ${alias.path}: ${alias.keys.join(" | ")}${alias.risks.length > 1 ? ` (risk variance: ${alias.risks.join(", ")})` : ""}`);
  const orphanLines = audit.reconciliation.orphan_references.map(item => `- ${item.source}: ${item.key}`);
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
    "## Cross-surface reconciliation",
    "",
    `- orphan source references: ${audit.reconciliation.orphan_references.length}`,
    `- duplicate manifest keys: ${audit.reconciliation.duplicate_manifest_keys.length}`,
    `- private-only manifest keys: ${audit.reconciliation.private_only_manifest_keys.length}`,
    `- public-only manifest keys: ${audit.reconciliation.public_only_manifest_keys.length}`,
    `- control-plane routes still using ExternalEvent: ${audit.reconciliation.control_plane_external_event_routes.length}`,
    "",
    "### Method variants",
    "",
    ...(methodVariantLines.length > 0 ? methodVariantLines : ["- none"]),
    "",
    "### Shared-handler aliases",
    "",
    ...(aliasLines.length > 0 ? aliasLines : ["- none"]),
    "",
    "### Orphan references",
    "",
    ...(orphanLines.length > 0 ? orphanLines : ["- none"]),
    "",
    "## Evidence warning",
    "",
    "`contract_valid` is source/contract parity only. `live_safe=true` means every attached bounded read-only receipt completed at the transport layer; it is not write-safety proof. `useful=true` means at least one attached receipt returned the expected structure in the open model. Unprobed tools remain null.",
    ""
  ].join("\n");
}

async function loadLiveCapabilities(): Promise<{ raw: unknown; source: string }> {
  assertExactDevelopmentLaboratoryNativeTransport(process.env, "Tool registry audit raw Revit transport");
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
