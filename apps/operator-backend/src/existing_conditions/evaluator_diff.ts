import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type {
  ExistingConditionsEvaluatorExpectedRun,
  ExistingConditionsEvaluatorRunIdentity,
  ExistingConditionsEvaluatorSigningAuthority
} from "./evaluator_visual.js";

type JsonObject = Record<string, unknown>;

export type ExistingConditionsEvaluatorChangeReceipt = {
  schema_version: 2;
  fixture_id: string;
  scope_id: string;
  workflow_fingerprint_sha256: string;
  action_id: string;
  attempt_id: string;
  capture_nonce: string;
  capture_name: string;
  artifact_scope_root: string;
  candidate_snapshot_sha256: string;
  before_visible_sha256: string;
  after_visible_sha256: string;
  agent_package_sha256: string;
  canonical_byte_lengths: {
    candidate_snapshot: number;
    before_visible: number;
    after_visible: number;
    agent_package: number;
  };
  native_diff_readback: true;
  changed_element_keys: string[];
  out_of_scope_changed_element_keys: string[];
  change_digest_sha256: string;
  issued_at: string;
  expires_at: string;
  freshness_rule: "bounded_single_attempt_change_v1";
  replay_key_sha256: string;
  receipt_sha256: string;
  evaluator_authority: {
    boundary: "trusted_hmac_verifier_v1";
    algorithm: "hmac-sha256";
    key_id: string;
    signature: string;
  };
};

export type ExistingConditionsEvaluatorChangeValidationOptions = {
  trusted_key_resolver?: (keyId: string) => string | Buffer | null | undefined;
  expected_run?: ExistingConditionsEvaluatorExpectedRun;
  maximum_clock_skew_ms?: number;
  now_ms?: number;
};

type ExistingConditionsEvaluatorChangeReceiptUnsigned = Omit<ExistingConditionsEvaluatorChangeReceipt, "evaluator_authority"> & {
  evaluator_authority: Omit<ExistingConditionsEvaluatorChangeReceipt["evaluator_authority"], "signature">;
};

const SHA256_PATTERN = /^[a-f0-9]{64}$/i;
const NONCE_PATTERN = /^[A-Za-z0-9_-]{16,128}$/;
const DEFAULT_MAXIMUM_CLOCK_SKEW_MS = 5_000;
const DEFAULT_RECEIPT_MAXIMUM_AGE_MS = 5 * 60_000;
const MAXIMUM_RECEIPT_AGE_MS = 24 * 60 * 60_000;

type Bounds = {
  min: { x: number; y: number; z: number };
  max: { x: number; y: number; z: number };
};

function object(value: unknown): JsonObject {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : {};
}

function number(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === "object") {
    const input = value as JsonObject;
    return Object.fromEntries(Object.keys(input).sort().map((key) => [key, stable(input[key])]));
  }
  return value;
}

function canonicalBytes(value: unknown): Buffer {
  return Buffer.from(JSON.stringify(stable(value)), "utf8");
}

function digest(value: unknown): string {
  return crypto.createHash("sha256").update(canonicalBytes(value)).digest("hex");
}

export function existingConditionsCandidateSnapshotSha256(snapshot: unknown): string {
  return digest(snapshot);
}

function requiredIdentity(value: unknown, field: string): string {
  const normalized = String(value ?? "").trim();
  if (!normalized || normalized.length > 256) throw new Error(`evaluator_diff_${field}_invalid`);
  return normalized;
}

function requiredSha256(value: unknown, field: string): string {
  const normalized = String(value ?? "").trim().toLowerCase();
  if (!SHA256_PATTERN.test(normalized)) throw new Error(`evaluator_diff_${field}_invalid`);
  return normalized;
}

function timestampMs(value: unknown, field: string): number {
  const normalized = String(value ?? "").trim();
  const parsed = Date.parse(normalized);
  if (!normalized || !Number.isFinite(parsed) || new Date(parsed).toISOString() !== normalized) {
    throw new Error(`evaluator_diff_${field}_invalid`);
  }
  return parsed;
}

function signingKeyBytes(value: string | Buffer): Buffer {
  const bytes = Buffer.isBuffer(value) ? Buffer.from(value) : Buffer.from(value, "utf8");
  if (bytes.length < 32) throw new Error("evaluator_diff_signing_key_must_be_at_least_32_bytes");
  return bytes;
}

function signReceipt(payload: ExistingConditionsEvaluatorChangeReceiptUnsigned, key: string | Buffer): string {
  return crypto.createHmac("sha256", signingKeyBytes(key)).update(canonicalBytes(payload)).digest("hex");
}

function timingSafeHexEqual(left: string, right: string): boolean {
  if (!SHA256_PATTERN.test(left) || !SHA256_PATTERN.test(right)) return false;
  const leftBytes = Buffer.from(left.toLowerCase(), "hex");
  const rightBytes = Buffer.from(right.toLowerCase(), "hex");
  return leftBytes.length === rightBytes.length && crypto.timingSafeEqual(leftBytes, rightBytes);
}

function receiptMaximumAgeMs(value: unknown): number {
  const parsed = value === undefined ? DEFAULT_RECEIPT_MAXIMUM_AGE_MS : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0 || parsed > MAXIMUM_RECEIPT_AGE_MS) {
    throw new Error("evaluator_diff_maximum_receipt_age_ms_invalid");
  }
  return parsed;
}

function normalizeArtifactScopeRoot(value: unknown): string {
  const root = fs.realpathSync(path.resolve(requiredIdentity(value, "artifact_scope_root")));
  if (!fs.statSync(root).isDirectory()) throw new Error("evaluator_diff_artifact_scope_root_invalid");
  return root;
}

function runIdentity(value: Omit<ExistingConditionsEvaluatorRunIdentity, "candidate_snapshot_sha256">, candidateSnapshotSha256: string): ExistingConditionsEvaluatorRunIdentity {
  const captureNonce = String(value.capture_nonce ?? "").trim();
  if (!NONCE_PATTERN.test(captureNonce)) throw new Error("evaluator_diff_capture_nonce_invalid");
  return {
    fixture_id: requiredIdentity(value.fixture_id, "fixture_id"),
    scope_id: requiredIdentity(value.scope_id, "scope_id"),
    workflow_fingerprint_sha256: requiredSha256(value.workflow_fingerprint_sha256, "workflow_fingerprint_sha256"),
    action_id: requiredIdentity(value.action_id, "action_id"),
    attempt_id: requiredIdentity(value.attempt_id, "attempt_id"),
    capture_nonce: captureNonce,
    capture_name: requiredIdentity(value.capture_name, "capture_name"),
    artifact_scope_root: normalizeArtifactScopeRoot(value.artifact_scope_root),
    candidate_snapshot_sha256: requiredSha256(candidateSnapshotSha256, "candidate_snapshot_sha256")
  };
}

function unorderedArray(value: unknown): unknown[] | null {
  if (!Array.isArray(value)) return null;
  return [...value].map(stable).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
}

function normalizedElectricalCircuit(value: unknown): unknown {
  const circuit = object(value);
  if (Object.keys(circuit).length === 0) return null;
  // primaryLabel is a presentation convenience selected from labels. Multi-system
  // equipment can enumerate those systems in a different order between reads.
  const { primaryLabel: _primaryLabel, ...deterministicCircuit } = circuit;
  return {
    ...deterministicCircuit,
    ...(Array.isArray(circuit.labels) ? { labels: unorderedArray(circuit.labels) } : {}),
    ...(Array.isArray(circuit.normalizedLabels) ? { normalizedLabels: unorderedArray(circuit.normalizedLabels) } : {}),
    ...(Array.isArray(circuit.systemIds) ? { systemIds: unorderedArray(circuit.systemIds) } : {}),
    ...(Array.isArray(circuit.powerSystemIds) ? { powerSystemIds: unorderedArray(circuit.powerSystemIds) } : {})
  };
}

function normalizedConnectorsSummary(value: unknown): unknown {
  const summary = object(value);
  if (Object.keys(summary).length === 0) return null;
  // The native exporter intentionally bounds sampleConnectors. Connector iteration order
  // is not stable, so two identical models can expose different members of that sample.
  // Compare the complete aggregate fields below instead of treating the sample as evidence.
  const { sampleConnectors: _sampleConnectors, ...deterministicSummary } = summary;
  return {
    ...deterministicSummary,
    ...(Array.isArray(summary.shapes) ? { shapes: unorderedArray(summary.shapes) } : {}),
    ...(Array.isArray(summary.domains) ? { domains: unorderedArray(summary.domains) } : {}),
    ...(Array.isArray(summary.connectedElementScopedIds) ? { connectedElementScopedIds: unorderedArray(summary.connectedElementScopedIds) } : {})
  };
}

function normalizedSystem(value: unknown, fallbackName: unknown): unknown {
  const system = object(value);
  if (Object.keys(system).length === 0) return fallbackName ?? null;
  return {
    ...system,
    ...(Array.isArray(system.candidates) ? { candidates: unorderedArray(system.candidates) } : {}),
    ...(Array.isArray(system.connectedElementScopedIds) ? { connectedElementScopedIds: unorderedArray(system.connectedElementScopedIds) } : {})
  };
}

function normalizedParameters(item: JsonObject): unknown {
  const parameters = object(item.parameters);
  if (Object.keys(parameters).length === 0) return null;
  const category = categoryToken(item);
  if (category !== "ost_ductcurves" && category !== "ost_pipecurves") return parameters;
  // Revit recalculates flow display values across a connected curve network when an
  // in-scope branch is added. Those read-only values are not edits to the surrounding
  // curves. Terminal/fixture design-flow parameters remain fingerprinted normally.
  const { cfm: _cfm, airflow: _airflow, flow: _flow, ...deterministicParameters } = parameters;
  return deterministicParameters;
}

function exportObject(value: unknown): JsonObject {
  const root = object(value);
  return Object.keys(object(root.result)).length > 0 ? object(root.result) : root;
}

function completeItems(value: unknown, label: string): JsonObject[] {
  const exported = exportObject(value);
  if (exported.truncated === true) throw new Error(`${label}_visible_inventory_is_truncated`);
  if (!Array.isArray(exported.items)) throw new Error(`${label}_visible_inventory_has_no_items`);
  const declaredCount = number(exported.count);
  if (declaredCount !== null && declaredCount !== exported.items.length) {
    throw new Error(`${label}_visible_inventory_count_mismatch`);
  }
  return exported.items.map(object);
}

function visibleViewScope(value: unknown): string {
  const exported = exportObject(value);
  if (Array.isArray(exported.viewIds)) {
    const ids = [...new Set(exported.viewIds.map(number).filter((id): id is number => id !== null && Number.isInteger(id) && id > 0))]
      .sort((a, b) => a - b);
    return ids.length > 0 ? `multi:${ids.join(",")}` : "";
  }
  const viewId = number(exported.viewId);
  return viewId !== null && Number.isInteger(viewId) && viewId > 0 ? `single:${viewId}` : "";
}

function elementKey(item: JsonObject): string {
  const candidates = [item.sourceScopedId, item.uniqueId, item.elementId, item.id];
  const selected = candidates.map((value) => String(value ?? "").trim()).find(Boolean);
  if (!selected) throw new Error("visible_inventory_item_has_no_stable_key");
  return selected;
}

function categoryToken(item: JsonObject): string {
  return String(item.builtInCategory ?? item.categoryToken ?? item.category ?? "").trim().toLowerCase();
}

function modelPoint(value: unknown): { x: number; y: number; z: number } | null {
  const candidate = object(value);
  const x = number(candidate.x);
  const y = number(candidate.y);
  const z = number(candidate.z);
  return x === null || y === null || z === null ? null : { x, y, z };
}

function points(item: JsonObject): Array<{ x: number; y: number; z: number }> {
  const geometry = object(item.geometry);
  const bboxModel = object(item.bboxModel);
  const bbox = object(item.bbox);
  return [
    modelPoint(item.point),
    modelPoint(item.center),
    modelPoint(item.bboxCenter),
    modelPoint(object(geometry.point).model),
    modelPoint(object(geometry.start).model),
    modelPoint(object(geometry.end).model),
    modelPoint(bboxModel.min),
    modelPoint(bboxModel.max),
    modelPoint(object(bbox.model).min),
    modelPoint(object(bbox.model).max)
  ].filter((value): value is { x: number; y: number; z: number } => value !== null);
}

function inside(point: { x: number; y: number; z: number }, bounds: Bounds): boolean {
  return point.x >= bounds.min.x && point.x <= bounds.max.x &&
    point.y >= bounds.min.y && point.y <= bounds.max.y &&
    point.z >= bounds.min.z && point.z <= bounds.max.z;
}

function isInScope(item: JsonObject, bounds: Bounds, allowedCategories: Set<string>): boolean {
  if (!allowedCategories.has(categoryToken(item))) return false;
  return points(item).some((point) => inside(point, bounds));
}

function fingerprint(item: JsonObject): string {
  return digest({
    category: item.builtInCategory ?? item.categoryToken ?? item.category ?? null,
    family: item.familyName ?? null,
    type: item.typeName ?? null,
    level: item.levelName ?? null,
    host: item.hostResolvedScopedId ?? item.hostScopedId ?? item.hostId ?? null,
    system: normalizedSystem(item.system, item.systemName),
    electricalCircuit: normalizedElectricalCircuit(item.electricalCircuit),
    point: item.point ?? null,
    bboxModel: item.bboxModel ?? null,
    geometry: item.geometry ?? null,
    orientation: item.orientation ?? null,
    parameters: normalizedParameters(item),
    connectorsSummary: normalizedConnectorsSummary(item.connectorsSummary)
  });
}

function parseScope(agentPackage: unknown): { bounds: Bounds; allowedCategories: Set<string> } {
  const root = object(agentPackage);
  const scope = object(root.scope);
  const rawBounds = object(scope.model_bounds_ft);
  const min = modelPoint(rawBounds.min);
  const max = modelPoint(rawBounds.max);
  if (!min || !max || min.x > max.x || min.y > max.y || min.z > max.z) {
    throw new Error("agent_package_has_invalid_model_bounds");
  }
  if (!Array.isArray(root.allowed_categories) || root.allowed_categories.length === 0) {
    throw new Error("agent_package_has_no_allowed_categories");
  }
  const allowedCategories = new Set(root.allowed_categories.map((value) => String(value).trim().toLowerCase()).filter(Boolean));
  return { bounds: { min, max }, allowedCategories };
}

export function createExistingConditionsEvaluatorChangeReceipt(
  beforeVisible: unknown,
  afterVisible: unknown,
  agentPackage: unknown,
  context?: {
    run: Omit<ExistingConditionsEvaluatorRunIdentity, "candidate_snapshot_sha256">;
    candidate_snapshot: unknown;
    authority: ExistingConditionsEvaluatorSigningAuthority;
    maximum_receipt_age_ms?: number;
  }
): ExistingConditionsEvaluatorChangeReceipt {
  if (!context) throw new Error("evaluator_diff_authenticated_run_context_required");
  const beforeViewScope = visibleViewScope(beforeVisible);
  const afterViewScope = visibleViewScope(afterVisible);
  if (!beforeViewScope || beforeViewScope !== afterViewScope) throw new Error("visible_inventory_view_mismatch");

  const before = completeItems(beforeVisible, "before");
  const after = completeItems(afterVisible, "after");
  const { bounds, allowedCategories } = parseScope(agentPackage);
  const beforeByKey = new Map(before.map((item) => [elementKey(item), item]));
  const afterByKey = new Map(after.map((item) => [elementKey(item), item]));
  const allKeys = [...new Set([...beforeByKey.keys(), ...afterByKey.keys()])].sort();
  const changed: string[] = [];
  const outOfScope: string[] = [];

  for (const key of allKeys) {
    const prior = beforeByKey.get(key);
    const next = afterByKey.get(key);
    if (prior && next && fingerprint(prior) === fingerprint(next)) continue;
    changed.push(key);
    if (!((prior && isInScope(prior, bounds, allowedCategories)) || (next && isInScope(next, bounds, allowedCategories)))) {
      outOfScope.push(key);
    }
  }

  const candidateSnapshotSha256 = existingConditionsCandidateSnapshotSha256(context.candidate_snapshot);
  const identity = runIdentity(context.run, candidateSnapshotSha256);
  const beforeVisibleSha256 = digest(beforeVisible);
  const afterVisibleSha256 = digest(afterVisible);
  const agentPackageSha256 = digest(agentPackage);
  const canonicalByteLengths = {
    candidate_snapshot: canonicalBytes(context.candidate_snapshot).length,
    before_visible: canonicalBytes(beforeVisible).length,
    after_visible: canonicalBytes(afterVisible).length,
    agent_package: canonicalBytes(agentPackage).length
  };
  const changePayload = {
    ...identity,
    native_diff_readback: true as const,
    changed_element_keys: changed,
    out_of_scope_changed_element_keys: outOfScope,
    candidate_snapshot_sha256: candidateSnapshotSha256,
    before_visible_sha256: beforeVisibleSha256,
    after_visible_sha256: afterVisibleSha256,
    agent_package_sha256: agentPackageSha256,
    canonical_byte_lengths: canonicalByteLengths
  };
  const changeDigestSha256 = digest(changePayload);
  const issuedAtMs = Date.now();
  const maximumReceiptAgeMs = receiptMaximumAgeMs(context.maximum_receipt_age_ms);
  const keyId = requiredIdentity(context.authority?.key_id, "authority_key_id");
  const replayKeySha256 = digest({
    ...identity,
    change_digest_sha256: changeDigestSha256,
    freshness_rule: "bounded_single_attempt_change_v1"
  });
  const preReceipt = {
    schema_version: 2 as const,
    ...identity,
    before_visible_sha256: beforeVisibleSha256,
    after_visible_sha256: afterVisibleSha256,
    agent_package_sha256: agentPackageSha256,
    canonical_byte_lengths: canonicalByteLengths,
    native_diff_readback: true as const,
    changed_element_keys: changed,
    out_of_scope_changed_element_keys: outOfScope,
    change_digest_sha256: changeDigestSha256,
    issued_at: new Date(issuedAtMs).toISOString(),
    expires_at: new Date(issuedAtMs + maximumReceiptAgeMs).toISOString(),
    freshness_rule: "bounded_single_attempt_change_v1" as const,
    replay_key_sha256: replayKeySha256
  };
  const receiptSha256 = digest(preReceipt);
  const unsigned: ExistingConditionsEvaluatorChangeReceiptUnsigned = {
    ...preReceipt,
    receipt_sha256: receiptSha256,
    evaluator_authority: {
      boundary: "trusted_hmac_verifier_v1",
      algorithm: "hmac-sha256",
      key_id: keyId
    }
  };
  return {
    ...unsigned,
    evaluator_authority: {
      ...unsigned.evaluator_authority,
      signature: signReceipt(unsigned, context.authority.signing_key)
    }
  };
}

function unsignedReceipt(receipt: ExistingConditionsEvaluatorChangeReceipt): ExistingConditionsEvaluatorChangeReceiptUnsigned {
  return {
    ...receipt,
    evaluator_authority: {
      boundary: receipt.evaluator_authority.boundary,
      algorithm: receipt.evaluator_authority.algorithm,
      key_id: receipt.evaluator_authority.key_id
    }
  };
}

export function validateExistingConditionsEvaluatorChangeReceipt(
  receipt: ExistingConditionsEvaluatorChangeReceipt | null | undefined,
  options: ExistingConditionsEvaluatorChangeValidationOptions = {}
): boolean {
  try {
    if (!receipt || receipt.schema_version !== 2 || receipt.native_diff_readback !== true ||
        receipt.freshness_rule !== "bounded_single_attempt_change_v1" ||
        !NONCE_PATTERN.test(receipt.capture_nonce) ||
        !Array.isArray(receipt.changed_element_keys) || !Array.isArray(receipt.out_of_scope_changed_element_keys)) return false;
    const identity = runIdentity(receipt, requiredSha256(receipt.candidate_snapshot_sha256, "candidate_snapshot_sha256"));
    for (const value of [
      receipt.before_visible_sha256,
      receipt.after_visible_sha256,
      receipt.agent_package_sha256,
      receipt.change_digest_sha256,
      receipt.replay_key_sha256,
      receipt.receipt_sha256
    ]) if (!SHA256_PATTERN.test(value)) return false;
    if (new Set(receipt.changed_element_keys).size !== receipt.changed_element_keys.length ||
        new Set(receipt.out_of_scope_changed_element_keys).size !== receipt.out_of_scope_changed_element_keys.length ||
        receipt.changed_element_keys.some(key => !requiredIdentity(key, "changed_element_key")) ||
        receipt.out_of_scope_changed_element_keys.some(key => !receipt.changed_element_keys.includes(key))) return false;
    const byteLengths = receipt.canonical_byte_lengths;
    if (!byteLengths || Object.values(byteLengths).some(value => !Number.isSafeInteger(value) || value <= 0)) return false;
    const changePayload = {
      ...identity,
      native_diff_readback: true as const,
      changed_element_keys: receipt.changed_element_keys,
      out_of_scope_changed_element_keys: receipt.out_of_scope_changed_element_keys,
      candidate_snapshot_sha256: receipt.candidate_snapshot_sha256,
      before_visible_sha256: receipt.before_visible_sha256,
      after_visible_sha256: receipt.after_visible_sha256,
      agent_package_sha256: receipt.agent_package_sha256,
      canonical_byte_lengths: receipt.canonical_byte_lengths
    };
    if (!timingSafeHexEqual(receipt.change_digest_sha256, digest(changePayload))) return false;
    const expectedReplayKey = digest({
      ...identity,
      change_digest_sha256: receipt.change_digest_sha256,
      freshness_rule: "bounded_single_attempt_change_v1"
    });
    if (!timingSafeHexEqual(receipt.replay_key_sha256, expectedReplayKey)) return false;
    const issuedAtMs = timestampMs(receipt.issued_at, "issued_at");
    const expiresAtMs = timestampMs(receipt.expires_at, "expires_at");
    const maximumClockSkewMs = Number.isFinite(options.maximum_clock_skew_ms)
      ? Math.max(0, Number(options.maximum_clock_skew_ms))
      : DEFAULT_MAXIMUM_CLOCK_SKEW_MS;
    const nowMs = Number.isFinite(options.now_ms) ? Number(options.now_ms) : Date.now();
    if (expiresAtMs <= issuedAtMs || expiresAtMs - issuedAtMs > MAXIMUM_RECEIPT_AGE_MS ||
        nowMs > expiresAtMs + maximumClockSkewMs || nowMs < issuedAtMs - maximumClockSkewMs) return false;
    const expectedPreReceipt = {
      schema_version: 2 as const,
      ...identity,
      before_visible_sha256: receipt.before_visible_sha256,
      after_visible_sha256: receipt.after_visible_sha256,
      agent_package_sha256: receipt.agent_package_sha256,
      canonical_byte_lengths: receipt.canonical_byte_lengths,
      native_diff_readback: true as const,
      changed_element_keys: receipt.changed_element_keys,
      out_of_scope_changed_element_keys: receipt.out_of_scope_changed_element_keys,
      change_digest_sha256: receipt.change_digest_sha256,
      issued_at: receipt.issued_at,
      expires_at: receipt.expires_at,
      freshness_rule: receipt.freshness_rule,
      replay_key_sha256: receipt.replay_key_sha256
    };
    if (!timingSafeHexEqual(receipt.receipt_sha256, digest(expectedPreReceipt))) return false;
    const authority = receipt.evaluator_authority;
    if (!authority || authority.boundary !== "trusted_hmac_verifier_v1" || authority.algorithm !== "hmac-sha256") return false;
    const trustedKey = options.trusted_key_resolver?.(requiredIdentity(authority.key_id, "authority_key_id"));
    if (!trustedKey) return false;
    if (!timingSafeHexEqual(authority.signature, signReceipt(unsignedReceipt(receipt), trustedKey))) return false;
    if (options.expected_run) {
      const expectedIdentity = runIdentity(options.expected_run, options.expected_run.candidate_snapshot_sha256);
      if (JSON.stringify(stable(identity)) !== JSON.stringify(stable(expectedIdentity)) ||
          !timingSafeHexEqual(receipt.change_digest_sha256, options.expected_run.change_digest_sha256)) return false;
    }
    return true;
  } catch {
    return false;
  }
}
