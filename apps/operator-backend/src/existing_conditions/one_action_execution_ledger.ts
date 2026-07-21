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
  latestExistingConditionsStagedWorkflow,
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

function recordToolResults(sessionId: string, toolResults: ToolResult[]): void {
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
      error: result.error ?? result.failure_hint ?? null
    });
  }
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
        result: result.result_json as Record<string, unknown>
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
  if (plan.state === "awaiting_readback") return null;
  if (plan.state === "verify_readback" || plan.state === "verify_visual" || plan.state === "checkpoint") {
    return {
      version: "operator.backend.v1",
      assistant_message: plan.state === "verify_readback"
        ? `Stage ${plan.action_key} is provisional; reading back every created or affected native ID before another write.`
        : plan.state === "verify_visual"
          ? `Stage ${plan.action_key} passed native readback; capturing focused visual evidence.`
          : `Stage ${plan.action_key} passed native and visual checks; saving its reversible checkpoint.`,
      actions: [{
        action_id: randomUUID(),
        method: plan.method,
        path: plan.path,
        ...(plan.body ? { body: plan.body } : {})
      }]
    };
  }
  if (plan.state !== "dry_run" && plan.state !== "apply") return null;
  return {
    version: "operator.backend.v1",
    assistant_message: plan.state === "dry_run"
      ? `Dry-running only ${plan.action_key}; ${plan.accepted_action_outputs.length} accepted prior stage(s) remain untouched.`
      : `Applying only rollback-verified stage ${plan.action_key}; earlier accepted progress remains untouched.`,
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
  const toolResults = Array.isArray(req.tool_results) ? req.tool_results : [];
  recordToolResults(req.session_id, toolResults);

  const persistedBeforeRecovery = latestExistingConditionsStagedWorkflow(req.session_id);
  if (persistedBeforeRecovery) {
    recordProviderIndependentStageResults(
      req.session_id,
      persistedBeforeRecovery.workflow,
      toolResults
    );
  }

  const recovery = recoveryDecision(toolResults);
  if (recovery) return recovery;

  const persisted = persistedBeforeRecovery ?? latestExistingConditionsStagedWorkflow(req.session_id);
  if (!persisted) return null;

  if (!persistedBeforeRecovery) {
    recordProviderIndependentStageResults(
      req.session_id,
      persisted.workflow,
      toolResults
    );
  }
  const plan = buildNextExistingConditionsStagePlan({
    sessionId: req.session_id,
    workflow: persisted.workflow
  });
  if (plan.state === "blocked" || plan.state === "awaiting_readback") {
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
  const toolResults = Array.isArray(args.req.tool_results) ? args.req.tool_results : [];
  recordToolResults(args.req.session_id, toolResults);

  const persistedBeforeRecovery = latestExistingConditionsStagedWorkflow(args.req.session_id);
  if (persistedBeforeRecovery) {
    recordProviderIndependentStageResults(
      args.req.session_id,
      persistedBeforeRecovery.workflow,
      toolResults
    );
  }

  const recovery = recoveryDecision(toolResults);
  let decision = recovery ?? args.decision;
  if (!recovery) {
    let persisted = persistedBeforeRecovery ?? latestExistingConditionsStagedWorkflow(args.req.session_id);
    const proposed = decision.actions.find(action =>
      clean(action.path).toLowerCase() === "/revit/existing-conditions-mep-draft-workflow"
    );
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
      decision = stagedHandoffDecision({
        sessionId: args.req.session_id,
        workflow: persisted.workflow,
        providerDecision: decision
      }) ?? decision;
    }
  }
  const proposedActions = Array.isArray(decision.actions) ? decision.actions : [];
  const registeredRect = loadRegisteredModelRect(args.req);
  let spatiallyRejectedCount = 0;
  const actions = proposedActions.filter(action => {
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
      error: "outside_persisted_registered_model_rectangle"
    });
    return false;
  });
  const ledger = readExistingConditionsExecutionLedger(args.req.session_id);
  const completedPlans = ledger.filter(entry => {
    if (entry.event !== "action_planned") return false;
    const completion = ledger.find(candidate =>
      candidate.sequence > entry.sequence &&
      candidate.event === "action_completed" &&
      candidate.action_id === entry.action_id &&
      candidate.path === entry.path
    );
    if (!completion) return false;
    if (entry.phase === "readback" || entry.phase === "visual") {
      const invalidatedByLaterWrite = ledger.some(candidate =>
        candidate.sequence > completion.sequence &&
        candidate.event === "action_completed" &&
        candidate.phase === "apply"
      );
      if (invalidatedByLaterWrite) return false;
    }
    return true;
  });
  const remainingActions = actions.filter(action => {
    const actionHash = sha256({
      method: action.method,
      path: action.path,
      body: action.body ?? null
    });
    return !completedPlans.some(entry => entry.action_sha256 === actionHash);
  });
  const replayedCount = actions.length - remainingActions.length;
  const selected = remainingActions.length > 0 ? [remainingActions[0]!] : [];
  if (selected[0]) {
    appendExecutionEntry({
      sessionId: args.req.session_id,
      event: "action_planned",
      action: selected[0],
      status: "planned",
      payload: {
        assistant_message_sha256: sha256(decision.assistant_message),
        proposed_action_count: actions.length
      }
    });
  }

  const suffixParts: string[] = [];
  if (replayedCount > 0) {
    suffixParts.push(
      `I skipped ${replayedCount} exact completed-action replay${replayedCount === 1 ? "" : "s"} and kept the persisted result.`
    );
  }
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
  const suffix = suffixParts.length > 0 ? ` ${suffixParts.join(" ")}` : "";
  return {
    ...decision,
    assistant_message: `${decision.assistant_message}${suffix}`.trim(),
    actions: selected
  };
}

export function existingConditionsExecutionLedgerPath(sessionId: string): string {
  return ledgerPath(sessionId);
}
