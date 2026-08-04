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
// body_json is itself JSON-escaped in the authorization request wrapper. The
// native System.Text.Json encoder may represent one source byte as a six-byte
// \uXXXX escape, so the outer request needs a separate, still-bounded ceiling.
export const DIRECT_REVIT_AUTHORIZATION_HTTP_MAX_BYTES = (DIRECT_REVIT_AUTHORIZATION_MAX_BODY_BYTES * 6) + 64 * 1024;

const DIRECT_REQUEST_KEYS = ["schema", "request_id", "method", "path", "body_present", "body_json", "channel", "alias", "runtime_mode"] as const;
const REQUEST_ID = /^(?:[0-9a-f]{32}|[0-9a-f]{64})$/;
const TOOL_ALIAS = /^[a-z][a-z0-9_]*$/;
type DirectRevitExecutionChannel = "search" | "generic_call" | "typed_mcp";

export type DirectRevitExecutionAuthorization = {
  version: typeof DIRECT_REVIT_EXECUTION_AUTHORIZATION_VERSION;
  phase: "certification_native_direct_admission";
  authorized_at: string;
  valid_for_ms: typeof DIRECT_REVIT_AUTHORIZATION_VALID_FOR_MS;
  request_id: string;
  method: "GET" | "POST";
  path: string;
  body_present: boolean;
  source_body_sha256: string;
  canonical_body_json: string;
  body_sha256: string;
  policy_hash: string;
  policy_record_hash: string;
  evidence_record_hash: string;
  request_hash: string;
  effect_hash: string;
  channel: DirectRevitExecutionChannel;
  alias: string;
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
  if ((request.channel !== "search" && request.channel !== "generic_call" && request.channel !== "typed_mcp")
    || typeof request.alias !== "string"
    || !TOOL_ALIAS.test(request.alias)
    || (request.channel === "generic_call" && request.alias !== "revit_call_tool")
    || (request.channel !== "generic_call" && request.alias === "revit_call_tool")) {
    malformed("Direct Revit authorization channel and alias contract is invalid.");
  }
  const channel = request.channel as DirectRevitExecutionChannel;
  const alias = request.alias as string;
  if (typeof request.runtime_mode !== "string") malformed("Direct Revit authorization runtime_mode must be canonical.");
  const runtimeMode = normalizeRuntimeMode(request.runtime_mode);
  if (request.runtime_mode !== runtimeMode || !/^[a-z][a-z0-9_]*$/.test(runtimeMode) || runtimeMode.length > 64) {
    malformed("Direct Revit authorization runtime_mode must be canonical.");
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
  let canonicalBodyJson = "";
  if (bodyPresent) {
    try {
      parsedBody = JSON.parse(bodyJson) as JsonValue;
      // Lock the source to the compact JSON compatibility form emitted by the
      // native client. Besides whitespace drift, this rejects duplicate-member
      // collapse and numeric lexemes that JSON.parse would silently rewrite.
      if (JSON.stringify(parsedBody) !== bodyJson) {
        malformed("Direct Revit authorization body_json must use the compact JSON source compatibility form.");
      }
      // The backend is the policy canonicalization authority. This second form
      // intentionally normalizes strings/keys and ordering before evaluation.
      canonicalBodyJson = canonicalJson(parsedBody);
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

  const requestHash = computeRequestHash(method, toolPath, method === "GET" ? {} : parsedBody);
  try {
    const trusted = loadTrustedToolExposurePolicy(env);
    const evaluation = evaluateTrustedToolExposurePolicy({
      policy: trusted.policy,
      method,
      path: toolPath,
      requestHash,
      channel,
      alias
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
      source_body_sha256: bodySha256(bodyJson),
      canonical_body_json: canonicalBodyJson,
      body_sha256: bodySha256(canonicalBodyJson),
      policy_hash: trusted.policy.policy_hash,
      policy_record_hash: record.policy_record_hash,
      evidence_record_hash: record.evidence_record_hash,
      request_hash: record.request_hash,
      effect_hash: record.effect_hash,
      channel,
      alias,
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
