import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { ensureWorkspaceLayout } from "../workspace.js";

const STORE_VERSION = "revit-operator.tool-contract-memory.v1";
const MAX_PENDING_FAILURES = 64;
const MAX_CORRECTIONS = 128;
const MAX_FAILURE_RECEIPTS = 256;
const MAX_PENDING_AGE_MS = 7 * 24 * 60 * 60 * 1_000;
const CONTRACT_FAILURE_PATTERN = /\b(schema|validat(?:e|ion)|invalid\s+(?:request|field|property|parameter|argument|payload|body|value)|required\s+(?:field|property|parameter|argument)|missing\s+(?:field|property|parameter|argument)|unknown\s+(?:field|property|parameter|argument)|unexpected\s+(?:field|property|parameter|argument)|enum|deserialize|request\s+body)\b/i;
const CONTRACT_VALUE_EXPECTATION_PATTERN = /\b(?:body|payload|field|property|parameter|argument|[A-Za-z_][A-Za-z0-9_.-]*)\s+must\s+be\s+(?:an?\s+)?(?:object|array|string|number|integer|boolean|null|one\s+of|'[^']+'|\"[^\"]+\")/i;
const SENSITIVE_KEY_PATTERN = /(authorization|cookie|password|passwd|secret|token|api[_-]?key|private[_-]?key|credential)/i;
const CONTRACT_LITERAL_KEY_PATTERN = /^(action|apply|caseSensitive|combine|dryRun|exact|includeAllRefs|includeCoordinateSystem|method|mode|onlyUntagged|path|placementMode|profile|risk|scope|target|type)$/i;

type JsonObject = Record<string, unknown>;

export type RevitToolRoute = {
  key: string;
  tool: string;
  method: string | null;
  path: string | null;
};

export type ToolQuarantineRecord = {
  id: string;
  tool: string | null;
  method: string | null;
  path: string | null;
  active: boolean;
  reason: string;
  evidence: string | null;
  created_at: string;
  cleared_at: string | null;
};

type PendingFailure = {
  route: RevitToolRoute;
  session_id: string | null;
  thread_id: string | null;
  turn_id: string | null;
  observed_at: string;
  error: string;
  failed_arguments: unknown;
};

export type ToolContractCorrection = {
  id: string;
  route: RevitToolRoute;
  failure_summary: string;
  failed_arguments: unknown;
  accepted_arguments: unknown;
  first_observed_at: string;
  last_observed_at: string;
  observations: number;
};

export type RevitToolFailureClass =
  | "contract"
  | "routing"
  | "scheduler"
  | "revit_context"
  | "unsupported_api"
  | "implementation_defect"
  | "environment_dependency"
  | "unknown";

export type RevitToolFailureReceipt = {
  id: string;
  route: RevitToolRoute;
  classification: RevitToolFailureClass;
  error: string;
  arguments: unknown;
  observed_at: string;
  session_id: string | null;
  thread_id: string | null;
  turn_id: string | null;
};

type ToolContractStore = {
  version: typeof STORE_VERSION;
  pending_failures: PendingFailure[];
  failure_receipts: RevitToolFailureReceipt[];
  corrections: ToolContractCorrection[];
  quarantines: ToolQuarantineRecord[];
};

function defaultStore(): ToolContractStore {
  return { version: STORE_VERSION, pending_failures: [], failure_receipts: [], corrections: [], quarantines: [] };
}

function storePath(): string {
  const override = (process.env.OPERATOR_REVIT_TOOL_CONTRACT_MEMORY_PATH || "").trim();
  if (override) return path.resolve(override);
  return path.join(ensureWorkspaceLayout().memory, "revit_tool_contract_memory.json");
}

function parseObject(value: unknown): JsonObject {
  if (value && typeof value === "object" && !Array.isArray(value)) return value as JsonObject;
  if (typeof value !== "string") return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as JsonObject : {};
  } catch {
    return {};
  }
}

function cleanString(value: unknown, max = 400): string {
  if (typeof value !== "string") return "";
  return value.replace(/\s+/g, " ").trim().slice(0, max);
}

function sanitizeDiagnostic(value: unknown, max = 600): string {
  return cleanString(value, max)
    .replace(/\b(Bearer\s+)[A-Za-z0-9._~+/=-]+/gi, "$1[redacted]")
    .replace(/((?:authorization|password|passwd|secret|token|api[_-]?key|private[_-]?key|credential)\s*[=:]\s*["']?)[^\s,"'}]+/gi, "$1[redacted]");
}

function normalizeMethod(value: unknown): string | null {
  const method = cleanString(value, 16).toUpperCase();
  return method || null;
}

function normalizePath(value: unknown): string | null {
  const routePath = cleanString(value, 240).toLowerCase();
  return routePath.startsWith("/revit/") ? routePath : null;
}

export function resolveRevitToolRoute(toolValue: unknown, argumentsValue: unknown): RevitToolRoute {
  const tool = cleanString(toolValue, 120);
  const args = parseObject(argumentsValue);
  if (tool === "revit_call_tool") {
    const method = normalizeMethod(args.method) ?? "GET";
    const routePath = normalizePath(args.path);
    if (routePath) return { key: `${method} ${routePath}`, tool, method, path: routePath };
  }
  return { key: `tool:${tool || "unknown"}`, tool: tool || "unknown", method: null, path: null };
}

function compactContractValue(value: unknown, key = "", depth = 0): unknown {
  if (SENSITIVE_KEY_PATTERN.test(key)) return "[redacted]";
  if (depth >= 4) return "<nested>";
  if (value === null || value === undefined) return value ?? null;
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return "<number>";
  if (typeof value === "string") {
    const text = cleanString(value, 120);
    if (CONTRACT_LITERAL_KEY_PATTERN.test(key) && /^[A-Za-z0-9_./:-]{1,120}$/.test(text)) return text;
    return "<string>";
  }
  if (Array.isArray(value)) {
    const compacted = value.slice(0, 3).map(item => compactContractValue(item, key, depth + 1));
    if (value.length > 3) compacted.push(`<${value.length - 3} more>`);
    return compacted;
  }
  if (typeof value === "object") {
    const result: JsonObject = {};
    for (const childKey of Object.keys(value as JsonObject).sort().slice(0, 32)) {
      result[childKey] = compactContractValue((value as JsonObject)[childKey], childKey, depth + 1);
    }
    return result;
  }
  return `<${typeof value}>`;
}

function compactArguments(tool: string, argumentsValue: unknown): unknown {
  const args = parseObject(argumentsValue);
  if (tool === "revit_call_tool") {
    return {
      method: normalizeMethod(args.method) ?? "GET",
      path: normalizePath(args.path) ?? "<invalid-revit-path>",
      body: compactContractValue(parseObject(args.body), "body")
    };
  }
  return compactContractValue(args, "arguments");
}

function readStoreFile(target: string): ToolContractStore | null {
  if (!fs.existsSync(target)) return null;
  try {
    const parsed = JSON.parse(fs.readFileSync(target, "utf8")) as Partial<ToolContractStore>;
    if (parsed.version !== STORE_VERSION) return null;
    return {
      version: STORE_VERSION,
      pending_failures: Array.isArray(parsed.pending_failures) ? parsed.pending_failures.slice(-MAX_PENDING_FAILURES) : [],
      failure_receipts: Array.isArray(parsed.failure_receipts) ? parsed.failure_receipts.slice(-MAX_FAILURE_RECEIPTS) : [],
      corrections: Array.isArray(parsed.corrections) ? parsed.corrections.slice(-MAX_CORRECTIONS) : [],
      quarantines: Array.isArray(parsed.quarantines) ? parsed.quarantines : []
    };
  } catch {
    return null;
  }
}

function readStore(): ToolContractStore {
  const target = storePath();
  return readStoreFile(target) ?? readStoreFile(`${target}.bak`) ?? defaultStore();
}

function writeStore(store: ToolContractStore): void {
  const target = storePath();
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const temp = `${target}.tmp-${process.pid}-${crypto.randomBytes(6).toString("hex")}`;
  fs.writeFileSync(temp, `${JSON.stringify(store, null, 2)}\n`, "utf8");
  if (readStoreFile(target)) fs.copyFileSync(target, `${target}.bak`);
  fs.renameSync(temp, target);
}

function correctionId(route: RevitToolRoute, failedArguments: unknown, acceptedArguments: unknown): string {
  return crypto
    .createHash("sha256")
    .update(JSON.stringify({ route: route.key, failedArguments, acceptedArguments }))
    .digest("hex")
    .slice(0, 24);
}

export function isContractShapedFailure(error: unknown): boolean {
  const diagnostic = cleanString(error, 2_000);
  return CONTRACT_FAILURE_PATTERN.test(diagnostic) || CONTRACT_VALUE_EXPECTATION_PATTERN.test(diagnostic);
}

export function classifyRevitToolFailure(errorValue: unknown): RevitToolFailureClass {
  const error = cleanString(errorValue, 2_000);
  if (isContractShapedFailure(error)) return "contract";
  if (/\b(404|unknown\s+(?:route|tool)|no\s+handler|route\s+not\s+found|unsupported\s+dynamic\s+tool\s+namespace)\b/i.test(error)) return "routing";
  if (/\b(external[_ -]?event[_ -]?busy|queue|circuit|deadline|timed?\s*out|host\s+unavailable|cancel(?:led|ed)|outcome\s+unknown)\b/i.test(error)) return "scheduler";
  if (/\b(no\s+active\s+(?:document|view)|document\s+(?:is\s+)?not\s+open|active\s+model\s+required|element\s+not\s+found|view\s+not\s+found|stale\s+element)\b/i.test(error)) return "revit_context";
  if (/\b(unsupported|not\s+supported|blocked\s+by\s+policy|signature[_ -]?unsupported|target[_ -]?unreachable|not\s+implemented)\b/i.test(error)) return "unsupported_api";
  if (/\b(nullreference|invalidoperationexception|unhandled|internal\s+(?:error|exception)|invariant\s+(?:failed|violation)|implementation\s+defect)\b/i.test(error)) return "implementation_defect";
  if (/\b(printer|family|file|directory|network|dns|permission|access\s+denied|authentication|unauthorized|dependency)\b.*\b(missing|not\s+found|unavailable|denied|failed|required)\b/i.test(error)) return "environment_dependency";
  return "unknown";
}

function attemptScope(input: { sessionId?: unknown; threadId?: unknown }): { sessionId: string | null; threadId: string | null } {
  return {
    sessionId: cleanString(input.sessionId, 120) || null,
    threadId: cleanString(input.threadId, 120) || null
  };
}

function pendingMatchesScope(pending: PendingFailure, scope: { sessionId: string | null; threadId: string | null }): boolean {
  if (scope.threadId) return pending.thread_id === scope.threadId;
  if (scope.sessionId) return pending.session_id === scope.sessionId;
  return pending.thread_id === null && pending.session_id === null;
}

export function recordRevitToolOutcome(input: {
  sessionId?: unknown;
  threadId?: unknown;
  turnId?: unknown;
  tool?: unknown;
  arguments?: unknown;
  success?: unknown;
  error?: unknown;
  observedAt?: string;
}): ToolContractCorrection | null {
  const route = resolveRevitToolRoute(input.tool, input.arguments);
  const observedAt = input.observedAt || new Date().toISOString();
  const error = sanitizeDiagnostic(input.error, 600);
  const compactedArguments = compactArguments(route.tool, input.arguments);
  const scope = attemptScope(input);
  const store = readStore();

  if (input.success === false) {
    const classification = classifyRevitToolFailure(error);
    const failureId = crypto
      .createHash("sha256")
      .update(JSON.stringify({ route: route.key, observedAt, error, compactedArguments }))
      .digest("hex")
      .slice(0, 24);
    store.failure_receipts.push({
      id: failureId,
      route,
      classification,
      error,
      arguments: compactedArguments,
      observed_at: observedAt,
      session_id: cleanString(input.sessionId, 120) || null,
      thread_id: cleanString(input.threadId, 120) || null,
      turn_id: cleanString(input.turnId, 120) || null
    });
    store.failure_receipts = store.failure_receipts.slice(-MAX_FAILURE_RECEIPTS);
    if (classification !== "contract") {
      writeStore(store);
      return null;
    }
    store.pending_failures = store.pending_failures.filter(item => !(item.route.key === route.key && pendingMatchesScope(item, scope)));
    store.pending_failures.push({
      route,
      session_id: scope.sessionId,
      thread_id: scope.threadId,
      turn_id: cleanString(input.turnId, 120) || null,
      observed_at: observedAt,
      error,
      failed_arguments: compactedArguments
    });
    store.pending_failures = store.pending_failures.slice(-MAX_PENDING_FAILURES);
    writeStore(store);
    return null;
  }

  if (input.success !== true) return null;
  const pendingIndex = store.pending_failures.map(item => item.route.key === route.key && pendingMatchesScope(item, scope)).lastIndexOf(true);
  if (pendingIndex < 0) return null;
  const pending = store.pending_failures[pendingIndex];
  store.pending_failures.splice(pendingIndex, 1);
  if (Date.parse(observedAt) - Date.parse(pending.observed_at) > MAX_PENDING_AGE_MS) {
    writeStore(store);
    return null;
  }
  if (JSON.stringify(pending.failed_arguments) === JSON.stringify(compactedArguments)) {
    writeStore(store);
    return null;
  }

  const id = correctionId(route, pending.failed_arguments, compactedArguments);
  const existing = store.corrections.find(item => item.id === id);
  let correction: ToolContractCorrection;
  if (existing) {
    existing.last_observed_at = observedAt;
    existing.observations += 1;
    existing.failure_summary = pending.error;
    correction = existing;
  } else {
    correction = {
      id,
      route,
      failure_summary: pending.error,
      failed_arguments: pending.failed_arguments,
      accepted_arguments: compactedArguments,
      first_observed_at: pending.observed_at,
      last_observed_at: observedAt,
      observations: 1
    };
    store.corrections.push(correction);
  }
  store.corrections = store.corrections
    .sort((a, b) => a.last_observed_at.localeCompare(b.last_observed_at))
    .slice(-MAX_CORRECTIONS);
  writeStore(store);
  return correction;
}

function routeLabel(route: RevitToolRoute): string {
  return route.method && route.path ? `${route.method} ${route.path}` : route.tool;
}

export function formatRevitToolContractMemoryForPrompt(maxCorrections = 8): string {
  const store = readStore();
  const corrections = [...store.corrections]
    .sort((a, b) => b.last_observed_at.localeCompare(a.last_observed_at))
    .slice(0, Math.max(0, Math.min(16, maxCorrections)));
  const quarantines = store.quarantines.filter(item => item.active);
  if (corrections.length === 0 && quarantines.length === 0) return "";

  const lines = [
    "PERSISTED REVIT TOOL CONTRACT MEMORY (hints only; current live tool docs remain authoritative):"
  ];
  for (const correction of corrections) {
    lines.push(
      `- ${routeLabel(correction.route)} failed with ${JSON.stringify(correction.failed_arguments)} and later accepted ${JSON.stringify(correction.accepted_arguments)}. Failure: ${correction.failure_summary}`
    );
  }
  for (const quarantine of quarantines) {
    const label = quarantine.method && quarantine.path ? `${quarantine.method} ${quarantine.path}` : quarantine.tool || "unknown tool";
    lines.push(`- QUARANTINED ${label}: ${quarantine.reason}. Do not call autonomously; inspect current docs/evidence and repair or use another primitive.`);
  }
  return lines.join("\n").slice(0, 12_000);
}

function quarantineMatches(record: ToolQuarantineRecord, route: RevitToolRoute): boolean {
  if (!record.active) return false;
  if (record.method && record.path) return record.method === route.method && record.path === route.path;
  return Boolean(record.tool && record.tool === route.tool);
}

export function findActiveToolQuarantine(tool: unknown, argumentsValue: unknown): ToolQuarantineRecord | null {
  const route = resolveRevitToolRoute(tool, argumentsValue);
  return readStore().quarantines.find(record => quarantineMatches(record, route)) ?? null;
}

export function setRevitToolQuarantine(input: {
  tool?: unknown;
  method?: unknown;
  path?: unknown;
  active: boolean;
  reason: unknown;
  evidence?: unknown;
  observedAt?: string;
}): ToolQuarantineRecord {
  const tool = cleanString(input.tool, 120) || null;
  const method = normalizeMethod(input.method);
  const routePath = normalizePath(input.path);
  if (!(tool || (method && routePath))) throw new Error("A tool name or exact Revit method/path is required for quarantine.");
  const reason = cleanString(input.reason, 600);
  if (!reason) throw new Error("A concrete quarantine reason is required.");
  const key = method && routePath ? `${method} ${routePath}` : `tool:${tool}`;
  const now = input.observedAt || new Date().toISOString();
  const id = crypto.createHash("sha256").update(key).digest("hex").slice(0, 24);
  const store = readStore();
  const existing = store.quarantines.find(record => record.id === id);
  const record: ToolQuarantineRecord = existing ?? {
    id,
    tool,
    method,
    path: routePath,
    active: input.active,
    reason,
    evidence: sanitizeDiagnostic(input.evidence, 600) || null,
    created_at: now,
    cleared_at: null
  };
  record.active = input.active;
  record.reason = reason;
  record.evidence = sanitizeDiagnostic(input.evidence, 600) || record.evidence;
  record.cleared_at = input.active ? null : now;
  if (!existing) store.quarantines.push(record);
  writeStore(store);
  return record;
}

export function filterQuarantinedToolSearchResult(result: any): any {
  const active = readStore().quarantines.filter(item => item.active && item.method && item.path);
  if (active.length === 0 || !Array.isArray(result?.content)) return result;
  const blocked = new Set(active.map(item => `${item.method} ${item.path}`));
  return {
    ...result,
    content: result.content.map((item: any) => {
      if (item?.type !== "text" || typeof item.text !== "string") return item;
      try {
        const parsed = JSON.parse(item.text);
        if (!Array.isArray(parsed?.matches)) return item;
        const matches = parsed.matches.filter((match: any) => !blocked.has(`${normalizeMethod(match?.method) ?? "GET"} ${normalizePath(match?.path) ?? ""}`));
        const removed = parsed.matches.length - matches.length;
        if (removed === 0) return item;
        return { ...item, text: JSON.stringify({ ...parsed, returned: matches.length, matches, quarantine_filtered: removed }) };
      } catch {
        return item;
      }
    })
  };
}

export function readRevitToolContractStoreForTests(): ToolContractStore {
  return readStore();
}
