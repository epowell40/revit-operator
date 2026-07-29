import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import * as fs from "fs";
import * as path from "path";
import * as xlsx from "xlsx";
import mammoth from "mammoth";
import { createRequire } from "module";

xlsx.set_fs(fs);
import { callRevit } from "./lib/revitClient.js";
import { countSheetsViaSafeRead } from "./lib/safeReadClient.js";
import { getWorkspaceRoot, resolveExistingFileUnderWorkspace, resolveFileUnderWorkspace } from "./lib/workspace.js";
import { auditLog, summarize } from "./lib/audit.js";
import {
  mergePdfsUnderWorkspaceArtifacts,
  renameFileUnderWorkspaceArtifacts,
  reorderPdfUnderWorkspaceArtifacts,
  resolveExistingPathUnderWorkspaceArtifacts,
  resolvePathUnderWorkspaceArtifacts,
} from "./lib/workspaceFiles.js";
import { runRoomAudit } from "./skills/roomAudit.js";
import { runLoadCalcSnapshot } from "./skills/loadCalc.js";
import { runDoorFireRatingCheck } from "./skills/doorFireRatingCheck.js";
import { runQuantify } from "./skills/quantify.js";
import { runThermalZoning } from "./skills/thermalZoning.js";
import { runPlaceVAVs } from "./skills/placeVAVs.js";
import { runCodeCompliance } from "./skills/codeCompliance.js";
import { runAutoDimFloorPlan } from "./skills/autoDimFloorPlanRunner.js";
import { runFireAlarmLayout } from "./skills/fireAlarmLayoutRunner.js";
import { fireDamperAudit, fireDamperAuditInputSchema, handleFireDamperAudit } from "./skills/fireDamperAudit.js";
import { lightingAuditTools, handleLightingAudit } from "./skills/lightingAudit.js";
import { runPrintSheets } from "./skills/print_sheets.js";
import { ensureWorkspaceLayout } from "./lib/workspace.js";
import { fetchWebEvidenceToWorkspace, getWebResearchPolicyFromEnv } from "./lib/webResearch.js";
import { bestLineReplacement, replaceLineRange, similarityScore } from "./lib/textMatch.js";
import { registerSemanticMepRouteTool } from "./tools/semanticMepRouteTool.js";
import { assertRevitBridgePath } from "./lib/revitPathPolicy.js";
import {
  filterRegistryEntriesForSearch,
  getToolExposureRuntimeDecision,
  isMcpToolAliasExposed,
  isCertifiedToolExposureMode,
  isKnownToolExposureRoute,
  isToolRouteExposedForSearch,
  loadToolExposurePolicy,
  runWithRevitToolAlias
} from "./lib/toolExposurePolicy.js";

function redirectConsoleToStderr(): void {
  // This server communicates over stdio (JSON-RPC). Writing to stdout (even for logs)
  // can corrupt the transport and cause "Transport closed" failures.
  const write = (prefix: string, args: unknown[]) => {
    try {
      const text = args
        .map(a => {
          if (typeof a === "string") return a;
          try {
            return JSON.stringify(a);
          } catch {
            return String(a);
          }
        })
        .join(" ");
      process.stderr.write(`${prefix}${text}\n`);
    } catch {
      // ignore
    }
  };

  // eslint-disable-next-line no-console
  console.log = (...args: unknown[]) => write("", args);
  // eslint-disable-next-line no-console
  console.info = (...args: unknown[]) => write("info: ", args);
  // eslint-disable-next-line no-console
  console.warn = (...args: unknown[]) => write("warn: ", args);
  // eslint-disable-next-line no-console
  console.debug = (...args: unknown[]) => write("debug: ", args);
}

redirectConsoleToStderr();

const require = createRequire(import.meta.url);
const pdfParse = require("pdf-parse");

const server = new McpServer({
  name: "revit-operator",
  version: "1.2.1",
});

// Ensure local-first workspace structure exists on startup.
ensureWorkspaceLayout();

// Audit logging wrapper for ALL MCP tools.
//
// Certified tools/list is fail-closed for every registered alias. The only
// non-policy exception is this explicit local/diagnostic allowlist. In
// particular, a naming convention (including the absence of a revit_ prefix)
// is never sufficient to make a tool model-visible.
const CERTIFIED_SAFE_NON_REVIT_TOOL_ALIASES = new Set([
  "audit_lpd",
  "check_photometrics",
  "fire_damper_audit",
  "operator_plan_semantic_mep_route",
  "operator_runtime_probe",
  "print_sheets",
  "read_excel",
  "read_pdf_text",
  "read_word",
  "validate_ies_files",
  "web_fetch_evidence",
  "workspace_pdf_merge",
  "workspace_pdf_reorder",
  "workspace_rename_file",
  "write_excel"
]);

function isRegisteredMcpToolExposed(name: string): boolean {
  if (!isCertifiedToolExposureMode()) return true;
  if (CERTIFIED_SAFE_NON_REVIT_TOOL_ALIASES.has(name)) return true;
  if (name.startsWith("revit_")) return isMcpToolAliasExposed(name);
  try {
    const { policy } = loadToolExposurePolicy();
    const records = policy.records.filter(record => record.typed_mcp_aliases.includes(name));
    return records.length > 0 && records.every(record =>
      record.visibility !== "workflow_only" && record.channels.typed_mcp.exposed
    );
  } catch {
    return false;
  }
}

function bindDynamicToolExposure(name: string, registeredTool: any): any {
  if (!registeredTool || typeof registeredTool !== "object") return registeredTool;
  let locallyEnabled = registeredTool.enabled !== false;
  Object.defineProperty(registeredTool, "enabled", {
    configurable: true,
    enumerable: true,
    get: () => locallyEnabled && isRegisteredMcpToolExposed(name),
    set: (value: unknown) => { locallyEnabled = value !== false; }
  });
  return registeredTool;
}

const originalTool = server.tool.bind(server);
(server as any).tool = (name: string, description: string, inputSchema: any, handler: (args: any) => Promise<any>) => {
  const registeredTool = originalTool(name, description, inputSchema, async (args: any) => {
    return await runWithRevitToolAlias(name, async () => {
      const startedAt = Date.now();
      auditLog("tool.call", { name, args: summarize(args) as any });
      try {
        const result = await handler(args);
        const durationMs = Date.now() - startedAt;
        const isError = !!(result && typeof result === "object" && (result as any).isError);
        let outBytes = 0;
        try {
          outBytes = JSON.stringify(result).length;
        } catch {
          outBytes = 0;
        }
        auditLog("tool.result", { name, ok: !isError, duration_ms: durationMs, out_bytes: outBytes });
        return result;
      } catch (e) {
        const durationMs = Date.now() - startedAt;
        auditLog("tool.result", { name, ok: false, duration_ms: durationMs, error: String(e) });
        throw e;
      }
    });
  });
  return bindDynamicToolExposure(name, registeredTool);
};

const originalRegisterTool = server.registerTool.bind(server) as any;
(server as any).registerTool = (name: string, config: any, handler: (args: unknown) => Promise<unknown>) => {
  const registeredTool = originalRegisterTool(name, config, async (args: unknown) =>
    await runWithRevitToolAlias(name, async () => await handler(args))
  );
  return bindDynamicToolExposure(name, registeredTool);
};

function registerAuditedZodTool(name: string, description: string, inputSchema: any, handler: (args: unknown) => Promise<unknown>): unknown {
  return (server as any).registerTool(name, { description, inputSchema }, async (args: unknown) => {
    const startedAt = Date.now();
    auditLog("tool.call", { name, args: summarize(args) as any });
    try {
      const result = await handler(args as any);
      const isError = !!(result && typeof result === "object" && (result as any).isError);
      let outBytes = 0;
      try { outBytes = JSON.stringify(result).length; } catch { /* ignore */ }
      auditLog("tool.result", { name, ok: !isError, duration_ms: Date.now() - startedAt, out_bytes: outBytes });
      return result;
    } catch (error) {
      auditLog("tool.result", { name, ok: false, duration_ms: Date.now() - startedAt, error: String(error) });
      throw error;
    }
  });
}

registerSemanticMepRouteTool((name, description, inputSchema, handler) =>
  registerAuditedZodTool(name, description, inputSchema, async (args) => await handler(args as any))
);

// Test-only registration exercises the registerTool interception path. It is
// deliberately not a certified-safe alias and must remain hidden unless a
// future policy explicitly binds and exposes it.
if (process.env.OPERATOR_TEST_REGISTER_UNBOUND_MCP_ALIAS === "1") {
  (server as any).registerTool(
    "operator_test_unbound_mcp_alias",
    { description: "Test-only unbound MCP alias.", inputSchema: {} },
    async () => ({ content: [{ type: "text", text: "test-only" }] })
  );
}

// --- Revit Tools ---

function tryMakeWorkspaceRelative(p: unknown): string | null {
  try {
    if (typeof p !== "string") return null;
    const raw = p.trim();
    if (!raw) return null;
    const root = path.resolve(getWorkspaceRoot());
    const full = path.isAbsolute(raw) ? path.resolve(raw) : path.resolve(root, raw);
    const rootNorm = process.platform === "win32" ? root.toLowerCase() : root;
    const fullNorm = process.platform === "win32" ? full.toLowerCase() : full;
    if (fullNorm === rootNorm) return ".";
    const prefix = rootNorm.endsWith(path.sep) ? rootNorm : rootNorm + path.sep;
    if (!fullNorm.startsWith(prefix)) return null;
    const rel = path.relative(root, full);
    return rel.replace(/\\/g, "/");
  } catch {
    return null;
  }
}

function canonicalWriteMode(applyInput: unknown, dryRunInput: unknown): { apply: boolean; dryRun: boolean } {
  const apply = applyInput === true;
  const dryRun = typeof dryRunInput === "boolean" ? dryRunInput : !apply;
  if (apply === dryRun) {
    throw new Error("Write tools require a canonical mode: preview with apply=false,dryRun=true or write with apply=true,dryRun=false.");
  }
  return { apply, dryRun };
}

function addWorkspaceLinks<T extends Record<string, any>>(data: T): T {
  try {
    const encodeOpPath = (p: string) => encodeURIComponent(p).replace(/%2F/gi, "/");
    const out: any = { ...data };
    const outFolderRel = tryMakeWorkspaceRelative(out.outputFolder);
    if (outFolderRel) {
      out.outputFolder_rel = outFolderRel;
      out.open_outputFolder_url = `op://open-folder?path=${encodeOpPath(outFolderRel)}`;
    }

    const outPathRel = tryMakeWorkspaceRelative(out.path);
    if (outPathRel) {
      out.path_rel = outPathRel;
      // open-folder supports file paths too (Explorer selects the file when it exists).
      out.open_path_url = `op://open-folder?path=${encodeOpPath(outPathRel)}`;
    }

    // Convenience constant; the Operator UI understands this scheme.
    out.open_prints_folder_url = "op://open-folder?path=artifacts/prints";

    // If this is a wrapper response (e.g., print_sheets) that nests the actual export response,
    // enrich the nested export object too.
    if (out.export && typeof out.export === "object") {
      out.export = addWorkspaceLinks(out.export);
    }
    return out as T;
  } catch {
    return data;
  }
}

function isBridgeStatusError(error: unknown, status: number): boolean {
  const text = String(error ?? "");
  return text.includes(`status ${status}`);
}

function parseMatchedCount(payload: any): number {
  const direct = Number(payload?.matchedCount);
  if (Number.isFinite(direct) && direct >= 0) return Math.floor(direct);
  const nested = Number(payload?.counts?.matchedCount);
  if (Number.isFinite(nested) && nested >= 0) return Math.floor(nested);
  return 0;
}

function normalizeDuctCategoriesForRoomContents(raw?: string[]): string[] {
  const src = Array.isArray(raw) && raw.length > 0 ? raw : ["Ducts", "Duct Fittings", "Air Terminals"];
  const mapped = src.map((c) => {
    const t = String(c ?? "").trim().toLowerCase();
    if (t === "ducts" || t === "duct curves" || t === "ost_ductcurves") return "OST_DuctCurves";
    if (t === "duct fittings" || t === "fittings" || t === "ost_ductfitting") return "OST_DuctFitting";
    if (t === "air terminals" || t === "terminals" || t === "ost_ductterminal") return "OST_DuctTerminal";
    return c;
  });
  return [...new Set(mapped)];
}

function normalizeScopeOrder(verticalScope: string | undefined): string[] {
  const v = String(verticalScope ?? "").trim().toLowerCase();
  if (v === "room") return ["room"];
  if (v === "plenum") return ["plenum"];
  if (v === "room+plenum") return ["room", "plenum"];
  if (v === "auto") return ["room", "plenum"];
  return ["room"];
}

function normalizeRoomModeOrder(roomMode: string | undefined): string[] {
  const m = String(roomMode ?? "").trim().toLowerCase();
  if (m === "roomaware") return ["roomAware"];
  if (m === "geometry") return ["geometry"];
  return ["roomAware", "geometry"];
}

function normalizeRoomContentsMode(value: unknown): "auto" | "roomAware" | "geometry" | undefined {
  if (value == null) return undefined;
  const normalized = String(value).trim().toLowerCase();
  if (!normalized) return undefined;
  if (normalized === "auto") return "auto";
  if (normalized === "roomaware" || normalized === "room-aware" || normalized === "room_aware") return "roomAware";
  if (normalized === "geometry" || normalized === "geom") return "geometry";
  return undefined;
}

function normalizeRoomContentsVerticalScope(value: unknown): "room" | "plenum" | "room+plenum" | undefined {
  if (value == null) return undefined;
  const normalized = String(value).trim().toLowerCase();
  if (!normalized) return undefined;
  if (normalized === "room") return "room";
  if (normalized === "plenum") return "plenum";
  if (normalized === "room+plenum" || normalized === "roomplenum" || normalized === "room_and_plenum") return "room+plenum";
  return undefined;
}

function normalizeSpatialKindPreference(value: unknown): "auto" | "room" | "space" | undefined {
  if (value == null) return undefined;
  const normalized = String(value).trim().toLowerCase();
  if (!normalized) return undefined;
  if (normalized === "auto") return "auto";
  if (normalized === "room") return "room";
  if (normalized === "space") return "space";
  return undefined;
}

type RegistryMethod = "GET" | "POST";

type RegistryToolEntry = {
  method?: string;
  path?: string;
  title?: string;
  description?: string;
  group?: string;
  risk?: string;
  required_fields?: string[];
  optional_fields?: string[];
  enums?: unknown;
  units?: unknown;
  notes?: unknown;
  request_schema?: unknown;
  response_schema?: unknown;
  examples?: unknown;
};

type ToolRegistryPayload = {
  version?: string;
  generated_at?: string;
  tools?: RegistryToolEntry[];
};

const TOOL_REGISTRY_CACHE_MS = Math.max(1_000, Number.parseInt(process.env.OPERATOR_TOOL_REGISTRY_CACHE_MS ?? "15000", 10) || 15000);
const EXTRA_DISCOVERY_PATHS = new Set<string>([
  "/revit/ping",
  "/revit/context",
  "/revit/views",
  "/revit/capabilities",
  "/revit/write-grant-status",
  "/revit/tool-registry",
  "/revit/tool-doc",
  "/revit/tool-examples",
  "/revit/native-api-policy",
  "/revit/native-api-catalog",
  "/revit/native-api-search",
  "/revit/native-api-call",
  "/revit/native-api-ops"
]);
let cachedToolRegistry: { fetchedAt: number; rawPayload: ToolRegistryPayload | null } = { fetchedAt: 0, rawPayload: null };

function normalizeRegistryMethod(v: unknown): RegistryMethod | null {
  const m = String(v ?? "").trim().toUpperCase();
  if (m === "GET" || m === "POST") return m;
  return null;
}

function normalizeRawJsonBody(body: unknown): unknown {
  if (typeof body !== "string") return body;
  const trimmed = body.trim();
  if (!trimmed) return body;
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return body;
  try {
    return JSON.parse(trimmed);
  } catch {
    return body;
  }
}

function normalizeParameterMatchOp(value: unknown): "equals" | "contains" {
  const raw = String(value ?? "").trim().toLowerCase();
  if (!raw) return "equals";
  if (["equals", "equal", "eq", "==", "=", "is", "exact"].includes(raw)) return "equals";
  if (["contains", "contain", "has", "includes", "include", "like"].includes(raw)) return "contains";
  return raw === "contains" ? "contains" : "equals";
}

function normalizeRegistryTool(entry: unknown): RegistryToolEntry | null {
  if (!entry || typeof entry !== "object") return null;
  const e = entry as Record<string, unknown>;
  const method = normalizeRegistryMethod(e.method);
  const path = typeof e.path === "string" ? e.path.trim() : "";
  if (!method || !path || !path.startsWith("/revit/")) return null;
  const required_fields = Array.isArray(e.required_fields)
    ? e.required_fields.map(x => String(x ?? "").trim()).filter(Boolean)
    : [];
  const optional_fields = Array.isArray(e.optional_fields)
    ? e.optional_fields.map(x => String(x ?? "").trim()).filter(Boolean)
    : [];
  return {
    method,
    path,
    title: typeof e.title === "string" ? e.title.trim() : "",
    description: typeof e.description === "string" ? e.description.trim() : "",
    group: typeof e.group === "string" ? e.group.trim() : "",
    risk: typeof e.risk === "string" ? e.risk.trim().toLowerCase() : "",
    required_fields,
    optional_fields,
    enums: e.enums,
    units: e.units,
    notes: e.notes,
    request_schema: e.request_schema,
    response_schema: e.response_schema,
    examples: e.examples
  };
}

function tokenizeForSearch(s: string): string[] {
  return String(s ?? "")
    .toLowerCase()
    .split(/[^a-z0-9/_-]+/g)
    .map(x => x.trim())
    .filter(Boolean);
}

function searchableTextForTool(t: RegistryToolEntry): string {
  const parts: string[] = [];
  if (t.path) parts.push(t.path);
  if (t.method) parts.push(t.method);
  if (t.group) parts.push(t.group);
  if (t.title) parts.push(t.title);
  if (t.description) parts.push(t.description);
  if (Array.isArray(t.required_fields) && t.required_fields.length > 0) parts.push(t.required_fields.join(" "));
  if (Array.isArray(t.optional_fields) && t.optional_fields.length > 0) parts.push(t.optional_fields.join(" "));
  return parts.join(" ").toLowerCase();
}

function scoreToolMatch(t: RegistryToolEntry, query: string): number {
  const q = String(query ?? "").trim().toLowerCase();
  if (!q) return 0;
  const tokens = tokenizeForSearch(q);
  if (tokens.length === 0) return 0;

  const method = String(t.method ?? "").toLowerCase();
  const path = String(t.path ?? "").toLowerCase();
  const title = String(t.title ?? "").toLowerCase();
  const desc = String(t.description ?? "").toLowerCase();
  const hay = searchableTextForTool(t);

  let score = 0;
  if (q === path) score += 200;
  if (q === `${method} ${path}`.trim()) score += 240;
  if (path.startsWith(q)) score += 120;
  if (title.includes(q)) score += 80;
  if (desc.includes(q)) score += 40;

  for (const tok of tokens) {
    if (!tok) continue;
    if (path === tok) score += 100;
    else if (path.includes(tok)) score += 28;
    if (title.includes(tok)) score += 20;
    if (desc.includes(tok)) score += 8;
    if (hay.includes(tok)) score += 3;
  }
  return score;
}

function compactToolForList(t: RegistryToolEntry, score?: number): Record<string, unknown> {
  const out: Record<string, unknown> = {
    method: t.method ?? "",
    path: t.path ?? "",
    group: t.group ?? "",
    risk: t.risk ?? "",
    title: t.title ?? "",
    description: t.description ?? ""
  };
  if (Array.isArray(t.required_fields) && t.required_fields.length > 0) out.required_fields = t.required_fields;
  if (Array.isArray(t.optional_fields) && t.optional_fields.length > 0) out.optional_fields = t.optional_fields.slice(0, 12);
  if (typeof score === "number") out.score = score;
  return out;
}

async function getToolRegistry(forceRefresh = false): Promise<ToolRegistryPayload> {
  const now = Date.now();
  if (!forceRefresh && cachedToolRegistry.rawPayload && now - cachedToolRegistry.fetchedAt < TOOL_REGISTRY_CACHE_MS) {
    return {
      ...cachedToolRegistry.rawPayload,
      tools: filterRegistryEntriesForSearch(cachedToolRegistry.rawPayload.tools ?? [])
    };
  }
  const raw = await callRevit<unknown>("/revit/tool-registry", "GET", undefined, { channel: "search" });
  const root = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const toolsRaw = Array.isArray(root.tools) ? root.tools : [];
  const tools: RegistryToolEntry[] = [];
  for (const item of toolsRaw) {
    const normalized = normalizeRegistryTool(item);
    if (normalized) tools.push(normalized);
  }
  const rawPayload: ToolRegistryPayload = {
    version: typeof root.version === "string" ? root.version : "operator.tool_registry.v1",
    generated_at: typeof root.generated_at === "string" ? root.generated_at : undefined,
    tools
  };
  cachedToolRegistry = { fetchedAt: now, rawPayload };
  return { ...rawPayload, tools: filterRegistryEntriesForSearch(tools) };
}

server.tool("operator_runtime_probe", "Check that the Revit Operator MCP runtime itself is responsive without contacting Revit.", {}, async () => {
  const toolExposure = getToolExposureRuntimeDecision();
  let certificationPolicy: Record<string, unknown> | undefined;
  if (toolExposure.certified) {
    try {
      const loaded = loadToolExposurePolicy();
      certificationPolicy = {
        status: "loaded",
        path: loaded.policyPath,
        hash: loaded.policy.policy_hash,
        trustedHash: loaded.trustedPolicyHash,
        trustSource: loaded.trustSource
      };
    } catch (error) {
      certificationPolicy = { status: "fail_closed", error: String(error) };
    }
  }
  return {
    content: [{
      type: "text",
      text: JSON.stringify({
        status: "ok",
        protocol: "operator.mcp.runtime.v1",
        revitTransport: (process.env.OPERATOR_REVIT_TRANSPORT || "direct").trim().toLowerCase(),
        toolExposure,
        certificationPolicy
      }, null, 2)
    }]
  };
});

server.tool("revit_ping", "Check connection to Revit Add-in.", {}, async () => {
  try {
    const data = await callRevit("/revit/ping");
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  } catch (e) { return { isError: true, content: [{ type: "text", text: String(e) }] }; }
});

server.tool("revit_write_grant_status", "Check actual bridge write-grant readiness (active mode/expiry).", {}, async () => {
  try {
    const data = await callRevit("/revit/write-grant-status");
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  } catch (e) { return { isError: true, content: [{ type: "text", text: String(e) }] }; }
});

server.tool("revit_get_context", "Get active doc/view info.", {}, async () => {
  try {
    const data = await callRevit("/revit/context");
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  } catch (e) { return { isError: true, content: [{ type: "text", text: String(e) }] }; }
});

server.tool("revit_list_views", "List all views.", {}, async () => {
  try {
    const data = await callRevit("/revit/views");
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  } catch (e) { return { isError: true, content: [{ type: "text", text: String(e) }] }; }
});

server.tool("revit_query_views", "Query a bounded view index by exact level/type/discipline/id predicates or a declared semantic group.", {
  action: z.enum(["list", "count"]).default("list"),
  viewIds: z.array(z.number().int().positive()).max(64).optional(),
  levelNames: z.array(z.string().min(1).max(160)).max(32).optional(),
  viewTypes: z.array(z.string().min(1).max(80)).max(32).optional(),
  disciplines: z.array(z.string().min(1).max(80)).max(16).optional(),
  viewNames: z.array(z.string().min(1).max(160)).max(32).optional(),
  nameContainsAny: z.array(z.string().min(1).max(160)).max(32).optional(),
  semanticGroups: z.array(z.enum(["power", "lighting", "electrical", "mechanical", "plumbing", "fire_alarm", "architectural"])).max(8).optional(),
  includeTemplates: z.boolean().default(false),
  offset: z.number().int().min(0).max(200000).default(0),
  limit: z.number().int().min(1).max(500).default(100)
}, async (args) => {
  try {
    const data = await callRevit("/revit/views", "POST", args);
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  } catch (e) { return { isError: true, content: [{ type: "text", text: String(e) }] }; }
});

server.tool("revit_tool_doc", "Describe a Revit HTTP tool (request schema + canonical examples).",
  { method: z.enum(["GET", "POST"]), path: z.string() },
  async (args) => {
    try {
      if (!isToolRouteExposedForSearch(args.method, String(args.path ?? "").trim())) {
        throw new Error(`Tool documentation is hidden because search exposure is not certified for ${args.method} ${args.path}.`);
      }
      const data = await callRevit("/revit/tool-doc", "POST", args);
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    } catch (e) { return { isError: true, content: [{ type: "text", text: String(e) }] }; }
  }
);

server.tool("revit_tool_examples", "Get runnable examples for a Revit HTTP tool.",
  { method: z.enum(["GET", "POST"]), path: z.string() },
  async (args) => {
    try {
      if (!isToolRouteExposedForSearch(args.method, String(args.path ?? "").trim())) {
        throw new Error(`Tool examples are hidden because search exposure is not certified for ${args.method} ${args.path}.`);
      }
      const data = await callRevit("/revit/tool-examples", "POST", args);
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    } catch (e) { return { isError: true, content: [{ type: "text", text: String(e) }] }; }
  }
);

server.tool("revit_native_api_policy", "Get current native Revit API gateway policy/profile.",
  {},
  async () => {
    try {
      const data = await callRevit("/revit/native-api-policy", "GET");
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    } catch (e) {
      return { isError: true, content: [{ type: "text", text: String(e) }] };
    }
  }
);

server.tool("revit_native_api_set_policy", "Set native Revit API gateway profile/risk policy.",
  {
    profile: z.enum(["balanced", "broad", "unrestricted"]).optional(),
    maxRisk: z.enum(["low", "medium", "high"]).optional(),
    allowMutating: z.boolean().optional(),
    blockFreezeRisk: z.boolean().optional(),
    maxResults: z.number().int().optional(),
    maxInvocationParams: z.number().int().optional()
  },
  async (args) => {
    try {
      const data = await callRevit("/revit/native-api-policy", "POST", args);
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    } catch (e) {
      return { isError: true, content: [{ type: "text", text: String(e) }] };
    }
  }
);

server.tool("revit_native_api_catalog", "List/paginate reflected Revit native API members (with risk and policy hints).",
  {
    query: z.string().optional(),
    namespacePrefix: z.string().optional(),
    typeContains: z.string().optional(),
    risk: z.enum(["low", "medium", "high"]).optional(),
    offset: z.number().int().optional().default(0),
    limit: z.number().int().optional().default(80)
  },
  async (args) => {
    try {
      const data = await callRevit("/revit/native-api-catalog", "POST", args);
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    } catch (e) {
      return { isError: true, content: [{ type: "text", text: String(e) }] };
    }
  }
);

server.tool("revit_native_api_search", "Search reflected Revit native API members by natural language or keywords.",
  {
    query: z.string(),
    namespacePrefix: z.string().optional(),
    risk: z.enum(["low", "medium", "high"]).optional(),
    max: z.number().int().optional().default(20)
  },
  async (args) => {
    try {
      const data = await callRevit("/revit/native-api-search", "POST", args);
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    } catch (e) {
      return { isError: true, content: [{ type: "text", text: String(e) }] };
    }
  }
);

server.tool("revit_native_api_call", "Invoke a reflected Revit native API member through bridge guardrails.",
  {
    memberId: z.string(),
    target: z.enum(["uiapp", "uidoc", "doc", "view"]).optional(),
    args: z.array(z.unknown()).optional(),
    dryRun: z.boolean().optional().default(false)
  },
  async (args) => {
    try {
      const data = await callRevit("/revit/native-api-call", "POST", args);
      const out =
        data && typeof data === "object" && !Array.isArray(data) ? addWorkspaceLinks(data as Record<string, any>) : data;
      return { content: [{ type: "text", text: JSON.stringify(out, null, 2) }] };
    } catch (e) {
      return { isError: true, content: [{ type: "text", text: String(e) }] };
    }
  }
);

server.tool("revit_native_api_ops", "Compose a bounded read-only native Revit API constructor/instance-call chain with ephemeral per-request result references.",
  {
    operations: z.array(z.object({
      id: z.string().min(1).max(64),
      op: z.enum(["construct", "call"]),
      memberId: z.string().min(1).max(400),
      target: z.string().max(72).optional().describe("For call operations, a prior result reference such as $collector."),
      args: z.array(z.unknown()).optional().default([])
    })).min(1).max(16),
    returns: z.array(z.string().min(1).max(65)).max(16).optional()
  },
  async (args) => {
    try {
      const data = await callRevit("/revit/native-api-ops", "POST", args);
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    } catch (e) {
      return { isError: true, content: [{ type: "text", text: String(e) }] };
    }
  }
);

server.tool("revit_tool_registry", "List/search Revit HTTP primitives from the bridge tool registry (best for large capability sets).",
  {
    query: z.string().optional().describe("Optional search text (path/title/description/fields)."),
    method: z.enum(["GET", "POST"]).optional().describe("Filter by method."),
    pathPrefix: z.string().optional().describe("Filter by path prefix, e.g. /revit/titleblock"),
    group: z.string().optional().describe("Filter by group (exact, case-insensitive)."),
    risk: z.enum(["low", "medium", "high"]).optional().describe("Filter by risk."),
    offset: z.number().int().optional().default(0),
    limit: z.number().int().optional().default(80),
    includeSchemas: z.boolean().optional().default(false).describe("Include request/response schema payloads (larger output)."),
    forceRefresh: z.boolean().optional().default(false).describe("Bypass short-lived cache and fetch registry again.")
  },
  async (args) => {
    try {
      const query = String(args.query ?? "").trim();
      const method = normalizeRegistryMethod(args.method);
      const pathPrefix = String(args.pathPrefix ?? "").trim().toLowerCase();
      const group = String(args.group ?? "").trim().toLowerCase();
      const risk = String(args.risk ?? "").trim().toLowerCase();
      const offset = Math.max(0, Number(args.offset ?? 0) || 0);
      const limit = Math.max(1, Math.min(300, Number(args.limit ?? 80) || 80));
      const includeSchemas = !!args.includeSchemas;
      const forceRefresh = !!args.forceRefresh;

      const registry = await getToolRegistry(forceRefresh);
      const base = Array.isArray(registry.tools) ? registry.tools : [];

      let filtered = base.filter(t => {
        if (method && String(t.method ?? "").toUpperCase() !== method) return false;
        if (pathPrefix && !String(t.path ?? "").toLowerCase().startsWith(pathPrefix)) return false;
        if (group && String(t.group ?? "").toLowerCase() !== group) return false;
        if (risk && String(t.risk ?? "").toLowerCase() !== risk) return false;
        return true;
      });

      let scored: Array<{ tool: RegistryToolEntry; score: number }> | null = null;
      if (query) {
        scored = filtered
          .map(tool => ({ tool, score: scoreToolMatch(tool, query) }))
          .filter(x => x.score > 0)
          .sort((a, b) => b.score - a.score || String(a.tool.path ?? "").localeCompare(String(b.tool.path ?? "")));
        filtered = scored.map(x => x.tool);
      } else {
        filtered = filtered.sort((a, b) => String(a.path ?? "").localeCompare(String(b.path ?? "")));
      }

      const total = filtered.length;
      const page = filtered.slice(offset, offset + limit);
      const items = includeSchemas
        ? page
        : page.map(t => {
            const score = scored?.find(x => x.tool === t)?.score;
            return compactToolForList(t, score);
          });

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                version: registry.version ?? "operator.tool_registry.v1",
                generated_at: registry.generated_at ?? null,
                query: query || null,
                filters: { method: method ?? null, pathPrefix: pathPrefix || null, group: group || null, risk: risk || null },
                offset,
                limit,
                total,
                returned: items.length,
                items
              },
              null,
              2
            )
          }
        ]
      };
    } catch (e) {
      return { isError: true, content: [{ type: "text", text: String(e) }] };
    }
  }
);

server.tool("revit_search_tools", "Search Revit bridge primitives and return best matches for a natural-language task.",
  {
    query: z.string().describe("What you need to do (or endpoint/path keywords)."),
    max: z.number().int().optional().default(20),
    method: z.enum(["GET", "POST"]).optional(),
    group: z.string().optional(),
    risk: z.enum(["low", "medium", "high"]).optional(),
    pathPrefix: z.string().optional(),
    includeSchemas: z.boolean().optional().default(false),
    forceRefresh: z.boolean().optional().default(false)
  },
  async (args) => {
    try {
      const query = String(args.query ?? "").trim();
      if (!query) {
        return { isError: true, content: [{ type: "text", text: "query is required." }] };
      }
      const method = normalizeRegistryMethod(args.method);
      const group = String(args.group ?? "").trim().toLowerCase();
      const risk = String(args.risk ?? "").trim().toLowerCase();
      const pathPrefix = String(args.pathPrefix ?? "").trim().toLowerCase();
      const max = Math.max(1, Math.min(100, Number(args.max ?? 20) || 20));
      const includeSchemas = !!args.includeSchemas;

      if (!pathPrefix && !includeSchemas) {
        try {
          const directBody: Record<string, unknown> = { query, max: Math.min(max, 12) };
          if (method) directBody.method = method;
          if (group) directBody.group = group;
          if (risk) directBody.risk = risk;

          const direct = await callRevit<Record<string, unknown>>("/revit/tool-search", "POST", directBody, { channel: "search" });
          const matchesRaw = Array.isArray((direct as any)?.matches) ? ((direct as any).matches as unknown[]) : [];
          const matches = filterRegistryEntriesForSearch(matchesRaw.map(item => {
            const tool = normalizeRegistryTool(item);
            if (!tool) return null;
            const raw = item && typeof item === "object" ? (item as Record<string, unknown>) : {};
            const score = typeof raw.score === "number" ? raw.score : undefined;
            return compactToolForList(tool, score);
          }).filter((item): item is Record<string, unknown> => !!item));

          if (matches.length > 0 || String((direct as any)?.version ?? "") === "operator.tool_search.v1") {
            return {
              content: [
                {
                  type: "text",
                  text: JSON.stringify(
                    {
                      source: "/revit/tool-search",
                      query,
                      total_matches: matches.length,
                      matches
                    },
                    null,
                    2
                  )
                }
              ]
            };
          }
        } catch {
          // Older add-ins may not expose /revit/tool-search yet. Fall back to registry search below.
        }
      }

      const registry = await getToolRegistry(!!args.forceRefresh);
      const base = Array.isArray(registry.tools) ? registry.tools : [];
      const ranked = base
        .filter(t => {
          if (method && String(t.method ?? "").toUpperCase() !== method) return false;
          if (group && String(t.group ?? "").toLowerCase() !== group) return false;
          if (risk && String(t.risk ?? "").toLowerCase() !== risk) return false;
          if (pathPrefix && !String(t.path ?? "").toLowerCase().startsWith(pathPrefix)) return false;
          return true;
        })
        .map(tool => ({ tool, score: scoreToolMatch(tool, query) }))
        .filter(x => x.score > 0)
        .sort((a, b) => b.score - a.score || String(a.tool.path ?? "").localeCompare(String(b.tool.path ?? "")))
        .slice(0, max);

      const matches = includeSchemas ? ranked.map(x => ({ score: x.score, ...x.tool })) : ranked.map(x => compactToolForList(x.tool, x.score));
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                source: "/revit/tool-registry",
                query,
                total_matches: ranked.length,
                matches
              },
              null,
              2
            )
          }
        ]
      };
    } catch (e) {
      return { isError: true, content: [{ type: "text", text: String(e) }] };
    }
  }
);

server.tool("revit_call_tool", "Generic Revit bridge call by method/path. Use when a primitive exists but has no dedicated MCP wrapper.",
  {
    method: z.enum(["GET", "POST"]),
    path: z.string().describe("Must start with /revit/ (e.g., /revit/model-health)."),
    body: z.unknown().optional().describe("JSON body for POST. Ignored for GET."),
    forceRefreshRegistry: z.boolean().optional().default(false).describe("Refresh registry before endpoint metadata lookup."),
    requireKnownPath: z.boolean().optional().default(false).describe("If true, reject paths not found in tool registry/capability extras.")
  },
  async (args) => {
    try {
      const method = normalizeRegistryMethod(args.method);
      const pathInput = String(args.path ?? "").trim();
      if (!method) throw new Error("method must be GET or POST.");
      assertRevitBridgePath(pathInput);

      let registry: ToolRegistryPayload | null = null;
      let registryLookupError = "";
      const certifiedMode = isCertifiedToolExposureMode();
      let known = false;
      if (certifiedMode) {
        // In certified mode the signed policy, not live bridge metadata, is the
        // exact route allowlist. This remains mandatory even when the caller
        // passes requireKnownPath=false.
        known = isKnownToolExposureRoute(method, pathInput);
      } else {
        try {
          registry = await getToolRegistry(!!args.forceRefreshRegistry);
        } catch (e) {
          registryLookupError = String(e ?? "");
        }
        known = (registry?.tools ?? []).some(
          t => String(t.method ?? "").toUpperCase() === method && String(t.path ?? "") === pathInput
        ) || EXTRA_DISCOVERY_PATHS.has(pathInput);
      }
      if ((certifiedMode || !!args.requireKnownPath) && !known) {
        if (registryLookupError) {
          throw new Error(`Tool registry lookup failed (${registryLookupError}). Cannot enforce requireKnownPath for ${method} ${pathInput}.`);
        }
        throw new Error(`Unknown tool path for this bridge: ${method} ${pathInput}. Run revit_search_tools first.`);
      }

      const normalizedBody = method === "GET" ? undefined : normalizeRawJsonBody(args.body);
      const data = method === "GET"
        ? await callRevit(pathInput, method, undefined, { channel: "generic_call" })
        : await callRevit(pathInput, method, normalizedBody, { channel: "generic_call" });
      const output =
        data && typeof data === "object" && !Array.isArray(data) ? addWorkspaceLinks(data as Record<string, any>) : data;
      const wrapped = known
        ? output
        : {
            warning: "Path not found in current tool registry metadata. Executed as raw bridge call.",
            registryLookupError: registryLookupError || undefined,
            method,
            path: pathInput,
            response: output
          };
      return { content: [{ type: "text", text: JSON.stringify(wrapped, null, 2) }] };
    } catch (e) {
      return { isError: true, content: [{ type: "text", text: String(e) }] };
    }
  }
);

server.tool("revit_list_sheets", "List or count sheets (sorted by Sheet Number). Use action=count for an exact total without fetching rows; supports prefix filtering and paging.",
  {
    action: z.enum(["list", "count"]).optional().default("list").describe("Use count for totals only or list for sheet rows."),
    countOnly: z.boolean().optional().describe("Legacy alias for action=count."),
    sheetNumberPrefix: z.string().optional().describe("Filter by Sheet Number prefix (e.g. M1)."),
    query: z.string().optional().describe("Fallback filter (contains match on sheet number/name). Supports trailing * as prefix."),
    exact: z.boolean().optional().default(false),
    offset: z.number().int().optional().describe("Paging offset (0-based)."),
    limit: z.number().int().optional().describe("Paging limit (max 2000)."),
    all: z.boolean().optional().describe("If true, return up to 500 matches in one response."),
    max: z.number().int().optional().describe("Legacy alias for limit.")
  },
  async (args) => {
    try {
      const data = await callRevit("/revit/sheets", "POST", args);
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    } catch (e) { return { isError: true, content: [{ type: "text", text: String(e) }] }; }
  }
);

// Development/laboratory-only until evidence promotion adds an exact policy
// record. The dynamic exposure wrapper keeps this alias absent in certified
// tools/list; the client independently rechecks policy before host discovery.
server.tool("revit_count_sheets_certified", "Laboratory-only fixed SafeRead count of sheets through an attested standalone loopback host.", {}, async () => {
  try {
    const data = await countSheetsViaSafeRead();
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  } catch (e) { return { isError: true, content: [{ type: "text", text: String(e) }] }; }
});

server.tool("revit_list_schedules", "List schedules or read one schedule's bounded fields and visible table cells.",
  {
    action: z.enum(["list", "detail"]).optional().default("list"),
    scheduleId: z.number().int().optional(),
    query: z.string().optional(),
    exact: z.boolean().optional().default(false),
    max: z.number().int().min(1).max(500).optional(),
    includeFields: z.boolean().optional(),
    includeData: z.boolean().optional(),
    rowOffset: z.number().int().min(0).optional(),
    columnOffset: z.number().int().min(0).optional(),
    maxRows: z.number().int().min(1).optional(),
    maxColumns: z.number().int().min(1).optional()
  },
  async (args) => {
    try {
      if (args.action === "detail" && args.scheduleId === undefined && !String(args.query ?? "").trim()) {
        throw new Error("revit_list_schedules detail requires scheduleId or query.");
      }
      const data = await callRevit("/revit/schedules", "POST", args);
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    } catch (e) { return { isError: true, content: [{ type: "text", text: String(e) }] }; }
  }
);

server.tool("revit_update_schedule_cell", "Resolve one schedule row to one backing parameter. Dry-run by default; apply only with apply=true,dryRun=false. Grouped schedules proceed only for one unique editable backing target; ambiguity, shared types, read-only cells, and expected-value mismatches fail closed.",
  {
    scheduleId: z.number().int().positive().optional(),
    scheduleQuery: z.string().optional(),
    scheduleExact: z.boolean().optional(),
    rowKey: z.string().min(1),
    rowField: z.string().optional().describe("Optional identifier field. Omit to try Mark, Number, Name, Designation, and DESIG."),
    targetField: z.string().min(1),
    expectedValue: z.string().optional(),
    value: z.string().min(1),
    apply: z.boolean().optional(),
    dryRun: z.boolean().optional(),
    maxSchedules: z.number().int().min(1).max(500).optional()
  },
  async (args) => {
    try {
      const mode = canonicalWriteMode(args.apply, args.dryRun);
      const data = await callRevit("/revit/update-schedule-cell", "POST", { ...args, ...mode });
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    } catch (e) { return { isError: true, content: [{ type: "text", text: String(e) }] }; }
  }
);

server.tool("revit_replace_schedule_values", "Plan or apply bounded literal replacements in exact fields of schedules placed on explicit sheets. Dry-run first; apply requires the returned expectedPlanHash.",
  {
    sheetNumbers: z.array(z.string()).max(50).optional(),
    scheduleIds: z.array(z.number().int().positive()).max(200).optional(),
    fieldNames: z.array(z.string()).max(20).optional(),
    valueContains: z.string().min(1),
    expectedValue: z.string().optional(),
    replaceFrom: z.string().min(1),
    replaceTo: z.string(),
    expectedPlanHash: z.string().optional(),
    apply: z.boolean().optional(),
    dryRun: z.boolean().optional(),
    maxSchedules: z.number().int().min(1).max(500).optional(),
    maxCandidates: z.number().int().min(1).max(10000).optional(),
    maxChanges: z.number().int().min(1).max(10000).optional()
  },
  async (args) => {
    try {
      if ((!args.sheetNumbers || args.sheetNumbers.length === 0) && (!args.scheduleIds || args.scheduleIds.length === 0)) {
        throw new Error("revit_replace_schedule_values requires sheetNumbers or scheduleIds.");
      }
      const mode = canonicalWriteMode(args.apply, args.dryRun);
      if (mode.apply && !String(args.expectedPlanHash ?? "").trim()) {
        throw new Error("Applying schedule replacements requires expectedPlanHash from the matching dry run.");
      }
      const data = await callRevit("/revit/replace-schedule-values", "POST", { ...args, ...mode });
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    } catch (e) { return { isError: true, content: [{ type: "text", text: String(e) }] }; }
  }
);

server.tool("revit_get_titleblock_info", "Resolve a sheet to its titleblock instance/type/family info.",
  {
    sheetNumber: z.string().optional(),
    sheetId: z.number().optional(),
    sheetViewId: z.number().optional(),
  },
  async (args) => {
    try {
      const data = await callRevit("/revit/get-titleblock-info", "POST", args);
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    } catch (e) { return { isError: true, content: [{ type: "text", text: String(e) }] }; }
  }
);

server.tool("revit_capture_sheet_region", "Capture a deterministic region of a sheet (currently: titleblock).",
  {
    sheetNumber: z.string().optional(),
    sheetViewId: z.number().optional(),
    region: z.enum(["titleblock"]).optional().default("titleblock"),
    marginFt: z.number().optional().default(0.15),
    imageMaxSizePx: z.number().int().optional().default(2400),
    includeMapping: z.boolean().optional().default(true),
    fileName: z.string().optional(),
    includeOcr: z.boolean().optional().default(false),
    ocrKind: z.enum(["date", "text"]).optional().default("date"),
    ocrExpected: z.string().optional(),
    ocrTimeoutMs: z.number().int().optional().default(20000),
    ocrMaxRetries: z.number().int().optional().default(2),
    ocrPreprocess: z.boolean().optional().default(false),
  },
  async (args) => {
    try {
      const data = addWorkspaceLinks(await callRevit("/revit/capture-sheet-region", "POST", args) as any);
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    } catch (e) { return { isError: true, content: [{ type: "text", text: String(e) }] }; }
  }
);

server.tool("titleblock_update_text", "Update titleblock static text on a sheet (edit family text → reload → capture for visual verification).",
  {
    sheetNumber: z.string().describe("Sheet Number (e.g. A101)."),
    matchText: z.string().describe("Text to match in the titleblock family (normalized matching by default)."),
    replaceText: z.string().describe("Replacement text to set in the titleblock family."),
    textNoteId: z.number().int().optional().describe("Optional: explicitly choose a TextNote id in the titleblock family to edit."),
    replaceLines: z.object({
      start: z.number().int(),
      end: z.number().int(),
    }).optional().describe("Optional: replace only a line range (1-based, inclusive) within the selected TextNote."),
    dryRun: z.boolean().optional().default(false),
    confirm: z.string().optional().describe("Typed confirmation string; if OPERATOR_BULK_CONFIRM_SIMPLE=1 you can pass \"yes\"."),
    verifyWithOcr: z.boolean().optional().default(false).describe("Optional: run OCR on the post-change capture (slower, more failure-prone). Default is visual verification via screenshot."),
    ocrTimeoutMs: z.number().int().optional().default(8000),
    imageMaxSizePx: z.number().int().optional().default(2400),
    marginFt: z.number().optional().default(0.15),
    maxCandidates: z.number().int().optional().default(8),
  },
  async (args) => {
    try {
      const textOut = (obj: any) => ({ content: [{ type: "text" as const, text: JSON.stringify(obj, null, 2) }] });
      const sheetNumber = String((args as any).sheetNumber ?? "").trim();
      const matchText = String((args as any).matchText ?? "").trim();
      const replaceText = String((args as any).replaceText ?? "").toString();
      const dryRun = !!(args as any).dryRun;
      const maxCandidates = Math.max(1, Math.min(20, Number((args as any).maxCandidates ?? 8) || 8));
      if (!sheetNumber) throw new Error("sheetNumber is required.");
      if (!matchText) throw new Error("matchText is required.");

      const confirmFromEnv = process.env.OPERATOR_BULK_CONFIRM_SIMPLE === "1" ? "yes" : undefined;
      const confirm = typeof (args as any).confirm === "string" ? (args as any).confirm : confirmFromEnv;

      const isInvalidObject = (e: unknown) => /referenced object is not valid|invalidobjectexception/i.test(String(e ?? ""));

      const runOnce = async (attempt: number) => {
        const now = Date.now();
        const info = await callRevit<any>("/revit/get-titleblock-info", "POST", { sheetNumber });
        const titleblockInstanceId = Number(info?.titleblockInstanceId ?? 0) || 0;
        const sheetViewId = Number(info?.sheetViewId ?? 0) || 0;
        if (!titleblockInstanceId) throw new Error("Could not resolve titleblockInstanceId for target sheet.");

        const fam = await callRevit<any>("/revit/open-family-doc", "POST", { titleblockInstanceId });
        const docId = String(fam?.docId ?? fam?.familyDocumentId ?? "").trim();
        if (!docId) throw new Error("open-family-doc did not return docId.");

        try {
          const notes = await callRevit<any>("/revit/find-text-notes", "POST", { docId, max: 400 });
          const items: any[] = Array.isArray(notes?.items) ? notes.items : [];

        const scored = items
          .map(it => {
            const before = String(it?.text ?? "");
            const score = similarityScore(before, matchText);

            let plannedAfter = before;
            let plan: any = { kind: "none" };

            const rl = (args as any).replaceLines;
            if (rl && typeof rl.start === "number" && typeof rl.end === "number") {
              const r = replaceLineRange(before, rl.start, rl.end, replaceText);
              if (r.ok) {
                plannedAfter = r.after;
                plan = { kind: "replaceLines", start: rl.start, end: rl.end };
              }
            } else {
              // Prefer line-local replace to preserve headers.
              const r = bestLineReplacement(before, matchText, replaceText);
              if (r.ok) {
                plannedAfter = r.after;
                plan = { kind: "bestLine", lineIndex0: r.lineIndex, score: r.score };
              }
            }

            return {
              textNoteId: Number(it?.textNoteId ?? it?.elementId ?? 0) || 0,
              before,
              after: plannedAfter,
              score,
              center: it?.center ?? null,
              plan,
            };
          })
          .filter(r => r.textNoteId > 0)
          .sort((a, b) => (b.score ?? 0) - (a.score ?? 0));

        const top = scored.slice(0, maxCandidates);

        const requestedId = Number((args as any).textNoteId ?? 0) || 0;
        let chosen = requestedId ? scored.find(s => s.textNoteId === requestedId) : null;

        if (!chosen) {
          const best = top[0];
          const second = top[1];
          const bestScore = best?.score ?? 0;
          const secondScore = second?.score ?? 0;
          const confident = bestScore >= 0.82 && bestScore - secondScore >= 0.08;
          if (confident && best) chosen = best;
        }

        if (!chosen) {
          return textOut({
            ok: false,
            status: "Pick Candidate",
            applied: false,
            reloaded: false,
            verified: false,
            verification_method: "none",
            sheetNumber,
            sheetViewId,
            titleblockInstanceId,
            matchText,
            replaceText,
            candidates: top.map(c => ({
              textNoteId: c.textNoteId,
              score: Math.round((c.score ?? 0) * 1000) / 1000,
              center: c.center,
              before: c.before,
              after: c.after,
              plan: c.plan,
            })),
            hint: "Provide textNoteId to apply (or make matchText more specific).",
          });
        }

        const before = chosen.before;
        const after = chosen.after;
        const changed = before !== after;

        const verifyWithOcr = !!(args as any).verifyWithOcr;

        if (dryRun || !changed) {
          return textOut({
            ok: true,
            status: dryRun ? "Dry Run" : "No Change",
            applied: false,
            reloaded: false,
            verified: null,
            verification_method: "none",
            sheetNumber,
            sheetViewId,
            titleblockInstanceId,
            textNoteId: chosen.textNoteId,
            matchText,
            replaceText,
            planned: { before, after, changed },
          });
        }

        const applyRes = await callRevit<any>("/revit/replace-text-note", "POST", {
          docId,
          elementId: chosen.textNoteId,
          newText: after,
          apply: true,
          confirm,
        });

        if (applyRes && typeof applyRes === "object" && (applyRes as any).ok === false) {
          return textOut({
            ok: false,
            status: "Confirm Required",
            applied: false,
            reloaded: false,
            verified: false,
            verification_method: "none",
            sheetNumber,
            sheetViewId,
            titleblockInstanceId,
            textNoteId: chosen.textNoteId,
            requiredConfirm: (applyRes as any).requiredConfirm ?? null,
            confirmReceived: (applyRes as any).confirmReceived ?? null,
            hint: (applyRes as any).hint ?? null,
            planned: { before, after, changed },
          });
        }

        const reloadRes = await callRevit<any>("/revit/load-family-doc", "POST", { docId, overwriteParameterValuesOnLoad: true });

        // Best-effort: force the sheet to reflect the reloaded family before we capture evidence.
        try { await callRevit("/revit/regenerate", "POST", { refreshActiveView: true }); } catch { /* ignore */ }

        const postCapture = addWorkspaceLinks(await callRevit<any>("/revit/capture-sheet-region", "POST", {
          sheetNumber,
          region: "titleblock",
          marginFt: (args as any).marginFt,
          imageMaxSizePx: (args as any).imageMaxSizePx,
          includeMapping: true,
          includeOcr: verifyWithOcr,
          ...(verifyWithOcr ? {
            ocrKind: "text",
            ocrExpected: replaceText,
            ocrTimeoutMs: (args as any).ocrTimeoutMs,
            ocrMaxRetries: 2,
            ocrPreprocess: false,
          } : {}),
          fileName: `titleblock_update_${sheetNumber}_after_${now}`,
        }) as any);

        const postEvidence = (postCapture as any)?.export?.path ?? null;
        const ocrVerified = !!((postCapture as any)?.ocr?.ok && (postCapture as any)?.ocr?.match_expected === true);
        const verified = verifyWithOcr ? ocrVerified : null;
        const verification_method = verifyWithOcr ? (ocrVerified ? "ocr" : ((postCapture as any)?.ocrReady ? "manual" : "none")) : "visual";

        return textOut({
          ok: true,
          status: verified === true ? "Applied + Verified" : "Applied (Needs Verification)",
          applied: true,
          reloaded: !!reloadRes?.ok,
          verified,
          verification_method,
          sheetNumber,
          sheetViewId,
          titleblockInstanceId,
          textNoteId: chosen.textNoteId,
          matchText,
          replaceText,
          evidence_path: postEvidence,
          ocrReady: verifyWithOcr ? !!(postCapture as any)?.ocrReady : undefined,
          ocrOk: verifyWithOcr ? !!(postCapture as any)?.ocr?.ok : undefined,
          ocrMatchExpected: verifyWithOcr ? ((postCapture as any)?.ocr?.match_expected ?? null) : undefined,
          ocrError: verifyWithOcr ? ((postCapture as any)?.ocr?.ok === false ? ((postCapture as any)?.ocr?.error ?? null) : null) : undefined,
          planned: { before, after, changed: true },
          applyResult: applyRes,
          reloadResult: reloadRes,
          capture: postCapture,
        });
      } finally {
        try {
          await callRevit("/revit/close-doc", "POST", { docId, saveChanges: false });
        } catch {
            // ignore
          }
        }
      };

      try {
        return await runOnce(0);
      } catch (e) {
        if (isInvalidObject(e)) {
          // Revit can invalidate document handles between runs; retry once with fresh resolves.
          await new Promise(r => setTimeout(r, 250));
          return await runOnce(1);
        }
        throw e;
      }
    } catch (e) {
      return { isError: true, content: [{ type: "text" as const, text: String(e) }] };
    }
  }
);

server.tool("revit_get_family_file_path", "Best-effort: determine a family file path (if known).",
  { familyId: z.number().int() },
  async (args) => {
    try {
      const data = await callRevit("/revit/get-family-file-path", "POST", args);
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    } catch (e) { return { isError: true, content: [{ type: "text", text: String(e) }] }; }
  }
);

server.tool("revit_open_family_doc", "Open a family document for editing (returns docId session handle).",
  {
    filePath: z.string().optional(),
    familyId: z.number().optional(),
    titleblockInstanceId: z.number().optional(),
    elementId: z.number().optional(),
  },
  async (args) => {
    try {
      const data = await callRevit("/revit/open-family-doc", "POST", args);
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    } catch (e) { return { isError: true, content: [{ type: "text", text: String(e) }] }; }
  }
);

server.tool("revit_find_text_notes", "Find TextNotes in an open family doc session (docId).",
  {
    docId: z.string(),
    textContains: z.string().optional(),
    regex: z.string().optional(),
    viewId: z.number().optional(),
    max: z.number().int().optional(),
  },
  async (args) => {
    try {
      const data = await callRevit("/revit/find-text-notes", "POST", args);
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    } catch (e) { return { isError: true, content: [{ type: "text", text: String(e) }] }; }
  }
);

server.tool("revit_replace_text_note", "Replace a TextNote's text in an open family doc session (docId).",
  {
    docId: z.string(),
    elementId: z.number().int(),
    newText: z.string(),
    dryRun: z.boolean().optional(),
    apply: z.boolean().optional(),
    confirm: z.string().optional(),
  },
  async (args) => {
    try {
      const data = await callRevit("/revit/replace-text-note", "POST", args);
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    } catch (e) { return { isError: true, content: [{ type: "text", text: String(e) }] }; }
  }
);

server.tool("revit_save_family_doc", "Save an open family doc to disk if it has a known path.",
  {
    docId: z.string(),
    overwrite: z.boolean().optional(),
  },
  async (args) => {
    try {
      const data = await callRevit("/revit/save-family-doc", "POST", args);
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    } catch (e) { return { isError: true, content: [{ type: "text", text: String(e) }] }; }
  }
);

server.tool("revit_load_family_doc", "Load/reload an open family doc into the active project (overwrite).",
  {
    docId: z.string(),
    overwriteParameterValuesOnLoad: z.boolean().optional(),
  },
  async (args) => {
    try {
      const data = await callRevit("/revit/load-family-doc", "POST", args);
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    } catch (e) { return { isError: true, content: [{ type: "text", text: String(e) }] }; }
  }
);

server.tool("revit_close_doc", "Close an open family doc session.",
  {
    docId: z.string(),
    saveChanges: z.boolean().optional(),
  },
  async (args) => {
    try {
      const data = await callRevit("/revit/close-doc", "POST", args);
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    } catch (e) { return { isError: true, content: [{ type: "text", text: String(e) }] }; }
  }
);

server.tool("revit_capture_view", "Export view as image.", 
  { viewId: z.number().optional(), imageSize: z.number().default(2048) }, 
  async ({ viewId, imageSize }) => {
    try {
      const data = await callRevit("/revit/export-image", "POST", { viewId, imageSize });
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    } catch (e) { return { isError: true, content: [{ type: "text", text: String(e) }] }; }
});

server.tool("revit_export_view_frame", "Export active view image + deterministic pixel-to-model mapping metadata.",
  {
    viewId: z.number().optional(),
    imageSize: z.number().default(2200),
    folder: z.string().optional(),
    includeMapping: z.boolean().default(true),
  },
  async ({ viewId, imageSize, folder, includeMapping }) => {
    try {
      const data = await callRevit("/revit/export-view-frame", "POST", { viewId, imageSize, folder, includeMapping });
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    } catch (e) { return { isError: true, content: [{ type: "text", text: String(e) }] }; }
  }
);

server.tool("revit_export_view_region", "Export an image + deterministic pixel-to-model mapping for a specified region of a view (works even when view crop is disabled/locked).",
  {
    viewId: z.number().optional(),
    imageMaxSizePx: z.number().default(2400),
    includeMapping: z.boolean().default(true),
    fileName: z.string().optional(),
    region: z.discriminatedUnion("mode", [
      z.object({
        mode: z.literal("focusElements"),
        focusElementIds: z.array(z.number()).min(1),
        marginFt: z.number().default(0.0),
      }),
      z.object({
        mode: z.literal("center"),
        centerX: z.number(),
        centerY: z.number(),
        halfWidth: z.number(),
        halfHeight: z.number(),
      }),
    ]),
  },
  async (args) => {
    try {
      const data = await callRevit("/revit/export-view-region", "POST", args);
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    } catch (e) { return { isError: true, content: [{ type: "text", text: String(e) }] }; }
  }
);

server.tool("revit_pick_at_pixel", "Pick element candidates at pixel coordinates from an exported view frame.",
  {
    frameId: z.string(),
    xPx: z.number(),
    yPx: z.number(),
    categories: z.array(z.string()).optional(),
    searchRadiusModel: z.number().default(0.35),
    maxCandidates: z.number().default(10),
    preferCategories: z.array(z.string()).optional(),
    includeLinked: z.boolean().default(true),
    preferViewLevel: z.boolean().default(false),
  },
  async (args) => {
    try {
      const data = await callRevit("/revit/pick-at-pixel", "POST", args);
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    } catch (e) { return { isError: true, content: [{ type: "text", text: String(e) }] }; }
  }
);

server.tool("revit_activate_view", "Activate a view by id, optionally show elements and/or zoom.",
  {
    viewId: z.number(),
    showElementIds: z.array(z.number()).optional(),
    bboxMinXyz: z.array(z.number()).length(3).optional(),
    bboxMaxXyz: z.array(z.number()).length(3).optional(),
    zoomToFit: z.boolean().default(false),
  },
  async (args) => {
    try {
      const data = await callRevit("/revit/activate-view", "POST", args);
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    } catch (e) { return { isError: true, content: [{ type: "text", text: String(e) }] }; }
  }
);

server.tool("revit_resolve_room_plan_view", "Resolve a room number to a best-matching plan view for the room's level.",
  {
    roomNumber: z.string(),
    preferViewNameContains: z.string().optional(),
    maxCandidates: z.number().default(10),
  },
  async (args) => {
    try {
      const data = await callRevit("/revit/resolve-room-plan-view", "POST", args);
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    } catch (e) { return { isError: true, content: [{ type: "text", text: String(e) }] }; }
  }
);

server.tool("revit_set_selection", "Set the current Revit UI selection by element id(s).",
  { elementIds: z.array(z.number()) },
  async (args) => {
    try {
      const data = await callRevit("/revit/set-selection", "POST", args);
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    } catch (e) { return { isError: true, content: [{ type: "text", text: String(e) }] }; }
  }
);

server.tool("revit_highlight_and_export", "Temporarily highlight element(s) in a view, export an image, and restore overrides.",
  {
    viewId: z.number().optional(),
    elementIds: z.array(z.number()),
    imageSize: z.number().default(2200),
    folder: z.string().optional(),
    highlightMode: z.string().default("temporary_override"),
    overrideStyle: z.object({
      lineWeight: z.number().optional(),
      r: z.number().optional(),
      g: z.number().optional(),
      b: z.number().optional(),
    }).optional(),
    focusElementIds: z.array(z.number()).optional().describe("Optional: crop the view to these elements for a focused export (rolled back after export)."),
    focusPaddingFt: z.number().optional().default(2.0),
  },
  async (args) => {
    try {
      const data = await callRevit("/revit/highlight-and-export", "POST", args);
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    } catch (e) { return { isError: true, content: [{ type: "text", text: String(e) }] }; }
  }
);

server.tool("revit_list_element_types", "List element types for a BuiltInCategory (e.g. 'OST_Doors').",
  {
    category: z.string(),
    nameContains: z.string().optional(),
    familyNameContains: z.string().optional(),
    limit: z.number().default(200),
  },
  async (args) => {
    try {
      const data = await callRevit("/revit/list-element-types", "POST", args);
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    } catch (e) { return { isError: true, content: [{ type: "text", text: String(e) }] }; }
  }
);

server.tool("revit_duplicate_element_type", "Duplicate an ElementType (e.g., create a 6\\\" wall cap type from an existing 4\\\" type).",
  {
    sourceTypeId: z.number(),
    newTypeName: z.string(),
    dryRun: z.boolean().optional().default(true),
  },
  async (args) => {
    try {
      const data = await callRevit("/revit/duplicate-element-type", "POST", args);
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    } catch (e) { return { isError: true, content: [{ type: "text", text: String(e) }] }; }
  }
);

server.tool("revit_set_type_parameters", "Set parameter values on an ElementType (supports dry-run).",
  {
    typeId: z.number(),
    changes: z.array(z.object({ parameterName: z.string(), value: z.string() })).min(1),
    dryRun: z.boolean().optional().default(true),
    confirm: z.string().optional(),
  },
  async (args) => {
    try {
      const data = await callRevit("/revit/set-type-parameters", "POST", args);
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    } catch (e) { return { isError: true, content: [{ type: "text", text: String(e) }] }; }
  }
);

server.tool("revit_duplicate_type_and_swap_instance", "Duplicate an instance's type, optionally update type params, then swap only that instance to the new type (supports dry-run).",
  {
    instanceId: z.number(),
    newTypeName: z.string(),
    typeParamChanges: z.array(z.object({ parameterName: z.string(), value: z.string() })).optional(),
    dryRun: z.boolean().optional().default(true),
    confirm: z.string().optional(),
  },
  async (args) => {
    try {
      const data = await callRevit("/revit/duplicate-type-and-swap-instance", "POST", args);
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    } catch (e) { return { isError: true, content: [{ type: "text", text: String(e) }] }; }
  }
);

server.tool("revit_change_element_type", "Change an element's type (e.g. swap a door instance from double to single).",
  {
    elementId: z.number(),
    typeId: z.number(),
  },
  async (args) => {
    try {
      const data = await callRevit("/revit/change-element-type", "POST", args);
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    } catch (e) { return { isError: true, content: [{ type: "text", text: String(e) }] }; }
  }
);

server.tool("revit_replace_door", "Replace a door instance with a different door type (can switch families).",
  {
    elementId: z.number(),
    newTypeId: z.number(),
    copyCommonParams: z.boolean().default(true),
    deleteOld: z.boolean().default(true),
  },
  async (args) => {
    try {
      const data = await callRevit("/revit/replace-door", "POST", args);
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    } catch (e) { return { isError: true, content: [{ type: "text", text: String(e) }] }; }
  }
);

server.tool("revit_query_elements", "Find elements by category.", 
  { category: z.string(), limit: z.number().default(100) }, 
  async ({ category, limit }) => {
    try {
      const data = await callRevit("/revit/query", "POST", { category, limit });
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    } catch (e) { return { isError: true, content: [{ type: "text", text: String(e) }] }; }
});

server.tool("revit_delete_elements", "Delete elements.", 
  { 
    ids: z.array(z.number()), 
    dryRun: z.boolean().default(false).describe("If true, simulates deletion and returns list of elements that WOULD be deleted.") 
  }, 
  async ({ ids, dryRun }) => {
    try {
      // API expects 'apply' which is !dryRun
      const data = await callRevit("/revit/delete", "POST", { ids, apply: !dryRun });
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    } catch (e) { return { isError: true, content: [{ type: "text", text: String(e) }] }; }
});

server.tool("revit_set_parameters", "Preview or update element parameters with optional expected-old-value preconditions and committed readback. Dry-run by default.",
  {
    changes: z.array(z.object({
      elementId: z.number().int().positive(),
      parameterName: z.string().min(1),
      value: z.string(),
      expectedOldValue: z.string().optional(),
      preserveTextCase: z.boolean().optional()
    })).min(1).max(100),
    apply: z.boolean().optional(),
    dryRun: z.boolean().optional(),
    confirm: z.string().optional(),
    excludeElementIds: z.array(z.number().int().positive()).max(200).optional(),
    preserveTextCase: z.boolean().optional()
  },
  async (args) => {
    try {
      const mode = canonicalWriteMode(args.apply, args.dryRun);
      const data = await callRevit("/revit/set-parameter", "POST", { ...args, ...mode });
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    } catch (e) { return { isError: true, content: [{ type: "text", text: String(e) }] }; }
});

server.tool("revit_get_element_summary", "Get a lightweight summary (id/category/name/bbox/location) for specific element ids.",
  { ids: z.array(z.number()) },
  async ({ ids }) => {
    try {
      // The Revit endpoint now prefers `elementIds` (legacy `ids` still supported).
      const data = await callRevit("/revit/get-element-summary", "POST", { elementIds: ids });
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    } catch (e) { return { isError: true, content: [{ type: "text", text: String(e) }] }; }
  }
);

server.tool("revit_move_elements", "Move element(s) by a translation vector (supports dry-run).",
  {
    ids: z.array(z.number()).min(1),
    dryRun: z.boolean().default(true),
    behavior: z.enum(["allOrNothing", "bestEffort"]).default("allOrNothing"),
    options: z.object({
      failOnPinned: z.boolean().default(true),
      unpinIfAllowed: z.boolean().default(false),
    }).optional(),
    // Preferred flat shape (matches /revit/move-elements request schema):
    mode: z.enum(["vector", "fromTo"]).optional(),
    vectorX: z.number().optional(),
    vectorY: z.number().optional(),
    vectorZ: z.number().optional(),
    fromX: z.number().optional(),
    fromY: z.number().optional(),
    fromZ: z.number().optional(),
    toX: z.number().optional(),
    toY: z.number().optional(),
    toZ: z.number().optional(),
    // Back-compat nested shape:
    move: z.discriminatedUnion("mode", [
      z.object({
        mode: z.literal("vector"),
        vectorX: z.number(),
        vectorY: z.number(),
        vectorZ: z.number(),
      }),
      z.object({
        mode: z.literal("fromTo"),
        fromX: z.number(),
        fromY: z.number(),
        fromZ: z.number(),
        toX: z.number(),
        toY: z.number(),
        toZ: z.number(),
      }),
    ]).optional(),
  },
  async (req: any) => {
    try {
      let movePayload: any = null;
      if (req?.move && typeof req.move === "object" && typeof req.move.mode === "string") {
        movePayload = req.move;
      } else if (typeof req?.mode === "string") {
        movePayload = {
          mode: req.mode,
          vectorX: req.vectorX,
          vectorY: req.vectorY,
          vectorZ: req.vectorZ,
          fromX: req.fromX,
          fromY: req.fromY,
          fromZ: req.fromZ,
          toX: req.toX,
          toY: req.toY,
          toZ: req.toZ,
        };
      }

      if (!movePayload || typeof movePayload.mode !== "string") {
        throw new Error("Move payload missing. Provide either flat mode/vector fields or move:{...}.");
      }

      const data = await callRevit("/revit/move-elements", "POST", {
        ids: req.ids,
        dryRun: req.dryRun,
        behavior: req.behavior,
        options: req.options,
        ...movePayload,
      });
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    } catch (e) { return { isError: true, content: [{ type: "text", text: String(e) }] }; }
  }
);

server.tool("revit_rotate_elements", "Rotate element(s) around an axis (supports dry-run).",
  {
    ids: z.array(z.number()).min(1),
    angleDegrees: z.number().describe("Rotation angle in degrees."),
    axis: z.object({
      mode: z.literal("zThroughPoint").default("zThroughPoint"),
      pointX: z.number(),
      pointY: z.number(),
      pointZ: z.number(),
    }),
    dryRun: z.boolean().default(true),
    behavior: z.enum(["allOrNothing", "bestEffort"]).default("allOrNothing"),
    options: z.object({
      failOnPinned: z.boolean().default(true),
      unpinIfAllowed: z.boolean().default(false),
    }).optional(),
  },
  async (req) => {
    try {
      const data = await callRevit("/revit/rotate-elements", "POST", req);
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    } catch (e) { return { isError: true, content: [{ type: "text", text: String(e) }] }; }
  }
);

server.tool("revit_room_contents", "Find element ids in a room/space by number (room-aware or geometry mode).",
  {
    roomNumber: z.string(),
    categories: z.array(z.string()).optional(),
    includeKeywords: z.array(z.string()).optional(),
    excludeKeywords: z.array(z.string()).optional(),
    includeLinked: z.boolean().default(false),
    mode: z.preprocess((value) => normalizeRoomContentsMode(value), z.enum(["auto", "roomAware", "geometry"]).default("auto")),
    verticalScope: z.preprocess((value) => normalizeRoomContentsVerticalScope(value), z.enum(["room", "plenum", "room+plenum"]).default("room")),
    spatialKindPreference: z.preprocess((value) => normalizeSpatialKindPreference(value), z.enum(["auto", "room", "space"]).default("auto")).describe("Resolve room number against Room first, Space first, or auto."),
    plenumMaxZ: z.number().optional().describe("Optional explicit maximum Z (feet) for verticalScope=plenum."),
    systemClassification: z.string().optional().describe("Optional system classification filter for MEP elements (e.g. Supply, Return, Exhaust, Any)."),
    includeConnectedOutsideRoom: z.boolean().default(false).describe("If true, include connected MEP elements that cross room boundaries."),
    limit: z.number().int().optional(),
  },
  async (req) => {
    try {
      const data = await callRevit("/revit/room-contents", "POST", req);
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    } catch (e) { return { isError: true, content: [{ type: "text", text: String(e) }] }; }
  }
);

server.tool("revit_find_elements", "Selector helper: find element ids by scope (viewId or sheetNumber) and filters.",
  {
    viewId: z.number().optional(),
    sheetNumber: z.string().optional(),
    includeSheetElements: z.boolean().optional(),
    category: z.string().optional(),
    categories: z.array(z.string()).optional(),
    typeNameContains: z.string().optional(),
    familyNameContains: z.string().optional(),
    nameContains: z.string().optional(),
    markContains: z.string().optional(),
    limit: z.number().int().optional(),
  },
  async (req) => {
    try {
      const data = await callRevit("/revit/find-elements", "POST", req);
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    } catch (e) { return { isError: true, content: [{ type: "text", text: String(e) }] }; }
  }
);

server.tool("revit_trace_connected_network", "Trace connected MEP elements via connectors starting from an element id.",
  {
    startElementId: z.number().describe("Element id to start from (duct, fitting, terminal, equipment)."),
    systemName: z.string().optional().describe("Optional system name filter. If omitted, can infer from start element."),
    inferSystemFromStart: z.boolean().optional().default(true),
    stopAtBranchFittings: z.boolean().optional().default(false).describe("Best-effort: stop traversal at duct fittings with 3+ connectors (tees/taps)."),
    stopAtTransitions: z.boolean().optional().default(false).describe("Best-effort: stop traversal at fittings with different connector sizes (reducers/transitions)."),
    includeSystemAudit: z.boolean().optional().default(false).describe("If true and a system name is known, also returns systemElementIds and disconnectedIds = systemIds - connectedIds."),
    systemAuditMaxElements: z.number().int().optional().default(20000).describe("Max system elements to consider for audit mode."),
    maxHops: z.number().int().optional().describe("Optional max graph distance from start (best-effort)."),
    excludeElementIds: z.array(z.number()).optional().describe("Ids to completely exclude from traversal/output."),
    stopAtElementIds: z.array(z.number()).optional().describe("Ids that are included but not traversed beyond."),
    stopAtCategories: z.array(z.string()).optional().describe("BuiltInCategory tokens or aliases to include-but-stop (e.g. duct_terminals)."),
    includeDucts: z.boolean().optional().default(true),
    includeFittings: z.boolean().optional().default(true),
    includeAccessories: z.boolean().optional().default(true),
    includeTerminals: z.boolean().optional().default(true),
    includeEquipment: z.boolean().optional().default(true),
    includeOtherCategories: z.boolean().optional().default(false),
    maxElements: z.number().int().optional().default(5000),
  },
  async (req) => {
    try {
      const data = await callRevit("/revit/trace-connected-network", "POST", req);
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    } catch (e) { return { isError: true, content: [{ type: "text", text: String(e) }] }; }
  }
);

server.tool("revit_find_elements_by_parameter", "Find elements by parameter value, with optional category/system/view filters.",
  {
    category: z.string().optional(),
    categories: z.array(z.string()).optional(),
    parameterName: z.string().describe("Parameter name to match (e.g. Diameter)."),
      op: z.string().optional().transform((value) => normalizeParameterMatchOp(value)),
    value: z.string().describe("Expected value (supports units for numeric params, e.g. 4\")."),
    systemName: z.string().optional().describe("Optional system name filter (exact match)."),
    viewId: z.number().optional().describe("Optional viewId to scope the collector."),
    limit: z.number().int().optional().default(2000),
  },
  async (req) => {
    try {
      const data = await callRevit("/revit/find-elements-by-parameter", "POST", req);
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    } catch (e) { return { isError: true, content: [{ type: "text", text: String(e) }] }; }
  }
);

server.tool("revit_sync_connected_sizes", "Best-effort: sync fitting/terminal sizes based on adjacent duct sizes (supports dry-run).",
  {
    startElementId: z.number().optional().describe("If provided, expands to connected network and syncs within it."),
    elementIds: z.array(z.number()).optional().describe("Optional explicit ids to attempt to sync."),
    mode: z.string().optional().default("duct->fittings->terminals"),
    dryRun: z.boolean().optional().default(true),
    resolveTypeDriven: z.enum(["auto", "duplicate", "skip"]).optional().default("skip").describe("When applying, optionally duplicate/swap types for type-driven fittings/terminals."),
    maxElements: z.number().int().optional().default(5000),
    confirm: z.string().optional().describe("Typed confirmation for large applies (see error.requiredConfirm)."),
  },
  async (req) => {
    try {
      const data = await callRevit("/revit/sync-connected-sizes", "POST", req);
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    } catch (e) { return { isError: true, content: [{ type: "text", text: String(e) }] }; }
  }
);

server.tool("revit_resize_duct_run", "Resize a connected round-duct run starting from a seed element (duct/fitting/terminal/equipment) up to best-effort boundaries (branches/transitions/terminations). Applies duct changes then syncs connected sizes (supports dry-run).",
  {
    startElementId: z.number(),
    targetDiameter: z.string().optional().describe("Target diameter with units (e.g. 6\\\" or 150mm). If omitted, provide targetDiameterFt."),
    targetDiameterFt: z.number().optional().describe("Target diameter in internal feet (e.g. 0.5 for 6 inches)."),
    systemName: z.string().optional(),
    inferSystemFromStart: z.boolean().optional().default(true),
    scope: z.enum(["run", "selectedOnly"]).optional().default("run"),
    stopAtBranchFittings: z.boolean().optional().default(true),
    stopAtTransitions: z.boolean().optional().default(true),
    includeTerminals: z.boolean().optional().default(true),
    includeEquipment: z.boolean().optional().default(true),
    eliminateTransitions: z.boolean().optional().default(false).describe("If true, attempts to resolve remaining transitions by resizing type-driven connected elements where possible."),
    maxElements: z.number().int().optional().default(5000),
    dryRun: z.boolean().optional().default(true),
    confirm: z.string().optional(),
  },
  async (req) => {
    try {
      const data = await callRevit("/revit/resize-duct-run", "POST", req);
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    } catch (e) { return { isError: true, content: [{ type: "text", text: String(e) }] }; }
  }
);

server.tool("revit_ducts_by_spatial_scope", "Resolve ductwork in a room/space scope with Room->Space->geometry fallback and optional size/system filtering.",
  {
    roomNumber: z.string().describe("Room/space query. Accepts values like '301' or 'office unit 301'."),
    systemClassification: z.string().optional().describe("Supply|Return|Exhaust|Any (best-effort exact match)."),
    sizeFrom: z.string().optional().describe("Optional current round size filter (e.g. 8\\\")."),
    verticalScope: z.enum(["room", "plenum", "room+plenum"]).optional().default("room+plenum"),
    includeCategories: z.array(z.enum(["Ducts", "Duct Fittings", "Air Terminals"])).optional().default(["Ducts", "Duct Fittings", "Air Terminals"]),
    roomMode: z.enum(["auto", "roomAware", "geometry"]).optional().default("auto").describe("auto tries roomAware then geometry."),
    includeConnectedOutsideRoom: z.boolean().optional().default(false),
    limit: z.number().int().optional().default(20000),
  },
  async (req) => {
    try {
      const data = await callRevit("/revit/ducts-by-spatial-scope", "POST", req);
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    } catch (e) {
      if (!isBridgeStatusError(e, 404)) return { isError: true, content: [{ type: "text", text: String(e) }] };

      try {
        const scopeOrder = normalizeScopeOrder(req.verticalScope);
        const modeOrder = normalizeRoomModeOrder(req.roomMode);
        const categories = normalizeDuctCategoriesForRoomContents(req.includeCategories);
        const idSet = new Set<number>();
        const attempts: any[] = [];

        for (const scope of scopeOrder) {
          for (const mode of modeOrder) {
            const roomReq = {
              roomNumber: req.roomNumber,
              categories,
              mode,
              verticalScope: scope,
              spatialKindPreference: "auto",
              systemClassification: req.systemClassification,
              includeConnectedOutsideRoom: !!req.includeConnectedOutsideRoom,
              limit: req.limit,
            };
            const roomData: any = await callRevit("/revit/room-contents", "POST", roomReq);
            const inRoom = Array.isArray(roomData?.elementIds) ? roomData.elementIds : [];
            const connected = Array.isArray(roomData?.connectedOutsideRoomIds) ? roomData.connectedOutsideRoomIds : [];
            for (const id of [...inRoom, ...connected]) {
              if (typeof id === "number" && Number.isFinite(id) && id > 0) idSet.add(id);
            }
            attempts.push({
              endpoint: "/revit/room-contents",
              mode,
              verticalScope: scope,
              matchedCount: inRoom.length + connected.length,
              result: roomData,
            });
            if (String(req.roomMode ?? "").toLowerCase() === "auto" && (inRoom.length + connected.length) > 0) break;
          }
        }

        const warnings = [
          "Fallback used because /revit/ducts-by-spatial-scope is unavailable in this Revit add-in build.",
        ];
        if (req.sizeFrom) warnings.push("Fallback does not enforce sizeFrom; use resize tool dry-run for exact size-filtered confirmation.");

        const data = {
          status: "Ok",
          endpoint: "/revit/ducts-by-spatial-scope",
          fallback: true,
          roomNumber: req.roomNumber,
          roomMode: req.roomMode,
          verticalScope: req.verticalScope,
          systemClassification: req.systemClassification,
          sizeFrom: req.sizeFrom,
          elementIds: Array.from(idSet).sort((a, b) => a - b),
          counts: { matchedCount: idSet.size },
          attempts,
          warnings,
        };
        return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
      } catch (fallbackErr) {
        return {
          isError: true,
          content: [{
            type: "text",
            text: `Primary and fallback discovery both failed. primary=${String(e)} fallback=${String(fallbackErr)}`,
          }],
        };
      }
    }
  }
);

server.tool("revit_resize_ducts_in_room", "Room-scoped MEP resize helper for ducts + connected fittings/terminals/equipment with room/space resolution.",
  {
    roomNumber: z.string(),
    roomMode: z.enum(["auto", "geometry", "roomAware"]).optional().default("auto"),
    verticalScope: z.enum(["room", "plenum", "auto", "room+plenum"]).optional().default("auto").describe("room=within room volume, plenum=above room to next/top level, auto=try room then plenum, room+plenum=apply both scopes."),
    plenumTopLevelName: z.string().optional().describe("Optional override level name used as plenum top when verticalScope includes plenum."),
    systemClassification: z.string().optional().describe("Supply|Return|Exhaust|Any (best-effort exact match)."),
    sizeFrom: z.string().optional().describe("Optional current size filter (e.g. 8\\\")."),
    sizeTo: z.string().describe("Target size (e.g. 10\\\")."),
    includeFittings: z.boolean().optional().default(true),
    includeTerminals: z.boolean().optional().default(true),
    includeEquipment: z.boolean().optional().default(true),
    stopAtBranchFittings: z.boolean().optional().default(true),
    resolveTypeDriven: z.enum(["auto", "duplicate", "skip"]).optional().default("auto"),
    eliminateTransitions: z.boolean().optional().default(false),
    verify: z.boolean().optional().default(false),
    dryRun: z.boolean().optional().default(true),
    maxElements: z.number().int().optional().default(5000),
    confirm: z.string().optional(),
  },
  async (req) => {
    try {
      const data = await callRevit("/revit/resize-ducts-in-room", "POST", req);
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    } catch (e) {
      // Compatibility fallback for older add-ins that reject roomMode=auto and/or verticalScope=room+plenum.
      if (!isBridgeStatusError(e, 400) && !isBridgeStatusError(e, 404)) {
        return { isError: true, content: [{ type: "text", text: String(e) }] };
      }

      try {
        const scopeOrder = normalizeScopeOrder(req.verticalScope);
        const roomModeOrder = normalizeRoomModeOrder(req.roomMode);
        const stopAfterFirstScopeHit = String(req.verticalScope ?? "").toLowerCase() === "auto";
        const attempts: any[] = [];
        let matchedCount = 0;
        let matchedAny = false;

        for (const scope of scopeOrder) {
          let scopeMatched = false;
          for (const mode of roomModeOrder) {
            const compatReq: any = {
              ...req,
              roomMode: mode,
              verticalScope: scope,
            };
            const result: any = await callRevit("/revit/resize-ducts-in-room", "POST", compatReq);
            const attemptMatched = parseMatchedCount(result);
            attempts.push({ verticalScope: scope, roomMode: mode, matchedCount: attemptMatched, result });
            matchedCount += attemptMatched;
            if (attemptMatched > 0) {
              scopeMatched = true;
              matchedAny = true;
              break;
            }
          }
          if (stopAfterFirstScopeHit && matchedAny) break;
          if (scopeMatched && scopeOrder.length === 1) break;
        }

        const data = {
          endpoint: "/revit/resize-ducts-in-room",
          fallback: true,
          status: req.dryRun ? "Dry Run" : "Applied",
          requested: { roomMode: req.roomMode, verticalScope: req.verticalScope },
          matchedCount,
          attempts,
          warnings: [
            "Fallback compatibility path used for resize-ducts-in-room.",
          ],
        };
        return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
      } catch (fallbackErr) {
        return {
          isError: true,
          content: [{
            type: "text",
            text: `Primary and compatibility fallback failed. primary=${String(e)} fallback=${String(fallbackErr)}`,
          }],
        };
      }
    }
  }
);

server.tool("revit_resize_ductwork_by_scope", "One-shot room/space ductwork resize by scope with fallback, fitting/terminal sync, continuity audit, and optional continuity repair.",
  {
    scope: z.object({
      roomNumber: z.string(),
      verticalScope: z.enum(["room", "plenum", "room+plenum"]).optional().default("room+plenum"),
      roomMode: z.enum(["auto", "roomAware", "geometry"]).optional().default("auto"),
    }),
    systemClassification: z.string().optional().describe("Supply|Return|Exhaust|Any (best-effort exact match)."),
    sizeFrom: z.string().optional().describe("Optional current size filter (e.g. 8\\\")."),
    sizeTo: z.string().describe("Target size (e.g. 10\\\")."),
    includeFittings: z.boolean().optional().default(true),
    includeTerminals: z.boolean().optional().default(true),
    resolveTypeDriven: z.enum(["auto", "duplicate", "skip"]).optional().default("duplicate"),
    repairContinuity: z.boolean().optional().default(false).describe("Run a best-effort continuity repair pass after resize."),
    continuityMaxGapFt: z.number().optional().default(1.5).describe("Max connector gap (feet) eligible for auto-repair bridging."),
    continuityMaxRepairs: z.number().int().optional().default(8).describe("Max continuity repair attempts in one call."),
    verify: z.boolean().optional().default(true),
    dryRun: z.boolean().optional().default(true),
    confirm: z.string().optional(),
    maxElements: z.number().int().optional().default(5000),
  },
  async (req) => {
    try {
      const data = await callRevit("/revit/resize-ductwork-by-scope", "POST", req);
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    } catch (e) {
      if (!isBridgeStatusError(e, 404)) return { isError: true, content: [{ type: "text", text: String(e) }] };

      try {
        const scopeOrder = normalizeScopeOrder(req.scope?.verticalScope);
        const roomModeOrder = normalizeRoomModeOrder(req.scope?.roomMode);
        const attempts: any[] = [];
        let matchedCount = 0;

        for (const scope of scopeOrder) {
          for (const mode of roomModeOrder) {
            const compatReq: any = {
              roomNumber: req.scope?.roomNumber,
              roomMode: mode,
              verticalScope: scope,
              systemClassification: req.systemClassification,
              sizeFrom: req.sizeFrom,
              sizeTo: req.sizeTo,
              includeFittings: req.includeFittings,
              includeTerminals: req.includeTerminals,
              includeEquipment: true,
              stopAtBranchFittings: true,
              resolveTypeDriven: req.resolveTypeDriven,
              eliminateTransitions: false,
              verify: req.verify,
              dryRun: req.dryRun,
              confirm: req.confirm,
              maxElements: req.maxElements,
            };
            const result: any = await callRevit("/revit/resize-ducts-in-room", "POST", compatReq);
            const attemptMatched = parseMatchedCount(result);
            attempts.push({ verticalScope: scope, roomMode: mode, matchedCount: attemptMatched, result });
            matchedCount += attemptMatched;
            if (String(req.scope?.roomMode ?? "").toLowerCase() === "auto" && attemptMatched > 0) break;
          }
        }

        const data = {
          endpoint: "/revit/resize-ductwork-by-scope",
          fallback: true,
          status: req.dryRun ? "Dry Run" : "Applied",
          scope: req.scope,
          systemClassification: req.systemClassification,
          sizeFrom: req.sizeFrom,
          sizeTo: req.sizeTo,
          matchedCount,
          attempts,
          warnings: [
            "Fallback used because /revit/resize-ductwork-by-scope is unavailable in this Revit add-in build.",
          ],
        };
        return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
      } catch (fallbackErr) {
        return {
          isError: true,
          content: [{
            type: "text",
            text: `Primary and fallback resize both failed. primary=${String(e)} fallback=${String(fallbackErr)}`,
          }],
        };
      }
    }
  }
);

server.tool("revit_repair_duct_continuity_by_scope", "Repair continuity breaks in room/plenum ductwork scope without resizing target diameter and report created-segment integrity.",
  {
    scope: z.object({
      roomNumber: z.string(),
      verticalScope: z.enum(["room", "plenum", "room+plenum"]).optional().default("room+plenum"),
      roomMode: z.enum(["auto", "roomAware", "geometry"]).optional().default("auto"),
    }),
    systemClassification: z.string().optional().describe("Supply|Return|Exhaust|Any (best-effort exact match)."),
    includeTerminals: z.boolean().optional().default(false).describe("Include terminals in continuity scope."),
    verify: z.boolean().optional().default(true),
    dryRun: z.boolean().optional().default(true),
    maxGapFt: z.number().optional().default(1.5).describe("Max connector gap eligible for auto-repair bridging."),
    maxRepairs: z.number().int().optional().default(8).describe("Max continuity repair attempts in one call."),
    maxElements: z.number().int().optional().default(5000),
  },
  async (req) => {
    try {
      const data = await callRevit("/revit/repair-duct-continuity-by-scope", "POST", req);
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    } catch (e) { return { isError: true, content: [{ type: "text", text: String(e) }] }; }
  }
);

const mepXyzSchema = () => z.array(z.number()).length(3);

const mepConnectorRefSchema = () => z.object({
  elementId: z.number(),
  connectorId: z.number(),
  expectedOriginXyz: mepXyzSchema().optional(),
  afterOriginXyz: mepXyzSchema().optional(),
});

const mepConnectorPairSchema = () => z.object({
  a: mepConnectorRefSchema(),
  b: mepConnectorRefSchema(),
});

const mepConnectorRepairSchema = z.object({
  kind: z.enum(["move_elements_vector", "set_curve_line", "set_flex_curve"]),
  elementIds: z.array(z.number()).min(1).optional(),
  vectorX: z.number().optional(),
  vectorY: z.number().optional(),
  vectorZ: z.number().optional(),
  elementId: z.number().optional(),
  startXyz: mepXyzSchema().optional(),
  endXyz: mepXyzSchema().optional(),
  flexPoints: z.array(mepXyzSchema()).min(2).optional(),
  startTangent: mepXyzSchema().optional(),
  endTangent: mepXyzSchema().optional(),
});

const mepConnectorRepairParams = (dryRunOnly: boolean) => ({
    expectedModelPath: z.string().min(1),
    disconnectOnlyPairs: z.array(mepConnectorPairSchema()).min(1).max(64).optional(),
    connectOpenPair: mepConnectorPairSchema().optional(),
    connectionKind: z.enum(["auto", "direct", "elbow", "transition"]).optional(),
    fittingWorksetName: z.string().optional(),
    fittingWorksetId: z.number().optional(),
    connectionMaxDistanceFt: z.number().positive().optional(),
    disconnectPairs: z.array(mepConnectorPairSchema()).min(1).max(64).optional(),
    repair: mepConnectorRepairSchema.optional(),
    allowConnectedRepair: z.boolean().optional().default(false),
    maxConnectorDistanceFt: z.number().positive().optional(),
    originToleranceFt: z.number().positive().optional().default(0.01),
    dryRun: dryRunOnly
      ? z.literal(true).optional().default(true)
      : z.boolean().optional().default(true),
    verify: z.boolean().optional().default(true),
});

function compactMepConnectorRepairReceipt(data: any): any {
  const compactSide = (side: any) => side && typeof side === "object" ? {
    elementId: side.elementId,
    connectorId: side.connectorId,
    connectorIdBasis: side.connectorIdBasis,
    origin: side.origin,
    domain: side.domain,
    shape: side.shape,
    systemClassification: side.systemClassification,
    systemName: side.systemName,
    physicalConnectedOwnerIds: side.physicalConnectedOwnerIds,
  } : side;
  const compactPairs = (pairs: any) => Array.isArray(pairs) ? pairs.map(pair => ({
    pairIndex: pair?.pairIndex,
    connected: pair?.connected,
    distanceFt: pair?.distanceFt,
    a: compactSide(pair?.a),
    b: compactSide(pair?.b),
  })) : pairs;
  return {
    status: data?.status,
    dryRun: data?.dryRun,
    transactionGroupRolledBack: data?.transactionGroupRolledBack,
    rollbackVerified: data?.rollbackVerified,
    beforePairs: compactPairs(data?.beforePairs),
    afterPairs: compactPairs(data?.afterPairs),
    finalPairs: compactPairs(data?.finalPairs),
    topologyExactMatch: data?.topologyExactMatch,
    connectorTopologyExactMatch: data?.connectorTopologyExactMatch,
    nativeFailures: data?.nativeFailures,
    auditedElementIds: data?.auditedElementIds,
    nextAction: data?.nextAction,
  };
}

async function runMepConnectorRepair(req: any, forceDryRun: boolean, compactResponse: boolean) {
  try {
    const modeCount =
      (req.disconnectOnlyPairs?.length ? 1 : 0) +
      (req.connectOpenPair ? 1 : 0) +
      (req.repair ? 1 : 0);
    if (modeCount !== 1) {
      throw new Error(
        "Connector repair requires exactly one mode: disconnectOnlyPairs, connectOpenPair, or repair (repair may include disconnectPairs)."
      );
    }
    if (req.disconnectPairs?.length && !req.repair) {
      throw new Error("disconnectPairs is valid only with repair.");
    }
    if (req.repair?.kind === "move_elements_vector") {
      if (
        !req.repair.elementIds?.length ||
        typeof req.repair.vectorX !== "number" ||
        typeof req.repair.vectorY !== "number" ||
        typeof req.repair.vectorZ !== "number"
      ) {
        throw new Error("move_elements_vector requires elementIds and vectorX/vectorY/vectorZ.");
      }
    } else if (req.repair?.kind === "set_curve_line") {
      if (
        typeof req.repair.elementId !== "number" ||
        !req.repair.startXyz ||
        !req.repair.endXyz
      ) {
        throw new Error("set_curve_line requires elementId, startXyz, and endXyz.");
      }
    } else if (req.repair?.kind === "set_flex_curve") {
      if (typeof req.repair.elementId !== "number" || !req.repair.flexPoints?.length) {
        throw new Error("set_flex_curve requires elementId and flexPoints.");
      }
    }
    const toNativePair = (pair: any) => ({ first: pair.a, second: pair.b });
    const nativeRequest = {
      ...req,
      dryRun: forceDryRun ? true : req.dryRun,
      verify: forceDryRun ? true : req.verify,
      ...(req.disconnectOnlyPairs
        ? { disconnectOnlyPairs: req.disconnectOnlyPairs.map(toNativePair) }
        : {}),
      ...(req.connectOpenPair
        ? { connectOpenPair: toNativePair(req.connectOpenPair) }
        : {}),
      ...(req.disconnectPairs
        ? { disconnectPairs: req.disconnectPairs.map(toNativePair) }
        : {}),
    };
    const data = await callRevit("/revit/repair-mep-connectors", "POST", nativeRequest);
    const response = compactResponse ? compactMepConnectorRepairReceipt(data) : data;
    return { content: [{ type: "text" as const, text: JSON.stringify(response, null, 2) }] };
  } catch (e) {
    return { isError: true, content: [{ type: "text" as const, text: String(e) }] };
  }
}

server.registerTool(
  "revit_repair_mep_connectors",
  {
    description: "Apply-capable exact native MEP connector disconnect/reconnect/reshape with rollback verification. Connector pairs use {a:{elementId,connectorId,expectedOriginXyz}, b:{...}}. Use exactly one mode: disconnectOnlyPairs, connectOpenPair, or repair (optionally with disconnectPairs). Use revit_dry_run_repair_mep_connectors for rollback-only trials.",
    inputSchema: mepConnectorRepairParams(false),
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
  },
  async req => runMepConnectorRepair(req, false, false)
);

server.registerTool(
  "revit_dry_run_repair_mep_connectors",
  {
    description: "Read-only rollback trial for exact native MEP connector disconnect/reconnect/reshape. Always forces dryRun=true and verify=true, returns compact before/after/final connector identity evidence, and never persists a model change. Connector pairs use exact keys a and b.",
    inputSchema: mepConnectorRepairParams(true),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  async req => runMepConnectorRepair(req, true, true)
);

server.tool("revit_get_connectors", "Get connector origins/sizes/directions for elements (ducts, fittings, terminals, equipment).",
  {
    elementIds: z.array(z.number()).min(1).max(5000),
    includeAllRefs: z.boolean().optional().default(true),
    includeCoordinateSystem: z.boolean().optional().default(true),
    maxConnectorsPerElement: z.number().int().optional().default(64),
  },
  async (req) => {
    try {
      const data = await callRevit("/revit/get-connectors", "POST", req);
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    } catch (e) { return { isError: true, content: [{ type: "text", text: String(e) }] }; }
  }
);

server.tool("revit_audit_electrical_circuit_loading", "Read evaluator-grade factual circuit membership, breaker, voltage, poles, wire-size, conductor-profile, and closed-scope load evidence without making a compliance claim.",
  {
    elementIds: z.array(z.number().int().positive()).min(1).max(5000).optional(),
    panelName: z.string().min(1).optional(),
    wireAmpacityProfiles: z.array(z.object({
      wireSizeToken: z.string().min(1),
      ampacityAmps: z.number().positive(),
    })).min(1).max(100),
    maxElements: z.number().int().positive().max(5000).optional().default(5000),
  },
  async (req) => {
    try {
      const data = await callRevit("/revit/audit-electrical-circuit-loading", "POST", req);
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    } catch (e) { return { isError: true, content: [{ type: "text", text: String(e) }] }; }
  }
);

server.tool("revit_audit_plumbing_fixture_services", "Read evaluator-grade level-scoped plumbing fixture connector, system-classification, size, and native Vent-system continuation evidence without making a compliance claim.",
  {
    levelName: z.string().min(1),
    familyMatchTokens: z.array(z.string().min(1)).min(1).max(100),
    typeMatchTokens: z.array(z.string().min(1)).min(1).max(100),
    maxElements: z.number().int().positive().max(5000).optional().default(5000),
    maxVentSearchElements: z.number().int().positive().max(10000).optional().default(2000),
    maxVentSearchHops: z.number().int().positive().max(500).optional().default(40),
  },
  async (req) => {
    try {
      const data = await callRevit("/revit/audit-plumbing-fixture-services", "POST", req);
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    } catch (e) { return { isError: true, content: [{ type: "text", text: String(e) }] }; }
  }
);

server.tool("revit_align_room_tops_to_ceilings", "Align room top elevation to the primary ceiling bottom elevation in each room (supports dry-run).",
  {
    roomNumbers: z.array(z.string()).optional(),
    levelNameContains: z.string().optional(),
    maxRooms: z.number().int().optional(),
    dryRun: z.boolean().default(true),
    behavior: z.enum(["allOrNothing", "bestEffort"]).default("bestEffort"),
    toleranceFt: z.number().optional(),
  },
  async (req) => {
    try {
      const data = await callRevit("/revit/align-room-tops-to-ceilings", "POST", req);
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    } catch (e) { return { isError: true, content: [{ type: "text", text: String(e) }] }; }
  }
);

const transactionActionSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("delete"), ids: z.array(z.number()) }),
  z.object({
    kind: z.literal("setParameters"),
    changes: z.array(z.object({ elementId: z.number(), parameterName: z.string(), value: z.string() })),
  }),
  z.object({
    kind: z.literal("placeFamilies"),
    levelName: z.string(),
    familyName: z.string().optional(),
    symbolName: z.string(),
    instances: z.array(z.object({
      x: z.number(),
      y: z.number(),
      z: z.number(),
      parameters: z.record(z.string()).optional(),
    })),
  }),
]);

server.tool("revit_transaction_plan", "Plan actions in a rolled-back transaction; returns impact + warnings.",
  { actions: z.array(transactionActionSchema) },
  async ({ actions }) => {
    try {
      const data = await callRevit("/revit/transaction-plan", "POST", { actions });
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    } catch (e) { return { isError: true, content: [{ type: "text", text: String(e) }] }; }
  }
);

server.tool("revit_transaction_apply", "Apply actions in a committed transaction group; returns success + transactionId.",
  { actions: z.array(transactionActionSchema) },
  async ({ actions }) => {
    try {
      const data = await callRevit("/revit/transaction-apply", "POST", { actions });
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    } catch (e) { return { isError: true, content: [{ type: "text", text: String(e) }] }; }
  }
);

const transactionCheckSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("exists"), elementId: z.number() }),
  z.object({ kind: z.literal("notExists"), elementId: z.number() }),
  z.object({
    kind: z.literal("parameterEquals"),
    elementId: z.number(),
    parameterName: z.string(),
    expectedValue: z.string(),
  }),
]);

server.tool("revit_transaction_validate", "Validate post-conditions after apply (exists/notExists/parameterEquals).",
  { transactionId: z.string(), checks: z.array(transactionCheckSchema).default([]) },
  async (args) => {
    try {
      const data = await callRevit("/revit/transaction-validate", "POST", args);
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    } catch (e) { return { isError: true, content: [{ type: "text", text: String(e) }] }; }
  }
);

server.tool("revit_create_sheet", "Create a new sheet.", 
  { name: z.string().optional(), number: z.string().optional(), titleBlockId: z.number().default(-1) },
  async (args) => {
    try {
      const data = await callRevit("/revit/create-sheet", "POST", args);
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    } catch (e) { return { isError: true, content: [{ type: "text", text: String(e) }] }; }
});

server.tool("revit_place_view", "Place a view on a sheet.", 
  { sheetId: z.number(), viewId: z.number(), x: z.number().default(0), y: z.number().default(0) },
  async (args) => {
    try {
      const data = await callRevit("/revit/place-view", "POST", args);
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    } catch (e) { return { isError: true, content: [{ type: "text", text: String(e) }] }; }
});

server.tool("revit_create_text", "Create a text note on a view/sheet.",
  {
    viewId: z.number().describe("The ID of the View or Sheet."),
    x: z.number().describe("X coordinate in view space (feet)."),
    y: z.number().describe("Y coordinate in view space (feet)."),
    text: z.string().describe("The text content."),
    typeId: z.number().optional().describe("Optional TextNoteType ID.")
  },
  async (args) => {
    try {
      const data = await callRevit("/revit/create-text", "POST", args);
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    } catch (e) { return { isError: true, content: [{ type: "text", text: String(e) }] }; }
});

server.tool("revit_create_duct", "Create a duct segment.", 
  { 
    levelName: z.string(), 
    startX: z.number(), startY: z.number(), startZ: z.number(),
    endX: z.number(), endY: z.number(), endZ: z.number(),
    systemType: z.string().optional(), ductType: z.string().optional(),
    dryRun: z.boolean().default(false).describe("If true, simulates creation and returns expected result without applying changes.")
  },
  async (args) => {
    try {
      const data = await callRevit("/revit/create-duct", "POST", args);
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    } catch (e) { return { isError: true, content: [{ type: "text", text: String(e) }] }; }
});

server.tool("revit_create_pipe", "Create a pipe segment.", 
  { 
    levelName: z.string(), 
    startX: z.number(), startY: z.number(), startZ: z.number(),
    endX: z.number(), endY: z.number(), endZ: z.number(),
    systemType: z.string().optional(), pipeType: z.string().optional()
  },
  async (args) => {
    try {
      const data = await callRevit("/revit/create-pipe", "POST", args);
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    } catch (e) { return { isError: true, content: [{ type: "text", text: String(e) }] }; }
});

server.tool("revit_get_parameters", "Get all parameters of an element.", 
  { elementId: z.number() },
  async (args) => {
    try {
      const data = await callRevit("/revit/get-parameters", "POST", args);
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    } catch (e) { return { isError: true, content: [{ type: "text", text: String(e) }] }; }
});

server.tool("revit_create_family_instance", "Place a family instance (e.g. equipment).",
  {
    familyName: z.string().optional(),
    symbolName: z.string(),
    levelName: z.string().optional(),
    x: z.number(), y: z.number(), z: z.number()
  },
  async (args) => {
    try {
      const data = await callRevit("/revit/create-family-instance", "POST", args);
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    } catch (e) { return { isError: true, content: [{ type: "text", text: String(e) }] }; }
});

server.tool("revit_place_families", "Batch place family instances with dry-run, idempotency, rotation, and per-instance reporting.",
  {
    levelName: z.string(),
    familyName: z.string().optional(),
    symbolName: z.string(),
    instances: z.array(z.object({
      x: z.number(),
      y: z.number(),
      z: z.number(),
      rotationDegrees: z.number().optional(),
      hostElementId: z.number().optional(),
      parameters: z.record(z.string()).optional(),
    })),
    dryRun: z.boolean().default(false),
    idempotency: z.object({
      enabled: z.boolean().default(true),
      toleranceFt: z.number().default(0.01),
    }).default({}),
    behavior: z.enum(["allOrNothing", "bestEffort"]).default("allOrNothing"),
  },
  async (args) => {
    try {
      const data = await callRevit("/revit/place-families", "POST", args);
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    } catch (e) { return { isError: true, content: [{ type: "text", text: String(e) }] }; }
  }
);

server.tool("revit_load_family", "Load a .rfa family file into the active project document.",
  {
    filePath: z.string().describe("Full path to the .rfa file."),
    overwriteParameterValues: z.boolean().default(false),
  },
  async (args) => {
    try {
      const data = await callRevit("/revit/load-family", "POST", args);
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    } catch (e) { return { isError: true, content: [{ type: "text", text: String(e) }] }; }
  }
);

server.tool("revit_create_family_from_template", "Create a new .rfa from a family template file and optionally load it into the active project (minimal v1).",
  {
    templatePath: z.string().describe("Full path to the Revit family template (.rft)."),
    savePath: z.string().describe("Full path where the new .rfa should be saved."),
    overwriteExistingFile: z.boolean().default(false),
    loadIntoProject: z.boolean().default(false),
    overwriteParameterValuesOnLoad: z.boolean().default(false),
  },
  async (args) => {
    try {
      const data = await callRevit("/revit/create-family-from-template", "POST", args);
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    } catch (e) { return { isError: true, content: [{ type: "text", text: String(e) }] }; }
  }
);

server.tool("revit_set_view_visibility", "Control view visibility and templates.",
  {
    viewId: z.number(),
    action: z.enum(["get", "set_template", "hide_category", "show_category"]).describe("Action to perform."),
    templateName: z.string().optional().describe("If setting template, the name."),
    categoryName: z.string().optional().describe("If hiding/showing category, the BuiltInCategory name (e.g. OST_Roofs).")
  },
  async (args) => {
    try {
      const data = await callRevit("/revit/visibility", "POST", args);
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    } catch (e) { return { isError: true, content: [{ type: "text", text: String(e) }] }; }
});

server.tool("revit_create_drafting_view", "Create (or reuse) a Drafting View by name.",
  {
    name: z.string().describe("Drafting view name."),
    scale: z.number().int().optional().describe("Optional view scale (e.g. 48)."),
    allowExisting: z.boolean().default(true).describe("If true, reuse an existing Drafting View with the same name."),
  },
  async (args) => {
    try {
      const data = await callRevit("/revit/create-drafting-view", "POST", args);
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    } catch (e) { return { isError: true, content: [{ type: "text", text: String(e) }] }; }
  }
);

server.tool("revit_draw_detail_curves", "Draw detail curves in a view (lines/polylines/arcs).",
  {
    viewId: z.number(),
    frameId: z.string().optional().describe("Optional frameId from /revit/export-view-frame (enables xPx/yPx points)."),
    lineStyleName: z.string().optional().describe("Optional Revit line style name (subcategory under Lines)."),
    curves: z.array(z.any()).describe("Curve specs. Each item: {kind:\"line\",a,b} | {kind:\"polyline\",points:[...]} | {kind:\"arc\",a,b,c}. Points support xyz (feet), xPx/yPx (with frameId), or xIn/yIn (inches)."),
    dryRun: z.boolean().default(false),
  },
  async (args) => {
    try {
      const data = await callRevit("/revit/draw-detail-curves", "POST", args);
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    } catch (e) { return { isError: true, content: [{ type: "text", text: String(e) }] }; }
  }
);

server.tool("revit_create_filled_region", "Create a filled region from one or more closed loops.",
  {
    viewId: z.number(),
    frameId: z.string().optional(),
    typeName: z.string().optional().describe("Optional FilledRegionType name."),
    loops: z.array(z.any()).describe("Loop specs: [{points:[...]}] where points support xyz, xPx/yPx, or xIn/yIn."),
    dryRun: z.boolean().default(false),
  },
  async (args) => {
    try {
      const data = await callRevit("/revit/create-filled-region", "POST", args);
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    } catch (e) { return { isError: true, content: [{ type: "text", text: String(e) }] }; }
  }
);

server.tool("revit_create_revision_cloud", "Create a revision cloud from a polyline/loop in a view.",
  {
    viewId: z.number(),
    frameId: z.string().optional(),
    points: z.array(z.any()).describe("Polyline points; supports xyz, xPx/yPx, or xIn/yIn."),
    revisionId: z.number().optional().describe("Optional Revision element id; if omitted, uses latest revision."),
    closed: z.boolean().default(true),
    dryRun: z.boolean().default(false),
  },
  async (args) => {
    try {
      const data = await callRevit("/revit/create-revision-cloud", "POST", args);
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    } catch (e) { return { isError: true, content: [{ type: "text", text: String(e) }] }; }
  }
);

server.tool("revit_import_excel_table", "Import an .xlsx range into a drafting view as a grid + text notes.",
  {
    sourcePath: z.string().describe("Workspace-relative path to the .xlsx file (e.g. artifacts/uploads/table.xlsx)."),
    sheetName: z.string().optional().describe("Worksheet name (default: first sheet)."),
    range: z.string().describe("A1 range like A1:G40."),
    viewId: z.number().optional().describe("Optional target view id."),
    viewName: z.string().optional().describe("Optional drafting view name (created if needed)."),
    textTypeName: z.string().optional().describe("Optional TextNoteType name to use."),
    lineStyleName: z.string().optional().describe("Optional line style name (subcategory under Lines)."),
    cellWidthInches: z.number().optional(),
    cellHeightInches: z.number().optional(),
    marginInches: z.number().optional(),
    startXInches: z.number().optional(),
    startYInches: z.number().optional(),
    sheetNumber: z.string().optional().describe("Optional sheet number to place the drafting view on."),
    sheetViewId: z.number().optional().describe("Optional sheet view id to place the drafting view on."),
    dryRun: z.boolean().default(false),
  },
  async (args) => {
    try {
      const data = await callRevit("/revit/import-excel-table", "POST", args);
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    } catch (e) { return { isError: true, content: [{ type: "text", text: String(e) }] }; }
  }
);

server.tool("revit_link_cad", "Link (or import) a DWG onto a sheet view. External paths require OPERATOR_ALLOWED_EXTERNAL_ROOTS.",
  {
    sourcePath: z.string().describe("Workspace-relative path OR approved external absolute path to .dwg."),
    sheetNumber: z.string().optional().describe("Target sheet number (e.g. A1.00)."),
    sheetViewId: z.number().optional().describe("Target sheet view id."),
    placement: z.enum(["origin", "center"]).optional().default("origin"),
    link: z.boolean().optional().default(true),
    dryRun: z.boolean().default(false),
  },
  async (args) => {
    try {
      const data = await callRevit("/revit/link-cad", "POST", args);
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    } catch (e) { return { isError: true, content: [{ type: "text", text: String(e) }] }; }
  }
);

server.tool("revit_place_image", "Place an image (.png/.jpg) onto a sheet view.",
  {
    sourcePath: z.string().describe("Workspace-relative path to the image (e.g. artifacts/uploads/redline.png)."),
    sheetNumber: z.string().optional(),
    sheetViewId: z.number().optional(),
    placement: z.enum(["origin", "center"]).optional().default("origin"),
    xInches: z.number().optional(),
    yInches: z.number().optional(),
    widthInches: z.number().optional(),
    heightInches: z.number().optional(),
    dryRun: z.boolean().default(false),
  },
  async (args) => {
    try {
      const data = await callRevit("/revit/place-image", "POST", args);
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    } catch (e) { return { isError: true, content: [{ type: "text", text: String(e) }] }; }
  }
);

server.tool("revit_export_pdf", "Export views/sheets to PDF.",
  {
    viewIds: z.array(z.number()).optional().describe("Optional explicit view/sheet IDs (order is preserved when provided)."),
    fileName: z.string().optional().describe("Legacy output filename (without path)."),
    sheetQuery: z.string().optional().describe("Convenience: export sheets by Sheet Number prefix (e.g. M1 or M1*)."),
    sheetNumberPrefix: z.string().optional().describe("Export sheets whose Sheet Number starts with this prefix (e.g. M1)."),
    all: z.boolean().optional().describe("If true, select up to 500 matches when using selector/prefix."),
    max: z.number().int().optional().describe("Legacy alias for selector.max (when selector isn't provided)."),
    combine: z.boolean().optional().describe("If true, produce one bound PDF. If false, export one PDF per sheet/view."),
    outputFolder: z.string().optional().describe("Workspace-relative output folder (default artifacts/prints), or an absolute folder under the current user's Documents, Desktop, or Downloads."),
    baseFileName: z.string().optional().describe("For combined output: base filename without extension."),
    perSheetFileNameTemplate: z.string().optional().describe("For individual output: template like {sheetNumber}_{sheetName}."),
    colorMode: z.enum(["Color", "Grayscale", "BlackLine"]).optional(),
    dryRun: z.boolean().optional(),
    selector: z.object({
      query: z.string().optional(),
      exact: z.boolean().optional(),
      max: z.number().int().optional(),
      sheetNumberPrefixes: z.array(z.string()).optional(),
      nameIncludes: z.array(z.string()).optional()
    }).passthrough().optional().describe("Advanced selector: combine prefixes, name includes, and query.")
  },
  async (args) => {
    try {
      const data = addWorkspaceLinks(await callRevit("/revit/export-pdf", "POST", args) as any);
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    } catch (e) { return { isError: true, content: [{ type: "text", text: String(e) }] }; }
});

server.tool(
  "print_sheets",
  "Print/export sheets by set (e.g. 'mechanical sheets') or by query (e.g. M*, M100 series, M1xx, title:Lighting). Defaults to dryRun=true so you can confirm matches before exporting.",
  {
    query: z.string(),
    mode: z.enum(["bound", "individual"]).default("bound"),
    setName: z.string().optional(),
    outputFolder: z.string().optional(),
    fileNameTemplate: z.string().default("{project}_{setName}_{yyyyMMdd}"),
    individualTemplate: z.string().default("{sheetNumber}_{sheetName}"),
    color: z.boolean().default(true),
    dryRun: z.boolean().default(true)
  },
  async (args) => {
    try {
      const result = await runPrintSheets(args);
      const enriched = addWorkspaceLinks(result as any);
      return { content: [{ type: "text", text: JSON.stringify(enriched, null, 2) }] };
    } catch (e) {
      return { isError: true, content: [{ type: "text", text: String(e) }] };
    }
  }
);

server.tool("revit_get_lighting_data", "Get photometrics/IES data from lighting fixtures.",
  {
    elementId: z.number().optional().describe("Specific element to check."),
    familyName: z.string().optional().describe("Scan all types in this family.")
  },
  async (args) => {
    try {
      const data = await callRevit("/revit/get-lighting-data", "POST", args);
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    } catch (e) { return { isError: true, content: [{ type: "text", text: String(e) }] }; }
});

server.tool("revit_sync_model", "Synchronize with Central and Relinquish All.",
  {
    comment: z.string().optional().default("Synced by Revit Operator").describe("Sync comment."),
    compact: z.boolean().default(false).describe("Compact central file.")
  },
  async (args) => {
    try {
      const data = await callRevit("/revit/sync", "POST", args);
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    } catch (e) { return { isError: true, content: [{ type: "text", text: String(e) }] }; }
});

server.tool("revit_open_model", "Open a Revit model file.",
  {
    filePath: z.string().describe("Full path to the .rvt file."),
    audit: z.boolean().default(false).describe("Audit the model on open."),
    detach: z.boolean().default(false).describe("Detach from central.")
  },
  async (args) => {
    try {
      const data = await callRevit("/revit/open-model", "POST", args);
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    } catch (e) { return { isError: true, content: [{ type: "text", text: String(e) }] }; }
});

// New Resolution Tools
server.tool("revit_resolve_level", "Find a level by name.", 
  { name: z.string() }, 
  async ({ name }) => {
    try {
      const data = await callRevit("/revit/resolve", "POST", { type: "level", query: name });
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    } catch (e) { return { isError: true, content: [{ type: "text", text: String(e) }] }; }
});

server.tool("revit_resolve_view", "Find a view by name.", 
  { name: z.string() }, 
  async ({ name }) => {
    try {
      const data = await callRevit("/revit/resolve", "POST", { type: "view", query: name });
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    } catch (e) { return { isError: true, content: [{ type: "text", text: String(e) }] }; }
});

server.tool("revit_resolve_sheet", "Find a sheet by name or number.", 
  { query: z.string() }, 
  async ({ query }) => {
    try {
      const data = await callRevit("/revit/resolve", "POST", { type: "sheet", query: query });
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    } catch (e) { return { isError: true, content: [{ type: "text", text: String(e) }] }; }
});

// New Room Tools
server.tool("revit_list_rooms", "List rooms, optionally filtered by level.", 
  { levelName: z.string().optional() }, 
  async ({ levelName }) => {
    try {
      const data = await callRevit("/revit/rooms", "POST", { action: "list", levelName });
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    } catch (e) { return { isError: true, content: [{ type: "text", text: String(e) }] }; }
});

server.tool("revit_get_room_details", "Get detailed geometry/metrics for specific rooms.", 
  { roomIds: z.array(z.number()) }, 
  async ({ roomIds }) => {
    try {
      const data = await callRevit("/revit/rooms", "POST", { action: "detail", roomIds });
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    } catch (e) { return { isError: true, content: [{ type: "text", text: String(e) }] }; }
});

// --- Skills ---

server.tool(
  "revit_auto_dimension_floor_plan",
  "Duplicate a floor plan view and auto-dimension it (architect preset by default).",
  {
    sourceViewName: z.string().optional().describe("Name of the source floor plan view."),
    sourceViewId: z.number().optional().describe("ID of the source floor plan view (overrides name)."),
    targetViewName: z.string().optional().describe("Optional name for the new view."),
    overwriteTarget: z.boolean().default(true).describe("If targetViewName exists, delete it first."),
    captureImages: z.boolean().default(true).describe("Export before/after images into the run folder."),
    imageSize: z.number().default(6000).describe("Export image pixel size (square)."),
    passes: z.number().default(1).describe("Number of plan/apply passes (1-6)."),
    preset: z.enum(["architect", "coverage"]).default("architect"),
    includeDenseSlices: z.boolean().optional(),
    includeTileSlices: z.boolean().optional(),
    includeAdjacent: z.boolean().optional(),
    includeCorridors: z.boolean().optional(),
    corridorSampleCount: z.number().optional(),
    includeWallRepair: z.boolean().optional(),
    enforceRoomConstraints: z.boolean().optional(),
    roomMaxGroups: z.number().optional(),
    targetWallCoverage: z.number().optional(),
    maxDimensions: z.number().optional(),
  },
  async (args) => {
    try {
      const report = await runAutoDimFloorPlan({
        sourceViewName: args.sourceViewName,
        sourceViewId: args.sourceViewId,
        targetViewName: args.targetViewName,
        overwriteTarget: args.overwriteTarget,
        captureImages: args.captureImages,
        imageSize: args.imageSize,
        passes: args.passes,
        options: {
          preset: args.preset,
          respectExistingDimensions: true,
          globalsMode: "ifEmpty",
          roomMode: "bbox",
          includeAdjacent: args.includeAdjacent,
          includeDenseSlices: args.includeDenseSlices,
          includeTileSlices: args.includeTileSlices,
          includeCorridors: args.includeCorridors,
          corridorSampleCount: args.corridorSampleCount,
          includeWallRepair: args.includeWallRepair,
          enforceRoomConstraints: args.enforceRoomConstraints,
          roomMaxGroups: args.roomMaxGroups,
          targetWallCoverage: args.targetWallCoverage,
          maxDimensions: args.maxDimensions,
        } as any,
      });
      return { content: [{ type: "text", text: JSON.stringify(report, null, 2) }] };
    } catch (e) {
      return { isError: true, content: [{ type: "text", text: String(e) }] };
    }
  }
);

server.tool("revit_run_room_audit", "Run a room audit on a specific level.", 
  { levelName: z.string() }, 
  async ({ levelName }) => {
    try {
      const result = await runRoomAudit(levelName);
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    } catch (e) { return { isError: true, content: [{ type: "text", text: String(e) }] }; }
});

server.tool("revit_run_load_calc", "Run a load calculation snapshot (V0).", 
  { levelName: z.string(), ach: z.number().default(6) }, 
  async ({ levelName, ach }) => {
    try {
      const result = await runLoadCalcSnapshot(levelName, ach);
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    } catch (e) { return { isError: true, content: [{ type: "text", text: String(e) }] }; }
});

server.tool("revit_run_door_fire_rating_check", "Perform a project-wide fire rating audit (Rooms & Doors).", {}, async () => {
  try {
    const result = await runDoorFireRatingCheck();
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  } catch (e) { return { isError: true, content: [{ type: "text", text: String(e) }] }; }
});

server.tool("revit_quantify", "Count or list elements using natural language (e.g. 'How many toilets on Level 1?').",
  { query: z.string() },
  async ({ query }) => {
    try {
      const result = await runQuantify(query);
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    } catch (e) { return { isError: true, content: [{ type: "text", text: String(e) }] }; }
});

server.tool("revit_run_thermal_zoning", "Generate thermal zones and sheets (e.g. 'Create thermal zoning for Level 1').",
  { query: z.string() },
  async ({ query }) => {
    try {
      const result = await runThermalZoning(query);
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    } catch (e) { return { isError: true, content: [{ type: "text", text: String(e) }] }; }
});

server.tool("revit_place_vavs", "Auto-place VAV boxes for thermal zones (e.g. 'Place VAVs on Level 1').",
  { query: z.string() },
  async ({ query }) => {
    try {
      const result = await runPlaceVAVs(query);
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    } catch (e) { return { isError: true, content: [{ type: "text", text: String(e) }] }; }
});

server.tool("revit_run_code_check", "Run code compliance checks (ADA/FGI) on rooms (e.g. 'Check ADA compliance on Level 1').",
  { query: z.string() },
  async ({ query }) => {
    try {
      const result = await runCodeCompliance(query);
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    } catch (e) { return { isError: true, content: [{ type: "text", text: String(e) }] }; }
});

server.tool("revit_fire_alarm_layout", "Place fire alarm devices and optionally create uncovered coverage markers (MVP).",
  {
    runConfigPath: z.string(),
    deviceMappingsPath: z.string().optional(),
    levelName: z.string().optional(),
    viewId: z.number().optional(),
    runId: z.string().optional(),
    dryRun: z.boolean().default(false),
    createVisualizer: z.boolean().default(true),
  },
  async (args) => {
    try {
      const data = await callRevit("/revit/fire-alarm-layout", "POST", args);
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    } catch (e) { return { isError: true, content: [{ type: "text", text: String(e) }] }; }
  }
);

server.tool("revit_fire_alarm_visualizer", "Show/hide/clear Fire Alarm visualizer markers in a view (MVP).",
  {
    viewId: z.number(),
    action: z.enum(["show", "hide", "clear"]),
    runId: z.string().optional(),
    layers: z.array(z.string()).optional(),
  },
  async (args) => {
    try {
      const data = await callRevit("/revit/fire-alarm-visualizer", "POST", args);
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    } catch (e) { return { isError: true, content: [{ type: "text", text: String(e) }] }; }
  }
);

server.tool("revit_run_fire_alarm_layout", "Run Fire Alarm layout with artifacts (report CSV/JSON + optional view capture).",
  {
    runConfigPath: z.string(),
    deviceMappingsPath: z.string().optional(),
    levelName: z.string().optional(),
    viewId: z.number().optional(),
    runId: z.string().optional(),
    dryRun: z.boolean().default(false),
    createVisualizer: z.boolean().default(true),
    captureImage: z.boolean().default(true),
    imageSize: z.number().default(2600),
    writeWorkIteration: z.boolean().default(true),
  },
  async (args) => {
    try {
      const result = await runFireAlarmLayout(args);
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    } catch (e) { return { isError: true, content: [{ type: "text", text: String(e) }] }; }
  }
);

registerAuditedZodTool(fireDamperAudit.name, fireDamperAudit.description, fireDamperAuditInputSchema, handleFireDamperAudit);

lightingAuditTools.forEach(tool => {
  registerAuditedZodTool(tool.name, tool.description, tool.inputSchema, (args: any) => handleLightingAudit(tool.name, args));
});

// --- Workspace Tools (artifacts only) ---

server.tool(
  "workspace_rename_file",
  "POST /workspace/rename-file — Rename/move a file under Workspace/artifacts/**.",
  {
    from: z.string().describe("Source path under Workspace/artifacts/** (e.g. artifacts/prints/A2_Series.pdf)."),
    to: z.string().describe("Destination path under Workspace/artifacts/**."),
    overwrite: z.boolean().default(false).describe("If true, replace destination if it already exists."),
  },
  async ({ from, to, overwrite }) => {
    try {
      auditLog("workspace.rename_file", {
        from,
        to,
        overwrite,
        from_full: resolveExistingPathUnderWorkspaceArtifacts(from),
        to_full: resolvePathUnderWorkspaceArtifacts(to),
      });
      const result = renameFileUnderWorkspaceArtifacts({ from, to, overwrite });
      return { content: [{ type: "text", text: JSON.stringify({ status: "Success", ...result }, null, 2) }] };
    } catch (e) {
      return { isError: true, content: [{ type: "text", text: String(e) }] };
    }
  }
);

server.tool(
  "workspace_pdf_reorder",
  "POST /workspace/pdf-reorder — Reorder pages in a PDF under Workspace/artifacts/** (pageOrder is 1-based).",
  {
    input: z.string().describe("Input PDF path under Workspace/artifacts/**."),
    output: z.string().describe("Output PDF path under Workspace/artifacts/**."),
    pageOrder: z.array(z.number().int()).describe("1-based permutation of all pages (e.g. [1,2,5,3,4])."),
  },
  async ({ input, output, pageOrder }) => {
    try {
      auditLog("workspace.pdf_reorder", {
        input,
        output,
        input_full: resolveExistingPathUnderWorkspaceArtifacts(input),
        output_full: resolvePathUnderWorkspaceArtifacts(output),
        page_order_len: pageOrder.length,
      });
      const result = await reorderPdfUnderWorkspaceArtifacts({ input, output, pageOrder });
      return { content: [{ type: "text", text: JSON.stringify({ status: "Success", ...result }, null, 2) }] };
    } catch (e) {
      return { isError: true, content: [{ type: "text", text: String(e) }] };
    }
  }
);

server.tool(
  "workspace_pdf_merge",
  "POST /workspace/pdf-merge — Merge multiple PDFs under Workspace/artifacts/** into a single output.",
  {
    inputs: z.array(z.string()).min(2).describe("Input PDF paths under Workspace/artifacts/**."),
    output: z.string().describe("Output PDF path under Workspace/artifacts/**."),
  },
  async ({ inputs, output }) => {
    try {
      auditLog("workspace.pdf_merge", {
        inputs,
        output,
        inputs_full: inputs.map((p) => resolveExistingPathUnderWorkspaceArtifacts(p)),
        output_full: resolvePathUnderWorkspaceArtifacts(output),
      });
      const result = await mergePdfsUnderWorkspaceArtifacts({ inputs, output });
      return { content: [{ type: "text", text: JSON.stringify({ status: "Success", ...result }, null, 2) }] };
    } catch (e) {
      return { isError: true, content: [{ type: "text", text: String(e) }] };
    }
  }
);

// --- Office/File Tools ---

server.tool("read_excel", "Read data from an Excel file.", 
  { filePath: z.string(), sheetName: z.string().optional() },
  async ({ filePath, sheetName }) => {
    try {
      const fullPath = resolveExistingFileUnderWorkspace(filePath);
      const workbook = xlsx.readFile(fullPath);
      const sheet = sheetName ? workbook.Sheets[sheetName] : workbook.Sheets[workbook.SheetNames[0]];
      if (!sheet) throw new Error("Sheet not found");
      const data = xlsx.utils.sheet_to_json(sheet);
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    } catch (e) { return { isError: true, content: [{ type: "text", text: String(e) }] }; }
});

server.tool("write_excel", "Write data to an Excel file.", 
  { filePath: z.string(), sheetName: z.string().default("Sheet1"), data: z.array(z.record(z.any())) },
  async ({ filePath, sheetName, data }) => {
    try {
      const fullPath = resolveFileUnderWorkspace(filePath);
      try { fs.mkdirSync(path.dirname(fullPath), { recursive: true }); } catch { /* ignore */ }
      const workbook = fs.existsSync(fullPath) ? xlsx.readFile(fullPath) : xlsx.utils.book_new();
      const worksheet = xlsx.utils.json_to_sheet(data);
      
      if (workbook.Sheets[sheetName]) {
        workbook.Sheets[sheetName] = worksheet;
      } else {
        xlsx.utils.book_append_sheet(workbook, worksheet, sheetName);
      }
      
      xlsx.writeFile(workbook, fullPath);
      return { content: [{ type: "text", text: `Successfully wrote ${data.length} rows to ${fullPath}` }] };
    } catch (e) { return { isError: true, content: [{ type: "text", text: String(e) }] }; }
});

server.tool("read_word", "Read text from a Word document.", 
  { filePath: z.string() },
  async ({ filePath }) => {
    try {
      const fullPath = resolveExistingFileUnderWorkspace(filePath);
      const buffer = fs.readFileSync(fullPath);
      const result = await mammoth.extractRawText({ buffer });
      return { content: [{ type: "text", text: result.value }] };
    } catch (e) { return { isError: true, content: [{ type: "text", text: String(e) }] }; }
});

server.tool("read_pdf_text", "Read text from a PDF file.", 
  { filePath: z.string() },
  async ({ filePath }) => {
    try {
      const fullPath = resolveExistingFileUnderWorkspace(filePath);
      const buffer = fs.readFileSync(fullPath);
      const data = await pdfParse(buffer);
      return { content: [{ type: "text", text: data.text }] };
    } catch (e) { return { isError: true, content: [{ type: "text", text: String(e) }] }; }
});

// --- Web Research Tools (Evidence-backed) ---

server.tool(
  "web_fetch_evidence",
  "Fetch a public URL (host-configured) and save evidence under Workspace/evidence/web/** (snapshot + extracted text + metadata).",
  {
    url: z.string().describe("http(s) URL to fetch."),
    timeoutMs: z.number().int().optional().describe("Optional timeout in ms (default ~25s)."),
    maxBytes: z.number().int().optional().describe("Optional max response bytes (default 10MB)."),
  },
  async ({ url, timeoutMs, maxBytes }) => {
    try {
      const policy = getWebResearchPolicyFromEnv();
      const result = await fetchWebEvidenceToWorkspace({
        url,
        timeoutMs: typeof timeoutMs === "number" ? timeoutMs : undefined,
        maxBytes: typeof maxBytes === "number" ? maxBytes : undefined,
        policy,
        pdfParseImpl: async (bytes) => await pdfParse(bytes),
      });

      const citationLabel = result.title ? result.title : result.url;
      const lines: string[] = [];
      lines.push(`Source: ${citationLabel}`);
      lines.push(`URL: ${result.url}`);
      if (result.final_url && result.final_url !== result.url) lines.push(`Final URL: ${result.final_url}`);
      lines.push(`Evidence folder: ${result.evidence_dir}`);
      lines.push(`Metadata: ${result.meta_path}`);
      if (result.text_path) lines.push(`Extracted text: ${result.text_path}`);
      if (result.snapshot_path) lines.push(`Snapshot: ${result.snapshot_path}`);
      if (result.text_snippet) {
        lines.push("");
        lines.push("Text snippet (for quick quoting; verify in saved text file):");
        lines.push(result.text_snippet);
      }

      if (!result.ok) {
        const msg = result.error ? result.error : "Fetch failed.";
        return { isError: true, content: [{ type: "text", text: lines.join("\n") + `\n\nError: ${msg}` }] };
      }

      return { content: [{ type: "text", text: lines.join("\n") }] };
    } catch (e) {
      return { isError: true, content: [{ type: "text", text: String(e) }] };
    }
  }
);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("Revit Operator MCP Server running on stdio");
}

main();
