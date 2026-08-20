import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  normalizeMethod,
  normalizeToolPath,
  sha256,
  type ExposureChannel,
  type ToolExposurePolicy,
  type ToolExposurePolicyRecord
} from "./tool_certification.js";
import {
  assertPolicyBindsCertifiedRequestFamily,
  assertValidatedCertifiedRequestFamilyAdmission,
  type ValidatedCertifiedRequestFamilyAdmission
} from "./certified_request_family_admission.js";

export const BUNDLED_TOOL_EXPOSURE_POLICY_HASH = "sha256:db58c5b7f28caf8045f6d949083ce80d29126e33feabbefbd648f9fd936e21cf";

const POLICY_FILENAME = "tool_exposure_policy.v1.json";
const SHA256 = /^sha256:[0-9a-f]{64}$/;
const ALIAS = /^[a-z][a-z0-9_]*$/;
const CHANNELS: readonly ExposureChannel[] = ["search", "generic_call", "typed_mcp", "deterministic_workflow"];
const LEVELS = ["L0", "L1", "L2", "L3", "L4", "L5"] as const;
const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
const SAFE_READ_STANDALONE_BINDING = Object.freeze({
  method: "POST",
  path: "/revit/certified/sheets/count",
  alias: "revit_count_sheets_certified",
  executor_id: "revit-operator.safe-read-host.v1",
  route_id: "safe_read.sheet_count.v1",
  transport: "direct_loopback"
});

export type TrustedToolExposurePolicy = {
  policy: ToolExposurePolicy;
  trustSource: "bundled" | "deployment";
  policyPath: string;
};

export class TrustedToolExposurePolicyError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "TrustedToolExposurePolicyError";
  }
}

function own(value: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function asObject(value: unknown, location: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TrustedToolExposurePolicyError("CERTIFICATION_POLICY_INVALID", `${location} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, required: readonly string[], location: string): void {
  const allowed = new Set(required);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) {
      throw new TrustedToolExposurePolicyError("CERTIFICATION_POLICY_INVALID", `${location} contains unknown field ${key}.`);
    }
  }
  for (const key of required) {
    if (!own(value, key)) {
      throw new TrustedToolExposurePolicyError("CERTIFICATION_POLICY_INVALID", `${location} is missing ${key}.`);
    }
  }
}

function requiredHash(value: unknown, location: string): string {
  if (typeof value !== "string" || !SHA256.test(value)) {
    throw new TrustedToolExposurePolicyError("CERTIFICATION_POLICY_INVALID", `${location} is not a canonical SHA-256 value.`);
  }
  return value;
}

export function parseTrustedToolExposurePolicy(value: unknown): ToolExposurePolicy {
  const policy = asObject(value, "certification policy");
  exactKeys(policy, ["schema", "hash_algorithm", "evidence_schema", "evidence_source_hash", "records", "policy_hash"], "certification policy");
  if (policy.schema !== "revit-operator.tool-exposure-policy.v1" || policy.hash_algorithm !== "sha256"
    || policy.evidence_schema !== "revit-operator.tool-certification-evidence.v1") {
    throw new TrustedToolExposurePolicyError("CERTIFICATION_POLICY_INVALID", "Certification policy schema is unsupported.");
  }
  requiredHash(policy.evidence_source_hash, "certification policy evidence source hash");
  const declaredHash = requiredHash(policy.policy_hash, "certification policy hash");
  if (!Array.isArray(policy.records) || policy.records.length === 0) {
    throw new TrustedToolExposurePolicyError("CERTIFICATION_POLICY_INVALID", "Certification policy has no records.");
  }
  const identities = new Set<string>();
  for (const [index, raw] of policy.records.entries()) {
    const record = asObject(raw, `certification policy record ${index}`);
    const hasExecutionSurface = own(record, "execution_surface");
    const hasRequestFamily = own(record, "request_family");
    exactKeys(record, [
      "method", "path", "typed_mcp_aliases", "request_hash", "effect_hash", "evidence_record_hash",
      "highest_cumulative_level", "observed_levels", "visibility", "channels", "policy_record_hash",
      ...(hasExecutionSurface ? ["execution_surface"] : []),
      ...(hasRequestFamily ? ["request_family"] : [])
    ], `certification policy record ${index}`);
    try {
      if (normalizeMethod(String(record.method ?? "")) !== record.method || normalizeToolPath(String(record.path ?? "")) !== record.path) {
        throw new Error("noncanonical");
      }
    } catch {
      throw new TrustedToolExposurePolicyError("CERTIFICATION_POLICY_INVALID", "Certification policy record method/path is noncanonical.");
    }
    for (const field of ["request_hash", "effect_hash", "evidence_record_hash", "policy_record_hash"] as const) {
      requiredHash(record[field], `certification policy record ${index}.${field}`);
    }
    if (hasRequestFamily) {
      const family = asObject(record.request_family, `certification policy record ${index}.request_family`);
      exactKeys(family, ["schema", "id", "validator_hash"], `certification policy record ${index}.request_family`);
      if (family.schema !== "revit-operator.certified-request-family.v1"
        || typeof family.id !== "string" || !/^[a-z][a-z0-9._-]*$/.test(family.id)) {
        throw new TrustedToolExposurePolicyError("CERTIFICATION_POLICY_INVALID", "Certification policy request family is invalid.");
      }
      requiredHash(family.validator_hash, `certification policy record ${index}.request_family.validator_hash`);
    }
    if (!Array.isArray(record.typed_mcp_aliases)
      || record.typed_mcp_aliases.some(alias => typeof alias !== "string" || !ALIAS.test(alias))) {
      throw new TrustedToolExposurePolicyError("CERTIFICATION_POLICY_INVALID", "Certification policy aliases are invalid.");
    }
    const aliases = record.typed_mcp_aliases as string[];
    if (new Set(aliases).size !== aliases.length || aliases.some((alias, aliasIndex) => aliasIndex > 0 && aliases[aliasIndex - 1]! >= alias)) {
      throw new TrustedToolExposurePolicyError("CERTIFICATION_POLICY_INVALID", "Certification policy aliases must be unique and ordinal-sorted.");
    }
    if (record.typed_mcp_aliases.includes("revit_call_tool")) {
      throw new TrustedToolExposurePolicyError("CERTIFICATION_POLICY_INVALID", "Certification policy cannot bind revit_call_tool as a typed alias.");
    }
    const referencesSafeRead = record.path === SAFE_READ_STANDALONE_BINDING.path
      || aliases.includes(SAFE_READ_STANDALONE_BINDING.alias);
    if (referencesSafeRead !== hasExecutionSurface) {
      throw new TrustedToolExposurePolicyError(
        "CERTIFICATION_POLICY_INVALID",
        "Certification policy SafeRead path and alias require the exact standalone execution_surface."
      );
    }
    const observedLevels = record.observed_levels;
    if ((record.highest_cumulative_level !== null && !(LEVELS as readonly unknown[]).includes(record.highest_cumulative_level))
      || !Array.isArray(observedLevels)
      || observedLevels.some(level => !(LEVELS as readonly unknown[]).includes(level))
      || new Set(observedLevels).size !== observedLevels.length
      || observedLevels.some((level, levelIndex) => levelIndex > 0
        && LEVELS.indexOf(observedLevels[levelIndex - 1] as typeof LEVELS[number]) >= LEVELS.indexOf(level as typeof LEVELS[number]))) {
      throw new TrustedToolExposurePolicyError("CERTIFICATION_POLICY_INVALID", "Certification policy levels are invalid or noncanonical.");
    }
    if (record.visibility !== "candidate" && record.visibility !== "workflow_only") {
      throw new TrustedToolExposurePolicyError("CERTIFICATION_POLICY_INVALID", "Certification policy visibility is invalid.");
    }
    const channels = asObject(record.channels, `certification policy record ${index}.channels`);
    exactKeys(channels, CHANNELS, `certification policy record ${index}.channels`);
    for (const channel of CHANNELS) {
      const decision = asObject(channels[channel], `certification policy record ${index}.channels.${channel}`);
      exactKeys(decision, ["exposed", "required_level", "reason_codes"], `certification policy record ${index}.channels.${channel}`);
      if (typeof decision.exposed !== "boolean" || !/^L[0-5]$/.test(String(decision.required_level))
        || !Array.isArray(decision.reason_codes) || decision.reason_codes.some(reason => typeof reason !== "string")) {
        throw new TrustedToolExposurePolicyError("CERTIFICATION_POLICY_INVALID", "Certification policy channel decision is invalid.");
      }
    }
    if (hasExecutionSurface) {
      const surface = asObject(record.execution_surface, `certification policy record ${index}.execution_surface`);
      exactKeys(surface, ["kind", "executor_id", "route_id", "transport"], `certification policy record ${index}.execution_surface`);
      if (surface.kind !== "standalone_executor"
        || surface.executor_id !== SAFE_READ_STANDALONE_BINDING.executor_id
        || surface.route_id !== SAFE_READ_STANDALONE_BINDING.route_id
        || surface.transport !== SAFE_READ_STANDALONE_BINDING.transport
        || record.method !== SAFE_READ_STANDALONE_BINDING.method
        || record.path !== SAFE_READ_STANDALONE_BINDING.path
        || record.visibility !== "candidate"
        || aliases.length !== 1
        || aliases[0] !== SAFE_READ_STANDALONE_BINDING.alias) {
        throw new TrustedToolExposurePolicyError(
          "CERTIFICATION_POLICY_INVALID",
          "Certification policy standalone executor attribution is not the reviewed SafeRead binding."
        );
      }
      for (const channel of ["search", "generic_call", "deterministic_workflow"] as const) {
        if ((channels[channel] as Record<string, unknown>).exposed === true) {
          throw new TrustedToolExposurePolicyError(
            "CERTIFICATION_POLICY_INVALID",
            `Certification policy standalone executor cannot expose the ${channel} channel.`
          );
        }
      }
    }
    const { policy_record_hash: recordHash, ...recordPayload } = record;
    if (recordHash !== sha256(recordPayload as never)) {
      throw new TrustedToolExposurePolicyError("CERTIFICATION_POLICY_INVALID", "Certification policy record hash is invalid.");
    }
    const family = hasRequestFamily ? record.request_family as Record<string, unknown> : undefined;
    const identity = `${record.method}\n${record.path}\n${record.request_hash}\n${record.effect_hash}\n${family?.id ?? ""}\n${family?.validator_hash ?? ""}`;
    if (identities.has(identity)) {
      throw new TrustedToolExposurePolicyError("CERTIFICATION_POLICY_INVALID", "Certification policy has duplicate exact records.");
    }
    identities.add(identity);
  }
  const { policy_hash: _policyHash, ...payload } = policy;
  if (declaredHash !== sha256(payload as never)) {
    throw new TrustedToolExposurePolicyError("CERTIFICATION_POLICY_INVALID", "Certification policy hash is invalid.");
  }
  return policy as unknown as ToolExposurePolicy;
}

function bundledPolicyPath(): string {
  // Source execution resolves ../../config. Compiled execution resolves
  // ../../../config because TypeScript emits this module below dist/src.
  // Never consult cwd: a launch directory must not be able to replace trust.
  const candidates = [
    path.resolve(MODULE_DIR, "../../config", POLICY_FILENAME),
    path.resolve(MODULE_DIR, "../../../config", POLICY_FILENAME)
  ];
  return candidates.find(candidate => fs.existsSync(candidate)) ?? candidates[0]!;
}

function trustedPolicyConfiguration(env: NodeJS.ProcessEnv): {
  policyPath: string;
  trustedHash: string;
  trustSource: "bundled" | "deployment";
} {
  const explicitPath = String(env.OPERATOR_TOOL_EXPOSURE_POLICY_PATH ?? "").trim();
  const explicitHash = String(env.OPERATOR_TOOL_EXPOSURE_POLICY_SHA256 ?? "").trim();
  if (explicitPath) {
    if (path.extname(explicitPath).toLowerCase() !== ".json" || !SHA256.test(explicitHash)) {
      throw new TrustedToolExposurePolicyError(
        "CERTIFICATION_POLICY_UNAVAILABLE",
        "Deployment certification policy path or trusted hash is invalid."
      );
    }
    return { policyPath: path.resolve(explicitPath), trustedHash: explicitHash, trustSource: "deployment" };
  }
  if (explicitHash && !SHA256.test(explicitHash)) {
    throw new TrustedToolExposurePolicyError("CERTIFICATION_POLICY_UNAVAILABLE", "Deployment certification policy hash is invalid.");
  }
  return {
    policyPath: bundledPolicyPath(),
    trustedHash: explicitHash || BUNDLED_TOOL_EXPOSURE_POLICY_HASH,
    trustSource: explicitHash ? "deployment" : "bundled"
  };
}

export function loadTrustedToolExposurePolicy(env: NodeJS.ProcessEnv = process.env): TrustedToolExposurePolicy {
  const configured = trustedPolicyConfiguration(env);
  let raw: string;
  try {
    raw = fs.readFileSync(configured.policyPath, "utf8");
  } catch {
    throw new TrustedToolExposurePolicyError("CERTIFICATION_POLICY_UNAVAILABLE", "Current certification policy is unavailable.");
  }
  let policy: ToolExposurePolicy;
  try {
    policy = parseTrustedToolExposurePolicy(JSON.parse(raw.replace(/^\uFEFF/, "")));
  } catch (error) {
    if (error instanceof TrustedToolExposurePolicyError) throw error;
    throw new TrustedToolExposurePolicyError("CERTIFICATION_POLICY_INVALID", "Current certification policy is malformed.");
  }
  if (policy.policy_hash !== configured.trustedHash) {
    throw new TrustedToolExposurePolicyError(
      "CERTIFICATION_POLICY_ROLLBACK_REJECTED",
      "Current certification policy does not match its trusted deployment anchor."
    );
  }
  return { policy, trustSource: configured.trustSource, policyPath: configured.policyPath };
}

export type TrustedToolExposureEvaluation = {
  record: ToolExposurePolicyRecord;
  channel: ExposureChannel;
};

export function evaluateTrustedToolExposurePolicy(input: {
  policy: ToolExposurePolicy;
  method: string;
  path: string;
  requestHash: string;
  effectHash?: string;
  channel: ExposureChannel;
  alias?: string;
  /** Opaque process-local result of the reviewed deterministic validator. */
  requestFamilyAdmission?: ValidatedCertifiedRequestFamilyAdmission;
}): TrustedToolExposureEvaluation {
  if (input.requestFamilyAdmission) {
    try { assertValidatedCertifiedRequestFamilyAdmission(input.requestFamilyAdmission); }
    catch { throw new TrustedToolExposurePolicyError("CERTIFICATION_POLICY_DENIED", "Parameterized request-family admission was not locally validated."); }
  }
  const matches = input.policy.records.filter(record =>
    record.method === input.method
    && record.path === input.path
    && (input.requestFamilyAdmission
      ? record.request_family?.id === input.requestFamilyAdmission.family_id
        && record.request_family.validator_hash === input.requestFamilyAdmission.family_hash
      : record.request_hash === input.requestHash)
    && (input.effectHash === undefined || record.effect_hash === input.effectHash)
  );
  if (matches.length !== 1) {
    throw new TrustedToolExposurePolicyError(
      "CERTIFICATION_POLICY_DENIED",
      "Current certification policy does not contain one exact certified method, path, request, and effect."
    );
  }
  const record = matches[0]!;
  if (input.requestFamilyAdmission) {
    try { assertPolicyBindsCertifiedRequestFamily(input.requestFamilyAdmission, record); }
    catch { throw new TrustedToolExposurePolicyError("CERTIFICATION_POLICY_DENIED", "Current certification policy does not bind the locally validated request family."); }
  }
  const decision = record.channels[input.channel];
  if (!decision?.exposed || (record.visibility === "workflow_only" && input.channel !== "deterministic_workflow")) {
    throw new TrustedToolExposurePolicyError("CERTIFICATION_POLICY_DENIED", "Current certification policy does not expose this exact channel.");
  }
  if (input.channel === "generic_call") {
    if (input.alias !== "revit_call_tool") {
      throw new TrustedToolExposurePolicyError("CERTIFICATION_POLICY_DENIED", "Generic certification alias is invalid.");
    }
    return { record, channel: input.channel };
  }
  if (input.channel === "deterministic_workflow") return { record, channel: input.channel };
  const alias = input.alias ?? "";
  const aliasRecords = input.policy.records.filter(candidate => candidate.typed_mcp_aliases.includes(alias));
  const aliasChannel = input.channel === "search" ? "search" : "typed_mcp";
  const routeBindsAlias = record.typed_mcp_aliases.includes(alias);
  const conjunctionAllowed = aliasRecords.length > 0 && aliasRecords.every(candidate =>
    candidate.visibility !== "workflow_only" && candidate.channels[aliasChannel].exposed
  );
  if (!routeBindsAlias || !conjunctionAllowed) {
    throw new TrustedToolExposurePolicyError(
      "CERTIFICATION_POLICY_DENIED",
      "Current certification policy does not expose the exact bound alias conjunction."
    );
  }
  return { record, channel: input.channel };
}
