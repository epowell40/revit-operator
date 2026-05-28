import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { ensureWorkspaceLayout } from "../workspace.js";

type JsonMap = Record<string, unknown>;

export type OperatorTaskStatus =
  | "planning"
  | "awaiting_approval"
  | "queued"
  | "running"
  | "paused"
  | "cancelled"
  | "failed"
  | "succeeded"
  | "succeeded_with_failures";

export type OperatorTaskVerificationStatus =
  | "not_required"
  | "required"
  | "pending"
  | "passed"
  | "failed"
  | "waived";

export type OperatorTaskProgress = {
  total: number;
  pending: number;
  running: number;
  succeeded: number;
  failed: number;
  skipped: number;
};

export type OperatorTaskVerification = {
  required: boolean;
  status: OperatorTaskVerificationStatus;
  checklist: string[];
  success_signals: string[];
  evidence_paths: string[];
  notes?: string[];
  updated_at: string;
};

export type OperatorTaskSkillUsage = {
  recorded_at: string;
  source: string;
  session_id?: string | null;
  message_id?: string | null;
  query_text?: string | null;
  skills: Array<{
    skill_id: string;
    skill_name?: string;
    score?: number | null;
    source_path?: string | null;
    metadata_path?: string | null;
  }>;
};

export type OperatorTaskRecord = {
  id: string;
  task_type: string;
  title: string;
  status: OperatorTaskStatus;
  created_at: string;
  updated_at: string;
  started_at?: string | null;
  finished_at?: string | null;
  frontend?: string | null;
  executor_kind?: string | null;
  source: JsonMap;
  plan: JsonMap;
  progress: OperatorTaskProgress;
  verification: OperatorTaskVerification;
  evidence: {
    artifact_paths: string[];
    output_paths: string[];
    notes: string[];
  };
  artifacts: {
    workspace_paths: string[];
  };
  skill_usage: OperatorTaskSkillUsage[];
  related: JsonMap;
  events: Array<{ ts: string; kind: string; text: string }>;
  result: JsonMap;
  error?: string | null;
};

type RevitBatchLike = {
  id?: string;
  task_id?: string;
  job_type?: string;
  title?: string;
  status?: string;
  created_at?: string;
  updated_at?: string;
  started_at?: string | null;
  finished_at?: string | null;
  executor_kind?: string;
  source?: JsonMap;
  params?: JsonMap;
  approval?: JsonMap;
  preview_items?: unknown[];
  items?: Array<Record<string, unknown>>;
  result?: JsonMap;
  error?: string | null;
  output_folder_relative?: string;
  events?: Array<{ ts: string; kind: string; text: string }>;
};

type TeachSkillRegistrationInput = {
  skill_id?: unknown;
  skill_name?: unknown;
  generated_at?: unknown;
  frontend?: unknown;
  session_id?: unknown;
  analysis?: unknown;
  batch_template?: unknown;
  provenance?: unknown;
  local_paths?: unknown;
  task_id?: unknown;
};

type TeachSkillUsageInput = {
  session_id?: unknown;
  message_id?: unknown;
  frontend?: unknown;
  source?: unknown;
  query_text?: unknown;
  skill_matches?: unknown;
};

function nowIso(): string {
  return new Date().toISOString();
}

function ensureDir(dirPath: string): string {
  fs.mkdirSync(dirPath, { recursive: true });
  return dirPath;
}

function writeJson(filePath: string, value: unknown): void {
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2) + "\n", "utf8");
}

function readJson<T>(filePath: string): T | null {
  try {
    if (!fs.existsSync(filePath)) return null;
    return JSON.parse(fs.readFileSync(filePath, "utf8")) as T;
  } catch {
    return null;
  }
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

function asStringList(value: unknown, maxItems = 24, maxLength = 400): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const item of asArray(value)) {
    const text = clip(item, maxLength);
    if (!text) continue;
    const key = text.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(text);
    if (out.length >= maxItems) break;
  }
  return out;
}

function tasksRoot(): string {
  return ensureDir(path.join(ensureWorkspaceLayout().artifacts, "tasks"));
}

function taskDir(taskId: string): string {
  return path.join(tasksRoot(), taskId);
}

function taskPath(taskId: string): string {
  return path.join(taskDir(taskId), "task.json");
}

function taskSummaryPath(taskId: string): string {
  return path.join(taskDir(taskId), "summary.json");
}

function teachSkillsRoot(): string {
  return ensureDir(path.join(ensureWorkspaceLayout().artifacts, "teach-skills"));
}

function teachSkillPackageDir(skillId: string): string {
  return ensureDir(path.join(teachSkillsRoot(), "packages", skillId));
}

function teachSkillUsageLogPath(): string {
  return path.join(teachSkillsRoot(), "usage_log.jsonl");
}

function progressSummary(items: Array<Record<string, unknown>>): OperatorTaskProgress {
  const summary: OperatorTaskProgress = {
    total: 0,
    pending: 0,
    running: 0,
    succeeded: 0,
    failed: 0,
    skipped: 0
  };
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

function normalizeTaskStatus(value: unknown): OperatorTaskStatus {
  const status = `${value || ""}`.trim().toLowerCase();
  if (status === "awaiting_approval") return "awaiting_approval";
  if (status === "queued") return "queued";
  if (status === "running") return "running";
  if (status === "paused" || status === "pausing") return "paused";
  if (status === "cancelled" || status === "cancelling") return "cancelled";
  if (status === "failed") return "failed";
  if (status === "succeeded_with_failures") return "succeeded_with_failures";
  if (status === "succeeded") return "succeeded";
  return "planning";
}

function summarizeVerificationStatus(taskStatus: OperatorTaskStatus, required: boolean, evidencePaths: string[]): OperatorTaskVerificationStatus {
  if (!required) return "not_required";
  if (taskStatus === "failed" || taskStatus === "cancelled") return "failed";
  if (taskStatus === "succeeded" || taskStatus === "succeeded_with_failures") {
    return evidencePaths.length > 0 ? "passed" : "pending";
  }
  if (taskStatus === "awaiting_approval") return "required";
  return "pending";
}

function relativeWorkspacePathMaybe(fullOrRelative: unknown): string {
  const text = clip(fullOrRelative, 600);
  if (!text) return "";
  const workspaceRoot = path.resolve(ensureWorkspaceLayout().root);
  const candidate = path.resolve(text);
  const prefix = workspaceRoot.endsWith(path.sep) ? workspaceRoot : `${workspaceRoot}${path.sep}`;
  if (candidate === workspaceRoot || candidate.startsWith(prefix)) {
    return path.relative(workspaceRoot, candidate).replace(/\\/g, "/");
  }
  return text.replace(/\\/g, "/");
}

function toPublicTask(task: OperatorTaskRecord): JsonMap {
  return {
    id: task.id,
    task_type: task.task_type,
    title: task.title,
    status: task.status,
    created_at: task.created_at,
    updated_at: task.updated_at,
    started_at: task.started_at || null,
    finished_at: task.finished_at || null,
    frontend: task.frontend || null,
    executor_kind: task.executor_kind || null,
    source: task.source,
    plan: task.plan,
    progress: task.progress,
    verification: task.verification,
    evidence: task.evidence,
    artifacts: task.artifacts,
    related: task.related,
    result: task.result,
    error: task.error || null,
    events: task.events.slice(-60),
    skill_usage: task.skill_usage.slice(-20)
  };
}

function readTaskRecord(taskId: string): OperatorTaskRecord | null {
  return readJson<OperatorTaskRecord>(taskPath(taskId));
}

function saveTaskRecord(task: OperatorTaskRecord): OperatorTaskRecord {
  const next: OperatorTaskRecord = {
    ...task,
    updated_at: nowIso(),
    events: Array.isArray(task.events) ? task.events.slice(-200) : [],
    skill_usage: Array.isArray(task.skill_usage) ? task.skill_usage.slice(-100) : []
  };
  writeJson(taskPath(task.id), next);
  writeJson(taskSummaryPath(task.id), toPublicTask(next));
  return next;
}

function buildTaskRecord(input: Partial<OperatorTaskRecord> & Pick<OperatorTaskRecord, "id" | "task_type" | "title">): OperatorTaskRecord {
  const now = nowIso();
  return {
    id: input.id,
    task_type: input.task_type,
    title: clip(input.title, 160) || "Operator task",
    status: normalizeTaskStatus(input.status),
    created_at: input.created_at || now,
    updated_at: input.updated_at || now,
    started_at: input.started_at || null,
    finished_at: input.finished_at || null,
    frontend: clip(input.frontend, 80) || null,
    executor_kind: clip(input.executor_kind, 120) || null,
    source: asObject(input.source),
    plan: asObject(input.plan),
    progress: input.progress || { total: 0, pending: 0, running: 0, succeeded: 0, failed: 0, skipped: 0 },
    verification: input.verification || {
      required: false,
      status: "not_required",
      checklist: [],
      success_signals: [],
      evidence_paths: [],
      notes: [],
      updated_at: now
    },
    evidence: input.evidence || { artifact_paths: [], output_paths: [], notes: [] },
    artifacts: input.artifacts || { workspace_paths: [] },
    skill_usage: Array.isArray(input.skill_usage) ? input.skill_usage : [],
    related: asObject(input.related),
    events: Array.isArray(input.events) ? input.events : [],
    result: asObject(input.result),
    error: clip(input.error, 500) || null
  };
}

function upsertTask(task: Partial<OperatorTaskRecord> & Pick<OperatorTaskRecord, "id" | "task_type" | "title">): OperatorTaskRecord {
  const existing = readTaskRecord(task.id);
  const merged = buildTaskRecord({
    ...(existing || {}),
    ...task,
    source: { ...(existing?.source || {}), ...asObject(task.source) },
    plan: { ...(existing?.plan || {}), ...asObject(task.plan) },
    related: { ...(existing?.related || {}), ...asObject(task.related) },
    result: { ...(existing?.result || {}), ...asObject(task.result) },
    evidence: task.evidence || existing?.evidence,
    artifacts: task.artifacts || existing?.artifacts,
    progress: task.progress || existing?.progress,
    verification: task.verification || existing?.verification,
    events: Array.isArray(task.events) ? task.events : existing?.events,
    skill_usage: Array.isArray(task.skill_usage) ? task.skill_usage : existing?.skill_usage
  });
  return saveTaskRecord(merged);
}

export function listOperatorTasks(limit = 20): JsonMap[] {
  return fs
    .readdirSync(tasksRoot(), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => readTaskRecord(entry.name))
    .filter((entry): entry is OperatorTaskRecord => !!entry)
    .sort((a, b) => `${b.updated_at}|${b.id}`.localeCompare(`${a.updated_at}|${a.id}`))
    .slice(0, Math.max(1, limit))
    .map((entry) => toPublicTask(entry));
}

export function getOperatorTask(taskId: string): JsonMap | null {
  const task = readTaskRecord(taskId);
  return task ? toPublicTask(task) : null;
}

function deriveVerificationFromBatch(job: RevitBatchLike, progress: OperatorTaskProgress): OperatorTaskVerification {
  const checklist = asStringList(job?.params?.success_checks, 16);
  const successSignals = checklist.slice(0, 16);
  const evidencePaths = [
    relativeWorkspacePathMaybe(path.join(ensureWorkspaceLayout().artifacts, "revit-batch", "jobs", `${job?.id || ""}`, "summary.json")),
    relativeWorkspacePathMaybe(path.join(ensureWorkspaceLayout().artifacts, "revit-batch", "jobs", `${job?.id || ""}`, "manifest.csv")),
    relativeWorkspacePathMaybe(job?.output_folder_relative)
  ].filter(Boolean);
  const required =
    checklist.length > 0 ||
    successSignals.length > 0 ||
    progress.total > 1 ||
    `${job?.executor_kind || ""}`.toLowerCase().includes("revit");

  return {
    required,
    status: summarizeVerificationStatus(normalizeTaskStatus(job?.status), required, evidencePaths),
    checklist,
    success_signals: successSignals,
    evidence_paths: evidencePaths,
    notes:
      required && evidencePaths.length === 0
        ? ["Verification is required for this task, but no evidence paths have been recorded yet."]
        : [],
    updated_at: nowIso()
  };
}

export function syncTaskFromRevitBatchJob(job: RevitBatchLike): JsonMap {
  const jobId = clip(job?.id, 120);
  if (!jobId) throw new Error("Cannot sync a batch job without an id.");
  const taskId = clip(job?.task_id, 120) || `task_${jobId}`;
  const items = asArray<Record<string, unknown>>(job?.items);
  const progress = progressSummary(items);
  const taskStatus = normalizeTaskStatus(job?.status);
  const artifactPaths = [
    relativeWorkspacePathMaybe(path.join(ensureWorkspaceLayout().artifacts, "revit-batch", "jobs", jobId, "job.json")),
    relativeWorkspacePathMaybe(path.join(ensureWorkspaceLayout().artifacts, "revit-batch", "jobs", jobId, "summary.json")),
    relativeWorkspacePathMaybe(path.join(ensureWorkspaceLayout().artifacts, "revit-batch", "jobs", jobId, "manifest.csv"))
  ].filter(Boolean);
  const outputPaths = [relativeWorkspacePathMaybe(job?.output_folder_relative)].filter(Boolean);
  const verification = deriveVerificationFromBatch(job, progress);
  const saved = upsertTask({
    id: taskId,
    task_type: `${job?.job_type || "revit_batch"}`.trim() || "revit_batch",
    title: clip(job?.title, 160) || "Revit batch task",
    status: taskStatus,
    created_at: clip(job?.created_at, 80) || nowIso(),
    started_at: clip(job?.started_at, 80) || null,
    finished_at: clip(job?.finished_at, 80) || null,
    frontend: clip(job?.source?.frontend, 80) || "backend",
    executor_kind: clip(job?.executor_kind, 120) || "revit_delegate",
    source: {
      backend_surface: "revit_batch",
      batch_job_id: jobId,
      session_id: clip(job?.source?.session_id, 120) || null,
      frontend: clip(job?.source?.frontend, 80) || null
    },
    plan: {
      params: asObject(job?.params),
      approval: asObject(job?.approval),
      preview_items: asArray(job?.preview_items).slice(0, 12)
    },
    progress,
    verification,
    evidence: {
      artifact_paths: artifactPaths,
      output_paths: outputPaths,
      notes: asStringList(job?.result?.planning_warnings, 12, 240)
    },
    artifacts: {
      workspace_paths: [...artifactPaths, ...outputPaths]
    },
    related: {
      batch_job_id: jobId
    },
    result: {
      ...(asObject(job?.result) || {}),
      item_summary: progress
    },
    events: Array.isArray(job?.events) ? job.events.slice(-120) : [],
    error: clip(job?.error, 500) || null
  });
  return toPublicTask(saved);
}

function appendJsonl(filePath: string, line: unknown): void {
  ensureDir(path.dirname(filePath));
  fs.appendFileSync(filePath, JSON.stringify(line) + "\n", "utf8");
}

function teachSkillPackageVersionPath(skillId: string, stamp: string): string {
  return path.join(teachSkillPackageDir(skillId), `${stamp}.json`);
}

function teachSkillLatestPath(skillId: string): string {
  return path.join(teachSkillPackageDir(skillId), "latest.json");
}

function sanitizeTeachSkillMatch(raw: unknown): {
  skill_id: string;
  skill_name?: string;
  score?: number | null;
  source_path?: string | null;
  metadata_path?: string | null;
} | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const source = raw as JsonMap;
  const skillId = clip(source.skill_id ?? source.skillId, 120);
  if (!skillId) return null;
  const scoreRaw =
    typeof source.score === "number"
      ? source.score
      : typeof source.score === "string"
        ? Number.parseFloat(source.score)
        : NaN;
  return {
    skill_id: skillId,
    skill_name: clip(source.skill_name ?? source.skillName, 160) || undefined,
    score: Number.isFinite(scoreRaw) ? scoreRaw : null,
    source_path: clip(source.file_path ?? source.filePath, 600) || null,
    metadata_path: clip(source.metadata_path ?? source.metadataPath, 600) || null
  };
}

export function registerTeachSkillPackage(input: TeachSkillRegistrationInput): JsonMap {
  const analysis = asObject(input.analysis);
  const provenance = asObject(input.provenance);
  const skillId =
    clip(input.skill_id ?? analysis.skill_id, 120) ||
    clip(analysis.skill_name ?? analysis.title, 120).toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "") ||
    `teach_skill_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
  const generatedAt = clip(input.generated_at, 80) || nowIso();
  const taskId = clip(input.task_id, 120) || `teach_${skillId}`;
  const pkg = {
    schema_version: 2,
    generated_at: generatedAt,
    skill_id: skillId,
    skill_name: clip(input.skill_name ?? analysis.skill_name ?? analysis.title, 160) || skillId,
    frontend: clip(input.frontend, 80) || "operator-desktop",
    session_id: clip(input.session_id, 120) || null,
    analysis,
    batch_template: input.batch_template && typeof input.batch_template === "object" ? input.batch_template : null,
    provenance,
    local_paths: input.local_paths && typeof input.local_paths === "object" ? input.local_paths : {}
  };
  const stamp = generatedAt.replace(/[:.]/g, "-");
  writeJson(teachSkillLatestPath(skillId), pkg);
  writeJson(teachSkillPackageVersionPath(skillId, stamp), pkg);

  const checklist = asStringList(analysis.verification_checklist, 16);
  const successSignals = asStringList(analysis.success_signals, 16);
  const evidencePaths = [
    relativeWorkspacePathMaybe(teachSkillLatestPath(skillId)),
    relativeWorkspacePathMaybe(provenance.session_dir),
    relativeWorkspacePathMaybe(provenance.analysis_path),
    relativeWorkspacePathMaybe(provenance.brief_path),
    relativeWorkspacePathMaybe(provenance.event_log_path),
    relativeWorkspacePathMaybe(provenance.live_review_path)
  ].filter(Boolean);

  const task = upsertTask({
    id: taskId,
    task_type: "teach_skill_package",
    title: clip(pkg.skill_name, 160) || skillId,
    status: "succeeded",
    created_at: generatedAt,
    started_at: generatedAt,
    finished_at: generatedAt,
    frontend: clip(input.frontend, 80) || "operator-desktop",
    executor_kind: "teach_mode",
    source: {
      backend_surface: "teach_skill_package",
      session_id: pkg.session_id,
      skill_id: skillId
    },
    plan: {
      analysis,
      batch_template: pkg.batch_template
    },
    progress: {
      total: 1,
      pending: 0,
      running: 0,
      succeeded: 1,
      failed: 0,
      skipped: 0
    },
    verification: {
      required: checklist.length > 0 || successSignals.length > 0,
      status: checklist.length > 0 || successSignals.length > 0 ? "passed" : "not_required",
      checklist,
      success_signals: successSignals,
      evidence_paths: evidencePaths,
      notes: [],
      updated_at: nowIso()
    },
    evidence: {
      artifact_paths: evidencePaths,
      output_paths: [relativeWorkspacePathMaybe(teachSkillLatestPath(skillId))].filter(Boolean),
      notes: asStringList(analysis.risks, 8, 240)
    },
    artifacts: {
      workspace_paths: evidencePaths
    },
    related: {
      skill_id: skillId
    },
    result: {
      skill_summary: clip(analysis.skill_summary ?? analysis.summary, 1200),
      execution_strategy: clip(analysis.execution_strategy, 400),
      example_requests: asStringList(analysis.example_requests, 8, 240),
      eval_examples: asArray(analysis.eval_examples).slice(0, 8)
    },
    events: [
      {
        ts: nowIso(),
        kind: "teach_skill_registered",
        text: `Registered Teach skill package '${clip(pkg.skill_name, 120) || skillId}'.`
      }
    ]
  });

  return {
    ok: true,
    skill_id: skillId,
    task_id: task.id,
    package_path: relativeWorkspacePathMaybe(teachSkillLatestPath(skillId)),
    task: toPublicTask(task)
  };
}

export function logTeachSkillUsage(input: TeachSkillUsageInput): JsonMap {
  const sessionId = clip(input.session_id, 120) || null;
  const messageId = clip(input.message_id, 120) || null;
  const frontend = clip(input.frontend, 80) || "operator-desktop";
  const source = clip(input.source, 80) || "chat_request";
  const queryText = clip(input.query_text, 1600) || null;
  const skills = asArray(input.skill_matches)
    .map((item) => sanitizeTeachSkillMatch(item))
    .filter((item): item is NonNullable<ReturnType<typeof sanitizeTeachSkillMatch>> => !!item);
  if (skills.length === 0) throw new Error("No teach skill matches were provided.");

  const entry: OperatorTaskSkillUsage = {
    recorded_at: nowIso(),
    source,
    session_id: sessionId,
    message_id: messageId,
    query_text: queryText,
    skills
  };
  appendJsonl(teachSkillUsageLogPath(), entry);

  for (const skill of skills) {
    const task = readTaskRecord(`teach_${skill.skill_id}`);
    if (!task) continue;
    saveTaskRecord({
      ...task,
      skill_usage: [...task.skill_usage, entry],
      events: [
        ...task.events,
        {
          ts: nowIso(),
          kind: "teach_skill_used",
          text: `Matched for ${source}${queryText ? `: ${clip(queryText, 140)}` : "."}`
        }
      ]
    });
  }

  return {
    ok: true,
    recorded_at: entry.recorded_at,
    count: skills.length
  };
}
