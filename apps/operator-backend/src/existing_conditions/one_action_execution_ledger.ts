import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { ActionCall, ChatRequest, ChatResponse, ToolResult } from "../contracts.js";
import { appendNotification } from "../memory/sqlite_store.js";
import { atomicAppendJsonlLine } from "../persistence/jsonl.js";
import { ensureWorkspaceLayout } from "../workspace.js";
import type { AtomicMepDraftWorkflowRequest } from "./mep_draft_plan.js";
import {
  buildNextExistingConditionsStagePlan,
  existingConditionsRepairLedgerPath,
  latestExistingConditionsStagedWorkflow,
  readExistingConditionsRepairLedger,
  recordExistingConditionsStageResult,
  recordExistingConditionsVerificationResult,
  registerExistingConditionsRepairAction,
  registerExistingConditionsStagedWorkflow
} from "./staged_repair_ledger.js";

type ExecutionEvent = "action_planned" | "action_completed" | "action_failed";
type ExecutionPhase =
  | "observe"
  | "dry_run"
  | "apply"
  | "readback"
  | "visual"
  | "checkpoint"
  | "recovery";

export type ExistingConditionsExecutionLedgerEntry = {
  schema_version: 1;
  sequence: number;
  ts: string;
  session_id: string;
  event: ExecutionEvent;
  phase: ExecutionPhase;
  action_id: string;
  method: "GET" | "POST";
  path: string;
  action_sha256: string;
  payload_sha256: string;
  status: "planned" | "done" | "failed";
  error: string | null;
  document_scope_sha256?: string | null;
  previous_entry_sha256: string | null;
  entry_sha256: string;
};

const READBACK_PATHS = new Set([
  "/revit/context",
  "/revit/state-snapshot",
  "/revit/get-element-summary",
  "/revit/get-parameters",
  "/revit/get-connectors",
  "/revit/query",
  "/revit/rooms",
  "/revit/room-contents",
  "/revit/linked-room-boundaries",
  "/revit/audit-plumbing-fixture-services",
  "/revit/export-view-frame",
  "/revit/export-view-region",
  "/revit/highlight-and-export",
  "/revit/computer-use-observe"
]);

const OBSERVE_PATHS = new Set([
  "/revit/context",
  "/revit/tool-search",
  "/revit/tool-examples",
  "/revit/tool-doc",
  "/revit/tool-registry",
  "/revit/native-api-search",
  "/revit/native-api-catalog"
]);

function clean(value: unknown): string {
  return String(value ?? "").trim();
}

function canonicalJson(value: unknown): string {
  if (value == null) return "null";
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return "null";
    return JSON.stringify(value);
  }
  if (typeof value === "boolean") return value ? "true" : "false";
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value !== "object") return "null";
  const row = value as Record<string, unknown>;
  return `{${Object.keys(row)
    .filter(key => row[key] !== undefined)
    .sort()
    .map(key => `${JSON.stringify(key)}:${canonicalJson(row[key])}`)
    .join(",")}}`;
}

function sha256(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function documentScopeSha256(context: unknown): string | null {
  const root = objectValue(context);
  const revit = objectValue(root.revit);
  const document = objectValue(revit.document);
  const documentPath = clean(
    revit.document_path ??
    revit.active_document_path ??
    document.path ??
    document.file_path
  );
  const documentTitle = clean(
    revit.document_title ??
    revit.active_document_name ??
    document.title ??
    document.name
  );
  const documentId = clean(
    revit.document_id ??
    revit.active_document_id ??
    document.id ??
    document.unique_id
  );
  if (!documentPath && !documentTitle && !documentId) return null;
  return sha256({
    path: documentPath.replaceAll("\\", "/").toLowerCase(),
    title: documentTitle.toLowerCase(),
    id: documentId
  });
}

function safeSessionId(sessionId: string): string {
  const value = clean(sessionId);
  if (!value) throw new Error("existing_conditions_execution_session_id_required");
  return value.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 120);
}

function ledgerPath(sessionId: string): string {
  return path.join(
    ensureWorkspaceLayout().runsSessions,
    safeSessionId(sessionId),
    "existing_conditions_execution_ledger.jsonl"
  );
}

function executionControlPath(sessionId: string): string {
  return path.join(
    ensureWorkspaceLayout().runsSessions,
    safeSessionId(sessionId),
    "existing_conditions_execution_control.jsonl"
  );
}

function textRequestsPauseBeforeAutomaticSplit(value: string): boolean {
  return /\bstop\b[^.!?\n]{0,120}\bbefore\b[^.!?\n]{0,120}\b(?:apply|applying|execute|executing|run|running|dry[-\s]?run|dry[-\s]?running)\b[^.!?\n]{0,100}\b(?:either\s+|any\s+|the\s+)?split\s+stages?\b/i.test(value);
}

function textRequestsDryRunOnly(value: string): boolean {
  return /\bdry[-\s]?run\s+only\b/i.test(value) ||
    /\bstop\b[^.!?\n]{0,80}\bafter\b[^.!?\n]{0,40}\bdry[-\s]?run\b/i.test(value) ||
    /\b(?:do\s+not|don't|never)\s+apply\b/i.test(value);
}

function textAuthorizesVerifiedStageApply(value: string): boolean {
  if (textRequestsDryRunOnly(value)) return false;
  return /\bapply\b[^.!?\n]{0,120}\b(?:exact|accepted|verified|rollback[-\s]?verified|dry[-\s]?run)\b[^.!?\n]{0,120}\bstage\b/i.test(value) ||
    /\bapply\b[^.!?\n]{0,120}\bstage\b[^.!?\n]{0,120}\b(?:exact|accepted|verified|rollback[-\s]?verified|dry[-\s]?run)\b/i.test(value);
}

type OneBoundedReadKind = "export" | "read" | "inventory" | "query" | "capture" | "inspection";

function textRequestsExactlyOneBoundedReadWithoutRetry(value: string): OneBoundedReadKind | null {
  const text = clean(value);
  if (!text) return null;
  const match = /\b(?:exactly\s+)?(?:one|single)\b[^.!?\n]{0,80}\b(?:bounded\s+)?(export|read|inventory|query|capture|inspection)\b/i.exec(text);
  if (!match) return null;
  const noRetry = /\b(?:no|do\s+not|don't|never|without)\s+(?:a\s+)?(?:retry|retries|retrying|repeat|repeating|rerun|rerunning)\b/i.test(text);
  return noRetry ? match[1]!.toLowerCase() as OneBoundedReadKind : null;
}

function actionMatchesOneBoundedReadKind(
  action: Pick<ActionCall | ToolResult, "method" | "path">,
  kind: OneBoundedReadKind
): boolean {
  const actionPath = clean(action.path).toLowerCase();
  if (!actionPath.startsWith("/revit/")) return false;
  if (kind === "export") {
    return /\/(?:export(?:-|\/)|highlight-and-export\b|print(?:-|\/))/.test(actionPath);
  }
  if (kind === "capture") {
    return /\/(?:capture(?:-|\/)|export-view(?:-|\/)|export-visible-elements\b|highlight-and-export\b|print(?:-|\/))/.test(actionPath);
  }
  if (kind === "inventory") {
    return /\/(?:export-visible-elements\b|find-elements\b|get-element-summary\b|room-contents\b|query\b)/.test(actionPath);
  }
  if (kind === "query") {
    return action.method === "GET" || /\/(?:query\b|find-|get-|list-|rooms\b|room-contents\b|context\b)/.test(actionPath);
  }
  if (kind === "inspection") {
    return action.method === "GET" || /\/(?:computer-use-observe\b|export-view|export-visible-elements\b|highlight-and-export\b|find-|get-|query\b)/.test(actionPath);
  }
  return action.method === "GET" ||
    READBACK_PATHS.has(actionPath) ||
    OBSERVE_PATHS.has(actionPath) ||
    /\/(?:export-|find-|get-|list-|query\b|capture-)/.test(actionPath);
}

function persistedExecutionControl(sessionId: string): {
  dry_run_only: boolean;
  pause_before_automatic_split: boolean;
  one_bounded_read_kind: OneBoundedReadKind | null;
} {
  const control: {
    dry_run_only: boolean;
    pause_before_automatic_split: boolean;
    one_bounded_read_kind: OneBoundedReadKind | null;
  } = {
    dry_run_only: false,
    pause_before_automatic_split: false,
    one_bounded_read_kind: null
  };
  const filePath = executionControlPath(sessionId);
  if (!fs.existsSync(filePath)) return control;
  try {
    for (const line of fs.readFileSync(filePath, "utf8").split(/\r?\n/).filter(Boolean).slice(-120)) {
      try {
        const row = JSON.parse(line) as Record<string, unknown>;
        if (typeof row.dry_run_only === "boolean") {
          control.dry_run_only = row.dry_run_only;
        }
        if (typeof row.pause_before_automatic_split === "boolean") {
          control.pause_before_automatic_split = row.pause_before_automatic_split;
        }
        if (row.one_bounded_read_kind === null) {
          control.one_bounded_read_kind = null;
        } else if (["export", "read", "inventory", "query", "capture", "inspection"].includes(clean(row.one_bounded_read_kind))) {
          control.one_bounded_read_kind = clean(row.one_bounded_read_kind) as OneBoundedReadKind;
        }
      } catch {
        // Ignore an incomplete append tail; prior durable directives remain valid.
      }
    }
  } catch {
    // An unreadable control file never creates new write authority.
  }
  return control;
}

function persistExecutionControlDirectives(req: ChatRequest): void {
  const text = clean(req.user_text);
  if (!text) return;
  const dryRunOnly = textRequestsDryRunOnly(text);
  const pauseBeforeAutomaticSplit = textRequestsPauseBeforeAutomaticSplit(text);
  const authorizeVerifiedApply = textAuthorizesVerifiedStageApply(text);
  const oneBoundedReadKind = textRequestsExactlyOneBoundedReadWithoutRetry(text);
  const previous = persistedExecutionControl(req.session_id);
  const nextDryRunOnly = authorizeVerifiedApply
    ? false
    : dryRunOnly || previous.dry_run_only;
  const nextPauseBeforeAutomaticSplit =
    pauseBeforeAutomaticSplit || previous.pause_before_automatic_split;
  const nextOneBoundedReadKind = oneBoundedReadKind;
  if (
    nextDryRunOnly === previous.dry_run_only &&
    nextPauseBeforeAutomaticSplit === previous.pause_before_automatic_split &&
    nextOneBoundedReadKind === previous.one_bounded_read_kind
  ) {
    return;
  }
  atomicAppendJsonlLine(executionControlPath(req.session_id), {
    ts: new Date().toISOString(),
    dry_run_only: nextDryRunOnly,
    pause_before_automatic_split: nextPauseBeforeAutomaticSplit,
    one_bounded_read_kind: nextOneBoundedReadKind
  });
}

function oneBoundedReadTerminalDecision(
  req: ChatRequest,
  toolResults: ToolResult[]
): ChatResponse | null {
  const kind = persistedExecutionControl(req.session_id).one_bounded_read_kind;
  if (!kind) return null;
  const terminal = toolResults.find(result =>
    (result.status === "done" || result.status === "failed") &&
    actionMatchesOneBoundedReadKind(result, kind)
  );
  if (!terminal) return null;
  return {
    version: "operator.backend.v1",
    assistant_message: terminal.status === "done"
      ? `The requested single bounded ${kind} completed, so I stopped before any retry or follow-on read. Its result remains registered for the next deliberate stage.`
      : `The requested single bounded ${kind} failed, and the no-retry instruction remains in force. I stopped without issuing another read or action.`,
    actions: []
  };
}

type RegisteredModelRect = {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
};

function parseRegisteredModelRect(text: string): RegisteredModelRect | null {
  const number = "([+-]?(?:\\d+(?:\\.\\d+)?|\\.\\d+))";
  const separator = "(?:\\.\\.|\\bto\\b|[–—])";
  const match = new RegExp(
    `registered\\s+model\\s+(?:rectangle|rect)\\b[^\\r\\n]{0,160}?x\\s*${number}\\s*${separator}\\s*${number}(?:\\s*ft)?[^\\r\\n]{0,80}?y\\s*${number}\\s*${separator}\\s*${number}`,
    "i"
  ).exec(text);
  if (!match) return null;
  const values = match.slice(1, 5).map(value => Number(value));
  if (!values.every(Number.isFinite)) return null;
  const [x1, x2, y1, y2] = values as [number, number, number, number];
  return {
    minX: Math.min(x1, x2),
    maxX: Math.max(x1, x2),
    minY: Math.min(y1, y2),
    maxY: Math.max(y1, y2)
  };
}

function loadRegisteredModelRect(req: ChatRequest): RegisteredModelRect | null {
  const texts = [clean(req.user_text)];
  const requestLogPath = path.join(
    ensureWorkspaceLayout().runsSessions,
    safeSessionId(req.session_id),
    "request_log.jsonl"
  );
  if (fs.existsSync(requestLogPath)) {
    try {
      const lines = fs.readFileSync(requestLogPath, "utf8").split(/\r?\n/).filter(Boolean).slice(-120);
      for (const line of lines) {
        try {
          const row = JSON.parse(line) as Record<string, unknown>;
          if (typeof row.user_text === "string" && row.user_text.trim()) texts.push(row.user_text);
        } catch {
          // Ignore a partial request-log tail; the execution ledger remains authoritative.
        }
      }
    } catch {
      // A missing registration guard is safer than treating unreadable text as coordinates.
    }
  }
  for (const text of texts.reverse()) {
    const parsed = parseRegisteredModelRect(text);
    if (parsed) return parsed;
  }
  return null;
}

function actionModelPoints(body: unknown): Array<{ x: number; y: number }> {
  const root = objectValue(body);
  const points: Array<{ x: number; y: number }> = [];
  const addPair = (x: unknown, y: unknown) => {
    if (typeof x === "number" && Number.isFinite(x) && typeof y === "number" && Number.isFinite(y)) {
      points.push({ x, y });
    }
  };
  for (const [xKey, yKey] of [
    ["x", "y"],
    ["startX", "startY"],
    ["endX", "endY"],
    ["pointX", "pointY"]
  ] as const) {
    addPair(root[xKey], root[yKey]);
  }
  for (const key of ["pointXyz", "startPoint", "endPoint"] as const) {
    const value = root[key];
    if (Array.isArray(value)) addPair(value[0], value[1]);
  }
  for (const key of ["points", "pathPoints", "routePoints"] as const) {
    const values = root[key];
    if (!Array.isArray(values)) continue;
    for (const value of values) {
      if (Array.isArray(value)) addPair(value[0], value[1]);
      else {
        const point = objectValue(value);
        addPair(point.x, point.y);
      }
    }
  }
  return points;
}

function pointsOutsideRegisteredRect(
  body: unknown,
  rect: RegisteredModelRect,
  toleranceFt = 0.5
): Array<{ x: number; y: number }> {
  return actionModelPoints(body).filter(point =>
    point.x < rect.minX - toleranceFt ||
    point.x > rect.maxX + toleranceFt ||
    point.y < rect.minY - toleranceFt ||
    point.y > rect.maxY + toleranceFt
  );
}

function acquireLedgerLock(lockPath: string, timeoutMs = 5000): number {
  const deadline = Date.now() + timeoutMs;
  const waitBuffer = new Int32Array(new SharedArrayBuffer(4));
  while (true) {
    try {
      return fs.openSync(lockPath, "wx");
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code !== "EEXIST") throw error;
      if (Date.now() >= deadline) {
        throw new Error("existing_conditions_execution_ledger_is_locked");
      }
      Atomics.wait(waitBuffer, 0, 0, 10);
    }
  }
}

function classifyPhase(pathValue: string, body: unknown): ExecutionPhase {
  const normalizedPath = clean(pathValue).toLowerCase();
  const row = body && typeof body === "object" && !Array.isArray(body)
    ? body as Record<string, unknown>
    : {};
  if (normalizedPath.includes("computer-use")) return "recovery";
  if (normalizedPath.includes("save")) return "checkpoint";
  if (normalizedPath.includes("export") || normalizedPath.includes("highlight")) return "visual";
  if (OBSERVE_PATHS.has(normalizedPath)) return "observe";
  if (normalizedPath === "/revit/list-element-types") return "observe";
  if (READBACK_PATHS.has(normalizedPath)) return "readback";
  if (row.dryRun === true || row.dry_run === true) return "dry_run";
  return "apply";
}

export function readExistingConditionsExecutionLedger(
  sessionId: string
): ExistingConditionsExecutionLedgerEntry[] {
  const filePath = ledgerPath(sessionId);
  if (!fs.existsSync(filePath)) return [];
  const text = fs.readFileSync(filePath, "utf8");
  if (!text.trim()) return [];
  const entries: ExistingConditionsExecutionLedgerEntry[] = [];
  let previousHash: string | null = null;
  for (const [index, rawLine] of text.split(/\r?\n/).entries()) {
    const line = rawLine.trim();
    if (!line) continue;
    let entry: ExistingConditionsExecutionLedgerEntry;
    try {
      entry = JSON.parse(line) as ExistingConditionsExecutionLedgerEntry;
    } catch {
      throw new Error(`existing_conditions_execution_ledger_malformed_line:${index + 1}`);
    }
    const { entry_sha256: claimedHash, ...withoutHash } = entry;
    if (
      entry.schema_version !== 1 ||
      entry.sequence !== entries.length + 1 ||
      entry.session_id !== clean(sessionId) ||
      entry.previous_entry_sha256 !== previousHash ||
      sha256(withoutHash) !== claimedHash
    ) {
      throw new Error(`existing_conditions_execution_ledger_invalid_chain_line:${index + 1}`);
    }
    entries.push(entry);
    previousHash = claimedHash;
  }
  return entries;
}

function appendExecutionEntry(args: {
  sessionId: string;
  event: ExecutionEvent;
  action: Pick<ActionCall, "action_id" | "method" | "path"> & { body?: unknown };
  status: "planned" | "done" | "failed";
  payload: unknown;
  phase?: ExecutionPhase;
  error?: string | null;
  documentScopeSha256?: string | null;
}): ExistingConditionsExecutionLedgerEntry {
  const sessionId = clean(args.sessionId);
  const filePath = ledgerPath(sessionId);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const lockPath = `${filePath}.lock`;
  let lockHandle: number | null = null;
  lockHandle = acquireLedgerLock(lockPath);
  let entry: ExistingConditionsExecutionLedgerEntry;
  try {
    const existing = readExistingConditionsExecutionLedger(sessionId);
    const actionHash = sha256({
      method: args.action.method,
      path: args.action.path,
      body: args.action.body ?? null
    });
    const payloadHash = sha256(args.payload);
    const duplicate = existing.find(value =>
      value.event === args.event &&
      value.action_id === args.action.action_id &&
      value.action_sha256 === actionHash &&
      value.payload_sha256 === payloadHash &&
      (value.document_scope_sha256 ?? null) === (args.documentScopeSha256 ?? null) &&
      value.status === args.status
    );
    if (duplicate) return duplicate;

    const withoutHash: Omit<ExistingConditionsExecutionLedgerEntry, "entry_sha256"> = {
      schema_version: 1,
      sequence: existing.length + 1,
      ts: new Date().toISOString(),
      session_id: sessionId,
      event: args.event,
      phase: args.phase ?? classifyPhase(args.action.path, args.action.body),
      action_id: clean(args.action.action_id),
      method: args.action.method,
      path: clean(args.action.path),
      action_sha256: actionHash,
      payload_sha256: payloadHash,
      status: args.status,
      error: clean(args.error) || null,
      document_scope_sha256: args.documentScopeSha256 ?? null,
      previous_entry_sha256: existing.at(-1)?.entry_sha256 ?? null
    };
    entry = {
      ...withoutHash,
      entry_sha256: sha256(withoutHash)
    };
    atomicAppendJsonlLine(filePath, entry);
  } finally {
    if (lockHandle != null) {
      try {
        fs.closeSync(lockHandle);
      } catch {
        // best effort
      }
    }
    try {
      fs.unlinkSync(lockPath);
    } catch {
      // best effort
    }
  }
  appendNotification(
    sessionId,
    `existing_conditions_${entry.phase}`,
    entry.event === "action_planned"
      ? `Next ${entry.phase} action: ${entry.method} ${entry.path}`
      : `${entry.phase} action ${entry.status}: ${entry.method} ${entry.path}`,
    {
      sequence: entry.sequence,
      action_id: entry.action_id,
      phase: entry.phase,
      status: entry.status,
      ledger_path: filePath
    }
  );
  return entry;
}

function recordToolResults(
  sessionId: string,
  toolResults: ToolResult[],
  documentScope: string | null
): void {
  for (const result of toolResults) {
    appendExecutionEntry({
      sessionId,
      event: result.status === "done" ? "action_completed" : "action_failed",
      action: {
        action_id: result.action_id,
        method: result.method,
        path: result.path
      },
      status: result.status,
      phase: classifyPhase(result.path, result.result_json),
      payload: {
        result_json: result.result_json ?? null,
        result_summary: result.result_summary ?? null,
        failure_kind: result.failure_kind ?? null,
        failure_code: result.failure_code ?? null,
        attachments: result.attachments ?? []
      },
      error: result.error ?? result.failure_hint ?? null,
      documentScopeSha256: documentScope
    });
  }
}

/**
 * Only a result for an action that is still recorded as in flight may advance
 * the staged existing-conditions ledger. The bridge can deliver a delayed
 * receipt after a backend restart, and providers can also replay a receipt
 * with the same path and workflow fingerprint but a different action id. A
 * path/fingerprint match alone is not an execution identity.
 */
function persistedContinuationResults(
  sessionId: string,
  toolResults: ToolResult[],
  currentScope: string | null
): ToolResult[] {
  const ledger = readExistingConditionsExecutionLedger(sessionId);
  return toolResults.filter(result => {
    const actionId = clean(result.action_id);
    const method = clean(result.method).toUpperCase();
    const resultPath = clean(result.path).toLowerCase();
    if (!actionId || (method !== "GET" && method !== "POST") || !resultPath) return false;
    const planned = ledger
      .filter(entry =>
        entry.event === "action_planned" &&
        entry.action_id === actionId &&
        entry.method === method &&
        entry.path.toLowerCase() === resultPath &&
        scopesMatch(entry, currentScope)
      )
      .at(-1);
    if (!planned) return false;
    return !ledger.some(entry =>
      entry.sequence > planned.sequence &&
      (entry.event === "action_completed" || entry.event === "action_failed") &&
      entry.action_id === actionId &&
      entry.method === method &&
      entry.path.toLowerCase() === resultPath &&
      entriesShareScope(planned, entry)
    );
  });
}
function scopesMatch(
  entry: ExistingConditionsExecutionLedgerEntry,
  currentScope: string | null
): boolean {
  const entryScope = entry.document_scope_sha256 ?? null;
  if (entryScope && currentScope) return entryScope === currentScope;
  if (entryScope || currentScope) {
    // Legacy write entries predate document scoping. Continue treating them as
    // global so an upgrade cannot accidentally replay a completed model write.
    // Legacy read/visual entries are intentionally not reusable across a known
    // document boundary because native ElementIds collide between documents.
    return entryScope == null && entry.phase !== "readback" && entry.phase !== "visual";
  }
  return true;
}

function entriesShareScope(
  left: ExistingConditionsExecutionLedgerEntry,
  right: ExistingConditionsExecutionLedgerEntry
): boolean {
  const leftScope = left.document_scope_sha256 ?? null;
  const rightScope = right.document_scope_sha256 ?? null;
  if (leftScope && rightScope) return leftScope === rightScope;
  if (leftScope || rightScope) {
    return leftScope == null && left.phase !== "readback" && left.phase !== "visual";
  }
  return true;
}

function extractBalancedJson(text: string, start: number): unknown {
  const opening = text[start];
  if (opening !== "{" && opening !== "[") throw new Error("explicit_action_json_missing");
  const closing = opening === "{" ? "}" : "]";
  let depth = 0;
  let quoted = false;
  let escaped = false;
  for (let index = start; index < text.length; index += 1) {
    const char = text[index]!;
    if (quoted) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') quoted = false;
      continue;
    }
    if (char === '"') {
      quoted = true;
      continue;
    }
    if (char === opening) depth += 1;
    else if (char === closing) {
      depth -= 1;
      if (depth === 0) return JSON.parse(text.slice(start, index + 1));
    }
  }
  throw new Error("explicit_action_json_unterminated");
}

/**
 * Executes a user's strict single-action bridge instruction without asking a
 * provider to restate it. Normal environment policy and the one-action ledger
 * still run afterward, so this lane does not bypass allowlists or safety gates.
 */
export function maybeBuildExplicitExistingConditionsAction(
  req: ChatRequest
): ChatResponse | null {
  const explicitResult = (req.tool_results ?? []).find(result =>
    clean(result.action_id).startsWith("explicit-")
  );
  if (explicitResult?.status === "done") {
    return {
      version: "operator.backend.v1",
      assistant_message:
        `The exact ${explicitResult.method} ${explicitResult.path} action completed. No further action was dispatched.`,
      actions: []
    };
  }
  if ((req.tool_results?.length ?? 0) > 0) return null;
  const userText = clean(req.user_text);
  const strictMatch = /\b(?:perform|execute|run)\s+exactly\s+one\s+(GET|POST)\s+(\/revit\/[a-z0-9_\/-]+)\b/i.exec(userText);
  const literalCallMatch = /(?:^|[.!?;]\s+)(?:please\s+)?call\s+(GET|POST)\s+(\/revit\/[a-z0-9_\/-]+)\b/i.exec(userText);
  const match = strictMatch ?? literalCallMatch;
  if (!match) return null;
  const method = match[1]!.toUpperCase() as "GET" | "POST";
  const actionPath = match[2]!;
  const remainder = userText.slice((match.index ?? 0) + match[0].length);
  const bodyMarker = /\bwith\s+body\b/i.exec(remainder);
  let body: unknown = undefined;
  if (bodyMarker) {
    const afterMarker = remainder.slice((bodyMarker.index ?? 0) + bodyMarker[0].length);
    const objectIndex = afterMarker.search(/[\[{]/);
    if (objectIndex < 0) return null;
    try {
      body = extractBalancedJson(afterMarker, objectIndex);
    } catch {
      return null;
    }
  } else if (method === "POST" && !/\b(?:with\s+)?no\s+body\b/i.test(remainder)) {
    return null;
  }
  const actionId = `explicit-${sha256({
    session_id: req.session_id,
    message_id: req.message_id,
    method,
    path: actionPath,
    body: body ?? null
  }).slice(0, 24)}`;
  return {
    version: "operator.backend.v1",
    assistant_message:
      "Executing the exact single Revit action supplied in the current request; provider planning is bypassed for this action.",
    actions: [{
      action_id: actionId,
      method,
      path: actionPath,
      ...(body === undefined ? {} : { body })
    }]
  };
}

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function latestResult(toolResults: ToolResult[]): ToolResult | null {
  return toolResults.length > 0 ? toolResults[toolResults.length - 1]! : null;
}

function isLocalContractFailure(result: ToolResult): boolean {
  const failureKind = clean(result.failure_kind).toLowerCase();
  const failureCode = clean(result.failure_code).toLowerCase();
  if ([
    "validation",
    "validation_error",
    "invalid_request",
    "invalid_request_body",
    "contract_error",
    "schema_error",
    "not_allowlisted"
  ].includes(failureKind) || [
    "validation_error",
    "invalid_request",
    "invalid_request_body",
    "schema_error",
    "not_allowlisted",
    "unknown_path"
  ].includes(failureCode)) {
    return true;
  }

  const resultRow = objectValue(result.result_json);
  const message = [
    result.error,
    result.failure_hint,
    result.result_summary,
    resultRow.error,
    resultRow.message
  ].map(clean).filter(Boolean).join(" ").toLowerCase();

  return [
    /\bmust be an array of integers\b/,
    /\brequest body\b.*\b(invalid|required|must)\b/,
    /\b(invalid|malformed)\s+(json|payload|request)\b/,
    /\b(schema|validation)\s+(error|failed|failure)\b/,
    /\bmissing required\b/,
    /\bis required\b/,
    /\bunknown (path|field|property|parameter)\b/,
    /\bunsupported (path|method|field|property|parameter)\b/,
    /\bnot allowlisted\b/
  ].some(pattern => pattern.test(message));
}

function recoveryDecision(toolResults: ToolResult[]): ChatResponse | null {
  const latest = latestResult(toolResults);
  if (!latest) return null;
  const normalizedPath = clean(latest.path).toLowerCase();

  if (
    latest.status === "failed" &&
    !normalizedPath.startsWith("/revit/computer-use-") &&
    !isLocalContractFailure(latest)
  ) {
    return {
      version: "operator.backend.v1",
      assistant_message:
        "The last Revit action failed. I preserved earlier accepted work and will inspect the live dialog state before clearing or retrying anything.",
      actions: [{
        action_id: `existing-conditions-observe-${Date.now()}`,
        method: "POST",
        path: "/revit/computer-use-observe",
        body: {
          includeScreenshot: true,
          maxDialogs: 8,
          onlyModal: false
        }
      }]
    };
  }

  if (latest.status === "done" && normalizedPath === "/revit/computer-use-observe") {
    const result = objectValue(latest.result_json);
    if (result.blocked_by_modal !== true) return null;
    const event = objectValue(result.last_dialog_event);
    const policy = clean(event.policy_category).toLowerCase();
    if (policy === "requires_user_approval" || policy === "blocker") {
      return {
        version: "operator.backend.v1",
        assistant_message:
          `Revit is blocked by a ${policy.replaceAll("_", " ")} dialog. Progress is preserved; I will not dismiss a destructive or unknown prompt automatically.`,
        actions: []
      };
    }
    if (policy === "safe_ok" || policy === "safe_cancel" || policy === "retryable_error") {
      const dialogId = clean(event.dialog_id);
      return {
        version: "operator.backend.v1",
        assistant_message:
          `Revit reported a ${policy.replaceAll("_", " ")} dialog. I will clear only that dialog, then re-observe before any write retry.`,
        actions: [{
          action_id: `existing-conditions-act-${Date.now()}`,
          method: "POST",
          path: "/revit/computer-use-act",
          body: {
            button: policy === "safe_ok" ? "default" : "cancel",
            ...(dialogId ? { dialogIdContains: dialogId } : {}),
            interactionMode: "message_then_mouse",
            cursorRestoreMode: "keep",
            waitForDialogMs: 1500,
            includeScreenshotAfter: true
          }
        }]
      };
    }
  }

  if (latest.status === "done" && normalizedPath === "/revit/computer-use-act") {
    return {
      version: "operator.backend.v1",
      assistant_message:
        "The dialog action completed. I will re-observe the Revit window before deciding whether the interrupted write committed, rolled back, or needs a smaller repair.",
      actions: [{
        action_id: `existing-conditions-reobserve-${Date.now()}`,
        method: "POST",
        path: "/revit/computer-use-observe",
        body: {
          includeScreenshot: true,
          maxDialogs: 8,
          onlyModal: false
        }
      }]
    };
  }
  return null;
}

function workflowFromAction(action: ActionCall | undefined): AtomicMepDraftWorkflowRequest | null {
  if (!action || clean(action.path).toLowerCase() !== "/revit/existing-conditions-mep-draft-workflow") {
    return null;
  }
  if (providerWorkflowContractIssue(action)) return null;
  const row = objectValue(action.body);
  const fingerprint = clean(row.inputFingerprintSha256).toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(fingerprint) || !Array.isArray(row.operations) || row.operations.length === 0) {
    return null;
  }
  return {
    inputFingerprintSha256: fingerprint,
    operations: JSON.parse(JSON.stringify(row.operations)) as AtomicMepDraftWorkflowRequest["operations"],
    provisionalObservationIds: Array.isArray(row.provisionalObservationIds)
      ? row.provisionalObservationIds.map(clean).filter(Boolean)
      : [],
    dryRun: row.dryRun !== false,
    verify: row.verify !== false,
    maximumCreatedElements: Number.isSafeInteger(row.maximumCreatedElements)
      ? Number(row.maximumCreatedElements)
      : 100,
    ...(Number.isSafeInteger(row.targetViewId) ? { targetViewId: Number(row.targetViewId) } : {}),
    ...(typeof row.applyTargetViewPhase === "boolean"
      ? { applyTargetViewPhase: row.applyTargetViewPhase }
      : {}),
    ...(typeof row.requireAllCreatedElementsVisibleInTargetView === "boolean"
      ? { requireAllCreatedElementsVisibleInTargetView: row.requireAllCreatedElementsVisibleInTargetView }
      : {}),
    benchmarkCredit: false,
    authorizationBasis: "explicit_unscored_user_direction"
  };
}

function providerWorkflowContractIssue(action: ActionCall | undefined): string | null {
  if (!action || clean(action.path).toLowerCase() !== "/revit/existing-conditions-mep-draft-workflow") {
    return null;
  }
  const row = objectValue(action.body);
  const fingerprint = clean(row.inputFingerprintSha256).toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(fingerprint)) {
    return "inputFingerprintSha256_must_be_64_lowercase_hex_characters";
  }
  if (!Array.isArray(row.operations) || row.operations.length === 0) {
    return "operations_must_be_a_nonempty_array";
  }
  for (const [index, value] of row.operations.entries()) {
    const operation = objectValue(value);
    const actionKey = clean(operation.action_key) || `index_${index}`;
    if (!clean(operation.action_key)) return `operation_action_key_required:${actionKey}`;
    if (!clean(operation.path)) return `operation_path_required:${actionKey}`;
    if (!Array.isArray(operation.depends_on)) {
      return `operation_depends_on_array_required:${actionKey}`;
    }
    const applyBody = objectValue(operation.apply_body);
    const deferredBody = objectValue(operation.deferred_body);
    if (Object.keys(applyBody).length === 0 && Object.keys(deferredBody).length === 0) {
      return `operation_apply_body_or_deferred_body_required:${actionKey}`;
    }
    const executionMode = clean(operation.execution_mode);
    const batchKey = clean(operation.provisional_batch_key);
    if (executionMode && executionMode !== "single_action" && executionMode !== "provisional_backbone_batch") {
      return `operation_execution_mode_invalid:${actionKey}`;
    }
    if (executionMode === "provisional_backbone_batch") {
      if (!batchKey) return `operation_provisional_batch_key_required:${actionKey}`;
      if (clean(operation.path).toLowerCase() !== "/revit/mep-route-workflow") {
        return `operation_provisional_batch_route_only:${actionKey}`;
      }
      if (operation.depends_on.length > 0) {
        return `operation_provisional_batch_must_be_dependency_free:${actionKey}`;
      }
    } else if (batchKey) {
      return `operation_provisional_batch_execution_mode_required:${actionKey}`;
    }
  }
  return null;
}

function rejectedProviderWorkflowDecision(args: {
  req: ChatRequest;
  action: ActionCall;
  issue: string;
  documentScopeSha256: string | null;
}): ChatResponse {
  appendExecutionEntry({
    sessionId: args.req.session_id,
    event: "action_failed",
    action: args.action,
    status: "failed",
    phase: "dry_run",
    payload: {
      contract_issue: args.issue,
      model_write_issued: false,
      provider_tool_search_required: false
    },
    error: args.issue,
    documentScopeSha256: args.documentScopeSha256
  });
  return {
    version: "operator.backend.v1",
    assistant_message:
      `The host rejected an incomplete staged-workflow envelope before Revit; no model write was issued. Contract issue: ${args.issue}. ` +
      "Do not search the Revit tool catalog for the host ledger. Compile and register the source workflow first, or resubmit a complete workflow in which every operation has an apply_body or deferred_body. " +
      "A provisional backbone batch must explicitly mark each independent /revit/mep-route-workflow operation with execution_mode=provisional_backbone_batch and one shared provisional_batch_key. " +
      `Execution ledger: ${ledgerPath(args.req.session_id)}. Repair ledger: ${existingConditionsRepairLedgerPath(args.req.session_id)}.`,
    actions: []
  };
}

function recordProviderIndependentStageResults(
  sessionId: string,
  workflow: AtomicMepDraftWorkflowRequest,
  toolResults: ToolResult[]
): void {
  const fingerprint = workflow.inputFingerprintSha256.toLowerCase();
  for (const result of toolResults) {
    if (
      clean(result.path).toLowerCase() === "/revit/existing-conditions-mep-draft-workflow" &&
      result.result_json &&
      typeof result.result_json === "object" &&
      !Array.isArray(result.result_json) &&
      clean((result.result_json as Record<string, unknown>).inputFingerprintSha256).toLowerCase() === fingerprint
    ) {
      recordExistingConditionsStageResult({
        sessionId,
        workflow,
        result: {
          ...(result.result_json as Record<string, unknown>),
          action_id: result.action_id
        }
      });
    }
  }
  for (const result of toolResults) {
    recordExistingConditionsVerificationResult({
      sessionId,
      workflow,
      result: result as unknown as Record<string, unknown>
    });
  }
}

function userRequestedPauseBeforeAutomaticSplit(req: ChatRequest): boolean {
  const controlFilePath = executionControlPath(req.session_id);
  if (fs.existsSync(controlFilePath)) {
    return persistedExecutionControl(req.session_id).pause_before_automatic_split;
  }
  const texts = [clean(req.user_text)];
  const requestLogPath = path.join(
    ensureWorkspaceLayout().runsSessions,
    safeSessionId(req.session_id),
    "request_log.jsonl"
  );
  if (fs.existsSync(requestLogPath)) {
    try {
      for (const line of fs.readFileSync(requestLogPath, "utf8").split(/\r?\n/).filter(Boolean).slice(-120)) {
        try {
          const row = JSON.parse(line) as Record<string, unknown>;
          if (typeof row.user_text === "string") texts.push(row.user_text);
        } catch {
          // Ignore an incomplete request-log tail and retain the explicit turn text.
        }
      }
    } catch {
      // A missing pause receipt is non-destructive; the staged ledger remains authoritative.
    }
  }
  return texts.some(textRequestsPauseBeforeAutomaticSplit);
}

function userRequestedDryRunOnly(req: ChatRequest): boolean {
  const controlFilePath = executionControlPath(req.session_id);
  if (fs.existsSync(controlFilePath)) {
    return persistedExecutionControl(req.session_id).dry_run_only;
  }
  const texts = [clean(req.user_text)];
  const requestLogPath = path.join(
    ensureWorkspaceLayout().runsSessions,
    safeSessionId(req.session_id),
    "request_log.jsonl"
  );
  if (fs.existsSync(requestLogPath)) {
    try {
      for (const line of fs.readFileSync(requestLogPath, "utf8").split(/\r?\n/).filter(Boolean).slice(-120)) {
        try {
          const row = JSON.parse(line) as Record<string, unknown>;
          if (typeof row.user_text === "string") texts.push(row.user_text);
        } catch {
          // Ignore an incomplete request-log tail and retain the explicit turn text.
        }
      }
    } catch {
      // Failure to read an older request cannot authorize an apply.
    }
  }
  return texts.some(textRequestsDryRunOnly);
}

function dryRunOnlyPauseDecision(
  req: ChatRequest,
  plan: ReturnType<typeof buildNextExistingConditionsStagePlan>
): ChatResponse | null {
  if (plan.state !== "apply" || !userRequestedDryRunOnly(req)) return null;
  const stageLabel = plan.action_keys.join(", ");
  return {
    version: "operator.backend.v1",
    assistant_message:
      `Dry-run accepted for ${stageLabel}, and I paused before apply as explicitly requested. No apply action was issued. ` +
      `Session: ${req.session_id}. Execution ledger: ${ledgerPath(req.session_id)}. ` +
      `Repair ledger: ${existingConditionsRepairLedgerPath(req.session_id)}.`,
    actions: []
  };
}

function automaticSplitPauseDecision(
  req: ChatRequest,
  plan: ReturnType<typeof buildNextExistingConditionsStagePlan>
): ChatResponse | null {
  if (
    plan.state !== "dry_run" ||
    !plan.stage_key.startsWith("repair:") ||
    !userRequestedPauseBeforeAutomaticSplit(req)
  ) {
    return null;
  }
  const entries = readExistingConditionsRepairLedger(req.session_id);
  const activeRepair = entries.find(entry =>
    entry.event === "repair_registered" &&
    entry.stage_key === plan.stage_key &&
    clean(entry.payload.reason) === "automatic_batch_scope_reduction_after_verified_clean_rollback"
  );
  const supersedesStageKey = clean(activeRepair?.payload.supersedes_stage_key);
  if (!activeRepair || !supersedesStageKey) return null;
  const splitStages = entries
    .filter(entry =>
      entry.event === "repair_registered" &&
      clean(entry.payload.supersedes_stage_key) === supersedesStageKey &&
      clean(entry.payload.reason) === "automatic_batch_scope_reduction_after_verified_clean_rollback"
    )
    .map(entry => clean(entry.stage_key))
    .filter(Boolean);
  const rejected = entries
    .filter(entry => entry.event === "stage_rejected" && entry.stage_key === supersedesStageKey)
    .at(-1);
  return {
    version: "operator.backend.v1",
    assistant_message:
      `The provisional backbone batch ${supersedesStageKey} failed with a clean rollback and was automatically reduced to ${splitStages.length} single-action repair stage(s). ` +
      `Rollback receipt: rollback_verified=${rejected?.payload.rollback_verified === true}, residual_created_element_ids=${JSON.stringify(rejected?.payload.residual_created_element_ids ?? [])}, error=${clean(rejected?.payload.error) || "stage_blocked"}. ` +
      `I paused before executing any split stage as requested. Session: ${req.session_id}. Split stages: ${splitStages.join(", ")}. ` +
      `Execution ledger: ${ledgerPath(req.session_id)}. Repair ledger: ${existingConditionsRepairLedgerPath(req.session_id)}.`,
    actions: []
  };
}

function stagedHandoffDecision(args: {
  sessionId: string;
  workflow: AtomicMepDraftWorkflowRequest;
  providerDecision: ChatResponse;
}): ChatResponse | null {
  let plan = buildNextExistingConditionsStagePlan({
    sessionId: args.sessionId,
    workflow: args.workflow
  });
  if (plan.state === "blocked" && plan.stage_key && plan.action_key) {
    const proposed = args.providerDecision.actions.find(action =>
      clean(action.path).toLowerCase() === "/revit/existing-conditions-mep-draft-workflow"
    );
    const body = objectValue(proposed?.body);
    const candidate = workflowFromAction(proposed);
    const operation = candidate?.operations.length === 1 ? candidate.operations[0] : null;
    const repairStageKey = clean(body.stageKey);
    if (
      candidate &&
      candidate.inputFingerprintSha256 === args.workflow.inputFingerprintSha256 &&
      operation &&
      clean(operation.action_key) === plan.action_key &&
      repairStageKey &&
      repairStageKey !== plan.stage_key
    ) {
      registerExistingConditionsRepairAction({
        sessionId: args.sessionId,
        workflow: args.workflow,
        supersedesStageKey: plan.stage_key,
        repairStageKey,
        operation,
        reason: clean(body.repairReason) || clean(args.providerDecision.assistant_message) || "Provider proposed a smaller source-grounded repair."
      });
      plan = buildNextExistingConditionsStagePlan({
        sessionId: args.sessionId,
        workflow: args.workflow
      });
    }
  }
  if (plan.state === "blocked") {
    return {
      version: "operator.backend.v1",
      assistant_message:
        `The failed stage remains isolated and prior accepted work is preserved. Propose one smaller replacement operation for ${plan.stage_key ?? "the blocked stage"} (${plan.reason}).`,
      actions: []
    };
  }
  if (plan.state === "awaiting_readback") {
    return {
      version: "operator.backend.v1",
      assistant_message:
        `All ${plan.accepted_action_outputs.length} registered existing-conditions stage(s) are accepted and checkpointed. ` +
        "The host stopped this workflow before provider rediscovery or replay.",
      actions: []
    };
  }
  if (plan.state === "verify_readback" || plan.state === "verify_continuation" || plan.state === "verify_visual" || plan.state === "checkpoint") {
    const stageLabel = plan.action_keys.join(", ");
    return {
      version: "operator.backend.v1",
      assistant_message: plan.state === "verify_readback"
        ? `Stage ${stageLabel} is provisional; reading back every created or affected native ID before another write.`
        : plan.state === "verify_continuation"
          ? `Stage ${stageLabel} passed element readback; auditing its registered continuation connectors before visual acceptance.`
        : plan.state === "verify_visual"
          ? `Stage ${stageLabel} passed native and continuation readback; capturing focused visual evidence.`
          : `Stage ${stageLabel} passed native and visual checks; saving its reversible checkpoint.`,
      actions: [{
        action_id: randomUUID(),
        method: plan.method,
        path: plan.path,
        ...(plan.body ? { body: plan.body } : {})
      }]
    };
  }
  if (plan.state !== "dry_run" && plan.state !== "apply") return null;
  const stageLabel = plan.action_keys.join(", ");
  return {
    version: "operator.backend.v1",
    assistant_message: plan.state === "dry_run"
      ? `Dry-running only ${stageLabel}; ${plan.accepted_action_outputs.length} accepted prior action(s) remain untouched.`
      : `Applying only rollback-verified stage ${stageLabel}; earlier accepted progress remains untouched.`,
    actions: [{
      action_id: randomUUID(),
      method: "POST",
      path: "/revit/existing-conditions-mep-draft-workflow",
      body: plan.request
    }]
  };
}

/**
 * Advances a persisted, non-blocked existing-conditions stage without asking a
 * provider to rediscover the next deterministic ledger transition. The caller
 * still runs the returned decision through the normal finalization path so
 * environment policy, verification guards, one-action selection, and planned
 * action receipts remain identical to provider-originated decisions.
 *
 * Returns null when provider judgment is actually useful: there is no staged
 * workflow yet, the workflow is blocked and needs a smaller repair proposal,
 * or every registered operation has reached its checkpoint.
 */
export function maybeContinueExistingConditionsOneActionLoop(
  req: ChatRequest
): ChatResponse | null {
  persistExecutionControlDirectives(req);
  const toolResults = Array.isArray(req.tool_results) ? req.tool_results : [];
  const continuationResults = persistedContinuationResults(
    req.session_id,
    toolResults,
    documentScopeSha256(req.context)
  );
  recordToolResults(req.session_id, toolResults, documentScopeSha256(req.context));
  const boundedReadTerminal = oneBoundedReadTerminalDecision(req, toolResults);
  if (boundedReadTerminal) return boundedReadTerminal;

  const persistedBeforeRecovery = latestExistingConditionsStagedWorkflow(req.session_id);
  if (persistedBeforeRecovery?.execution_boundary === "compile_only") {
    return null;
  }
  if (persistedBeforeRecovery) {
    recordProviderIndependentStageResults(
      req.session_id,
      persistedBeforeRecovery.workflow,
      continuationResults
    );
  }

  const recovery = recoveryDecision(toolResults);
  if (recovery) return recovery;

  const persisted = persistedBeforeRecovery ?? latestExistingConditionsStagedWorkflow(req.session_id);
  if (!persisted) return null;
  if (persisted.execution_boundary === "compile_only") return null;

  if (!persistedBeforeRecovery) {
    recordProviderIndependentStageResults(
      req.session_id,
      persisted.workflow,
      continuationResults
    );
  }
  const plan = buildNextExistingConditionsStagePlan({
    sessionId: req.session_id,
    workflow: persisted.workflow
  });
  const dryRunOnlyPause = dryRunOnlyPauseDecision(req, plan);
  if (dryRunOnlyPause) return dryRunOnlyPause;
  const splitPause = automaticSplitPauseDecision(req, plan);
  if (splitPause) return splitPause;
  if (plan.state === "blocked") {
    return null;
  }

  return stagedHandoffDecision({
    sessionId: req.session_id,
    workflow: persisted.workflow,
    providerDecision: {
      version: "operator.backend.v1",
      assistant_message: "",
      actions: []
    }
  });
}

export function enforceExistingConditionsOneActionLoop(args: {
  req: ChatRequest;
  decision: ChatResponse;
}): ChatResponse {
  persistExecutionControlDirectives(args.req);
  const toolResults = Array.isArray(args.req.tool_results) ? args.req.tool_results : [];
  const currentDocumentScope = documentScopeSha256(args.req.context);
  const continuationResults = persistedContinuationResults(
    args.req.session_id,
    toolResults,
    currentDocumentScope
  );
  recordToolResults(args.req.session_id, toolResults, currentDocumentScope);
  const boundedReadTerminal = oneBoundedReadTerminalDecision(args.req, toolResults);
  if (boundedReadTerminal) return boundedReadTerminal;

  const persistedBeforeRecovery = latestExistingConditionsStagedWorkflow(args.req.session_id);
  if (persistedBeforeRecovery?.execution_boundary === "compile_only") {
    return args.decision;
  }
  if (persistedBeforeRecovery) {
    recordProviderIndependentStageResults(
      args.req.session_id,
      persistedBeforeRecovery.workflow,
      continuationResults
    );
  }

  const recovery = recoveryDecision(toolResults);
  let decision = recovery ?? args.decision;
  if (!recovery) {
    let persisted = persistedBeforeRecovery ?? latestExistingConditionsStagedWorkflow(args.req.session_id);
    const proposed = decision.actions.find(action =>
      clean(action.path).toLowerCase() === "/revit/existing-conditions-mep-draft-workflow"
    );
    const proposedContractIssue = providerWorkflowContractIssue(proposed);
    if (!persisted && proposed && proposedContractIssue) {
      return rejectedProviderWorkflowDecision({
        req: args.req,
        action: proposed,
        issue: proposedContractIssue,
        documentScopeSha256: currentDocumentScope
      });
    }
    const proposedWorkflow = workflowFromAction(proposed);
    const canReplaceCompletedWorkflow = persisted && proposedWorkflow &&
      proposedWorkflow.inputFingerprintSha256 !== persisted.workflow.inputFingerprintSha256 &&
      buildNextExistingConditionsStagePlan({
        sessionId: args.req.session_id,
        workflow: persisted.workflow
      }).state === "awaiting_readback";
    if (!persisted || canReplaceCompletedWorkflow) {
      const workflow = proposedWorkflow;
      if (workflow) {
        const body = objectValue(proposed?.body);
        const sourceViewId = Number.isSafeInteger(workflow.targetViewId)
          ? Number(workflow.targetViewId)
          : 0;
        registerExistingConditionsStagedWorkflow({
          sessionId: args.req.session_id,
          sourceFrameId: clean(body.sourceFrameId ?? body.source_frame_id) || `external:${workflow.inputFingerprintSha256.slice(0, 16)}`,
          sourceViewId,
          registrationContextId: clean(body.registrationContextId ?? body.registration_context_id) || `external:${workflow.inputFingerprintSha256}`,
          workflow
        });
        persisted = latestExistingConditionsStagedWorkflow(args.req.session_id);
      }
    }
    if (persisted) {
      if (!persistedBeforeRecovery) {
        recordProviderIndependentStageResults(
          args.req.session_id,
          persisted.workflow,
          toolResults
        );
      }
      const plan = buildNextExistingConditionsStagePlan({
        sessionId: args.req.session_id,
        workflow: persisted.workflow
      });
      const explicitPause = dryRunOnlyPauseDecision(args.req, plan) ??
        automaticSplitPauseDecision(args.req, plan);
      decision = explicitPause ?? stagedHandoffDecision({
        sessionId: args.req.session_id,
        workflow: persisted.workflow,
        providerDecision: decision
      }) ?? decision;
    }
  }
  const proposedActions = Array.isArray(decision.actions) ? decision.actions : [];
  const registeredRect = loadRegisteredModelRect(args.req);
  let spatiallyRejectedCount = 0;
  const spatiallyAcceptedActions = proposedActions.filter(action => {
    if (!registeredRect) return true;
    const phase = classifyPhase(action.path, action.body);
    if (phase !== "dry_run" && phase !== "apply") return true;
    const outsidePoints = pointsOutsideRegisteredRect(action.body, registeredRect);
    if (outsidePoints.length === 0) return true;
    spatiallyRejectedCount += 1;
    appendExecutionEntry({
      sessionId: args.req.session_id,
      event: "action_failed",
      action,
      status: "failed",
      phase,
      payload: { registered_model_rectangle: registeredRect, outside_points: outsidePoints },
      error: "outside_persisted_registered_model_rectangle",
      documentScopeSha256: currentDocumentScope
    });
    return false;
  });
  const oneBoundedReadKind = persistedExecutionControl(args.req.session_id).one_bounded_read_kind;
  let wrongBoundedReadKindCount = 0;
  const actions = oneBoundedReadKind
    ? spatiallyAcceptedActions.filter(action => {
        const allowed = actionMatchesOneBoundedReadKind(action, oneBoundedReadKind);
        if (!allowed) wrongBoundedReadKindCount += 1;
        return allowed;
      })
    : spatiallyAcceptedActions;
  const ledger = readExistingConditionsExecutionLedger(args.req.session_id);
  const completedPlans = ledger.filter(entry => {
    if (entry.event !== "action_planned") return false;
    const completion = ledger.find(candidate =>
      candidate.sequence > entry.sequence &&
      candidate.event === "action_completed" &&
      candidate.action_id === entry.action_id &&
      candidate.path === entry.path &&
      entriesShareScope(entry, candidate)
    );
    if (!completion) return false;
    if (entry.phase === "readback" || entry.phase === "visual") {
      const invalidatedByLaterWrite = ledger.some(candidate =>
        candidate.sequence > completion.sequence &&
        candidate.event === "action_completed" &&
        candidate.phase === "apply" &&
        entriesShareScope(entry, candidate)
      );
      if (invalidatedByLaterWrite) return false;
    }
    if (
      entry.phase === "recovery" &&
      clean(entry.path).toLowerCase() === "/revit/computer-use-observe"
    ) {
      const invalidatedByDialogAction = ledger.some(candidate =>
        candidate.sequence > completion.sequence &&
        candidate.event === "action_completed" &&
        clean(candidate.path).toLowerCase() === "/revit/computer-use-act" &&
        entriesShareScope(entry, candidate)
      );
      if (invalidatedByDialogAction) return false;
    }
    return true;
  });
  const inFlightPlans = ledger.filter(entry => {
    if (entry.event !== "action_planned") return false;
    return !ledger.some(candidate =>
      candidate.sequence > entry.sequence &&
      (candidate.event === "action_completed" || candidate.event === "action_failed") &&
      candidate.action_id === entry.action_id &&
      candidate.path === entry.path &&
      entriesShareScope(entry, candidate)
    );
  });
  let replayedCount = 0;
  let inFlightCount = 0;
  const remainingActions = actions.filter(action => {
    const actionHash = sha256({
      method: action.method,
      path: action.path,
      body: action.body ?? null
    });
    if (completedPlans.some(entry => entry.action_sha256 === actionHash && scopesMatch(entry, currentDocumentScope))) {
      replayedCount += 1;
      return false;
    }
    if (inFlightPlans.some(entry => entry.action_sha256 === actionHash && scopesMatch(entry, currentDocumentScope))) {
      inFlightCount += 1;
      return false;
    }
    return true;
  });
  const selected = remainingActions.length > 0 ? [remainingActions[0]!] : [];
  if (selected[0]) {
    appendExecutionEntry({
      sessionId: args.req.session_id,
      event: "action_planned",
      action: selected[0],
      status: "planned",
      payload: {
        assistant_message_sha256: sha256(decision.assistant_message),
        proposed_action_count: actions.length,
        document_scope_sha256: currentDocumentScope
      },
      documentScopeSha256: currentDocumentScope
    });
  }

  const suffixParts: string[] = [];
  if (replayedCount > 0) {
    suffixParts.push(
      `I skipped ${replayedCount} exact completed-action replay${replayedCount === 1 ? "" : "s"} and kept the persisted result.`
    );
  }
  if (inFlightCount > 0) {
    suffixParts.push(
      `I kept ${inFlightCount} exact action${inFlightCount === 1 ? "" : "s"} already in flight instead of dispatching a duplicate.`
    );
  }
  const onlySuppressedActions = replayedCount + inFlightCount > 0 && selected.length === 0;
  if (remainingActions.length > 1) {
    suffixParts.push(
      `I queued only the first of ${remainingActions.length} proposed actions so progress remains visible and repairable.`
    );
  }
  if (spatiallyRejectedCount > 0 && registeredRect) {
    suffixParts.push(
      `I rejected ${spatiallyRejectedCount} proposed spatial action${spatiallyRejectedCount === 1 ? "" : "s"} outside the persisted registered model rectangle X ${registeredRect.minX}..${registeredRect.maxX}, Y ${registeredRect.minY}..${registeredRect.maxY}. No model write was issued; the next repair is to remap the source-normalized point and retry only the bounded dry-run.`
    );
  }
  if (wrongBoundedReadKindCount > 0 && oneBoundedReadKind) {
    suffixParts.push(
      `I blocked ${wrongBoundedReadKindCount} proposed action${wrongBoundedReadKindCount === 1 ? "" : "s"} that did not match the authorized single bounded ${oneBoundedReadKind}.`
    );
  }
  const suffix = suffixParts.length > 0 ? ` ${suffixParts.join(" ")}` : "";
  const onlyWrongBoundedReadKind = wrongBoundedReadKindCount > 0 && actions.length === 0;
  return {
    ...decision,
    assistant_message: onlyWrongBoundedReadKind
      ? `No action was executed because this turn authorizes exactly one bounded ${oneBoundedReadKind}; provider preparation or follow-on actions were outside that boundary.${suffix}`
      : onlySuppressedActions
      ? replayedCount > 0
        ? `No action was executed because the provider proposed only already completed or in-flight actions. The persisted result remains accepted; the authoritative current request still needs a new plan.${suffix}`
        : `No duplicate action was dispatched because the exact requested action is already in flight.${suffix}`
      : `${decision.assistant_message}${suffix}`.trim(),
    actions: selected
  };
}

export function existingConditionsExecutionLedgerPath(sessionId: string): string {
  return ledgerPath(sessionId);
}
