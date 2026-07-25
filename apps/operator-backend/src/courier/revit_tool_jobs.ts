import fs from "node:fs";
import path from "node:path";
import { ensureWorkspaceLayout } from "../workspace.js";

export const REVIT_COURIER_JOB_VERSION = "revit-operator.revit-tool-job.v1";
export const REVIT_COURIER_RESULT_VERSION = "revit-operator.revit-tool-result.v1";

export type RevitToolJob = {
  version: typeof REVIT_COURIER_JOB_VERSION;
  id: string;
  session_id: string;
  message_id?: string | null;
  correlation_id: string;
  idempotency_key: string;
  method: "GET" | "POST";
  path: string;
  body?: unknown;
  created_at: string;
  expires_at: string;
  status: "pending" | "running" | "succeeded" | "failed";
  claim?: {
    executor_id: string;
    claimed_at: string;
    lease_expires_at: string;
  } | null;
  finished_at?: string | null;
  error?: string | null;
};

type ClaimInput = {
  session_id?: string | null;
  executor_id: string;
  session_allowed?: (sessionId: string) => boolean;
};
type FinishInput = { session_id: string; job_id: string; executor_id: string; result?: unknown; error?: string; retryable?: boolean };

function jobsRoot(): string {
  const root = path.join(ensureWorkspaceLayout().artifacts, "revit-courier", "jobs");
  fs.mkdirSync(root, { recursive: true });
  return root;
}

function safeId(value: unknown, field: string, max = 200): string {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text || text.length > max || !/^[a-zA-Z0-9._:-]+$/.test(text)) throw new Error(`${field} is invalid.`);
  return text;
}

function jobDir(jobId: string): string {
  return path.join(jobsRoot(), safeId(jobId, "job_id"));
}

function jobPath(jobId: string): string {
  return path.join(jobDir(jobId), "job.json");
}

function resultPath(jobId: string): string {
  return path.join(jobDir(jobId), "result.json");
}

function readJson<T>(filePath: string): T | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as T : null;
  } catch {
    return null;
  }
}

function writeJsonAtomic(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temp = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  fs.renameSync(temp, filePath);
}

function readJob(jobId: string): RevitToolJob | null {
  const job = readJson<RevitToolJob>(jobPath(jobId));
  if (!job || job.version !== REVIT_COURIER_JOB_VERSION || job.id !== jobId) return null;
  return job;
}

function saveJob(job: RevitToolJob): RevitToolJob {
  writeJsonAtomic(jobPath(job.id), job);
  return job;
}

function writeTerminal(job: RevitToolJob, terminal: { status: "succeeded" | "failed"; result?: unknown; error?: string; retryable?: boolean; code?: string }): RevitToolJob {
  const finishedAt = new Date().toISOString();
  const next = saveJob({
    ...job,
    status: terminal.status,
    finished_at: finishedAt,
    error: terminal.error ?? null
  });
  writeJsonAtomic(resultPath(job.id), {
    version: REVIT_COURIER_RESULT_VERSION,
    id: job.id,
    correlation_id: job.correlation_id,
    status: terminal.status,
    finished_at: finishedAt,
    result: terminal.result ?? null,
    error: terminal.error ?? null,
    code: terminal.code ?? null,
    retryable: terminal.retryable ?? false
  });
  return next;
}

function leaseDurationMs(): number {
  const parsed = Number.parseInt(process.env.OPERATOR_REVIT_COURIER_LEASE_MS ?? "", 10);
  return Number.isFinite(parsed) ? Math.max(30_000, Math.min(10 * 60_000, parsed)) : 4 * 60_000;
}

function enumerateJobIds(): string[] {
  try {
    return fs.readdirSync(jobsRoot(), { withFileTypes: true })
      .filter(entry => entry.isDirectory() && /^[a-zA-Z0-9._:-]+$/.test(entry.name))
      .map(entry => entry.name);
  } catch {
    return [];
  }
}

export function claimNextRevitToolJob(input: ClaimInput): { job: RevitToolJob | null } {
  const sessionId = input.session_id == null || `${input.session_id}`.trim() === ""
    ? null
    : safeId(input.session_id, "session_id");
  const executorId = safeId(input.executor_id, "executor_id");
  const now = Date.now();
  const candidates = enumerateJobIds()
    .map(id => readJob(id))
    .filter((job): job is RevitToolJob => !!job &&
      (sessionId === null || job.session_id === sessionId) &&
      (input.session_allowed?.(job.session_id) ?? true))
    .sort((a, b) => `${a.created_at}|${a.id}`.localeCompare(`${b.created_at}|${b.id}`));

  for (const job of candidates) {
    if (job.status === "running") {
      const leaseExpires = Date.parse(job.claim?.lease_expires_at ?? "");
      if (Number.isFinite(leaseExpires) && leaseExpires <= now && !fs.existsSync(resultPath(job.id))) {
        writeTerminal(job, {
          status: "failed",
          error: "The workstation execution lease expired; outcome is unknown and the call was not retried automatically.",
          code: "execution_lease_expired_outcome_unknown",
          retryable: false
        });
      }
      continue;
    }
    if (job.status !== "pending") continue;
    const expiresAt = Date.parse(job.expires_at);
    if (!Number.isFinite(expiresAt) || expiresAt <= now) {
      writeTerminal(job, {
        status: "failed",
        error: "The Revit courier job expired before a workstation claimed it.",
        code: "courier_job_expired_before_claim",
        retryable: true
      });
      continue;
    }

    const claimedAt = new Date().toISOString();
    const leaseExpiresAt = new Date(Math.min(expiresAt, now + leaseDurationMs())).toISOString();
    return {
      job: saveJob({
        ...job,
        status: "running",
        claim: { executor_id: executorId, claimed_at: claimedAt, lease_expires_at: leaseExpiresAt }
      })
    };
  }
  return { job: null };
}

function requireClaimedJob(input: FinishInput): RevitToolJob {
  const sessionId = safeId(input.session_id, "session_id");
  const jobId = safeId(input.job_id, "job_id");
  const executorId = safeId(input.executor_id, "executor_id");
  const job = readJob(jobId);
  if (!job) throw new Error("Revit courier job was not found.");
  if (job.session_id !== sessionId) throw new Error("Revit courier session mismatch.");
  if (job.status === "succeeded" || job.status === "failed") return job;
  if (job.status !== "running" || job.claim?.executor_id !== executorId) throw new Error("Revit courier job is not claimed by this executor.");
  return job;
}

export function completeRevitToolJob(input: FinishInput): RevitToolJob {
  const job = requireClaimedJob(input);
  if (job.status === "succeeded" || job.status === "failed") return job;
  return writeTerminal(job, { status: "succeeded", result: input.result, retryable: false });
}

export function failRevitToolJob(input: FinishInput): RevitToolJob {
  const job = requireClaimedJob(input);
  if (job.status === "succeeded" || job.status === "failed") return job;
  const error = typeof input.error === "string" && input.error.trim() ? input.error.trim().slice(0, 4000) : "Revit courier execution failed.";
  return writeTerminal(job, { status: "failed", result: input.result, error, retryable: input.retryable === true });
}
