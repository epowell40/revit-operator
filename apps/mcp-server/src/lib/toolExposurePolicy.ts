import { createHash } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { revitRouteEffect } from "./revitRouteEffect.js";

export const TOOL_EXPOSURE_CHANNELS = ["search", "generic_call", "typed_mcp", "deterministic_workflow"] as const;
export type ToolExposureChannel = typeof TOOL_EXPOSURE_CHANNELS[number];
export type ToolExposureMode = "certified" | "laboratory";

type ChannelDecision = {
  exposed: boolean;
  required_level: string;
  reason_codes: string[];
};

export type ToolExposurePolicyRecord = {
  method: string;
  path: string;
  request_hash: string;
  effect_hash: string;
  evidence_record_hash: string;
  highest_cumulative_level: string | null;
  observed_levels: string[];
  visibility: "candidate" | "workflow_only";
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
  visibility?: ToolExposurePolicyRecord["visibility"];
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
const BUNDLED_POLICY_HASH = "sha256:d6204c2576e83a96586f0b4bc575d7f68c7325e3efb32566ba6204e1aa3d2624";
const invokedMcpAlias = new AsyncLocalStorage<string>();

function normalizeRuntimeMode(value: unknown): string {
  return String(value ?? "local").trim().toLowerCase().replace(/-/g, "_") || "local";
}

export function getToolExposureRuntimeDecision(env: NodeJS.ProcessEnv = process.env): ToolExposureRuntimeDecision {
  const runtimeMode = normalizeRuntimeMode(env.REVIT_OPERATOR_MODE);
  const requested = String(env.OPERATOR_TOOL_EXPOSURE_PROFILE ?? "").trim().toLowerCase();
  if (requested && requested !== "certified" && requested !== "laboratory") {
    return {
      runtimeMode,
      mode: "certified",
      certified: true,
      explicitLaboratory: false,
      reason: `invalid OPERATOR_TOOL_EXPOSURE_PROFILE=${requested}; failing closed`
    };
  }

  if (runtimeMode === "hosted" || runtimeMode === "production") {
    return {
      runtimeMode,
      mode: "certified",
      certified: true,
      explicitLaboratory: false,
      reason: requested === "laboratory"
        ? "laboratory mode is not permitted in hosted or production runtime; failing closed"
        : "hosted and production runtimes require certified exposure"
    };
  }

  if (runtimeMode === "development") {
    const laboratory = requested === "laboratory";
    return {
      runtimeMode,
      mode: laboratory ? "laboratory" : "certified",
      certified: !laboratory,
      explicitLaboratory: laboratory,
      reason: laboratory
        ? "explicit development laboratory escape is active"
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

function canonicalValue(value: unknown, location = "value"): unknown {
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "string") return normalizeText(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error(`${location} contains a non-finite number`);
    return value;
  }
  if (Array.isArray(value)) return value.map((item, index) => canonicalValue(item, `${location}[${index}]`));
  if (!value || typeof value !== "object") throw new Error(`${location} is not canonical JSON data`);
  const entries = Object.entries(value as Record<string, unknown>)
    .map(([key, item]) => [normalizeText(key), item] as const)
    .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0);
  const result: Record<string, unknown> = {};
  for (const [key, item] of entries) {
    if (Object.prototype.hasOwnProperty.call(result, key)) throw new Error(`${location} contains a normalized key collision`);
    if (item === undefined) throw new Error(`${location}.${key} is undefined`);
    result[key] = canonicalValue(item, `${location}.${key}`);
  }
  return result;
}

function digest(value: unknown): string {
  const canonical = JSON.stringify(canonicalValue(value));
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

function parsePolicyRecord(value: unknown, index: number): ToolExposurePolicyRecord {
  const location = `policy.records[${index}]`;
  assertObject(value, location);
  assertExactKeys(value, [
    "method", "path", "request_hash", "effect_hash", "evidence_record_hash", "highest_cumulative_level",
    "observed_levels", "visibility", "typed_mcp_aliases", "channels", "policy_record_hash"
  ], [], location);
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
  assertCanonicalAliasArray(value.typed_mcp_aliases, `${location}.typed_mcp_aliases`);
  if (value.typed_mcp_aliases.includes("revit_call_tool")) throw new Error(`${location}.typed_mcp_aliases cannot bind the generic revit_call_tool surface`);
  assertObject(value.channels, `${location}.channels`);
  const channelsRaw = value.channels;
  assertExactKeys(channelsRaw, TOOL_EXPOSURE_CHANNELS, [], `${location}.channels`);
  const channels = Object.fromEntries(TOOL_EXPOSURE_CHANNELS.map(channel => [
    channel,
    parseChannelDecision(channelsRaw[channel], `${location}.channels.${channel}`)
  ])) as Record<ToolExposureChannel, ChannelDecision>;
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
    const identity = `${record.method}\n${record.path}\n${record.request_hash}\n${record.effect_hash}`;
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

export function evaluateToolExposure(input: {
  method: string;
  path: string;
  body?: unknown;
  channel?: ToolExposureChannel;
  workflow?: string;
  alias?: string;
  env?: NodeJS.ProcessEnv;
}): ToolExposureDecision {
  const env = input.env ?? process.env;
  const runtime = getToolExposureRuntimeDecision(env);
  const method = normalizedMethod(input.method);
  const channel = input.channel ?? "typed_mcp";
  if (!(TOOL_EXPOSURE_CHANNELS as readonly string[]).includes(channel)) {
    throw new ToolExposurePolicyError("TOOL_EXPOSURE_CHANNEL_INVALID", `Unsupported tool exposure channel: ${String(channel)}.`);
  }
  const reqHash = requestHash(method, input.path, input.body, runtime.certified);
  const effHash = effectHash(input.path, method, input.body, input.workflow);
  if (runtime.mode === "laboratory") {
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
      reasonCodes: ["LABORATORY_MODE_ACTIVE"]
    };
  }

  const { policy, policyPath } = loadToolExposurePolicy(env);
  const routeRecords = policy.records.filter(record => record.method === method && record.path === input.path);
  const requestRecords = routeRecords.filter(record => record.request_hash === reqHash);
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
      policyHash: policy.policy_hash
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
      visibility: record.visibility
    };
  }
  const alias = String(input.alias ?? invokedMcpAlias.getStore() ?? "").trim();
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
      visibility: record.visibility
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
        visibility: record.visibility
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
    visibility: record.visibility
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
