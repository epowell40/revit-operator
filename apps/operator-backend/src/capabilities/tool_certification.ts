import { createHash } from "node:crypto";

export const CERTIFICATION_LEVELS = ["L0", "L1", "L2", "L3", "L4", "L5"] as const;
export type CertificationLevel = typeof CERTIFICATION_LEVELS[number];

export const EXPOSURE_CHANNELS = ["search", "generic_call", "typed_mcp", "deterministic_workflow"] as const;
export type ExposureChannel = typeof EXPOSURE_CHANNELS[number];

export const EVIDENCE_STATUSES = ["verified", "unknown", "stale", "revoked", "mismatched"] as const;
export type EvidenceStatus = typeof EVIDENCE_STATUSES[number];

export const TOOL_VISIBILITIES = ["candidate", "workflow_only"] as const;
export type ToolVisibility = typeof TOOL_VISIBILITIES[number];

const HTTP_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"] as const;
const GENERIC_MCP_TOOL = "revit_call_tool";

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
  typedMcpAliasUnknown: "CERT_TYPED_MCP_ALIAS_UNKNOWN",
  channelNotRequested: "CERT_CHANNEL_NOT_REQUESTED",
  workflowOnly: "CERT_WORKFLOW_ONLY",
  levelInsufficient: "CERT_LEVEL_INSUFFICIENT"
} as const;

export type CertificationReasonCode = typeof CERTIFICATION_REASON_CODES[keyof typeof CERTIFICATION_REASON_CODES];
export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

export type CertificationEvidence = {
  levels: CertificationLevel[];
  state: EvidenceStatus;
  provenance: string;
};

export type StandaloneExecutorSurface = {
  kind: "standalone_executor";
  executor_id: string;
  route_id: string;
  transport: "direct_loopback";
};

const SAFE_READ_STANDALONE_BINDING = Object.freeze({
  method: "POST",
  path: "/revit/certified/sheets/count",
  alias: "revit_count_sheets_certified",
  executor_id: "revit-operator.safe-read-host.v1",
  route_id: "safe_read.sheet_count.v1",
  transport: "direct_loopback" as const
});

export type ToolCertificationRecord = {
  method: string;
  path: string;
  typed_mcp_aliases: string[];
  request: JsonValue;
  effect: JsonValue;
  requested_channels: ExposureChannel[];
  visibility: ToolVisibility;
  evidence: CertificationEvidence;
  execution_surface?: StandaloneExecutorSurface;
  request_hash: string;
  effect_hash: string;
  record_hash: string;
};

export type TypedMcpRequestFixture = {
  alias: string;
  arguments: JsonValue;
  request: JsonValue;
};

export type ToolCertificationCandidate = Pick<
  ToolCertificationRecord,
  "method" | "path" | "typed_mcp_aliases" | "request_hash" | "effect_hash"
> & {
  request: JsonValue;
  typed_mcp_request_fixtures: TypedMcpRequestFixture[];
  execution_surface?: StandaloneExecutorSurface;
};

export type ToolCertificationCandidatesFile = {
  schema: "revit-operator.tool-certification-candidates.v1";
  hash_algorithm: "sha256";
  candidates: ToolCertificationCandidate[];
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
  typed_mcp_aliases: string[];
  request_hash: string;
  effect_hash: string;
  evidence_record_hash: string;
  highest_cumulative_level: CertificationLevel | null;
  observed_levels: CertificationLevel[];
  visibility: ToolVisibility;
  execution_surface?: StandaloneExecutorSurface;
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

function ordinalCompare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function assertPlainObject(value: unknown, location: string): asserts value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${location} must be an object`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new Error(`${location} must be a plain object`);
  }
}

function assertExactKeys(value: Record<string, unknown>, expected: readonly string[], location: string): void {
  const expectedSet = new Set(expected);
  for (const key of Object.keys(value)) {
    if (!expectedSet.has(key)) throw new Error(`${location} contains unknown field: ${key}`);
  }
  for (const key of expected) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) throw new Error(`${location} is missing field: ${key}`);
  }
}

function assertString(value: unknown, location: string): asserts value is string {
  if (typeof value !== "string" || value.length === 0) throw new Error(`${location} must be a nonempty string`);
}

function assertArray(value: unknown, location: string): asserts value is unknown[] {
  if (!Array.isArray(value)) throw new Error(`${location} must be an array`);
}

function assertEnum<T extends string>(
  value: unknown,
  allowed: readonly T[],
  location: string
): asserts value is T {
  if (typeof value !== "string" || !(allowed as readonly string[]).includes(value)) {
    throw new Error(`${location} has unsupported value: ${String(value)}`);
  }
}

function assertSha256(value: unknown, location: string): asserts value is string {
  if (typeof value !== "string" || !/^sha256:[0-9a-f]{64}$/.test(value)) {
    throw new Error(`${location} must be a lowercase sha256 digest`);
  }
}

function assertTypedMcpAliases(value: unknown, location: string): asserts value is string[] {
  assertArray(value, location);
  let previous = "";
  const seen = new Set<string>();
  value.forEach((item, index) => {
    assertString(item, `${location}[${index}]`);
    if (!/^[a-z][a-z0-9_]*$/.test(item)) {
      throw new Error(`${location}[${index}] must be a canonical typed MCP tool name`);
    }
    if (item === GENERIC_MCP_TOOL) {
      throw new Error(`${location}[${index}] must not contain the generic MCP dispatcher`);
    }
    if (seen.has(item)) throw new Error(`${location} contains duplicate alias: ${item}`);
    if (previous && ordinalCompare(previous, item) >= 0) {
      throw new Error(`${location} must use unique ordinal-sorted aliases`);
    }
    seen.add(item);
    previous = item;
  });
}

function assertRepositorySource(value: unknown, location: string): asserts value is string {
  assertString(value, location);
  if (
    value !== normalizeString(value)
    || value.includes("\\")
    || value.startsWith("/")
    || /^[A-Za-z]:/.test(value)
    || value.split("/").some(part => part === "" || part === "." || part === "..")
    || !/^config\/[A-Za-z0-9._/-]+\.json$/.test(value)
  ) {
    throw new Error(`${location} must be a canonical repository-relative config JSON path`);
  }
}

function parseStandaloneExecutorSurface(value: unknown, location: string): StandaloneExecutorSurface {
  assertPlainObject(value, location);
  assertExactKeys(value, ["kind", "executor_id", "route_id", "transport"], location);
  assertEnum(value.kind, ["standalone_executor"] as const, `${location}.kind`);
  assertString(value.executor_id, `${location}.executor_id`);
  assertString(value.route_id, `${location}.route_id`);
  assertEnum(value.transport, ["direct_loopback"] as const, `${location}.transport`);
  if (!/^[a-z0-9][a-z0-9._-]*$/.test(value.executor_id)) {
    throw new Error(`${location}.executor_id must be a canonical executor identifier`);
  }
  if (!/^[a-z0-9][a-z0-9._-]*$/.test(value.route_id)) {
    throw new Error(`${location}.route_id must be a canonical executor route identifier`);
  }
  return value as unknown as StandaloneExecutorSurface;
}

function assertStandaloneExecutorBinding(
  value: Record<string, unknown>,
  aliases: string[],
  hasExecutionSurface: boolean,
  location: string
): void {
  const referencesSafeRead = value.path === SAFE_READ_STANDALONE_BINDING.path
    || aliases.includes(SAFE_READ_STANDALONE_BINDING.alias);
  if (referencesSafeRead !== hasExecutionSurface) {
    throw new Error(`${location} SafeRead path and alias require the exact standalone execution_surface`);
  }
  if (!hasExecutionSurface) return;
  const surface = parseStandaloneExecutorSurface(value.execution_surface, `${location}.execution_surface`);
  if (value.method !== SAFE_READ_STANDALONE_BINDING.method
    || value.path !== SAFE_READ_STANDALONE_BINDING.path
    || aliases.length !== 1
    || aliases[0] !== SAFE_READ_STANDALONE_BINDING.alias
    || surface.executor_id !== SAFE_READ_STANDALONE_BINDING.executor_id
    || surface.route_id !== SAFE_READ_STANDALONE_BINDING.route_id
    || surface.transport !== SAFE_READ_STANDALONE_BINDING.transport) {
    throw new Error(`${location}.execution_surface is not the reviewed SafeRead standalone binding`);
  }
}

function normalizedObjectEntries(
  value: Record<string, unknown>,
  location: string
): Array<[string, unknown]> {
  const normalized = new Map<string, { original: string; value: unknown }>();
  for (const [key, item] of Object.entries(value)) {
    const normalizedKey = normalizeString(key);
    const prior = normalized.get(normalizedKey);
    if (prior) {
      throw new Error(
        `${location} contains NFC-normalized key collision: ${JSON.stringify(prior.original)} and ${JSON.stringify(key)}`
      );
    }
    normalized.set(normalizedKey, { original: key, value: item });
  }
  return [...normalized.entries()]
    .sort(([left], [right]) => ordinalCompare(left, right))
    .map(([key, item]) => [key, item.value]);
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
    assertPlainObject(value, location);
    for (const [key, item] of normalizedObjectEntries(value, location)) {
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
    return Object.fromEntries(normalizedObjectEntries(value, "value").map(([key, item]) => [
      key,
      canonicalValue(item as JsonValue)
    ]));
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
  if (!(HTTP_METHODS as readonly string[]).includes(normalized)) throw new Error(`Invalid HTTP method: ${method}`);
  return normalized;
}

export function normalizeToolPath(toolPath: string): string {
  const normalized = toolPath.trim().replace(/\\/g, "/").replace(/\/{2,}/g, "/");
  if (
    !/^\/revit\/[A-Za-z0-9][A-Za-z0-9._~/-]*$/.test(normalized)
    || normalized.endsWith("/")
    || normalized.split("/").some(part => part === "." || part === "..")
  ) {
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

function assertCanonicalMethod(value: unknown, location: string): asserts value is string {
  assertString(value, location);
  const normalized = normalizeMethod(value);
  if (normalized !== value) throw new Error(`${location} must use canonical HTTP method spelling`);
}

function assertCanonicalToolPath(value: unknown, location: string): asserts value is string {
  assertString(value, location);
  const normalized = normalizeToolPath(value);
  if (normalized !== value) throw new Error(`${location} must use a canonical exact Revit tool path`);
}

function assertUniqueEnumArray<T extends string>(
  value: unknown,
  allowed: readonly T[],
  location: string,
  requireCanonicalOrder = false
): asserts value is T[] {
  assertArray(value, location);
  const seen = new Set<T>();
  let previousIndex = -1;
  value.forEach((item, index) => {
    assertEnum(item, allowed, `${location}[${index}]`);
    if (seen.has(item)) throw new Error(`${location} contains duplicate value: ${item}`);
    const currentIndex = allowed.indexOf(item);
    if (requireCanonicalOrder && currentIndex <= previousIndex) {
      throw new Error(`${location} must follow canonical order`);
    }
    previousIndex = currentIndex;
    seen.add(item);
  });
}

function parseCertificationRecord(
  value: unknown,
  source: string,
  location: string
): ToolCertificationRecord {
  assertPlainObject(value, location);
  const hasExecutionSurface = Object.prototype.hasOwnProperty.call(value, "execution_surface");
  assertExactKeys(value, [
    "method",
    "path",
    "typed_mcp_aliases",
    "request",
    "effect",
    "requested_channels",
    "visibility",
    "evidence",
    ...(hasExecutionSurface ? ["execution_surface"] : []),
    "request_hash",
    "effect_hash",
    "record_hash"
  ], location);
  assertCanonicalMethod(value.method, `${location}.method`);
  assertCanonicalToolPath(value.path, `${location}.path`);
  assertTypedMcpAliases(value.typed_mcp_aliases, `${location}.typed_mcp_aliases`);
  assertStandaloneExecutorBinding(value, value.typed_mcp_aliases, hasExecutionSurface, location);
  assertJsonValue(value.request, `${location}.request`);
  assertJsonValue(value.effect, `${location}.effect`);
  assertUniqueEnumArray(value.requested_channels, EXPOSURE_CHANNELS, `${location}.requested_channels`);
  assertEnum(value.visibility, TOOL_VISIBILITIES, `${location}.visibility`);
  assertPlainObject(value.evidence, `${location}.evidence`);
  assertExactKeys(value.evidence, ["levels", "state", "provenance"], `${location}.evidence`);
  assertUniqueEnumArray(value.evidence.levels, CERTIFICATION_LEVELS, `${location}.evidence.levels`, true);
  assertEnum(value.evidence.state, EVIDENCE_STATUSES, `${location}.evidence.state`);
  assertRepositorySource(value.evidence.provenance, `${location}.evidence.provenance`);
  if (value.evidence.provenance !== source) {
    throw new Error(`${location}.evidence.provenance must match evidence file provenance.source`);
  }
  if (hasExecutionSurface) {
    if (value.visibility !== "candidate") {
      throw new Error(`${location}.execution_surface requires candidate visibility`);
    }
    if (canonicalJson(value.requested_channels) !== canonicalJson(["typed_mcp"])) {
      throw new Error(`${location}.execution_surface may request only the typed_mcp channel`);
    }
  }
  assertSha256(value.request_hash, `${location}.request_hash`);
  assertSha256(value.effect_hash, `${location}.effect_hash`);
  assertSha256(value.record_hash, `${location}.record_hash`);
  return value as unknown as ToolCertificationRecord;
}

export function parseToolCertificationEvidence(value: unknown): ToolCertificationEvidenceFile {
  assertPlainObject(value, "evidence");
  assertExactKeys(value, ["schema", "hash_algorithm", "provenance", "records"], "evidence");
  assertEnum(value.schema, ["revit-operator.tool-certification-evidence.v1"] as const, "evidence.schema");
  assertEnum(value.hash_algorithm, ["sha256"] as const, "evidence.hash_algorithm");
  assertPlainObject(value.provenance, "evidence.provenance");
  assertExactKeys(value.provenance, ["source", "source_hash"], "evidence.provenance");
  assertRepositorySource(value.provenance.source, "evidence.provenance.source");
  assertSha256(value.provenance.source_hash, "evidence.provenance.source_hash");
  const provenance = {
    source: value.provenance.source,
    source_hash: value.provenance.source_hash
  };
  assertArray(value.records, "evidence.records");
  if (value.records.length === 0) throw new Error("evidence.records must not be empty");
  const records = value.records.map((record, index) =>
    parseCertificationRecord(record, provenance.source, `evidence.records[${index}]`)
  );
  return {
    schema: value.schema,
    hash_algorithm: value.hash_algorithm,
    provenance,
    records
  };
}

export function parseToolCertificationCandidates(value: unknown): ToolCertificationCandidatesFile {
  assertPlainObject(value, "candidates");
  assertExactKeys(value, ["schema", "hash_algorithm", "candidates"], "candidates");
  assertEnum(value.schema, ["revit-operator.tool-certification-candidates.v1"] as const, "candidates.schema");
  assertEnum(value.hash_algorithm, ["sha256"] as const, "candidates.hash_algorithm");
  assertArray(value.candidates, "candidates.candidates");
  if (value.candidates.length === 0) throw new Error("candidates.candidates must not be empty");
  const identities = new Set<string>();
  const candidates = value.candidates.map((candidate, index) => {
    const location = `candidates.candidates[${index}]`;
    assertPlainObject(candidate, location);
    const hasExecutionSurface = Object.prototype.hasOwnProperty.call(candidate, "execution_surface");
    assertExactKeys(candidate, [
      "method",
      "path",
      "typed_mcp_aliases",
      "request",
      "typed_mcp_request_fixtures",
      ...(hasExecutionSurface ? ["execution_surface"] : []),
      "request_hash",
      "effect_hash"
    ], location);
    assertCanonicalMethod(candidate.method, `${location}.method`);
    assertCanonicalToolPath(candidate.path, `${location}.path`);
    assertTypedMcpAliases(candidate.typed_mcp_aliases, `${location}.typed_mcp_aliases`);
    assertStandaloneExecutorBinding(candidate, candidate.typed_mcp_aliases, hasExecutionSurface, location);
    if (hasExecutionSurface) {
      if (candidate.typed_mcp_aliases.length !== 1) {
        throw new Error(`${location}.execution_surface requires exactly one typed MCP alias`);
      }
    }
    assertJsonValue(candidate.request, `${location}.request`);
    const candidateRequest = candidate.request;
    assertArray(candidate.typed_mcp_request_fixtures, `${location}.typed_mcp_request_fixtures`);
    const fixtureAliases: string[] = [];
    candidate.typed_mcp_request_fixtures.forEach((fixture, fixtureIndex) => {
      const fixtureLocation = `${location}.typed_mcp_request_fixtures[${fixtureIndex}]`;
      assertPlainObject(fixture, fixtureLocation);
      assertExactKeys(fixture, ["alias", "arguments", "request"], fixtureLocation);
      assertTypedMcpAliases([fixture.alias], `${fixtureLocation}.alias`);
      assertJsonValue(fixture.arguments, `${fixtureLocation}.arguments`);
      assertJsonValue(fixture.request, `${fixtureLocation}.request`);
      if (canonicalJson(fixture.request) !== canonicalJson(candidateRequest)) {
        throw new Error(`${fixtureLocation}.request must match the candidate exact outbound request`);
      }
      fixtureAliases.push(fixture.alias as string);
    });
    if (canonicalJson(fixtureAliases) !== canonicalJson(candidate.typed_mcp_aliases)) {
      throw new Error(
        `${location}.typed_mcp_request_fixtures must provide one ordinal fixture for every typed MCP alias`
      );
    }
    assertSha256(candidate.request_hash, `${location}.request_hash`);
    assertSha256(candidate.effect_hash, `${location}.effect_hash`);
    if (candidate.request_hash !== computeRequestHash(candidate.method, candidate.path, candidate.request)) {
      throw new Error(`${location}.request_hash does not match the candidate exact outbound request`);
    }
    const parsed = candidate as unknown as ToolCertificationCandidate;
    const identity = certificationIdentity(parsed);
    if (identities.has(identity)) throw new Error(`Duplicate candidate identity: ${identity}`);
    identities.add(identity);
    return parsed;
  });
  return { schema: value.schema, hash_algorithm: value.hash_algorithm, candidates };
}

function certificationIdentity(
  value: Pick<ToolCertificationRecord, "method" | "path" | "request_hash" | "effect_hash" | "execution_surface">
): string {
  return canonicalJson({
    method: value.method,
    path: value.path,
    request_hash: value.request_hash,
    effect_hash: value.effect_hash,
    ...(value.execution_surface ? { execution_surface: value.execution_surface } : {})
  });
}

function aliasBindingIdentity(
  value: Pick<ToolCertificationRecord, "method" | "path" | "effect_hash" | "typed_mcp_aliases" | "execution_surface">
): string {
  return canonicalJson({
    method: value.method,
    path: value.path,
    effect_hash: value.effect_hash,
    typed_mcp_aliases: value.typed_mcp_aliases,
    ...(value.execution_surface ? { execution_surface: value.execution_surface } : {})
  });
}

export function sha256NormalizedText(value: string): string {
  const normalized = value.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
  return `sha256:${createHash("sha256").update(normalized, "utf8").digest("hex")}`;
}

export function verifyCertificationCandidates(
  evidence: ToolCertificationEvidenceFile,
  candidates: ToolCertificationCandidatesFile,
  candidateSourceHash: string
): void {
  assertSha256(candidateSourceHash, "candidate source hash");
  if (evidence.provenance.source_hash !== candidateSourceHash) {
    throw new Error("Certification candidate source hash does not match evidence provenance");
  }
  const expected = new Set(candidates.candidates.map(certificationIdentity));
  const actual = new Set(evidence.records.map(certificationIdentity));
  if (expected.size !== actual.size) {
    throw new Error(`Certification candidate identity count mismatch: expected ${expected.size}, received ${actual.size}`);
  }
  for (const identity of expected) {
    if (!actual.has(identity)) throw new Error(`Certification candidate identity missing or replaced: ${identity}`);
  }
  for (const identity of actual) {
    if (!expected.has(identity)) throw new Error(`Unexpected certification candidate identity: ${identity}`);
  }
  const candidatesByIdentity = new Map(candidates.candidates.map(candidate => [certificationIdentity(candidate), candidate]));
  for (const record of evidence.records) {
    const candidate = candidatesByIdentity.get(certificationIdentity(record));
    if (!candidate || canonicalJson(candidate.request) !== canonicalJson(record.request)) {
      throw new Error(`Certification evidence request does not match its exact candidate request: ${record.method} ${record.path}`);
    }
  }
  const expectedAliases = new Set(candidates.candidates.map(aliasBindingIdentity));
  const actualAliases = new Set(evidence.records.map(aliasBindingIdentity));
  for (const binding of expectedAliases) {
    if (!actualAliases.has(binding)) throw new Error(`Certification typed MCP alias binding missing or replaced: ${binding}`);
  }
  for (const binding of actualAliases) {
    if (!expectedAliases.has(binding)) throw new Error(`Unexpected certification typed MCP alias binding: ${binding}`);
  }
}

function recordHashPayload(record: Omit<ToolCertificationRecord, "record_hash">): JsonValue {
  return {
    method: normalizeMethod(record.method),
    path: normalizeToolPath(record.path),
    typed_mcp_aliases: [...record.typed_mcp_aliases],
    request: canonicalValue(record.request),
    effect: canonicalValue(record.effect),
    requested_channels: [...record.requested_channels].sort(ordinalCompare),
    visibility: record.visibility,
    ...(record.execution_surface
      ? { execution_surface: canonicalValue(record.execution_surface as unknown as JsonValue) }
      : {}),
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
    typed_mcp_aliases: [...record.typed_mcp_aliases].sort(ordinalCompare),
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

export function generateToolExposurePolicy(input: ToolCertificationEvidenceFile | unknown): ToolExposurePolicy {
  const evidenceFile = parseToolCertificationEvidence(input);

  const identities = new Set<string>();
  const records = evidenceFile.records.map(record => {
    const method = record.method;
    const toolPath = record.path;
    const identity = certificationIdentity(record);
    if (identities.has(identity)) throw new Error(`Duplicate certification identity: ${identity}`);
    identities.add(identity);

    const evidence = evidenceAssessment(record);
    const blocking = [...new Set([...hashAssessment(record), ...evidence.blocking])].sort();
    const base: Omit<ToolExposurePolicyRecord, "policy_record_hash"> = {
      method,
      path: toolPath,
      typed_mcp_aliases: [...record.typed_mcp_aliases],
      request_hash: record.request_hash,
      effect_hash: record.effect_hash,
      evidence_record_hash: record.record_hash,
      highest_cumulative_level: evidence.highest,
      observed_levels: evidence.observed,
      visibility: record.visibility,
      ...(record.execution_surface ? { execution_surface: record.execution_surface } : {}),
      channels: Object.fromEntries(EXPOSURE_CHANNELS.map(channel => [
        channel,
        decision(channel, record, evidence.highest, blocking)
      ])) as Record<ExposureChannel, ChannelDecision>
    };
    return { ...base, policy_record_hash: sha256(policyRecordHashPayload(base)) };
  }).sort((left, right) => {
    const keyOrder = ordinalCompare(
      `${left.method} ${left.path} ${left.request_hash}`,
      `${right.method} ${right.path} ${right.request_hash}`
    );
    return keyOrder || ordinalCompare(left.effect_hash, right.effect_hash);
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

export type TypedMcpAliasDecision = {
  alias: string;
  exposed: boolean;
  method: string | null;
  path: string | null;
  effect_hash: string | null;
  reason_codes: CertificationReasonCode[];
  bindings: Array<{
    method: string;
    path: string;
    effect_hash: string;
    exposed: boolean;
    reason_codes: CertificationReasonCode[];
  }>;
};

export function decideTypedMcpAlias(policy: ToolExposurePolicy, alias: string): TypedMcpAliasDecision {
  const normalized = normalizeString(alias).trim();
  if (!normalized || normalized === GENERIC_MCP_TOOL) {
    return {
      alias: normalized,
      exposed: false,
      method: null,
      path: null,
      effect_hash: null,
      reason_codes: [CERTIFICATION_REASON_CODES.typedMcpAliasUnknown],
      bindings: []
    };
  }
  const matches = policy.records.filter(record => record.typed_mcp_aliases.includes(normalized));
  if (matches.length === 0) {
    return {
      alias: normalized,
      exposed: false,
      method: null,
      path: null,
      effect_hash: null,
      reason_codes: [CERTIFICATION_REASON_CODES.typedMcpAliasUnknown],
      bindings: []
    };
  }
  const bindings = matches.map(record => ({
    method: record.method,
    path: record.path,
    effect_hash: record.effect_hash,
    exposed: record.channels.typed_mcp.exposed,
    reason_codes: [...record.channels.typed_mcp.reason_codes]
  }));
  const single = matches.length === 1 ? matches[0]! : null;
  return {
    alias: normalized,
    exposed: bindings.every(binding => binding.exposed),
    method: single?.method ?? null,
    path: single?.path ?? null,
    effect_hash: single?.effect_hash ?? null,
    reason_codes: [...new Set(bindings.flatMap(binding => binding.reason_codes))].sort(),
    bindings
  };
}
