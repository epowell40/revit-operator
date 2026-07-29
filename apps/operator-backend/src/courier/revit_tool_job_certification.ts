import { createHash } from "node:crypto";
import {
  canonicalJson,
  computeRequestHash,
  normalizeMethod,
  normalizeToolPath,
  type ExposureChannel,
} from "../capabilities/tool_certification.js";
import {
  evaluateTrustedToolExposurePolicy,
  loadTrustedToolExposurePolicy,
  TrustedToolExposurePolicyError,
  type TrustedToolExposurePolicy
} from "../capabilities/trusted_tool_exposure_policy.js";

export const REVIT_COURIER_V2_JOB_VERSION = "revit-operator.revit-tool-job.v2";
export const REVIT_COURIER_CERTIFICATION_ENVELOPE_SCHEMA = "revit-operator.revit-tool-certification-envelope.v1";
export const REVIT_COURIER_FINAL_AUTHORIZATION_VERSION = "revit-operator.revit-tool-final-authorization.v1";
export const REVIT_COURIER_CANONICALIZATION = "revit-operator.canonical-json.nfc-key-sorted.v1";

const SHA256 = /^sha256:[0-9a-f]{64}$/;
const ID = /^[a-f0-9]{64}$/;
const ALIAS = /^[a-z][a-z0-9_]*$/;
const CHANNELS: readonly ExposureChannel[] = ["search", "generic_call", "typed_mcp", "deterministic_workflow"];

export type RevitCourierCertificationEnvelope = {
  schema: typeof REVIT_COURIER_CERTIFICATION_ENVELOPE_SCHEMA;
  version: 1;
  canonicalization: typeof REVIT_COURIER_CANONICALIZATION;
  policy_hash: string;
  policy_record_hash: string;
  evidence_record_hash: string;
  request_hash: string;
  effect_hash: string;
  method: string;
  path: string;
  body_present: boolean;
  body_sha256: string;
  channel: ExposureChannel;
  alias: string;
  workflow?: string;
  runtime_mode: string;
  exposure_profile: "certified";
  policy_trust_source: "bundled" | "deployment";
  envelope_hash: string;
};

export type CertifiedCourierJobV2 = {
  version: typeof REVIT_COURIER_V2_JOB_VERSION;
  id: string;
  session_id: string;
  message_id: string | null;
  turn_token_sha256: string | null;
  correlation_id: string;
  idempotency_key: string;
  method: "GET" | "POST";
  path: string;
  target_executor_id: string | null;
  target_document_title: string | null;
  target_document_path: string | null;
  body?: unknown;
  body_json: string;
  body_present: boolean;
  certification_envelope: RevitCourierCertificationEnvelope;
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

export type CertifiedCourierFinalAuthorization = {
  version: typeof REVIT_COURIER_FINAL_AUTHORIZATION_VERSION;
  phase: "certification_final_execution";
  authorized_at: string;
  job_id: string;
  correlation_id: string;
  session_id: string;
  executor_id: string;
  target_executor_id: string | null;
  target_document_title: string | null;
  target_document_path: string | null;
  method: "GET" | "POST";
  path: string;
  body_present: boolean;
  body_json: string;
  policy_hash: string;
  policy_record_hash: string;
  evidence_record_hash: string;
  request_hash: string;
  effect_hash: string;
  channel: ExposureChannel;
  alias: string;
  workflow?: string;
  runtime_mode: string;
  exposure_profile: "certified";
  policy_trust_source: "bundled" | "deployment";
  certification_envelope_hash: string;
};

export class RevitCourierCertificationError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "RevitCourierCertificationError";
  }
}

function own(value: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function asObject(value: unknown, location: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new RevitCourierCertificationError("CERTIFICATION_JOB_MALFORMED", `${location} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, required: readonly string[], optional: readonly string[], location: string): void {
  const allowed = new Set([...required, ...optional]);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw new RevitCourierCertificationError("CERTIFICATION_JOB_MALFORMED", `${location} contains unknown field ${key}.`);
  }
  for (const key of required) {
    if (!own(value, key)) throw new RevitCourierCertificationError("CERTIFICATION_JOB_MALFORMED", `${location} is missing ${key}.`);
  }
}

function boundedSafeText(value: unknown, location: string, max: number, allowNull = false): string | null {
  if (value === null && allowNull) return null;
  // Match the producer exactly: allow ordinary Unicode, reject C0 controls
  // (including NUL/CR/LF) and DEL, and enforce UTF-16 code-unit limits.
  if (typeof value !== "string" || value.length > max || /[\u0000-\u001F\u007F]/.test(value)) {
    throw new RevitCourierCertificationError("CERTIFICATION_JOB_MALFORMED", `${location} is invalid.`);
  }
  return value;
}

function requiredAsciiId(value: unknown, location: string): string {
  const text = boundedSafeText(value, location, 200);
  if (!text || !/^[A-Za-z0-9._:-]+$/.test(text)) {
    throw new RevitCourierCertificationError("CERTIFICATION_JOB_MALFORMED", `${location} is invalid.`);
  }
  return text;
}

function requiredContextIdentity(value: unknown, location: string): string {
  const text = boundedSafeText(value, location, 200);
  if (!text) throw new RevitCourierCertificationError("CERTIFICATION_JOB_MALFORMED", `${location} is invalid.`);
  return text;
}

function requiredHash(value: unknown, location: string, nullable = false): string | null {
  if (value === null && nullable) return null;
  if (typeof value !== "string" || !SHA256.test(value)) {
    throw new RevitCourierCertificationError("CERTIFICATION_JOB_MALFORMED", `${location} is not a canonical SHA-256 value.`);
  }
  return value;
}

function canonicalSha256Text(value: string): string {
  return `sha256:${createHash("sha256").update(value, "utf8").digest("hex")}`;
}

function isCanonicalIsoInstant(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) return false;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}

function hashV2Idempotency(payload: unknown): string {
  return createHash("sha256").update(canonicalJson(payload as never), "utf8").digest("hex");
}

function normalizeRuntimeMode(value: unknown): string {
  return String(value ?? "local").trim().toLowerCase().replace(/-/g, "_") || "local";
}

export function isRevitCourierDevelopmentLaboratory(env: NodeJS.ProcessEnv = process.env): boolean {
  return normalizeRuntimeMode(env.REVIT_OPERATOR_MODE) === "development"
    && String(env.OPERATOR_TOOL_EXPOSURE_PROFILE ?? "").trim().toLowerCase() === "laboratory";
}

function assertCurrentCertifiedRuntime(envelope: RevitCourierCertificationEnvelope): void {
  const runtimeMode = normalizeRuntimeMode(process.env.REVIT_OPERATOR_MODE);
  if (isRevitCourierDevelopmentLaboratory()) {
    throw new RevitCourierCertificationError(
      "CERTIFICATION_RUNTIME_PROFILE_MISMATCH",
      "Certified courier jobs cannot execute while the explicit development laboratory profile is active."
    );
  }
  if (envelope.runtime_mode !== runtimeMode || envelope.exposure_profile !== "certified") {
    throw new RevitCourierCertificationError(
      "CERTIFICATION_RUNTIME_PROFILE_MISMATCH",
      "Certified courier job runtime/profile does not match the current certified backend runtime."
    );
  }
}

function parseEnvelope(value: unknown, job: Record<string, unknown>): RevitCourierCertificationEnvelope {
  const envelope = asObject(value, "certification_envelope");
  exactKeys(envelope, [
    "schema", "version", "canonicalization", "policy_hash", "policy_record_hash", "evidence_record_hash",
    "request_hash", "effect_hash", "method", "path", "body_present", "body_sha256", "channel", "alias",
    "runtime_mode", "exposure_profile", "policy_trust_source", "envelope_hash"
  ], ["workflow"], "certification_envelope");
  if (envelope.schema !== REVIT_COURIER_CERTIFICATION_ENVELOPE_SCHEMA || envelope.version !== 1
    || envelope.canonicalization !== REVIT_COURIER_CANONICALIZATION) {
    throw new RevitCourierCertificationError("CERTIFICATION_JOB_MALFORMED", "Certification envelope schema is unsupported.");
  }
  for (const field of ["policy_hash", "policy_record_hash", "evidence_record_hash", "request_hash", "effect_hash", "body_sha256", "envelope_hash"] as const) {
    requiredHash(envelope[field], `certification_envelope.${field}`);
  }
  if (envelope.method !== job.method || envelope.path !== job.path) {
    throw new RevitCourierCertificationError("CERTIFICATION_JOB_MISMATCH", "Certification envelope method/path does not match the durable job.");
  }
  if (envelope.body_present !== job.body_present) {
    throw new RevitCourierCertificationError("CERTIFICATION_JOB_MISMATCH", "Certification envelope body presence does not match the durable job.");
  }
  if (envelope.body_sha256 !== canonicalSha256Text(job.body_json as string)) {
    throw new RevitCourierCertificationError("CERTIFICATION_JOB_MISMATCH", "Certification envelope body hash does not match the authoritative raw body.");
  }
  if (!(CHANNELS as readonly string[]).includes(String(envelope.channel))) {
    throw new RevitCourierCertificationError("CERTIFICATION_JOB_MALFORMED", "Certification envelope has an unsupported exposure channel.");
  }
  const alias = boundedSafeText(envelope.alias, "certification_envelope.alias", 160);
  if (!alias || !ALIAS.test(alias)) throw new RevitCourierCertificationError("CERTIFICATION_JOB_MALFORMED", "Certification envelope alias is invalid.");
  if (envelope.channel === "generic_call" && alias !== "revit_call_tool") {
    throw new RevitCourierCertificationError("CERTIFICATION_JOB_MISMATCH", "Generic certified courier job is not bound to revit_call_tool.");
  }
  if (envelope.channel !== "generic_call" && alias === "revit_call_tool") {
    throw new RevitCourierCertificationError("CERTIFICATION_JOB_MISMATCH", "Non-generic certified courier job cannot use revit_call_tool.");
  }
  if (own(envelope, "workflow")) {
    // Workflow text participates in the canonical envelope/effect identities.
    // It is allowed to contain line feeds (the cross-runtime canonicalization
    // explicitly normalizes them), unlike identifiers and target fields.
    const workflow = typeof envelope.workflow === "string" && envelope.workflow.length > 0
      && envelope.workflow.length <= 500 && !envelope.workflow.includes("\u0000")
      ? envelope.workflow
      : null;
    if (!workflow) throw new RevitCourierCertificationError("CERTIFICATION_JOB_MALFORMED", "Certification workflow is invalid.");
  }
  const runtimeMode = boundedSafeText(envelope.runtime_mode, "certification_envelope.runtime_mode", 80);
  if (!runtimeMode || runtimeMode !== normalizeRuntimeMode(runtimeMode)) {
    throw new RevitCourierCertificationError("CERTIFICATION_JOB_MALFORMED", "Certification runtime mode is not canonical.");
  }
  if (envelope.exposure_profile !== "certified") {
    throw new RevitCourierCertificationError("CERTIFICATION_JOB_MALFORMED", "Certification envelope must use the certified exposure profile.");
  }
  if (envelope.policy_trust_source !== "bundled" && envelope.policy_trust_source !== "deployment") {
    throw new RevitCourierCertificationError("CERTIFICATION_JOB_MALFORMED", "Certification envelope policy trust source is invalid.");
  }
  const { envelope_hash: declaredHash, ...payload } = envelope;
  if (declaredHash !== canonicalSha256Text(canonicalJson(payload as never))) {
    throw new RevitCourierCertificationError("CERTIFICATION_JOB_MISMATCH", "Certification envelope hash does not match its immutable contents.");
  }
  return envelope as unknown as RevitCourierCertificationEnvelope;
}

/**
 * Validates the durable v2 record against the b73c518 publisher contract.
 * The published raw JSON body is the authority. The compatibility `body`
 * member is checked only to ensure it cannot differ from that raw authority.
 */
export function parseCertifiedCourierJobV2(value: unknown): CertifiedCourierJobV2 {
  const job = asObject(value, "courier job");
  exactKeys(job, [
    "version", "id", "session_id", "message_id", "turn_token_sha256", "correlation_id", "idempotency_key",
    "method", "path", "target_executor_id", "target_document_title", "target_document_path", "body_json",
    "body_present", "certification_envelope", "created_at", "expires_at", "status", "claim"
  ], ["body", "finished_at", "error"], "courier job");
  if (job.version !== REVIT_COURIER_V2_JOB_VERSION) {
    throw new RevitCourierCertificationError("CERTIFICATION_JOB_MALFORMED", "Courier job is not a supported v2 certified job.");
  }
  if (own(job, "turn_token")) {
    throw new RevitCourierCertificationError("CERTIFICATION_JOB_MALFORMED", "Certified courier jobs must not persist a raw turn token.");
  }
  const id = requiredAsciiId(job.id, "courier job id");
  if (!ID.test(id) || job.correlation_id !== id || job.idempotency_key !== id) {
    throw new RevitCourierCertificationError("CERTIFICATION_JOB_MISMATCH", "Certified courier job id, correlation id, and idempotency key must be the same SHA-256 identity.");
  }
  const sessionId = requiredContextIdentity(job.session_id, "courier session_id");
  const messageId = boundedSafeText(job.message_id, "courier message_id", 200, true);
  const turnTokenHash = requiredHash(job.turn_token_sha256, "courier turn_token_sha256", true);
  const method = String(job.method ?? "");
  if ((method !== "GET" && method !== "POST") || normalizeMethod(method) !== method) {
    throw new RevitCourierCertificationError("CERTIFICATION_JOB_MALFORMED", "Certified courier method must be canonical GET or POST.");
  }
  const toolPath = String(job.path ?? "");
  if (!toolPath.startsWith("/revit/") || normalizeToolPath(toolPath) !== toolPath) {
    throw new RevitCourierCertificationError("CERTIFICATION_JOB_MALFORMED", "Certified courier path is not canonical.");
  }
  const targetExecutorId = boundedSafeText(job.target_executor_id, "courier target_executor_id", 200, true);
  const targetTitle = boundedSafeText(job.target_document_title, "courier target_document_title", 500, true);
  const targetPath = boundedSafeText(job.target_document_path, "courier target_document_path", 2000, true);
  if (typeof job.body_present !== "boolean" || typeof job.body_json !== "string") {
    throw new RevitCourierCertificationError("CERTIFICATION_JOB_MALFORMED", "Certified courier raw body contract is invalid.");
  }
  if (!job.body_present && job.body_json !== "") {
    throw new RevitCourierCertificationError("CERTIFICATION_JOB_MISMATCH", "Absent certified courier body must be represented by an empty raw body string.");
  }
  if (job.body_present) {
    try { JSON.parse(job.body_json); } catch {
      throw new RevitCourierCertificationError("CERTIFICATION_JOB_MALFORMED", "Certified courier raw body is not valid JSON.");
    }
    if (!own(job, "body")) {
      throw new RevitCourierCertificationError("CERTIFICATION_JOB_MISMATCH", "Certified courier raw body has no matching compatibility body.");
    }
    let compatibilityBody: string | undefined;
    try { compatibilityBody = typeof job.body === "string" ? job.body : JSON.stringify(job.body); } catch { /* terminal below */ }
    if (compatibilityBody !== job.body_json) {
      throw new RevitCourierCertificationError("CERTIFICATION_JOB_MISMATCH", "Compatibility body differs from the authoritative certified raw body.");
    }
  } else if (own(job, "body")) {
    throw new RevitCourierCertificationError("CERTIFICATION_JOB_MISMATCH", "Absent certified courier body must not retain a compatibility body.");
  }
  if (!isCanonicalIsoInstant(job.created_at) || !isCanonicalIsoInstant(job.expires_at)) {
    throw new RevitCourierCertificationError("CERTIFICATION_JOB_MALFORMED", "Certified courier timestamps are invalid.");
  }
  const createdAt = Date.parse(job.created_at);
  const expiresAt = Date.parse(job.expires_at);
  if (expiresAt < createdAt) throw new RevitCourierCertificationError("CERTIFICATION_JOB_MALFORMED", "Certified courier timestamps are invalid.");
  if (!["pending", "running", "succeeded", "failed"].includes(String(job.status))) {
    throw new RevitCourierCertificationError("CERTIFICATION_JOB_MALFORMED", "Certified courier status is invalid.");
  }
  if (job.status === "pending") {
    if (job.claim !== null) {
      throw new RevitCourierCertificationError("CERTIFICATION_JOB_MISMATCH", "Pending certified courier job must not carry a claim.");
    }
  } else if (job.status === "running") {
    const claim = asObject(job.claim, "certified courier claim");
    exactKeys(claim, ["executor_id", "claimed_at", "lease_expires_at"], [], "certified courier claim");
    requiredContextIdentity(claim.executor_id, "certified courier claim executor_id");
    if (!isCanonicalIsoInstant(claim.claimed_at) || !isCanonicalIsoInstant(claim.lease_expires_at)
      || Date.parse(claim.lease_expires_at) < Date.parse(claim.claimed_at)) {
      throw new RevitCourierCertificationError("CERTIFICATION_JOB_MALFORMED", "Certified courier claim timestamps are invalid.");
    }
  }
  const envelope = parseEnvelope(job.certification_envelope, job);
  const requestForHash = method === "GET"
    ? {}
    : job.body_present ? JSON.parse(job.body_json) : {};
  if (envelope.request_hash !== computeRequestHash(method, toolPath, requestForHash as never)) {
    throw new RevitCourierCertificationError("CERTIFICATION_JOB_MISMATCH", "Certification request hash does not match the authoritative raw body.");
  }
  const expectedIdempotency = hashV2Idempotency({
    schema: "revit-operator.revit-tool-job-idempotency.v2",
    canonicalization: REVIT_COURIER_CANONICALIZATION,
    session_id: sessionId,
    message_id: messageId,
    expires_at: job.expires_at,
    turn_token_sha256: turnTokenHash,
    target_executor_id: targetExecutorId,
    target_document_title: targetTitle,
    target_document_path: targetPath,
    method,
    path: toolPath,
    body_present: job.body_present,
    body_sha256: canonicalSha256Text(job.body_json),
    certification_envelope_hash: envelope.envelope_hash
  });
  if (expectedIdempotency !== id) {
    throw new RevitCourierCertificationError("CERTIFICATION_JOB_MISMATCH", "Certified courier idempotency identity does not match its exact durable contract.");
  }
  return job as unknown as CertifiedCourierJobV2;
}

function policyAllowsEnvelope(trusted: TrustedToolExposurePolicy, job: CertifiedCourierJobV2): void {
  const { policy, trustSource } = trusted;
  const envelope = job.certification_envelope;
  assertCurrentCertifiedRuntime(envelope);
  if (envelope.policy_hash !== policy.policy_hash || envelope.policy_trust_source !== trustSource) {
    throw new RevitCourierCertificationError("CERTIFICATION_POLICY_CHANGED", "Courier policy identity changed after durable publication.");
  }
  const matches = policy.records.filter(record =>
    record.method === envelope.method && record.path === envelope.path
    && record.request_hash === envelope.request_hash && record.effect_hash === envelope.effect_hash
  );
  if (matches.length !== 1) {
    throw new RevitCourierCertificationError(
      "CERTIFICATION_POLICY_DENIED",
      "Current courier policy no longer contains the exact certified method, path, request, and effect."
    );
  }
  const record = matches[0]!;
  // Preserve the courier contract: an immutable record/evidence identity
  // change is reported before evaluating its potentially changed exposure.
  if (record.policy_record_hash !== envelope.policy_record_hash || record.evidence_record_hash !== envelope.evidence_record_hash) {
    throw new RevitCourierCertificationError("CERTIFICATION_POLICY_CHANGED", "Courier policy record or evidence identity changed after durable publication.");
  }
  try {
    evaluateTrustedToolExposurePolicy({
      policy,
      method: envelope.method,
      path: envelope.path,
      requestHash: envelope.request_hash,
      effectHash: envelope.effect_hash,
      channel: envelope.channel,
      alias: envelope.alias
    }).record;
  } catch (error) {
    if (error instanceof TrustedToolExposurePolicyError) {
      throw new RevitCourierCertificationError(error.code, error.message.replace("Current certification policy", "Current courier policy"));
    }
    throw error;
  }
}

/** Revalidates the persisted v2 envelope against the current trusted policy immediately before Revit execution. */
export function authorizeCertifiedCourierFinalExecution(value: unknown, executorId: string): CertifiedCourierFinalAuthorization {
  const job = parseCertifiedCourierJobV2(value);
  const executor = requiredContextIdentity(executorId, "executor_id");
  if (job.target_executor_id && job.target_executor_id !== executor) {
    throw new RevitCourierCertificationError("CERTIFICATION_EXECUTOR_MISMATCH", "Certified courier job target executor does not match the claiming workstation.");
  }
  let trusted: TrustedToolExposurePolicy;
  try {
    trusted = loadTrustedToolExposurePolicy();
  } catch (error) {
    if (error instanceof TrustedToolExposurePolicyError) {
      throw new RevitCourierCertificationError(error.code, error.message.replace("certification policy", "courier certification policy"));
    }
    throw error;
  }
  policyAllowsEnvelope(trusted, job);
  const envelope = job.certification_envelope;
  return {
    version: REVIT_COURIER_FINAL_AUTHORIZATION_VERSION,
    phase: "certification_final_execution",
    authorized_at: new Date().toISOString(),
    job_id: job.id,
    correlation_id: job.correlation_id,
    session_id: job.session_id,
    executor_id: executor,
    target_executor_id: job.target_executor_id,
    target_document_title: job.target_document_title,
    target_document_path: job.target_document_path,
    method: job.method,
    path: job.path,
    body_present: job.body_present,
    body_json: job.body_json,
    policy_hash: envelope.policy_hash,
    policy_record_hash: envelope.policy_record_hash,
    evidence_record_hash: envelope.evidence_record_hash,
    request_hash: envelope.request_hash,
    effect_hash: envelope.effect_hash,
    channel: envelope.channel,
    alias: envelope.alias,
    ...(envelope.workflow === undefined ? {} : { workflow: envelope.workflow }),
    runtime_mode: envelope.runtime_mode,
    exposure_profile: envelope.exposure_profile,
    policy_trust_source: envelope.policy_trust_source,
    certification_envelope_hash: envelope.envelope_hash
  };
}
