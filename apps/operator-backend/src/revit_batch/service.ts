import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { syncTaskFromRevitBatchJob } from "../tasks/service.js";
import { ensureWorkspaceLayout } from "../workspace.js";

export const REVIT_BATCH_JOB_TYPE_ROOM_VIEW_CAPTURE = "room_view_capture";
export const REVIT_BATCH_JOB_TYPE_DELEGATED = "delegated_revit_task_batch";

export type RevitBatchJobType =
  | typeof REVIT_BATCH_JOB_TYPE_ROOM_VIEW_CAPTURE
  | typeof REVIT_BATCH_JOB_TYPE_DELEGATED;

export type RevitBatchJobStatus =
  | "planning"
  | "awaiting_approval"
  | "queued"
  | "running"
  | "pausing"
  | "paused"
  | "cancelling"
  | "cancelled"
  | "failed"
  | "succeeded"
  | "succeeded_with_failures";

type JsonMap = Record<string, unknown>;

export type RevitBatchOwner = {
  user_id: string;
  tenant_id: string;
};

export type RevitBatchTargetContext = {
  executor_id: string;
  project_fingerprint: string;
  document_title?: string;
  document_path?: string;
};

/**
 * Supplied by the authenticated HTTP boundary, never copied from the job body.
 * Omitting the context retains compatibility with legacy local/shared-token jobs.
 */
export type RevitBatchAccessContext = {
  owner?: RevitBatchOwner | null;
  session_id?: string | null;
  target?: RevitBatchTargetContext | null;
};

export type RevitBatchJobItem = {
  id: string;
  index: number;
  status: "pending" | "running" | "succeeded" | "failed" | "skipped";
  started_at?: string | null;
  finished_at?: string | null;
  claim?: {
    executor_id: string;
    executor_kind: string;
    claimed_at: string;
    lease_expires_at: string;
    fencing_token?: string;
    attempt?: number;
    schema_version?: 2;
    owner?: RevitBatchOwner;
    session_id?: string;
    target_context?: RevitBatchTargetContext;
  } | null;
  error?: string;
  [key: string]: unknown;
};

export type RevitBatchJobRecord = {
  id: string;
  task_id?: string;
  job_type: RevitBatchJobType;
  title: string;
  status: RevitBatchJobStatus;
  created_at: string;
  updated_at: string;
  started_at?: string | null;
  finished_at?: string | null;
  output_folder_relative?: string;
  executor_kind: string;
  owner?: RevitBatchOwner;
  session_id?: string;
  target_context?: RevitBatchTargetContext;
  params: JsonMap;
  source: JsonMap;
  approval: JsonMap;
  planning_progress?: JsonMap | null;
  preview_items: unknown[];
  items: RevitBatchJobItem[];
  result: JsonMap;
  events?: Array<{ ts: string; kind: string; text: string }>;
  error?: string | null;
  cancel_requested?: boolean;
  pause_requested?: boolean;
};

export type CreateRevitBatchJobInput = {
  job_type?: unknown;
  title?: unknown;
  params?: unknown;
  source?: unknown;
  approval?: unknown;
  preview_items?: unknown;
  items?: unknown;
  result?: unknown;
  output_folder_relative?: unknown;
  executor_kind?: unknown;
};

export type ClaimNextRevitBatchItemInput = {
  job_id?: string;
  executor_id: string;
  executor_kind?: string;
  access?: RevitBatchAccessContext;
};

export type CompleteRevitBatchItemInput = {
  job_id: string;
  item_id: string;
  executor_id: string;
  claim_token?: string;
  result?: unknown;
  access?: RevitBatchAccessContext;
};

export type FailRevitBatchItemInput = {
  job_id: string;
  item_id: string;
  executor_id: string;
  claim_token?: string;
  error: string;
  result?: unknown;
  access?: RevitBatchAccessContext;
};

const TERMINAL_JOB_STATUSES = new Set<RevitBatchJobStatus>([
  "cancelled",
  "failed",
  "succeeded",
  "succeeded_with_failures"
]);
const CLAIMABLE_JOB_STATUSES = new Set<RevitBatchJobStatus>(["queued", "running"]);
const JOB_LOCK_WAIT_MS = 5_000;
const JOB_LOCK_STALE_MS = 60_000;
const LOCK_WAIT_ARRAY = new Int32Array(new SharedArrayBuffer(4));

function nowIso(): string {
  return new Date().toISOString();
}

function clip(value: unknown, max = 400): string {
  const text = typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
  if (!text) return "";
  return text.length <= max ? text : `${text.slice(0, max).trim()}…`;
}

function asObject(value: unknown): JsonMap {
  return value && typeof value === "object" && !Array.isArray(value) ? { ...(value as JsonMap) } : {};
}

function asArray<T = unknown>(value: unknown): T[] {
  return Array.isArray(value) ? (value as T[]) : [];
}

function asJobType(value: unknown): RevitBatchJobType {
  const normalized = clip(value, 80).toLowerCase();
  return normalized === REVIT_BATCH_JOB_TYPE_ROOM_VIEW_CAPTURE
    ? REVIT_BATCH_JOB_TYPE_ROOM_VIEW_CAPTURE
    : REVIT_BATCH_JOB_TYPE_DELEGATED;
}

function asPositiveInt(value: unknown, fallback: number, min: number, max: number): number {
  const numeric = typeof value === "number" ? value : typeof value === "string" ? Number.parseInt(value, 10) : NaN;
  if (!Number.isFinite(numeric)) return fallback;
  return Math.max(min, Math.min(max, Math.round(numeric)));
}

function normalizeOwner(value: RevitBatchOwner | null | undefined): RevitBatchOwner | null {
  if (!value) return null;
  const userId = clip(value.user_id, 200);
  const tenantId = clip(value.tenant_id, 200);
  if (!userId || !tenantId) throw new Error("Authenticated batch owner context is incomplete.");
  return { user_id: userId, tenant_id: tenantId };
}

function normalizeTargetContext(value: RevitBatchTargetContext | null | undefined): RevitBatchTargetContext | null {
  if (!value) return null;
  const executorId = clip(value.executor_id, 160);
  const fingerprint = clip(value.project_fingerprint, 256).toLowerCase();
  if (!executorId) throw new Error("Batch target executor_id is required.");
  if (!/^[a-f0-9]{64}$/.test(fingerprint)) {
    throw new Error("Batch target project_fingerprint must be a 64-character SHA-256 value.");
  }
  const documentTitle = clip(value.document_title, 512);
  const documentPath = clip(value.document_path, 2048);
  return {
    executor_id: executorId,
    project_fingerprint: fingerprint,
    ...(documentTitle ? { document_title: documentTitle } : {}),
    ...(documentPath ? { document_path: documentPath } : {})
  };
}

function normalizeAccessContext(value: RevitBatchAccessContext | null | undefined): {
  owner: RevitBatchOwner | null;
  session_id: string;
  target: RevitBatchTargetContext | null;
} {
  return {
    owner: normalizeOwner(value?.owner),
    session_id: clip(value?.session_id, 200),
    target: normalizeTargetContext(value?.target)
  };
}

function bindingFromCreateAccess(value: RevitBatchAccessContext | null | undefined): {
  owner?: RevitBatchOwner;
  session_id?: string;
  target_context?: RevitBatchTargetContext;
} {
  if (!value) return {};
  const access = normalizeAccessContext(value);
  if (!access.session_id || !access.target) {
    throw new Error("Bound batch creation requires session_id, intended executor, and project fingerprint.");
  }
  return {
    ...(access.owner ? { owner: access.owner } : {}),
    session_id: access.session_id,
    target_context: access.target
  };
}

function ownersMatch(a: RevitBatchOwner | null | undefined, b: RevitBatchOwner | null | undefined): boolean {
  return !!a && !!b && a.user_id === b.user_id && a.tenant_id === b.tenant_id;
}

function targetsMatch(a: RevitBatchTargetContext | null | undefined, b: RevitBatchTargetContext | null | undefined): boolean {
  return !!a && !!b &&
    a.executor_id === b.executor_id &&
    a.project_fingerprint.toLowerCase() === b.project_fingerprint.toLowerCase();
}

function jobAccessAllowed(job: RevitBatchJobRecord, value: RevitBatchAccessContext | null | undefined): boolean {
  const isBound = !!job.owner || !!job.session_id || !!job.target_context;
  if (!isBound) return true;
  const access = normalizeAccessContext(value);
  return (!job.owner || ownersMatch(job.owner, access.owner)) &&
    !!job.session_id && job.session_id === access.session_id &&
    targetsMatch(job.target_context, access.target);
}

function assertJobAccess(job: RevitBatchJobRecord, value: RevitBatchAccessContext | null | undefined): void {
  if (!jobAccessAllowed(job, value)) throw new Error("Batch job access context mismatch.");
}

function ensureDir(dirPath: string): string {
  fs.mkdirSync(dirPath, { recursive: true });
  return dirPath;
}

function batchJobsRoot(): string {
  return ensureDir(path.join(ensureWorkspaceLayout().artifacts, "revit-batch", "jobs"));
}

function jobDir(jobId: string): string {
  return path.join(batchJobsRoot(), jobId);
}

function jobRecordPath(jobId: string): string {
  return path.join(jobDir(jobId), "job.json");
}

function jobSummaryPath(jobId: string): string {
  return path.join(jobDir(jobId), "summary.json");
}

function jobManifestPath(jobId: string): string {
  return path.join(jobDir(jobId), "manifest.csv");
}

function jobLockPath(jobId: string): string {
  return path.join(jobDir(jobId), ".job.lock");
}

function processIsAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function archiveStaleJobLock(lockPath: string): boolean {
  try {
    const stat = fs.statSync(lockPath);
    if (Date.now() - stat.mtimeMs < JOB_LOCK_STALE_MS) return false;
    const metadata = readJsonFile<{ pid?: number }>(lockPath);
    if (metadata?.pid && processIsAlive(metadata.pid)) return false;
    fs.renameSync(lockPath, `${lockPath}.stale-${Date.now()}-${randomUUID().replace(/-/g, "")}`);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return true;
    return false;
  }
}

function withJobLock<T>(jobId: string, action: () => T): T {
  const lockPath = jobLockPath(jobId);
  ensureDir(path.dirname(lockPath));
  const token = randomUUID().replace(/-/g, "");
  const deadline = Date.now() + JOB_LOCK_WAIT_MS;
  let fd: number | null = null;
  while (fd === null) {
    try {
      fd = fs.openSync(lockPath, "wx");
      try {
        fs.writeFileSync(fd, JSON.stringify({ token, pid: process.pid, created_at: nowIso() }) + "\n", "utf8");
      } catch (error) {
        fs.closeSync(fd);
        fd = null;
        try {
          fs.unlinkSync(lockPath);
        } catch {
          // Preserve the lock-write error.
        }
        throw error;
      }
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "EEXIST") throw error;
      if (archiveStaleJobLock(lockPath)) continue;
      if (Date.now() >= deadline) throw new Error(`Timed out waiting for the batch job lock for ${jobId}.`);
      Atomics.wait(LOCK_WAIT_ARRAY, 0, 0, 10);
    }
  }
  try {
    return action();
  } finally {
    try {
      fs.closeSync(fd);
    } catch {
      // The lock file is still fenced by its random token if close already occurred.
    }
    try {
      const metadata = readJsonFile<{ token?: string }>(lockPath);
      if (metadata?.token === token) fs.unlinkSync(lockPath);
    } catch {
      // A missing lock after the action is harmless; another token is never removed.
    }
  }
}

function toPublicJob(job: RevitBatchJobRecord, includeItems = true): JsonMap {
  return {
    id: job.id,
    task_id: job.task_id || null,
    job_type: job.job_type,
    title: job.title,
    status: job.status,
    created_at: job.created_at,
    updated_at: job.updated_at,
    started_at: job.started_at || null,
    finished_at: job.finished_at || null,
    error: job.error || null,
    output_folder_relative: job.output_folder_relative || "",
    executor_kind: job.executor_kind,
    owner: job.owner || null,
    session_id: job.session_id || null,
    target_context: job.target_context || null,
    params: job.params,
    source: job.source,
    approval: job.approval,
    planning_progress: job.planning_progress || null,
    preview_items: asArray(job.preview_items).slice(0, 8),
    item_summary: summarizeItems(job.items),
    result: job.result,
    events: asArray(job.events).slice(-40),
    ...(includeItems ? { items: job.items } : {})
  };
}

function summarizeItems(items: RevitBatchJobItem[]): Record<string, number> {
  const summary = { total: 0, pending: 0, running: 0, succeeded: 0, failed: 0, skipped: 0 };
  for (const item of items) {
    summary.total += 1;
    const status = `${item?.status || "pending"}`.trim().toLowerCase();
    if (status === "running") summary.running += 1;
    else if (status === "succeeded") summary.succeeded += 1;
    else if (status === "failed") summary.failed += 1;
    else if (status === "skipped") summary.skipped += 1;
    else summary.pending += 1;
  }
  return summary;
}

function writeTextFileAtomic(filePath: string, contents: string): void {
  ensureDir(path.dirname(filePath));
  const tempPath = `${filePath}.tmp-${process.pid}-${randomUUID().replace(/-/g, "")}`;
  fs.writeFileSync(tempPath, contents, "utf8");
  try {
    fs.renameSync(tempPath, filePath);
  } catch (error) {
    try {
      fs.unlinkSync(tempPath);
    } catch {
      // Preserve the original rename error.
    }
    throw error;
  }
}

function writeJsonFile(filePath: string, value: unknown): void {
  writeTextFileAtomic(filePath, JSON.stringify(value, null, 2) + "\n");
}

function readJsonFile<T>(filePath: string): T | null {
  try {
    if (!fs.existsSync(filePath)) return null;
    return JSON.parse(fs.readFileSync(filePath, "utf8")) as T;
  } catch {
    return null;
  }
}

function writeManifest(job: RevitBatchJobRecord): void {
  const header =
    job.job_type === REVIT_BATCH_JOB_TYPE_DELEGATED
      ? "index,label,itemKey,status,resultSummary,error,claimExecutor"
      : "index,roomNumber,roomName,levelName,viewId,viewName,status,outputRelativePath,error";
  const rows = [header];
  for (const item of job.items) {
    const values =
      job.job_type === REVIT_BATCH_JOB_TYPE_DELEGATED
        ? [
            item.index,
            item.label,
            item.item_key,
            item.status,
            item.result_summary,
            item.error,
            item.claim?.executor_id || ""
          ]
        : [
            item.index,
            item.room_number,
            item.room_name,
            item.level_name,
            item.view_id,
            item.view_name,
            item.status,
            item.output_relative_path,
            item.error
          ];
    rows.push(values.map((value) => `"${`${value ?? ""}`.replace(/"/g, "\"\"")}"`).join(","));
  }
  writeTextFileAtomic(jobManifestPath(job.id), rows.join("\n") + "\n");
}

function saveJob(job: RevitBatchJobRecord): RevitBatchJobRecord {
  const next = {
    ...job,
    updated_at: nowIso()
  };
  ensureDir(jobDir(job.id));
  writeJsonFile(jobRecordPath(job.id), next);
  writeJsonFile(jobSummaryPath(job.id), toPublicJob(next, false));
  writeManifest(next);
  try {
    syncTaskFromRevitBatchJob(next);
  } catch {
    // Do not fail the batch persistence path if generic task syncing fails.
  }
  return next;
}

function readJob(jobId: string): RevitBatchJobRecord | null {
  return readJsonFile<RevitBatchJobRecord>(jobRecordPath(jobId));
}

function listJobRecords(limit = 20): RevitBatchJobRecord[] {
  return fs
    .readdirSync(batchJobsRoot(), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => readJob(entry.name))
    .filter((entry): entry is RevitBatchJobRecord => !!entry)
    .sort((a, b) => `${b.updated_at}|${b.id}`.localeCompare(`${a.updated_at}|${a.id}`))
    .slice(0, Math.max(1, limit));
}

function sanitizeItem(raw: unknown, index: number): RevitBatchJobItem | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const source = raw as JsonMap;
  const taskPrompt = clip(source.task_prompt ?? source.taskPrompt, 4000);
  const base: RevitBatchJobItem = {
    id: clip(source.id, 80) || randomUUID().replace(/-/g, ""),
    index: asPositiveInt(source.index, index + 1, 1, 100000),
    status:
      `${source.status || "pending"}`.trim().toLowerCase() === "failed"
        ? "failed"
        : `${source.status || "pending"}`.trim().toLowerCase() === "succeeded"
          ? "succeeded"
          : "pending",
    error: clip(source.error, 500)
  };
  const next: RevitBatchJobItem = {
    ...source,
    ...base
  };
  if (taskPrompt) next.task_prompt = taskPrompt;
  return next;
}

function appendEvent(job: RevitBatchJobRecord, kind: string, text: string): RevitBatchJobRecord {
  const entry = { ts: nowIso(), kind, text: clip(text, 500) };
  return saveJob({
    ...job,
    events: [...(Array.isArray(job.events) ? job.events : []), entry].slice(-200)
  });
}

function finalizeJobIfComplete(job: RevitBatchJobRecord): RevitBatchJobRecord {
  let items = job.items;
  let counts = summarizeItems(items);
  if (counts.running > 0) return job;

  if (job.cancel_requested || job.status === "cancelling") {
    const finishedAt = nowIso();
    items = items.map((item) => item.status === "pending"
      ? { ...item, status: "skipped" as const, finished_at: finishedAt, error: "Skipped because the batch was cancelled." }
      : item);
    counts = summarizeItems(items);
    return saveJob({
      ...job,
      items,
      status: "cancelled",
      finished_at: finishedAt,
      result: { ...(job.result || {}), counts, finished_at: finishedAt, status: "cancelled" }
    });
  }

  if (job.pause_requested || job.status === "pausing") {
    return saveJob({
      ...job,
      status: "paused",
      finished_at: null,
      result: { ...(job.result || {}), counts, finished_at: null, status: "paused" }
    });
  }

  if (counts.pending > 0) return job;

  let status: RevitBatchJobStatus = "succeeded";
  if (counts.failed > 0 && counts.succeeded > 0) status = "succeeded_with_failures";
  else if (counts.failed > 0) status = "failed";

  return saveJob({
    ...job,
    status,
    finished_at: nowIso(),
    result: {
      ...(job.result || {}),
      counts,
      finished_at: nowIso(),
      status
    }
  });
}

function leaseDurationMs(): number {
  const raw = Number.parseInt(process.env.OPERATOR_REVIT_BATCH_LEASE_MS ?? "", 10);
  if (!Number.isFinite(raw)) return 30 * 60 * 1000;
  return Math.max(60_000, Math.min(4 * 60 * 60 * 1000, raw));
}

function isReadOnlyItem(job: RevitBatchJobRecord, item: RevitBatchJobItem): boolean {
  const taskText = `${item.task_prompt || ""} ${job.params?.task_prompt || ""}`.trim();
  if (/\b(?:add|apply|change|connect|create|delete|disconnect|edit|modify|move|place|remove|rename|replace|resize|route|set|update|write)\b/i.test(taskText)) {
    return false;
  }
  if (typeof item.read_only === "boolean") return item.read_only;
  const operationKind = clip(item.operation_kind ?? item.execution_mode, 80).toLowerCase().replace(/[ -]+/g, "_");
  if (["read", "readonly", "read_only", "non_mutating"].includes(operationKind)) return true;
  if (["write", "mutation", "mutating"].includes(operationKind)) return false;
  return job.job_type === REVIT_BATCH_JOB_TYPE_ROOM_VIEW_CAPTURE;
}

function maxClaimAttempts(job: RevitBatchJobRecord, item: RevitBatchJobItem): number {
  return asPositiveInt(item.max_claim_attempts ?? job.params?.max_claim_attempts, 3, 1, 10);
}

function reconcileExpiredClaims(job: RevitBatchJobRecord): RevitBatchJobRecord {
  const now = Date.now();
  let changed = false;
  const mutationUnknownIds: string[] = [];
  let readOnlyRequeued = 0;
  let readOnlyExhausted = 0;
  const items = job.items.map((item) => {
    const leaseExpiresAt = `${item.claim?.lease_expires_at || ""}`.trim();
    const expiresAt = leaseExpiresAt ? Date.parse(leaseExpiresAt) : NaN;
    if (item.status !== "running" || (Number.isFinite(expiresAt) && expiresAt > now)) return item;
    changed = true;
    const attempt = asPositiveInt(item.claim?.attempt ?? item.claim_attempts, 1, 1, 10_000);
    if (isReadOnlyItem(job, item) && attempt < maxClaimAttempts(job, item)) {
      readOnlyRequeued += 1;
      return {
        ...item,
        status: "pending" as const,
        claim: null,
        claim_attempts: attempt,
        error: "The previous read-only claim expired before settlement and was safely re-queued."
      };
    }
    const readOnly = isReadOnlyItem(job, item);
    if (readOnly) readOnlyExhausted += 1;
    else mutationUnknownIds.push(item.id);
    return {
      ...item,
      status: "failed" as const,
      finished_at: nowIso(),
      claim: null,
      claim_attempts: attempt,
      outcome: "unknown",
      retryable: false,
      reconciliation_required: !readOnly,
      error: readOnly
        ? `The read-only claim expired without settlement after ${attempt} attempt${attempt === 1 ? "" : "s"}; automatic retries are exhausted.`
        : "The mutating claim expired after execution may have started. Its outcome is unknown and must be reconciled before any retry."
    };
  });
  if (!changed) return job;
  const events = [...(Array.isArray(job.events) ? job.events : [])];
  if (readOnlyRequeued > 0) {
    events.push({ ts: nowIso(), kind: "read_only_claim_requeued", text: `Safely re-queued ${readOnlyRequeued} expired read-only batch claim${readOnlyRequeued === 1 ? "" : "s"}.` });
  }
  if (readOnlyExhausted > 0) {
    events.push({ ts: nowIso(), kind: "read_only_retry_exhausted", text: `${readOnlyExhausted} read-only batch claim${readOnlyExhausted === 1 ? "" : "s"} exhausted the automatic retry limit.` });
  }
  if (mutationUnknownIds.length > 0) {
    events.push({ ts: nowIso(), kind: "mutation_outcome_unknown", text: `${mutationUnknownIds.length} expired mutating batch claim${mutationUnknownIds.length === 1 ? "" : "s"} require reconciliation and will not be replayed.` });
  }
  const activeAfterRecovery = items.some((item) => item.status === "pending" || item.status === "running");
  const status: RevitBatchJobStatus = mutationUnknownIds.length > 0
    ? (activeAfterRecovery ? "paused" : "failed")
    : (job.status === "running" && readOnlyRequeued > 0 ? "queued" : job.status);
  let saved = saveJob({
    ...job,
    status,
    pause_requested: mutationUnknownIds.length > 0 && activeAfterRecovery ? true : job.pause_requested,
    finished_at: mutationUnknownIds.length > 0 && !activeAfterRecovery ? nowIso() : job.finished_at,
    error: mutationUnknownIds.length > 0
      ? "One or more mutating items have an unknown outcome and require reconciliation before the batch can continue."
      : job.error,
    items,
    events: events.slice(-200),
    result: mutationUnknownIds.length > 0
      ? {
          ...(job.result || {}),
          reconciliation_required: true,
          unknown_outcome_item_ids: mutationUnknownIds,
          reason: "expired_mutating_claim"
        }
      : job.result
  });
  if (mutationUnknownIds.length === 0 && !saved.items.some((item) => item.status === "pending" || item.status === "running")) {
    saved = finalizeJobIfComplete(saved);
  }
  return saved;
}

function defaultTemplates(): JsonMap[] {
  return [
    {
      job_type: REVIT_BATCH_JOB_TYPE_DELEGATED,
      title: "Run a repeated Revit task across a scope",
      description: "Plan a reusable worklist for a repeated Revit task, preview a few items, then let a frontend executor claim and run them with resumable control.",
      task_prompt: "",
      scope_description: "",
      work_item_hint: "",
      preview_count: 3,
      max_items: 50,
      per_item_max_rounds: 8
    },
    {
      job_type: REVIT_BATCH_JOB_TYPE_ROOM_VIEW_CAPTURE,
      title: "Capture room discipline screenshots",
      description: "Resolve a plan view for each room, export the image, and file it with a deterministic name.",
      view_name_hint: "coord",
      image_size: 2048,
      file_name_pattern: "{roomNumber}_{viewName}",
      output_folder_relative: "artifacts/revit-batch/exports/room-captures",
      sample_count: 3,
      max_rooms: 200
    }
  ];
}

export function listRevitBatchTemplates(): JsonMap[] {
  return defaultTemplates();
}

export function createRevitBatchJob(input: CreateRevitBatchJobInput, access?: RevitBatchAccessContext): JsonMap {
  const jobType = asJobType(input.job_type);
  const params = asObject(input.params);
  const source = asObject(input.source);
  const approval = asObject(input.approval);
  const previewItems = asArray(input.preview_items).slice(0, 12);
  const items = asArray(input.items).map((item, index) => sanitizeItem(item, index)).filter((item): item is RevitBatchJobItem => !!item);
  const title = clip(input.title || params.title || defaultTemplates().find((template) => template.job_type === jobType)?.title, 160) || "Revit batch job";
  const id = randomUUID().replace(/-/g, "");
  const pendingCount = items.filter((item) => item.status === "pending").length;
  const initialStatus: RevitBatchJobStatus =
    pendingCount <= 0 ? "failed" : approval.required === false ? "queued" : "awaiting_approval";
  const binding = bindingFromCreateAccess(access);
  const job: RevitBatchJobRecord = {
    id,
    task_id: randomUUID().replace(/-/g, ""),
    job_type: jobType,
    title,
    status: initialStatus,
    created_at: nowIso(),
    updated_at: nowIso(),
    started_at: null,
    finished_at: initialStatus === "failed" ? nowIso() : null,
    output_folder_relative: clip(input.output_folder_relative, 300),
    executor_kind: clip(input.executor_kind, 120) || "revit_delegate",
    ...binding,
    params,
    source,
    approval: {
      required: approval.required !== false,
      approved_at: approval.required === false ? nowIso() : null,
      sample_count: asPositiveInt(approval.sample_count, 3, 1, 12)
    },
    planning_progress: null,
    preview_items: previewItems,
    items,
    result: asObject(input.result),
    events: [],
    error: pendingCount <= 0 ? "This batch job has no runnable items." : null
  };
  const saved = appendEvent(saveJob(job), "created", `Created batch job '${title}'.`);
  if (saved.status === "queued") {
    return toPublicJob(appendEvent(saved, "queued", `Batch job '${title}' queued.`));
  }
  return toPublicJob(saved);
}

export function listRevitBatchJobs(limit = 20, access?: RevitBatchAccessContext): JsonMap[] {
  return listJobRecords(Math.max(limit, 200)).filter((job) => jobAccessAllowed(job, access)).slice(0, Math.max(1, limit)).map((job) => withJobLock(job.id, () => {
    const current = readJob(job.id);
    const scoped = current && jobAccessAllowed(current, access) ? current : null;
    return toPublicJob(scoped ? reconcileExpiredClaims(scoped) : job, false);
  }));
}

export function getRevitBatchJob(jobId: string, access?: RevitBatchAccessContext): JsonMap | null {
  const existing = readJob(jobId);
  if (!existing || !jobAccessAllowed(existing, access)) return null;
  return withJobLock(jobId, () => {
    const job = readJob(jobId);
    return job && jobAccessAllowed(job, access) ? toPublicJob(reconcileExpiredClaims(job), true) : null;
  });
}

function mutateJob(jobId: string, access: RevitBatchAccessContext | undefined, mutator: (current: RevitBatchJobRecord) => RevitBatchJobRecord): RevitBatchJobRecord {
  return withJobLock(jobId, () => {
    const current = readJob(jobId);
    if (!current) throw new Error("Batch job not found.");
    assertJobAccess(current, access);
    return mutator(reconcileExpiredClaims(current));
  });
}

export function approveRevitBatchJob(jobId: string, access?: RevitBatchAccessContext): JsonMap {
  const saved = mutateJob(jobId, access, (current) => {
    if (current.status !== "awaiting_approval") throw new Error("Only jobs awaiting approval can be approved.");
    if (!current.items.some((item) => item.status === "pending")) throw new Error("This batch job has no pending items.");
    return appendEvent(saveJob({
      ...current,
      status: "queued",
      approval: {
        ...(current.approval || {}),
        approved_at: nowIso()
      },
      error: null
    }), "approved", `Approved batch job '${current.title}'.`);
  });
  return toPublicJob(saved);
}

export function pauseRevitBatchJob(jobId: string, access?: RevitBatchAccessContext): JsonMap {
  const saved = mutateJob(jobId, access, (current) => {
    if (current.status === "queued") {
      return appendEvent(saveJob({ ...current, status: "paused" }), "paused", `Paused batch job '${current.title}'.`);
    }
    if (current.status !== "running") throw new Error("Only queued or running jobs can be paused.");
    return appendEvent(saveJob({ ...current, status: "pausing", pause_requested: true }), "pause_requested", `Pause requested for '${current.title}'.`);
  });
  return toPublicJob(saved);
}

export function resumeRevitBatchJob(jobId: string, access?: RevitBatchAccessContext): JsonMap {
  const saved = mutateJob(jobId, access, (current) => {
    if (current.status !== "paused") throw new Error("Only paused jobs can be resumed.");
    if (current.result?.reconciliation_required === true || current.items.some((item) => item.reconciliation_required === true)) {
      throw new Error("This batch job requires mutation outcome reconciliation before it can be resumed.");
    }
    return appendEvent(saveJob({
      ...current,
      status: "queued",
      pause_requested: false,
      error: null
    }), "resumed", `Resumed batch job '${current.title}'.`);
  });
  return toPublicJob(saved);
}

export function cancelRevitBatchJob(jobId: string, access?: RevitBatchAccessContext): JsonMap {
  const saved = mutateJob(jobId, access, (current) => {
    if (TERMINAL_JOB_STATUSES.has(current.status)) throw new Error("This batch job is already finished.");
    let next =
      current.status === "running" || current.status === "pausing"
        ? saveJob({ ...current, status: "cancelling", cancel_requested: true })
        : saveJob({ ...current, status: "cancelling", cancel_requested: true });
    if (!next.items.some((item) => item.status === "running")) next = finalizeJobIfComplete(next);
    return appendEvent(next, "cancel_requested", `Cancel requested for batch job '${current.title}'.`);
  });
  return toPublicJob(saved);
}

export function retryFailedRevitBatchItems(jobId: string, access?: RevitBatchAccessContext): JsonMap {
  const saved = mutateJob(jobId, access, (current) => {
    if (current.result?.reconciliation_required === true || current.items.some((item) => item.reconciliation_required === true)) {
      throw new Error("This batch job requires mutation outcome reconciliation before failed items can be retried.");
    }
    const failedCount = current.items.filter((item) => item.status === "failed" && item.reconciliation_required !== true && item.retryable !== false).length;
    if (failedCount <= 0) throw new Error("This batch job has no safely retryable failed items.");
    const reset = current.items.map((item) =>
      item.status === "failed" && item.reconciliation_required !== true && item.retryable !== false
        ? {
            ...item,
            status: "pending" as const,
            error: "",
            finished_at: null,
            started_at: null,
            claim: null
          }
        : item
    );
    return appendEvent(saveJob({
      ...current,
      status: current.approval?.approved_at ? "queued" : "awaiting_approval",
      finished_at: null,
      cancel_requested: false,
      pause_requested: false,
      error: null,
      items: reset
    }), "retry_failed", `Retry requested for failed items in '${current.title}'.`);
  });
  return toPublicJob(saved);
}

export function claimNextRevitBatchItem(input: ClaimNextRevitBatchItemInput): JsonMap {
  const executorId = clip(input.executor_id, 160);
  const executorKind = clip(input.executor_kind, 120) || "revit_delegate";
  const requestedJobId = clip(input.job_id, 120);
  if (!executorId) throw new Error("executor_id is required.");
  const access = normalizeAccessContext(input.access);
  if (access.target && access.target.executor_id !== executorId) {
    throw new Error("Batch claimant does not match the trusted target executor.");
  }

  const jobIds = requestedJobId ? [requestedJobId] : listJobRecords(200).map((job) => job.id);
  for (const jobId of jobIds) {
    const claimed = withJobLock<JsonMap | null>(jobId, () => {
      const current = readJob(jobId);
      if (!current) return null;
      if (!jobAccessAllowed(current, input.access)) {
        if (requestedJobId) throw new Error("Batch job access context mismatch.");
        return null;
      }
      let job = reconcileExpiredClaims(current);
      if (!CLAIMABLE_JOB_STATUSES.has(job.status)) return null;
      if (job.executor_kind && job.executor_kind !== executorKind) return null;
      const nextItem = job.items.find((item) => item.status === "pending");
      if (!nextItem) {
        finalizeJobIfComplete(job);
        return null;
      }
      const attempt = asPositiveInt(nextItem.claim_attempts, 0, 0, 10_000) + 1;
      const claim = {
        executor_id: executorId,
        executor_kind: executorKind,
        claimed_at: nowIso(),
        lease_expires_at: new Date(Date.now() + leaseDurationMs()).toISOString(),
        fencing_token: randomUUID().replace(/-/g, ""),
        attempt,
        schema_version: 2 as const,
        ...(job.owner ? { owner: job.owner } : {}),
        ...(job.session_id ? { session_id: job.session_id } : {}),
        ...(job.target_context ? { target_context: job.target_context } : {})
      };
      const status = job.status === "queued" ? "running" : job.status;
      const claimedJob = appendEvent(
        saveJob({
          ...job,
          status,
          started_at: job.started_at || nowIso(),
          items: job.items.map((item) =>
            item.id === nextItem.id
              ? {
                  ...item,
                  status: "running",
                  started_at: item.started_at || nowIso(),
                  claim_attempts: attempt,
                  error: "",
                  claim
                }
              : item
          )
        }),
        "claim",
        `Claimed item ${nextItem.index} in '${job.title}' for ${executorId} with fenced attempt ${attempt}.`
      );
      const claimedItem = claimedJob.items.find((item) => item.id === nextItem.id) || nextItem;
      return {
        ok: true,
        job: toPublicJob(claimedJob),
        item: claimedItem,
        claim_token: claim.fencing_token
      };
    });
    if (claimed) return claimed;
  }
  return { ok: true, job: null, item: null };
}

function applyResultPatch(item: RevitBatchJobItem, result: unknown): RevitBatchJobItem {
  if (!result || typeof result !== "object" || Array.isArray(result)) return item;
  const source = result as JsonMap;
  const patched: RevitBatchJobItem = { ...item };
  for (const [key, value] of Object.entries(source)) {
    if (key === "status" || key === "claim" || key === "claim_token" || key === "claimToken") continue;
    patched[key] = value;
  }
  return patched;
}

function settlementToken(explicitToken: unknown, result: unknown): string {
  const resultMap = asObject(result);
  return clip(explicitToken ?? resultMap.claim_token ?? resultMap.claimToken, 160);
}

function canonicalSettlementValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalSettlementValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as JsonMap)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, canonicalSettlementValue(entry)])
  );
}

function settlementSha256(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(canonicalSettlementValue(value))).digest("hex");
}

function settleClaim(jobId: string, itemId: string, executorId: string, claimToken: string, failed: boolean, payload: { error?: string; result?: unknown }, access?: RevitBatchAccessContext): JsonMap {
  return withJobLock(jobId, () => {
    const current = readJob(jobId);
    if (!current) throw new Error("Batch job not found.");
    assertJobAccess(current, access);
    const job = reconcileExpiredClaims(current);
    const target = job.items.find((item) => item.id === itemId);
    if (!target) throw new Error("Batch item not found.");
    const settlementReceipt = asObject(target.settlement_receipt);
    if ((target.status === "succeeded" || target.status === "failed") && Object.keys(settlementReceipt).length > 0) {
      const expectedStatus = failed ? "failed" : "succeeded";
      const tokenSha256 = settlementSha256(claimToken);
      const payloadSha256 = settlementSha256({ failed, payload });
      if (target.status !== expectedStatus ||
        clip(settlementReceipt.executor_id, 200) !== executorId.trim() ||
        clip(settlementReceipt.claim_token_sha256, 64) !== tokenSha256 ||
        clip(settlementReceipt.payload_sha256, 64) !== payloadSha256) {
        throw new Error("Batch item was already settled with a different outcome or payload.");
      }
      return {
        ok: true,
        idempotent: true,
        job: toPublicJob(job),
        item: target
      };
    }
    if (target.status !== "running" || !target.claim) {
      throw new Error(target.reconciliation_required === true
        ? "Batch item has an unknown mutation outcome and requires reconciliation; stale settlement is rejected."
        : "Batch item is not actively claimed.");
    }
    if (`${target.claim.executor_id || ""}`.trim() !== executorId.trim()) {
      throw new Error("Batch item is not claimed by this executor.");
    }
    if (job.owner || job.session_id || job.target_context) {
      const claimContextMatches = (!job.owner || ownersMatch(target.claim.owner, job.owner)) &&
        !!target.claim.session_id && target.claim.session_id === job.session_id &&
        targetsMatch(target.claim.target_context, job.target_context);
      if (!claimContextMatches) {
        throw new Error("Batch claim context no longer matches its bound owner, session, executor, and document.");
      }
    }
    const storedToken = clip(target.claim.fencing_token, 160);
    if (storedToken) {
      if (!claimToken) throw new Error("claim_token is required to settle this fenced batch claim.");
      if (storedToken !== claimToken) throw new Error("Stale or invalid batch claim_token; settlement was rejected.");
    } else if (target.claim.schema_version === 2) {
      throw new Error("The fenced batch claim is missing its stored token and cannot be settled safely.");
    }
    const nextItems = job.items.map((item) => {
      if (item.id !== itemId) return item;
      const patched = applyResultPatch(item, payload.result);
      return {
        ...patched,
        status: (failed ? "failed" : "succeeded") as "failed" | "succeeded",
        finished_at: nowIso(),
        claim: null,
        settlement_receipt: {
          schema_version: 1,
          executor_id: executorId.trim(),
          claim_token_sha256: settlementSha256(claimToken),
          payload_sha256: settlementSha256({ failed, payload })
        },
        error: failed ? clip(payload.error, 500) || "Batch item failed." : ""
      };
    });
    let next = saveJob({
      ...job,
      status: job.status === "cancelling" || job.status === "pausing" || job.status === "paused" ? job.status : "running",
      items: nextItems
    });
    next = appendEvent(
      next,
      failed ? "item_failed" : "item_succeeded",
      `${failed ? "Failed" : "Completed"} item ${target.index} in '${job.title}' for fenced attempt ${target.claim.attempt || 1}.`
    );
    next = finalizeJobIfComplete(next);
    return {
      ok: true,
      job: toPublicJob(next),
      item: next.items.find((item) => item.id === itemId) || null
    };
  });
}

export function completeRevitBatchItem(input: CompleteRevitBatchItemInput): JsonMap {
  return settleClaim(input.job_id, input.item_id, input.executor_id, settlementToken(input.claim_token, input.result), false, { result: input.result }, input.access);
}

export function failRevitBatchItem(input: FailRevitBatchItemInput): JsonMap {
  return settleClaim(input.job_id, input.item_id, input.executor_id, settlementToken(input.claim_token, input.result), true, { error: input.error, result: input.result }, input.access);
}
