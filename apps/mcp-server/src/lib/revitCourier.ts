import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  assertToolExposure,
  canonicalToolExposureJson,
  getToolExposureRuntimeDecision,
  readCertifiedCourierAdmission,
  TOOL_EXPOSURE_CANONICALIZATION,
  type CertifiedCourierAdmission,
  type ToolExposureChannel,
  type ToolExposureDecision
} from "./toolExposurePolicy.js";
import { getWorkspaceRoot } from "./workspace.js";

const JOB_VERSION_V1 = "revit-operator.revit-tool-job.v1";
const JOB_VERSION_V2 = "revit-operator.revit-tool-job.v2";
const RESULT_VERSION = "revit-operator.revit-tool-result.v1";
const CERTIFICATION_ENVELOPE_SCHEMA = "revit-operator.revit-tool-certification-envelope.v1";
const SHA256 = /^sha256:[0-9a-f]{64}$/;
const EXPOSURE_CHANNELS: readonly ToolExposureChannel[] = ["search", "generic_call", "typed_mcp", "deterministic_workflow"];
const UNSAFE_CONTEXT_CONTROL = /[\u0000-\u001F\u007F]/u;

export const REVIT_COURIER_CONTEXT_STRING_LIMITS = Object.freeze({
  session_id: 200,
  message_id: 200,
  target_executor_id: 200,
  target_document_title: 500,
  target_document_path: 2_000
} as const);

type CourierContext = {
  version?: string;
  active?: boolean;
  token?: string;
  session_id?: string;
  message_id?: string;
  expires_at?: string;
  target_executor_id?: string;
  target_document_title?: string;
  target_document_path?: string;
};

type CourierResult = {
  version?: string;
  id?: string;
  status?: string;
  result?: unknown;
  error?: string | null;
  code?: string | null;
  retryable?: boolean;
  outcome_unknown?: boolean;
};

export class RevitCourierError extends Error {
  readonly code: string;
  readonly retryable: boolean;
  readonly outcome_unknown: boolean;
  readonly outcomeUnknown: boolean;
  readonly job_id: string;
  readonly jobId: string;

  constructor(input: {
    code: string;
    message: string;
    retryable: boolean;
    outcomeUnknown?: boolean;
    jobId: string;
  }) {
    super(input.message);
    this.name = "RevitCourierError";
    this.code = input.code;
    this.outcome_unknown = input.outcomeUnknown === true;
    this.outcomeUnknown = this.outcome_unknown;
    // An unknown execution outcome must never invite an automatic retry.
    this.retryable = this.outcome_unknown ? false : input.retryable;
    this.job_id = input.jobId;
    this.jobId = input.jobId;
  }
}

type CourierJob = {
  version?: string;
  id?: string;
  session_id?: string;
  message_id?: string | null;
  turn_token?: string | null;
  turn_token_sha256?: string | null;
  correlation_id?: string;
  idempotency_key?: string;
  method?: string;
  path?: string;
  created_at?: string;
  expires_at?: string;
  status?: string;
  claim?: unknown;
  target_executor_id?: string | null;
  target_document_title?: string | null;
  target_document_path?: string | null;
  body_json?: string;
  body_present?: boolean;
  certification_envelope?: CertificationEnvelope;
  [key: string]: unknown;
};

type CertificationEnvelope = {
  schema: typeof CERTIFICATION_ENVELOPE_SCHEMA;
  version: 1;
  canonicalization: typeof TOOL_EXPOSURE_CANONICALIZATION;
  policy_hash: string;
  policy_record_hash: string;
  evidence_record_hash: string;
  request_hash: string;
  effect_hash: string;
  method: string;
  path: string;
  body_present: boolean;
  body_sha256: string;
  channel: ToolExposureChannel;
  alias: string;
  workflow?: string;
  runtime_mode: string;
  exposure_profile: "certified";
  policy_trust_source: "bundled" | "deployment";
  envelope_hash: string;
};

export type RevitCourierCallOptions = {
  /**
   * Opaque in-process capability minted by callRevit at MCP admission. It is
   * mandatory for certified courier publication and is checked again before
   * the durable job is written.
   */
  certifiedAdmission?: CertifiedCourierAdmission;
};

function timeoutMs(): number {
  const parsed = Number.parseInt(process.env.OPERATOR_REVIT_COURIER_TIMEOUT_MS ?? "", 10);
  return Number.isFinite(parsed) ? Math.max(5_000, Math.min(15 * 60_000, parsed)) : 90_000;
}

function readContextString(
  value: unknown,
  field: keyof typeof REVIT_COURIER_CONTEXT_STRING_LIMITS,
  required = false
): string | undefined {
  if (value === undefined || value === null) {
    if (required) throw new Error(`Revit courier context ${field} is required.`);
    return undefined;
  }
  if (typeof value !== "string") throw new Error(`Revit courier context ${field} must be a string.`);
  if (required && !value.trim()) throw new Error(`Revit courier context ${field} must not be blank.`);
  if (value.length > REVIT_COURIER_CONTEXT_STRING_LIMITS[field]) {
    throw new Error(`Revit courier context ${field} exceeds ${REVIT_COURIER_CONTEXT_STRING_LIMITS[field]} UTF-16 code units.`);
  }
  if (UNSAFE_CONTEXT_CONTROL.test(value)) {
    throw new Error(`Revit courier context ${field} contains a forbidden control character.`);
  }
  return required ? value.trim() : value;
}

function readContext(): Required<Pick<CourierContext, "session_id" | "expires_at">> & CourierContext {
  const contextPath = path.join(getWorkspaceRoot(), "config", "revit-courier-context.json");
  let parsed: CourierContext;
  try {
    parsed = JSON.parse(fs.readFileSync(contextPath, "utf8")) as CourierContext;
  } catch {
    throw new Error("Revit courier context is unavailable; the hosted Codex turn is not bound to a workstation session.");
  }
  const sessionId = readContextString(parsed.session_id, "session_id", true)!;
  const messageId = readContextString(parsed.message_id, "message_id");
  const targetExecutorId = readContextString(parsed.target_executor_id, "target_executor_id");
  const targetDocumentTitle = readContextString(parsed.target_document_title, "target_document_title");
  const targetDocumentPath = readContextString(parsed.target_document_path, "target_document_path");
  const expiresAt = typeof parsed.expires_at === "string" ? Date.parse(parsed.expires_at) : Number.NaN;
  if (parsed.active !== true || !Number.isFinite(expiresAt) || expiresAt <= Date.now()) {
    throw new Error("Revit courier context is inactive or expired; start a fresh Operator turn.");
  }
  const expiresAtIso = new Date(expiresAt).toISOString();
  return {
    ...parsed,
    session_id: sessionId,
    expires_at: expiresAtIso,
    ...(messageId === undefined ? { message_id: undefined } : { message_id: messageId }),
    ...(targetExecutorId === undefined ? { target_executor_id: undefined } : { target_executor_id: targetExecutorId }),
    ...(targetDocumentTitle === undefined ? { target_document_title: undefined } : { target_document_title: targetDocumentTitle }),
    ...(targetDocumentPath === undefined ? { target_document_path: undefined } : { target_document_path: targetDocumentPath })
  };
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
    if (receipt.version !== RESULT_VERSION || receipt.id !== id || (receipt as { correlation_id?: string }).correlation_id !== id) {
      throw new Error("Revit courier returned a mismatched result receipt.");
    }
    return receipt;
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return null;
    throw error;
  }
}

function sha256(value: string): string {
  return `sha256:${createHash("sha256").update(value, "utf8").digest("hex")}`;
}

function exactJson(value: unknown): string {
  return JSON.stringify(value);
}

function isCertificationHash(value: unknown): value is string {
  return typeof value === "string" && SHA256.test(value);
}

function isExposureChannel(value: unknown): value is ToolExposureChannel {
  return typeof value === "string" && (EXPOSURE_CHANNELS as readonly string[]).includes(value);
}

function rawJsonBody(body: unknown): { present: boolean; json: string } {
  if (body === undefined) return { present: false, json: "" };
  const json = typeof body === "string" ? body : JSON.stringify(body);
  if (json === undefined) throw new Error("Revit courier request body is not JSON serializable.");
  try {
    JSON.parse(json);
  } catch (error) {
    throw new Error("Certified Revit courier requests require an exact JSON body.", { cause: error });
  }
  return { present: true, json };
}

function assertExactCertifiedAdmission(
  capability: CertifiedCourierAdmission | undefined,
  method: string,
  revitPath: string,
  body: unknown
): ToolExposureDecision {
  const decision = readCertifiedCourierAdmission(capability);
  if (decision.allowed !== true || decision.mode !== "certified") {
    throw new Error("Certified Revit courier publication requires an allowed certified MCP admission decision.");
  }
  if (decision.method !== method || decision.path !== revitPath || !isExposureChannel(decision.channel)) {
    throw new Error("Certified Revit courier admission decision does not bind the exact requested method and path.");
  }
  if (!decision.alias || !/^[a-z][a-z0-9_]*$/.test(decision.alias)) {
    throw new Error("Certified Revit courier admission decision is missing an exact MCP alias.");
  }
  if (decision.channel === "generic_call" && decision.alias !== "revit_call_tool") {
    throw new Error("Certified Revit courier generic admission must be bound to revit_call_tool.");
  }
  if (!isCertificationHash(decision.policyHash)
    || !isCertificationHash(decision.policyRecordHash)
    || !isCertificationHash(decision.evidenceRecordHash)
    || !isCertificationHash(decision.requestHash)
    || !isCertificationHash(decision.effectHash)
    || (decision.policyTrustSource !== "bundled" && decision.policyTrustSource !== "deployment")
    || !decision.runtimeMode.trim()) {
    throw new Error("Certified Revit courier admission decision is malformed or incomplete.");
  }

  // Recompute admission against the live trusted policy before publication.
  // The immutable result has to match the earlier decision exactly; a policy
  // rotation or changed binding is a typed fail-closed condition, never a
  // reason to enqueue a broadened job.
  const recomputed = assertToolExposure({
    method,
    path: revitPath,
    body,
    channel: decision.channel,
    workflow: decision.workflow,
    alias: decision.alias
  });
  const immutableFields: Array<keyof ToolExposureDecision> = [
    "allowed",
    "mode",
    "runtimeMode",
    "method",
    "path",
    "channel",
    "requestHash",
    "effectHash",
    "policyHash",
    "policyRecordHash",
    "evidenceRecordHash",
    "policyTrustSource",
    "alias",
    "workflow"
  ];
  for (const field of immutableFields) {
    if (decision[field] !== recomputed[field]) {
      throw new Error(`Certified Revit courier admission decision changed at ${field}; refusing durable publication.`);
    }
  }
  return recomputed;
}

function createCertificationEnvelope(decision: ToolExposureDecision, rawBody: { present: boolean; json: string }): CertificationEnvelope {
  const payload = {
    schema: CERTIFICATION_ENVELOPE_SCHEMA as typeof CERTIFICATION_ENVELOPE_SCHEMA,
    version: 1 as const,
    canonicalization: TOOL_EXPOSURE_CANONICALIZATION as typeof TOOL_EXPOSURE_CANONICALIZATION,
    policy_hash: decision.policyHash!,
    policy_record_hash: decision.policyRecordHash!,
    evidence_record_hash: decision.evidenceRecordHash!,
    request_hash: decision.requestHash,
    effect_hash: decision.effectHash,
    method: decision.method,
    path: decision.path,
    body_present: rawBody.present,
    body_sha256: sha256(rawBody.json),
    channel: decision.channel,
    alias: decision.alias!,
    ...(decision.workflow === undefined ? {} : { workflow: decision.workflow }),
    runtime_mode: decision.runtimeMode,
    exposure_profile: "certified" as const,
    policy_trust_source: decision.policyTrustSource!
  };
  return { ...payload, envelope_hash: sha256(canonicalToolExposureJson(payload)) };
}

function legacyIdempotencyKey(context: CourierContext & Required<Pick<CourierContext, "session_id">>, method: string, revitPath: string, bodyJson: string): string {
  return createHash("sha256")
    .update(`${context.session_id}\n${context.message_id ?? ""}\n${context.token ?? ""}\n${context.target_executor_id ?? ""}\n${context.target_document_title ?? ""}\n${context.target_document_path ?? ""}\n${method}\n${revitPath}\n${bodyJson}`)
    .digest("hex");
}

function v2IdempotencyKey(
  context: CourierContext & Required<Pick<CourierContext, "session_id" | "expires_at">>,
  method: string,
  revitPath: string,
  rawBody: { present: boolean; json: string },
  envelope: CertificationEnvelope
): string {
  return createHash("sha256")
    .update(canonicalToolExposureJson({
      schema: "revit-operator.revit-tool-job-idempotency.v2",
      canonicalization: TOOL_EXPOSURE_CANONICALIZATION,
      session_id: context.session_id,
      message_id: context.message_id ?? null,
      expires_at: context.expires_at,
      turn_token_sha256: context.token ? sha256(context.token) : null,
      target_executor_id: context.target_executor_id ?? null,
      target_document_title: context.target_document_title ?? null,
      target_document_path: context.target_document_path ?? null,
      method,
      path: revitPath,
      body_present: rawBody.present,
      body_sha256: sha256(rawBody.json),
      certification_envelope_hash: envelope.envelope_hash
    }), "utf8")
    .digest("hex");
}

function assertNoLegacyJobForCertifiedCall(legacyJobPath: string): void {
  if (!fs.existsSync(legacyJobPath)) return;
  let existing: CourierJob;
  try {
    existing = JSON.parse(fs.readFileSync(legacyJobPath, "utf8")) as CourierJob;
  } catch {
    throw new Error("Certified Revit courier found an unreadable legacy job receipt; refusing resume.");
  }
  if (existing.version === JOB_VERSION_V1) {
    throw new Error("Certified Revit courier refuses to resume a legacy v1 job without a certification envelope.");
  }
}

function isCanonicalIsoInstant(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) return false;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}

function publishOrResumeJob(jobPath: string, candidate: CourierJob): CourierJob {
  fs.mkdirSync(path.dirname(jobPath), { recursive: true });
  try {
    fs.writeFileSync(jobPath, `${JSON.stringify(candidate, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
    return candidate;
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code !== "EEXIST") throw error;
  }

  let existing: CourierJob;
  try {
    existing = JSON.parse(fs.readFileSync(jobPath, "utf8")) as CourierJob;
  } catch {
    throw new Error("Revit courier found an unreadable existing idempotent job receipt.");
  }
  if (candidate.version === JOB_VERSION_V2 && existing.version !== JOB_VERSION_V2) {
    throw new Error("Certified Revit courier refuses to resume a legacy v1 job without a certification envelope.");
  }
  const matches = existing.version === candidate.version &&
    existing.id === candidate.id &&
    existing.correlation_id === candidate.correlation_id &&
    existing.idempotency_key === candidate.idempotency_key &&
    existing.session_id === candidate.session_id &&
    (existing.message_id ?? null) === (candidate.message_id ?? null) &&
    (existing.turn_token ?? null) === (candidate.turn_token ?? null) &&
    (existing.turn_token_sha256 ?? null) === (candidate.turn_token_sha256 ?? null) &&
    existing.method === candidate.method &&
    existing.path === candidate.path;
  const sameTarget =
    (existing.target_executor_id ?? null) === (candidate.target_executor_id ?? null) &&
    (existing.target_document_title ?? null) === (candidate.target_document_title ?? null) &&
    (existing.target_document_path ?? null) === (candidate.target_document_path ?? null);
  const v2Equivalent = candidate.version !== JOB_VERSION_V2 || (
    existing.body_present === candidate.body_present
    && existing.body_json === candidate.body_json
    && exactJson(existing.certification_envelope) === exactJson(candidate.certification_envelope)
    && exactJson(existing.body) === exactJson(candidate.body)
    && existing.expires_at === candidate.expires_at
    && isCanonicalIsoInstant(existing.created_at)
    && isCanonicalIsoInstant(existing.expires_at)
    && Date.parse(existing.created_at) <= Date.parse(existing.expires_at)
  );
  if (!matches || !sameTarget || !v2Equivalent) {
    throw new Error("Revit courier idempotency collision detected; refusing to broaden or replay the call.");
  }
  return existing;
}

function resolveResult<T>(receipt: CourierResult): T {
  if (receipt.status === "succeeded") return receipt.result as T;
  const details = [receipt.code, receipt.error].filter(Boolean).join(": ") || "Revit courier execution failed.";
  const outcomeUnknown = receipt.outcome_unknown === true;
  const retryable = outcomeUnknown ? false : receipt.retryable === true;
  throw new RevitCourierError({
    code: receipt.code || "courier_execution_failed",
    message: `${details}${retryable ? " (retryable)" : ""}`,
    retryable,
    outcomeUnknown,
    jobId: receipt.id || "unknown"
  });
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

  const supportedVersion = job?.version === JOB_VERSION_V1 || job?.version === JOB_VERSION_V2;
  const running = supportedVersion && job?.id === id && job.status === "running";
  const pending = supportedVersion && job?.id === id && job.status === "pending";
  if (running || pending) {
    const finishedAt = new Date().toISOString();
    const code = running
      ? "courier_execution_deadline_elapsed_outcome_unknown"
      : "courier_job_timed_out_before_claim";
    const error = running
      ? "The workstation execution deadline elapsed; outcome is unknown and the call was not retried automatically."
      : "The Revit courier job timed out before a workstation claimed it.";
    const retryable = pending;
    const outcomeUnknown = running;
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
      retryable,
      outcome_unknown: outcomeUnknown
    });
    throw new RevitCourierError({
      code,
      message: `${code}: ${error}${retryable ? " (retryable)" : ""} (job ${id}).`,
      retryable,
      outcomeUnknown,
      jobId: id
    });
  }

  throw new Error(`Revit courier timed out after ${durationMs} ms waiting for workstation execution (job ${id}).`);
}

export async function callRevitViaCourier<T>(
  revitPath: string,
  method: string,
  body?: unknown,
  options: RevitCourierCallOptions = {}
): Promise<T> {
  const context = readContext();
  const normalizedMethod = String(method || "GET").trim().toUpperCase();
  if (normalizedMethod !== "GET" && normalizedMethod !== "POST") throw new Error("Revit courier supports GET or POST only.");
  if (!revitPath.startsWith("/revit/")) throw new Error("Revit courier path must begin with /revit/.");

  const durationMs = timeoutMs();
  const now = Date.now();
  const runtime = getToolExposureRuntimeDecision();
  const certified = runtime.certified;
  const rawBody = certified ? rawJsonBody(body) : undefined;
  const legacyBodyJson = JSON.stringify(body) ?? "null";
  const bodyForSizeCheck = rawBody?.json ?? legacyBodyJson;
  if (Buffer.byteLength(bodyForSizeCheck, "utf8") > 2 * 1024 * 1024) throw new Error("Revit courier request body exceeds 2 MiB.");

  const decision = certified
    ? assertExactCertifiedAdmission(options.certifiedAdmission, normalizedMethod, revitPath, body)
    : undefined;
  const envelope = decision && rawBody ? createCertificationEnvelope(decision, rawBody) : undefined;
  const idempotencyKey = envelope && rawBody
    ? v2IdempotencyKey(context, normalizedMethod, revitPath, rawBody, envelope)
    : legacyIdempotencyKey(context, normalizedMethod, revitPath, legacyBodyJson);
  // A stable job id makes a transport retry resume the same durable operation instead of publishing a duplicate write.
  const id = idempotencyKey;
  const jobDir = path.join(getWorkspaceRoot(), "artifacts", "revit-courier", "jobs", id);
  const jobPath = path.join(jobDir, "job.json");
  const resultPath = path.join(jobDir, "result.json");
  if (envelope) {
    const legacyId = legacyIdempotencyKey(context, normalizedMethod, revitPath, legacyBodyJson);
    assertNoLegacyJobForCertifiedCall(path.join(getWorkspaceRoot(), "artifacts", "revit-courier", "jobs", legacyId, "job.json"));
  }
  const job = publishOrResumeJob(jobPath, {
    version: envelope ? JOB_VERSION_V2 : JOB_VERSION_V1,
    id,
    session_id: context.session_id,
    message_id: context.message_id ?? null,
    ...(envelope
      ? { turn_token_sha256: context.token ? sha256(context.token) : null }
      : { turn_token: context.token ?? null }),
    correlation_id: id,
    idempotency_key: idempotencyKey,
    method: normalizedMethod,
    path: revitPath,
    target_executor_id: context.target_executor_id ?? null,
    target_document_title: context.target_document_title ?? null,
    target_document_path: context.target_document_path ?? null,
    ...(body === undefined ? {} : { body }),
    ...(rawBody ? { body_json: rawBody.json, body_present: rawBody.present } : {}),
    ...(envelope ? { certification_envelope: envelope } : {}),
    created_at: new Date(now).toISOString(),
    expires_at: envelope ? context.expires_at : new Date(now + durationMs).toISOString(),
    status: "pending",
    claim: null
  });

  const persistedExpiry = Date.parse(job.expires_at ?? "");
  const deadline = Number.isFinite(persistedExpiry) ? Math.min(now + durationMs, persistedExpiry) : now + durationMs;
  while (Date.now() < deadline) {
    const receipt = readResult(resultPath, id);
    if (receipt) return resolveResult<T>(receipt);
    await delay(200);
  }
  return finalizeTimeout<T>(jobPath, resultPath, id, durationMs);
}
