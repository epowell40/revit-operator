import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  canonicalJson,
  computeRequestHash,
  normalizeMethod,
  normalizeToolPath,
  sha256,
  type ExposureChannel,
  type ToolExposurePolicy,
  type ToolExposurePolicyRecord
} from "../capabilities/tool_certification.js";

export const REVIT_COURIER_V2_JOB_VERSION = "revit-operator.revit-tool-job.v2";
export const REVIT_COURIER_CERTIFICATION_ENVELOPE_SCHEMA = "revit-operator.revit-tool-certification-envelope.v1";
export const REVIT_COURIER_FINAL_AUTHORIZATION_VERSION = "revit-operator.revit-tool-final-authorization.v1";
export const REVIT_COURIER_CANONICALIZATION = "revit-operator.canonical-json.nfc-key-sorted.v1";

const SHA256 = /^sha256:[0-9a-f]{64}$/;
const ID = /^[a-f0-9]{64}$/;
const ALIAS = /^[a-z][a-z0-9_]*$/;
const POLICY_FILENAME = "tool_exposure_policy.v1.json";
const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
// This is a reviewed deployment anchor. It is never derived from a job or a
// policy file. A deployed policy may use an independently configured anchor.
const BUNDLED_POLICY_HASH = "sha256:d6204c2576e83a96586f0b4bc575d7f68c7325e3efb32566ba6204e1aa3d2624";
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

function policyPathFromTrustedDeployment(): { policyPath: string; trustedHash: string; trustSource: "bundled" | "deployment" } {
  const explicitPath = String(process.env.OPERATOR_TOOL_EXPOSURE_POLICY_PATH ?? "").trim();
  const explicitHash = String(process.env.OPERATOR_TOOL_EXPOSURE_POLICY_SHA256 ?? "").trim();
  if (explicitPath) {
    if (path.extname(explicitPath).toLowerCase() !== ".json" || !SHA256.test(explicitHash)) {
      throw new RevitCourierCertificationError("CERTIFICATION_POLICY_UNAVAILABLE", "Deployment courier certification policy path or trusted hash is invalid.");
    }
    return { policyPath: path.resolve(explicitPath), trustedHash: explicitHash, trustSource: "deployment" };
  }
  if (explicitHash && !SHA256.test(explicitHash)) {
    throw new RevitCourierCertificationError("CERTIFICATION_POLICY_UNAVAILABLE", "Deployment courier certification policy hash is invalid.");
  }
  return {
    policyPath: path.resolve(MODULE_DIR, "../../config", POLICY_FILENAME),
    trustedHash: explicitHash || BUNDLED_POLICY_HASH,
    trustSource: explicitHash ? "deployment" : "bundled"
  };
}

function parsePolicy(value: unknown): ToolExposurePolicy {
  const policy = asObject(value, "certification policy");
  exactKeys(policy, ["schema", "hash_algorithm", "evidence_schema", "evidence_source_hash", "records", "policy_hash"], [], "certification policy");
  if (policy.schema !== "revit-operator.tool-exposure-policy.v1" || policy.hash_algorithm !== "sha256"
    || policy.evidence_schema !== "revit-operator.tool-certification-evidence.v1") {
    throw new RevitCourierCertificationError("CERTIFICATION_POLICY_INVALID", "Courier certification policy schema is unsupported.");
  }
  requiredHash(policy.evidence_source_hash, "certification policy evidence source hash");
  const declaredHash = requiredHash(policy.policy_hash, "certification policy hash")!;
  if (!Array.isArray(policy.records) || policy.records.length === 0) {
    throw new RevitCourierCertificationError("CERTIFICATION_POLICY_INVALID", "Courier certification policy has no records.");
  }
  const identities = new Set<string>();
  for (const [index, raw] of policy.records.entries()) {
    const record = asObject(raw, `certification policy record ${index}`);
    exactKeys(record, [
      "method", "path", "typed_mcp_aliases", "request_hash", "effect_hash", "evidence_record_hash",
      "highest_cumulative_level", "observed_levels", "visibility", "channels", "policy_record_hash"
    ], [], `certification policy record ${index}`);
    if (normalizeMethod(String(record.method ?? "")) !== record.method || normalizeToolPath(String(record.path ?? "")) !== record.path) {
      throw new RevitCourierCertificationError("CERTIFICATION_POLICY_INVALID", "Courier certification policy record method/path is noncanonical.");
    }
    for (const field of ["request_hash", "effect_hash", "evidence_record_hash", "policy_record_hash"] as const) {
      requiredHash(record[field], `certification policy record ${index}.${field}`);
    }
    if (!Array.isArray(record.typed_mcp_aliases) || record.typed_mcp_aliases.some(alias => typeof alias !== "string" || !ALIAS.test(alias))) {
      throw new RevitCourierCertificationError("CERTIFICATION_POLICY_INVALID", "Courier certification policy aliases are invalid.");
    }
    if (record.typed_mcp_aliases.includes("revit_call_tool")) {
      throw new RevitCourierCertificationError("CERTIFICATION_POLICY_INVALID", "Courier certification policy cannot bind revit_call_tool as a typed alias.");
    }
    const channels = asObject(record.channels, `certification policy record ${index}.channels`);
    exactKeys(channels, CHANNELS, [], `certification policy record ${index}.channels`);
    for (const channel of CHANNELS) {
      const decision = asObject(channels[channel], `certification policy record ${index}.channels.${channel}`);
      exactKeys(decision, ["exposed", "required_level", "reason_codes"], [], `certification policy record ${index}.channels.${channel}`);
      if (typeof decision.exposed !== "boolean" || !/^L[0-5]$/.test(String(decision.required_level))
        || !Array.isArray(decision.reason_codes) || decision.reason_codes.some(reason => typeof reason !== "string")) {
        throw new RevitCourierCertificationError("CERTIFICATION_POLICY_INVALID", "Courier certification policy channel decision is invalid.");
      }
    }
    const { policy_record_hash: recordHash, ...recordPayload } = record;
    if (recordHash !== sha256(recordPayload as never)) {
      throw new RevitCourierCertificationError("CERTIFICATION_POLICY_INVALID", "Courier certification policy record hash is invalid.");
    }
    const identity = `${record.method}\n${record.path}\n${record.request_hash}\n${record.effect_hash}`;
    if (identities.has(identity)) throw new RevitCourierCertificationError("CERTIFICATION_POLICY_INVALID", "Courier certification policy has duplicate exact records.");
    identities.add(identity);
  }
  const { policy_hash: _policyHash, ...payload } = policy;
  if (declaredHash !== sha256(payload as never)) {
    throw new RevitCourierCertificationError("CERTIFICATION_POLICY_INVALID", "Courier certification policy hash is invalid.");
  }
  return policy as unknown as ToolExposurePolicy;
}

function loadTrustedCurrentPolicy(): { policy: ToolExposurePolicy; trustSource: "bundled" | "deployment" } {
  const configured = policyPathFromTrustedDeployment();
  let raw: string;
  try { raw = fs.readFileSync(configured.policyPath, "utf8"); } catch {
    throw new RevitCourierCertificationError("CERTIFICATION_POLICY_UNAVAILABLE", "Current courier certification policy is unavailable.");
  }
  let policy: ToolExposurePolicy;
  try { policy = parsePolicy(JSON.parse(raw.replace(/^\uFEFF/, ""))); } catch (error) {
    if (error instanceof RevitCourierCertificationError) throw error;
    throw new RevitCourierCertificationError("CERTIFICATION_POLICY_INVALID", "Current courier certification policy is malformed.");
  }
  if (policy.policy_hash !== configured.trustedHash) {
    throw new RevitCourierCertificationError("CERTIFICATION_POLICY_ROLLBACK_REJECTED", "Current courier certification policy does not match its trusted deployment anchor.");
  }
  return { policy, trustSource: configured.trustSource };
}

function policyAllowsEnvelope(policy: ToolExposurePolicy, trustSource: "bundled" | "deployment", job: CertifiedCourierJobV2): void {
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
    throw new RevitCourierCertificationError("CERTIFICATION_POLICY_DENIED", "Current courier policy no longer contains the exact certified method, path, request, and effect.");
  }
  const record = matches[0]!;
  if (record.policy_record_hash !== envelope.policy_record_hash || record.evidence_record_hash !== envelope.evidence_record_hash) {
    throw new RevitCourierCertificationError("CERTIFICATION_POLICY_CHANGED", "Courier policy record or evidence identity changed after durable publication.");
  }
  const channelDecision = record.channels[envelope.channel];
  if (!channelDecision?.exposed || (record.visibility === "workflow_only" && envelope.channel !== "deterministic_workflow")) {
    throw new RevitCourierCertificationError("CERTIFICATION_POLICY_DENIED", "Current courier policy does not expose this exact channel.");
  }
  if (envelope.channel === "generic_call") {
    if (envelope.alias !== "revit_call_tool") throw new RevitCourierCertificationError("CERTIFICATION_POLICY_DENIED", "Generic courier alias is invalid.");
    return;
  }
  if (envelope.channel === "deterministic_workflow") return;
  const aliasRecords = policy.records.filter(candidate => candidate.typed_mcp_aliases.includes(envelope.alias));
  const aliasChannel = envelope.channel === "search" ? "search" : "typed_mcp";
  const routeBindsAlias = record.typed_mcp_aliases.includes(envelope.alias);
  const conjunctionAllowed = aliasRecords.length > 0 && aliasRecords.every(candidate =>
    candidate.visibility !== "workflow_only" && candidate.channels[aliasChannel].exposed
  );
  if (!routeBindsAlias || !conjunctionAllowed) {
    throw new RevitCourierCertificationError("CERTIFICATION_POLICY_DENIED", "Current courier policy no longer exposes the exact bound alias conjunction.");
  }
}

/** Revalidates the persisted v2 envelope against the current trusted policy immediately before Revit execution. */
export function authorizeCertifiedCourierFinalExecution(value: unknown, executorId: string): CertifiedCourierFinalAuthorization {
  const job = parseCertifiedCourierJobV2(value);
  const executor = requiredContextIdentity(executorId, "executor_id");
  if (job.target_executor_id && job.target_executor_id !== executor) {
    throw new RevitCourierCertificationError("CERTIFICATION_EXECUTOR_MISMATCH", "Certified courier job target executor does not match the claiming workstation.");
  }
  const { policy, trustSource } = loadTrustedCurrentPolicy();
  policyAllowsEnvelope(policy, trustSource, job);
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
