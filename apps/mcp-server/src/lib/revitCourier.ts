import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { getWorkspaceRoot } from "./workspace.js";

const JOB_VERSION = "revit-operator.revit-tool-job.v1";
const RESULT_VERSION = "revit-operator.revit-tool-result.v1";

type CourierContext = {
  version?: string;
  active?: boolean;
  session_id?: string;
  message_id?: string;
  expires_at?: string;
};

type CourierResult = {
  version?: string;
  id?: string;
  status?: string;
  result?: unknown;
  error?: string | null;
  code?: string | null;
  retryable?: boolean;
};

type CourierJob = {
  version?: string;
  id?: string;
  correlation_id?: string;
  status?: string;
  claim?: unknown;
  [key: string]: unknown;
};

function timeoutMs(): number {
  const parsed = Number.parseInt(process.env.OPERATOR_REVIT_COURIER_TIMEOUT_MS ?? "", 10);
  return Number.isFinite(parsed) ? Math.max(5_000, Math.min(15 * 60_000, parsed)) : 90_000;
}

function readContext(): Required<Pick<CourierContext, "session_id">> & CourierContext {
  const contextPath = path.join(getWorkspaceRoot(), "config", "revit-courier-context.json");
  let parsed: CourierContext;
  try {
    parsed = JSON.parse(fs.readFileSync(contextPath, "utf8")) as CourierContext;
  } catch {
    throw new Error("Revit courier context is unavailable; the hosted Codex turn is not bound to a workstation session.");
  }
  const sessionId = typeof parsed.session_id === "string" ? parsed.session_id.trim() : "";
  const expiresAt = Date.parse(parsed.expires_at ?? "");
  if (!parsed.active || !sessionId || !Number.isFinite(expiresAt) || expiresAt <= Date.now()) {
    throw new Error("Revit courier context is inactive or expired; start a fresh Operator turn.");
  }
  return { ...parsed, session_id: sessionId };
}

function writeJsonAtomic(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temp = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  fs.renameSync(temp, filePath);
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function readResult(resultPath: string, id: string): CourierResult | null {
  try {
    const receipt = JSON.parse(fs.readFileSync(resultPath, "utf8")) as CourierResult;
    if (receipt.version !== RESULT_VERSION || receipt.id !== id) throw new Error("Revit courier returned a mismatched result receipt.");
    return receipt;
  } catch (error) {
    if (error instanceof Error && /ENOENT|cannot find the file/i.test(error.message)) return null;
    throw error;
  }
}

function resolveResult<T>(receipt: CourierResult): T {
  if (receipt.status === "succeeded") return receipt.result as T;
  const details = [receipt.code, receipt.error].filter(Boolean).join(": ") || "Revit courier execution failed.";
  throw new Error(`${details}${receipt.retryable ? " (retryable)" : ""}`);
}

function finalizeTimeout<T>(jobPath: string, resultPath: string, id: string, durationMs: number): T {
  const receipt = readResult(resultPath, id);
  if (receipt) return resolveResult<T>(receipt);

  let job: CourierJob | null = null;
  try {
    job = JSON.parse(fs.readFileSync(jobPath, "utf8")) as CourierJob;
  } catch {
    // The timeout error below remains authoritative when the pending receipt is unreadable.
  }

  const running = job?.version === JOB_VERSION && job.id === id && job.status === "running";
  const pending = job?.version === JOB_VERSION && job.id === id && job.status === "pending";
  if (running || pending) {
    const finishedAt = new Date().toISOString();
    const code = running
      ? "courier_execution_deadline_elapsed_outcome_unknown"
      : "courier_job_timed_out_before_claim";
    const error = running
      ? "The workstation execution deadline elapsed; outcome is unknown and the call was not retried automatically."
      : "The Revit courier job timed out before a workstation claimed it.";
    const retryable = pending;
    writeJsonAtomic(jobPath, {
      ...job,
      status: "failed",
      finished_at: finishedAt,
      error
    });
    writeJsonAtomic(resultPath, {
      version: RESULT_VERSION,
      id,
      correlation_id: job?.correlation_id ?? id,
      status: "failed",
      finished_at: finishedAt,
      result: null,
      error,
      code,
      retryable
    });
    throw new Error(`${code}: ${error}${retryable ? " (retryable)" : ""} (job ${id}).`);
  }

  throw new Error(`Revit courier timed out after ${durationMs} ms waiting for workstation execution (job ${id}).`);
}

export async function callRevitViaCourier<T>(revitPath: string, method: string, body?: unknown): Promise<T> {
  const context = readContext();
  const normalizedMethod = String(method || "GET").trim().toUpperCase();
  if (normalizedMethod !== "GET" && normalizedMethod !== "POST") throw new Error("Revit courier supports GET or POST only.");
  if (!revitPath.startsWith("/revit/")) throw new Error("Revit courier path must begin with /revit/.");

  const durationMs = timeoutMs();
  const now = Date.now();
  const id = randomUUID().replace(/-/g, "");
  const bodyJson = JSON.stringify(body) ?? "null";
  if (Buffer.byteLength(bodyJson, "utf8") > 2 * 1024 * 1024) throw new Error("Revit courier request body exceeds 2 MiB.");
  const idempotencyKey = createHash("sha256")
    .update(`${context.session_id}\n${context.message_id ?? ""}\n${normalizedMethod}\n${revitPath}\n${bodyJson}`)
    .digest("hex");
  const jobDir = path.join(getWorkspaceRoot(), "artifacts", "revit-courier", "jobs", id);
  const jobPath = path.join(jobDir, "job.json");
  const resultPath = path.join(jobDir, "result.json");
  writeJsonAtomic(jobPath, {
    version: JOB_VERSION,
    id,
    session_id: context.session_id,
    message_id: context.message_id ?? null,
    correlation_id: id,
    idempotency_key: idempotencyKey,
    method: normalizedMethod,
    path: revitPath,
    ...(body === undefined ? {} : { body }),
    created_at: new Date(now).toISOString(),
    expires_at: new Date(now + durationMs).toISOString(),
    status: "pending",
    claim: null
  });

  const deadline = now + durationMs;
  while (Date.now() < deadline) {
    const receipt = readResult(resultPath, id);
    if (receipt) return resolveResult<T>(receipt);
    await delay(200);
  }
  return finalizeTimeout<T>(jobPath, resultPath, id, durationMs);
}
