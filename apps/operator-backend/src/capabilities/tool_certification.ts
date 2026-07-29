import { createHash } from "node:crypto";

export const CERTIFICATION_LEVELS = ["L0", "L1", "L2", "L3", "L4", "L5"] as const;
export type CertificationLevel = typeof CERTIFICATION_LEVELS[number];

export const EXPOSURE_CHANNELS = ["search", "generic_call", "typed_mcp", "deterministic_workflow"] as const;
export type ExposureChannel = typeof EXPOSURE_CHANNELS[number];

export const CERTIFICATION_REASON_CODES = {
  certified: "CERTIFIED",
  missing: "CERT_EVIDENCE_MISSING",
  unknown: "CERT_EVIDENCE_UNKNOWN",
  unknownLevel: "CERT_EVIDENCE_UNKNOWN_LEVEL",
  duplicateLevel: "CERT_EVIDENCE_DUPLICATE_LEVEL",
  gap: "CERT_EVIDENCE_GAP",
  stale: "CERT_EVIDENCE_STALE",
  revoked: "CERT_EVIDENCE_REVOKED",
  mismatched: "CERT_EVIDENCE_MISMATCHED",
  requestHashMismatch: "CERT_REQUEST_HASH_MISMATCH",
  effectHashMismatch: "CERT_EFFECT_HASH_MISMATCH",
  recordHashMismatch: "CERT_RECORD_HASH_MISMATCH",
  channelNotRequested: "CERT_CHANNEL_NOT_REQUESTED",
  workflowOnly: "CERT_WORKFLOW_ONLY",
  levelInsufficient: "CERT_LEVEL_INSUFFICIENT"
} as const;

export type CertificationReasonCode = typeof CERTIFICATION_REASON_CODES[keyof typeof CERTIFICATION_REASON_CODES];
export type EvidenceStatus = "verified" | "unknown" | "stale" | "revoked" | "mismatched";
export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

export type CertificationEvidence = {
  levels: (CertificationLevel | string)[];
  state: EvidenceStatus | string;
  provenance: string;
};

export type ToolCertificationRecord = {
  method: string;
  path: string;
  request: JsonValue;
  effect: JsonValue;
  requested_channels: ExposureChannel[];
  visibility: "candidate" | "workflow_only";
  evidence: CertificationEvidence;
  request_hash: string;
  effect_hash: string;
  record_hash: string;
};

export type ToolCertificationEvidenceFile = {
  schema: "revit-operator.tool-certification-evidence.v1";
  hash_algorithm: "sha256";
  provenance: {
    source: string;
    source_hash: string;
  };
  records: ToolCertificationRecord[];
};

export type ChannelDecision = {
  exposed: boolean;
  required_level: CertificationLevel;
  reason_codes: CertificationReasonCode[];
};

export type ToolExposurePolicyRecord = {
  method: string;
  path: string;
  request_hash: string;
  effect_hash: string;
  evidence_record_hash: string;
  highest_cumulative_level: CertificationLevel | null;
  observed_levels: CertificationLevel[];
  visibility: "candidate" | "workflow_only";
  channels: Record<ExposureChannel, ChannelDecision>;
  policy_record_hash: string;
};

export type ToolExposurePolicy = {
  schema: "revit-operator.tool-exposure-policy.v1";
  hash_algorithm: "sha256";
  evidence_schema: ToolCertificationEvidenceFile["schema"];
  evidence_source_hash: string;
  records: ToolExposurePolicyRecord[];
  policy_hash: string;
};

const REQUIRED_LEVEL: Record<ExposureChannel, CertificationLevel> = {
  search: "L3",
  generic_call: "L4",
  typed_mcp: "L4",
  deterministic_workflow: "L4"
};

function normalizeString(value: string): string {
  return value.replace(/\r\n?/g, "\n").normalize("NFC");
}

function assertJsonValue(value: unknown, location = "value"): asserts value is JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error(`${location} contains a non-finite number`);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertJsonValue(item, `${location}[${index}]`));
    return;
  }
  if (typeof value === "object") {
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      if (item === undefined) throw new Error(`${location}.${key} is undefined`);
      assertJsonValue(item, `${location}.${key}`);
    }
    return;
  }
  throw new Error(`${location} is not canonical JSON data`);
}

function canonicalValue(value: JsonValue): JsonValue {
  if (typeof value === "string") return normalizeString(value);
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort((left, right) => left.localeCompare(right, "en"))
        .map(key => [normalizeString(key), canonicalValue(value[key]!)])
    );
  }
  return value;
}

export function canonicalJson(value: JsonValue): string {
  assertJsonValue(value);
  return JSON.stringify(canonicalValue(value));
}

export function sha256(value: JsonValue): string {
  return `sha256:${createHash("sha256").update(canonicalJson(value), "utf8").digest("hex")}`;
}

export function normalizeMethod(method: string): string {
  const normalized = method.trim().toUpperCase();
  if (!/^[A-Z]+$/.test(normalized)) throw new Error(`Invalid HTTP method: ${method}`);
  return normalized;
}

export function normalizeToolPath(toolPath: string): string {
  const normalized = toolPath.trim().replace(/\\/g, "/").replace(/\/{2,}/g, "/");
  if (!normalized.startsWith("/revit/") || normalized.includes("?") || (normalized.length > 1 && normalized.endsWith("/"))) {
    throw new Error(`Invalid exact Revit tool path: ${toolPath}`);
  }
  return normalized;
}

export function computeRequestHash(method: string, toolPath: string, request: JsonValue): string {
  return sha256({ method: normalizeMethod(method), path: normalizeToolPath(toolPath), request: canonicalValue(request) });
}

export function computeEffectHash(effect: JsonValue): string {
  return sha256({ effect: canonicalValue(effect) });
}

function recordHashPayload(record: Omit<ToolCertificationRecord, "record_hash">): JsonValue {
  return {
    method: normalizeMethod(record.method),
    path: normalizeToolPath(record.path),
    request: canonicalValue(record.request),
    effect: canonicalValue(record.effect),
    requested_channels: [...record.requested_channels].sort(),
    visibility: record.visibility,
    evidence: {
      levels: record.evidence.levels.map(normalizeString),
      state: normalizeString(record.evidence.state),
      provenance: normalizeString(record.evidence.provenance)
    },
    request_hash: record.request_hash,
    effect_hash: record.effect_hash
  };
}

export function computeEvidenceRecordHash(record: Omit<ToolCertificationRecord, "record_hash">): string {
  return sha256(recordHashPayload(record));
}

export function sealEvidenceRecord(
  record: Omit<ToolCertificationRecord, "request_hash" | "effect_hash" | "record_hash">
): ToolCertificationRecord {
  assertJsonValue(record.request, "request");
  assertJsonValue(record.effect, "effect");
  const sealed = {
    ...record,
    method: normalizeMethod(record.method),
    path: normalizeToolPath(record.path),
    request: canonicalValue(record.request),
    effect: canonicalValue(record.effect),
    request_hash: computeRequestHash(record.method, record.path, record.request),
    effect_hash: computeEffectHash(record.effect)
  };
  return { ...sealed, record_hash: computeEvidenceRecordHash(sealed) };
}

function levelIndex(level: string): number {
  return (CERTIFICATION_LEVELS as readonly string[]).indexOf(level);
}

function evidenceAssessment(record: ToolCertificationRecord): {
  blocking: CertificationReasonCode[];
  highest: CertificationLevel | null;
  observed: CertificationLevel[];
} {
  const blocking = new Set<CertificationReasonCode>();
  const byLevel = new Set<CertificationLevel>();
  let hasUnknownLevel = false;

  if (record.evidence.levels.length === 0) blocking.add(CERTIFICATION_REASON_CODES.missing);
  if (record.evidence.state === "unknown") blocking.add(CERTIFICATION_REASON_CODES.unknown);
  else if (record.evidence.state === "stale") blocking.add(CERTIFICATION_REASON_CODES.stale);
  else if (record.evidence.state === "revoked") blocking.add(CERTIFICATION_REASON_CODES.revoked);
  else if (record.evidence.state === "mismatched") blocking.add(CERTIFICATION_REASON_CODES.mismatched);
  else if (record.evidence.state !== "verified") blocking.add(CERTIFICATION_REASON_CODES.unknown);

  for (const item of record.evidence.levels) {
    const index = levelIndex(item);
    if (index < 0) {
      hasUnknownLevel = true;
      continue;
    }
    const level = CERTIFICATION_LEVELS[index]!;
    if (byLevel.has(level)) blocking.add(CERTIFICATION_REASON_CODES.duplicateLevel);
    byLevel.add(level);
  }
  if (hasUnknownLevel) blocking.add(CERTIFICATION_REASON_CODES.unknownLevel);

  const observed = record.evidence.state === "verified" ? CERTIFICATION_LEVELS.filter(level => byLevel.has(level)) : [];
  let highest: CertificationLevel | null = null;
  for (const level of CERTIFICATION_LEVELS) {
    if (!byLevel.has(level)) {
      if (CERTIFICATION_LEVELS.some(candidate => levelIndex(candidate) > levelIndex(level) && byLevel.has(candidate))) {
        blocking.add(CERTIFICATION_REASON_CODES.gap);
      }
      break;
    }
    if (record.evidence.state !== "verified") break;
    highest = level;
  }

  return { blocking: [...blocking].sort(), highest, observed };
}

function hashAssessment(record: ToolCertificationRecord): CertificationReasonCode[] {
  const reasons = new Set<CertificationReasonCode>();
  if (record.request_hash !== computeRequestHash(record.method, record.path, record.request)) {
    reasons.add(CERTIFICATION_REASON_CODES.requestHashMismatch);
  }
  if (record.effect_hash !== computeEffectHash(record.effect)) {
    reasons.add(CERTIFICATION_REASON_CODES.effectHashMismatch);
  }
  const { record_hash: _recordHash, ...withoutRecordHash } = record;
  if (record.record_hash !== computeEvidenceRecordHash(withoutRecordHash)) {
    reasons.add(CERTIFICATION_REASON_CODES.recordHashMismatch);
  }
  return [...reasons].sort();
}

function decision(
  channel: ExposureChannel,
  record: ToolCertificationRecord,
  highest: CertificationLevel | null,
  blocking: CertificationReasonCode[]
): ChannelDecision {
  const requiredLevel = REQUIRED_LEVEL[channel];
  if (blocking.length > 0) return { exposed: false, required_level: requiredLevel, reason_codes: blocking };
  if (record.visibility === "workflow_only" && channel !== "deterministic_workflow") {
    return { exposed: false, required_level: requiredLevel, reason_codes: [CERTIFICATION_REASON_CODES.workflowOnly] };
  }
  if (!record.requested_channels.includes(channel)) {
    return { exposed: false, required_level: requiredLevel, reason_codes: [CERTIFICATION_REASON_CODES.channelNotRequested] };
  }
  if (highest === null || levelIndex(highest) < levelIndex(requiredLevel)) {
    return { exposed: false, required_level: requiredLevel, reason_codes: [CERTIFICATION_REASON_CODES.levelInsufficient] };
  }
  return { exposed: true, required_level: requiredLevel, reason_codes: [CERTIFICATION_REASON_CODES.certified] };
}

function policyRecordHashPayload(record: Omit<ToolExposurePolicyRecord, "policy_record_hash">): JsonValue {
  return record as unknown as JsonValue;
}

export function generateToolExposurePolicy(evidenceFile: ToolCertificationEvidenceFile): ToolExposurePolicy {
  if (evidenceFile.schema !== "revit-operator.tool-certification-evidence.v1") throw new Error("Unsupported evidence schema");
  if (evidenceFile.hash_algorithm !== "sha256") throw new Error("Unsupported evidence hash algorithm");

  const identities = new Set<string>();
  const records = evidenceFile.records.map(record => {
    const method = normalizeMethod(record.method);
    const toolPath = normalizeToolPath(record.path);
    assertJsonValue(record.request, "request");
    assertJsonValue(record.effect, "effect");
    const identity = `${method} ${toolPath} ${record.request_hash} ${record.effect_hash}`;
    if (identities.has(identity)) throw new Error(`Duplicate certification identity: ${identity}`);
    identities.add(identity);

    const evidence = evidenceAssessment(record);
    const blocking = [...new Set([...hashAssessment(record), ...evidence.blocking])].sort();
    const base: Omit<ToolExposurePolicyRecord, "policy_record_hash"> = {
      method,
      path: toolPath,
      request_hash: record.request_hash,
      effect_hash: record.effect_hash,
      evidence_record_hash: record.record_hash,
      highest_cumulative_level: evidence.highest,
      observed_levels: evidence.observed,
      visibility: record.visibility,
      channels: Object.fromEntries(EXPOSURE_CHANNELS.map(channel => [
        channel,
        decision(channel, record, evidence.highest, blocking)
      ])) as Record<ExposureChannel, ChannelDecision>
    };
    return { ...base, policy_record_hash: sha256(policyRecordHashPayload(base)) };
  }).sort((left, right) => {
    const keyOrder = `${left.method} ${left.path} ${left.request_hash}`.localeCompare(`${right.method} ${right.path} ${right.request_hash}`, "en");
    return keyOrder || left.effect_hash.localeCompare(right.effect_hash, "en");
  });

  const base: Omit<ToolExposurePolicy, "policy_hash"> = {
    schema: "revit-operator.tool-exposure-policy.v1",
    hash_algorithm: "sha256",
    evidence_schema: evidenceFile.schema,
    evidence_source_hash: evidenceFile.provenance.source_hash,
    records
  };
  return { ...base, policy_hash: sha256(base as unknown as JsonValue) };
}

export function renderCanonicalDocument(value: JsonValue): string {
  return `${canonicalJson(value)}\n`;
}
