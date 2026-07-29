import fs from "node:fs";
import path from "node:path";
import {
  REVIT_COURIER_V2_JOB_VERSION,
  RevitCourierCertificationError,
  authorizeCertifiedCourierFinalExecution,
  isRevitCourierDevelopmentLaboratory,
  parseCertifiedCourierJobV2,
  type CertifiedCourierFinalAuthorization,
  type CertifiedCourierJobV2
} from "./revit_tool_job_certification.js";
import { ensureWorkspaceLayout } from "../workspace.js";

export const REVIT_COURIER_JOB_VERSION = "revit-operator.revit-tool-job.v1";
export const REVIT_COURIER_RESULT_VERSION = "revit-operator.revit-tool-result.v1";

export type RevitToolJobV1 = {
  version: typeof REVIT_COURIER_JOB_VERSION;
  id: string;
  session_id: string;
  message_id?: string | null;
  turn_token?: string | null;
  correlation_id: string;
  idempotency_key: string;
  method: "GET" | "POST";
  path: string;
  target_executor_id?: string | null;
  target_document_title?: string | null;
  target_document_path?: string | null;
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

export type RevitToolJob = RevitToolJobV1 | CertifiedCourierJobV2;

type RevitToolResult = {
  version: typeof REVIT_COURIER_RESULT_VERSION;
  id: string;
  correlation_id: string;
  status: "succeeded" | "failed";
  finished_at: string;
  result?: unknown;
  error?: string | null;
  code?: string | null;
  retryable?: boolean;
  phase?: string | null;
  outcome_unknown?: boolean;
};

type ClaimInput = {
  session_id?: string | null;
  executor_id: string;
  session_allowed?: (sessionId: string) => boolean;
};
type FinishInput = { session_id: string; job_id: string; executor_id: string; result?: unknown; error?: string; retryable?: boolean };
type AuthorizeInput = { session_id: string; job_id: string; executor_id: string };

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

/** Session/executor identities are producer-provided Unicode text, not ASCII ids. */
function safeContextIdentity(value: unknown, field: string, max = 200): string {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text || text.length > max || /[\u0000-\u001F\u007F]/.test(text)) throw new Error(`${field} is invalid.`);
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
  // Keep an unknown persisted version visible to the claimant so it can be
  // terminally quarantined. Silently ignoring it would leave an executable
  // durable record that might be accepted by a future worker.
  if (!job || job.id !== jobId) return null;
  return job;
}

function saveJob(job: RevitToolJob): RevitToolJob {
  writeJsonAtomic(jobPath(job.id), job);
  return job;
}

function readTerminalResult(job: RevitToolJob): RevitToolResult | null {
  const result = readJson<RevitToolResult>(resultPath(job.id));
  if (!result || result.version !== REVIT_COURIER_RESULT_VERSION || result.id !== job.id || result.correlation_id !== job.correlation_id) return null;
  if (result.status !== "succeeded" && result.status !== "failed") return null;
  return result;
}

function reconcileJobWithResult(job: RevitToolJob, result: RevitToolResult): RevitToolJob {
  if (job.status === result.status && job.finished_at === result.finished_at && (job.error ?? null) === (result.error ?? null)) return job;
  return saveJob({
    ...job,
    status: result.status,
    finished_at: result.finished_at,
    error: result.error ?? null
  });
}

function writeTerminal(job: RevitToolJob, terminal: {
  status: "succeeded" | "failed";
  result?: unknown;
  error?: string;
  retryable?: boolean;
  code?: string;
  phase?: string;
  outcome_unknown?: boolean;
}): RevitToolJob {
  const finishedAt = new Date().toISOString();
  // The durable result is authoritative. Write it before the job summary so a crash can never expose a terminal job without its receipt.
  writeJsonAtomic(resultPath(job.id), {
    version: REVIT_COURIER_RESULT_VERSION,
    id: job.id,
    correlation_id: job.correlation_id,
    status: terminal.status,
    finished_at: finishedAt,
    result: terminal.result ?? null,
    error: terminal.error ?? null,
    code: terminal.code ?? null,
    retryable: terminal.retryable ?? false,
    phase: terminal.phase ?? null,
    outcome_unknown: terminal.outcome_unknown === true
  });
  return saveJob({
    ...job,
    status: terminal.status,
    finished_at: finishedAt,
    error: terminal.error ?? null
  });
}

function writeCertificationTerminal(job: RevitToolJob, error: RevitCourierCertificationError): RevitToolJob {
  const terminal = readTerminalResult(job);
  if (terminal) return reconcileJobWithResult(job, terminal);
  if (fs.existsSync(resultPath(job.id))) {
    return saveJob({
      ...job,
      status: "failed",
      finished_at: new Date().toISOString(),
      error: "The durable Revit courier result receipt is invalid or mismatched; the job was quarantined without replay."
    });
  }
  return writeTerminal(job, {
    status: "failed",
    error: error.message,
    code: error.code,
    retryable: false,
    phase: "certification_final_execution",
    outcome_unknown: false,
    result: {
      code: error.code,
      phase: "certification_final_execution",
      retryable: false,
      outcome_unknown: false
    }
  });
}

function validCertifiedJobForClaim(job: RevitToolJob): boolean {
  if (job.version === REVIT_COURIER_JOB_VERSION) return true;
  if (job.version !== REVIT_COURIER_V2_JOB_VERSION) {
    writeCertificationTerminal(job, new RevitCourierCertificationError(
      "CERTIFICATION_JOB_VERSION_UNSUPPORTED",
      "Revit courier job version is unsupported and was quarantined before workstation execution."
    ));
    return false;
  }
  try {
    parseCertifiedCourierJobV2(job);
    return true;
  } catch (error) {
    const certificationError = error instanceof RevitCourierCertificationError
      ? error
      : new RevitCourierCertificationError("CERTIFICATION_JOB_MALFORMED", "Certified courier job could not be validated.");
    writeCertificationTerminal(job, certificationError);
    return false;
  }
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
    : safeContextIdentity(input.session_id, "session_id");
  const executorId = safeContextIdentity(input.executor_id, "executor_id");
  const now = Date.now();
  const candidates = enumerateJobIds()
    .map(id => readJob(id))
    .filter((job): job is RevitToolJob => !!job &&
      (sessionId === null || job.session_id === sessionId) &&
      (!job.target_executor_id || job.target_executor_id === executorId) &&
      (input.session_allowed?.(job.session_id) ?? true))
    .sort((a, b) => `${a.created_at}|${a.id}`.localeCompare(`${b.created_at}|${b.id}`));

  for (const job of candidates) {
    const terminalResult = readTerminalResult(job);
    if (terminalResult) {
      reconcileJobWithResult(job, terminalResult);
      continue;
    }
    if (fs.existsSync(resultPath(job.id))) {
      saveJob({
        ...job,
        status: "failed",
        finished_at: new Date().toISOString(),
        error: "The durable Revit courier result receipt is invalid or mismatched; the job was quarantined without replay."
      });
      continue;
    }
    if (job.version === REVIT_COURIER_JOB_VERSION && !isRevitCourierDevelopmentLaboratory()) {
      writeCertificationTerminal(job, new RevitCourierCertificationError(
        "CERTIFICATION_LEGACY_V1_DENIED",
        "Legacy v1 Revit courier jobs are denied outside the explicit development laboratory profile."
      ));
      continue;
    }
    if (!validCertifiedJobForClaim(job)) continue;
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
  const sessionId = safeContextIdentity(input.session_id, "session_id");
  const jobId = safeId(input.job_id, "job_id");
  const executorId = safeContextIdentity(input.executor_id, "executor_id");
  const job = readJob(jobId);
  if (!job) throw new Error("Revit courier job was not found.");
  if (job.session_id !== sessionId) throw new Error("Revit courier session mismatch.");
  if (job.claim?.executor_id !== executorId) throw new Error("Revit courier job is not claimed by this executor.");
  const terminalResult = readTerminalResult(job);
  if (terminalResult) return reconcileJobWithResult(job, terminalResult);
  if (fs.existsSync(resultPath(job.id))) throw new Error("Revit courier result receipt is invalid or mismatched; refusing to overwrite or replay it.");
  if (job.status === "succeeded" || job.status === "failed") return job;
  if (job.status !== "running") throw new Error("Revit courier job is not claimed by this executor.");
  return job;
}

export function completeRevitToolJob(input: FinishInput): RevitToolJob {
  const job = requireClaimedJob(input);
  if (job.status === "failed") throw new Error("Revit courier job is already terminally failed; refusing a contradictory completion.");
  if (job.status === "succeeded" && readTerminalResult(job)) return job;
  return writeTerminal(job, { status: "succeeded", result: input.result, retryable: false });
}

export function failRevitToolJob(input: FinishInput): RevitToolJob {
  const job = requireClaimedJob(input);
  if (job.status === "succeeded") throw new Error("Revit courier job is already terminally succeeded; refusing a contradictory failure.");
  if (job.status === "failed" && readTerminalResult(job)) return job;
  const error = typeof input.error === "string" && input.error.trim() ? input.error.trim().slice(0, 4000) : "Revit courier execution failed.";
  const resultRecord = input.result && typeof input.result === "object" && !Array.isArray(input.result)
    ? input.result as Record<string, unknown>
    : null;
  const rawCode = typeof resultRecord?.code === "string" ? resultRecord.code.trim() : "";
  const code = /^[a-z0-9._:-]{1,160}$/i.test(rawCode) ? rawCode : undefined;
  return writeTerminal(job, { status: "failed", result: input.result, error, code, retryable: input.retryable === true });
}

/**
 * Re-reads a claimed durable v2 job immediately before the workstation calls
 * Revit. Certification denial writes an authoritative, non-retryable terminal
 * receipt so a restart or another worker can never re-claim the operation.
 */
export function authorizeRevitToolJobExecution(input: AuthorizeInput): { job: RevitToolJob; authorization: CertifiedCourierFinalAuthorization } {
  const sessionId = safeContextIdentity(input.session_id, "session_id");
  const jobId = safeId(input.job_id, "job_id");
  const executorId = safeContextIdentity(input.executor_id, "executor_id");
  const job = readJob(jobId);
  if (!job) throw new Error("Revit courier job was not found.");
  if (job.session_id !== sessionId) throw new Error("Revit courier session mismatch.");
  const terminal = readTerminalResult(job);
  if (terminal) {
    reconcileJobWithResult(job, terminal);
    throw new Error("Revit courier job is already terminal and cannot be authorized for execution.");
  }
  if (fs.existsSync(resultPath(job.id))) throw new Error("Revit courier result receipt is invalid or mismatched; refusing execution authorization.");
  if (job.status !== "running") throw new Error("Revit courier job is not running under this executor.");
  if (job.version !== REVIT_COURIER_V2_JOB_VERSION) {
    throw new Error("Legacy Revit courier jobs do not have a certified final-execution authorization receipt.");
  }
  const terminalize = (error: unknown): never => {
    const certificationError = error instanceof RevitCourierCertificationError
      ? error
      : new RevitCourierCertificationError("CERTIFICATION_FINAL_EXECUTION_FAILED", "Certified courier final execution authorization failed.");
    const terminalJob = writeCertificationTerminal(job, certificationError);
    const terminalError = new Error(`${certificationError.code}: ${certificationError.message}`);
    (terminalError as Error & { job?: RevitToolJob }).job = terminalJob;
    throw terminalError;
  };
  try {
    // Validate durable v2 shape before consulting the claim. A malformed claim
    // is a quarantined job, never a generic authorization error that leaves it
    // eligible for a later workstation.
    parseCertifiedCourierJobV2(job);
  } catch (error) {
    return terminalize(error);
  }
  // Caller identity mismatches are not a certification decision. Do not let
  // an untrusted wrong-workstation request poison another worker's lease.
  if (job.claim?.executor_id !== executorId) throw new Error("Revit courier job is not claimed by this executor.");
  try {
    // This endpoint is called immediately before the workstation creates its
    // Revit action. These expiry failures are therefore known not to have
    // reached Revit and must not be mislabeled as outcome-unknown leases.
    const now = Date.now();
    const jobExpiresAt = Date.parse(job.expires_at);
    if (!Number.isFinite(jobExpiresAt) || jobExpiresAt <= now) {
      throw new RevitCourierCertificationError(
        "CERTIFICATION_FINAL_JOB_EXPIRED",
        "Certified courier job expired before final execution authorization; no Revit call was made."
      );
    }
    const leaseExpiresAt = Date.parse(job.claim?.lease_expires_at ?? "");
    if (!Number.isFinite(leaseExpiresAt) || leaseExpiresAt <= now) {
      throw new RevitCourierCertificationError(
        "CERTIFICATION_FINAL_CLAIM_LEASE_EXPIRED",
        "Certified courier claim lease expired before final execution authorization; no Revit call was made."
      );
    }
    const authorization = authorizeCertifiedCourierFinalExecution(job, executorId);
    return { job, authorization };
  } catch (error) {
    return terminalize(error);
  }
}
