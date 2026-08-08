import { createHash, createPublicKey, verify } from "node:crypto";
import {
  canonicalJson,
  computeRequestHash,
  normalizeMethod,
  normalizeToolPath,
  type ExposureChannel,
  type JsonValue,
} from "../capabilities/tool_certification.js";
import {
  evaluateTrustedToolExposurePolicy,
  loadTrustedToolExposurePolicy,
  TrustedToolExposurePolicyError,
  type TrustedToolExposurePolicy
} from "../capabilities/trusted_tool_exposure_policy.js";
import {
  CertifiedRequestFamilyAdmissionError,
  certifiedRequestFamilyEffectHash,
  finalizeCertifiedRequestFamilyAdmission,
  validateCertifiedRequestFamilyAdmission,
  type CertifiedRequestFamilyAdmission,
  type ValidatedCertifiedRequestFamilyAdmission
} from "../capabilities/certified_request_family_admission.js";

export const REVIT_COURIER_V2_JOB_VERSION = "revit-operator.revit-tool-job.v2";
export const REVIT_COURIER_CERTIFICATION_ENVELOPE_V1_SCHEMA = "revit-operator.revit-tool-certification-envelope.v1";
export const REVIT_COURIER_CERTIFICATION_ENVELOPE_V2_SCHEMA = "revit-operator.revit-tool-certification-envelope.v2";
export const REVIT_COURIER_CERTIFICATION_ENVELOPE_SCHEMA = REVIT_COURIER_CERTIFICATION_ENVELOPE_V1_SCHEMA;
export const REVIT_COURIER_FINAL_AUTHORIZATION_V1_VERSION = "revit-operator.revit-tool-final-authorization.v1";
export const REVIT_COURIER_FINAL_AUTHORIZATION_V2_VERSION = "revit-operator.revit-tool-final-authorization.v2";
export const REVIT_COURIER_FINAL_AUTHORIZATION_VERSION = REVIT_COURIER_FINAL_AUTHORIZATION_V1_VERSION;
export const REVIT_COURIER_CANONICALIZATION = "revit-operator.canonical-json.nfc-key-sorted.v1";

const SHA256 = /^sha256:[0-9a-f]{64}$/;
const ID = /^[a-f0-9]{64}$/;
const ALIAS = /^[a-z][a-z0-9_]*$/;
const CHANNELS: readonly ExposureChannel[] = ["search", "generic_call", "typed_mcp", "deterministic_workflow"];

export type RevitCourierCertificationEnvelope = {
  schema: typeof REVIT_COURIER_CERTIFICATION_ENVELOPE_V1_SCHEMA | typeof REVIT_COURIER_CERTIFICATION_ENVELOPE_V2_SCHEMA;
  version: 1 | 2;
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
  request_family_admission?: CertifiedRequestFamilyAdmission;
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
  version: typeof REVIT_COURIER_FINAL_AUTHORIZATION_V1_VERSION | typeof REVIT_COURIER_FINAL_AUTHORIZATION_V2_VERSION;
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
  authorization_stage?: "preflight" | "final";
  request_family_admission?: CertifiedRequestFamilyAdmission;
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
  return env.REVIT_OPERATOR_MODE === "development"
    && env.OPERATOR_TOOL_EXPOSURE_PROFILE === "laboratory";
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
  const isFamilyEnvelope = envelope.schema === REVIT_COURIER_CERTIFICATION_ENVELOPE_V2_SCHEMA;
  exactKeys(envelope, [
    "schema", "version", "canonicalization", "policy_hash", "policy_record_hash", "evidence_record_hash",
    "request_hash", "effect_hash", "method", "path", "body_present", "body_sha256", "channel", "alias",
    "runtime_mode", "exposure_profile", "policy_trust_source", "envelope_hash",
    ...(isFamilyEnvelope ? ["request_family_admission"] : [])
  ], ["workflow"], "certification_envelope");
  if ((!isFamilyEnvelope && (envelope.schema !== REVIT_COURIER_CERTIFICATION_ENVELOPE_V1_SCHEMA || envelope.version !== 1))
    || (isFamilyEnvelope && envelope.version !== 2)
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
  if (isFamilyEnvelope) {
    let parsedBody: JsonValue;
    try { parsedBody = JSON.parse(job.body_json as string) as JsonValue; }
    catch { throw new RevitCourierCertificationError("CERTIFICATION_JOB_MALFORMED", "Request-family courier body is not valid JSON."); }
    try {
      const familyAdmission = validateCertifiedRequestFamilyAdmission(envelope.request_family_admission, {
        method: envelope.method as string,
        path: envelope.path as string,
        body: parsedBody,
        bodyJson: job.body_json as string
      });
      envelope.request_family_admission = familyAdmission;
      if (envelope.effect_hash !== certifiedRequestFamilyEffectHash(familyAdmission)) {
        throw new RevitCourierCertificationError(
          "CERTIFICATION_REQUEST_FAMILY_DENIED",
          "Courier request-family phase does not bind the exact reviewed preview/apply effect."
        );
      }
    } catch (error) {
      if (error instanceof CertifiedRequestFamilyAdmissionError) {
        throw new RevitCourierCertificationError(error.code, error.message);
      }
      throw error;
    }
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
  const expectedRequestHash = envelope.request_family_admission?.request_instance_hash
    ?? computeRequestHash(method, toolPath, requestForHash as never);
  if (envelope.request_hash !== expectedRequestHash) {
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
  const requestFamilyAdmission = envelope.request_family_admission as ValidatedCertifiedRequestFamilyAdmission | undefined;
  const matches = policy.records.filter(record =>
    record.method === envelope.method && record.path === envelope.path
    && (requestFamilyAdmission
      ? record.request_family?.id === requestFamilyAdmission.family_id
        && record.request_family.validator_hash === requestFamilyAdmission.family_hash
      : record.request_hash === envelope.request_hash)
    && record.effect_hash === envelope.effect_hash
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
      alias: envelope.alias,
      requestFamilyAdmission
    }).record;
  } catch (error) {
    if (error instanceof TrustedToolExposurePolicyError) {
      throw new RevitCourierCertificationError(error.code, error.message.replace("Current certification policy", "Current courier policy"));
    }
    throw error;
  }
}

/** Revalidates the persisted v2 envelope against the current trusted policy immediately before Revit execution. */
export function authorizeCertifiedCourierFinalExecution(
  value: unknown,
  executorId: string,
  authorizationStage?: "preflight" | "final"
): CertifiedCourierFinalAuthorization {
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
  if (!envelope.request_family_admission && authorizationStage !== undefined) {
    throw new RevitCourierCertificationError(
      "CERTIFICATION_JOB_MALFORMED",
      "Exact courier authorization cannot carry a request-family authorization_stage."
    );
  }
  if (envelope.request_family_admission && authorizationStage !== "preflight" && authorizationStage !== "final") {
    throw new RevitCourierCertificationError(
      "CERTIFICATION_JOB_MALFORMED",
      "Certified request-family courier authorization requires a preflight or final authorization_stage."
    );
  }
  if (envelope.request_family_admission && authorizationStage === "final") {
    try {
      finalizeCertifiedRequestFamilyAdmission(
        envelope.request_family_admission as ValidatedCertifiedRequestFamilyAdmission,
        job.body_json
      );
    } catch (error) {
      if (error instanceof CertifiedRequestFamilyAdmissionError) {
        throw new RevitCourierCertificationError(error.code, error.message);
      }
      throw error;
    }
  }
  return {
    version: envelope.request_family_admission
      ? REVIT_COURIER_FINAL_AUTHORIZATION_V2_VERSION
      : REVIT_COURIER_FINAL_AUTHORIZATION_V1_VERSION,
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
    ...(envelope.request_family_admission === undefined ? {} : { authorization_stage: authorizationStage! }),
    ...(envelope.request_family_admission === undefined ? {} : { request_family_admission: envelope.request_family_admission }),
    certification_envelope_hash: envelope.envelope_hash
  };
}

const FAMILY_EXECUTION_RECEIPT_KEYS = [
  "schema", "phase", "request_instance_hash", "family_id", "family_hash", "document_fingerprint",
  "document_session_id", "source_scoped_id", "element_id", "observation_id", "observation_binding_hash",
  "admission_session_id", "policy_hash", "policy_record_hash", "evidence_record_hash", "effect_hash",
  "channel", "alias", "outcome", "affected_element_ids", "outcome_unknown", "result_hash",
  "native_attestation_key_id", "native_attestation_signature"
] as const;

const CERTIFIED_MOVE_RESULT_KEYS = [
  "status", "movedIds", "skipped", "warnings", "snapshots", "movedTogether", "rolledBack",
  "certified_execution_receipt"
] as const;

function doubleBits(value: unknown, location: string): string {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new RevitCourierCertificationError(
      "CERTIFICATION_EXECUTION_ATTESTATION_INVALID",
      `${location} must be a finite number.`
    );
  }
  const buffer = Buffer.allocUnsafe(8);
  buffer.writeDoubleBE(value, 0);
  return buffer.toString("hex");
}

function certifiedMoveResultProjection(
  result: Record<string, unknown>,
  admission: CertifiedRequestFamilyAdmission
): Record<string, unknown> {
  exactKeys(
    result,
    admission.phase === "preview"
      ? [...CERTIFIED_MOVE_RESULT_KEYS, "certified_preview_receipt"]
      : CERTIFIED_MOVE_RESULT_KEYS,
    [],
    "certified courier execution result"
  );
  const expectedStatus = admission.phase === "preview" ? "Dry Run" : "Moved";
  const expectedRolledBack = admission.phase === "preview";
  if (result.status !== expectedStatus
    || result.movedTogether !== false
    || result.rolledBack !== expectedRolledBack
    || !Array.isArray(result.movedIds)
    || result.movedIds.length !== 1
    || result.movedIds[0] !== admission.element_id
    || !Array.isArray(result.skipped)
    || result.skipped.length !== 0
    || !Array.isArray(result.warnings)
    || result.warnings.some(item => typeof item !== "string")
    || !Array.isArray(result.snapshots)
    || result.snapshots.length !== 1) {
    throw new RevitCourierCertificationError(
      "CERTIFICATION_EXECUTION_ATTESTATION_INVALID",
      "Native move result does not prove the exact certified one-element outcome."
    );
  }
  const snapshot = asObject(result.snapshots[0], "certified move snapshot");
  exactKeys(snapshot, ["id", "before", "after"], [], "certified move snapshot");
  if (snapshot.id !== admission.element_id) {
    throw new RevitCourierCertificationError(
      "CERTIFICATION_EXECUTION_ATTESTATION_INVALID",
      "Native move snapshot does not match the certified target."
    );
  }
  const projectPoint = (value: unknown, location: string): Record<string, unknown> => {
    const point = asObject(value, location);
    exactKeys(point, ["kind", "pointXyz"], [], location);
    if (point.kind !== "LocationPoint" || !Array.isArray(point.pointXyz) || point.pointXyz.length !== 3) {
      throw new RevitCourierCertificationError(
        "CERTIFICATION_EXECUTION_ATTESTATION_INVALID",
        `${location} must be an exact LocationPoint snapshot.`
      );
    }
    return {
      kind: "LocationPoint",
      point_bits: point.pointXyz.map((coordinate, index) => doubleBits(coordinate, `${location}.pointXyz[${index}]`))
    };
  };
  return {
    status: result.status,
    movedIds: result.movedIds,
    skipped: [],
    warnings: result.warnings,
    snapshots: [{
      id: snapshot.id,
      before: projectPoint(snapshot.before, "certified move snapshot.before"),
      after: projectPoint(snapshot.after, "certified move snapshot.after")
    }],
    movedTogether: false,
    rolledBack: expectedRolledBack
  };
}

/**
 * Verifies the native Revit-thread outcome receipt before a courier job may be
 * durably marked succeeded. The job id already binds the envelope; this check
 * binds the returned outcome and exact affected target back to that envelope.
 */
export function assertCertifiedCourierExecutionResult(value: unknown, resultValue: unknown): void {
  const job = parseCertifiedCourierJobV2(value);
  const envelope = job.certification_envelope;
  const admission = envelope.request_family_admission;
  if (!admission) return;
  const result = asObject(resultValue, "certified courier execution result");
  const receipt = asObject(result.certified_execution_receipt, "certified_execution_receipt");
  exactKeys(receipt, FAMILY_EXECUTION_RECEIPT_KEYS, [], "certified_execution_receipt");
  const expectedOutcome = admission.phase === "preview" ? "rolled_back" : "committed";
  const exactBindings: Array<[unknown, unknown]> = [
    [receipt.schema, "revit-operator.certified-family-execution-receipt.v1"],
    [receipt.phase, admission.phase],
    [receipt.request_instance_hash, admission.request_instance_hash],
    [receipt.family_id, admission.family_id],
    [receipt.family_hash, admission.family_hash],
    [receipt.document_fingerprint, admission.document_fingerprint],
    [receipt.document_session_id, admission.document_session_id],
    [receipt.source_scoped_id, admission.source_scoped_id],
    [receipt.element_id, admission.element_id],
    [receipt.observation_id, admission.observation_id],
    [receipt.observation_binding_hash, admission.observation_binding_hash],
    [receipt.admission_session_id, admission.admission_session_id],
    [receipt.policy_hash, envelope.policy_hash],
    [receipt.policy_record_hash, envelope.policy_record_hash],
    [receipt.evidence_record_hash, envelope.evidence_record_hash],
    [receipt.effect_hash, envelope.effect_hash],
    [receipt.channel, envelope.channel],
    [receipt.alias, envelope.alias],
    [receipt.outcome, expectedOutcome],
    [receipt.outcome_unknown, false],
    [receipt.native_attestation_key_id, admission.native_attestation_key_id]
  ];
  if (exactBindings.some(([actual, expected]) => actual !== expected)
    || !Array.isArray(receipt.affected_element_ids)
    || receipt.affected_element_ids.length !== 1
    || receipt.affected_element_ids[0] !== admission.element_id) {
    throw new RevitCourierCertificationError(
      "CERTIFICATION_EXECUTION_RECEIPT_INVALID",
      "Native execution receipt does not match the exact certified family, request, document, target, policy, effect, channel, or outcome."
    );
  }

  const expectedResultHash = canonicalSha256Text(canonicalJson(certifiedMoveResultProjection(result, admission) as never));
  if (receipt.result_hash !== expectedResultHash
    || typeof receipt.native_attestation_signature !== "string"
    || !/^[A-Za-z0-9_-]+$/.test(receipt.native_attestation_signature)) {
    throw new RevitCourierCertificationError(
      "CERTIFICATION_EXECUTION_ATTESTATION_INVALID",
      "Native execution result hash or attestation signature is invalid."
    );
  }
  const { native_attestation_signature: _signature, ...signedReceipt } = receipt;
  try {
    const key = createPublicKey({
      key: {
        kty: "RSA",
        alg: "RS256",
        n: admission.native_attestation_modulus_base64url,
        e: admission.native_attestation_exponent_base64url
      },
      format: "jwk"
    });
    if (!verify(
      "sha256",
      Buffer.from(canonicalJson(signedReceipt as never), "utf8"),
      key,
      Buffer.from(receipt.native_attestation_signature, "base64url")
    )) throw new Error("signature mismatch");
  } catch {
    throw new RevitCourierCertificationError(
      "CERTIFICATION_EXECUTION_ATTESTATION_INVALID",
      "Courier completion is not signed by the exact native authority observed for this request."
    );
  }

  if (admission.phase === "preview") {
    const preview = asObject(result.certified_preview_receipt, "certified_preview_receipt");
    exactKeys(preview, [
      "schema", "preview_receipt", "preview_receipt_hash", "preview_instance_hash", "admission_session_id", "issued_at_utc"
    ], [], "certified_preview_receipt");
    if (preview.schema !== "revit-operator.certified-move-preview-receipt.v1"
      || typeof preview.preview_receipt !== "string" || !/^cmpr1_[A-Za-z0-9_-]{43}$/.test(preview.preview_receipt)
      || preview.preview_receipt_hash !== canonicalSha256Text(preview.preview_receipt)
      || preview.preview_instance_hash !== admission.request_instance_hash
      || preview.admission_session_id !== admission.admission_session_id
      || !isCanonicalIsoInstant(preview.issued_at_utc)) {
      throw new RevitCourierCertificationError(
        "CERTIFICATION_EXECUTION_RECEIPT_INVALID",
        "Native rollback preview receipt is absent or does not match the exact certified preview lineage."
      );
    }
  } else if (own(result, "certified_preview_receipt")) {
    throw new RevitCourierCertificationError(
      "CERTIFICATION_EXECUTION_RECEIPT_INVALID",
      "Committed apply result cannot carry a rollback preview receipt."
    );
  }
}
