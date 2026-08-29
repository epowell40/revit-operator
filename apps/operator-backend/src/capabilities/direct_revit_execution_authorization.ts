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
import {
  CertifiedRequestFamilyAdmissionError,
  certifiedRequestFamilyEffectHash,
  finalizeCertifiedRequestFamilyAdmission,
  validateCertifiedRequestFamilyAdmission,
  type CertifiedRequestFamilyAdmission,
  type ValidatedCertifiedRequestFamilyAdmission
} from "./certified_request_family_admission.js";
import { getSidecarAgentProfileState } from "./sidecar_agent_profile.js";

export const DIRECT_REVIT_EXECUTION_AUTHORIZATION_V1_VERSION = "revit-operator.revit-direct-final-authorization.v1";
export const DIRECT_REVIT_EXECUTION_AUTHORIZATION_V2_VERSION = "revit-operator.revit-direct-final-authorization.v2";
export const DIRECT_REVIT_EXECUTION_AUTHORIZATION_VERSION = DIRECT_REVIT_EXECUTION_AUTHORIZATION_V1_VERSION;
export const DIRECT_REVIT_ADMISSION_REQUEST_V1_SCHEMA = "revit-operator.revit-direct-admission-request.v1";
export const DIRECT_REVIT_ADMISSION_REQUEST_V2_SCHEMA = "revit-operator.revit-direct-admission-request.v2";
export const DIRECT_REVIT_ADMISSION_REQUEST_V3_SCHEMA = "revit-operator.revit-direct-admission-request.v3";
export const DIRECT_REVIT_ADMISSION_REQUEST_SCHEMA = DIRECT_REVIT_ADMISSION_REQUEST_V3_SCHEMA;
// The receipt is exact-request-bound and one-use. Its local dispatch window
// must still cover Revit ExternalEvent admission while Revit is minimized or
// backgrounded; observed healthy background turns can take 10-12 seconds to
// reach the API thread after the hosted response has arrived.
export const DIRECT_REVIT_AUTHORIZATION_VALID_FOR_MS = 30_000;
export const DIRECT_REVIT_AUTHORIZATION_MAX_BODY_BYTES = 2 * 1024 * 1024;
// body_json is itself JSON-escaped in the authorization request wrapper. The
// native System.Text.Json encoder may represent one source byte as a six-byte
// \uXXXX escape, so the outer request needs a separate, still-bounded ceiling.
export const DIRECT_REVIT_AUTHORIZATION_HTTP_MAX_BYTES = (DIRECT_REVIT_AUTHORIZATION_MAX_BODY_BYTES * 6) + 64 * 1024;

const DIRECT_REQUEST_V1_KEYS = ["schema", "request_id", "method", "path", "body_present", "body_json", "channel", "alias"] as const;
const DIRECT_REQUEST_V2_KEYS = [...DIRECT_REQUEST_V1_KEYS, "runtime_mode"] as const;
const DIRECT_REQUEST_V3_KEYS = [
  ...DIRECT_REQUEST_V2_KEYS,
  "policy_hash", "policy_record_hash", "evidence_record_hash", "effect_hash", "authorization_stage", "request_family_admission"
] as const;
const REQUEST_ID = /^(?:[0-9a-f]{32}|[0-9a-f]{64})$/;
const SHA256 = /^sha256:[0-9a-f]{64}$/;
const TOOL_ALIAS = /^[a-z][a-z0-9_]*$/;
type DirectRevitExecutionChannel = "search" | "generic_call" | "typed_mcp";

export type DirectRevitExecutionAuthorization = {
  version: typeof DIRECT_REVIT_EXECUTION_AUTHORIZATION_V1_VERSION | typeof DIRECT_REVIT_EXECUTION_AUTHORIZATION_V2_VERSION;
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
  exposure_profile: "certified" | "general";
  policy_trust_source: "bundled" | "deployment";
  authorization_stage?: "preflight" | "final";
  request_family_admission?: CertifiedRequestFamilyAdmission;
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

function asExactRequest(value: unknown, expectedKeys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) malformed("Direct Revit authorization request must be an object.");
  const request = value as Record<string, unknown>;
  const expected = new Set<string>(expectedKeys);
  for (const key of Object.keys(request)) {
    if (!expected.has(key)) malformed(`Direct Revit authorization request contains unknown field ${key}.`);
  }
  for (const key of expectedKeys) {
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

function isHostedGeneralAgentReady(env: NodeJS.ProcessEnv): boolean {
  const profile = getSidecarAgentProfileState(env);
  return profile.general_agent_ready === true
    && profile.capability_profile === "general_agent"
    && profile.tool_exposure_profile === "general"
    && (profile.runtime_mode === "hosted" || profile.runtime_mode === "production");
}

function isDevelopmentGeneralAgentReady(env: NodeJS.ProcessEnv): boolean {
  const profile = getSidecarAgentProfileState(env);
  return isDevelopmentLaboratory(env)
    && profile.general_agent_ready === true
    && profile.capability_profile === "general_agent_laboratory"
    && profile.tool_exposure_profile === "laboratory"
    && profile.runtime_mode === "development";
}

/**
 * The authenticated hosted product is a general Revit worker, not a static
 * certification allowlist. Bind each well-formed request to an exact receipt
 * while keeping the legacy native-admission wire shape used by ROSB/1.
 */
function generalAgentAdmissionRecord(input: {
  method: "GET" | "POST";
  path: string;
  requestHash: string;
  authority: "authenticated_hosted_general_agent" | "authenticated_local_general_agent";
  capabilityProfile: "general_agent" | "general_agent_laboratory";
  effectHash?: string;
}): {
  policy_hash: string;
  policy_record_hash: string;
  evidence_record_hash: string;
  effect_hash: string;
} {
  const effectHash = input.effectHash ?? sha256({
    schema: "revit-operator.general-agent-direct-effect.v1",
    method: input.method,
    path: input.path,
    request_hash: input.requestHash
  } as never);
  const evidenceRecordHash = sha256({
    schema: "revit-operator.general-agent-direct-evidence.v1",
    authority: input.authority,
    method: input.method,
    path: input.path
  } as never);
  const policyRecordHash = sha256({
    schema: "revit-operator.general-agent-direct-record.v1",
    method: input.method,
    path: input.path,
    request_hash: input.requestHash,
    effect_hash: effectHash,
    evidence_record_hash: evidenceRecordHash
  } as never);
  const policyHash = sha256({
    schema: "revit-operator.general-agent-direct-policy.v1",
    authority: "backend_environment",
    capability_profile: input.capabilityProfile
  } as never);
  return {
    policy_hash: policyHash,
    policy_record_hash: policyRecordHash,
    evidence_record_hash: evidenceRecordHash,
    effect_hash: effectHash
  };
}

export function authorizeDirectRevitExecution(
  value: unknown,
  env: NodeJS.ProcessEnv = process.env,
  now: Date = new Date()
): DirectRevitExecutionAuthorization {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    malformed("Direct Revit authorization request must be an object.");
  }
  const requestSchema = (value as Record<string, unknown>).schema;
  let expectedKeys: readonly string[];
  if (requestSchema === DIRECT_REVIT_ADMISSION_REQUEST_V1_SCHEMA) {
    expectedKeys = DIRECT_REQUEST_V1_KEYS;
  } else if (requestSchema === DIRECT_REVIT_ADMISSION_REQUEST_V2_SCHEMA) {
    expectedKeys = DIRECT_REQUEST_V2_KEYS;
  } else if (requestSchema === DIRECT_REVIT_ADMISSION_REQUEST_V3_SCHEMA) {
    expectedKeys = DIRECT_REQUEST_V3_KEYS;
  } else {
    malformed("Direct Revit authorization request schema is unsupported.");
  }
  const request = asExactRequest(value, expectedKeys);
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
  let runtimeMode: string;
  if (requestSchema === DIRECT_REVIT_ADMISSION_REQUEST_V1_SCHEMA) {
    runtimeMode = normalizeRuntimeMode(env.REVIT_OPERATOR_MODE);
  } else {
    if (typeof request.runtime_mode !== "string") malformed("Direct Revit authorization runtime_mode must be canonical.");
    runtimeMode = normalizeRuntimeMode(request.runtime_mode);
    if (request.runtime_mode !== runtimeMode || !/^[a-z][a-z0-9_]*$/.test(runtimeMode) || runtimeMode.length > 64) {
      malformed("Direct Revit authorization runtime_mode must be canonical.");
    }
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
  let requestFamilyAdmission: ValidatedCertifiedRequestFamilyAdmission | undefined;
  if (requestSchema === DIRECT_REVIT_ADMISSION_REQUEST_V3_SCHEMA) {
    for (const field of ["policy_hash", "policy_record_hash", "evidence_record_hash", "effect_hash"] as const) {
      if (typeof request[field] !== "string" || !SHA256.test(request[field] as string)) {
        malformed(`Direct Revit authorization ${field} must be a canonical SHA-256 digest.`);
      }
    }
    if (request.authorization_stage !== "preflight" && request.authorization_stage !== "final") {
      malformed("Direct request-family authorization_stage must be preflight or final.");
    }
    try {
      requestFamilyAdmission = validateCertifiedRequestFamilyAdmission(request.request_family_admission, {
        method,
        path: toolPath,
        body: parsedBody,
        bodyJson
      });
      if (request.effect_hash !== certifiedRequestFamilyEffectHash(requestFamilyAdmission)) {
        throw new DirectRevitExecutionAuthorizationError(
          "CERTIFICATION_REQUEST_FAMILY_DENIED",
          "Direct request-family phase does not bind the exact reviewed preview/apply effect.",
          403,
          false
        );
      }
    } catch (error) {
      if (error instanceof CertifiedRequestFamilyAdmissionError) {
        throw new DirectRevitExecutionAuthorizationError(error.code, error.message, 403, false);
      }
      throw error;
    }
  }

  const requestHash = computeRequestHash(method, toolPath, method === "GET" ? {} : parsedBody);
  try {
    const hostedGeneralAgent = isHostedGeneralAgentReady(env) && !requestFamilyAdmission;
    const developmentGeneralAgent = isDevelopmentGeneralAgentReady(env)
      && runtimeMode === "development"
      && !requestFamilyAdmission;
    if (isDevelopmentLaboratory(env) && !developmentGeneralAgent) {
      throw new DirectRevitExecutionAuthorizationError(
        "CERTIFICATION_RUNTIME_PROFILE_MISMATCH",
        "Direct Revit authorization requires the exact ready development General Agent profile.",
        403,
        false
      );
    }
    if (hostedGeneralAgent || developmentGeneralAgent) {
      const record = generalAgentAdmissionRecord({
        method,
        path: toolPath,
        requestHash,
        authority: developmentGeneralAgent
          ? "authenticated_local_general_agent"
          : "authenticated_hosted_general_agent",
        capabilityProfile: developmentGeneralAgent
          ? "general_agent_laboratory"
          : "general_agent"
      });
      const payload = {
        version: DIRECT_REVIT_EXECUTION_AUTHORIZATION_V1_VERSION as typeof DIRECT_REVIT_EXECUTION_AUTHORIZATION_V1_VERSION,
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
        policy_hash: record.policy_hash,
        policy_record_hash: record.policy_record_hash,
        evidence_record_hash: record.evidence_record_hash,
        request_hash: requestHash,
        effect_hash: record.effect_hash,
        channel,
        alias,
        runtime_mode: runtimeMode,
        exposure_profile: "general" as const,
        policy_trust_source: "deployment" as const
      };
      return { ...payload, authorization_hash: sha256(payload as never) };
    }
    const trusted = loadTrustedToolExposurePolicy(env);
    const evaluation = evaluateTrustedToolExposurePolicy({
      policy: trusted.policy,
      method,
      path: toolPath,
      requestHash,
      effectHash: requestSchema === DIRECT_REVIT_ADMISSION_REQUEST_V3_SCHEMA ? request.effect_hash as string : undefined,
      channel,
      alias,
      requestFamilyAdmission
    });
    const record = evaluation.record;
    if (requestSchema === DIRECT_REVIT_ADMISSION_REQUEST_V3_SCHEMA
      && (request.policy_hash !== trusted.policy.policy_hash
        || request.policy_record_hash !== record.policy_record_hash
        || request.evidence_record_hash !== record.evidence_record_hash
        || request.effect_hash !== record.effect_hash)) {
      throw new DirectRevitExecutionAuthorizationError(
        "CERTIFICATION_POLICY_CHANGED",
        "Direct request-family policy, record, evidence, or effect identity changed before final authorization.",
        403,
        false
      );
    }
    if (requestFamilyAdmission && request.authorization_stage === "final") {
      try { finalizeCertifiedRequestFamilyAdmission(requestFamilyAdmission, bodyJson); }
      catch (error) {
        if (error instanceof CertifiedRequestFamilyAdmissionError) {
          throw new DirectRevitExecutionAuthorizationError(error.code, error.message, 403, false);
        }
        throw error;
      }
    }
    const authorizationVersion: DirectRevitExecutionAuthorization["version"] = requestFamilyAdmission
        ? DIRECT_REVIT_EXECUTION_AUTHORIZATION_V2_VERSION
        : DIRECT_REVIT_EXECUTION_AUTHORIZATION_V1_VERSION;
    const payload = {
      version: authorizationVersion,
      phase: "certification_native_direct_admission" as const,
      authorized_at: now.toISOString(),
      valid_for_ms: DIRECT_REVIT_AUTHORIZATION_VALID_FOR_MS as typeof DIRECT_REVIT_AUTHORIZATION_VALID_FOR_MS,
      request_id: requestId,
      method,
      path: toolPath,
      body_present: bodyPresent,
      source_body_sha256: bodySha256(bodyJson),
      canonical_body_json: requestFamilyAdmission ? bodyJson : canonicalBodyJson,
      body_sha256: bodySha256(requestFamilyAdmission ? bodyJson : canonicalBodyJson),
      policy_hash: trusted.policy.policy_hash,
      policy_record_hash: record.policy_record_hash,
      evidence_record_hash: record.evidence_record_hash,
      request_hash: requestFamilyAdmission?.request_instance_hash ?? record.request_hash,
      effect_hash: record.effect_hash,
      channel,
      alias,
      runtime_mode: runtimeMode,
      exposure_profile: "certified" as const,
      policy_trust_source: trusted.trustSource,
      ...(requestFamilyAdmission ? { authorization_stage: request.authorization_stage as "preflight" | "final" } : {}),
      ...(requestFamilyAdmission ? { request_family_admission: requestFamilyAdmission } : {})
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
