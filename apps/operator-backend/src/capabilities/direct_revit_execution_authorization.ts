import { createHash } from "node:crypto";
import {
  canonicalJson,
  computeRequestHash,
  normalizeMethod,
  normalizeToolPath,
  sha256,
  type JsonValue
} from "./tool_certification.js";
import {
  evaluateTrustedToolExposurePolicy,
  loadTrustedToolExposurePolicy,
  TrustedToolExposurePolicyError
} from "./trusted_tool_exposure_policy.js";

export const DIRECT_REVIT_EXECUTION_AUTHORIZATION_VERSION = "revit-operator.revit-direct-final-authorization.v1";
export const DIRECT_REVIT_ADMISSION_REQUEST_SCHEMA = "revit-operator.revit-direct-admission-request.v1";
export const DIRECT_REVIT_AUTHORIZATION_VALID_FOR_MS = 5_000;
export const DIRECT_REVIT_AUTHORIZATION_MAX_BODY_BYTES = 2 * 1024 * 1024;
// body_json is itself JSON-escaped in the authorization request wrapper.
export const DIRECT_REVIT_AUTHORIZATION_HTTP_MAX_BYTES = (DIRECT_REVIT_AUTHORIZATION_MAX_BODY_BYTES * 2) + 16 * 1024;

const DIRECT_REQUEST_KEYS = ["schema", "request_id", "method", "path", "body_present", "body_json"] as const;
const REQUEST_ID = /^(?:[0-9a-f]{32}|[0-9a-f]{64})$/;

export type DirectRevitExecutionAuthorization = {
  version: typeof DIRECT_REVIT_EXECUTION_AUTHORIZATION_VERSION;
  phase: "certification_native_direct_admission";
  authorized_at: string;
  valid_for_ms: typeof DIRECT_REVIT_AUTHORIZATION_VALID_FOR_MS;
  request_id: string;
  method: "GET" | "POST";
  path: string;
  body_present: boolean;
  body_sha256: string;
  policy_hash: string;
  policy_record_hash: string;
  evidence_record_hash: string;
  request_hash: string;
  effect_hash: string;
  channel: "generic_call";
  runtime_mode: string;
  exposure_profile: "certified";
  policy_trust_source: "bundled" | "deployment";
  authorization_hash: string;
};

export class DirectRevitExecutionAuthorizationError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: 400 | 403 | 503,
    readonly retryable: boolean
  ) {
    super(message);
    this.name = "DirectRevitExecutionAuthorizationError";
  }
}

function malformed(message: string): never {
  throw new DirectRevitExecutionAuthorizationError("CERTIFICATION_DIRECT_REQUEST_MALFORMED", message, 400, false);
}

function asExactRequest(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) malformed("Direct Revit authorization request must be an object.");
  const request = value as Record<string, unknown>;
  const expected = new Set<string>(DIRECT_REQUEST_KEYS);
  for (const key of Object.keys(request)) {
    if (!expected.has(key)) malformed(`Direct Revit authorization request contains unknown field ${key}.`);
  }
  for (const key of DIRECT_REQUEST_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(request, key)) malformed(`Direct Revit authorization request is missing ${key}.`);
  }
  return request;
}

function normalizeRuntimeMode(value: unknown): string {
  return String(value ?? "local").trim().toLowerCase().replace(/-/g, "_") || "local";
}

function isDevelopmentLaboratory(env: NodeJS.ProcessEnv): boolean {
  return env.REVIT_OPERATOR_MODE === "development"
    && env.OPERATOR_TOOL_EXPOSURE_PROFILE === "laboratory";
}

function bodySha256(bodyJson: string): string {
  return `sha256:${createHash("sha256").update(bodyJson, "utf8").digest("hex")}`;
}

function mapTrustedPolicyError(error: TrustedToolExposurePolicyError): DirectRevitExecutionAuthorizationError {
  if (error.code === "CERTIFICATION_POLICY_DENIED") {
    return new DirectRevitExecutionAuthorizationError(error.code, error.message, 403, false);
  }
  return new DirectRevitExecutionAuthorizationError(error.code, error.message, 503, true);
}

export function authorizeDirectRevitExecution(
  value: unknown,
  env: NodeJS.ProcessEnv = process.env,
  now: Date = new Date()
): DirectRevitExecutionAuthorization {
  const request = asExactRequest(value);
  if (request.schema !== DIRECT_REVIT_ADMISSION_REQUEST_SCHEMA) {
    malformed("Direct Revit authorization request schema is unsupported.");
  }
  if (typeof request.request_id !== "string" || !REQUEST_ID.test(request.request_id)) {
    malformed("Direct Revit authorization request_id must be 32 or 64 lowercase hexadecimal characters.");
  }
  const requestId = request.request_id;
  if (request.method !== "GET" && request.method !== "POST") {
    malformed("Direct Revit authorization method must be canonical GET or POST.");
  }
  const method = request.method as "GET" | "POST";
  try {
    if (normalizeMethod(method) !== method) malformed("Direct Revit authorization method must be canonical GET or POST.");
  } catch {
    malformed("Direct Revit authorization method must be canonical GET or POST.");
  }
  if (typeof request.path !== "string") malformed("Direct Revit authorization path must be a canonical Revit path.");
  const toolPath = request.path as string;
  try {
    if (normalizeToolPath(toolPath) !== toolPath) malformed("Direct Revit authorization path must be a canonical Revit path.");
  } catch {
    malformed("Direct Revit authorization path must be a canonical Revit path.");
  }
  if (typeof request.body_present !== "boolean" || typeof request.body_json !== "string") {
    malformed("Direct Revit authorization body contract is invalid.");
  }
  const bodyPresent = request.body_present as boolean;
  const bodyJson = request.body_json as string;
  if (Buffer.byteLength(bodyJson, "utf8") > DIRECT_REVIT_AUTHORIZATION_MAX_BODY_BYTES) {
    malformed("Direct Revit authorization body exceeds the 2 MiB UTF-8 limit.");
  }
  if (!bodyPresent && bodyJson !== "") {
    malformed("An absent direct Revit body must use an empty body_json string.");
  }
  if (method === "GET" && bodyPresent) {
    malformed("Direct Revit GET authorization cannot include a body.");
  }
  if (method === "POST" && !bodyPresent) {
    malformed("Direct Revit POST authorization requires a present JSON body.");
  }
  let parsedBody: JsonValue = {};
  if (bodyPresent) {
    try {
      parsedBody = JSON.parse(bodyJson) as JsonValue;
      // Canonicalization rejects non-JSON runtime values and NFC key collisions.
      canonicalJson(parsedBody);
    } catch {
      malformed("Direct Revit authorization body_json must contain canonicalizable UTF-8 JSON.");
    }
  }
  if (isDevelopmentLaboratory(env)) {
    throw new DirectRevitExecutionAuthorizationError(
      "CERTIFICATION_RUNTIME_PROFILE_MISMATCH",
      "Certified direct Revit authorization is unavailable in the explicit development laboratory profile.",
      403,
      false
    );
  }

  const runtimeMode = normalizeRuntimeMode(env.REVIT_OPERATOR_MODE);
  const requestHash = computeRequestHash(method, toolPath, method === "GET" ? {} : parsedBody);
  try {
    const trusted = loadTrustedToolExposurePolicy(env);
    const evaluation = evaluateTrustedToolExposurePolicy({
      policy: trusted.policy,
      method,
      path: toolPath,
      requestHash,
      channel: "generic_call",
      alias: "revit_call_tool"
    });
    const record = evaluation.record;
    const payload = {
      version: DIRECT_REVIT_EXECUTION_AUTHORIZATION_VERSION as typeof DIRECT_REVIT_EXECUTION_AUTHORIZATION_VERSION,
      phase: "certification_native_direct_admission" as const,
      authorized_at: now.toISOString(),
      valid_for_ms: DIRECT_REVIT_AUTHORIZATION_VALID_FOR_MS as typeof DIRECT_REVIT_AUTHORIZATION_VALID_FOR_MS,
      request_id: requestId,
      method,
      path: toolPath,
      body_present: bodyPresent,
      body_sha256: bodySha256(bodyJson),
      policy_hash: trusted.policy.policy_hash,
      policy_record_hash: record.policy_record_hash,
      evidence_record_hash: record.evidence_record_hash,
      request_hash: record.request_hash,
      effect_hash: record.effect_hash,
      channel: "generic_call" as const,
      runtime_mode: runtimeMode,
      exposure_profile: "certified" as const,
      policy_trust_source: trusted.trustSource
    };
    return { ...payload, authorization_hash: sha256(payload as never) };
  } catch (error) {
    if (error instanceof TrustedToolExposurePolicyError) throw mapTrustedPolicyError(error);
    if (error instanceof DirectRevitExecutionAuthorizationError) throw error;
    throw new DirectRevitExecutionAuthorizationError(
      "CERTIFICATION_POLICY_UNAVAILABLE",
      "Current certification policy could not authorize direct Revit execution.",
      503,
      true
    );
  }
}
