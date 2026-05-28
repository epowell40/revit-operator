import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ensureWorkspaceLayout } from "../workspace.js";

type CliArgs = {
  inputPath: string;
  outputDir: string;
  bridgeUrl: string;
  tokenOverride: string;
  familyPathFallback: string;
  offline: boolean;
  appendDeterministicHint: boolean;
};

type PromptRow = {
  id: string;
  category: string;
  prompt: string;
  lineNumber: number;
};

type PlaceholderMatch = {
  rawToken: string;
  token: string;
  literal: string;
};

type ResolutionSource = "model" | "generated" | "fallback" | "unresolved";

type PlaceholderResolution = {
  token: string;
  value: string;
  source: ResolutionSource;
  note?: string;
};

type CompiledRow = {
  id: string;
  category: string;
  originalPrompt: string;
  compiledPrompt: string;
  replacements: PlaceholderResolution[];
  unresolvedTokens: string[];
  needsDeterministicHint: boolean;
};

type ToolTypeEntry = {
  id?: number;
  name?: string;
  familyName?: string;
  category?: string;
};

type ModelSnapshot = {
  capturedAt: string;
  bridgeUrl: string;
  online: boolean;
  warnings: string[];
  context: Record<string, unknown> | null;
  views: Array<{ id: number; name: string; type: string }>;
  sheets: Array<{ id: number; sheetNumber: string; name: string }>;
  levels: string[];
  worksets: string[];
  projectParameters: string[];
  schedules: string[];
  printSets: string[];
  revisions: string[];
  typeCatalogs: Record<string, ToolTypeEntry[]>;
};

type PromptIssue = {
  id: string;
  category: string;
  issueCode: string;
  detail: string;
};

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, "..", "..", "..");
const DEFAULT_INPUT_PATH = path.resolve(
  REPO_ROOT,
  "docs",
  "epics",
  "EPIC-0019_task-library-foundation",
  "revit_operator_human_prompts_v0_1 (1).txt"
);
const DEFAULT_OUTPUT_ROOT = path.resolve(REPO_ROOT, "local-work", "epic-0019", "prompt-scrubber");
const DEFAULT_BRIDGE_URL = process.env.REVIT_BRIDGE_URL?.trim() || "http://localhost:5000";

const TYPE_PLACEHOLDER_CATEGORY_MAP: Record<string, string[]> = {
  titleblocktype: ["OST_TitleBlocks"],
  walltype: ["OST_Walls"],
  doortype: ["OST_Doors"],
  windowtype: ["OST_Windows"],
  floortype: ["OST_Floors"],
  ceilingtype: ["OST_Ceilings"],
  rooftype: ["OST_Roofs"],
  railingtype: ["OST_Railings", "OST_StairsRailing"],
  ducttype: ["OST_DuctCurves"],
  equipmenttype: ["OST_MechanicalEquipment"],
  detailitemtype: ["OST_DetailComponents"],
  familytypename: ["OST_MechanicalEquipment", "OST_Doors", "OST_Windows", "OST_DuctAccessory"],
  filledregiontype: ["OST_FilledRegion"],
  viewtitletype: ["OST_ViewportLabel"],
};

const AMBIGUOUS_PATTERNS: RegExp[] = [
  /\bwhere i (specify|indicate|point|click|pick|draw|outline|sketch)\b/i,
  /\bi (specify|provide|pick)\b/i,
  /\bmy selection\b/i,
  /\bthe values i provide\b/i,
  /\bthe sheets i specify\b/i,
  /\bfrom this csv list\b/i,
  /\bwe discussed\b/i,
];

function parseArgs(argv: string[]): CliArgs {
  const out: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] ?? "";
    if (!a.startsWith("--")) continue;
    const key = a.slice(2).trim();
    if (!key) continue;
    const next = argv[i + 1] ?? "";
    if (next && !next.startsWith("--")) {
      out[key] = next;
      i++;
    } else {
      out[key] = true;
    }
  }

  const stamp = makeTimestampForPath(new Date());
  const outputDirRaw =
    typeof out["output-dir"] === "string" && out["output-dir"].trim()
      ? out["output-dir"].trim()
      : path.join(DEFAULT_OUTPUT_ROOT, stamp);

  return {
    inputPath:
      typeof out.input === "string" && out.input.trim() ? path.resolve(out.input.trim()) : DEFAULT_INPUT_PATH,
    outputDir: path.resolve(outputDirRaw),
    bridgeUrl:
      typeof out["bridge-url"] === "string" && out["bridge-url"].trim()
        ? out["bridge-url"].trim()
        : DEFAULT_BRIDGE_URL,
    tokenOverride: typeof out.token === "string" ? out.token.trim() : "",
    familyPathFallback: typeof out["family-path"] === "string" ? out["family-path"].trim() : "",
    offline: Boolean(out.offline),
    appendDeterministicHint: out["no-deterministic-hint"] ? false : true,
  };
}

function makeTimestampForPath(d: Date): string {
  const yyyy = d.getFullYear().toString().padStart(4, "0");
  const mm = (d.getMonth() + 1).toString().padStart(2, "0");
  const dd = d.getDate().toString().padStart(2, "0");
  const hh = d.getHours().toString().padStart(2, "0");
  const min = d.getMinutes().toString().padStart(2, "0");
  const sec = d.getSeconds().toString().padStart(2, "0");
  return `${yyyy}${mm}${dd}_${hh}${min}${sec}`;
}

function readTokenFromWorkspace(): string {
  const fromEnv = process.env.OPERATOR_TOKEN?.trim();
  if (fromEnv) return fromEnv;
  const root = ensureWorkspaceLayout().root;
  const tokenPath = path.join(root, "operator_token.txt");
  try {
    return fs.readFileSync(tokenPath, "utf8").trim();
  } catch {
    return "";
  }
}

function csvEscape(v: string): string {
  const raw = `${v ?? ""}`;
  if (!/[",\r\n]/.test(raw)) return raw;
  return `"${raw.replace(/"/g, "\"\"")}"`;
}

function writeCsv(pathOut: string, headers: string[], rows: Array<Record<string, string>>): void {
  const lines: string[] = [];
  lines.push(headers.map(csvEscape).join(","));
  for (const row of rows) {
    lines.push(headers.map(h => csvEscape(row[h] ?? "")).join(","));
  }
  fs.writeFileSync(pathOut, `${lines.join("\n")}\n`, "utf8");
}

function parsePromptFile(content: string): PromptRow[] {
  const rows: PromptRow[] = [];
  const lines = content.split(/\r?\n/);
  const rx = /^\[(\d{3})\]\s+([A-Z0-9._-]+)\s*::\s*(.+)\s*$/;
  for (let i = 0; i < lines.length; i++) {
    const line = (lines[i] ?? "").trim();
    if (!line) continue;
    const m = line.match(rx);
    if (!m) continue;
    rows.push({
      id: m[1],
      category: m[2],
      prompt: m[3],
      lineNumber: i + 1,
    });
  }
  return rows;
}

function extractPlaceholders(prompt: string): PlaceholderMatch[] {
  const out: PlaceholderMatch[] = [];
  let m: RegExpExecArray | null;

  const curly = /\{([^{}]+)\}/g;
  while ((m = curly.exec(prompt)) !== null) {
    const rawToken = (m[1] ?? "").trim();
    if (!rawToken) continue;
    out.push({ rawToken, token: normalizeToken(rawToken), literal: m[0] });
  }

  const square = /\[([A-Za-z][A-Za-z0-9_. ]*)\]/g;
  while ((m = square.exec(prompt)) !== null) {
    const rawToken = (m[1] ?? "").trim();
    if (!rawToken) continue;
    out.push({ rawToken, token: normalizeToken(rawToken), literal: m[0] });
  }

  return out;
}

function normalizeToken(token: string): string {
  return token.trim().replace(/\s+/g, "").toLowerCase();
}

function uniqueStrings(values: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of values) {
    const v = (raw ?? "").trim();
    if (!v) continue;
    const key = v.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(v);
  }
  return out;
}

function pickFirst(values: string[]): string | null {
  for (const v of values) {
    const clean = `${v ?? ""}`.trim();
    if (clean) return clean;
  }
  return null;
}

function chooseView(snapshot: ModelSnapshot, mode: "any" | "plan" | "3d"): string | null {
  const all = snapshot.views;
  if (all.length === 0) return null;
  if (mode === "plan") {
    const plan = all.find(v => v.type.toLowerCase().includes("plan"));
    if (plan?.name) return plan.name;
  }
  if (mode === "3d") {
    const threeD = all.find(v => v.type.toLowerCase().includes("3d"));
    if (threeD?.name) return threeD.name;
  }
  return all[0]?.name ?? null;
}

function chooseLevel(snapshot: ModelSnapshot, index = 0): string | null {
  if (snapshot.levels.length === 0) return null;
  const bounded = Math.max(0, Math.min(snapshot.levels.length - 1, index));
  return snapshot.levels[bounded] ?? null;
}

function chooseSheet(snapshot: ModelSnapshot): { number: string; name: string } | null {
  const s = snapshot.sheets[0];
  if (!s) return null;
  return { number: s.sheetNumber, name: s.name };
}

function flattenTypeNames(snapshot: ModelSnapshot): string[] {
  const names: string[] = [];
  for (const entries of Object.values(snapshot.typeCatalogs)) {
    for (const e of entries) {
      if (e.name && e.name.trim()) names.push(e.name.trim());
    }
  }
  return uniqueStrings(names);
}

function chooseTypeFromPlaceholder(snapshot: ModelSnapshot, token: string): string | null {
  const categories = TYPE_PLACEHOLDER_CATEGORY_MAP[token] ?? [];
  for (const category of categories) {
    const list = snapshot.typeCatalogs[category] ?? [];
    for (const entry of list) {
      const name = (entry.name ?? "").trim();
      if (name) return name;
    }
  }
  return null;
}

function shouldUseGeneratedName(promptLower: string): boolean {
  return /\b(create|new|duplicate|rename|save as|add)\b/i.test(promptLower);
}

function makeGeneratedName(prefix: string, rowId: string): string {
  return `AI_Test_${prefix}_${rowId}`;
}

function hasAmbiguousLanguage(prompt: string): boolean {
  return AMBIGUOUS_PATTERNS.some(rx => rx.test(prompt));
}

function addDeterministicHintIfNeeded(prompt: string): string {
  return `${prompt} Use deterministic test targets from the active model when selection is ambiguous (prefer active view, otherwise first matching elements).`;
}

function resolvePlaceholderValue(
  token: string,
  row: PromptRow,
  snapshot: ModelSnapshot,
  familyPathFallback: string
): PlaceholderResolution {
  const promptLower = row.prompt.toLowerCase();
  const sheet = chooseSheet(snapshot);
  const level0 = chooseLevel(snapshot, 0);
  const level1 = chooseLevel(snapshot, 1) ?? level0;

  const modelViewAny = chooseView(snapshot, "any");
  const paramName = pickFirst(snapshot.projectParameters) ?? "Comments";
  const scheduleName = pickFirst(snapshot.schedules);
  const worksetName = pickFirst(snapshot.worksets);
  const printSetName = pickFirst(snapshot.printSets);
  const revisionDesc = pickFirst(snapshot.revisions);
  const anyTypeName = pickFirst(flattenTypeNames(snapshot));
  const generatedByPrompt = shouldUseGeneratedName(promptLower);

  const resolve = (value: string | null, source: ResolutionSource, note?: string): PlaceholderResolution => ({
    token,
    value: value ?? "",
    source: value ? source : "unresolved",
    note: value ? note : note ?? "No suitable value found.",
  });

  switch (token) {
    case "viewname":
      return resolve(modelViewAny, "model", "Picked from /revit/views.");
    case "newviewname":
      return resolve(makeGeneratedName("View", row.id), "generated", "Generated deterministic view name.");
    case "draftingviewname":
      return resolve(makeGeneratedName("DraftingView", row.id), "generated");
    case "elevationname":
      return resolve(makeGeneratedName("Elevation", row.id), "generated");
    case "calloutname":
      return resolve(makeGeneratedName("Callout", row.id), "generated");
    case "viewtemplatename": {
      const templated = snapshot.views.find(v => v.name.toLowerCase().includes("template"))?.name ?? null;
      return resolve(templated ?? makeGeneratedName("ViewTemplate", row.id), templated ? "model" : "generated");
    }
    case "sheetnumber":
      return resolve(sheet?.number ?? null, "model", "Picked from /revit/sheets.");
    case "sheetname":
      return resolve(sheet?.name ?? null, "model", "Picked from /revit/sheets.");
    case "levelname":
    case "underlaylevel":
      return resolve(level0, "model", "Picked from /revit/datums.");
    case "levelfrom":
      return resolve(level0, "model", "Picked from /revit/datums.");
    case "levelto":
      return resolve(level1, "model", "Picked from /revit/datums.");
    case "levels":
      return resolve(uniqueStrings([level0 ?? "", level1 ?? ""]).join(", "), "model", "Picked from /revit/datums.");
    case "worksetname":
      return resolve(
        generatedByPrompt ? makeGeneratedName("Workset", row.id) : worksetName,
        generatedByPrompt ? "generated" : "model"
      );
    case "paramname":
    case "parametername":
      return resolve(
        generatedByPrompt ? makeGeneratedName("Param", row.id) : paramName,
        generatedByPrompt ? "generated" : "model"
      );
    case "printsetname":
      return resolve(
        generatedByPrompt ? makeGeneratedName("PrintSet", row.id) : (printSetName ?? makeGeneratedName("PrintSet", row.id)),
        printSetName && !generatedByPrompt ? "model" : "generated"
      );
    case "schedulename":
      return resolve(
        scheduleName ?? makeGeneratedName("Schedule", row.id),
        scheduleName ? "model" : "generated",
        scheduleName ? "Picked from /revit/schedules." : "Generated schedule name."
      );
    case "revisiondesc":
      return resolve(
        revisionDesc ?? `AI test revision ${row.id}`,
        revisionDesc ? "model" : "generated"
      );
    case "titleblocktype":
    case "walltype":
    case "doortype":
    case "windowtype":
    case "floortype":
    case "ceilingtype":
    case "rooftype":
    case "railingtype":
    case "ducttype":
    case "equipmenttype":
    case "familytypename":
    case "filledregiontype":
    case "viewtitletype":
    case "detailitemtype": {
      const modelType = chooseTypeFromPlaceholder(snapshot, token);
      return resolve(modelType ?? anyTypeName, modelType || anyTypeName ? "model" : "unresolved");
    }
    case "familyname":
      return resolve(anyTypeName ?? makeGeneratedName("Family", row.id), anyTypeName ? "model" : "generated");
    case "familypath":
      return resolve(
        familyPathFallback || null,
        familyPathFallback ? "fallback" : "unresolved",
        familyPathFallback ? "Provided via --family-path." : "Requires a real .rfa path on disk."
      );
    case "categoryname":
      return resolve("Doors", "fallback");
    case "rule":
      return resolve("equals", "fallback");
    case "value":
      return resolve(`AI_TEST_VALUE_${row.id}`, "generated");
    case "discipline":
      return resolve("Architectural", "fallback");
    case "detaillevel":
      return resolve("Fine", "fallback");
    case "phase":
    case "phasename":
      return resolve("New Construction", "fallback");
    case "phasefilter":
      return resolve("Show Complete", "fallback");
    case "underlayorientation":
      return resolve("LookDown", "fallback");
    case "text":
      return resolve(`AI test note ${row.id}`, "generated");
    case "find":
      return resolve("OLD", "fallback");
    case "replace":
      return resolve("NEW", "fallback");
    case "prefix":
      return resolve(`AI_${row.id}_`, "generated");
    case "newtypename":
      return resolve(makeGeneratedName("Type", row.id), "generated");
    case "optionset":
      return resolve(makeGeneratedName("OptionSet", row.id), "generated");
    case "optionname":
      return resolve(makeGeneratedName("Option", row.id), "generated");
    case "gridname":
      return resolve(`G-${row.id}`, "generated");
    case "linestylename":
      return resolve(makeGeneratedName("LineStyle", row.id), "generated");
    case "hatchname":
      return resolve("Solid Fill", "fallback");
    case "sweeptype":
      return resolve(makeGeneratedName("Sweep", row.id), "generated");
    case "refplane":
    case "refplanename":
      return resolve("Center (Left/Right)", "fallback");
    case "field":
      return resolve("Name", "fallback");
    case "locationhint":
      return resolve("center", "fallback");
    case "scale":
      return resolve("100", "fallback");
    case "height":
      return resolve("10'-0\"", "fallback");
    case "ceilingheight":
      return resolve("9'-0\"", "fallback");
    case "width":
      return resolve("4'-0\"", "fallback");
    case "spacing":
      return resolve("8'-0\"", "fallback");
    case "elevation":
      return resolve("0'-0\"", "fallback");
    case "maxlength":
      return resolve("20'-0\"", "fallback");
    case "size":
      return resolve("12\"", "fallback");
    case "fromsize":
      return resolve("12\"", "fallback");
    case "tosize":
      return resolve("10\"", "fallback");
    case "thickness":
      return resolve("1\"", "fallback");
    case "count":
      return resolve("3", "fallback");
    case "insulationtype":
      return resolve("Default Duct Insulation", "fallback");
    case "liningtype":
      return resolve("Default Duct Lining", "fallback");
    default:
      if (token.includes("name")) {
        return resolve(makeGeneratedName("Name", row.id), "generated", "Generated generic name.");
      }
      return resolve(null, "unresolved", "No resolver implemented for token.");
  }
}

function replaceTokenLiteral(prompt: string, literal: string, value: string): string {
  return prompt.split(literal).join(value);
}

function compilePrompts(
  rows: PromptRow[],
  snapshot: ModelSnapshot,
  appendDeterministicHint: boolean,
  familyPathFallback: string
): { compiled: CompiledRow[]; issues: PromptIssue[] } {
  const compiled: CompiledRow[] = [];
  const issues: PromptIssue[] = [];

  for (const row of rows) {
    const placeholders = extractPlaceholders(row.prompt);
    const perToken = new Map<string, PlaceholderResolution>();
    let finalPrompt = row.prompt;
    const replacements: PlaceholderResolution[] = [];
    const unresolvedTokens: string[] = [];

    for (const placeholder of placeholders) {
      const existing = perToken.get(placeholder.token);
      const resolved = existing ?? resolvePlaceholderValue(placeholder.token, row, snapshot, familyPathFallback);
      if (!existing) perToken.set(placeholder.token, resolved);
      replacements.push(resolved);

      if (resolved.source === "unresolved") {
        unresolvedTokens.push(placeholder.rawToken);
        issues.push({
          id: row.id,
          category: row.category,
          issueCode: "unresolved_placeholder",
          detail: `${placeholder.rawToken}: ${resolved.note ?? "No value"}`,
        });
        continue;
      }

      finalPrompt = replaceTokenLiteral(finalPrompt, placeholder.literal, resolved.value);
      if (resolved.source === "fallback") {
        issues.push({
          id: row.id,
          category: row.category,
          issueCode: "fallback_value",
          detail: `${placeholder.rawToken} -> ${resolved.value}`,
        });
      }
    }

    const needsDeterministicHint = hasAmbiguousLanguage(finalPrompt);
    if (needsDeterministicHint && appendDeterministicHint) {
      finalPrompt = addDeterministicHintIfNeeded(finalPrompt);
      issues.push({
        id: row.id,
        category: row.category,
        issueCode: "ambiguous_selection_hint_added",
        detail: "Prompt referenced interactive/ambiguous selection phrases.",
      });
    }

    compiled.push({
      id: row.id,
      category: row.category,
      originalPrompt: row.prompt,
      compiledPrompt: finalPrompt,
      replacements,
      unresolvedTokens: uniqueStrings(unresolvedTokens),
      needsDeterministicHint,
    });
  }

  return { compiled, issues };
}

function parseViews(raw: unknown): Array<{ id: number; name: string; type: string }> {
  if (!Array.isArray(raw)) return [];
  const out: Array<{ id: number; name: string; type: string }> = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const obj = item as Record<string, unknown>;
    const id = Number(obj.id);
    const name = `${obj.name ?? ""}`.trim();
    const type = `${obj.type ?? ""}`.trim();
    if (!Number.isFinite(id) || !name) continue;
    out.push({ id, name, type });
  }
  return out;
}

function parseSheets(raw: unknown): Array<{ id: number; sheetNumber: string; name: string }> {
  const rows: Array<{ id: number; sheetNumber: string; name: string }> = [];
  const items = Array.isArray(raw)
    ? raw
    : raw && typeof raw === "object" && Array.isArray((raw as Record<string, unknown>).items)
      ? ((raw as Record<string, unknown>).items as unknown[])
      : [];
  for (const item of items) {
    if (!item || typeof item !== "object") continue;
    const obj = item as Record<string, unknown>;
    const id = Number(obj.id ?? obj.sheetId ?? obj.viewId);
    const sheetNumber = `${obj.sheetNumber ?? ""}`.trim();
    const name = `${obj.name ?? obj.sheetName ?? ""}`.trim();
    if (!Number.isFinite(id) || !sheetNumber || !name) continue;
    rows.push({ id, sheetNumber, name });
  }
  return rows;
}

function parseNameArray(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const names: string[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const obj = item as Record<string, unknown>;
    const name = `${obj.name ?? ""}`.trim();
    if (name) names.push(name);
  }
  return uniqueStrings(names);
}

function parseItemNames(raw: unknown): string[] {
  const items = raw && typeof raw === "object" && Array.isArray((raw as Record<string, unknown>).items)
    ? ((raw as Record<string, unknown>).items as unknown[])
    : [];
  const names: string[] = [];
  for (const item of items) {
    if (!item || typeof item !== "object") continue;
    const obj = item as Record<string, unknown>;
    const name = `${obj.name ?? obj.sheetName ?? obj.description ?? obj.number ?? ""}`.trim();
    if (name) names.push(name);
  }
  return uniqueStrings(names);
}

function parseTypeEntries(raw: unknown): ToolTypeEntry[] {
  if (!Array.isArray(raw)) return [];
  const out: ToolTypeEntry[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const obj = item as Record<string, unknown>;
    out.push({
      id: typeof obj.id === "number" ? obj.id : undefined,
      name: typeof obj.name === "string" ? obj.name : undefined,
      familyName: typeof obj.familyName === "string" ? obj.familyName : undefined,
      category: typeof obj.category === "string" ? obj.category : undefined,
    });
  }
  return out;
}

function requestJson(
  urlString: string,
  method: "GET" | "POST",
  headers: Record<string, string>,
  body?: Record<string, unknown>
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const url = new URL(urlString);
    const payload = body ? JSON.stringify(body) : "";

    const req = http.request(
      {
        protocol: url.protocol,
        hostname: url.hostname,
        port: url.port,
        path: `${url.pathname}${url.search}`,
        method,
        headers: {
          ...headers,
          ...(body ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload).toString() } : {}),
        },
      },
      res => {
        const chunks: Buffer[] = [];
        res.on("data", chunk => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          const statusCode = res.statusCode ?? 0;
          if (statusCode < 200 || statusCode >= 300) {
            reject(new Error(`HTTP ${statusCode} for ${url.pathname}: ${text.slice(0, 400)}`));
            return;
          }
          if (!text.trim()) {
            resolve({});
            return;
          }
          try {
            resolve(JSON.parse(text));
          } catch (err) {
            reject(new Error(`Failed to parse JSON from ${url.pathname}: ${(err as Error).message}`));
          }
        });
      }
    );

    req.setTimeout(15000, () => req.destroy(new Error(`Timeout requesting ${url.pathname}`)));
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

async function safeBridgeCall(
  bridgeUrl: string,
  token: string,
  method: "GET" | "POST",
  endpoint: string,
  body?: Record<string, unknown>
): Promise<{ ok: true; data: unknown } | { ok: false; error: string }> {
  try {
    const headers: Record<string, string> = token ? { "X-Operator-Token": token } : {};
    const data = await requestJson(`${bridgeUrl}${endpoint}`, method, headers, body);
    return { ok: true, data };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}

async function collectSnapshot(bridgeUrl: string, token: string, offline: boolean): Promise<ModelSnapshot> {
  const snapshot: ModelSnapshot = {
    capturedAt: new Date().toISOString(),
    bridgeUrl,
    online: false,
    warnings: [],
    context: null,
    views: [],
    sheets: [],
    levels: [],
    worksets: [],
    projectParameters: [],
    schedules: [],
    printSets: [],
    revisions: [],
    typeCatalogs: {},
  };

  if (offline) {
    snapshot.warnings.push("Offline mode enabled: skipped live model snapshot.");
    return snapshot;
  }
  if (!token) {
    snapshot.warnings.push("No operator token found. Set OPERATOR_TOKEN or ensure workspace token file exists.");
    return snapshot;
  }

  const [
    contextRes,
    viewsRes,
    sheetsRes,
    levelsRes,
    schedulesRes,
    printSetsRes,
    revisionsRes,
  ] = await Promise.all([
    safeBridgeCall(bridgeUrl, token, "GET", "/revit/context"),
    safeBridgeCall(bridgeUrl, token, "GET", "/revit/views"),
    safeBridgeCall(bridgeUrl, token, "POST", "/revit/sheets", { action: "list", all: true, limit: 500 }),
    safeBridgeCall(bridgeUrl, token, "POST", "/revit/query", { category: "OST_Levels", limit: 500 }),
    safeBridgeCall(bridgeUrl, token, "POST", "/revit/schedules", { action: "list", max: 500 }),
    safeBridgeCall(bridgeUrl, token, "POST", "/revit/print-sets", { action: "list", max: 500 }),
    safeBridgeCall(bridgeUrl, token, "POST", "/revit/revisions", { max: 500 }),
  ]);

  const calls: Array<[string, { ok: true; data: unknown } | { ok: false; error: string }]> = [
    ["/revit/context", contextRes],
    ["/revit/views", viewsRes],
    ["/revit/sheets", sheetsRes],
    ["/revit/query(OST_Levels)", levelsRes],
    ["/revit/schedules", schedulesRes],
    ["/revit/print-sets", printSetsRes],
    ["/revit/revisions", revisionsRes],
  ];
  for (const [endpoint, result] of calls) {
    if (!result.ok) snapshot.warnings.push(`${endpoint} failed: ${result.error}`);
  }

  if (contextRes.ok && contextRes.data && typeof contextRes.data === "object") {
    snapshot.context = contextRes.data as Record<string, unknown>;
  }
  if (viewsRes.ok) snapshot.views = parseViews(viewsRes.data);
  if (sheetsRes.ok) snapshot.sheets = parseSheets(sheetsRes.data);
  if (levelsRes.ok) snapshot.levels = parseNameArray(levelsRes.data);
  if (schedulesRes.ok) snapshot.schedules = parseItemNames(schedulesRes.data);
  if (printSetsRes.ok) snapshot.printSets = parseItemNames(printSetsRes.data);
  if (revisionsRes.ok) snapshot.revisions = parseItemNames(revisionsRes.data);

  const neededCategories = uniqueStrings(Object.values(TYPE_PLACEHOLDER_CATEGORY_MAP).flat());
  const categoryCalls = await Promise.all(
    neededCategories.map(async category => {
      const result = await safeBridgeCall(bridgeUrl, token, "POST", "/revit/list-element-types", { category, limit: 200 });
      return { category, result };
    })
  );
  for (const { category, result } of categoryCalls) {
    if (!result.ok) {
      snapshot.warnings.push(`/revit/list-element-types (${category}) failed: ${result.error}`);
      snapshot.typeCatalogs[category] = [];
      continue;
    }
    snapshot.typeCatalogs[category] = parseTypeEntries(result.data);
  }

  snapshot.online = snapshot.warnings.length === 0 || snapshot.views.length > 0 || snapshot.sheets.length > 0;
  return snapshot;
}

function renderCompiledPromptText(rows: CompiledRow[]): string {
  const lines: string[] = [];
  lines.push("Revit Operator Compiled Prompts");
  lines.push("");
  lines.push("Format: [###] CATEGORY :: USER PROMPT");
  lines.push("");
  for (const row of rows) {
    lines.push(`[${row.id}] ${row.category} :: ${row.compiledPrompt}`);
  }
  lines.push("");
  return lines.join("\n");
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  if (!fs.existsSync(args.inputPath)) {
    throw new Error(`Prompt file not found: ${args.inputPath}`);
  }
  fs.mkdirSync(args.outputDir, { recursive: true });

  const token = args.tokenOverride || readTokenFromWorkspace();
  const promptFile = fs.readFileSync(args.inputPath, "utf8");
  const promptRows = parsePromptFile(promptFile);
  if (promptRows.length === 0) {
    throw new Error(`No prompt rows found in ${args.inputPath}. Expected lines like [001] CATEGORY :: PROMPT`);
  }

  const snapshot = await collectSnapshot(args.bridgeUrl, token, args.offline);
  const { compiled, issues } = compilePrompts(
    promptRows,
    snapshot,
    args.appendDeterministicHint,
    args.familyPathFallback
  );

  const compiledCsvPath = path.join(args.outputDir, "compiled_prompts.csv");
  const compiledTxtPath = path.join(args.outputDir, "compiled_prompts.txt");
  const issuesCsvPath = path.join(args.outputDir, "prompt_issues.csv");
  const snapshotPath = path.join(args.outputDir, "model_snapshot.json");
  const summaryPath = path.join(args.outputDir, "summary.md");

  writeCsv(
    compiledCsvPath,
    [
      "id",
      "category",
      "original_prompt",
      "compiled_prompt",
      "replacement_count",
      "replacements",
      "unresolved_placeholders",
      "deterministic_hint_added",
    ],
    compiled.map(row => ({
      id: row.id,
      category: row.category,
      original_prompt: row.originalPrompt,
      compiled_prompt: row.compiledPrompt,
      replacement_count: String(row.replacements.length),
      replacements: row.replacements
        .map(r => `${r.token}=${r.value} (${r.source}${r.note ? `: ${r.note}` : ""})`)
        .join(" | "),
      unresolved_placeholders: row.unresolvedTokens.join("; "),
      deterministic_hint_added: row.needsDeterministicHint ? "true" : "false",
    }))
  );

  fs.writeFileSync(compiledTxtPath, renderCompiledPromptText(compiled), "utf8");

  writeCsv(
    issuesCsvPath,
    ["id", "category", "issue_code", "detail"],
    issues.map(issue => ({
      id: issue.id,
      category: issue.category,
      issue_code: issue.issueCode,
      detail: issue.detail,
    }))
  );

  fs.writeFileSync(snapshotPath, `${JSON.stringify(snapshot, null, 2)}\n`, "utf8");

  const unresolvedCount = compiled.reduce((acc, row) => acc + row.unresolvedTokens.length, 0);
  const hintCount = compiled.filter(row => row.needsDeterministicHint).length;
  const fallbackCount = issues.filter(i => i.issueCode === "fallback_value").length;
  const summaryLines = [
    "# Prompt Scrubber Summary",
    "",
    `- Generated: ${new Date().toISOString()}`,
    `- Input: ${args.inputPath}`,
    `- Output Dir: ${args.outputDir}`,
    `- Prompts parsed: ${promptRows.length}`,
    `- Unresolved placeholders: ${unresolvedCount}`,
    `- Fallback values used: ${fallbackCount}`,
    `- Deterministic hints added: ${hintCount}`,
    `- Snapshot online: ${snapshot.online ? "yes" : "no"}`,
    `- Snapshot warnings: ${snapshot.warnings.length}`,
    "",
    "## Artifacts",
    `- compiled prompts (CSV): ${compiledCsvPath}`,
    `- compiled prompts (TXT): ${compiledTxtPath}`,
    `- prompt issues (CSV): ${issuesCsvPath}`,
    `- model snapshot (JSON): ${snapshotPath}`,
    "",
  ];
  if (snapshot.warnings.length > 0) {
    summaryLines.push("## Snapshot Warnings");
    for (const warning of snapshot.warnings) {
      summaryLines.push(`- ${warning}`);
    }
    summaryLines.push("");
  }
  fs.writeFileSync(summaryPath, `${summaryLines.join("\n")}\n`, "utf8");

  console.log("Prompt scrub complete.");
  console.log(`Output directory: ${args.outputDir}`);
  console.log(`Prompts parsed: ${promptRows.length}`);
  console.log(`Unresolved placeholders: ${unresolvedCount}`);
  console.log(`Fallback values used: ${fallbackCount}`);
  if (snapshot.warnings.length > 0) {
    console.log(`Snapshot warnings (${snapshot.warnings.length}):`);
    for (const warning of snapshot.warnings.slice(0, 10)) {
      console.log(`- ${warning}`);
    }
  }
}

main().catch(err => {
  console.error(`prompt scrub failed: ${(err as Error).message}`);
  process.exitCode = 1;
});
