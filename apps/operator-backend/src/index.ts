import http from "node:http";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import { decide, decideStreaming, isDirectBrainRouteRequest } from "./brain.js";
import { readJson, writeJson } from "./http.js";
import { OPERATOR_BACKEND_CONTRACT_VERSION, type ChatRequest, type ToolResult } from "./contracts.js";
import { appendMessage, appendToolSummary, assertSessionOwnership, ensureSession } from "./session_store.js";
import { consumeRestartRequested, scheduleBackendRestart } from "./dev/dev_agent.js";
import { appendAuditLine } from "./audit_log.js";
import { getOrCreateOperatorToken } from "./operator_token.js";
import { ensureWorkspaceLayout } from "./workspace.js";
import {
  appendEvent,
  appendNotification,
  attachToolResultToPlannedStep,
  getSessionOwner,
  getNotificationsAfter,
  setStepStopReason,
  upsertStepPlanned
} from "./memory/sqlite_store.js";
import { maybeHandleMacroSkill } from "./skills/macro_skill_commands.js";
import { ensureDefaultMacroSkills } from "./skills/default_macro_skills.js";
import { writeIssueBundle } from "./telemetry/issue_bundles.js";
import { cancelCodexBrainTurn, getCodexAppServerCompatibility, warmCodexAppServer } from "./brains/codex_brain.js";
import { persistence } from "./persistence/persistence_manager.js";
import { appendFeedbackAndMaybePromote } from "./feedback/feedback_store.js";
import { startFeedbackDevAutofix } from "./feedback/dev_autofix.js";
import { startFeedbackGitHubIssue } from "./feedback/github_issue.js";
import {
  attachGitHubIssueToImprovementJob,
  enqueueFeedbackImprovementJob,
  enqueueManualImprovementJob,
  getImprovementQueueSnapshot,
  startImprovementJobWorker
} from "./improvement/job_worker.js";
import { startUploadQueueWorker } from "./improvement/upload_queue_worker.js";
import { readCloudUploadConfig, writeCloudUploadConfig, type CloudUploadMode } from "./config/cloud_upload.js";
import { findLatestUploadIndexRecord, getLatestImageUploadWithContext, uploadIndexRelativePathExists } from "./attachments/upload_index.js";
import { getAttachmentUploadRequestLimitBytes, storeAttachmentUpload } from "./attachments/upload_store.js";
import { parseAttachmentUploadInput } from "./attachments/upload_request.js";
import { ingestDocument, knowledgeBaseOwnerIdForPrincipal, listKnowledgeBaseDocuments, getKnowledgeBaseDocumentStatus, searchKnowledgeBase } from "./knowledge_base/service.js";
import { ocrImage } from "./tools/ocr.js";
import { getOcrCapabilities } from "./tools/ocr_capabilities.js";
import { warmOcr } from "./tools/ocr.js";
import { analyzeRedlineFile } from "./redline/redline_analyzer.js";
import { mapSheetRegions } from "./redline/sheet_region_mapper.js";
import { orientRedlineFile } from "./redline/redline_orienter.js";
import { resolveMepSemanticRoutePlan } from "./deterministic/mep_semantic_route.js";
import { adaptMepSemanticRoutePlanToAecIntentEvidence } from "./deterministic/mep_semantic_route_evidence.js";
import { resolveAecTaskIntentHttp } from "./aec_task_intent_http.js";
import { tryCreateRedlineAnalyzeEvidence } from "./redline/redline_analyze_evidence.js";
import { analyzeRedlinePackageWithGemini } from "./vision/gemini_redline_package.js";
import { buildEvidencePack } from "./evidence/evidence_pack.js";
import { maybePersistAutoTurnMemory } from "./memory/auto_turn_memory.js";
import { addProjectStandard, readProjectProfile } from "./memory/project_profile.js";
import { handleRequirementsHttpRoute } from "./memory/requirements_http_routes.js";
import { requiresMemoryAuthentication } from "./memory/requirements_route_policy.js";
import { createOpenAiClient, resolveOpenAiApiKey } from "./openai_client.js";
import { getDesktopComputerConfig, relayDesktopComputerResponse } from "./desktop_computer.js";
import {
  authenticateRequest,
  isPrincipalAuthMode,
  isUnauthenticatedPrincipalRoute,
  requiresRequestAuthentication,
  resolveAuthMode
} from "./auth.js";
import {
  createPrincipalBoundSessionId,
  isSessionIdBoundToPrincipal,
  runWithRequestContext,
  type RequestPrincipal
} from "./request_context.js";
import { createArtifactShare, listArtifacts, resolveArtifactShare } from "./artifacts/artifact_bus.js";
import { describeVisibleElementsInventory, getChatRequestLimitBytes } from "./tool_result_compaction.js";
import {
  createZippyBimJob,
  getZippyBimConfig,
  getZippyBimHealth,
  getZippyBimJob,
  getZippyBimJobResult,
  listZippyBimJobs,
  listZippyBimPdfSources
} from "./zippybim/service.js";
import { buildZippyBimToolHtml } from "./zippybim/tool_ui.js";
import {
  approveRevitBatchJob,
  cancelRevitBatchJob,
  claimNextRevitBatchItem,
  completeRevitBatchItem,
  createRevitBatchJob,
  failRevitBatchItem,
  getRevitBatchJob,
  listRevitBatchJobs,
  listRevitBatchTemplates,
  retryFailedRevitBatchItems,
  resumeRevitBatchJob,
  pauseRevitBatchJob,
  type RevitBatchAccessContext
} from "./revit_batch/service.js";
import { normalizeIncomingToolResults, registerServerPlannedActions } from "./revit_batch/tool_result_normalization.js";
import { authorizeRevitToolJobExecution, claimNextRevitToolJob, completeRevitToolJob, failRevitToolJob } from "./courier/revit_tool_jobs.js";
import {
  authorizeDirectRevitExecution,
  DIRECT_REVIT_AUTHORIZATION_HTTP_MAX_BYTES,
  DirectRevitExecutionAuthorizationError
} from "./capabilities/direct_revit_execution_authorization.js";
import {
  getSafeReadCapabilityService,
  SAFE_READ_AUTHORIZE_EXECUTION_ENDPOINT,
  SAFE_READ_HTTP_MAX_BYTES,
  SAFE_READ_PREAUTHORIZE_ENDPOINT,
  SafeReadCapabilityError,
  safeReadDirectEndpointEnvelope,
  safeReadPrincipalScope
} from "./capabilities/safe_read_capability.js";
import {
  getOperatorTask,
  listOperatorTasks,
  logTeachSkillUsage,
  registerTeachSkillPackage
} from "./tasks/service.js";
import {
  appendGoalAction,
  appendGoalEvidence,
  appendGoalValidation,
  appendGoalProgress,
  completeGoalAfterAudit,
  createGoal,
  clearAgentGoal,
  getGoal,
  getActiveGoalForSession,
  listGoals,
  markAgentGoalBlocked,
  markAgentGoalComplete,
  requestGoalCompletionAudit,
  setAgentGoal,
  transitionGoal,
  updateGoal
} from "./goals/service.js";
import { classifyAutoGoalRequest } from "./goals/auto_goal.js";
import { buildSidecarDiagnosticReport } from "./sidecar_diagnostics.js";
import {
  applyEnvironmentPolicyToActions,
  buildCapabilityManifest,
  clearEnvironmentProfile,
  ensureEnvironmentProfile,
  formatEnvironmentSummaryForPrompt,
  getEnvironmentProfilePath,
  recordToolResultsEnvironmentMemory,
  refreshEnvironmentProfile,
  runDemoReadinessCheck
} from "./environment_profile.js";

const defaultPort = 7007;
const port = Number.parseInt(process.env.OPERATOR_BACKEND_PORT ?? "", 10) || defaultPort;
const operatorToken = getOrCreateOperatorToken();
const devAgentToken = (process.env.OPERATOR_DEV_AGENT_TOKEN || "").trim();
const authMode = resolveAuthMode();
const allowedOrigins = parseAllowedOrigins(process.env.OPERATOR_ALLOWED_ORIGINS);
const chatRequestLimitBytes = getChatRequestLimitBytes();

// Ensure local-first workspace structure exists on startup.
ensureWorkspaceLayout();
ensureDefaultMacroSkills();
try {
  ensureEnvironmentProfile({ refreshIfStale: true });
} catch {
  // Environment profiling is best-effort; startup must not fail on locked-down machines.
}

// Best-effort: warm OCR early to avoid first-run timeouts (especially for tesseract.js which may download language data).
// Do not block startup.
getOcrCapabilities()
  .then(c => {
    if (c?.provider === "tesseract-js") warmOcr();
  })
  .catch(() => {
    // ignore
  });

function readAttachmentPolicy(ctx: unknown): { shareWithAgent: boolean; autoOpenLatestAttachment: boolean } {
  const base: any = ctx && typeof ctx === "object" ? (ctx as any) : {};
  const ui: any = base.ui && typeof base.ui === "object" ? base.ui : {};
  const pol: any =
    (ui.attachment_policy && typeof ui.attachment_policy === "object" ? ui.attachment_policy : null) ??
    (ui.attachmentPolicy && typeof ui.attachmentPolicy === "object" ? ui.attachmentPolicy : null);

  const shareRaw = pol?.share_with_agent ?? pol?.shareWithAgent;
  const autoRaw = pol?.auto_open_latest_attachment ?? pol?.autoOpenLatestAttachment;

  const shareWithAgent = typeof shareRaw === "boolean" ? shareRaw : true;
  const autoOpenLatestAttachment = typeof autoRaw === "boolean" ? autoRaw : false;
  return { shareWithAgent, autoOpenLatestAttachment: shareWithAgent && autoOpenLatestAttachment };
}

function maybeAutoAttachLatestUpload(
  userAttachments: NonNullable<ChatRequest["user_attachments"]>,
  ctx: unknown,
  sessionId: string
): NonNullable<ChatRequest["user_attachments"]> {
  const pol = readAttachmentPolicy(ctx);
  if (!pol.autoOpenLatestAttachment) return userAttachments;

  const { image, context } = getLatestImageUploadWithContext(sessionId);
  const next = Array.isArray(userAttachments) ? [...userAttachments] : [];

  const hasId = (id: string) => next.some(a => (a?.id ?? "").toString() === id);
  const hasPath = (rp: string) => next.some(a => (a as any)?.relative_path && String((a as any).relative_path) === rp);

  const pushRecord = (r: any, fallbackId: string) => {
    if (!r || typeof r !== "object") return;
    const id = typeof r.id === "string" && r.id.trim() ? r.id.trim() : fallbackId;
    const rp = typeof r.relative_path === "string" ? r.relative_path.trim() : "";
    if (!rp) return;
    if (hasId(id) || hasPath(rp)) return;
    next.push({
      id,
      relative_path: rp,
      filename: typeof r.filename === "string" ? r.filename.trim() : undefined,
      bytes: typeof r.bytes === "number" ? r.bytes : undefined,
      sha256: typeof r.sha256 === "string" ? r.sha256.trim() : undefined,
      mime: typeof r.mime === "string" ? r.mime.trim() : undefined,
      created_at: typeof r.created_at === "string" ? r.created_at.trim() : undefined
    });
  };

  pushRecord(image, "latest_upload_image");
  pushRecord(context, "latest_upload_context");
  return next;
}

// Best-effort: if Codex is selected, warm up the app-server process early (before first chat request).
if ((process.env.OPERATOR_BRAIN || "").toLowerCase().trim() === "codex") {
  warmCodexAppServer().catch(() => {
    // ignore; codex is feature-flagged and may not be installed/logged-in on every machine
  });
}

function log(evt: string, data: Record<string, unknown>): void {
  const entry = { ts: new Date().toISOString(), evt, ...data };
  appendAuditLine(entry);
  // eslint-disable-next-line no-console
  console.log(JSON.stringify(entry));
}

function issueBundlesEnabled(): boolean {
  const v = (process.env.OPERATOR_ISSUE_BUNDLES ?? "").trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes";
}

function warningsReportOfferEnabled(): boolean {
  // Default off: this was too noisy (especially on first load when delta can be large).
  const v = (process.env.OPERATOR_WARNINGS_REPORT_OFFER ?? "").trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes";
}

function captureBackendErrorBundle(sessionId: string, messageId: string | undefined, err: unknown, context?: unknown): void {
  if (!issueBundlesEnabled()) return;
  const message = err instanceof Error ? err.message : "Unknown error";
  const stack = err instanceof Error ? err.stack : undefined;
  try {
    writeIssueBundle({
      schema_version: 1,
      captured_at: new Date().toISOString(),
      kind: "backend.error",
      backend: { version: OPERATOR_BACKEND_CONTRACT_VERSION },
      session: { session_id: sessionId, ...(messageId ? { message_id: messageId } : {}) },
      error: { message, ...(stack ? { stack } : {}) },
      ...(context !== undefined ? { context } : {})
    });
  } catch {
    // ignore
  }
}

// Keep the backend alive on unexpected errors so the add-in can retry and resume by session_id.
// (We still log + emit an issue bundle for diagnostics.)
process.on("uncaughtException", (err) => {
  try {
    appendAuditLine({ ts: new Date().toISOString(), kind: "process.uncaughtException", error: String(err), stack: err instanceof Error ? err.stack : undefined });
  } catch {
    // ignore
  }
  try {
    captureBackendErrorBundle("global", undefined, err, { fatal: true, source: "uncaughtException" });
  } catch {
    // ignore
  }
});

process.on("unhandledRejection", (reason) => {
  try {
    appendAuditLine({ ts: new Date().toISOString(), kind: "process.unhandledRejection", reason: String(reason) });
  } catch {
    // ignore
  }
  try {
    captureBackendErrorBundle("global", undefined, reason, { fatal: true, source: "unhandledRejection" });
  } catch {
    // ignore
  }
});

function parseAllowedOrigins(raw: string | undefined): Set<string> {
  // If you need browser-based access (e.g., WebView2), set OPERATOR_ALLOWED_ORIGINS explicitly.
  // Default to the Revit bridge host origin.
  const fallback = ["http://localhost:5000", "http://127.0.0.1:5000"];
  const parts = (raw ?? "")
    .split(",")
    .map(s => s.trim())
    .filter(Boolean);
  return new Set((parts.length > 0 ? parts : fallback).map(s => s.replace(/\/+$/, "")));
}

function applyCors(req: http.IncomingMessage, res: http.ServerResponse, pathname = ""): void {
  const origin = typeof req.headers.origin === "string" ? req.headers.origin.replace(/\/+$/, "") : "";
  if (!origin || !allowedOrigins.has(origin)) return;

  res.setHeader("access-control-allow-origin", origin);
  res.setHeader("vary", "origin");
  res.setHeader("access-control-allow-methods", "GET,POST,OPTIONS");
  res.setHeader(
    "access-control-allow-headers",
    ["content-type", "x-operator-token", "x-operator-dev-agent-token", "authorization"].join(",")
  );
}

function trimText(value: unknown, max = 400): string {
  const text = typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
  if (!text) return "";
  return text.length <= max ? text : `${text.slice(0, max).trim()}…`;
}

/** Match the certified courier producer: preserve safe Unicode identities and reject controls before trimming. */
function trimCourierContextIdentity(value: unknown, max = 200): string {
  if (typeof value !== "string" || value.length > max || /[\u0000-\u001F\u007F]/.test(value)) return "";
  return value.trim();
}

function asStringList(value: unknown, max = 20): string[] {
  return Array.isArray(value)
    ? value.map(item => trimText(item, 300)).filter(Boolean).slice(0, max)
    : [];
}

function tryParseAssistantJsonObject(text: string): Record<string, unknown> | null {
  const raw = `${text || ""}`.trim();
  if (!raw) return null;
  const candidates = [raw];
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced?.[1]) candidates.push(fenced[1].trim());
  const extracted = extractBalancedJsonObject(raw);
  if (extracted) candidates.push(extracted);
  for (const candidate of candidates) {
    for (const normalized of [candidate, stripTrailingJsonCommas(candidate)]) {
      try {
        const parsed = JSON.parse(normalized);
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          return parsed as Record<string, unknown>;
        }
      } catch {
        // ignore
      }
    }
  }
  return null;
}

function extractBalancedJsonObject(text: string): string | null {
  const raw = `${text || ""}`;
  const start = raw.indexOf("{");
  if (start < 0) return null;
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let index = start; index < raw.length; index += 1) {
    const char = raw[index];
    if (inString) {
      if (escape) {
        escape = false;
      } else if (char === "\\") {
        escape = true;
      } else if (char === "\"") {
        inString = false;
      }
      continue;
    }
    if (char === "\"") {
      inString = true;
      continue;
    }
    if (char === "{") depth += 1;
    if (char === "}") {
      depth -= 1;
      if (depth === 0) {
        return raw.slice(start, index + 1).trim();
      }
    }
  }
  return null;
}

function stripTrailingJsonCommas(text: string): string {
  return `${text || ""}`.replace(/,\s*([}\]])/g, "$1");
}

function buildDelegatedBatchPlannerPrompt(input: {
  title: string;
  taskPrompt: string;
  scopeDescription: string;
  workItemHint: string;
  previewCount: number;
  maxItems: number;
  successChecks: string[];
}): string {
  return [
    "You are planning a repeated Revit batch job for Operator.",
    "Return JSON only.",
    "Required JSON schema:",
    "{",
    '  "title": "short title",',
    '  "planner_summary": "one short summary",',
    '  "strategy_summary": "how the repeated scope was decomposed",',
    '  "warnings": ["planner warnings or missing assumptions"],',
    '  "work_items": [',
    '    {',
    '      "label": "short item label",',
    '      "item_key": "stable short key if available",',
    '      "task_prompt": "standalone deterministic Revit instruction for this one item",',
    '      "planning_note": "why this item exists or what scope it covers",',
    '      "artifact_paths": []',
    "    }",
    "  ]",
    "}",
    "Rules:",
    "- Decompose the work into bounded independent items.",
    "- Each task_prompt must be executable on its own without implicit prior-item context.",
    "- Prefer one room, one fixture cluster, one sheet, one element group, or similarly bounded scope per item.",
    "- If you cannot confidently enumerate multiple items, return exactly one conservative work_item instead of returning malformed JSON or an empty list.",
    `- Return at most ${input.maxItems} work items.`,
    `- The first ${input.previewCount} items should provide a meaningful preview sample.`,
    input.successChecks.length > 0
      ? `Success checks to keep in mind:\n${input.successChecks.map(item => `- ${item}`).join("\n")}`
      : "Success checks: none provided.",
    "",
    `Batch title: ${input.title || "(missing)"}`,
    `Repeated task request: ${input.taskPrompt || "(missing)"}`,
    `Scope description: ${input.scopeDescription || "(not provided)"}`,
    `Preferred work-item granularity: ${input.workItemHint || "(not provided)"}`,
    "",
    "If the task is underspecified, still produce the safest useful worklist you can and put the missing assumptions in warnings."
  ].join("\n");
}

function buildDelegatedBatchPlannerRepairPrompt(originalPrompt: string, malformedResponse: string): string {
  return [
    "You are repairing a malformed delegated Revit batch planner response.",
    "Return JSON only.",
    "Use the exact JSON schema requested in the original planner prompt.",
    "Do not add commentary, markdown fences, or explanations.",
    "If the malformed response omitted optional fields, fill them conservatively with empty strings/arrays instead of inventing new scope.",
    "",
    "Original planner prompt:",
    originalPrompt || "(missing)",
    "",
    "Malformed planner response to repair:",
    malformedResponse || "(missing)"
  ].join("\n");
}

function splitExplicitWorkItemHint(workItemHint: string, maxItems: number): string[] {
  const hint = trimText(workItemHint, 800)
    .replace(/[\r\n;]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!hint) return [];

  const marker = /(?:^|(?:\s+(?:and|,)\s+))one\s+(?:work\s+)?item\s+for\s+/i;
  if (!marker.test(hint)) return [];

  const stripped = hint.replace(/^\s*one\s+(?:work\s+)?item\s+for\s+/i, "");
  const parts = stripped
    .split(/\s+(?:and|,)\s+one\s+(?:work\s+)?item\s+for\s+/i)
    .map(part => trimText(part, 180))
    .filter(Boolean)
    .slice(0, Math.max(1, maxItems));

  return parts.length > 1 ? parts : [];
}

function buildFallbackDelegatedBatchPlan(input: {
  title: string;
  taskPrompt: string;
  scopeDescription: string;
  workItemHint: string;
  maxItems: number;
}, reason: string, assistantMessage = ""): Record<string, unknown> {
  const warnings = [trimText(reason, 400)];
  const assistantSnippet = trimText(assistantMessage, 600);
  if (assistantSnippet) warnings.push(`Planner raw response (truncated): ${assistantSnippet}`);
  const hintedItems = splitExplicitWorkItemHint(input.workItemHint, input.maxItems);
  const label = trimText(input.workItemHint || input.scopeDescription || input.title || "Fallback batch item", 160);
  const planningNote = [
    hintedItems.length > 1
      ? "Using a structured fallback split from the explicit work-item hint because the delegated batch planner output was invalid or incomplete."
      : "Using a conservative single-item fallback because the delegated batch planner output was invalid or incomplete.",
    input.scopeDescription ? `Scope: ${input.scopeDescription}` : "",
    input.workItemHint ? `Preferred granularity: ${input.workItemHint}` : ""
  ].filter(Boolean).join(" ");
  const fallbackItems = hintedItems.length > 1
    ? hintedItems.map((item, index) => ({
        label: trimText(item, 160) || `Fallback item ${index + 1}`,
        item_key: `fallback_${index + 1}`,
        task_prompt: trimText([
          input.taskPrompt,
          "",
          `This fallback work item is limited to: ${item}.`,
          "Do not perform the other hinted work items except as needed for verification."
        ].join("\n"), 4000),
        planning_note: trimText(planningNote, 600),
        artifact_paths: []
      }))
    : [
        {
          label: label || "Fallback scope item",
          item_key: "fallback_scope",
          task_prompt: input.taskPrompt,
          planning_note: trimText(planningNote, 600),
          artifact_paths: []
        }
      ];

  return {
    title: input.title || "Run a repeated Revit task across a scope",
    planner_summary: "Planner fallback used because the delegated batch plan could not be validated.",
    strategy_summary: hintedItems.length > 1
      ? "Split the repeated task using the explicit work-item hint instead of failing batch setup outright."
      : "Run the repeated task as one bounded fallback item instead of failing batch setup outright.",
    warnings,
    work_items: fallbackItems.slice(0, Math.max(1, input.maxItems))
  };
}

function normalizeDelegatedBatchPlan(raw: unknown, input: {
  title: string;
  taskPrompt: string;
  scopeDescription: string;
  workItemHint: string;
  maxItems: number;
}): Record<string, unknown> {
  const rec = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const workItems = Array.isArray(rec.work_items) ? rec.work_items : [];
  const normalizedItems = workItems
    .map((item, index) => {
      const row = item && typeof item === "object" && !Array.isArray(item) ? (item as Record<string, unknown>) : {};
      const taskPrompt = trimText(row.task_prompt, 4000);
      if (!taskPrompt) return null;
      return {
        label: trimText(row.label, 160) || `Item ${index + 1}`,
        item_key: trimText(row.item_key, 120) || `item_${index + 1}`,
        task_prompt: taskPrompt,
        planning_note: trimText(row.planning_note, 600),
        artifact_paths: asStringList(row.artifact_paths, 12)
      };
    })
    .filter(Boolean)
    .slice(0, Math.max(1, input.maxItems));

  if (normalizedItems.length === 0) {
    return buildFallbackDelegatedBatchPlan(
      input,
      "Planner output did not contain any runnable work_items.",
      typeof rec.assistant_message === "string" ? rec.assistant_message : ""
    );
  }

  return {
    title: trimText(rec.title, 160) || input.title || "Run a repeated Revit task across a scope",
    planner_summary: trimText(rec.planner_summary, 1200) || "Repeated Revit work was decomposed into bounded items.",
    strategy_summary: trimText(rec.strategy_summary, 1200) || "The repeated scope was normalized into runnable work items.",
    warnings: asStringList(rec.warnings, 20),
    work_items: normalizedItems
  };
}

function getRevitBatchSessionId(job: any): string {
  return trimText(job?.source?.session_id ?? job?.source?.sessionId, 160);
}

function getRevitBatchCounts(job: any): { total: number; pending: number; running: number; succeeded: number; failed: number; skipped: number } {
  const summary = job?.item_summary ?? {};
  return {
    total: Math.max(0, Number.parseInt(`${summary?.total ?? 0}`, 10) || 0),
    pending: Math.max(0, Number.parseInt(`${summary?.pending ?? 0}`, 10) || 0),
    running: Math.max(0, Number.parseInt(`${summary?.running ?? 0}`, 10) || 0),
    succeeded: Math.max(0, Number.parseInt(`${summary?.succeeded ?? 0}`, 10) || 0),
    failed: Math.max(0, Number.parseInt(`${summary?.failed ?? 0}`, 10) || 0),
    skipped: Math.max(0, Number.parseInt(`${summary?.skipped ?? 0}`, 10) || 0)
  };
}

function notifyRevitBatch(job: any, type: string, text: string, payload?: Record<string, unknown>): void {
  const sessionId = getRevitBatchSessionId(job);
  if (!sessionId) return;
  appendNotification(sessionId, type, text, {
    job_id: trimText(job?.id, 120),
    title: trimText(job?.title, 160),
    status: trimText(job?.status, 80),
    item_summary: getRevitBatchCounts(job),
    ...(payload || {})
  });
}

function maybeNotifyRevitBatchProgress(job: any, phase: "complete" | "fail", item: any): void {
  const counts = getRevitBatchCounts(job);
  const doneCount = counts.succeeded + counts.failed + counts.skipped;
  const shouldNotify =
    doneCount <= 1 ||
    doneCount % 5 === 0 ||
    counts.failed > 0 ||
    counts.total <= doneCount ||
    ["failed", "cancelled", "succeeded", "succeeded_with_failures"].includes(`${job?.status || ""}`.trim().toLowerCase());
  if (!shouldNotify) return;

  const index = Number.parseInt(`${item?.index ?? 0}`, 10) || doneCount;
  const label = trimText(item?.label ?? item?.room_number ?? item?.room_name ?? item?.item_key, 120);
  const itemSuffix = label ? ` (${label})` : "";
  const prefix = phase === "fail" ? "Batch progress" : "Batch progress";
  const failureBits = counts.failed > 0 ? `, ${counts.failed} failed` : "";
  notifyRevitBatch(
    job,
    phase === "fail" ? "revit.batch.item_failed" : "revit.batch.progress",
    `${prefix}: ${trimText(job?.title, 160) || "Revit batch job"}. ${doneCount}/${counts.total} complete${failureBits}. Last item ${phase === "fail" ? "failed" : "completed"}: #${index}${itemSuffix}.`,
    {
      item_index: index,
      item_label: label || undefined,
      phase
    }
  );
}

function getHeader(req: http.IncomingMessage, name: string): string {
  const key = name.toLowerCase();
  const v = req.headers[key];
  if (typeof v === "string") return v.trim();
  if (Array.isArray(v) && v.length > 0) return String(v[0] ?? "").trim();
  return "";
}

function requiresOperatorToken(pathname: string): boolean {
  if (pathname.startsWith("/tools/zippybim/")) return true;
  if (requiresMemoryAuthentication(pathname)) return true;
  // Intentionally include /health to avoid drive-by localhost probing of backend state.
  return (
    pathname === "/chat" ||
    pathname === "/chat/result" ||
    pathname === "/chat/stream" ||
    pathname === "/event" ||
    pathname === "/feedback" ||
    pathname === "/config/cloud-upload" ||
    pathname === "/notifications" ||
    pathname === "/voice/transcribe" ||
    pathname === "/voice/realtime-token" ||
    pathname === "/voice/speak" ||
    pathname === "/desktop/computer/config" ||
    pathname === "/desktop/computer/respond" ||
    pathname === "/attachments/upload" ||
    pathname === "/api/agent-goal" ||
    pathname.startsWith("/api/agent-goal/") ||
    pathname === "/api/goals" ||
    pathname.startsWith("/api/goals/") ||
    pathname === "/api/tasks" ||
    pathname.startsWith("/api/tasks/") ||
    pathname === "/api/teach/skills/register" ||
    pathname === "/api/teach/skills/usage" ||
    pathname === "/api/revit-batch/templates" ||
    pathname === "/api/revit-batch/plan-delegated" ||
    pathname === "/api/revit-batch/jobs" ||
    pathname === "/api/revit-batch/claim-next" ||
    pathname.startsWith("/api/revit-batch/jobs/") ||
    pathname === "/api/revit-courier/claim-next" ||
    pathname.startsWith("/api/revit-courier/jobs/") ||
    pathname === "/api/revit-direct/authorize-execution" ||
    pathname === SAFE_READ_PREAUTHORIZE_ENDPOINT ||
    pathname === SAFE_READ_AUTHORIZE_EXECUTION_ENDPOINT ||
    pathname === "/api/kb/documents/upload" ||
    pathname === "/api/kb/documents" ||
    pathname.startsWith("/api/kb/documents/") ||
    pathname === "/api/kb/search" ||
    pathname === "/session/new" ||
    pathname === "/loop/stop" ||
    pathname === "/tools/ocr" ||
    pathname === "/tools/redline/analyze" ||
    pathname === "/tools/redline/orient" ||
    pathname === "/tools/redline/map-sheet-regions" ||
    pathname === "/tools/redline/gemini-analyze" ||
    pathname === "/tools/mep/semantic-route-plan" ||
    pathname === "/tools/aec/task-intent" ||
    pathname === "/tools/evidence-pack/build" ||
    pathname === "/artifacts/list" ||
    pathname === "/artifacts/share" ||
    pathname === "/health"
  );
}

function sessionOwnerForPrincipal(principal: RequestPrincipal | undefined): { owner_user_id: string; owner_license_id: string } | null {
  if (!isPrincipalAuthMode(authMode) || !principal) return null;
  return { owner_user_id: principal.user_id, owner_license_id: principal.tenant_id || principal.license_id };
}

function sessionAccessAllowed(res: http.ServerResponse, sessionId: string, principal: RequestPrincipal | undefined): boolean {
  const owner = sessionOwnerForPrincipal(principal);
  if (!owner) return true;
  if (!principal || !isSessionIdBoundToPrincipal(sessionId, principal)) {
    writeJson(res, 403, { error: "Forbidden (session is not bound to this principal)." });
    return false;
  }
  const allowed = assertSessionOwnership(sessionId, owner);
  if (allowed.ok) return true;
  writeJson(res, 403, { error: "Forbidden (session belongs to another user)." });
  return false;
}

function objectRecord(value: unknown): Record<string, any> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, any> : {};
}

function consistentBatchBindingValue(label: string, values: unknown[], max: number, normalize = (value: string) => value): string {
  const present = values.map(value => trimText(value, max)).filter(Boolean);
  if (present.length === 0) return "";
  const first = normalize(present[0]!);
  if (present.some(value => normalize(value) !== first)) {
    throw new Error(`Revit batch ${label} fields disagree.`);
  }
  return present[0]!;
}

function revitBatchAccessContext(
  principal: RequestPrincipal | undefined,
  input: unknown
): RevitBatchAccessContext | undefined {
  // In principal mode, owner identity comes only from authenticated claims. Local and
  // shared-token callers may still bind a job to their live session/executor/document;
  // this prevents two Revit instances on the same workstation from cross-claiming.
  // Legacy local callers that send no binding retain the unbound single-user contract.
  const row = objectRecord(input);
  const source = objectRecord(row.source);
  const target = objectRecord(row.target_context ?? row.targetContext);
  const context = objectRecord(row.context);
  const revit = objectRecord(context.revit);
  const canonicalDocument = objectRecord(revit.document);
  const projectIdentity = objectRecord(canonicalDocument.projectIdentity ?? canonicalDocument.project_identity);
  const ui = objectRecord(context.ui);
  const legacyDocument = objectRecord(ui.revit_document);
  const sessionId = consistentBatchBindingValue("session", [row.session_id, row.sessionId, source.session_id, source.sessionId], 200);
  const executorId = consistentBatchBindingValue(
    "target executor",
    [target.executor_id, target.executorId, row.target_executor_id, row.targetExecutorId, row.executor_id, row.executorId, revit.courier_executor_id, legacyDocument.courier_executor_id],
    160
  );
  const fingerprint = consistentBatchBindingValue(
    "project fingerprint",
    [target.project_fingerprint, target.projectFingerprint, row.project_fingerprint, row.projectFingerprint, projectIdentity.fingerprint, canonicalDocument.project_fingerprint, legacyDocument.project_fingerprint],
    256,
    value => value.toLowerCase()
  ).toLowerCase();
  if (!principal && !sessionId && !executorId && !fingerprint) return undefined;
  if (!sessionId || !executorId || !fingerprint) {
    throw new Error("Bound batch requests require session_id, target_executor_id, and project_fingerprint.");
  }
  if (!/^[a-f0-9]{64}$/.test(fingerprint)) {
    throw new Error("Authenticated batch project_fingerprint must be a 64-character SHA-256 value.");
  }
  const documentTitle = consistentBatchBindingValue(
    "document title",
    [target.document_title, target.documentTitle, canonicalDocument.title, legacyDocument.title],
    512,
    value => value.toLowerCase()
  );
  const documentPath = consistentBatchBindingValue(
    "document path",
    [target.document_path, target.documentPath, canonicalDocument.path, legacyDocument.path],
    2048,
    value => value.replace(/\\/g, "/").toLowerCase()
  );
  return {
    ...(principal ? {
      owner: {
        user_id: principal.user_id,
        tenant_id: principal.tenant_id || principal.license_id
      }
    } : {}),
    session_id: sessionId,
    target: {
      executor_id: executorId,
      project_fingerprint: fingerprint,
      ...(documentTitle ? { document_title: documentTitle } : {}),
      ...(documentPath ? { document_path: documentPath } : {})
    }
  };
}

function revitBatchQueryBinding(url: URL): Record<string, string> {
  return {
    session_id: trimText(url.searchParams.get("session_id") ?? url.searchParams.get("sessionId"), 200),
    target_executor_id: trimText(url.searchParams.get("target_executor_id") ?? url.searchParams.get("executor_id"), 160),
    project_fingerprint: trimText(url.searchParams.get("project_fingerprint"), 256)
  };
}

function resolveKnowledgeBaseOwnerId(
  res: http.ServerResponse,
  principal: RequestPrincipal | undefined,
  requestedOwnerUserId: string
): string | null {
  if (principal) {
    const ownerUserId = knowledgeBaseOwnerIdForPrincipal(principal);
    if (!ownerUserId) {
      writeJson(res, 403, { error: "Forbidden (knowledge base owner could not be resolved)." });
      return null;
    }

    const requested = (requestedOwnerUserId ?? "").trim();
    if (requested && requested !== ownerUserId && requested !== principal.user_id) {
      writeJson(res, 403, { error: "Forbidden (knowledge base owner mismatch)." });
      return null;
    }
    return ownerUserId;
  }

  const ownerUserId = (requestedOwnerUserId ?? "").trim();
  if (!ownerUserId) {
    writeJson(res, 400, { error: "ownerUserId is required." });
    return null;
  }
  return ownerUserId;
}

function devAgentUnlocked(req: http.IncomingMessage): boolean {
  if (!devAgentToken) return false;
  const got = getHeader(req, "x-operator-dev-agent-token");
  return got.length > 0 && got === devAgentToken;
}

function withServerContext(existing: unknown, extra: Record<string, unknown>): unknown {
  const base = existing && typeof existing === "object" ? (existing as any) : {};
  const server = (base.__server && typeof base.__server === "object" ? base.__server : {}) as Record<string, unknown>;
  return { ...base, __server: { ...server, ...extra } };
}

function normalizeDownloadFileName(raw: string): string {
  const fallback = "artifact.bin";
  const trimmed = (raw ?? "").trim();
  if (!trimmed) return fallback;
  const cleaned = trimmed.replace(/[\r\n"]/g, "_").replace(/[\\\/]/g, "_");
  return cleaned || fallback;
}

function tryMatchPath(pathname: string, prefix: string): string | null {
  if (!pathname.startsWith(prefix)) return null;
  const rest = pathname.slice(prefix.length);
  return rest.length > 0 ? rest : null;
}

const lastWarningsNoticeAtBySession = new Map<string, number>();
function maybeCreateProactiveNotification(sessionId: string, type: string, payload: unknown): void {
  if (type !== "warnings.count") return;
  if (!warningsReportOfferEnabled()) return;
  if (!payload || typeof payload !== "object") return;
  const p: any = payload;
  const warningCount = typeof p.warning_count === "number" ? p.warning_count : Number.parseInt(String(p.warning_count ?? ""), 10);
  const delta = typeof p.delta === "number" ? p.delta : Number.parseInt(String(p.delta ?? ""), 10);
  if (!Number.isFinite(warningCount) || !Number.isFinite(delta)) return;
  if (delta < 10) return;

  const now = Date.now();
  const last = lastWarningsNoticeAtBySession.get(sessionId) ?? 0;
  // Throttle to avoid spamming the UI if warnings change rapidly.
  if (now - last < 5 * 60 * 1000) return;
  lastWarningsNoticeAtBySession.set(sessionId, now);

  const docTitle = typeof p.document_title === "string" ? p.document_title.trim() : "";
  const docPath = typeof p.document_path === "string" ? p.document_path.trim() : "";
  const docLabel = docTitle || docPath ? ` (${docTitle || docPath})` : "";

  appendNotification(
    sessionId,
    "warnings.report_offer",
    `I noticed Revit warnings increased to ${warningCount} (Δ${delta})${docLabel}. Want a report?`,
    { warning_count: warningCount, delta, document_title: docTitle || undefined, document_path: docPath || undefined }
  );
}

function toolHostDemoHtml(): string {
  return `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Operator Tool Host Demo</title>
    <style>
      :root { color-scheme: light dark; }
      * { box-sizing: border-box; }
      body { margin: 0; font-family: "Segoe UI", Arial, sans-serif; background: linear-gradient(180deg, rgba(30,80,110,0.12), transparent 40%); }
      .wrap { min-height: 100vh; padding: 24px; display: grid; gap: 16px; align-content: start; }
      .hero { display: grid; gap: 8px; }
      .eyebrow { font-size: 12px; letter-spacing: 0.08em; text-transform: uppercase; opacity: 0.7; }
      h1 { margin: 0; font-size: 28px; }
      p { margin: 0; max-width: 72ch; line-height: 1.45; }
      .actions { display: flex; flex-wrap: wrap; gap: 10px; }
      button { padding: 10px 14px; border-radius: 10px; border: 1px solid rgba(127,127,127,0.35); background: rgba(255,255,255,0.08); cursor: pointer; font: inherit; }
      button:hover { background: rgba(255,255,255,0.14); }
      .grid { display: grid; gap: 16px; grid-template-columns: minmax(260px, 340px) minmax(0, 1fr); }
      .card { border: 1px solid rgba(127,127,127,0.25); border-radius: 16px; background: rgba(255,255,255,0.04); padding: 16px; }
      .card h2 { margin: 0 0 10px; font-size: 16px; }
      .card ul { margin: 0; padding-left: 18px; display: grid; gap: 8px; }
      pre { margin: 0; min-height: 360px; max-height: 70vh; overflow: auto; padding: 14px; border-radius: 12px; border: 1px solid rgba(127,127,127,0.2); background: rgba(0,0,0,0.18); font: 12px/1.45 Consolas, monospace; white-space: pre-wrap; }
      @media (max-width: 900px) { .grid { grid-template-columns: 1fr; } pre { min-height: 240px; } }
    </style>
  </head>
  <body>
    <div class="wrap">
      <div class="hero">
        <div class="eyebrow">Operator Hosted UI</div>
        <h1>Dynamic Tool Host Demo</h1>
        <p>This page is served by the backend and talks to Revit through the Operator host bridge. Use it to validate pane/popup hosting plus bounded Revit and backend requests.</p>
      </div>
      <div class="actions">
        <button id="btnPing">Ping Revit</button>
        <button id="btnContext">Read Context</button>
        <button id="btnPickEls">Pick Elements</button>
        <button id="btnShowPicked">Show Picked</button>
        <button id="btnPickPts">Pick 2 Points</button>
        <button id="btnCapture">Capture View</button>
        <button id="btnHealth">Backend Health</button>
        <button id="btnClose">Close</button>
      </div>
      <div class="grid">
        <div class="card">
          <h2>What this proves</h2>
          <ul>
            <li>The backend can launch a hosted UI in the existing Operator pane or a popup window.</li>
            <li>The hosted page can request bounded Revit interactions through the add-in bridge.</li>
            <li>The hosted page can issue authenticated backend requests through the host bridge.</li>
            <li>Tool-specific UI can live outside the main chat surface.</li>
          </ul>
        </div>
        <div class="card">
          <h2>Log</h2>
          <pre id="log"></pre>
        </div>
      </div>
    </div>
    <script>
      const logEl = document.getElementById('log');
      let lastPicked = [];

      function log(title, value) {
        const line = [new Date().toLocaleTimeString(), title, typeof value === 'string' ? value : JSON.stringify(value, null, 2)].join(' | ');
        logEl.textContent = line + "\\n\\n" + logEl.textContent;
      }

      async function call(title, fn) {
        try {
          const value = await fn();
          log(title, value);
          return value;
        } catch (err) {
          log(title + ' error', err && err.message ? err.message : String(err));
          return null;
        }
      }

      function host() {
        return window.OperatorToolHost || null;
      }

      document.getElementById('btnPing').addEventListener('click', () => call('revit.ping', () => host().request('revit.ping', {})));
      document.getElementById('btnContext').addEventListener('click', () => call('revit.executeAction context', () => host().request('revit.executeAction', { method: 'GET', path: '/revit/context' })));
      document.getElementById('btnPickEls').addEventListener('click', () => call('revit.pickElements', async () => {
        const value = await host().request('revit.pickElements', { prompt: 'Select elements for the hosted UI demo, then Finish.' });
        lastPicked = Array.isArray(value && value.elementIds) ? value.elementIds : [];
        return value;
      }));
      document.getElementById('btnShowPicked').addEventListener('click', () => call('revit.showElements', () => {
        if (!lastPicked.length) throw new Error('Pick elements first.');
        return host().request('revit.showElements', { elementIds: lastPicked });
      }));
      document.getElementById('btnPickPts').addEventListener('click', () => call('revit.pickPoints', () => host().request('revit.pickPoints', { count: 2, prompt: 'Pick two points for the hosted UI demo.' })));
      document.getElementById('btnCapture').addEventListener('click', () => call('revit.executeAction export-image', () => host().request('revit.executeAction', { method: 'POST', path: '/revit/export-image', body: {} })));
      document.getElementById('btnHealth').addEventListener('click', () => call('backend.request health', () => host().request('backend.request', { method: 'GET', path: '/health' })));
      document.getElementById('btnClose').addEventListener('click', () => call('host.close', () => host().close()));

      if (window.OperatorToolHost && typeof window.OperatorToolHost.onMessage === 'function') {
        window.OperatorToolHost.onMessage((msg) => {
          if (!msg || !msg.type) return;
          if (msg.type === 'host.ready') log('host.ready', msg.payload || {});
        });
      } else {
        log('bootstrap', 'OperatorToolHost bridge not detected. Open this page inside the Revit Operator host.');
      }
    </script>
  </body>
</html>`;
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);

    if (req.method === "OPTIONS") {
      res.statusCode = 204;
      applyCors(req, res, url.pathname);
      return res.end();
    }

    applyCors(req, res, url.pathname);

    const auth = authenticateRequest(req, {
      mode: authMode,
      requireAuth: requiresRequestAuthentication({
        mode: authMode,
        method: req.method,
        pathname: url.pathname,
        sharedTokenRouteProtected: requiresOperatorToken(url.pathname)
      }),
      sharedToken: operatorToken
    });
    if (!auth.ok) return writeJson(res, auth.status, { error: auth.error });

    // Principal mode exposes only a deliberately minimal liveness receipt
    // without authentication. Do not initialize or reveal a base workspace.
    if (isPrincipalAuthMode(authMode) && !auth.principal && isUnauthenticatedPrincipalRoute(req.method, url.pathname)) {
      return writeJson(res, 200, {
        status: "ok",
        version: OPERATOR_BACKEND_CONTRACT_VERSION,
        auth_mode: authMode,
        authentication_required: true
      });
    }

    if (req.method === "GET" && url.pathname === "/ui/tool-host-demo") {
      const html = toolHostDemoHtml();
      res.statusCode = 200;
      res.setHeader("content-type", "text/html; charset=utf-8");
      res.setHeader("content-length", Buffer.byteLength(html));
      return res.end(html);
    }

    if (req.method === "GET" && url.pathname === "/ui/zippybim-import") {
      const html = buildZippyBimToolHtml(getZippyBimConfig().default_scale_ratio);
      res.statusCode = 200;
      res.setHeader("content-type", "text/html; charset=utf-8");
      res.setHeader("cache-control", "no-store, no-cache, must-revalidate, max-age=0");
      res.setHeader("pragma", "no-cache");
      res.setHeader("expires", "0");
      res.setHeader("content-length", Buffer.byteLength(html));
      return res.end(html);
    }

    const requestContext = auth.principal ? { principal: auth.principal } : {};
    return await runWithRequestContext(requestContext, async () => {
    // Principal mode initializes only the authenticated request's scoped workspace root.
    ensureWorkspaceLayout();
    ensureDefaultMacroSkills();

    if (req.method === "POST" && url.pathname === "/session/new") {
      const session_id = auth.principal ? createPrincipalBoundSessionId(auth.principal) : randomUUID();
      const sessionOwner = sessionOwnerForPrincipal(auth.principal) ?? undefined;
      ensureSession(session_id, sessionOwner);
      try {
        persistence.ensureSession(session_id, {
          created_by: "session.new",
          ...(sessionOwner ? { owner_user_id: sessionOwner.owner_user_id, owner_license_id: sessionOwner.owner_license_id } : {})
        });
      } catch {
        // ignore
      }
      log("session.new", { session_id });
      return writeJson(res, 200, { session_id });
    }

    if (req.method === "GET" && url.pathname === "/environment/profile") {
      const profile = ensureEnvironmentProfile({ refreshIfStale: true });
      return writeJson(res, 200, {
        ok: true,
        profile_path: getEnvironmentProfilePath(),
        profile,
        manifest: buildCapabilityManifest(profile),
        summary: formatEnvironmentSummaryForPrompt(profile)
      });
    }

    if (req.method === "POST" && url.pathname === "/environment/refresh") {
      const profile = refreshEnvironmentProfile();
      return writeJson(res, 200, {
        ok: true,
        profile_path: getEnvironmentProfilePath(),
        profile,
        manifest: buildCapabilityManifest(profile),
        summary: formatEnvironmentSummaryForPrompt(profile)
      });
    }

    if (req.method === "POST" && url.pathname === "/environment/clear") {
      clearEnvironmentProfile();
      const profile = refreshEnvironmentProfile();
      return writeJson(res, 200, {
        ok: true,
        profile_path: getEnvironmentProfilePath(),
        profile,
        manifest: buildCapabilityManifest(profile),
        summary: formatEnvironmentSummaryForPrompt(profile)
      });
    }

    if (req.method === "GET" && url.pathname === "/environment/capabilities") {
      const profile = ensureEnvironmentProfile({ refreshIfStale: true });
      return writeJson(res, 200, { ok: true, manifest: buildCapabilityManifest(profile) });
    }

    if (req.method === "GET" && url.pathname === "/environment/sidecar-diagnostics") {
      const report = await buildSidecarDiagnosticReport();
      return writeJson(res, 200, { ok: true, report });
    }

    if (req.method === "GET" && url.pathname === "/environment/demo-readiness") {
      const profile = ensureEnvironmentProfile({ refreshIfStale: true });
      return writeJson(res, 200, { ok: true, result: runDemoReadinessCheck(profile) });
    }

    if (req.method === "GET" && url.pathname === "/api/goals") {
      const limit = Math.max(1, Math.min(100, Number.parseInt(url.searchParams.get("limit") || "50", 10) || 50));
      const sessionId = trimText(url.searchParams.get("session_id"), 160);
      if (sessionId && !sessionAccessAllowed(res, sessionId, auth.principal)) return;
      const goals = listGoals(limit).filter(goal => !sessionId || goal.related_session_id === sessionId);
      return writeJson(res, 200, { ok: true, goals });
    }

    if (req.method === "GET" && url.pathname === "/api/agent-goal") {
      const sessionId = trimText(url.searchParams.get("session_id"), 160);
      if (!sessionId) return writeJson(res, 400, { error: "session_id is required." });
      if (!sessionAccessAllowed(res, sessionId, auth.principal)) return;
      return writeJson(res, 200, { ok: true, goal: getActiveGoalForSession(sessionId) });
    }

    if (req.method === "POST" && url.pathname === "/api/agent-goal") {
      const body = await readJson(req, 1_000_000);
      const sessionId = trimText((body as any)?.session_id ?? (body as any)?.sessionId ?? (body as any)?.related_session_id, 160);
      if (!sessionId) return writeJson(res, 400, { error: "session_id is required." });
      if (!sessionAccessAllowed(res, sessionId, auth.principal)) return;
      try {
        const owner = sessionOwnerForPrincipal(auth.principal);
        const goal = setAgentGoal(sessionId, {
          ...(body as any),
          ...(owner ? { created_by: owner.owner_user_id } : {})
        });
        appendNotification(sessionId, "goal.set", `Goal set: ${goal.title}`, { goal_id: goal.id, status: goal.status });
        return writeJson(res, 200, { ok: true, goal });
      } catch (error) {
        return writeJson(res, 400, { error: error instanceof Error ? error.message : String(error) });
      }
    }

    if (req.method === "DELETE" && url.pathname === "/api/agent-goal") {
      const sessionId = trimText(url.searchParams.get("session_id"), 160);
      if (!sessionId) return writeJson(res, 400, { error: "session_id is required." });
      if (!sessionAccessAllowed(res, sessionId, auth.principal)) return;
      const goal = clearAgentGoal(sessionId, "Cleared through agent goal API.");
      return writeJson(res, 200, { ok: true, goal });
    }

    {
      const goalAction = url.pathname.match(/^\/api\/agent-goal\/(progress|blocked|complete)$/);
      if (req.method === "POST" && goalAction) {
        const body = await readJson(req, 1_000_000).catch(() => ({}));
        const sessionId = trimText((body as any)?.session_id ?? (body as any)?.sessionId, 160);
        if (!sessionId) return writeJson(res, 400, { error: "session_id is required." });
        if (!sessionAccessAllowed(res, sessionId, auth.principal)) return;
        try {
          const action = goalAction[1];
          const goal =
            action === "progress"
              ? appendGoalProgress(sessionId, body)
              : action === "blocked"
                ? markAgentGoalBlocked(sessionId, (body as any)?.reason ?? (body as any)?.summary ?? "Blocked.", (body as any)?.evidence)
                : markAgentGoalComplete(sessionId, (body as any)?.evidence ?? body);
          appendNotification(sessionId, `goal.${action}`, `Goal ${action}: ${goal.title}`, { goal_id: goal.id, status: goal.status });
          return writeJson(res, 200, { ok: true, goal });
        } catch (error) {
          return writeJson(res, 400, { error: error instanceof Error ? error.message : String(error) });
        }
      }
    }

    if (req.method === "POST" && url.pathname === "/api/goals") {
      const body = await readJson(req, 1_000_000);
      const sessionId = trimText((body as any)?.related_session_id ?? (body as any)?.relatedSessionId ?? (body as any)?.session_id, 160);
      if (sessionId && !sessionAccessAllowed(res, sessionId, auth.principal)) return;
      try {
        const owner = sessionOwnerForPrincipal(auth.principal);
        const goal = createGoal({
          ...(body as any),
          ...(sessionId ? { related_session_id: sessionId } : {}),
          ...(owner ? { created_by: owner.owner_user_id } : {})
        });
        if (goal.related_session_id) {
          appendNotification(goal.related_session_id, "goal.created", `Goal created: ${goal.title}`, { goal_id: goal.id, status: goal.status });
        }
        return writeJson(res, 201, { ok: true, goal });
      } catch (error) {
        return writeJson(res, 400, { error: error instanceof Error ? error.message : String(error) });
      }
    }

    {
      const goalMatch = url.pathname.match(/^\/api\/goals\/([^/]+)$/);
      if (goalMatch) {
        const goalId = decodeURIComponent(goalMatch[1] || "");
        const existing = getGoal(goalId);
        if (!existing) return writeJson(res, 404, { error: "Goal not found." });
        if (existing.related_session_id && !sessionAccessAllowed(res, existing.related_session_id, auth.principal)) return;
        if (req.method === "GET") return writeJson(res, 200, { ok: true, goal: existing });
        if (req.method === "PATCH") {
          try {
            const body = await readJson(req, 1_000_000);
            const requestedSession = trimText((body as any)?.related_session_id ?? (body as any)?.relatedSessionId, 160);
            if (requestedSession && !sessionAccessAllowed(res, requestedSession, auth.principal)) return;
            const goal = updateGoal(goalId, body as any);
            return writeJson(res, 200, { ok: true, goal });
          } catch (error) {
            return writeJson(res, 400, { error: error instanceof Error ? error.message : String(error) });
          }
        }
      }
    }

    {
      const actionMatch = url.pathname.match(/^\/api\/goals\/([^/]+)\/(pause|resume|cancel|block|fail|complete|evidence|actions|validations|completion-audit)$/);
      if (req.method === "POST" && actionMatch) {
        const goalId = decodeURIComponent(actionMatch[1] || "");
        const action = actionMatch[2] || "";
        const existing = getGoal(goalId);
        if (!existing) return writeJson(res, 404, { error: "Goal not found." });
        if (existing.related_session_id && !sessionAccessAllowed(res, existing.related_session_id, auth.principal)) return;
        try {
          const body = await readJson(req, 2_000_000).catch(() => ({}));
          const reason = (body as any)?.reason ?? (body as any)?.summary ?? (body as any)?.blocker ?? (body as any)?.error;
          const goal =
            action === "pause"
              ? transitionGoal(goalId, "paused", reason)
              : action === "resume"
                ? transitionGoal(goalId, "active", reason)
                : action === "cancel"
                  ? transitionGoal(goalId, "canceled", reason)
                  : action === "block"
                    ? transitionGoal(goalId, "blocked", reason)
                    : action === "fail"
                      ? transitionGoal(goalId, "failed", reason)
                      : action === "complete"
                        ? completeGoalAfterAudit(goalId)
                        : action === "evidence"
                          ? appendGoalEvidence(goalId, body)
                          : action === "actions"
                            ? appendGoalAction(goalId, body)
                            : action === "validations"
                              ? appendGoalValidation(goalId, body)
                              : requestGoalCompletionAudit(goalId, body);
          if (goal.related_session_id) {
            appendNotification(goal.related_session_id, `goal.${action}`, `Goal ${action}: ${goal.title}`, { goal_id: goal.id, status: goal.status });
          }
          return writeJson(res, 200, { ok: true, goal });
        } catch (error) {
          return writeJson(res, 400, { error: error instanceof Error ? error.message : String(error) });
        }
      }
    }

    if (req.method === "GET" && url.pathname === "/api/revit-batch/templates") {
      return writeJson(res, 200, { ok: true, defaults: listRevitBatchTemplates() });
    }

    if (req.method === "POST" && url.pathname === "/api/revit-direct/authorize-execution") {
      try {
        const body = await readJson(req, DIRECT_REVIT_AUTHORIZATION_HTTP_MAX_BYTES);
        const authorization = authorizeDirectRevitExecution(body);
        return writeJson(res, 200, { ok: true, authorization });
      } catch (error) {
        const directError = error instanceof DirectRevitExecutionAuthorizationError
          ? error
          : new DirectRevitExecutionAuthorizationError(
              "CERTIFICATION_DIRECT_REQUEST_MALFORMED",
              error instanceof Error ? error.message : "Direct Revit authorization request is invalid.",
              400,
              false
            );
        return writeJson(res, directError.status, {
          ok: false,
          code: directError.code,
          error: directError.message,
          retryable: directError.retryable
        });
      }
    }

    if (req.method === "POST" && (
      url.pathname === SAFE_READ_PREAUTHORIZE_ENDPOINT
      || url.pathname === SAFE_READ_AUTHORIZE_EXECUTION_ENDPOINT
    )) {
      try {
        const body = await readJson(req, SAFE_READ_HTTP_MAX_BYTES);
        const service = getSafeReadCapabilityService();
        const principalScope = safeReadPrincipalScope(auth.mode, auth.principal);
        return writeJson(res, 200, safeReadDirectEndpointEnvelope(service, url.pathname, principalScope, body));
      } catch (error) {
        const safeReadError = error instanceof SafeReadCapabilityError
          ? error
          : new SafeReadCapabilityError(
              "SAFE_READ_REQUEST_MALFORMED",
              error instanceof Error ? error.message : "SafeRead request is invalid.",
              400,
              false
            );
        return writeJson(res, safeReadError.status, safeReadError.body());
      }
    }

    if (req.method === "POST" && url.pathname === "/api/revit-courier/claim-next") {
      const body = await readJson(req, 1_000_000);
      const sessionId = trimCourierContextIdentity((body as any)?.session_id ?? (body as any)?.sessionId, 200);
      const executorId = trimCourierContextIdentity((body as any)?.executor_id ?? (body as any)?.executorId, 200);
      const waitMs = Math.max(0, Math.min(15_000, Number.parseInt(`${(body as any)?.wait_ms ?? 10_000}`, 10) || 0));
      if (!executorId) return writeJson(res, 400, { error: "executor_id is required." });
      if (sessionId && !sessionAccessAllowed(res, sessionId, auth.principal)) return;
      const owner = sessionOwnerForPrincipal(auth.principal);
      const sessionAllowed = sessionId || !owner
        ? undefined
        : (candidateSessionId: string) => {
            const candidateOwner = getSessionOwner(candidateSessionId);
            return candidateOwner?.owner_user_id === owner.owner_user_id &&
              candidateOwner.owner_license_id === owner.owner_license_id;
          };
      try {
        const deadline = Date.now() + waitMs;
        let claim = claimNextRevitToolJob({ session_id: sessionId || null, executor_id: executorId, session_allowed: sessionAllowed });
        while (!claim.job && Date.now() < deadline) {
          await new Promise(resolve => setTimeout(resolve, Math.min(250, Math.max(1, deadline - Date.now()))));
          claim = claimNextRevitToolJob({ session_id: sessionId || null, executor_id: executorId, session_allowed: sessionAllowed });
        }
        return writeJson(res, 200, { ok: true, ...claim });
      } catch (error) {
        return writeJson(res, 400, { error: error instanceof Error ? error.message : String(error) });
      }
    }

    {
      const courierJobActionMatch = url.pathname.match(/^\/api\/revit-courier\/jobs\/([^/]+)\/(authorize-execution|complete|fail)$/);
      if (req.method === "POST" && courierJobActionMatch) {
        const body = await readJson(req, 5_000_000);
        const sessionId = trimCourierContextIdentity((body as any)?.session_id ?? (body as any)?.sessionId, 200);
        const executorId = trimCourierContextIdentity((body as any)?.executor_id ?? (body as any)?.executorId, 200);
        const jobId = decodeURIComponent(courierJobActionMatch[1] || "");
        const action = courierJobActionMatch[2] || "";
        if (!sessionId || !executorId) return writeJson(res, 400, { error: "session_id and executor_id are required." });
        if (!sessionAccessAllowed(res, sessionId, auth.principal)) return;
        try {
          if (action === "authorize-execution") {
            const authorized = authorizeRevitToolJobExecution({ session_id: sessionId, job_id: jobId, executor_id: executorId });
            return writeJson(res, 200, { ok: true, job: authorized.job, authorization: authorized.authorization });
          }
          const job = action === "complete"
            ? completeRevitToolJob({ session_id: sessionId, job_id: jobId, executor_id: executorId, result: (body as any)?.result })
            : failRevitToolJob({
                session_id: sessionId,
                job_id: jobId,
                executor_id: executorId,
                result: (body as any)?.result,
                error: trimText((body as any)?.error, 4000),
                retryable: (body as any)?.retryable === true
              });
          try {
            recordToolResultsEnvironmentMemory([{
              action_id: job.id,
              method: job.method,
              path: job.path,
              status: action === "complete" ? "done" : "failed",
              ...(action === "complete" ? { result_json: (body as any)?.result } : {}),
              ...(action === "fail" ? { error: trimText((body as any)?.error, 4000) || job.error || "Revit courier job failed." } : {})
            }]);
          } catch {
            // Environment memory is advisory and must not break courier completion.
          }
          return writeJson(res, 200, { ok: true, job });
        } catch (error) {
          const terminalJob = error && typeof error === "object" && "job" in error
            ? (error as { job?: unknown }).job
            : undefined;
          return writeJson(res, 400, {
            error: error instanceof Error ? error.message : String(error),
            ...(terminalJob === undefined ? {} : { job: terminalJob })
          });
        }
      }
    }

    if (req.method === "GET" && url.pathname === "/api/tasks") {
      const limit = Math.max(1, Math.min(100, Number.parseInt(url.searchParams.get("limit") || "20", 10) || 20));
      return writeJson(res, 200, { ok: true, tasks: listOperatorTasks(limit) });
    }

    if (req.method === "GET" && url.pathname.startsWith("/api/tasks/")) {
      const taskId = trimText(url.pathname.slice("/api/tasks/".length), 160);
      if (!taskId) return writeJson(res, 400, { error: "Missing task id." });
      const task = getOperatorTask(taskId);
      if (!task) return writeJson(res, 404, { error: "Task not found." });
      return writeJson(res, 200, { ok: true, task });
    }

    if (req.method === "POST" && url.pathname === "/api/teach/skills/register") {
      const body = await readJson(req, 2_000_000);
      const saved = registerTeachSkillPackage(body as any);
      const sessionId = trimText((body as any)?.session_id, 120);
      if (sessionId) {
        appendNotification(
          sessionId,
          "teach.skill.saved",
          `Saved Teach skill '${trimText((saved as any)?.skill_id, 120) || "teach_skill"}'.`,
          saved as any
        );
      }
      return writeJson(res, 200, saved);
    }

    if (req.method === "POST" && url.pathname === "/api/teach/skills/usage") {
      const body = await readJson(req, 1_000_000);
      const saved = logTeachSkillUsage(body as any);
      const sessionId = trimText((body as any)?.session_id, 120);
      if (sessionId) {
        const matched = Array.isArray((body as any)?.skill_matches)
          ? (body as any).skill_matches
              .map((item: any) => trimText(item?.skill_name ?? item?.skill_id, 120))
              .filter(Boolean)
              .slice(0, 4)
          : [];
        appendNotification(
          sessionId,
          "teach.skill_context.used",
          `Matched Teach skill context${matched.length > 0 ? `: ${matched.join(", ")}` : "."}`,
          {
            ...(saved as any),
            skill_matches: Array.isArray((body as any)?.skill_matches) ? (body as any).skill_matches : []
          }
        );
      }
      return writeJson(res, 200, saved);
    }

    if (req.method === "POST" && url.pathname === "/api/revit-batch/plan-delegated") {
      const body = await readJson(req, 1_000_000);
      const title = trimText((body as any)?.title, 160) || "Run a repeated Revit task across a scope";
      const taskPrompt = trimText((body as any)?.task_prompt ?? (body as any)?.taskPrompt, 4000);
      const scopeDescription = trimText((body as any)?.scope_description ?? (body as any)?.scopeDescription, 2000);
      const workItemHint = trimText((body as any)?.work_item_hint ?? (body as any)?.workItemHint, 800);
      const previewCount = Math.max(1, Math.min(10, Number.parseInt(`${(body as any)?.preview_count ?? (body as any)?.previewCount ?? 3}`, 10) || 3));
      const maxItems = Math.max(1, Math.min(300, Number.parseInt(`${(body as any)?.max_items ?? (body as any)?.maxItems ?? 50}`, 10) || 50));
      const successChecks = asStringList((body as any)?.success_checks ?? (body as any)?.successChecks, 12);
      if (!taskPrompt) return writeJson(res, 400, { error: "task_prompt is required." });
      const plannerInput = {
        title,
        taskPrompt,
        scopeDescription,
        workItemHint,
        maxItems
      };

      const plannerRequest: ChatRequest = {
        version: OPERATOR_BACKEND_CONTRACT_VERSION,
        session_id: randomUUID(),
        message_id: randomUUID(),
        user_text: buildDelegatedBatchPlannerPrompt({
          title,
          taskPrompt,
          scopeDescription,
          workItemHint,
          previewCount,
          maxItems,
          successChecks
        }),
        context: withServerContext({
          ui: {
            client: "operator-backend",
            surface: "revit-batch-planner",
            lane: "batch"
          }
        }, { dev_agent_unlocked: devAgentUnlocked(req) })
      };

      const decision = await decide(plannerRequest);
      let parsed = tryParseAssistantJsonObject(decision.assistant_message || "");
      let repairedAssistantMessage = "";
      if (!parsed) {
        const repairRequest: ChatRequest = {
          version: OPERATOR_BACKEND_CONTRACT_VERSION,
          session_id: randomUUID(),
          message_id: randomUUID(),
          user_text: buildDelegatedBatchPlannerRepairPrompt(
            plannerRequest.user_text || "",
            decision.assistant_message || ""
          ),
          context: withServerContext({
            ui: {
              client: "operator-backend",
              surface: "revit-batch-planner-repair",
              lane: "batch"
            }
          }, { dev_agent_unlocked: devAgentUnlocked(req) })
        };
        const repaired = await decide(repairRequest);
        repairedAssistantMessage = repaired.assistant_message || "";
        parsed = tryParseAssistantJsonObject(repairedAssistantMessage);
      }
      const usedFallback = !parsed;
      const plan = parsed
        ? normalizeDelegatedBatchPlan(parsed, plannerInput)
        : buildFallbackDelegatedBatchPlan(
            plannerInput,
            "Batch planner did not return valid JSON after repair; using fallback single-item plan.",
            repairedAssistantMessage || decision.assistant_message || ""
          );
      return writeJson(res, 200, {
        ok: true,
        plan,
        planner_fallback_used: usedFallback,
        ...(usedFallback ? { assistant_message: decision.assistant_message || "", repaired_assistant_message: repairedAssistantMessage || "" } : {})
      });
    }

    if (req.method === "GET" && url.pathname === "/api/revit-batch/jobs") {
      const limit = Math.max(1, Math.min(50, Number.parseInt(url.searchParams.get("limit") || "12", 10) || 12));
      try {
        const access = revitBatchAccessContext(auth.principal, revitBatchQueryBinding(url));
        if (access?.session_id && !sessionAccessAllowed(res, access.session_id, auth.principal)) return;
        return writeJson(res, 200, { ok: true, jobs: listRevitBatchJobs(limit, access) });
      } catch (error) {
        return writeJson(res, 400, { error: error instanceof Error ? error.message : String(error) });
      }
    }

    if (req.method === "POST" && url.pathname === "/api/revit-batch/jobs") {
      const body = await readJson(req, 5_000_000);
      let access: RevitBatchAccessContext | undefined;
      try {
        access = revitBatchAccessContext(auth.principal, body);
      } catch (error) {
        return writeJson(res, 400, { error: error instanceof Error ? error.message : String(error) });
      }
      if (access?.session_id && !sessionAccessAllowed(res, access.session_id, auth.principal)) return;
      const job = createRevitBatchJob(body as any, access);
      const counts = getRevitBatchCounts(job);
      const title = trimText((job as any)?.title, 160) || "Revit batch job";
      const status = trimText((job as any)?.status, 80).toLowerCase();
      const previewCount = Math.min(
        Math.max(1, Number.parseInt(`${(job as any)?.approval?.sample_count ?? 3}`, 10) || 3),
        Math.max(1, counts.total)
      );
      notifyRevitBatch(
        job,
        "revit.batch.created",
        status === "awaiting_approval"
          ? `Starting batch mode: ${title}. Previewing ${previewCount} of ${counts.total} items before approval.`
          : `Starting batch mode: ${title}. ${counts.total} item(s) queued for execution.`,
        { preview_count: previewCount }
      );
      return writeJson(res, 200, { ok: true, job });
    }

    {
      const jobMatch = url.pathname.match(/^\/api\/revit-batch\/jobs\/([^/]+)$/);
      if (req.method === "GET" && jobMatch) {
        let access: RevitBatchAccessContext | undefined;
        try {
          access = revitBatchAccessContext(auth.principal, revitBatchQueryBinding(url));
        } catch (error) {
          return writeJson(res, 400, { error: error instanceof Error ? error.message : String(error) });
        }
        if (access?.session_id && !sessionAccessAllowed(res, access.session_id, auth.principal)) return;
        const job = getRevitBatchJob(decodeURIComponent(jobMatch[1] || ""), access);
        if (!job) return writeJson(res, 404, { error: "Batch job not found." });
        return writeJson(res, 200, { ok: true, job });
      }
    }

    {
      const controlMatch = url.pathname.match(/^\/api\/revit-batch\/jobs\/([^/]+)\/(approve|pause|resume|cancel|retry-failed)$/);
      if (req.method === "POST" && controlMatch) {
        const jobId = decodeURIComponent(controlMatch[1] || "");
        const action = controlMatch[2] || "";
        try {
          const controlBody = await readJson(req, 1_000_000).catch(() => ({}));
          const access = revitBatchAccessContext(auth.principal, {
            ...revitBatchQueryBinding(url),
            ...objectRecord(controlBody)
          });
          if (access?.session_id && !sessionAccessAllowed(res, access.session_id, auth.principal)) return;
          const job =
            action === "approve"
              ? approveRevitBatchJob(jobId, access)
              : action === "pause"
                ? pauseRevitBatchJob(jobId, access)
                : action === "resume"
                  ? resumeRevitBatchJob(jobId, access)
                  : action === "cancel"
                    ? cancelRevitBatchJob(jobId, access)
                    : retryFailedRevitBatchItems(jobId, access);
          const counts = getRevitBatchCounts(job);
          const title = trimText((job as any)?.title, 160) || "Revit batch job";
          if (action === "approve") {
            notifyRevitBatch(job, "revit.batch.approved", `Batch approved: ${title}. 0/${counts.total} complete.`, { operation: action });
          } else if (action === "resume") {
            notifyRevitBatch(job, "revit.batch.resumed", `Batch resumed: ${title}. ${counts.succeeded + counts.failed + counts.skipped}/${counts.total} complete.`, { operation: action });
          } else if (action === "pause") {
            notifyRevitBatch(job, "revit.batch.paused", `Batch paused: ${title}. ${counts.succeeded + counts.failed + counts.skipped}/${counts.total} complete.`, { operation: action });
          } else if (action === "cancel") {
            notifyRevitBatch(job, "revit.batch.cancelled", `Batch cancelled: ${title}. ${counts.succeeded + counts.failed + counts.skipped}/${counts.total} complete.`, { operation: action });
          } else {
            notifyRevitBatch(job, "revit.batch.retry_failed", `Retrying failed items in batch: ${title}.`, { operation: action });
          }
          return writeJson(res, 200, { ok: true, job });
        } catch (error) {
          return writeJson(res, 400, { error: error instanceof Error ? error.message : String(error) });
        }
      }
    }

    if (req.method === "POST" && url.pathname === "/api/revit-batch/claim-next") {
      const body = await readJson(req, 1_000_000);
      try {
        const access = revitBatchAccessContext(auth.principal, body);
        if (access?.session_id && !sessionAccessAllowed(res, access.session_id, auth.principal)) return;
        const claim = claimNextRevitBatchItem({
          job_id: trimText((body as any)?.job_id ?? (body as any)?.jobId, 120),
          executor_id: trimText((body as any)?.executor_id ?? (body as any)?.executorId, 160),
          executor_kind: trimText((body as any)?.executor_kind ?? (body as any)?.executorKind, 120),
          access
        });
        return writeJson(res, 200, claim);
      } catch (error) {
        return writeJson(res, 400, { error: error instanceof Error ? error.message : String(error) });
      }
    }

    {
      const itemMatch = url.pathname.match(/^\/api\/revit-batch\/jobs\/([^/]+)\/items\/([^/]+)\/(complete|fail)$/);
      if (req.method === "POST" && itemMatch) {
        const body = await readJson(req, 5_000_000);
        const jobId = decodeURIComponent(itemMatch[1] || "");
        const itemId = decodeURIComponent(itemMatch[2] || "");
        const action = itemMatch[3] || "";
        const executorId = trimText((body as any)?.executor_id ?? (body as any)?.executorId, 160);
        const claimToken = trimText((body as any)?.claim_token ?? (body as any)?.claimToken, 160);
        try {
          const access = revitBatchAccessContext(auth.principal, body);
          if (access?.session_id && !sessionAccessAllowed(res, access.session_id, auth.principal)) return;
          const payload =
            action === "complete"
              ? completeRevitBatchItem({
                  job_id: jobId,
                  item_id: itemId,
                  executor_id: executorId,
                  claim_token: claimToken,
                  result: (body as any)?.result,
                  access
                })
              : failRevitBatchItem({
                  job_id: jobId,
                  item_id: itemId,
                  executor_id: executorId,
                  claim_token: claimToken,
                  error: trimText((body as any)?.error, 500) || "Batch item failed.",
                  result: (body as any)?.result,
                  access
                });
          const job = (payload as any)?.job;
          const item = (payload as any)?.item;
          if (job) {
            maybeNotifyRevitBatchProgress(job, action === "complete" ? "complete" : "fail", item);
            const status = trimText((job as any)?.status, 80).toLowerCase();
            const counts = getRevitBatchCounts(job);
            const title = trimText((job as any)?.title, 160) || "Revit batch job";
            if (["failed", "cancelled", "succeeded", "succeeded_with_failures"].includes(status)) {
              const failureBits = counts.failed > 0 ? ` ${counts.failed} failed.` : "";
              notifyRevitBatch(
                job,
                "revit.batch.finished",
                `Batch finished: ${title}. ${counts.succeeded}/${counts.total} succeeded.${failureBits}`.trim(),
                { final_status: status }
              );
            }
          }
          return writeJson(res, 200, payload);
        } catch (error) {
          return writeJson(res, 400, { error: error instanceof Error ? error.message : String(error) });
        }
      }
    }

    if (req.method === "GET" && url.pathname === "/desktop/computer/config") {
      return writeJson(res, 200, {
        ok: true,
        ...getDesktopComputerConfig()
      });
    }

    if (req.method === "POST" && url.pathname === "/desktop/computer/respond") {
      try {
        const body = await readJson(req, 30_000_000);
        const response = await relayDesktopComputerResponse(body);
        return writeJson(res, 200, { ok: true, response });
      } catch (err) {
        const message = err instanceof Error ? err.message : "Unknown OpenAI error";
        return writeJson(res, 500, { error: message });
      }
    }

    if (req.method === "POST" && url.pathname === "/voice/transcribe") {
      const apiKey = resolveOpenAiApiKey();
      if (!apiKey) return writeJson(res, 400, { error: "OPERATOR_OPENAI_API_KEY (or OPENAI_API_KEY) is not set." });

      const body = await readJson(req, 15_000_000);
      const parsed = body as any;
      if (!parsed || typeof parsed !== "object") return writeJson(res, 400, { error: "Invalid JSON body" });

      const audioBase64 = typeof parsed.audio_base64 === "string" ? parsed.audio_base64 : typeof parsed.audioBase64 === "string" ? parsed.audioBase64 : "";
      const formatRaw = typeof parsed.format === "string" ? parsed.format : "wav";
      const format = formatRaw.trim().toLowerCase();
      if (!audioBase64) return writeJson(res, 400, { error: "audio_base64 is required." });
      if (format !== "wav" && format !== "mp3" && format !== "webm" && format !== "ogg") {
        return writeJson(res, 400, { error: "format must be 'wav', 'mp3', 'webm', or 'ogg'." });
      }
      if (audioBase64.length > 12_000_000) return writeJson(res, 413, { error: "Audio payload too large." });

      // Prefer the dedicated transcription API to avoid "assistant-y" responses (e.g. speaker-identification refusals).
      // Keep OPERATOR_OPENAI_AUDIO_MODEL for backwards-compat, but default it to a transcription model.
      const modelFromEnv = (process.env.OPERATOR_OPENAI_TRANSCRIBE_MODEL || process.env.OPERATOR_OPENAI_AUDIO_MODEL || "").trim();
      const model = modelFromEnv || "gpt-4o-mini-transcribe";

      try {
        const client = createOpenAiClient(apiKey);
        const audioBytes = Buffer.from(audioBase64, "base64");
        if (!audioBytes || audioBytes.length < 64) return writeJson(res, 200, { text: "" });

        const mime =
          format === "wav"
            ? "audio/wav"
            : format === "webm"
              ? "audio/webm"
              : format === "ogg"
                ? "audio/ogg"
                : "audio/mpeg";
        const fileName =
          format === "wav"
            ? "voice.wav"
            : format === "webm"
              ? "voice.webm"
              : format === "ogg"
                ? "voice.ogg"
                : "voice.mp3";
        const file = new File([audioBytes], fileName, { type: mime });

        // Attempt transcription with configured model, then fall back to whisper-1 if the model is incompatible.
        let text = "";
        try {
          const tr = await client.audio.transcriptions.create({
            file,
            model,
            response_format: "text"
          } as any);
          text = typeof tr === "string" ? tr : typeof (tr as any)?.text === "string" ? (tr as any).text : "";
        } catch (e) {
          const fallbackModel = "whisper-1";
          const tr = await client.audio.transcriptions.create({
            file,
            model: fallbackModel,
            response_format: "text"
          } as any);
          text = typeof tr === "string" ? tr : typeof (tr as any)?.text === "string" ? (tr as any).text : "";
        }

        if (!text || typeof text !== "string") return writeJson(res, 500, { error: "Transcription returned no text." });
        // Normalize whitespace so we can safely insert into the composer.
        text = text.replace(/\s+/g, " ").trim();
        if (!text) return writeJson(res, 200, { text: "", model });
        return writeJson(res, 200, { text, model });
      } catch (err) {
        const message = err instanceof Error ? err.message : "Unknown OpenAI error";
        return writeJson(res, 500, { error: message });
      }
    }

    if (req.method === "POST" && url.pathname === "/voice/realtime-token") {
      const apiKey = resolveOpenAiApiKey();
      if (!apiKey) return writeJson(res, 400, { error: "OPERATOR_OPENAI_API_KEY (or OPENAI_API_KEY) is not set." });

      const body = await readJson(req, 200_000);
      const parsed = body as any;
      if (!parsed || typeof parsed !== "object") return writeJson(res, 400, { error: "Invalid JSON body" });

      const purposeRaw = typeof parsed.purpose === "string" ? parsed.purpose : "transcription";
      const purpose = purposeRaw.trim().toLowerCase();
      if (purpose !== "transcription") return writeJson(res, 400, { error: "purpose must be 'transcription'." });

      const modelFromEnv = (process.env.OPERATOR_OPENAI_REALTIME_TRANSCRIBE_MODEL || "").trim();
      const model = (typeof parsed.model === "string" ? parsed.model : "").trim() || modelFromEnv || "gpt-realtime-whisper";

      const sessionConfigWithTurnDetection = {
        session: {
          type: "transcription",
          audio: {
            input: {
              transcription: {
                model
              },
              turn_detection: {
                type: "server_vad",
                silence_duration_ms: 650
              }
            }
          }
        }
      };
      const sessionConfigWithoutTurnDetection = {
        session: {
          type: "transcription",
          audio: {
            input: {
              transcription: {
                model
              }
            }
          }
        }
      };

      try {
        const safetyId = auth.principal?.user_id || auth.principal?.tenant_id || "revit-operator-local";
        const requestClientSecret = async (sessionConfig: unknown) => fetch("https://api.openai.com/v1/realtime/client_secrets", {
          method: "POST",
          headers: {
            Authorization: `Bearer ${apiKey}`,
            "Content-Type": "application/json",
            "OpenAI-Safety-Identifier": safetyId
          },
          body: JSON.stringify(sessionConfig)
        });

        let response = await requestClientSecret(sessionConfigWithTurnDetection);
        const text = await response.text();
        let data: any = null;
        try {
          data = text ? JSON.parse(text) : null;
        } catch {
          data = null;
        }

        if (!response.ok && /turn[_ -]?detection/i.test(typeof data?.error?.message === "string" ? data.error.message : text)) {
          response = await requestClientSecret(sessionConfigWithoutTurnDetection);
          const retryText = await response.text();
          try {
            data = retryText ? JSON.parse(retryText) : null;
          } catch {
            data = null;
          }
          if (!response.ok) {
            const message =
              typeof data?.error?.message === "string"
                ? data.error.message
                : retryText || `OpenAI realtime token request failed (${response.status}).`;
            return writeJson(res, response.status, { error: message });
          }
        }

        if (!response.ok) {
          const message =
            typeof data?.error?.message === "string"
              ? data.error.message
              : text || `OpenAI realtime token request failed (${response.status}).`;
          return writeJson(res, response.status, { error: message });
        }

        const value =
          typeof data?.value === "string"
            ? data.value
            : typeof data?.client_secret?.value === "string"
              ? data.client_secret.value
              : "";
        if (!value) return writeJson(res, 500, { error: "Realtime token response missing client secret." });

        return writeJson(res, 200, {
          value,
          model,
          expires_at: data?.expires_at ?? data?.client_secret?.expires_at ?? null
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : "Unknown OpenAI error";
        return writeJson(res, 500, { error: message });
      }
    }

    if (req.method === "POST" && url.pathname === "/voice/speak") {
      const apiKey = resolveOpenAiApiKey();
      if (!apiKey) return writeJson(res, 400, { error: "OPERATOR_OPENAI_API_KEY (or OPENAI_API_KEY) is not set." });

      const body = await readJson(req, 1_000_000);
      const parsed = body as any;
      if (!parsed || typeof parsed !== "object") return writeJson(res, 400, { error: "Invalid JSON body" });

      const textRaw = typeof parsed.text === "string" ? parsed.text : typeof parsed.input === "string" ? parsed.input : "";
      const text = textRaw.trim();
      if (!text) return writeJson(res, 400, { error: "text is required." });
      if (text.length > 4096) return writeJson(res, 413, { error: "text too long (max 4096 chars)." });

      const modelFromEnv = (process.env.OPERATOR_OPENAI_TTS_MODEL || "").trim();
      const voiceFromEnv = (process.env.OPERATOR_OPENAI_TTS_VOICE || "").trim();
      const formatFromEnv = (process.env.OPERATOR_OPENAI_TTS_FORMAT || "").trim();
      const speedFromEnv = (process.env.OPERATOR_OPENAI_TTS_SPEED || "").trim();

      const model = (typeof parsed.model === "string" ? parsed.model : "").trim() || modelFromEnv || "gpt-4o-mini-tts";
      const voice = (typeof parsed.voice === "string" ? parsed.voice : "").trim() || voiceFromEnv || "marin";
      const response_format = ((typeof parsed.format === "string" ? parsed.format : "").trim() || formatFromEnv || "mp3").toLowerCase();
      const instructions = typeof parsed.instructions === "string" ? parsed.instructions.trim() : undefined;

      const speedRaw = typeof parsed.speed === "number" ? parsed.speed : speedFromEnv ? Number.parseFloat(speedFromEnv) : undefined;
      const speed = typeof speedRaw === "number" && Number.isFinite(speedRaw) ? speedRaw : undefined;

      if (!["mp3", "opus", "aac", "flac", "wav", "pcm"].includes(response_format)) {
        return writeJson(res, 400, { error: "format must be one of: mp3|opus|aac|flac|wav|pcm" });
      }
      if (speed !== undefined && (speed < 0.25 || speed > 4.0)) return writeJson(res, 400, { error: "speed must be between 0.25 and 4.0." });

      try {
        const client = createOpenAiClient(apiKey);
        const speech = await client.audio.speech.create({
          model,
          voice,
          input: text,
          response_format: response_format as any,
          ...(instructions ? { instructions } : {}),
          ...(speed !== undefined ? { speed } : {})
        } as any);

        const bytes = Buffer.from(await speech.arrayBuffer());
        if (!bytes || bytes.length < 16) return writeJson(res, 500, { error: "TTS returned no audio bytes." });
        if (bytes.length > 12_000_000) return writeJson(res, 413, { error: "TTS audio payload too large." });

        return writeJson(res, 200, {
          audio_base64: bytes.toString("base64"),
          format: response_format,
          model,
          voice
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : "Unknown OpenAI error";
        return writeJson(res, 500, { error: message });
      }
    }

    if (req.method === "POST" && url.pathname === "/chat/stream") {
      const body = await readJson(req, chatRequestLimitBytes);
      const parsed = body as Partial<ChatRequest> | null;
      if (!parsed || typeof parsed !== "object") {
        res.statusCode = 400;
        res.setHeader("content-type", "text/plain; charset=utf-8");
        return res.end("Invalid JSON body");
      }

      const version = parsed.version;
      if (version !== OPERATOR_BACKEND_CONTRACT_VERSION) {
        res.statusCode = 400;
        res.setHeader("content-type", "application/json; charset=utf-8");
        return res.end(
          JSON.stringify({
            error: "Unsupported contract version",
            expected: OPERATOR_BACKEND_CONTRACT_VERSION,
            got: version ?? null
          })
        );
      }

      if (typeof parsed.session_id !== "string" || typeof parsed.message_id !== "string") {
        res.statusCode = 400;
        res.setHeader("content-type", "text/plain; charset=utf-8");
        return res.end("Missing required fields");
      }
      if (!sessionAccessAllowed(res, parsed.session_id, auth.principal)) return;

      const userText = typeof parsed.user_text === "string" ? parsed.user_text : "";
      const toolResults = normalizeIncomingToolResults(parsed.tool_results, parsed.session_id);
      try {
        recordToolResultsEnvironmentMemory(toolResults);
      } catch {
        // ignore environment memory failures
      }
      let userAttachments = normalizeUserAttachments((parsed as any).user_attachments);
      userAttachments = maybeAutoAttachLatestUpload(userAttachments, parsed.context, parsed.session_id);
      const userTextWithAttachments = appendAttachmentsToUserText(userText, userAttachments);
      const canonicalRequest: ChatRequest = {
        ...(parsed as ChatRequest),
        context: withServerContext(parsed.context, { dev_agent_unlocked: devAgentUnlocked(req) }),
        user_text: userTextWithAttachments,
        tool_results: toolResults,
        user_attachments: userAttachments
      };
      if (!userText.trim() && toolResults.length === 0 && userAttachments.length === 0) {
        res.statusCode = 400;
        res.setHeader("content-type", "text/plain; charset=utf-8");
        return res.end("Provide user_text or tool_results");
      }

      maybeStartAutoGoal(parsed.session_id, userTextWithAttachments, toolResults.length, "stream", auth.principal);

      // Phase 1 journaling: user turn received (even if this is a tool-loop continuation).
      try {
        persistence.appendUserTurn({
          sessionId: parsed.session_id,
          messageId: parsed.message_id,
          userText: userTextWithAttachments,
          toolResultsCount: toolResults.length,
          userAttachments
        });
      } catch {
        // ignore
      }

      // Attach incoming tool results to their originating planned step (best-effort).
      for (const tr of toolResults) {
        try {
          attachToolResultToPlannedStep(parsed.session_id as any, tr);
        } catch {
          // ignore
        }
      }
      const macroResp = isDirectBrainRouteRequest(canonicalRequest)
        ? null
        : maybeHandleMacroSkill(canonicalRequest);

      let streamClosed = false;
      const send = (event: string, data: unknown) => {
        if (streamClosed) return;
        try {
          res.write(`event: ${event}\n`);
          res.write(`data: ${JSON.stringify(data)}\n\n`);
        } catch {
          streamClosed = true;
        }
      };

      res.statusCode = 200;
      res.setHeader("content-type", "text/event-stream; charset=utf-8");
      res.setHeader("cache-control", "no-cache, no-transform");
      res.setHeader("connection", "keep-alive");
      try {
        // Force headers immediately so the UI can switch to "running" state.
        (res as any).flushHeaders?.();
      } catch {
        // ignore
      }

      const streamAbort = new AbortController();
      const onReqAborted = () => {
        streamClosed = true;
        try { streamAbort.abort(); } catch {}
      };
      req.on("close", onReqAborted);
      req.on("aborted", onReqAborted);
      let heartbeat: NodeJS.Timeout | null = null;

      try {
      const devUnlocked = devAgentUnlocked(req);
      if (macroResp) {
        macroResp.actions = applyEnvironmentPolicyToActions(macroResp.actions);
        ensureSession(parsed.session_id);
        if (userTextWithAttachments.trim()) appendMessage(parsed.session_id, { role: "user", text: userTextWithAttachments });
        for (const tr of toolResults) appendToolSummary(parsed.session_id, summarizeToolResult(tr));
        appendMessage(parsed.session_id, { role: "assistant", text: macroResp.assistant_message });

        // Phase 1 journaling: tool outputs and assistant.
        try {
          for (const tr of toolResults) {
            persistence.appendToolOutput(parsed.session_id, {
              ts: new Date().toISOString(),
              kind: "revit.result",
              session_id: parsed.session_id,
              message_id: parsed.message_id,
              tool_result: tr
            });
          }
        } catch {
          // ignore
        }
        try {
          persistence.appendAssistantTurn({ sessionId: parsed.session_id, messageId: parsed.message_id, text: macroResp.assistant_message || "" });
        } catch {
          // ignore
        }
        try {
          for (const a of macroResp.actions ?? []) {
            persistence.appendToolCall(parsed.session_id, {
              ts: new Date().toISOString(),
              kind: "revit.action",
              session_id: parsed.session_id,
              message_id: parsed.message_id,
              action: a
            });
          }
        } catch {
          // ignore
        }

        log("chat.request", {
          session_id: parsed.session_id,
          message_id: parsed.message_id,
            user_text: userText,
            stream: true,
            has_tool_results: toolResults.length > 0,
            dev_agent_unlocked: devUnlocked,
            macro: true
          });
          send("chat.start", { session_id: parsed.session_id, message_id: parsed.message_id });
          const text = macroResp.assistant_message || "";
          const chunkSize = 60;
          const delayMs = Math.max(0, Number.parseInt(process.env.OPERATOR_STREAM_DELAY_MS ?? "0", 10) || 0);
          for (let i = 0; i < text.length; i += chunkSize) {
            send("assistant.delta", { text: text.slice(i, i + chunkSize) });
            if (delayMs > 0) await new Promise<void>(resolve => setTimeout(resolve, delayMs));
          }
        send("assistant.done", { text });
        send("actions", { actions: macroResp.actions });
        send("done", {});

          try {
          persistServerPlannedStep(parsed.session_id, parsed.message_id, userTextWithAttachments || null, macroResp.actions);
          if (macroResp.actions.length === 0) setStepStopReason(parsed.session_id as any, parsed.message_id as any, "NO_ACTIONS");
        } catch {
          // ignore
        }
          return;
        }
        log("chat.request", {
          session_id: parsed.session_id,
          message_id: parsed.message_id,
          user_text: userText,
          stream: true,
          has_tool_results: toolResults.length > 0,
          dev_agent_unlocked: devUnlocked
        });
        send("chat.start", { session_id: parsed.session_id, message_id: parsed.message_id });

      ensureSession(parsed.session_id);
      if (userTextWithAttachments.trim()) appendMessage(parsed.session_id, { role: "user", text: userTextWithAttachments });
      for (const tr of toolResults) {
        appendToolSummary(parsed.session_id, summarizeToolResult(tr));
        try {
          appendEvent(parsed.session_id, "tool", "tool.result", tr);
          appendToolFailureEvent(parsed.session_id, parsed.message_id, tr);
        } catch {
          // ignore
        }
      }

      // Phase 1 journaling: tool outputs from the add-in.
      try {
        for (const tr of toolResults) {
          persistence.appendToolOutput(parsed.session_id, {
            ts: new Date().toISOString(),
            kind: "revit.result",
            session_id: parsed.session_id,
            message_id: parsed.message_id,
            tool_result: tr
          });
        }
      } catch {
        // ignore
      }

        if (toolResults.length > 0) {
          for (const tr of toolResults) log("tool.result", { session_id: parsed.session_id, message_id: parsed.message_id, summary: summarizeToolResult(tr) });
        }

        let streamed = "";
        let doneText: string | null = null;
        heartbeat = setInterval(() => {
          send("heartbeat", { ts: new Date().toISOString() });
        }, 5_000);

        const decision = await decideStreaming(
          canonicalRequest,
          {
            abortSignal: streamAbort.signal,
            onDelta: delta => {
              const d = (delta ?? "").toString();
              if (!d) return;
              streamed += d;
              send("assistant.delta", { text: d });
            },
            onDone: full => {
              const t = (full ?? "").toString();
              if (t) doneText = t;
            }
          }
        );
        if (heartbeat) {
          clearInterval(heartbeat);
          heartbeat = null;
        }

        const text = (decision.assistant_message || doneText || streamed || "").toString();
        appendMessage(parsed.session_id, { role: "assistant", text });
        try {
          appendEvent(parsed.session_id, "assistant", "actions", { actions: decision.actions });
        } catch {
          // ignore
        }
        try {
          const autoMem = maybePersistAutoTurnMemory({
            sessionId: parsed.session_id,
            messageId: parsed.message_id,
            userText,
            assistantMessage: text,
            actionsCount: decision.actions.length,
            toolResults,
            ts: new Date().toISOString()
          });
          if (autoMem.saved) appendEvent(parsed.session_id, "assistant", "memory.saved.auto", { daily_path: autoMem.dailyPath });
        } catch {
          // ignore
        }

        // Phase 1 journaling: assistant + outbound tool calls.
        try {
          persistence.appendAssistantTurn({ sessionId: parsed.session_id, messageId: parsed.message_id, text });
        } catch {
          // ignore
        }
        try {
          for (const a of decision.actions ?? []) {
            persistence.appendToolCall(parsed.session_id, {
              ts: new Date().toISOString(),
              kind: "revit.action",
              session_id: parsed.session_id,
              message_id: parsed.message_id,
              action: a
            });
          }
        } catch {
          // ignore
        }

        send("assistant.done", { text });
        send("actions", { actions: decision.actions });
        send("done", {});

        try {
          persistServerPlannedStep(parsed.session_id, parsed.message_id, userTextWithAttachments || null, decision.actions);
          if (decision.actions.length === 0) setStepStopReason(parsed.session_id as any, parsed.message_id as any, "NO_ACTIONS");
        } catch {
          // ignore
        }
      } catch (err) {
        if (heartbeat) {
          clearInterval(heartbeat);
          heartbeat = null;
        }
        if (streamAbort.signal.aborted || streamClosed) {
          try {
            persistServerPlannedStep(parsed.session_id, parsed.message_id, userTextWithAttachments || null, []);
            setStepStopReason(parsed.session_id as any, parsed.message_id as any, "USER_CANCELLED");
          } catch {
            // ignore
          }
          return;
        }

        const message = err instanceof Error ? err.message : "Unknown error";
        try {
          appendEvent(parsed.session_id as any, "assistant", "backend.error", {
            message_id: parsed.message_id,
            message,
            ...(err instanceof Error && typeof err.stack === "string" ? { stack: err.stack } : {})
          });
        } catch {
          // ignore
        }
        try {
          captureBackendErrorBundle(parsed.session_id as any, parsed.message_id as any, err, { stream: true });
        } catch {
          // ignore
        }
        try {
          send("error", { error: message });
          send("done", {});
        } catch {
          // ignore
        }
        try {
          persistServerPlannedStep(parsed.session_id, parsed.message_id, userTextWithAttachments || null, []);
          setStepStopReason(parsed.session_id as any, parsed.message_id as any, "ERROR");
        } catch {
          // ignore
        }
      } finally {
        if (heartbeat) {
          clearInterval(heartbeat);
          heartbeat = null;
        }
        streamClosed = true;
        req.off("close", onReqAborted);
        req.off("aborted", onReqAborted);
        try {
          res.end();
        } catch {
          // ignore
        }
      }
      // If dev agent requested a restart (dev-only), schedule it after the stream closes.
      if (consumeRestartRequested()) setTimeout(() => scheduleBackendRestart(), 250);
      return;
    }

    if (req.method === "GET" && url.pathname === "/chat/result") {
      const session_id = (url.searchParams.get("session_id") ?? "").trim();
      const message_id = (url.searchParams.get("message_id") ?? "").trim();
      if (!session_id || !message_id) return writeJson(res, 400, { error: "session_id and message_id are required." });
      if (!sessionAccessAllowed(res, session_id, auth.principal)) return;
      try {
        const record = persistence.readChatResult({ sessionId: session_id, messageId: message_id });
        res.setHeader("cache-control", "no-store");
        if (!record) return writeJson(res, 202, { status: "pending", session_id, message_id });
        if (record.status === "complete") return writeJson(res, 200, record.response);
        return writeJson(res, 200, { status: "error", session_id, message_id, error: record.error });
      } catch (err) {
        const message = err instanceof Error ? err.message : "Unable to read persisted chat result.";
        return writeJson(res, 500, { error: message });
      }
    }

    if (req.method === "POST" && url.pathname === "/chat") {
      const body = await readJson(req, chatRequestLimitBytes);
      const parsed = body as Partial<ChatRequest> | null;
      if (!parsed || typeof parsed !== "object") {
        return writeJson(res, 400, { error: "Invalid JSON body" });
      }

      const version = parsed.version;
      if (version !== OPERATOR_BACKEND_CONTRACT_VERSION) {
        return writeJson(res, 400, {
          error: "Unsupported contract version",
          expected: OPERATOR_BACKEND_CONTRACT_VERSION,
          got: version ?? null
        });
      }

      if (typeof parsed.session_id !== "string" || typeof parsed.message_id !== "string") {
        return writeJson(res, 400, { error: "Missing required fields" });
      }
      if (!sessionAccessAllowed(res, parsed.session_id, auth.principal)) return;

      const userText = typeof parsed.user_text === "string" ? parsed.user_text : "";
      const toolResults = normalizeIncomingToolResults(parsed.tool_results, parsed.session_id);
      try {
        recordToolResultsEnvironmentMemory(toolResults);
      } catch {
        // ignore environment memory failures
      }
      let userAttachments = normalizeUserAttachments((parsed as any).user_attachments);
      userAttachments = maybeAutoAttachLatestUpload(userAttachments, parsed.context, parsed.session_id);
      const userTextWithAttachments = appendAttachmentsToUserText(userText, userAttachments);
      if (!userText.trim() && toolResults.length === 0 && userAttachments.length === 0) {
        return writeJson(res, 400, { error: "Provide user_text or tool_results" });
      }

      maybeStartAutoGoal(parsed.session_id, userTextWithAttachments, toolResults.length, "chat", auth.principal);

      // Phase 1 journaling: user turn received (even if this is a tool-loop continuation).
      try {
        persistence.appendUserTurn({
          sessionId: parsed.session_id,
          messageId: parsed.message_id,
          userText: userTextWithAttachments,
          toolResultsCount: toolResults.length,
          userAttachments
        });
      } catch {
        // ignore
      }

      // Attach incoming tool results to their originating planned step (best-effort).
      for (const tr of toolResults) {
        try {
          attachToolResultToPlannedStep(parsed.session_id as any, tr);
        } catch {
          // ignore
        }
      }

      const devUnlocked = devAgentUnlocked(req);
      const brainRequest: ChatRequest = {
        ...(parsed as ChatRequest),
        user_text: userTextWithAttachments,
        tool_results: toolResults,
        user_attachments: userAttachments,
        context: withServerContext(parsed.context, { dev_agent_unlocked: devUnlocked })
      };
      const macroResp = isDirectBrainRouteRequest(brainRequest)
        ? null
        : maybeHandleMacroSkill(brainRequest);
      if (macroResp) {
        macroResp.actions = applyEnvironmentPolicyToActions(macroResp.actions);
        ensureSession(parsed.session_id);
        if (userTextWithAttachments.trim()) appendMessage(parsed.session_id, { role: "user", text: userTextWithAttachments });
        for (const tr of toolResults) appendToolSummary(parsed.session_id, summarizeToolResult(tr));
        appendMessage(parsed.session_id, { role: "assistant", text: macroResp.assistant_message });

        // Phase 1 journaling: tool outputs and assistant.
        try {
          for (const tr of toolResults) {
            persistence.appendToolOutput(parsed.session_id, {
              ts: new Date().toISOString(),
              kind: "revit.result",
              session_id: parsed.session_id,
              message_id: parsed.message_id,
              tool_result: tr
            });
          }
        } catch {
          // ignore
        }
        try {
          persistence.appendAssistantTurn({ sessionId: parsed.session_id, messageId: parsed.message_id, text: macroResp.assistant_message || "" });
        } catch {
          // ignore
        }
        try {
          for (const a of macroResp.actions ?? []) {
            persistence.appendToolCall(parsed.session_id, {
              ts: new Date().toISOString(),
              kind: "revit.action",
              session_id: parsed.session_id,
              message_id: parsed.message_id,
              action: a
            });
          }
        } catch {
          // ignore
        }
        try {
          persistServerPlannedStep(parsed.session_id, parsed.message_id, userTextWithAttachments || null, macroResp.actions);
          if (macroResp.actions.length === 0) setStepStopReason(parsed.session_id, parsed.message_id as any, "NO_ACTIONS");
        } catch {
          // ignore
        }

        log("chat.request", {
          session_id: parsed.session_id,
          message_id: parsed.message_id,
          user_text: userText,
          user_attachments: userAttachments.length,
          has_tool_results: toolResults.length > 0,
          dev_agent_unlocked: devUnlocked,
          macro: true
        });
        log("chat.response", {
          session_id: parsed.session_id,
          message_id: parsed.message_id,
          actions: macroResp.actions.map(a => ({ action_id: a.action_id, method: a.method, path: a.path })),
          macro: true
        });
        persistence.persistChatResponse({ sessionId: parsed.session_id, messageId: parsed.message_id, response: macroResp });
        return writeJson(res, 200, macroResp);
      }
      log("chat.request", {
        session_id: parsed.session_id,
        message_id: parsed.message_id,
        user_text: userText,
        user_attachments: userAttachments.length,
        has_tool_results: toolResults.length > 0,
        dev_agent_unlocked: devUnlocked
      });

      ensureSession(parsed.session_id);
      if (userTextWithAttachments.trim()) appendMessage(parsed.session_id, { role: "user", text: userTextWithAttachments });
      for (const tr of toolResults) {
        appendToolSummary(parsed.session_id, summarizeToolResult(tr));
        try {
          appendEvent(parsed.session_id, "tool", "tool.result", tr);
          appendToolFailureEvent(parsed.session_id, parsed.message_id, tr);
        } catch {
          // ignore
        }
      }

      // Phase 1 journaling: tool outputs from the add-in.
      try {
        for (const tr of toolResults) {
          persistence.appendToolOutput(parsed.session_id, {
            ts: new Date().toISOString(),
            kind: "revit.result",
            session_id: parsed.session_id,
            message_id: parsed.message_id,
            tool_result: tr
          });
        }
      } catch {
        // ignore
      }

      if (toolResults.length > 0) {
        for (const tr of toolResults) log("tool.result", { session_id: parsed.session_id, message_id: parsed.message_id, summary: summarizeToolResult(tr) });
      }

      try {
        const decision = await decide({
          ...(parsed as ChatRequest),
          context: withServerContext(parsed.context, { dev_agent_unlocked: devUnlocked }),
          user_text: userTextWithAttachments,
          tool_results: toolResults,
          user_attachments: userAttachments
        });
        appendMessage(parsed.session_id, { role: "assistant", text: decision.assistant_message });
        try {
          appendEvent(parsed.session_id, "assistant", "actions", { actions: decision.actions });
        } catch {
          // ignore
        }
        try {
          const autoMem = maybePersistAutoTurnMemory({
            sessionId: parsed.session_id,
            messageId: parsed.message_id,
            userText,
            assistantMessage: decision.assistant_message || "",
            actionsCount: decision.actions.length,
            toolResults,
            ts: new Date().toISOString()
          });
          if (autoMem.saved) appendEvent(parsed.session_id, "assistant", "memory.saved.auto", { daily_path: autoMem.dailyPath });
        } catch {
          // ignore
        }

        // Phase 1 journaling: assistant + outbound tool calls.
        try {
          persistence.appendAssistantTurn({ sessionId: parsed.session_id, messageId: parsed.message_id, text: decision.assistant_message || "" });
        } catch {
          // ignore
        }
        try {
          for (const a of decision.actions ?? []) {
            persistence.appendToolCall(parsed.session_id, {
              ts: new Date().toISOString(),
              kind: "revit.action",
              session_id: parsed.session_id,
              message_id: parsed.message_id,
              action: a
            });
          }
        } catch {
          // ignore
        }

        try {
          persistServerPlannedStep(parsed.session_id, parsed.message_id, userTextWithAttachments || null, decision.actions);
          if (decision.actions.length === 0) setStepStopReason(parsed.session_id, parsed.message_id, "NO_ACTIONS");
        } catch {
          // ignore
        }
        log("chat.response", {
          session_id: parsed.session_id,
          message_id: parsed.message_id,
          actions: decision.actions.map(a => ({ action_id: a.action_id, method: a.method, path: a.path }))
        });
        persistence.persistChatResponse({ sessionId: parsed.session_id, messageId: parsed.message_id, response: decision });
        const resp = writeJson(res, 200, decision);
        // If dev agent requested a restart (dev-only), schedule it after the response is sent.
        if (consumeRestartRequested()) setTimeout(() => scheduleBackendRestart(), 250);
        return resp;
      } catch (err) {
        const message = err instanceof Error ? err.message : "Unknown error";
        try {
          appendEvent(parsed.session_id, "assistant", "backend.error", {
            message_id: parsed.message_id,
            message,
            ...(err instanceof Error && typeof err.stack === "string" ? { stack: err.stack } : {})
          });
        } catch {
          // ignore
        }
        try {
          captureBackendErrorBundle(parsed.session_id, parsed.message_id, err, { stream: false });
        } catch {
          // ignore
        }
        try {
          persistServerPlannedStep(parsed.session_id, parsed.message_id, userTextWithAttachments || null, []);
          setStepStopReason(parsed.session_id, parsed.message_id, "ERROR");
        } catch {
          // ignore
        }
        try {
          persistence.persistChatError({ sessionId: parsed.session_id, messageId: parsed.message_id, error: message });
        } catch {
          // ignore
        }
        log("chat.error", { session_id: parsed.session_id, message_id: parsed.message_id, error: message });
        return writeJson(res, 500, { error: message });
      }
    }

    if (req.method === "POST" && url.pathname === "/loop/stop") {
      const body = await readJson(req);
      const parsed = body as any;
      if (!parsed || typeof parsed !== "object") return writeJson(res, 400, { error: "Invalid JSON body" });
      const session_id = typeof parsed.session_id === "string" ? parsed.session_id : "";
      const message_id = typeof parsed.message_id === "string" ? parsed.message_id : "";
      const stop_reason = typeof parsed.stop_reason === "string" ? parsed.stop_reason : "";
      if (!session_id || !message_id || !stop_reason) return writeJson(res, 400, { error: "Missing fields" });
      if (!sessionAccessAllowed(res, session_id, auth.principal)) return;
      // Only allow recognized stop reasons (others ignored).
      if (
        stop_reason !== "NO_ACTIONS" &&
        stop_reason !== "AWAITING_APPROVAL" &&
        stop_reason !== "MAX_STEPS" &&
        stop_reason !== "ERROR" &&
        stop_reason !== "USER_CANCELLED"
      ) {
        return writeJson(res, 400, { error: "Invalid stop_reason" });
      }
      try {
        if (stop_reason === "USER_CANCELLED") {
          cancelCodexBrainTurn(session_id, message_id);
        }
        setStepStopReason(session_id, message_id, stop_reason as any);
        appendEvent(session_id, "assistant", "loop.stop", { message_id, stop_reason });
      } catch {
        // ignore
      }
      log("loop.stop", { session_id, message_id, stop_reason });
      return writeJson(res, 200, { ok: true });
    }

    if (req.method === "POST" && url.pathname === "/event") {
      const body = await readJson(req);
      const parsed = body as any;
      if (!parsed || typeof parsed !== "object") return writeJson(res, 400, { error: "Invalid JSON body" });
      const session_id = typeof parsed.session_id === "string" ? parsed.session_id.trim() : "";
      const type = typeof parsed.type === "string" ? parsed.type.trim() : "";
      const payload = parsed.payload;
      const ts = typeof parsed.ts === "string" ? parsed.ts.trim() : "";
      if (!session_id || !type) return writeJson(res, 400, { error: "Missing session_id or type" });
      if (!sessionAccessAllowed(res, session_id, auth.principal)) return;

      ensureSession(session_id);
      try {
        appendEvent(session_id, "tool", "addin.event", { type, ts: ts || new Date().toISOString(), payload });
      } catch {
        // ignore
      }
      try {
        maybeCreateProactiveNotification(session_id, type, payload);
      } catch {
        // ignore
      }

      log("event.in", { session_id, type });
      return writeJson(res, 200, { ok: true });
    }

    if (req.method === "POST" && url.pathname === "/attachments/upload") {
      const body = await readJson(req, getAttachmentUploadRequestLimitBytes());
      const parsed = body as any;
      if (!parsed || typeof parsed !== "object") return writeJson(res, 400, { ok: false, error: "Invalid JSON body" });

      const upload = parseAttachmentUploadInput(parsed);
      const session_id = upload.session_id;
      if (!session_id) return writeJson(res, 400, { ok: false, error: "session_id is required." });
      if (!sessionAccessAllowed(res, session_id, auth.principal)) return;

      try {
        const stored = storeAttachmentUpload(upload);
        return writeJson(res, 200, { ok: true, attachment: stored });
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        return writeJson(res, 400, { ok: false, error: message });
      }
    }

    if (req.method === "POST" && url.pathname === "/api/kb/documents/upload") {
      const body = (await readJson(req, 300_000_000)) as any;
      const requestedOwnerUserId = typeof body?.ownerUserId === "string" ? body.ownerUserId.trim() : "";
      const ownerUserId = resolveKnowledgeBaseOwnerId(res, auth.principal, requestedOwnerUserId);
      if (!ownerUserId) return;
      const filename = typeof body?.filename === "string" ? body.filename.trim() : "document.pdf";
      const mimeType = typeof body?.mimeType === "string" ? body.mimeType.trim() : "application/pdf";
      const dataBase64 = typeof body?.dataBase64 === "string" ? body.dataBase64.trim() : "";
      if (!dataBase64) {
        writeJson(res, 400, { error: "dataBase64 is required." });
        return;
      }
      const bytes = Buffer.from(dataBase64, "base64");
      const result = await ingestDocument({
        ownerUserId,
        filename,
        mimeType,
        bytes,
        title: typeof body?.title === "string" ? body.title : undefined,
        scopeType: body?.scopeType === "project" ? "project" : "user",
        tags: Array.isArray(body?.tags) ? body.tags.filter((x: unknown) => typeof x === "string") : [],
        allowDuplicate: body?.allowDuplicate === true
      });
      writeJson(res, 200, result);
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/kb/documents") {
      const ownerUserId = resolveKnowledgeBaseOwnerId(res, auth.principal, String(url.searchParams.get("ownerUserId") ?? "").trim());
      if (!ownerUserId) return;
      const scopeType = String(url.searchParams.get("scopeType") ?? "user").trim() === "project" ? "project" : "user";
      writeJson(res, 200, { documents: listKnowledgeBaseDocuments(ownerUserId, scopeType) });
      return;
    }

    if (req.method === "GET" && url.pathname.startsWith("/api/kb/documents/") && url.pathname.endsWith("/status")) {
      const parts = url.pathname.split("/").filter(Boolean);
      const documentId = parts.length >= 4 ? parts[3] ?? "" : "";
      const ownerUserId = resolveKnowledgeBaseOwnerId(res, auth.principal, String(url.searchParams.get("ownerUserId") ?? "").trim());
      if (!ownerUserId) return;
      if (!documentId) {
        writeJson(res, 400, { error: "documentId is required." });
        return;
      }
      const status = getKnowledgeBaseDocumentStatus(documentId, ownerUserId);
      if (!status) {
        writeJson(res, 404, { error: "Document not found." });
        return;
      }
      writeJson(res, 200, status);
      return;
    }

    if (req.method === "GET" && url.pathname.startsWith("/api/kb/documents/")) {
      const parts = url.pathname.split("/").filter(Boolean);
      const documentId = parts.length >= 4 ? parts[3] ?? "" : "";
      const ownerUserId = resolveKnowledgeBaseOwnerId(res, auth.principal, String(url.searchParams.get("ownerUserId") ?? "").trim());
      if (!ownerUserId) return;
      if (!documentId) {
        writeJson(res, 400, { error: "documentId is required." });
        return;
      }
      const status = getKnowledgeBaseDocumentStatus(documentId, ownerUserId);
      if (!status) {
        writeJson(res, 404, { error: "Document not found." });
        return;
      }
      writeJson(res, 200, status);
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/kb/search") {
      const body = (await readJson(req, 2_000_000)) as any;
      const query = typeof body?.query === "string" ? body.query.trim() : "";
      const requestedOwnerUserId = typeof body?.ownerUserId === "string" ? body.ownerUserId.trim() : "";
      const ownerUserId = resolveKnowledgeBaseOwnerId(res, auth.principal, requestedOwnerUserId);
      if (!ownerUserId) return;
      if (!query) {
        writeJson(res, 400, { error: "query is required." });
        return;
      }
      const result = await searchKnowledgeBase({
        query,
        ownerUserId,
        scopeType: body?.scopeType === "project" ? "project" : "user",
        maxResults: Number.isFinite(body?.maxResults) ? body.maxResults : undefined,
        documentIds: Array.isArray(body?.documentIds) ? body.documentIds.filter((x: unknown) => typeof x === "string") : undefined,
        citationStyle: body?.citationStyle === "full" ? "full" : "short"
      });
      writeJson(res, 200, result);
      return;
    }

    if (req.method === "GET" && url.pathname === "/tools/zippybim/health") {
      const health = await getZippyBimHealth();
      return writeJson(res, health.ok ? 200 : 503, health);
    }

    if (req.method === "GET" && url.pathname === "/tools/zippybim/sources") {
      const items = listZippyBimPdfSources();
      return writeJson(res, 200, { ok: true, count: items.length, items });
    }

    if (req.method === "GET" && url.pathname === "/tools/zippybim/source-preview") {
      const relative_path = (url.searchParams.get("relative_path") ?? "").trim();
      if (!relative_path) return writeJson(res, 400, { ok: false, error: "relative_path is required." });
      try {
        const shared = createArtifactShare({ relativePath: relative_path, ttlSeconds: 15 * 60 });
        const download_path = `/artifacts/download-shared/${encodeURIComponent(shared.token)}`;
        const download_url = `${url.origin}${download_path}`;
        return writeJson(res, 200, {
          ok: true,
          relative_path: shared.relative_path,
          file_name: shared.file_name,
          expires_at_utc: shared.expires_at_utc,
          download_path,
          download_url
        });
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        return writeJson(res, 400, { ok: false, error: message });
      }
    }

    if (req.method === "GET" && url.pathname === "/tools/zippybim/jobs") {
      const limitRaw = (url.searchParams.get("limit") ?? "").trim();
      const limit = limitRaw ? Number.parseInt(limitRaw, 10) : undefined;
      const items = listZippyBimJobs(Number.isFinite(limit) ? limit : 20);
      return writeJson(res, 200, { ok: true, count: items.length, items });
    }

    if (req.method === "POST" && url.pathname === "/tools/zippybim/jobs") {
      const body = await readJson(req);
      const parsed = body as any;
      if (!parsed || typeof parsed !== "object") return writeJson(res, 400, { ok: false, error: "Invalid JSON body" });
      try {
        const job = createZippyBimJob({
          relative_path:
            typeof parsed.relative_path === "string"
              ? parsed.relative_path
              : typeof parsed.relativePath === "string"
                ? parsed.relativePath
                : "",
          extractor:
            typeof parsed.extractor === "string"
              ? parsed.extractor
              : typeof parsed.engine === "string"
                ? parsed.engine
                : undefined,
          scale_ratio:
            typeof parsed.scale_ratio === "number"
              ? parsed.scale_ratio
              : typeof parsed.scaleRatio === "number"
                ? parsed.scaleRatio
                : undefined,
          crop_min_x:
            typeof parsed.crop_min_x === "number"
              ? parsed.crop_min_x
              : typeof parsed.cropMinX === "number"
                ? parsed.cropMinX
                : undefined,
          crop_min_y:
            typeof parsed.crop_min_y === "number"
              ? parsed.crop_min_y
              : typeof parsed.cropMinY === "number"
                ? parsed.cropMinY
                : undefined,
          crop_max_y:
            typeof parsed.crop_max_y === "number"
              ? parsed.crop_max_y
              : typeof parsed.cropMaxY === "number"
                ? parsed.cropMaxY
                : undefined,
          detect_doors:
            typeof parsed.detect_doors === "boolean"
              ? parsed.detect_doors
              : typeof parsed.detectDoors === "boolean"
                ? parsed.detectDoors
                : undefined
        });
        return writeJson(res, 200, job);
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        return writeJson(res, 400, { ok: false, error: message });
      }
    }

    const zippyJobResultId = tryMatchPath(url.pathname, "/tools/zippybim/jobs/");
    if (req.method === "GET" && zippyJobResultId) {
      const segments = zippyJobResultId.split("/").filter(Boolean);
      if (segments.length === 1) {
        const job = getZippyBimJob(segments[0]!);
        if (!job) return writeJson(res, 404, { ok: false, error: "Job not found." });
        return writeJson(res, 200, job);
      }
      if (segments.length === 2 && segments[1] === "result") {
        const result = getZippyBimJobResult(segments[0]!);
        if (!result) return writeJson(res, 404, { ok: false, error: "Result not found." });
        return writeJson(res, 200, result);
      }
    }

    if (req.method === "GET" && url.pathname === "/config/cloud-upload") {
      const cfg = readCloudUploadConfig() ?? {};
      const upload_url = typeof cfg.upload_url === "string" ? cfg.upload_url.trim() : "";
      const mode = typeof cfg.mode === "string" && ["off", "once", "watch"].includes(cfg.mode) ? cfg.mode : "off";
      const has_token = typeof cfg.upload_token === "string" && cfg.upload_token.trim().length > 0;
      return writeJson(res, 200, { ok: true, upload_url: upload_url || null, mode, has_token });
    }

    if (req.method === "POST" && url.pathname === "/config/cloud-upload") {
      const body = await readJson(req).catch(() => null);
      const parsed = body && typeof body === "object" ? (body as any) : {};

      const upload_url = typeof parsed.upload_url === "string" ? parsed.upload_url.trim() : parsed.upload_url === null ? "" : undefined;
      const upload_token = typeof parsed.upload_token === "string" ? parsed.upload_token.trim() : parsed.upload_token === null ? "" : undefined;
      const modeRaw = typeof parsed.mode === "string" ? parsed.mode.trim().toLowerCase() : "";
      const mode: CloudUploadMode | undefined = modeRaw === "off" || modeRaw === "once" || modeRaw === "watch" ? (modeRaw as any) : undefined;

      const existing = readCloudUploadConfig() ?? {};
      const next = {
        ...existing,
        ...(upload_url !== undefined ? { upload_url } : {}),
        ...(upload_token !== undefined ? { upload_token } : {}),
        ...(mode ? { mode } : {})
      };

      const wr = writeCloudUploadConfig(next);
      if (!wr.ok) return writeJson(res, 500, { ok: false, error: wr.error });

      try {
        refreshUploadQueueWorker();
      } catch {
        // ignore
      }

      const cfg = readCloudUploadConfig() ?? {};
      const out_url = typeof cfg.upload_url === "string" ? cfg.upload_url.trim() : "";
      const out_mode = typeof cfg.mode === "string" && ["off", "once", "watch"].includes(cfg.mode) ? cfg.mode : "off";
      const has_token = typeof cfg.upload_token === "string" && cfg.upload_token.trim().length > 0;
      return writeJson(res, 200, { ok: true, upload_url: out_url || null, mode: out_mode, has_token });
    }

    if (req.method === "GET" && url.pathname === "/memory/project-profile") {
      try {
        return writeJson(res, 200, { ok: true, profile: readProjectProfile() });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return writeJson(res, 500, { ok: false, error: `Failed to read project profile: ${msg}` });
      }
    }

    const requirementsRoute = await handleRequirementsHttpRoute({ method: req.method ?? "", url, actor_id: auth.principal?.user_id ?? null, read_body: () => readJson(req) });
    if (requirementsRoute) {
      if (requirementsRoute.audit) appendAuditLine({ ...requirementsRoute.audit, principal: auth.principal ?? null });
      return writeJson(res, requirementsRoute.status, requirementsRoute.body);
    }

    if (req.method === "POST" && url.pathname === "/memory/project-profile/standards") {
      const body = await readJson(req).catch(() => null);
      const parsed = body && typeof body === "object" ? (body as any) : {};
      const text = typeof parsed.text === "string" ? parsed.text.trim() : "";
      const category = typeof parsed.category === "string" ? parsed.category.trim() : "general";
      const source = typeof parsed.source === "string" ? parsed.source.trim() : "api";
      const tags = Array.isArray(parsed.tags) ? parsed.tags.filter((x: unknown): x is string => typeof x === "string") : undefined;
      const mirror_to_memory = typeof parsed.mirror_to_memory === "boolean" ? parsed.mirror_to_memory : true;

      if (!text) return writeJson(res, 400, { ok: false, error: "text is required." });
      try {
        const saved = addProjectStandard({
          text,
          category,
          source,
          tags,
          mirror_to_memory,
          session_id: typeof parsed.session_id === "string" && parsed.session_id.trim() ? parsed.session_id.trim() : undefined
        });
        try {
          appendAuditLine({
            type: "project_profile.standard.saved",
            ts: new Date().toISOString(),
            category: saved.standard.category,
            source,
            standard_id: saved.standard.id,
            principal: auth.principal
              ? {
                  user_id: auth.principal.user_id,
                  tenant_id: auth.principal.tenant_id || auth.principal.license_id || null
                }
              : null
          });
        } catch {
          // ignore
        }
        return writeJson(res, 200, saved);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return writeJson(res, 400, { ok: false, error: msg });
      }
    }

    if (req.method === "POST" && url.pathname === "/feedback") {
      const body = await readJson(req);
      const parsed = body as any;
      if (!parsed || typeof parsed !== "object") return writeJson(res, 400, { error: "Invalid JSON body" });

      const session_id = typeof parsed.session_id === "string" ? parsed.session_id.trim() : "";
      const chat_id = typeof parsed.chat_id === "string" ? parsed.chat_id.trim() : "";
      const rating = typeof parsed.rating === "string" ? parsed.rating.trim().toLowerCase() : "";
      const note = typeof parsed.note === "string" ? parsed.note.trim() : "";
      const remember_preference = !!parsed.remember_preference;
      const queue_upload = !!parsed.queue_upload;
      const dev_apply_repo_changes = !!parsed.dev_apply_repo_changes;

      if (!session_id) return writeJson(res, 400, { error: "Missing session_id" });
      if (!sessionAccessAllowed(res, session_id, auth.principal)) return;
      if (rating !== "worked" && rating !== "partial" && rating !== "failed") {
        return writeJson(res, 400, { error: "rating must be one of: worked|partial|failed" });
      }

      const created_at = new Date().toISOString();
      let persisted: any;
      try {
        persisted = appendFeedbackAndMaybePromote({
          session_id,
          chat_id: chat_id || null,
          rating,
          note: note || null,
          remember_preference,
          queue_upload,
          created_at
        });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return writeJson(res, 500, { error: `Failed to persist feedback: ${msg}` });
      }

      let improvementJob: any = null;
      try {
        improvementJob = enqueueFeedbackImprovementJob({
          session_id,
          chat_id: chat_id || null,
          rating,
          note: note || null,
          created_at,
          dev_handoff: persisted?.dev_handoff ?? null,
          upload_queue_dir: persisted?.upload_queue_dir ?? null
        });
      } catch {
        // ignore
      }

      // Best-effort: index in SQLite + notify UI.
      try {
        appendEvent(session_id, "user", "feedback.submitted", { rating, note, remember_preference, queue_upload, dev_apply_repo_changes, created_at });
      } catch {
        // ignore
      }

      // Phase 1 journaling: write feedback into the per-session run bundle too.
      try {
        persistence.appendToolOutput(session_id, {
          ts: created_at,
          kind: "mcp.tool_result",
          session_id,
          tool: "feedback.submit",
          status: "done",
          result: persisted
        } as any);
      } catch {
        // ignore
      }

      // Optional: notify UI about promotions/queueing (single consolidated notification).
      try {
        const bits: string[] = [];
        if (persisted?.memory_daily_path || persisted?.memory_longterm_path) bits.push("saved to memory");
        if (persisted?.upload_queue_dir) bits.push("queued upload");
        if (improvementJob?.job?.id) bits.push(`job #${improvementJob.job.id}`);
        appendNotification(session_id, "feedback.saved", `Feedback saved${bits.length ? ` (${bits.join(", ")})` : ""}.`, persisted);
      } catch {
        // ignore
      }

      let devAutofix: any = null;
      try {
        const started = startFeedbackDevAutofix(
          {
            session_id,
            chat_id: chat_id || null,
            rating,
            note: note || null,
            dev_handoff: persisted?.dev_handoff ?? null,
            dev_apply_repo_changes
          },
          {
            onStarted: (x) => {
              try {
                appendNotification(session_id, "feedback.dev_autofix.started", "Dev auto-update started.", {
                  run_id: x.run_id,
                  run_dir_rel: x.run_dir_rel
                });
              } catch {
                // ignore
              }
            },
            onFinished: (x) => {
              try {
                const text = x.ok
                  ? `Dev auto-update completed (${x.changed_files.length} changed file(s)).`
                  : `Dev auto-update failed: ${x.error || "unknown error"}`;
                appendNotification(session_id, x.ok ? "feedback.dev_autofix.done" : "feedback.dev_autofix.failed", text, x as any);
              } catch {
                // ignore
              }
              try {
                if (x.ok && x.backend_touched && x.backend_rebuild_ok) {
                  appendNotification(session_id, "feedback.dev_autofix.backend_restart", "Backend changes detected. Restarting backend to apply updates.", {
                    run_id: x.run_id,
                    run_dir_rel: x.run_dir_rel
                  });
                  setTimeout(() => scheduleBackendRestart(), 300);
                }
              } catch {
                // ignore
              }
            }
          }
        );
        if (started.started) {
          devAutofix = started;
        } else if (dev_apply_repo_changes && started.error) {
          appendNotification(session_id, "feedback.dev_autofix.skipped", `Dev auto-update skipped: ${started.error}`, started);
        }
      } catch {
        // ignore
      }

      let githubIssue: any = null;
      try {
        const started = startFeedbackGitHubIssue(
          {
            session_id,
            chat_id: chat_id || null,
            rating,
            note: note || null,
            created_at,
            dev_handoff: persisted?.dev_handoff ?? null
          },
          {
            onStarted: (x) => {
              try {
                appendNotification(session_id, "feedback.github_issue.started", `Creating GitHub issue in ${x.repo}...`, {
                  repo: x.repo,
                  fingerprint: x.fingerprint
                });
              } catch {
                // ignore
              }
            },
            onFinished: (x) => {
              try {
                if (x.ok) {
                  const text = `Created GitHub issue #${x.issue_number} for this feedback.`;
                  try {
                    attachGitHubIssueToImprovementJob({
                      fingerprint: x.fingerprint ?? "",
                      repo: x.repo ?? null,
                      issue_number: x.issue_number ?? null,
                      issue_url: x.issue_url ?? null
                    });
                  } catch {
                    // ignore
                  }
                  appendNotification(session_id, "feedback.github_issue.created", text, x);
                  log("feedback.github_issue", {
                    session_id,
                    rating,
                    ok: true,
                    issue_number: x.issue_number,
                    issue_url: x.issue_url,
                    repo: x.repo
                  });
                } else if (x.skipped === "duplicate") {
                  appendNotification(session_id, "feedback.github_issue.duplicate", "Feedback already linked to a GitHub issue.", x);
                } else if (!x.skipped) {
                  const text = `GitHub issue creation failed: ${x.error || "unknown error"}`;
                  appendNotification(session_id, "feedback.github_issue.failed", text, x);
                  log("feedback.github_issue", {
                    session_id,
                    rating,
                    ok: false,
                    error: x.error || null,
                    status: x.status ?? null,
                    repo: x.repo ?? null
                  });
                }
              } catch {
                // ignore
              }
            }
          }
        );
        if (started.started) githubIssue = started;
      } catch {
        // ignore
      }

      const responsePayload = {
        ...persisted,
        ...(improvementJob?.job ? { improvement_job: improvementJob.job } : {}),
        ...(devAutofix ? { dev_autofix: devAutofix } : {}),
        ...(githubIssue ? { github_issue: githubIssue } : {})
      };
      log("feedback.in", {
        session_id,
        rating,
        remember_preference,
        queue_upload,
        dev_apply_repo_changes,
        dev_autofix_started: !!devAutofix,
        github_issue_started: !!githubIssue
      });
      return writeJson(res, 200, responsePayload);
    }

    if (req.method === "POST" && url.pathname === "/tools/ocr") {
      const body = await readJson(req);
      const parsed = body as any;
      if (!parsed || typeof parsed !== "object") return writeJson(res, 400, { error: "Invalid JSON body" });

      const image_path =
        typeof parsed.image_path === "string"
          ? parsed.image_path.trim()
          : typeof parsed.imagePath === "string"
            ? parsed.imagePath.trim()
            : "";
      const kind = typeof parsed.kind === "string" ? parsed.kind.trim() : undefined;
      const expected = typeof parsed.expected === "string" ? parsed.expected : undefined;
      const timeout_ms = typeof parsed.timeout_ms === "number" ? parsed.timeout_ms : typeof parsed.timeoutMs === "number" ? parsed.timeoutMs : undefined;

      const r = await ocrImage({ image_path, kind, expected, timeout_ms });
      return writeJson(res, r.ok ? 200 : 400, r);
    }

    if (req.method === "POST" && url.pathname === "/tools/redline/analyze") {
      const body = await readJson(req);
      const parsed = body as any;
      if (!parsed || typeof parsed !== "object") return writeJson(res, 400, { error: "Invalid JSON body" });

      const file_path =
        typeof parsed.file_path === "string"
          ? parsed.file_path.trim()
          : typeof parsed.filePath === "string"
            ? parsed.filePath.trim()
            : "";
      const expected_sheet =
        typeof parsed.expected_sheet === "string"
          ? parsed.expected_sheet.trim()
          : typeof parsed.expectedSheet === "string"
            ? parsed.expectedSheet.trim()
            : undefined;
      const max_pages = typeof parsed.max_pages === "number" ? parsed.max_pages : typeof parsed.maxPages === "number" ? parsed.maxPages : undefined;
      const page_start = typeof parsed.page_start === "number" ? parsed.page_start : typeof parsed.pageStart === "number" ? parsed.pageStart : undefined;
      const include_pdf_annotations =
        typeof parsed.include_pdf_annotations === "boolean"
          ? parsed.include_pdf_annotations
          : typeof parsed.includePdfAnnotations === "boolean"
            ? parsed.includePdfAnnotations
            : undefined;
      const include_ocr_for_images =
        typeof parsed.include_ocr_for_images === "boolean"
          ? parsed.include_ocr_for_images
          : typeof parsed.includeOcrForImages === "boolean"
            ? parsed.includeOcrForImages
            : undefined;
      const timeout_ms = typeof parsed.timeout_ms === "number" ? parsed.timeout_ms : typeof parsed.timeoutMs === "number" ? parsed.timeoutMs : undefined;
      const baseline_file_path =
        typeof parsed.baseline_file_path === "string"
          ? parsed.baseline_file_path.trim()
          : typeof parsed.baselineFilePath === "string"
            ? parsed.baselineFilePath.trim()
            : undefined;

      const r = await analyzeRedlineFile({
        file_path,
        expected_sheet,
        max_pages,
        page_start,
        include_pdf_annotations,
        include_ocr_for_images,
        timeout_ms,
        baseline_file_path
      });
      const aec_intent_evidence = r.ok ? await tryCreateRedlineAnalyzeEvidence(r, { id: randomUUID(), created_at: new Date().toISOString() }) : undefined;
      return writeJson(res, r.ok ? 200 : 400, aec_intent_evidence ? { ...r, aec_intent_evidence } : r);
    }

    if (req.method === "POST" && url.pathname === "/tools/redline/map-sheet-regions") {
      const body = await readJson(req);
      const parsed = body as any;
      if (!parsed || typeof parsed !== "object") return writeJson(res, 400, { error: "Invalid JSON body" });

      const image_width =
        typeof parsed.image_width === "number"
          ? parsed.image_width
          : typeof parsed.imageWidth === "number"
            ? parsed.imageWidth
            : 0;
      const image_height =
        typeof parsed.image_height === "number"
          ? parsed.image_height
          : typeof parsed.imageHeight === "number"
            ? parsed.imageHeight
            : 0;
      const boxes = Array.isArray(parsed.boxes) ? parsed.boxes : [];
      const sheet_outline =
        parsed.sheet_outline && typeof parsed.sheet_outline === "object"
          ? parsed.sheet_outline
          : parsed.sheetOutline && typeof parsed.sheetOutline === "object"
            ? parsed.sheetOutline
            : {};
      const viewport_geometry = Array.isArray(parsed.viewport_geometry)
        ? parsed.viewport_geometry
        : Array.isArray(parsed.viewportGeometry)
          ? parsed.viewportGeometry
          : [];
      const title_blocks = Array.isArray(parsed.title_blocks)
        ? parsed.title_blocks
        : Array.isArray(parsed.titleBlocks)
          ? parsed.titleBlocks
          : [];

      const r = mapSheetRegions({
        image_width,
        image_height,
        boxes,
        sheet_outline,
        viewport_geometry,
        title_blocks
      });
      return writeJson(res, r.ok ? 200 : 400, r);
    }

    if (req.method === "POST" && url.pathname === "/tools/aec/task-intent") { const r = await resolveAecTaskIntentHttp(await readJson(req)); return writeJson(res, r.status, r.body); }
    if (req.method === "POST" && url.pathname === "/tools/mep/semantic-route-plan") {
      const body = await readJson(req);
      const parsed = body as any;
      if (!parsed || typeof parsed !== "object") return writeJson(res, 400, { error: "Invalid JSON body" });

      const plannerRequest = {
        user_text: typeof parsed.user_text === "string" ? parsed.user_text : typeof parsed.userText === "string" ? parsed.userText : typeof parsed.request === "string" ? parsed.request : typeof parsed.requestText === "string" ? parsed.requestText : "",
        view_id: typeof parsed.view_id === "number" ? parsed.view_id : typeof parsed.viewId === "number" ? parsed.viewId : undefined,
        room_number: typeof parsed.room_number === "string" ? parsed.room_number : typeof parsed.roomNumber === "string" ? parsed.roomNumber : undefined,
        level_name: typeof parsed.level_name === "string" ? parsed.level_name : typeof parsed.levelName === "string" ? parsed.levelName : undefined,
        tool_results: Array.isArray(parsed.tool_results) ? parsed.tool_results : Array.isArray(parsed.toolResults) ? parsed.toolResults : []
      };
      const r = resolveMepSemanticRoutePlan(plannerRequest);
      const aec_intent_evidence = adaptMepSemanticRoutePlanToAecIntentEvidence(plannerRequest, r, {
        id: randomUUID(),
        created_at: new Date().toISOString(),
        host: { kind: "other", name: "revit-operator-backend" }
      });
      return writeJson(res, r.ok ? 200 : 400, { ...r, aec_intent_evidence });
    }

    if (req.method === "POST" && url.pathname === "/tools/redline/orient") {
      const body = await readJson(req);
      const parsed = body as any;
      if (!parsed || typeof parsed !== "object") return writeJson(res, 400, { error: "Invalid JSON body" });

      const file_path =
        typeof parsed.file_path === "string"
          ? parsed.file_path.trim()
          : typeof parsed.filePath === "string"
            ? parsed.filePath.trim()
            : "";
      const expected_sheet =
        typeof parsed.expected_sheet === "string"
          ? parsed.expected_sheet.trim()
          : typeof parsed.expectedSheet === "string"
            ? parsed.expectedSheet.trim()
            : undefined;
      const max_pages = typeof parsed.max_pages === "number" ? parsed.max_pages : typeof parsed.maxPages === "number" ? parsed.maxPages : undefined;
      const page_start = typeof parsed.page_start === "number" ? parsed.page_start : typeof parsed.pageStart === "number" ? parsed.pageStart : undefined;
      const include_pdf_annotations =
        typeof parsed.include_pdf_annotations === "boolean"
          ? parsed.include_pdf_annotations
          : typeof parsed.includePdfAnnotations === "boolean"
            ? parsed.includePdfAnnotations
            : undefined;
      const include_ocr_for_images =
        typeof parsed.include_ocr_for_images === "boolean"
          ? parsed.include_ocr_for_images
          : typeof parsed.includeOcrForImages === "boolean"
            ? parsed.includeOcrForImages
            : undefined;
      const timeout_ms = typeof parsed.timeout_ms === "number" ? parsed.timeout_ms : typeof parsed.timeoutMs === "number" ? parsed.timeoutMs : undefined;
      const baseline_file_path =
        typeof parsed.baseline_file_path === "string"
          ? parsed.baseline_file_path.trim()
          : typeof parsed.baselineFilePath === "string"
            ? parsed.baselineFilePath.trim()
            : undefined;

      const image_width =
        typeof parsed.image_width === "number"
          ? parsed.image_width
          : typeof parsed.imageWidth === "number"
            ? parsed.imageWidth
            : undefined;
      const image_height =
        typeof parsed.image_height === "number"
          ? parsed.image_height
          : typeof parsed.imageHeight === "number"
            ? parsed.imageHeight
            : undefined;
      const boxes = Array.isArray(parsed.boxes) ? parsed.boxes : [];
      const sheet_outline =
        parsed.sheet_outline && typeof parsed.sheet_outline === "object"
          ? parsed.sheet_outline
          : parsed.sheetOutline && typeof parsed.sheetOutline === "object"
            ? parsed.sheetOutline
            : undefined;
      const viewport_geometry = Array.isArray(parsed.viewport_geometry)
        ? parsed.viewport_geometry
        : Array.isArray(parsed.viewportGeometry)
          ? parsed.viewportGeometry
          : undefined;
      const title_blocks = Array.isArray(parsed.title_blocks)
        ? parsed.title_blocks
        : Array.isArray(parsed.titleBlocks)
          ? parsed.titleBlocks
          : undefined;

      const r = await orientRedlineFile({
        file_path,
        expected_sheet,
        max_pages,
        page_start,
        include_pdf_annotations,
        include_ocr_for_images,
        timeout_ms,
        baseline_file_path,
        image_width,
        image_height,
        boxes,
        sheet_outline,
        viewport_geometry,
        title_blocks
      });
      return writeJson(res, r.ok ? 200 : 400, r);
    }

    if (req.method === "POST" && url.pathname === "/tools/redline/gemini-analyze") {
      const body = await readJson(req);
      const parsed = body as any;
      if (!parsed || typeof parsed !== "object") return writeJson(res, 400, { error: "Invalid JSON body" });

      const file_path =
        typeof parsed.file_path === "string"
          ? parsed.file_path.trim()
          : typeof parsed.filePath === "string"
            ? parsed.filePath.trim()
            : "";
      const image_paths = Array.isArray(parsed.image_paths)
        ? parsed.image_paths
        : Array.isArray(parsed.imagePaths)
          ? parsed.imagePaths
          : [];
      const expected_sheet =
        typeof parsed.expected_sheet === "string"
          ? parsed.expected_sheet.trim()
          : typeof parsed.expectedSheet === "string"
            ? parsed.expectedSheet.trim()
            : undefined;
      const max_pages = typeof parsed.max_pages === "number" ? parsed.max_pages : typeof parsed.maxPages === "number" ? parsed.maxPages : undefined;
      const page_start = typeof parsed.page_start === "number" ? parsed.page_start : typeof parsed.pageStart === "number" ? parsed.pageStart : undefined;
      const baseline_file_path =
        typeof parsed.baseline_file_path === "string"
          ? parsed.baseline_file_path.trim()
          : typeof parsed.baselineFilePath === "string"
            ? parsed.baselineFilePath.trim()
            : undefined;
      const objective = typeof parsed.objective === "string" ? parsed.objective.trim() : undefined;
      const region_boxes = Array.isArray(parsed.region_boxes)
        ? parsed.region_boxes
        : Array.isArray(parsed.regionBoxes)
          ? parsed.regionBoxes
          : [];
      const max_regions = typeof parsed.max_regions === "number" ? parsed.max_regions : typeof parsed.maxRegions === "number" ? parsed.maxRegions : undefined;
      const min_confidence =
        typeof parsed.min_confidence === "number"
          ? parsed.min_confidence
          : typeof parsed.minConfidence === "number"
            ? parsed.minConfidence
            : undefined;
      const include_code_execution =
        typeof parsed.include_code_execution === "boolean"
          ? parsed.include_code_execution
          : typeof parsed.includeCodeExecution === "boolean"
            ? parsed.includeCodeExecution
            : undefined;
      const timeout_ms = typeof parsed.timeout_ms === "number" ? parsed.timeout_ms : typeof parsed.timeoutMs === "number" ? parsed.timeoutMs : undefined;

      const r = await analyzeRedlinePackageWithGemini({
        file_path,
        image_paths,
        expected_sheet,
        max_pages,
        page_start,
        baseline_file_path,
        objective,
        region_boxes,
        max_regions,
        min_confidence,
        include_code_execution,
        timeout_ms
      });
      return writeJson(res, r.ok ? 200 : 400, r);
    }

    if (req.method === "POST" && (url.pathname === "/tools/evidence-pack/build" || url.pathname === "/tools/evidence_pack/build")) {
      const body = await readJson(req).catch(() => null);
      const parsed = body && typeof body === "object" ? (body as any) : {};

      const toStringArray = (v: unknown): string[] => {
        if (!Array.isArray(v)) return [];
        const out: string[] = [];
        for (const x of v) {
          if (typeof x !== "string") continue;
          const s = x.trim();
          if (!s) continue;
          out.push(s);
        }
        return out;
      };

      const checklistRaw =
        Array.isArray(parsed.verification_checklist)
          ? parsed.verification_checklist
          : Array.isArray(parsed.verificationChecklist)
            ? parsed.verificationChecklist
            : [];
      const changeSummaryItems = toStringArray(
        Array.isArray(parsed.change_summary_items) ? parsed.change_summary_items : parsed.changeSummaryItems
      );

      try {
        const built = buildEvidencePack({
          session_id:
            typeof parsed.session_id === "string"
              ? parsed.session_id.trim()
              : typeof parsed.sessionId === "string"
                ? parsed.sessionId.trim()
                : undefined,
          title:
            typeof parsed.title === "string"
              ? parsed.title.trim()
              : typeof parsed.name === "string"
                ? parsed.name.trim()
                : undefined,
          run_label:
            typeof parsed.run_label === "string"
              ? parsed.run_label.trim()
              : typeof parsed.runLabel === "string"
                ? parsed.runLabel.trim()
                : undefined,
          verification_checklist: Array.isArray(checklistRaw) ? checklistRaw : [],
          before_images: toStringArray(Array.isArray(parsed.before_images) ? parsed.before_images : parsed.beforeImages),
          after_images: toStringArray(Array.isArray(parsed.after_images) ? parsed.after_images : parsed.afterImages),
          pdf_paths: toStringArray(Array.isArray(parsed.pdf_paths) ? parsed.pdf_paths : parsed.pdfPaths),
          artifact_paths: toStringArray(Array.isArray(parsed.artifact_paths) ? parsed.artifact_paths : parsed.artifactPaths),
          change_summary_items: changeSummaryItems,
          include_feature2_diff:
            typeof parsed.include_feature2_diff === "boolean"
              ? parsed.include_feature2_diff
              : typeof parsed.includeFeature2Diff === "boolean"
                ? parsed.includeFeature2Diff
                : undefined,
          feature2_branch:
            typeof parsed.feature2_branch === "string"
              ? parsed.feature2_branch.trim()
              : typeof parsed.feature2Branch === "string"
                ? parsed.feature2Branch.trim()
                : undefined,
          feature2_base_branch:
            typeof parsed.feature2_base_branch === "string"
              ? parsed.feature2_base_branch.trim()
              : typeof parsed.feature2BaseBranch === "string"
                ? parsed.feature2BaseBranch.trim()
                : undefined,
          halt_on_verification_failure:
            typeof parsed.halt_on_verification_failure === "boolean"
              ? parsed.halt_on_verification_failure
              : typeof parsed.haltOnVerificationFailure === "boolean"
                ? parsed.haltOnVerificationFailure
                : undefined,
          package_zip:
            typeof parsed.package_zip === "boolean"
              ? parsed.package_zip
              : typeof parsed.packageZip === "boolean"
                ? parsed.packageZip
                : undefined,
          output_folder:
            typeof parsed.output_folder === "string"
              ? parsed.output_folder.trim()
              : typeof parsed.outputFolder === "string"
                ? parsed.outputFolder.trim()
                : undefined,
          share_ttl_seconds:
            typeof parsed.share_ttl_seconds === "number"
              ? parsed.share_ttl_seconds
              : typeof parsed.shareTtlSeconds === "number"
                ? parsed.shareTtlSeconds
                : undefined,
          max_session_tool_results:
            typeof parsed.max_session_tool_results === "number"
              ? parsed.max_session_tool_results
              : typeof parsed.maxSessionToolResults === "number"
                ? parsed.maxSessionToolResults
                : undefined
        });

        if (!built.ok) return writeJson(res, 409, built);

        const download_url = `${url.origin}${built.share.download_path}`;
        const summary_markdown = built.summary_markdown.replace(
          `[Download evidence pack](${built.share.download_path})`,
          `[Download evidence pack](${download_url})`
        );

        return writeJson(res, 200, {
          ...built,
          share: {
            ...built.share,
            download_url
          },
          assistant_message: summary_markdown,
          summary_markdown
        });
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        return writeJson(res, 400, { ok: false, error: message });
      }
    }

    if (req.method === "GET" && (url.pathname === "/tools/ocr/capabilities" || url.pathname === "/tools/ocr-capabilities")) {
      const caps = await getOcrCapabilities();
      return writeJson(res, 200, caps);
    }

    if (req.method === "GET" && url.pathname === "/improvement/jobs") {
      const limitRaw = (url.searchParams.get("limit") ?? "").trim();
      const limit = limitRaw ? Number.parseInt(limitRaw, 10) : undefined;
      const snapshot = getImprovementQueueSnapshot(limit && Number.isFinite(limit) ? limit : undefined);
      const state = (url.searchParams.get("state") ?? "").trim();
      const source = (url.searchParams.get("source") ?? "").trim();
      const fingerprint = (url.searchParams.get("fingerprint") ?? "").trim();
      const session_id = (url.searchParams.get("session_id") ?? "").trim();

      const items = snapshot.jobs.filter(job => {
        if (state && job.state !== state) return false;
        if (source && job.source !== source && !job.signal_sources.includes(source as any)) return false;
        if (fingerprint && job.fingerprint !== fingerprint) return false;
        if (session_id && job.session_id !== session_id) return false;
        return true;
      });

      return writeJson(res, 200, {
        ok: true,
        count: items.length,
        items,
        operator_profile: snapshot.operator_profile
      });
    }

    if (req.method === "POST" && url.pathname === "/improvement/jobs") {
      const body = await readJson(req).catch(() => null);
      const parsed = body && typeof body === "object" ? (body as any) : null;
      if (!parsed) return writeJson(res, 400, { ok: false, error: "Invalid JSON body" });

      const session_id = typeof parsed.session_id === "string" ? parsed.session_id.trim() : "";
      if (session_id && !sessionAccessAllowed(res, session_id, auth.principal)) return;

      try {
        const result = enqueueManualImprovementJob({
          fingerprint: typeof parsed.fingerprint === "string" ? parsed.fingerprint.trim() : null,
          source: typeof parsed.source === "string" ? parsed.source.trim().toLowerCase() : "manual",
          state: typeof parsed.state === "string" ? parsed.state.trim().toLowerCase() : "detected",
          title: typeof parsed.title === "string" ? parsed.title.trim() : null,
          summary: typeof parsed.summary === "string" ? parsed.summary.trim() : null,
          rating: typeof parsed.rating === "string" ? parsed.rating.trim().toLowerCase() : null,
          severity: typeof parsed.severity === "number" ? parsed.severity : null,
          confidence: typeof parsed.confidence === "number" ? parsed.confidence : null,
          impact_score: typeof parsed.impact_score === "number" ? parsed.impact_score : null,
          session_id: session_id || null,
          chat_id: typeof parsed.chat_id === "string" ? parsed.chat_id.trim() : null,
          evidence_paths: Array.isArray(parsed.evidence_paths) ? parsed.evidence_paths.map((x: unknown) => String(x ?? "")) : [],
          issue_keys: Array.isArray(parsed.issue_keys) ? parsed.issue_keys.map((x: unknown) => String(x ?? "")) : [],
          tool_names: Array.isArray(parsed.tool_names) ? parsed.tool_names.map((x: unknown) => String(x ?? "")) : [],
          latest_user_request: typeof parsed.latest_user_request === "string" ? parsed.latest_user_request.trim() : null,
          metadata: parsed.metadata && typeof parsed.metadata === "object" && !Array.isArray(parsed.metadata) ? parsed.metadata : null
        });
        return writeJson(res, result.created ? 201 : 200, { ok: true, item: result.job });
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        return writeJson(res, 400, { ok: false, error: message });
      }
    }

    if (req.method === "GET" && url.pathname === "/artifacts/list") {
      const prefixRaw = (url.searchParams.get("prefix") ?? "").trim();
      const recursiveRaw = (url.searchParams.get("recursive") ?? "").trim().toLowerCase();
      const limitRaw = (url.searchParams.get("limit") ?? "").trim();
      const recursive = recursiveRaw === "1" || recursiveRaw === "true" || recursiveRaw === "yes";
      const limit = limitRaw ? Number.parseInt(limitRaw, 10) : undefined;
      try {
        const listed = listArtifacts({ prefix: prefixRaw || undefined, recursive, limit });
        return writeJson(res, 200, {
          ok: true,
          prefix: listed.prefix,
          count: listed.items.length,
          items: listed.items
        });
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        return writeJson(res, 400, { ok: false, error: message });
      }
    }

    if (req.method === "POST" && url.pathname === "/artifacts/share") {
      const body = await readJson(req).catch(() => null);
      const parsed = body && typeof body === "object" ? (body as any) : {};

      const relative_path =
        typeof parsed.relative_path === "string"
          ? parsed.relative_path.trim()
          : typeof parsed.relativePath === "string"
            ? parsed.relativePath.trim()
            : "";
      const ttl_seconds =
        typeof parsed.ttl_seconds === "number"
          ? parsed.ttl_seconds
          : typeof parsed.ttlSeconds === "number"
            ? parsed.ttlSeconds
            : undefined;
      const file_name =
        typeof parsed.file_name === "string"
          ? parsed.file_name.trim()
          : typeof parsed.fileName === "string"
            ? parsed.fileName.trim()
            : undefined;

      if (!relative_path) return writeJson(res, 400, { ok: false, error: "relative_path is required." });
      try {
        const shared = createArtifactShare({ relativePath: relative_path, ttlSeconds: ttl_seconds, fileName: file_name });
        const download_path = `/artifacts/download-shared/${encodeURIComponent(shared.token)}`;
        const download_url = `${url.origin}${download_path}`;
        return writeJson(res, 200, {
          ok: true,
          ...shared,
          download_path,
          download_url
        });
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        return writeJson(res, 400, { ok: false, error: message });
      }
    }

    if (req.method === "GET" && url.pathname.startsWith("/artifacts/download-shared/")) {
      let token = "";
      try {
        token = decodeURIComponent(url.pathname.slice("/artifacts/download-shared/".length)).trim();
      } catch {
        return writeJson(res, 400, { ok: false, error: "Invalid share token encoding." });
      }
      if (!token) return writeJson(res, 400, { ok: false, error: "token is required." });

      const shared = resolveArtifactShare(token);
      if (!shared) return writeJson(res, 404, { ok: false, error: "Artifact share not found or expired." });

      try {
        const st = fs.statSync(shared.full_path);
        if (!st.isFile()) return writeJson(res, 404, { ok: false, error: "Artifact file is not available." });

        const fileName = normalizeDownloadFileName(shared.file_name);
        res.statusCode = 200;
        res.setHeader("content-type", "application/octet-stream");
        res.setHeader("content-length", String(st.size));
        res.setHeader("cache-control", "private, no-store");
        res.setHeader(
          "content-disposition",
          `attachment; filename="${fileName}"; filename*=UTF-8''${encodeURIComponent(fileName)}`
        );

        const stream = fs.createReadStream(shared.full_path);
        stream.on("error", () => {
          if (!res.headersSent) return writeJson(res, 500, { ok: false, error: "Failed to stream artifact." });
          try {
            res.end();
          } catch {
            // ignore
          }
        });
        stream.pipe(res);
        return;
      } catch {
        return writeJson(res, 404, { ok: false, error: "Artifact file is not available." });
      }
    }

    if (req.method === "GET" && url.pathname === "/notifications") {
      const session_id = (url.searchParams.get("session_id") ?? "").trim();
      const after_id = Number.parseInt(url.searchParams.get("after_id") ?? "0", 10) || 0;
      const limit = Number.parseInt(url.searchParams.get("limit") ?? "50", 10) || 50;
      if (!session_id) return writeJson(res, 400, { error: "Missing session_id" });
      if (!sessionAccessAllowed(res, session_id, auth.principal)) return;

      const notifications = getNotificationsAfter(session_id, after_id, limit);
      const next_after_id = notifications.length > 0 ? notifications[notifications.length - 1]!.id : after_id;
      log("notifications.get", { session_id, after_id, count: notifications.length });
      return writeJson(res, 200, { notifications, next_after_id });
    }

    if (req.method === "GET" && url.pathname === "/health") {
      const ws = ensureWorkspaceLayout();
      return writeJson(res, 200, {
        status: "ok",
        version: OPERATOR_BACKEND_CONTRACT_VERSION,
        auth_mode: authMode,
        principal: auth.principal
          ? {
              user_id: auth.principal.user_id,
              tenant_id: auth.principal.tenant_id || auth.principal.license_id,
              roles: auth.principal.roles
            }
          : null,
        workspace_root: ws.root,
        revit_transport: (process.env.OPERATOR_REVIT_TRANSPORT || "direct").trim().toLowerCase(),
        revit_courier_enabled: (process.env.OPERATOR_REVIT_TRANSPORT || "direct").trim().toLowerCase() === "courier",
        codex_app_server: getCodexAppServerCompatibility(),
        memory_path: ws.memory,
        local_skills_path: ws.skills,
        zippybim: getZippyBimConfig()
      });
    }

    return writeJson(res, 404, { error: "Not found" });
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    if (!res.headersSent) return writeJson(res, 500, { error: message });
    try {
      res.end();
    } catch {
      // ignore
    }
    return;
  }
});

function persistServerPlannedStep(sessionId: string, messageId: string, userText: string | null, actions: unknown[]): void {
  registerServerPlannedActions(sessionId, actions);
  upsertStepPlanned(sessionId, messageId, userText, actions);
}

function normalizeUserAttachments(input: unknown): NonNullable<ChatRequest["user_attachments"]> {
  if (!Array.isArray(input)) return [];
  const out: any[] = [];
  for (const item of input) {
    if (!item || typeof item !== "object") continue;
    const a = item as any;
    const id = typeof a.id === "string" ? a.id.trim() : "";
    if (!id) continue;
    const rawRelativePath = typeof a.relative_path === "string" ? a.relative_path.trim() : "";
    const sha256 = typeof a.sha256 === "string" ? a.sha256.trim() : "";
    const indexed =
      rawRelativePath && uploadIndexRelativePathExists(rawRelativePath)
        ? null
        : findLatestUploadIndexRecord({
            id,
            sha256,
            relative_path: rawRelativePath
          });
    out.push({
      id,
      relative_path: indexed?.relative_path ?? (rawRelativePath || undefined),
      filename: typeof a.filename === "string" && a.filename.trim() ? a.filename.trim() : indexed?.filename,
      bytes: typeof a.bytes === "number" ? a.bytes : indexed?.bytes,
      sha256: sha256 || indexed?.sha256,
      mime: typeof a.mime === "string" && a.mime.trim() ? a.mime.trim() : indexed?.mime,
      created_at: typeof a.created_at === "string" && a.created_at.trim() ? a.created_at.trim() : indexed?.created_at,
      external_path: typeof a.external_path === "string" ? a.external_path.trim() : undefined
    });
  }
  return out;
}

function formatAttachmentsForUserText(attachments: NonNullable<ChatRequest["user_attachments"]>): string {
  const list = Array.isArray(attachments) ? attachments : [];
  if (list.length === 0) return "";
  const lines: string[] = [];
  lines.push("Attachments:");
  let i = 0;
  for (const a of list) {
    i++;
    const id = a?.id ? String(a.id) : "";
    const p = (a as any)?.relative_path ? String((a as any).relative_path) : "";
    const ext = (a as any)?.external_path ? String((a as any).external_path) : "";
    const name = (a as any)?.filename ? String((a as any).filename) : (p || ext);
    const sha = (a as any)?.sha256 ? String((a as any).sha256).slice(0, 12) : "";
    const bytes = typeof (a as any)?.bytes === "number" ? Math.round((a as any).bytes) : null;
    const loc = p ? `path=${p}` : ext ? `external=${ext}` : "";
    const meta = [id ? `id=${id}` : null, loc || null, sha ? `sha256=${sha}…` : null, bytes !== null ? `bytes=${bytes}` : null]
      .filter(Boolean)
      .join(", ");
    lines.push(`- [${i}] ${name}${meta ? ` (${meta})` : ""}`);
  }
  return lines.join("\n");
}

function appendAttachmentsToUserText(userText: string, attachments: NonNullable<ChatRequest["user_attachments"]>): string {
  const t = (userText ?? "").trim();
  const block = formatAttachmentsForUserText(attachments);
  if (!block) return t;
  if (!t) return block;
  return `${t}\n\n${block}`;
}

function maybeStartAutoGoal(
  sessionId: string,
  userText: string,
  toolResultCount: number,
  source: string,
  principal?: RequestPrincipal
): void {
  try {
    if (toolResultCount > 0) return;
    if (getActiveGoalForSession(sessionId)) return;
    const decision = classifyAutoGoalRequest(userText);
    if (!decision.shouldStart) return;
    const owner = sessionOwnerForPrincipal(principal);
    const goal = setAgentGoal(sessionId, {
      title: decision.title,
      objective: decision.objective,
      success_criteria: decision.acceptanceCriteria,
      current_phase: "observe",
      current_step: "Capability-aware preflight",
      progress_summary: `Auto-entered goal mode (${decision.signals.join("; ")}).`,
      work_budget: {
        mode: "auto_goal",
        source,
        score: decision.score,
        signals: decision.signals,
        retry_policy: "bounded spatial/workflow retries; ask or block after no defensible next action"
      },
      created_by: owner?.owner_user_id ?? `auto_goal:${source}`
    });
    appendNotification(sessionId, "goal.auto_started", `Goal mode started: ${goal.title}`, {
      goal_id: goal.id,
      status: goal.status,
      signals: decision.signals
    });
  } catch {
    // Auto-goal routing should never block a chat turn.
  }
}

function appendToolFailureEvent(sessionId: string, messageId: string, r: ToolResult): void {
  if (r.status !== "failed") return;
  const attachmentSummary = summarizeFailureAttachments(r.attachments);
  appendEvent(sessionId, "assistant", "tool.failure", {
    message_id: messageId,
    action_id: r.action_id,
    method: r.method,
    path: r.path,
    status: r.status,
    ...(typeof r.error === "string" && r.error.trim() ? { error: r.error.trim() } : {}),
    ...(typeof r.failure_kind === "string" && r.failure_kind.trim() ? { failure_kind: r.failure_kind.trim() } : {}),
    ...(typeof r.failure_code === "string" && r.failure_code.trim() ? { failure_code: r.failure_code.trim() } : {}),
    ...(typeof r.failure_hint === "string" && r.failure_hint.trim() ? { failure_hint: r.failure_hint.trim() } : {}),
    ...(typeof r.duration_ms === "number" ? { duration_ms: Math.round(r.duration_ms) } : {}),
    ...(attachmentSummary ? { attachments: attachmentSummary } : {})
  });
}

function summarizeFailureAttachments(attachments: ToolResult["attachments"] | undefined): { total: number; image_count: number } | null {
  const list = Array.isArray(attachments) ? attachments : [];
  if (list.length === 0) return null;
  const imageCount = list.filter(a => a && typeof a === "object" && (a as any).kind === "image").length;
  return {
    total: list.length,
    image_count: imageCount
  };
}

function summarizeToolResult(r: ToolResult): string {
  const bits = [`${r.status.toUpperCase()} ${r.method} ${r.path} (action_id=${r.action_id})`];
  if (typeof r.duration_ms === "number") bits.push(`duration_ms=${Math.round(r.duration_ms)}`);
  if (r.error) bits.push(`error=${r.error}`);
  if (r.failure_code) bits.push(`failure_code=${r.failure_code}`);
  if (r.failure_kind) bits.push(`failure_kind=${r.failure_kind}`);
  const attachments = r.attachments ?? [];
  const img = attachments.filter(a => a && typeof a === "object" && (a as any).kind === "image");
  if (img.length > 0) bits.push(`attachments=image(${img.length})`);

  try {
    if (r.path === "/revit/quantify" && r.result_json && typeof r.result_json === "object") {
      const rr: any = r.result_json;
      const total = rr?.summary?.total;
      if (typeof total === "number") bits.push(`total=${total}`);
      const rsid = typeof rr?.resultSetId === "string" ? rr.resultSetId.trim() : "";
      if (rsid) bits.push(`resultSetId=${rsid.slice(0, 12)}…`);
      const groups = rr?.summary?.groups;
      if (groups && typeof groups === "object") {
        const entries = Object.entries(groups as Record<string, unknown>)
          .filter(([, v]) => typeof v === "number")
          .sort((a, b) => (b[1] as number) - (a[1] as number))
          .slice(0, 5);
        if (entries.length > 0) bits.push(`top_groups=${entries.map(([k, v]) => `${k}:${v}`).join(",")}`);
      }
    }

    if (
      (r.path === "/revit/export-image" ||
        r.path === "/revit/export-view-frame" ||
        r.path === "/revit/export-view-region" ||
        r.path === "/revit/export-visible-elements" ||
        r.path === "/revit/highlight-and-export" ||
        r.path === "/revit/mep-route-workflow") &&
      r.result_json &&
      typeof r.result_json === "object"
    ) {
      const rr: any = r.result_json;
      if (typeof rr.path === "string") bits.push(`path=${rr.path}`);
      if (typeof rr?.visualVerification?.capture?.path === "string") bits.push(`path=${rr.visualVerification.capture.path}`);
    }

    if (r.path === "/revit/export-visible-elements") {
      const inventory = describeVisibleElementsInventory(r.result_json);
      if (inventory && inventory.count !== null) bits.push(`count=${inventory.count}`);
      if (inventory && inventory.sampled) bits.push(`sampled=${inventory.sampled}`);
      if (inventory && inventory.topCategories.length) bits.push(`top_categories=${inventory.topCategories.slice(0, 3).join(",")}`);
      if (inventory && inventory.topRooms.length) bits.push(`top_rooms=${inventory.topRooms.slice(0, 3).join(",")}`);
    }
  } catch {
    // ignore
  }

  return bits.join(" | ");
}

let uploadQueueWorker: { stop: () => void } | null = null;
let improvementJobWorker: { stop: () => void } | null = null;
function refreshImprovementJobWorker(): void {
  try {
    improvementJobWorker?.stop();
  } catch {
    // ignore
  }
  improvementJobWorker = null;
  improvementJobWorker = startImprovementJobWorker();
}

function refreshUploadQueueWorker(): void {
  try {
    uploadQueueWorker?.stop();
  } catch {
    // ignore
  }
  uploadQueueWorker = null;
  uploadQueueWorker = startUploadQueueWorker();
}

server.listen(port, "127.0.0.1", () => {
  // eslint-disable-next-line no-console
  console.log(`[operator-backend] listening on http://localhost:${port}`);
  try {
    refreshImprovementJobWorker();
  } catch {
    // ignore
  }
  try {
    refreshUploadQueueWorker();
  } catch {
    // ignore (opt-in)
  }
});
