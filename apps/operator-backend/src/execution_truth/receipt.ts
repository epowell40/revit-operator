import { canonicalJson, sha256, type JsonValue } from "../capabilities/tool_certification.js";

export const EXECUTION_TRUTH_RECEIPT_SCHEMA = "revit-operator.execution-truth-receipt.v1" as const;
export const EXECUTION_TRUTH_RECEIPT_VERSION = 1 as const;
export const EXECUTION_TRUTH_CANONICALIZATION = "revit-operator.canonical-json.nfc.v1" as const;
export const EXECUTION_TRUTH_RECEIPT_MAX_BYTES = 131_072;

const MAX_IDENTIFIER_CHARS = 128;
const MAX_TITLE_CHARS = 256;
const MAX_PATH_CHARS = 1_024;
const MAX_CODE_CHARS = 96;
const MAX_PHASE_CHARS = 96;
const MAX_HASHES = 32;
const MAX_TRANSACTIONS = 64;
const MAX_EVIDENCE_REFS = 64;
const MAX_VERIFIER_REFS = 32;
const MAX_CHANGE_COUNT = 1_000_000_000;

export const EXECUTION_TRUTH_FENCE_KINDS = [
  "batch_claim",
  "courier_claim",
  "direct_request",
  "none"
] as const;
export type ExecutionTruthFenceKind = typeof EXECUTION_TRUTH_FENCE_KINDS[number];

export const EXECUTION_TRUTH_OUTCOME_STATUSES = ["succeeded", "failed", "unknown"] as const;
export type ExecutionTruthOutcomeStatus = typeof EXECUTION_TRUTH_OUTCOME_STATUSES[number];

export const EXECUTION_TRUTH_EFFECTS = [
  "read_only",
  "not_started",
  "no_change",
  "committed",
  "rolled_back",
  "partial",
  "unknown"
] as const;
export type ExecutionTruthEffect = typeof EXECUTION_TRUTH_EFFECTS[number];

export const EXECUTION_TRUTH_TRANSACTION_IMPACT_STATES = [
  "committed",
  "rolledBack",
  "notCommittedOrUnknown"
] as const;
export type ExecutionTruthTransactionImpactState = typeof EXECUTION_TRUTH_TRANSACTION_IMPACT_STATES[number];

export const EXECUTION_TRUTH_CHANGE_COVERAGES = [
  "not_applicable",
  "complete",
  "partial",
  "unavailable"
] as const;
export type ExecutionTruthChangeCoverage = typeof EXECUTION_TRUTH_CHANGE_COVERAGES[number];

export const EXECUTION_TRUTH_ARTIFACT_KINDS = [
  "result",
  "transaction_receipt",
  "change_manifest",
  "evidence",
  "verifier_receipt"
] as const;
export type ExecutionTruthArtifactKind = typeof EXECUTION_TRUTH_ARTIFACT_KINDS[number];

export const EXECUTION_TRUTH_VERIFIER_STATUSES = ["passed", "failed", "inconclusive"] as const;
export type ExecutionTruthVerifierStatus = typeof EXECUTION_TRUTH_VERIFIER_STATUSES[number];

export type ExecutionTruthArtifactRef = {
  kind: ExecutionTruthArtifactKind;
  workspace_relative_path: string;
  sha256: string;
  media_type: string;
};

export type ExecutionTruthVerifierRef = {
  verifier_id: string;
  verifier_version: string;
  status: ExecutionTruthVerifierStatus;
  receipt_ref: ExecutionTruthArtifactRef;
};

export type ExecutionTruthTransaction = {
  transaction_id: string;
  undo_label?: string;
  impact_state: ExecutionTruthTransactionImpactState;
  receipt_ref?: ExecutionTruthArtifactRef;
};

export type ExecutionTruthReceiptPayload = {
  schema: typeof EXECUTION_TRUTH_RECEIPT_SCHEMA;
  version: typeof EXECUTION_TRUTH_RECEIPT_VERSION;
  canonicalization: typeof EXECUTION_TRUTH_CANONICALIZATION;
  observed_at_utc: string;
  execution: {
    execution_id: string;
    attempt: number;
    executor_id: string;
    session_id?: string;
    job_id?: string;
    item_id?: string;
    task_id?: string;
    action_id?: string;
    correlation_id?: string;
  };
  request: {
    request_hash: string;
    method?: string;
    path?: string;
    effect_hashes?: string[];
    policy_hashes?: string[];
    authorization_hashes?: string[];
  };
  document: {
    project_fingerprint: string;
    document_session_id?: string;
    title?: string;
    path?: string;
    state_before_sha256?: string;
    state_after_sha256?: string;
  };
  fence: {
    kind: ExecutionTruthFenceKind;
    token_sha256?: string;
  };
  outcome: {
    status: ExecutionTruthOutcomeStatus;
    effect: ExecutionTruthEffect;
    code?: string;
    phase?: string;
    retryable: boolean;
    reconciliation_required: boolean;
  };
  transactions: ExecutionTruthTransaction[];
  changes: {
    coverage: ExecutionTruthChangeCoverage;
    manifest_ref?: ExecutionTruthArtifactRef;
    created_count?: number;
    modified_count?: number;
    deleted_count?: number;
    truncated?: boolean;
    omitted_count?: number;
  };
  evidence_refs: ExecutionTruthArtifactRef[];
  verifier_refs: ExecutionTruthVerifierRef[];
  result_sha256: string;
};

export type ExecutionTruthReceipt = ExecutionTruthReceiptPayload & {
  receipt_sha256: string;
};

function fail(location: string, message: string): never {
  throw new Error(`${location} ${message}`);
}

function assertPlainObject(value: unknown, location: string): asserts value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) fail(location, "must be an object");
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) fail(location, "must be a plain object");
}

function assertExactKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[],
  location: string
): void {
  const allowed = new Set([...required, ...optional]);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) fail(location, `contains unknown field: ${key}`);
  }
  for (const key of required) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) fail(location, `is missing field: ${key}`);
  }
}

function assertCanonicalString(value: unknown, location: string, maxChars: number): asserts value is string {
  if (typeof value !== "string" || value.length === 0 || value.length > maxChars) {
    fail(location, `must be a nonempty string no longer than ${maxChars} characters`);
  }
  if (value !== value.normalize("NFC") || /[\u0000-\u001f\u007f]/.test(value)) {
    fail(location, "must be NFC text without control characters");
  }
}

function assertNotObviousSecret(value: string, location: string): void {
  const basicMatch = /\bbasic\s+([A-Za-z0-9+/]{8,}={0,2})(?:\s|$)/i.exec(value);
  let decodedBasicCredential = false;
  if (basicMatch?.[1]) {
    try {
      decodedBasicCredential = /^[^:\r\n]{1,256}:[^\r\n]{1,256}$/.test(Buffer.from(basicMatch[1], "base64").toString("utf8"));
    } catch {
      decodedBasicCredential = false;
    }
  }
  if (
    /\bauthorization\s*[:=]\s*[^\s]{8,}/i.test(value)
    || /\bbearer\s+[A-Za-z0-9._~+\/-]{12,}=*/i.test(value)
    || decodedBasicCredential
    || /\bsk-[A-Za-z0-9_-]{16,}\b/.test(value)
    || /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/.test(value)
    || /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/.test(value)
    || /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/.test(value)
  ) {
    fail(location, "must not contain a raw credential or bearer token");
  }
}

function assertIdentifier(value: unknown, location: string): asserts value is string {
  assertCanonicalString(value, location, MAX_IDENTIFIER_CHARS);
  assertNotObviousSecret(value, location);
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(value)) {
    fail(location, "must be a canonical identifier");
  }
}

function assertLabel(value: unknown, location: string, maxChars = MAX_TITLE_CHARS): asserts value is string {
  assertCanonicalString(value, location, maxChars);
  assertNotObviousSecret(value, location);
}

function assertEnum<T extends string>(
  value: unknown,
  allowed: readonly T[],
  location: string
): asserts value is T {
  if (typeof value !== "string" || !(allowed as readonly string[]).includes(value)) {
    fail(location, `has unsupported value: ${String(value)}`);
  }
}

function assertSha256(value: unknown, location: string): asserts value is string {
  if (typeof value !== "string" || !/^sha256:[0-9a-f]{64}$/.test(value)) {
    fail(location, "must be a lowercase sha256 digest");
  }
}

function assertSafeInteger(value: unknown, location: string, min: number, max: number): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < min || (value as number) > max) {
    fail(location, `must be a safe integer from ${min} through ${max}`);
  }
}

function assertCanonicalUtc(value: unknown, location: string): asserts value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) {
    fail(location, "must be a canonical UTC timestamp with milliseconds");
  }
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== value) {
    fail(location, "must be a valid canonical UTC timestamp");
  }
}

function assertWorkspaceRelativePath(value: unknown, location: string): asserts value is string {
  assertCanonicalString(value, location, MAX_PATH_CHARS);
  assertNotObviousSecret(value, location);
  if (
    value.includes("\\")
    || value.startsWith("/")
    || value.startsWith("~")
    || /^[A-Za-z]:/.test(value)
    || value.includes(":")
    || value.split("/").some(part => part === "" || part === "." || part === "..")
    || !/^[A-Za-z0-9._/-]+$/.test(value)
  ) {
    fail(location, "must be a canonical workspace-relative path without traversal");
  }
}

function assertRequestPath(value: unknown, location: string): asserts value is string {
  assertCanonicalString(value, location, 512);
  if (
    !/^\/[A-Za-z0-9][A-Za-z0-9._~/-]*$/.test(value)
    || value.endsWith("/")
    || value.includes("//")
    || value.split("/").some(part => part === "." || part === "..")
  ) {
    fail(location, "must be a canonical absolute HTTP path without query, fragment, or traversal");
  }
}

function assertMediaType(value: unknown, location: string): asserts value is string {
  assertCanonicalString(value, location, 128);
  if (!/^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/.test(value)) {
    fail(location, "must be a lowercase media type without parameters");
  }
}

function assertSortedUniqueHashes(value: unknown, location: string): asserts value is string[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_HASHES) {
    fail(location, `must contain from 1 through ${MAX_HASHES} hashes`);
  }
  let previous = "";
  value.forEach((item, index) => {
    assertSha256(item, `${location}[${index}]`);
    if (previous && item <= previous) fail(location, "must contain unique ordinal-sorted hashes");
    previous = item;
  });
}

function parseArtifactRef(value: unknown, location: string): ExecutionTruthArtifactRef {
  assertPlainObject(value, location);
  assertExactKeys(value, ["kind", "workspace_relative_path", "sha256", "media_type"], [], location);
  assertEnum(value.kind, EXECUTION_TRUTH_ARTIFACT_KINDS, `${location}.kind`);
  assertWorkspaceRelativePath(value.workspace_relative_path, `${location}.workspace_relative_path`);
  assertSha256(value.sha256, `${location}.sha256`);
  assertMediaType(value.media_type, `${location}.media_type`);
  return value as unknown as ExecutionTruthArtifactRef;
}

function artifactSortKey(value: ExecutionTruthArtifactRef): string {
  return `${value.kind}\u0000${value.workspace_relative_path}\u0000${value.sha256}`;
}

function assertArtifactRefs(value: unknown, location: string): asserts value is ExecutionTruthArtifactRef[] {
  if (!Array.isArray(value) || value.length > MAX_EVIDENCE_REFS) {
    fail(location, `must be an array with at most ${MAX_EVIDENCE_REFS} entries`);
  }
  let previous = "";
  value.forEach((item, index) => {
    const ref = parseArtifactRef(item, `${location}[${index}]`);
    if (ref.kind === "verifier_receipt") {
      fail(`${location}[${index}].kind`, "must be carried by verifier_refs, not evidence_refs");
    }
    const key = artifactSortKey(ref);
    if (previous && key <= previous) fail(location, "must contain unique ordinal-sorted artifact references");
    previous = key;
  });
}

function parseExecution(value: unknown): void {
  const location = "receipt.execution";
  assertPlainObject(value, location);
  assertExactKeys(
    value,
    ["execution_id", "attempt", "executor_id"],
    ["session_id", "job_id", "item_id", "task_id", "action_id", "correlation_id"],
    location
  );
  assertIdentifier(value.execution_id, `${location}.execution_id`);
  assertSafeInteger(value.attempt, `${location}.attempt`, 1, 1_000_000);
  assertIdentifier(value.executor_id, `${location}.executor_id`);
  for (const key of ["session_id", "job_id", "item_id", "task_id", "action_id", "correlation_id"] as const) {
    if (value[key] !== undefined) assertIdentifier(value[key], `${location}.${key}`);
  }
}

function parseRequest(value: unknown): void {
  const location = "receipt.request";
  assertPlainObject(value, location);
  assertExactKeys(
    value,
    ["request_hash"],
    ["method", "path", "effect_hashes", "policy_hashes", "authorization_hashes"],
    location
  );
  assertSha256(value.request_hash, `${location}.request_hash`);
  const hasMethod = value.method !== undefined;
  const hasPath = value.path !== undefined;
  if (hasMethod !== hasPath) fail(location, "must provide method and path together");
  if (hasMethod) {
    assertEnum(value.method, ["GET", "POST", "PUT", "PATCH", "DELETE"] as const, `${location}.method`);
    assertRequestPath(value.path, `${location}.path`);
  }
  for (const key of ["effect_hashes", "policy_hashes", "authorization_hashes"] as const) {
    if (value[key] !== undefined) assertSortedUniqueHashes(value[key], `${location}.${key}`);
  }
}

function parseDocument(value: unknown): void {
  const location = "receipt.document";
  assertPlainObject(value, location);
  assertExactKeys(
    value,
    ["project_fingerprint"],
    ["document_session_id", "title", "path", "state_before_sha256", "state_after_sha256"],
    location
  );
  assertSha256(value.project_fingerprint, `${location}.project_fingerprint`);
  if (value.document_session_id !== undefined) {
    assertIdentifier(value.document_session_id, `${location}.document_session_id`);
  }
  if (value.title !== undefined) assertLabel(value.title, `${location}.title`);
  if (value.path !== undefined) assertWorkspaceRelativePath(value.path, `${location}.path`);
  if (value.state_before_sha256 !== undefined) assertSha256(value.state_before_sha256, `${location}.state_before_sha256`);
  if (value.state_after_sha256 !== undefined) assertSha256(value.state_after_sha256, `${location}.state_after_sha256`);
}

function parseFence(value: unknown): void {
  const location = "receipt.fence";
  assertPlainObject(value, location);
  assertExactKeys(value, ["kind"], ["token_sha256"], location);
  assertEnum(value.kind, EXECUTION_TRUTH_FENCE_KINDS, `${location}.kind`);
  if (value.token_sha256 !== undefined) assertSha256(value.token_sha256, `${location}.token_sha256`);
  if (value.kind === "none" && value.token_sha256 !== undefined) {
    fail(location, "must not carry token_sha256 when kind is none");
  }
}

function parseOutcome(value: unknown): ExecutionTruthReceiptPayload["outcome"] {
  const location = "receipt.outcome";
  assertPlainObject(value, location);
  assertExactKeys(value, ["status", "effect", "retryable", "reconciliation_required"], ["code", "phase"], location);
  assertEnum(value.status, EXECUTION_TRUTH_OUTCOME_STATUSES, `${location}.status`);
  assertEnum(value.effect, EXECUTION_TRUTH_EFFECTS, `${location}.effect`);
  if (value.code !== undefined) {
    assertCanonicalString(value.code, `${location}.code`, MAX_CODE_CHARS);
    if (!/^[A-Z][A-Z0-9_]*$/.test(value.code)) fail(`${location}.code`, "must be an uppercase reason code");
  }
  if (value.phase !== undefined) {
    assertCanonicalString(value.phase, `${location}.phase`, MAX_PHASE_CHARS);
    if (!/^[a-z][a-z0-9_]*$/.test(value.phase)) fail(`${location}.phase`, "must be a lowercase phase identifier");
  }
  if (typeof value.retryable !== "boolean") fail(`${location}.retryable`, "must be a boolean");
  if (typeof value.reconciliation_required !== "boolean") fail(`${location}.reconciliation_required`, "must be a boolean");

  const allowedByStatus: Record<ExecutionTruthOutcomeStatus, readonly ExecutionTruthEffect[]> = {
    succeeded: ["read_only", "no_change", "committed"],
    failed: ["not_started", "no_change", "rolled_back", "partial"],
    unknown: ["unknown"]
  };
  if (!allowedByStatus[value.status].includes(value.effect)) {
    fail(location, `status ${value.status} is incompatible with effect ${value.effect}`);
  }
  if (value.status === "unknown" || value.effect === "unknown") {
    if (value.effect !== "unknown" || value.reconciliation_required !== true || value.retryable !== false) {
      fail(location, "unknown outcomes require effect unknown, reconciliation_required true, and retryable false");
    }
  }
  if (value.status === "succeeded" && value.retryable) fail(location, "succeeded outcomes cannot be retryable");
  if (value.effect === "committed" && value.retryable) fail(location, "committed effects cannot be retryable");
  if (value.effect === "partial" && (value.retryable || !value.reconciliation_required)) {
    fail(location, "partial effects require reconciliation_required true and retryable false");
  }
  return value as unknown as ExecutionTruthReceiptPayload["outcome"];
}

function parseTransactions(value: unknown, outcome: ExecutionTruthReceiptPayload["outcome"]): void {
  const location = "receipt.transactions";
  if (!Array.isArray(value) || value.length > MAX_TRANSACTIONS) {
    fail(location, `must be an array with at most ${MAX_TRANSACTIONS} entries`);
  }
  if ((outcome.effect === "read_only" || outcome.effect === "not_started") && value.length !== 0) {
    fail(location, `${outcome.effect} effects cannot claim transactions`);
  }
  const ids = new Set<string>();
  value.forEach((item, index) => {
    const itemLocation = `${location}[${index}]`;
    assertPlainObject(item, itemLocation);
    assertExactKeys(item, ["transaction_id", "impact_state"], ["undo_label", "receipt_ref"], itemLocation);
    assertIdentifier(item.transaction_id, `${itemLocation}.transaction_id`);
    if (ids.has(item.transaction_id)) fail(location, `contains duplicate transaction_id: ${item.transaction_id}`);
    ids.add(item.transaction_id);
    if (item.undo_label !== undefined) assertLabel(item.undo_label, `${itemLocation}.undo_label`);
    assertEnum(item.impact_state, EXECUTION_TRUTH_TRANSACTION_IMPACT_STATES, `${itemLocation}.impact_state`);
    if (item.receipt_ref !== undefined) {
      const ref = parseArtifactRef(item.receipt_ref, `${itemLocation}.receipt_ref`);
      if (ref.kind !== "transaction_receipt") fail(`${itemLocation}.receipt_ref.kind`, "must be transaction_receipt");
    }
    if (outcome.effect === "rolled_back" && item.impact_state !== "rolledBack") {
      fail(`${itemLocation}.impact_state`, "must be rolledBack when the observed effect is rolled_back");
    }
  });
}

function parseChanges(value: unknown, outcome: ExecutionTruthReceiptPayload["outcome"]): void {
  const location = "receipt.changes";
  assertPlainObject(value, location);
  assertExactKeys(
    value,
    ["coverage"],
    ["manifest_ref", "created_count", "modified_count", "deleted_count", "truncated", "omitted_count"],
    location
  );
  assertEnum(value.coverage, EXECUTION_TRUTH_CHANGE_COVERAGES, `${location}.coverage`);
  if (value.manifest_ref !== undefined) {
    const ref = parseArtifactRef(value.manifest_ref, `${location}.manifest_ref`);
    if (ref.kind !== "change_manifest") fail(`${location}.manifest_ref.kind`, "must be change_manifest");
  }
  for (const key of ["created_count", "modified_count", "deleted_count"] as const) {
    if (value[key] !== undefined) assertSafeInteger(value[key], `${location}.${key}`, 0, MAX_CHANGE_COUNT);
  }
  if (value.truncated !== undefined && typeof value.truncated !== "boolean") {
    fail(`${location}.truncated`, "must be a boolean");
  }
  if (value.omitted_count !== undefined) {
    assertSafeInteger(value.omitted_count, `${location}.omitted_count`, 1, MAX_CHANGE_COUNT);
  }

  const detailKeys = ["manifest_ref", "created_count", "modified_count", "deleted_count", "truncated", "omitted_count"];
  if ((value.coverage === "not_applicable" || value.coverage === "unavailable")
    && detailKeys.some(key => value[key] !== undefined)) {
    fail(location, `${value.coverage} coverage cannot claim manifest or count details`);
  }
  if (value.coverage === "complete" && (value.truncated === true || value.omitted_count !== undefined)) {
    fail(location, "complete coverage cannot be truncated or omit changes");
  }
  if (value.truncated === true && value.coverage !== "partial") {
    fail(location, "truncated true requires partial coverage");
  }
  if (value.omitted_count !== undefined && (value.coverage !== "partial" || value.truncated !== true)) {
    fail(location, "omitted_count requires partial coverage with truncated true");
  }
  if (outcome.effect === "read_only" || outcome.effect === "not_started") {
    if (value.coverage !== "not_applicable") fail(location, `${outcome.effect} effects require not_applicable coverage`);
  }
  if (["committed", "partial", "unknown"].includes(outcome.effect) && value.coverage === "not_applicable") {
    fail(location, `${outcome.effect} effects cannot use not_applicable coverage`);
  }
}

function parseVerifierRefs(value: unknown): void {
  const location = "receipt.verifier_refs";
  if (!Array.isArray(value) || value.length > MAX_VERIFIER_REFS) {
    fail(location, `must be an array with at most ${MAX_VERIFIER_REFS} entries`);
  }
  let previous = "";
  value.forEach((item, index) => {
    const itemLocation = `${location}[${index}]`;
    assertPlainObject(item, itemLocation);
    assertExactKeys(item, ["verifier_id", "verifier_version", "status", "receipt_ref"], [], itemLocation);
    assertIdentifier(item.verifier_id, `${itemLocation}.verifier_id`);
    assertIdentifier(item.verifier_version, `${itemLocation}.verifier_version`);
    assertEnum(item.status, EXECUTION_TRUTH_VERIFIER_STATUSES, `${itemLocation}.status`);
    const ref = parseArtifactRef(item.receipt_ref, `${itemLocation}.receipt_ref`);
    if (ref.kind !== "verifier_receipt") fail(`${itemLocation}.receipt_ref.kind`, "must be verifier_receipt");
    const key = `${item.verifier_id}\u0000${item.verifier_version}\u0000${ref.workspace_relative_path}`;
    if (previous && key <= previous) fail(location, "must contain unique ordinal-sorted verifier references");
    previous = key;
  });
}

function validatePayload(value: Record<string, unknown>): asserts value is ExecutionTruthReceiptPayload {
  assertExactKeys(
    value,
    [
      "schema", "version", "canonicalization", "observed_at_utc", "execution", "request", "document", "fence",
      "outcome", "transactions", "changes", "evidence_refs", "verifier_refs", "result_sha256"
    ],
    [],
    "receipt"
  );
  if (value.schema !== EXECUTION_TRUTH_RECEIPT_SCHEMA) fail("receipt.schema", `must be ${EXECUTION_TRUTH_RECEIPT_SCHEMA}`);
  if (value.version !== EXECUTION_TRUTH_RECEIPT_VERSION) fail("receipt.version", `must be ${EXECUTION_TRUTH_RECEIPT_VERSION}`);
  if (value.canonicalization !== EXECUTION_TRUTH_CANONICALIZATION) {
    fail("receipt.canonicalization", `must be ${EXECUTION_TRUTH_CANONICALIZATION}`);
  }
  assertCanonicalUtc(value.observed_at_utc, "receipt.observed_at_utc");
  parseExecution(value.execution);
  parseRequest(value.request);
  parseDocument(value.document);
  parseFence(value.fence);
  const outcome = parseOutcome(value.outcome);
  parseTransactions(value.transactions, outcome);
  parseChanges(value.changes, outcome);
  assertArtifactRefs(value.evidence_refs, "receipt.evidence_refs");
  parseVerifierRefs(value.verifier_refs);
  assertSha256(value.result_sha256, "receipt.result_sha256");
}

function canonicalClone(value: unknown): Record<string, unknown> {
  const json = canonicalJson(value as JsonValue);
  if (Buffer.byteLength(json, "utf8") > EXECUTION_TRUTH_RECEIPT_MAX_BYTES) {
    fail("receipt", `must not exceed ${EXECUTION_TRUTH_RECEIPT_MAX_BYTES} canonical UTF-8 bytes`);
  }
  const clone = JSON.parse(json) as unknown;
  assertPlainObject(clone, "receipt");
  return clone;
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const item of Object.values(value as Record<string, unknown>)) deepFreeze(item);
    Object.freeze(value);
  }
  return value;
}

/**
 * Computes the receipt identity over the complete canonical payload, excluding
 * receipt_sha256 itself. It never invents transaction, undo, state, or evidence data.
 */
export function hashExecutionTruthReceipt(value: ExecutionTruthReceiptPayload | ExecutionTruthReceipt): string {
  const clone = canonicalClone(value);
  const hasReceiptHash = Object.prototype.hasOwnProperty.call(clone, "receipt_sha256");
  if (hasReceiptHash) {
    assertExactKeys(
      clone,
      [
        "schema", "version", "canonicalization", "observed_at_utc", "execution", "request", "document", "fence",
        "outcome", "transactions", "changes", "evidence_refs", "verifier_refs", "result_sha256", "receipt_sha256"
      ],
      [],
      "receipt"
    );
    assertSha256(clone.receipt_sha256, "receipt.receipt_sha256");
    delete clone.receipt_sha256;
  }
  validatePayload(clone);
  return sha256(clone as unknown as JsonValue);
}

/** Creates one immutable post-execution observation and adds only its content hash. */
export function createExecutionTruthReceipt(input: ExecutionTruthReceiptPayload): Readonly<ExecutionTruthReceipt> {
  const payload = canonicalClone(input);
  validatePayload(payload);
  const receipt = canonicalClone({ ...payload, receipt_sha256: sha256(payload as unknown as JsonValue) });
  return parseExecutionTruthReceipt(receipt);
}

/** Strictly parses, hash-verifies, normalizes, and recursively freezes a v1 receipt. */
export function parseExecutionTruthReceipt(value: unknown): Readonly<ExecutionTruthReceipt> {
  const receipt = canonicalClone(value);
  assertExactKeys(
    receipt,
    [
      "schema", "version", "canonicalization", "observed_at_utc", "execution", "request", "document", "fence",
      "outcome", "transactions", "changes", "evidence_refs", "verifier_refs", "result_sha256", "receipt_sha256"
    ],
    [],
    "receipt"
  );
  assertSha256(receipt.receipt_sha256, "receipt.receipt_sha256");
  const declaredHash = receipt.receipt_sha256;
  const payload = { ...receipt };
  delete payload.receipt_sha256;
  validatePayload(payload);
  const expectedHash = sha256(payload as unknown as JsonValue);
  if (declaredHash !== expectedHash) fail("receipt.receipt_sha256", "does not match the canonical receipt payload");
  return deepFreeze(receipt as unknown as ExecutionTruthReceipt);
}
