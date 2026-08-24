import { createHash } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { revitRouteEffect } from "./revitRouteEffect.js";
import {
  admitCertifiedMoveOneRequest,
  CERTIFIED_MOVE_ONE_REQUEST_FAMILY_HASH,
  CERTIFIED_MOVE_ONE_REQUEST_FAMILY_V1,
  assertCertifiedMoveApplyPolicyLineage,
  isCertifiedMoveOneAdmission,
  type CertifiedMoveOneAdmission
} from "./certifiedMoveOneRequestFamily.js";
import {
  SAFE_READ_EXECUTOR_ID,
  SAFE_READ_SHEETS_COUNT_PATH,
  SAFE_READ_SHEETS_COUNT_ROUTE_ID
} from "./safeReadDiscovery.js";

export const TOOL_EXPOSURE_CHANNELS = ["search", "generic_call", "typed_mcp", "deterministic_workflow"] as const;
export type ToolExposureChannel = typeof TOOL_EXPOSURE_CHANNELS[number];
export type ToolExposureMode = "certified" | "laboratory" | "general";
/**
 * Cross-runtime envelope/policy canonicalization: NFC text, CRLF/CR folded
 * to LF, ordinal key sort, no duplicate normalized keys, and compact JSON.
 * Strings use JSON's mandatory escapes for quote, backslash, and U+0000..001F
 * only; all other Unicode scalar values, including U+2028/U+2029, are emitted
 * as literal UTF-8. C# consumers must not use a serializer configuration that
 * HTML-escapes or otherwise rewrites those literal Unicode code points.
 */
export const TOOL_EXPOSURE_CANONICALIZATION = "revit-operator.canonical-json.nfc-key-sorted.v1";

type ChannelDecision = {
  exposed: boolean;
  required_level: string;
  reason_codes: string[];
};

type StandaloneExecutorSurface = {
  kind: "standalone_executor";
  executor_id: string;
  route_id: string;
  transport: "direct_loopback";
};

export type RequestFamilyBinding = {
  schema: "revit-operator.certified-request-family.v1";
  id: string;
  validator_hash: string;
};

export type ToolExposurePolicyRecord = {
  method: string;
  path: string;
  request_hash: string;
  effect_hash: string;
  evidence_record_hash: string;
  request_family?: RequestFamilyBinding;
  highest_cumulative_level: string | null;
  observed_levels: string[];
  visibility: "candidate" | "workflow_only";
  execution_surface?: StandaloneExecutorSurface;
  typed_mcp_aliases: string[];
  channels: Record<ToolExposureChannel, ChannelDecision>;
  policy_record_hash: string;
};

export type ToolExposurePolicy = {
  schema: "revit-operator.tool-exposure-policy.v1";
  hash_algorithm: "sha256";
  evidence_schema: "revit-operator.tool-certification-evidence.v1";
  evidence_source_hash: string;
  records: ToolExposurePolicyRecord[];
  policy_hash: string;
};

export type ToolExposureRuntimeDecision = {
  runtimeMode: string;
  mode: ToolExposureMode;
  certified: boolean;
  explicitLaboratory: boolean;
  reason: string;
  policyPath?: string;
};

export type ToolExposureDecision = {
  allowed: boolean;
  mode: ToolExposureMode;
  runtimeMode: string;
  method: string;
  path: string;
  channel: ToolExposureChannel;
  requestHash: string;
  effectHash: string;
  knownRoute: boolean;
  reasonCodes: string[];
  policyPath?: string;
  policyHash?: string;
  policyRecordHash?: string;
  evidenceRecordHash?: string;
  requestFamily?: RequestFamilyBinding;
  /** Hash of the independently normalized parameterized request instance. */
  requestInstanceHash?: string;
  policyTrustSource?: "bundled" | "deployment";
  visibility?: ToolExposurePolicyRecord["visibility"];
  /** The MCP surface that was actually bound at admission, never a caller-supplied display name. */
  alias?: string;
  /** Present only for a deterministic workflow admission. */
  workflow?: string;
};

export class ToolExposurePolicyError extends Error {
  readonly code: string;
  readonly decision?: ToolExposureDecision;

  constructor(code: string, message: string, decision?: ToolExposureDecision, cause?: unknown) {
    super(`[${code}] ${message}`, { cause });
    this.name = "ToolExposurePolicyError";
    this.code = code;
    this.decision = decision;
  }
}

const SHA256 = /^sha256:[0-9a-f]{64}$/;
const POLICY_FILENAME = "tool_exposure_policy.v1.json";
const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
// This is a deployment trust anchor, not a value learned from the policy file.
// Update it only alongside a reviewed bundled policy artifact.
const BUNDLED_POLICY_HASH = "sha256:1e544366b9bf7c984250e53987ae5628480d064600d826c15fecfcecdfedf54b";
const invokedMcpAlias = new AsyncLocalStorage<string>();
declare const certifiedCourierAdmissionBrand: unique symbol;
export type CertifiedCourierAdmission = {
  readonly [certifiedCourierAdmissionBrand]: true;
};
const courierAdmissionDecisions = new WeakMap<object, ToolExposureDecision>();
const courierMoveAdmissions = new WeakMap<object, CertifiedMoveOneAdmission>();

function normalizeRuntimeMode(value: unknown): string {
  return String(value ?? "local").trim().toLowerCase().replace(/-/g, "_") || "local";
}

export function getToolExposureRuntimeDecision(env: NodeJS.ProcessEnv = process.env): ToolExposureRuntimeDecision {
  const rawRuntimeMode = typeof env.REVIT_OPERATOR_MODE === "string" ? env.REVIT_OPERATOR_MODE : "";
  const rawRequestedProfile = typeof env.OPERATOR_TOOL_EXPOSURE_PROFILE === "string"
    ? env.OPERATOR_TOOL_EXPOSURE_PROFILE
    : "";
  const runtimeMode = normalizeRuntimeMode(env.REVIT_OPERATOR_MODE);
  const requested = rawRequestedProfile.trim().toLowerCase();
  const exactHostedProduction = rawRuntimeMode === "hosted" || rawRuntimeMode === "production";
  // This is the sole certification escape. Keep it bound to the exact raw
  // deployment values so normalization cannot silently weaken the boundary.
  const explicitLaboratory = rawRuntimeMode === "development" && rawRequestedProfile === "laboratory";
  if (requested && requested !== "certified" && requested !== "laboratory" && requested !== "general") {
    return {
      runtimeMode,
      mode: "certified",
      certified: true,
      explicitLaboratory: false,
      reason: `invalid OPERATOR_TOOL_EXPOSURE_PROFILE=${requested}; failing closed`
    };
  }

  if (runtimeMode === "hosted" || runtimeMode === "production") {
    // A ready authenticated production deployment is the General Agent product.
    // Do not let a stale deployment variable silently put the user back onto the
    // retired certified-only surface. Laboratory semantics are also ignored here;
    // production continues to use the authenticated General Agent transport.
    if (exactHostedProduction) {
      return {
        runtimeMode,
        mode: "general",
        certified: false,
        explicitLaboratory: false,
        reason: rawRequestedProfile && rawRequestedProfile !== "general"
          ? `authenticated hosted General Agent exposure is active; ignoring retired ${rawRequestedProfile} profile override`
          : "authenticated hosted General Agent exposure is active"
      };
    }
    return {
      runtimeMode,
      mode: "certified",
      certified: true,
      explicitLaboratory: false,
      reason: "non-exact hosted/production runtime values cannot activate General Agent exposure"
    };
  }

  if (runtimeMode === "development") {
    return {
      runtimeMode,
      mode: explicitLaboratory ? "laboratory" : "certified",
      certified: !explicitLaboratory,
      explicitLaboratory,
      reason: explicitLaboratory
        ? "explicit development laboratory escape is active"
        : requested === "laboratory"
          ? "laboratory exposure requires exact raw REVIT_OPERATOR_MODE=development and OPERATOR_TOOL_EXPOSURE_PROFILE=laboratory; failing closed"
          : "development defaults to certified exposure; set OPERATOR_TOOL_EXPOSURE_PROFILE=laboratory explicitly to escape"
    };
  }

  return {
    runtimeMode,
    mode: "certified",
    certified: true,
    explicitLaboratory: false,
    reason: requested === "laboratory"
      ? `laboratory exposure requires exact REVIT_OPERATOR_MODE=development; ${runtimeMode} is certified`
      : `${runtimeMode} runtime uses certified exposure`
  };
}

function normalizeText(value: string): string {
  return value.replace(/\r\n?/g, "\n").normalize("NFC");
}

export function canonicalToolExposureValue(value: unknown, location = "value"): unknown {
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "string") return normalizeText(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error(`${location} contains a non-finite number`);
    return value;
  }
  if (Array.isArray(value)) return value.map((item, index) => canonicalToolExposureValue(item, `${location}[${index}]`));
  if (!value || typeof value !== "object") throw new Error(`${location} is not canonical JSON data`);
  const entries = Object.entries(value as Record<string, unknown>)
    .map(([key, item]) => [normalizeText(key), item] as const)
    .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0);
  const result: Record<string, unknown> = {};
  for (const [key, item] of entries) {
    if (Object.prototype.hasOwnProperty.call(result, key)) throw new Error(`${location} contains a normalized key collision`);
    if (item === undefined) throw new Error(`${location}.${key} is undefined`);
    result[key] = canonicalToolExposureValue(item, `${location}.${key}`);
  }
  return result;
}

export function canonicalToolExposureJson(value: unknown): string {
  return JSON.stringify(canonicalToolExposureValue(value));
}

function digest(value: unknown): string {
  const canonical = canonicalToolExposureJson(value);
  return `sha256:${createHash("sha256").update(canonical, "utf8").digest("hex")}`;
}

function jsonWireValue(value: unknown, location: string): unknown {
  let serialized: string | undefined;
  try {
    serialized = JSON.stringify(value);
  } catch (error) {
    throw new Error(`${location} cannot be serialized as JSON`, { cause: error });
  }
  if (serialized === undefined) return undefined;
  return JSON.parse(serialized) as unknown;
}

function assertWireValueIsCanonical(value: unknown, location = "request"): void {
  if (typeof value === "string") {
    if (value !== normalizeText(value)) {
      throw new Error(`${location} contains non-canonical text that would hash differently from the dispatched JSON body`);
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertWireValueIsCanonical(item, `${location}[${index}]`));
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (key !== normalizeText(key)) {
      throw new Error(`${location} contains a non-canonical JSON key`);
    }
    assertWireValueIsCanonical(item, `${location}.${key}`);
  }
}

function assertObject(value: unknown, location: string): asserts value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${location} must be an object`);
}

function assertExactKeys(value: Record<string, unknown>, required: readonly string[], optional: readonly string[], location: string): void {
  const allowed = new Set([...required, ...optional]);
  for (const key of Object.keys(value)) if (!allowed.has(key)) throw new Error(`${location} contains unknown field: ${key}`);
  for (const key of required) if (!Object.prototype.hasOwnProperty.call(value, key)) throw new Error(`${location} is missing field: ${key}`);
}

function assertStringArray(value: unknown, location: string): asserts value is string[] {
  if (!Array.isArray(value) || value.some(item => typeof item !== "string")) throw new Error(`${location} must be a string array`);
  if (new Set(value).size !== value.length) throw new Error(`${location} contains a duplicate value`);
}

function assertCanonicalAliasArray(value: unknown, location: string): asserts value is string[] {
  assertStringArray(value, location);
  for (const [index, alias] of value.entries()) {
    if (!/^[a-z][a-z0-9_]*$/.test(alias)) throw new Error(`${location}[${index}] is not a canonical MCP alias`);
    if (index > 0 && value[index - 1]! >= alias) throw new Error(`${location} must use unique ordinal-sorted aliases`);
  }
}

function parseChannelDecision(value: unknown, location: string): ChannelDecision {
  assertObject(value, location);
  assertExactKeys(value, ["exposed", "required_level", "reason_codes"], [], location);
  if (typeof value.exposed !== "boolean") throw new Error(`${location}.exposed must be boolean`);
  if (typeof value.required_level !== "string" || !/^L[0-5]$/.test(value.required_level)) throw new Error(`${location}.required_level is invalid`);
  assertStringArray(value.reason_codes, `${location}.reason_codes`);
  if (value.reason_codes.length === 0) throw new Error(`${location}.reason_codes must not be empty`);
  return value as unknown as ChannelDecision;
}

function parseStandaloneExecutorSurface(value: unknown, location: string): StandaloneExecutorSurface {
  assertObject(value, location);
  assertExactKeys(value, ["kind", "executor_id", "route_id", "transport"], [], location);
  if (value.kind !== "standalone_executor") throw new Error(`${location}.kind is invalid`);
  if (value.executor_id !== SAFE_READ_EXECUTOR_ID) throw new Error(`${location}.executor_id is not a reviewed standalone executor`);
  if (value.route_id !== SAFE_READ_SHEETS_COUNT_ROUTE_ID) throw new Error(`${location}.route_id is not a reviewed standalone route`);
  if (value.transport !== "direct_loopback") throw new Error(`${location}.transport is invalid`);
  return value as unknown as StandaloneExecutorSurface;
}

function parseRequestFamilyBinding(value: unknown, location: string): RequestFamilyBinding {
  assertObject(value, location);
  assertExactKeys(value, ["schema", "id", "validator_hash"], [], location);
  if (value.schema !== "revit-operator.certified-request-family.v1") throw new Error(`${location}.schema is invalid`);
  if (typeof value.id !== "string" || !/^[a-z][a-z0-9._-]*$/.test(value.id)) throw new Error(`${location}.id is invalid`);
  if (typeof value.validator_hash !== "string" || !SHA256.test(value.validator_hash)) throw new Error(`${location}.validator_hash is invalid`);
  return value as unknown as RequestFamilyBinding;
}

function parsePolicyRecord(value: unknown, index: number): ToolExposurePolicyRecord {
  const location = `policy.records[${index}]`;
  assertObject(value, location);
  const hasExecutionSurface = Object.prototype.hasOwnProperty.call(value, "execution_surface");
  const hasRequestFamily = Object.prototype.hasOwnProperty.call(value, "request_family");
  assertExactKeys(value, [
    "method", "path", "request_hash", "effect_hash", "evidence_record_hash", "highest_cumulative_level",
    "observed_levels", "visibility", "typed_mcp_aliases", "channels", "policy_record_hash"
  ], [
    ...(hasExecutionSurface ? ["execution_surface"] : []),
    ...(hasRequestFamily ? ["request_family"] : [])
  ], location);
  if (typeof value.method !== "string" || value.method !== value.method.trim().toUpperCase()) throw new Error(`${location}.method must be canonical`);
  if (typeof value.path !== "string" || !/^\/revit\/[A-Za-z0-9][A-Za-z0-9._~/-]*$/.test(value.path) || value.path.endsWith("/")) {
    throw new Error(`${location}.path must be an exact canonical Revit path`);
  }
  for (const name of ["request_hash", "effect_hash", "evidence_record_hash", "policy_record_hash"] as const) {
    if (typeof value[name] !== "string" || !SHA256.test(value[name] as string)) throw new Error(`${location}.${name} is invalid`);
  }
  if (value.highest_cumulative_level !== null && (typeof value.highest_cumulative_level !== "string" || !/^L[0-5]$/.test(value.highest_cumulative_level))) {
    throw new Error(`${location}.highest_cumulative_level is invalid`);
  }
  assertStringArray(value.observed_levels, `${location}.observed_levels`);
  if (value.visibility !== "candidate" && value.visibility !== "workflow_only") throw new Error(`${location}.visibility is invalid`);
  if (hasRequestFamily) parseRequestFamilyBinding(value.request_family, `${location}.request_family`);
  assertCanonicalAliasArray(value.typed_mcp_aliases, `${location}.typed_mcp_aliases`);
  if (value.typed_mcp_aliases.includes("revit_call_tool")) throw new Error(`${location}.typed_mcp_aliases cannot bind the generic revit_call_tool surface`);
  const referencesSafeRead = value.path === SAFE_READ_SHEETS_COUNT_PATH
    || value.typed_mcp_aliases.includes("revit_count_sheets_certified");
  if (referencesSafeRead !== hasExecutionSurface) {
    throw new Error(`${location} SafeRead path and alias require the exact standalone execution_surface`);
  }
  assertObject(value.channels, `${location}.channels`);
  const channelsRaw = value.channels;
  assertExactKeys(channelsRaw, TOOL_EXPOSURE_CHANNELS, [], `${location}.channels`);
  const channels = Object.fromEntries(TOOL_EXPOSURE_CHANNELS.map(channel => [
    channel,
    parseChannelDecision(channelsRaw[channel], `${location}.channels.${channel}`)
  ])) as Record<ToolExposureChannel, ChannelDecision>;
  if (hasExecutionSurface) {
    parseStandaloneExecutorSurface(value.execution_surface, `${location}.execution_surface`);
    if (value.method !== "POST" || value.path !== SAFE_READ_SHEETS_COUNT_PATH) {
      throw new Error(`${location}.execution_surface is not bound to the reviewed standalone route`);
    }
    if (value.visibility !== "candidate" || value.typed_mcp_aliases.length !== 1 || value.typed_mcp_aliases[0] !== "revit_count_sheets_certified") {
      throw new Error(`${location}.execution_surface is not bound to the reviewed typed MCP alias`);
    }
    for (const channel of ["search", "generic_call", "deterministic_workflow"] as const) {
      if (channels[channel].exposed) {
        throw new Error(`${location}.execution_surface cannot expose the ${channel} channel`);
      }
    }
  }
  const { policy_record_hash: policyRecordHash, ...hashPayload } = value;
  if (digest(hashPayload) !== policyRecordHash) throw new Error(`${location}.policy_record_hash does not match record contents`);
  return { ...value, channels } as unknown as ToolExposurePolicyRecord;
}

export function parseToolExposurePolicy(value: unknown): ToolExposurePolicy {
  assertObject(value, "policy");
  assertExactKeys(value, ["schema", "hash_algorithm", "evidence_schema", "evidence_source_hash", "records", "policy_hash"], [], "policy");
  if (value.schema !== "revit-operator.tool-exposure-policy.v1") throw new Error("policy.schema is unsupported");
  if (value.hash_algorithm !== "sha256") throw new Error("policy.hash_algorithm is unsupported");
  if (value.evidence_schema !== "revit-operator.tool-certification-evidence.v1") throw new Error("policy.evidence_schema is unsupported");
  if (typeof value.evidence_source_hash !== "string" || !SHA256.test(value.evidence_source_hash)) throw new Error("policy.evidence_source_hash is invalid");
  if (typeof value.policy_hash !== "string" || !SHA256.test(value.policy_hash)) throw new Error("policy.policy_hash is invalid");
  if (!Array.isArray(value.records) || value.records.length === 0) throw new Error("policy.records must be a nonempty array");
  const records = value.records.map(parsePolicyRecord);
  const identities = new Set<string>();
  for (const [index, record] of records.entries()) {
    const identity = `${record.method}\n${record.path}\n${record.request_hash}\n${record.effect_hash}\n${record.request_family?.id ?? ""}\n${record.request_family?.validator_hash ?? ""}`;
    if (identities.has(identity)) throw new Error(`policy.records[${index}] duplicates an exact policy identity`);
    identities.add(identity);
  }
  const { policy_hash: policyHash, ...hashPayload } = value;
  if (digest(hashPayload) !== policyHash) throw new Error("policy.policy_hash does not match policy contents");
  return { ...value, records } as unknown as ToolExposurePolicy;
}

function configuredPolicyPath(env: NodeJS.ProcessEnv): string | undefined {
  const explicit = String(env.OPERATOR_TOOL_EXPOSURE_POLICY_PATH ?? "").trim();
  if (!explicit) return undefined;
  if (path.extname(explicit).toLowerCase() !== ".json") throw new Error("OPERATOR_TOOL_EXPOSURE_POLICY_PATH must name a JSON file");
  return path.resolve(explicit);
}

function configuredExpectedPolicyHash(env: NodeJS.ProcessEnv): string | undefined {
  const expected = String(env.OPERATOR_TOOL_EXPOSURE_POLICY_SHA256 ?? "").trim();
  if (!expected) return undefined;
  if (!SHA256.test(expected)) {
    throw new ToolExposurePolicyError(
      "TOOL_EXPOSURE_POLICY_TRUST_ANCHOR_INVALID",
      "OPERATOR_TOOL_EXPOSURE_POLICY_SHA256 must be a lowercase canonical sha256:<64 hex> policy hash."
    );
  }
  return expected;
}

function trustedPolicyHash(env: NodeJS.ProcessEnv): { expectedHash: string; source: "bundled" | "deployment" } {
  const configuredHash = configuredExpectedPolicyHash(env);
  if (configuredPolicyPath(env)) {
    if (!configuredHash) {
      throw new ToolExposurePolicyError(
        "TOOL_EXPOSURE_POLICY_TRUST_ANCHOR_REQUIRED",
        "An explicit OPERATOR_TOOL_EXPOSURE_POLICY_PATH requires OPERATOR_TOOL_EXPOSURE_POLICY_SHA256 from a separately trusted deployment source."
      );
    }
    return { expectedHash: configuredHash, source: "deployment" };
  }
  return configuredHash
    ? { expectedHash: configuredHash, source: "deployment" }
    : { expectedHash: BUNDLED_POLICY_HASH, source: "bundled" };
}

export function resolveToolExposurePolicyPath(env: NodeJS.ProcessEnv = process.env): string {
  const explicit = configuredPolicyPath(env);
  if (explicit) return explicit;
  const safeDefaults = [
    path.resolve(MODULE_DIR, "../../../operator-backend/config", POLICY_FILENAME),
    path.resolve(MODULE_DIR, "../../config", POLICY_FILENAME)
  ];
  const existing = safeDefaults.find(candidate => fs.existsSync(candidate));
  return existing ?? safeDefaults[0]!;
}

export function loadToolExposurePolicy(env: NodeJS.ProcessEnv = process.env): {
  policy: ToolExposurePolicy;
  policyPath: string;
  trustedPolicyHash: string;
  trustSource: "bundled" | "deployment";
} {
  const policyPath = resolveToolExposurePolicyPath(env);
  const trust = trustedPolicyHash(env);
  let source: string;
  try {
    source = fs.readFileSync(policyPath, "utf8");
  } catch (error) {
    throw new ToolExposurePolicyError("TOOL_EXPOSURE_POLICY_UNAVAILABLE", `Certified tool exposure policy is unavailable at ${policyPath}.`, undefined, error);
  }
  try {
    const policy = parseToolExposurePolicy(JSON.parse(source.replace(/^\uFEFF/, "")));
    if (policy.policy_hash !== trust.expectedHash) {
      throw new ToolExposurePolicyError(
        "TOOL_EXPOSURE_POLICY_ROLLBACK_REJECTED",
        `Policy hash ${policy.policy_hash} does not match trusted ${trust.source} anchor ${trust.expectedHash}.`
      );
    }
    return {
      policy,
      policyPath,
      trustedPolicyHash: trust.expectedHash,
      trustSource: trust.source
    };
  } catch (error) {
    if (error instanceof ToolExposurePolicyError) throw error;
    throw new ToolExposurePolicyError("TOOL_EXPOSURE_POLICY_INVALID", `Certified tool exposure policy is malformed or hash-mismatched at ${policyPath}: ${String(error)}`, undefined, error);
  }
}

function normalizedMethod(method: string): string {
  return String(method || "GET").trim().toUpperCase();
}

function normalizedRequest(method: string, body: unknown): unknown {
  if (method === "GET" || body === undefined) return {};
  if (typeof body !== "string") return body;
  const trimmed = body.trim();
  if (!trimmed) return body;
  try { return JSON.parse(trimmed); } catch { return body; }
}

function requestHash(method: string, toolPath: string, body: unknown, strictCanonical: boolean): string {
  const normalized = normalizedRequest(method, body);
  const wireValue = jsonWireValue(normalized, "request");
  const request = wireValue === undefined ? {} : wireValue;
  if (strictCanonical) assertWireValueIsCanonical(request);
  return digest({ method, path: toolPath, request });
}

function effectHash(toolPath: string, method: string, body: unknown, workflow?: string): string {
  const normalized = normalizedRequest(method, body);
  const wireBody = method === "GET" ? undefined : jsonWireValue(normalized, "request");
  // Schedule listing/detail is a read-only POST contract. Keep this refinement
  // at the certification boundary until the shared route-effect table gains
  // the same entry; defaulting it to write would make a valid read hash fail.
  const routeEffect = method === "POST" && toolPath === "/revit/schedules"
    ? "read"
    : revitRouteEffect(toolPath, method, wireBody);
  const effect: Record<string, unknown> = { resolved_effect: routeEffect === "apply" ? "write" : routeEffect };
  if (workflow) effect.workflow = workflow;
  return digest({ effect });
}

function evaluateToolExposureInternal(input: {
  method: string;
  path: string;
  body?: unknown;
  channel?: ToolExposureChannel;
  workflow?: string;
  alias?: string;
  env?: NodeJS.ProcessEnv;
  /** Internal-only bridge from a reviewed deterministic family validator. */
  requestFamily?: RequestFamilyBinding;
  /** The independently canonicalized, validator-produced request instance. */
  requestInstanceHash?: string;
}): ToolExposureDecision {
  const env = input.env ?? process.env;
  const runtime = getToolExposureRuntimeDecision(env);
  const method = normalizedMethod(input.method);
  const channel = input.channel ?? "typed_mcp";
  const alias = String(input.alias ?? invokedMcpAlias.getStore() ?? "").trim();
  const workflow = input.workflow;
  if (!(TOOL_EXPOSURE_CHANNELS as readonly string[]).includes(channel)) {
    throw new ToolExposurePolicyError("TOOL_EXPOSURE_CHANNEL_INVALID", `Unsupported tool exposure channel: ${String(channel)}.`);
  }
  if (input.requestFamily && (!input.requestInstanceHash || !SHA256.test(input.requestInstanceHash))) {
    throw new ToolExposurePolicyError("CERT_REQUEST_FAMILY_INSTANCE_INVALID", "Parameterized certification requires a validator-produced request instance hash.");
  }
  const reqHash = input.requestFamily ? input.requestInstanceHash! : requestHash(method, input.path, input.body, runtime.certified);
  const effHash = effectHash(input.path, method, input.body, input.workflow);
  if (runtime.mode === "laboratory" || runtime.mode === "general") {
    return {
      allowed: true,
      mode: runtime.mode,
      runtimeMode: runtime.runtimeMode,
      method,
      path: input.path,
      channel,
      requestHash: reqHash,
      effectHash: effHash,
      knownRoute: false,
      reasonCodes: [runtime.mode === "general" ? "GENERAL_AGENT_MODE_ACTIVE" : "LABORATORY_MODE_ACTIVE"],
      ...(alias ? { alias } : {}),
      ...(input.requestFamily ? { requestFamily: input.requestFamily, requestInstanceHash: reqHash } : {}),
      ...(workflow === undefined ? {} : { workflow })
    };
  }

  const { policy, policyPath, trustSource } = loadToolExposurePolicy(env);
  const routeRecords = policy.records.filter(record => record.method === method && record.path === input.path);
  const requestRecords = routeRecords.filter(record => input.requestFamily
    ? record.request_family?.schema === input.requestFamily.schema
      && record.request_family.id === input.requestFamily.id
      && record.request_family.validator_hash === input.requestFamily.validator_hash
    : record.request_hash === reqHash);
  const record = requestRecords.find(candidate => candidate.effect_hash === effHash);
  if (!record) {
    return {
      allowed: false,
      mode: runtime.mode,
      runtimeMode: runtime.runtimeMode,
      method,
      path: input.path,
      channel,
      requestHash: reqHash,
      effectHash: effHash,
      knownRoute: routeRecords.length > 0,
      reasonCodes: routeRecords.length === 0
        ? ["CERT_ROUTE_UNKNOWN"]
        : requestRecords.length === 0
          ? ["CERT_REQUEST_HASH_MISMATCH"]
          : ["CERT_EFFECT_HASH_MISMATCH"],
      policyPath,
      policyHash: policy.policy_hash,
      policyTrustSource: trustSource,
      ...(alias ? { alias } : {}),
      ...(input.requestFamily ? { requestFamily: input.requestFamily, requestInstanceHash: reqHash } : {}),
      ...(workflow === undefined ? {} : { workflow })
    };
  }
  const channelDecision = record.channels[channel];
  const workflowOnlyRaw = record.visibility === "workflow_only" && channel !== "deterministic_workflow";
  if (!channelDecision.exposed || workflowOnlyRaw) {
    return {
      allowed: false,
      mode: runtime.mode,
      runtimeMode: runtime.runtimeMode,
      method,
      path: input.path,
      channel,
      requestHash: reqHash,
      effectHash: effHash,
      knownRoute: true,
      reasonCodes: workflowOnlyRaw ? ["CERT_WORKFLOW_ONLY"] : [...channelDecision.reason_codes],
      policyPath,
      policyHash: policy.policy_hash,
      policyRecordHash: record.policy_record_hash,
      evidenceRecordHash: record.evidence_record_hash,
      policyTrustSource: trustSource,
      visibility: record.visibility,
      ...(alias ? { alias } : {}),
      ...(input.requestFamily ? { requestFamily: input.requestFamily, requestInstanceHash: reqHash } : {}),
      ...(workflow === undefined ? {} : { workflow })
    };
  }
  if (!alias) {
    return {
      allowed: false,
      mode: runtime.mode,
      runtimeMode: runtime.runtimeMode,
      method,
      path: input.path,
      channel,
      requestHash: reqHash,
      effectHash: effHash,
      knownRoute: true,
      reasonCodes: ["CERT_MCP_ALIAS_REQUIRED"],
      policyPath,
      policyHash: policy.policy_hash,
      policyRecordHash: record.policy_record_hash,
      evidenceRecordHash: record.evidence_record_hash,
      policyTrustSource: trustSource,
      visibility: record.visibility,
      ...(workflow === undefined ? {} : { workflow })
    };
  }
  if (channel === "generic_call" && alias !== "revit_call_tool") {
    return {
      allowed: false,
      mode: runtime.mode,
      runtimeMode: runtime.runtimeMode,
      method,
      path: input.path,
      channel,
      requestHash: reqHash,
      effectHash: effHash,
      knownRoute: true,
      reasonCodes: ["CERT_GENERIC_ALIAS_REQUIRED"],
      policyPath,
      policyHash: policy.policy_hash,
      policyRecordHash: record.policy_record_hash,
      evidenceRecordHash: record.evidence_record_hash,
      policyTrustSource: trustSource,
      visibility: record.visibility,
      ...(alias ? { alias } : {}),
      ...(workflow === undefined ? {} : { workflow })
    };
  }
  if (channel !== "generic_call" && channel !== "deterministic_workflow") {
    const aliasRecords = alias
      ? policy.records.filter(candidate => candidate.typed_mcp_aliases.includes(alias))
      : [];
    const aliasMatchesRoute = !!alias && record.typed_mcp_aliases.includes(alias);
    const aliasChannel = channel === "search" ? "search" : "typed_mcp";
    const conjunctionAllowed = aliasRecords.length > 0 && aliasRecords.every(candidate =>
      candidate.visibility !== "workflow_only" && candidate.channels[aliasChannel].exposed
    );
    if (!aliasMatchesRoute || !conjunctionAllowed) {
      return {
        allowed: false,
        mode: runtime.mode,
        runtimeMode: runtime.runtimeMode,
        method,
        path: input.path,
        channel,
        requestHash: reqHash,
        effectHash: effHash,
        knownRoute: true,
        reasonCodes: [!aliasMatchesRoute ? "CERT_TYPED_ALIAS_MISMATCH" : "CERT_TYPED_ALIAS_CONJUNCTION_DENIED"],
        policyPath,
        policyHash: policy.policy_hash,
        policyRecordHash: record.policy_record_hash,
        evidenceRecordHash: record.evidence_record_hash,
        policyTrustSource: trustSource,
        visibility: record.visibility,
        ...(alias ? { alias } : {}),
        ...(input.requestFamily ? { requestFamily: input.requestFamily, requestInstanceHash: reqHash } : {}),
        ...(workflow === undefined ? {} : { workflow })
      };
    }
  }
  return {
    allowed: true,
    mode: runtime.mode,
    runtimeMode: runtime.runtimeMode,
    method,
    path: input.path,
    channel,
    requestHash: reqHash,
    effectHash: effHash,
    knownRoute: true,
    reasonCodes: [...channelDecision.reason_codes],
    policyPath,
    policyHash: policy.policy_hash,
    policyRecordHash: record.policy_record_hash,
    evidenceRecordHash: record.evidence_record_hash,
    policyTrustSource: trustSource,
    visibility: record.visibility,
    alias,
    ...(input.requestFamily ? { requestFamily: input.requestFamily, requestInstanceHash: reqHash } : {}),
    ...(workflow === undefined ? {} : { workflow })
  };
}

export function assertToolExposure(input: {
  method: string;
  path: string;
  body?: unknown;
  channel?: ToolExposureChannel;
  workflow?: string;
  alias?: string;
  env?: NodeJS.ProcessEnv;
}): ToolExposureDecision {
  const decision = evaluateToolExposure(input);
  if (decision.allowed) return decision;
  throw new ToolExposurePolicyError(
    decision.reasonCodes[0] ?? "TOOL_EXPOSURE_DENIED",
    `${decision.channel} exposure denied for exact ${decision.method} ${decision.path}; reasons=${decision.reasonCodes.join(",")}; request_hash=${decision.requestHash}; effect_hash=${decision.effectHash}.`,
    decision
  );
}

/** Exact-body policy evaluation. Parameterized family admission is deliberately
 * unavailable here; only the sealed family entry point below may use it. */
export function evaluateToolExposure(input: {
  method: string;
  path: string;
  body?: unknown;
  channel?: ToolExposureChannel;
  workflow?: string;
  alias?: string;
  env?: NodeJS.ProcessEnv;
}): ToolExposureDecision {
  return evaluateToolExposureInternal({
    method: input.method,
    path: input.path,
    body: input.body,
    channel: input.channel,
    workflow: input.workflow,
    alias: input.alias,
    env: input.env
  });
}

/**
 * The sole entry point for the first parameterized edit profile. It validates
 * the model-facing input before looking up a policy family binding and keeps
 * the resulting instance hash on the authorization receipt. Callers must use
 * the returned native body; they never supply a raw /move-elements body.
 */
export function assertCertifiedMoveOneToolExposure(input: {
  request: unknown;
  channel?: ToolExposureChannel;
  alias?: string;
  env?: NodeJS.ProcessEnv;
}): { admission: CertifiedMoveOneAdmission; decision: ToolExposureDecision } {
  const admission = admitCertifiedMoveOneRequest(input.request);
  return {
    admission,
    decision: assertCertifiedMoveOneAdmissionExposure({
      admission,
      channel: input.channel,
      alias: input.alias,
      env: input.env
    })
  };
}

/** Revalidates an opaque validator-issued family capability at a later hop. */
export function assertCertifiedMoveOneAdmissionExposure(input: {
  admission: unknown;
  channel?: ToolExposureChannel;
  alias?: string;
  env?: NodeJS.ProcessEnv;
}): ToolExposureDecision {
  const admission = input.admission;
  if (!isCertifiedMoveOneAdmission(admission)) {
    throw new ToolExposurePolicyError("CERT_REQUEST_FAMILY_VALIDATOR_INVALID", "Certified move-one validator did not produce a local admission capability.");
  }
  const decision = evaluateToolExposureInternal({
    method: "POST",
    path: "/revit/move-elements",
    body: admission.outboundBody,
    channel: input.channel ?? "typed_mcp",
    alias: input.alias,
    env: input.env,
    requestFamily: {
      schema: "revit-operator.certified-request-family.v1",
      id: CERTIFIED_MOVE_ONE_REQUEST_FAMILY_V1,
      validator_hash: CERTIFIED_MOVE_ONE_REQUEST_FAMILY_HASH
    },
    requestInstanceHash: admission.requestInstanceHash
  });
  if (decision.allowed) {
    assertCertifiedMoveApplyPolicyLineage(admission, {
      policyHash: decision.policyHash,
      policyRecordHash: decision.policyRecordHash,
      evidenceRecordHash: decision.evidenceRecordHash,
      effectHash: decision.effectHash,
      channel: decision.channel,
      alias: decision.alias
    });
    return decision;
  }
  throw new ToolExposurePolicyError(
    decision.reasonCodes[0] ?? "CERT_REQUEST_FAMILY_DENIED",
    `${decision.channel} exposure denied for certified move-one request family; reasons=${decision.reasonCodes.join(",")}; request_instance_hash=${admission.requestInstanceHash}; effect_hash=${decision.effectHash}.`,
    decision
  );
}

/** Distinct evidence-only family evaluator; it can never return certified mode authority. */
export function assertLaboratoryMoveEvidenceAdmissionExposure(input: {
  admission: unknown;
  channel?: ToolExposureChannel;
  alias?: string;
  env?: NodeJS.ProcessEnv;
}): ToolExposureDecision {
  const env = input.env ?? process.env;
  if (env.REVIT_OPERATOR_MODE !== "development"
    || env.OPERATOR_TOOL_EXPOSURE_PROFILE !== "laboratory"
    || env.OPERATOR_CERTIFICATION_PROTECTED_LABORATORY !== "1"
    || !isCertifiedMoveOneAdmission(input.admission)) {
    throw new ToolExposurePolicyError("CERT_LABORATORY_FAMILY_DENIED", "Move-family evidence admission requires an opaque validator admission in the exact protected laboratory lane.");
  }
  const admission = input.admission;
  const decision = evaluateToolExposureInternal({
    method: "POST", path: "/revit/move-elements", body: admission.outboundBody,
    channel: input.channel ?? "typed_mcp", alias: input.alias, env,
    requestFamily: { schema: "revit-operator.certified-request-family.v1", id: CERTIFIED_MOVE_ONE_REQUEST_FAMILY_V1, validator_hash: CERTIFIED_MOVE_ONE_REQUEST_FAMILY_HASH },
    requestInstanceHash: admission.requestInstanceHash
  });
  if (!decision.allowed || decision.mode !== "laboratory") {
    throw new ToolExposurePolicyError("CERT_LABORATORY_FAMILY_DENIED", "Move-family evidence admission did not resolve to exact laboratory authority.", decision);
  }
  return bindProtectedLaboratoryDecisionToCurrentPolicy(decision, env);
}

function bindProtectedLaboratoryDecisionToCurrentPolicy(
  decision: ToolExposureDecision,
  env: NodeJS.ProcessEnv,
  policyIdentity: { requestHash: string; effectHash: string } = { requestHash: decision.requestHash, effectHash: decision.effectHash }
): ToolExposureDecision {
  const { policy, policyPath, trustSource } = loadToolExposurePolicy(env);
  const record = policy.records.find(candidate => candidate.method === decision.method
    && candidate.path === decision.path
    && candidate.effect_hash === policyIdentity.effectHash
    && (decision.requestFamily
      ? candidate.request_family?.schema === decision.requestFamily.schema
        && candidate.request_family.id === decision.requestFamily.id
        && candidate.request_family.validator_hash === decision.requestFamily.validator_hash
      : candidate.request_hash === policyIdentity.requestHash));
  if (!record || !decision.alias || !record.typed_mcp_aliases.includes(decision.alias)) {
    throw new ToolExposurePolicyError(
      "CERT_LABORATORY_POLICY_BINDING_DENIED",
      "Protected laboratory evidence requires one exact reviewed candidate record and typed alias in the current trusted policy.",
      decision
    );
  }
  return Object.freeze({
    ...decision,
    policyPath,
    policyHash: policy.policy_hash,
    policyRecordHash: record.policy_record_hash,
    evidenceRecordHash: record.evidence_record_hash,
    requestHash: decision.requestFamily ? decision.requestHash : record.request_hash,
    effectHash: record.effect_hash,
    policyTrustSource: trustSource,
    visibility: record.visibility
  });
}

/** Binds generic protected-laboratory evidence to an exact current candidate record. */
export function assertProtectedLaboratoryEvidenceExposure(input: {
  method: string;
  path: string;
  body?: unknown;
  channel?: ToolExposureChannel;
  workflow?: string;
  alias?: string;
  env?: NodeJS.ProcessEnv;
}): ToolExposureDecision {
  const env = input.env ?? process.env;
  if (env.REVIT_OPERATOR_MODE !== "development"
    || env.OPERATOR_TOOL_EXPOSURE_PROFILE !== "laboratory"
    || env.OPERATOR_CERTIFICATION_PROTECTED_LABORATORY !== "1") {
    throw new ToolExposurePolicyError("CERT_LABORATORY_POLICY_BINDING_DENIED", "Protected laboratory evidence lane is not exact.");
  }
  const decision = assertToolExposure(input);
  if (decision.mode !== "laboratory") throw new ToolExposurePolicyError("CERT_LABORATORY_POLICY_BINDING_DENIED", "Laboratory policy binding resolved outside laboratory mode.", decision);
  return bindProtectedLaboratoryDecisionToCurrentPolicy(decision, env, {
    requestHash: requestHash(decision.method, decision.path, input.body, true),
    effectHash: effectHash(decision.path, decision.method, input.body)
  });
}

/**
 * Creates a process-local, non-serializable courier capability from the
 * active MCP alias. Callers cannot supply an alias here: the AsyncLocalStorage
 * binding installed by server.tool/registerTool is the authority.
 */
export function createCertifiedCourierAdmission(input: {
  method: string;
  path: string;
  body?: unknown;
  channel?: ToolExposureChannel;
  workflow?: string;
  certifiedMoveOneAdmission?: CertifiedMoveOneAdmission;
  laboratoryMoveEvidenceAdmission?: CertifiedMoveOneAdmission;
  laboratoryEvidence?: boolean;
  env?: NodeJS.ProcessEnv;
}): CertifiedCourierAdmission | undefined {
  const env = input.env ?? process.env;
  const runtime = getToolExposureRuntimeDecision(env);
  const protectedLaboratory = runtime.mode === "laboratory"
    && env.OPERATOR_CERTIFICATION_PROTECTED_LABORATORY === "1";
  if (!runtime.certified && !protectedLaboratory && runtime.mode !== "general") return undefined;
  const alias = String(invokedMcpAlias.getStore() ?? "").trim();
  if (!alias) {
    throw new ToolExposurePolicyError(
      "CERT_MCP_ALIAS_REQUIRED",
      "Certified courier publication requires an active MCP tool alias binding."
    );
  }
  if (input.certifiedMoveOneAdmission && input.laboratoryMoveEvidenceAdmission) {
    throw new ToolExposurePolicyError("CERT_REQUEST_FAMILY_VALIDATOR_INVALID", "Production and laboratory family admissions are mutually exclusive.");
  }
  const familyAdmission = input.certifiedMoveOneAdmission ?? input.laboratoryMoveEvidenceAdmission;
  let decision = input.laboratoryMoveEvidenceAdmission
    ? assertLaboratoryMoveEvidenceAdmissionExposure({ admission: input.laboratoryMoveEvidenceAdmission, channel: input.channel, alias, env })
    : input.certifiedMoveOneAdmission
    ? assertCertifiedMoveOneAdmissionExposure({ admission: input.certifiedMoveOneAdmission, channel: input.channel, alias, env })
    : input.laboratoryEvidence
    ? assertProtectedLaboratoryEvidenceExposure({
      method: input.method,
      path: input.path,
      body: input.body,
      channel: input.channel,
      workflow: input.workflow,
      alias,
      env
    })
    : assertToolExposure({
      method: input.method,
      path: input.path,
      body: input.body,
      channel: input.channel,
      workflow: input.workflow,
      alias,
      env
    });
  if (protectedLaboratory && input.laboratoryMoveEvidenceAdmission && input.workflow !== undefined) {
    decision = Object.freeze({ ...decision, workflow: input.workflow });
  }
  if (decision.method !== input.method || decision.path !== input.path) {
    throw new ToolExposurePolicyError("CERT_REQUEST_FAMILY_ROUTE_MISMATCH", "Certified request-family admission does not bind the requested route.");
  }
  const capability = Object.freeze({}) as unknown as CertifiedCourierAdmission;
  courierAdmissionDecisions.set(capability, decision);
  if (familyAdmission) courierMoveAdmissions.set(capability, familyAdmission);
  return capability;
}

export function readCertifiedCourierAdmissionBinding(capability: unknown): {
  decision: ToolExposureDecision;
  certifiedMoveOneAdmission?: CertifiedMoveOneAdmission;
} {
  const certifiedMoveOneAdmission = courierMoveAdmissions.get(capability as object);
  try {
    const decision = readCertifiedCourierAdmission(capability);
    return { decision, ...(certifiedMoveOneAdmission ? { certifiedMoveOneAdmission } : {}) };
  } finally {
    if (capability && (typeof capability === "object" || typeof capability === "function")) {
      courierMoveAdmissions.delete(capability as object);
    }
  }
}

/**
 * Intentionally accepts unknown: callers cannot manufacture a valid
 * capability from a structurally similar JSON DTO because membership in the
 * module-private WeakMap is required.
 */
export function readCertifiedCourierAdmission(capability: unknown): ToolExposureDecision {
  if (!capability || (typeof capability !== "object" && typeof capability !== "function")) {
    throw new ToolExposurePolicyError(
      "CERT_COURIER_ADMISSION_CAPABILITY_REQUIRED",
      "Certified courier publication requires an in-process admission capability."
    );
  }
  const decision = courierAdmissionDecisions.get(capability as object);
  if (!decision) {
    throw new ToolExposurePolicyError(
      "CERT_COURIER_ADMISSION_CAPABILITY_INVALID",
      "Certified courier publication rejected an unbranded or stale admission capability."
    );
  }
  // Consume before inspecting the context or returning. A failed replay from a
  // different execution context cannot leave a usable capability behind.
  courierAdmissionDecisions.delete(capability as object);
  courierMoveAdmissions.delete(capability as object);
  const activeAlias = String(invokedMcpAlias.getStore() ?? "").trim();
  if (!activeAlias) {
    throw new ToolExposurePolicyError(
      "CERT_COURIER_ADMISSION_CONTEXT_REQUIRED",
      "Certified courier publication requires the active MCP alias context that minted the admission capability."
    );
  }
  if (activeAlias !== decision.alias) {
    throw new ToolExposurePolicyError(
      "CERT_COURIER_ADMISSION_ALIAS_MISMATCH",
      "Certified courier publication rejected an admission capability bound to a different MCP alias."
    );
  }
  return decision;
}

export function runWithRevitToolAlias<T>(alias: string, operation: () => T): T {
  return invokedMcpAlias.run(alias, operation);
}

export function isMcpToolAliasExposed(alias: string, env: NodeJS.ProcessEnv = process.env): boolean {
  if (!alias.startsWith("revit_")) return true;
  if (!isCertifiedToolExposureMode(env)) return true;
  try {
    const { policy } = loadToolExposurePolicy(env);
    if (alias === "revit_call_tool") {
      return policy.records.some(record =>
        record.visibility !== "workflow_only" && record.channels.generic_call.exposed
      );
    }
    const records = policy.records.filter(record => record.typed_mcp_aliases.includes(alias));
    return records.length > 0 && records.every(record =>
      record.visibility !== "workflow_only" && record.channels.typed_mcp.exposed
    );
  } catch {
    return false;
  }
}

export function isCertifiedToolExposureMode(env: NodeJS.ProcessEnv = process.env): boolean {
  return getToolExposureRuntimeDecision(env).certified;
}

export function isKnownToolExposureRoute(method: string, toolPath: string, env: NodeJS.ProcessEnv = process.env): boolean {
  if (!isCertifiedToolExposureMode(env)) return true;
  const { policy } = loadToolExposurePolicy(env);
  const normalized = normalizedMethod(method);
  return policy.records.some(record => record.method === normalized && record.path === toolPath);
}

export function isToolRouteExposedForSearch(method: string, toolPath: string, env: NodeJS.ProcessEnv = process.env): boolean {
  if (!isCertifiedToolExposureMode(env)) return true;
  const { policy } = loadToolExposurePolicy(env);
  const normalized = normalizedMethod(method);
  return policy.records.some(record =>
    record.method === normalized
    && record.path === toolPath
    && record.visibility !== "workflow_only"
    && record.channels.search.exposed
  );
}

export function filterRegistryEntriesForSearch<T extends { method?: unknown; path?: unknown }>(
  entries: readonly T[],
  env: NodeJS.ProcessEnv = process.env
): T[] {
  if (!isCertifiedToolExposureMode(env)) return [...entries];
  const { policy } = loadToolExposurePolicy(env);
  const exposed = new Set(policy.records
    .filter(record => record.visibility !== "workflow_only" && record.channels.search.exposed)
    .map(record => `${record.method}\n${record.path}`));
  return entries.filter(entry => exposed.has(`${normalizedMethod(String(entry.method ?? ""))}\n${String(entry.path ?? "")}`));
}
