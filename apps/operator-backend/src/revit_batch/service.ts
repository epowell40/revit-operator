import { randomUUID } from "node:crypto";
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
};

export type CompleteRevitBatchItemInput = {
  job_id: string;
  item_id: string;
  executor_id: string;
  result?: unknown;
};

export type FailRevitBatchItemInput = {
  job_id: string;
  item_id: string;
  executor_id: string;
  error: string;
  result?: unknown;
};

const TERMINAL_JOB_STATUSES = new Set<RevitBatchJobStatus>([
  "cancelled",
  "failed",
  "succeeded",
  "succeeded_with_failures"
]);
const CLAIMABLE_JOB_STATUSES = new Set<RevitBatchJobStatus>(["queued", "running", "pausing", "cancelling"]);

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

function writeJsonFile(filePath: string, value: unknown): void {
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2) + "\n", "utf8");
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
  fs.writeFileSync(jobManifestPath(job.id), rows.join("\n") + "\n", "utf8");
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
  const counts = summarizeItems(job.items);
  const hasRunning = counts.running > 0;
  const hasPending = counts.pending > 0;
  if (hasRunning || hasPending) return job;

  let status: RevitBatchJobStatus = "succeeded";
  if (job.cancel_requested || job.status === "cancelling") status = "cancelled";
  else if (job.pause_requested || job.status === "pausing") status = "paused";
  else if (counts.failed > 0 && counts.succeeded > 0) status = "succeeded_with_failures";
  else if (counts.failed > 0) status = "failed";

  return saveJob({
    ...job,
    status,
    finished_at: status === "paused" ? null : nowIso(),
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

function requeueExpiredClaims(job: RevitBatchJobRecord): RevitBatchJobRecord {
  const now = Date.now();
  let changed = false;
  const items = job.items.map((item) => {
    const leaseExpiresAt = `${item.claim?.lease_expires_at || ""}`.trim();
    const expiresAt = leaseExpiresAt ? Date.parse(leaseExpiresAt) : NaN;
    if (item.status !== "running" || !Number.isFinite(expiresAt) || expiresAt > now) return item;
    changed = true;
    return {
      ...item,
      status: "pending" as const,
      claim: null,
      error: clip(item.error || "Previous claim expired and the item was re-queued.", 500)
    };
  });
  if (!changed) return job;
  return saveJob({
    ...job,
    status: job.status === "running" ? "queued" : job.status,
    items
  });
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

export function createRevitBatchJob(input: CreateRevitBatchJobInput): JsonMap {
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

export function listRevitBatchJobs(limit = 20): JsonMap[] {
  return listJobRecords(limit).map((job) => toPublicJob(requeueExpiredClaims(job), false));
}

export function getRevitBatchJob(jobId: string): JsonMap | null {
  const job = readJob(jobId);
  if (!job) return null;
  return toPublicJob(requeueExpiredClaims(job), true);
}

function mutateJob(jobId: string, mutator: (current: RevitBatchJobRecord) => RevitBatchJobRecord): RevitBatchJobRecord {
  const current = readJob(jobId);
  if (!current) throw new Error("Batch job not found.");
  return mutator(requeueExpiredClaims(current));
}

export function approveRevitBatchJob(jobId: string): JsonMap {
  const saved = mutateJob(jobId, (current) => {
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

export function pauseRevitBatchJob(jobId: string): JsonMap {
  const saved = mutateJob(jobId, (current) => {
    if (current.status === "queued") {
      return appendEvent(saveJob({ ...current, status: "paused" }), "paused", `Paused batch job '${current.title}'.`);
    }
    if (current.status !== "running") throw new Error("Only queued or running jobs can be paused.");
    return appendEvent(saveJob({ ...current, status: "pausing", pause_requested: true }), "pause_requested", `Pause requested for '${current.title}'.`);
  });
  return toPublicJob(saved);
}

export function resumeRevitBatchJob(jobId: string): JsonMap {
  const saved = mutateJob(jobId, (current) => {
    if (current.status !== "paused") throw new Error("Only paused jobs can be resumed.");
    return appendEvent(saveJob({
      ...current,
      status: "queued",
      pause_requested: false,
      error: null
    }), "resumed", `Resumed batch job '${current.title}'.`);
  });
  return toPublicJob(saved);
}

export function cancelRevitBatchJob(jobId: string): JsonMap {
  const saved = mutateJob(jobId, (current) => {
    if (TERMINAL_JOB_STATUSES.has(current.status)) throw new Error("This batch job is already finished.");
    const next =
      current.status === "running" || current.status === "pausing"
        ? saveJob({ ...current, status: "cancelling", cancel_requested: true })
        : saveJob({ ...current, status: "cancelled", finished_at: nowIso(), cancel_requested: true });
    return appendEvent(next, "cancel_requested", `Cancel requested for batch job '${current.title}'.`);
  });
  return toPublicJob(saved);
}

export function retryFailedRevitBatchItems(jobId: string): JsonMap {
  const saved = mutateJob(jobId, (current) => {
    const failedCount = current.items.filter((item) => item.status === "failed").length;
    if (failedCount <= 0) throw new Error("This batch job has no failed items to retry.");
    const reset = current.items.map((item) =>
      item.status === "failed"
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

  const jobRecords = requestedJobId ? [readJob(requestedJobId)].filter((job): job is RevitBatchJobRecord => !!job) : listJobRecords(200);
  for (const rawJob of jobRecords) {
    let job = requeueExpiredClaims(rawJob);
    if (!CLAIMABLE_JOB_STATUSES.has(job.status)) continue;
    if (job.executor_kind && job.executor_kind !== executorKind) continue;
    const nextItem = job.items.find((item) => item.status === "pending");
    if (!nextItem) {
      job = finalizeJobIfComplete(job);
      continue;
    }
    const claim = {
      executor_id: executorId,
      executor_kind: executorKind,
      claimed_at: nowIso(),
      lease_expires_at: new Date(Date.now() + leaseDurationMs()).toISOString()
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
                error: "",
                claim
              }
            : item
        )
      }),
      "claim",
      `Claimed item ${nextItem.index} in '${job.title}' for ${executorId}.`
    );
    const claimedItem = claimedJob.items.find((item) => item.id === nextItem.id) || nextItem;
    return {
      ok: true,
      job: toPublicJob(claimedJob),
      item: claimedItem
    };
  }
  return { ok: true, job: null, item: null };
}

function applyResultPatch(item: RevitBatchJobItem, result: unknown): RevitBatchJobItem {
  if (!result || typeof result !== "object" || Array.isArray(result)) return item;
  const source = result as JsonMap;
  const patched: RevitBatchJobItem = { ...item };
  for (const [key, value] of Object.entries(source)) {
    if (key === "status" || key === "claim") continue;
    patched[key] = value;
  }
  return patched;
}

function settleClaim(jobId: string, itemId: string, executorId: string, failed: boolean, payload: { error?: string; result?: unknown }): JsonMap {
  const current = readJob(jobId);
  if (!current) throw new Error("Batch job not found.");
  const job = requeueExpiredClaims(current);
  const target = job.items.find((item) => item.id === itemId);
  if (!target) throw new Error("Batch item not found.");
  if (`${target.claim?.executor_id || ""}`.trim() !== executorId.trim()) {
    throw new Error("Batch item is not claimed by this executor.");
  }
  const nextItems = job.items.map((item) => {
    if (item.id !== itemId) return item;
    const patched = applyResultPatch(item, payload.result);
    return {
      ...patched,
      status: (failed ? "failed" : "succeeded") as "failed" | "succeeded",
      finished_at: nowIso(),
      claim: null,
      error: failed ? clip(payload.error, 500) || "Batch item failed." : ""
    };
  });
  let next = saveJob({
    ...job,
    status: job.status === "cancelling" || job.status === "pausing" ? job.status : "running",
    items: nextItems
  });
  next = appendEvent(
    next,
    failed ? "item_failed" : "item_succeeded",
    `${failed ? "Failed" : "Completed"} item ${target.index} in '${job.title}'.`
  );
  next = finalizeJobIfComplete(next);
  return {
    ok: true,
    job: toPublicJob(next),
    item: next.items.find((item) => item.id === itemId) || null
  };
}

export function completeRevitBatchItem(input: CompleteRevitBatchItemInput): JsonMap {
  return settleClaim(input.job_id, input.item_id, input.executor_id, false, { result: input.result });
}

export function failRevitBatchItem(input: FailRevitBatchItemInput): JsonMap {
  return settleClaim(input.job_id, input.item_id, input.executor_id, true, { error: input.error, result: input.result });
}
