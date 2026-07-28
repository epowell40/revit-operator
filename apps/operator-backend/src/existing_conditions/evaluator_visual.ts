import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export type ExistingConditionsEvaluatorArtifactBinding = {
  path: string;
  file_name: string;
  sha256: string;
  byte_length: number;
  media_type: "image" | "application/pdf";
  modified_at: string;
};

export type ExistingConditionsEvaluatorSigningAuthority = {
  key_id: string;
  signing_key: string | Buffer;
};

export type ExistingConditionsEvaluatorRunIdentity = {
  fixture_id: string;
  scope_id: string;
  workflow_fingerprint_sha256: string;
  action_id: string;
  attempt_id: string;
  capture_nonce: string;
  capture_name: string;
  artifact_scope_root: string;
  candidate_snapshot_sha256: string;
};

export type ExistingConditionsEvaluatorExpectedRun = ExistingConditionsEvaluatorRunIdentity & {
  change_digest_sha256: string;
};

export type ExistingConditionsEvaluatorVisualReceipt = {
  schema_version: 3;
  fixture_id: string;
  scope_id: string;
  artifact_scope_root: string;
  workflow_fingerprint_sha256: string;
  action_id: string;
  attempt_id: string;
  capture_nonce: string;
  capture_name: string;
  candidate_snapshot_sha256: string;
  change_digest_sha256: string;
  post_apply_completed_at: string;
  issued_at: string;
  expires_at: string;
  freshness_rule: "bounded_single_attempt_capture_v1";
  replay_key_sha256: string;
  post_change_capture_sha256: string;
  post_change_pdf_sha256: string;
  post_change_capture_artifact: ExistingConditionsEvaluatorArtifactBinding;
  post_change_pdf_artifact: ExistingConditionsEvaluatorArtifactBinding;
  evaluator_review: {
    reviewer_role: "evaluator";
    review_status: "pass" | "needs_review" | "fail";
    notes: string[];
  };
  evaluator_authority: {
    boundary: "trusted_hmac_verifier_v1";
    algorithm: "hmac-sha256";
    key_id: string;
    signature: string;
  };
};

export type ExistingConditionsEvaluatorVisualValidationOptions = {
  allowed_artifact_root?: string;
  trusted_key_resolver?: (keyId: string) => string | Buffer | null | undefined;
  maximum_clock_skew_ms?: number;
  expected_run?: ExistingConditionsEvaluatorExpectedRun;
  now_ms?: number;
};

type UnsignedVisualReceipt = Omit<ExistingConditionsEvaluatorVisualReceipt, "evaluator_authority"> & {
  evaluator_authority: Omit<ExistingConditionsEvaluatorVisualReceipt["evaluator_authority"], "signature">;
};

const SHA256_PATTERN = /^[a-f0-9]{64}$/i;
const NONCE_PATTERN = /^[A-Za-z0-9_-]{16,128}$/;
const DEFAULT_MAXIMUM_CLOCK_SKEW_MS = 5_000;
const DEFAULT_RECEIPT_MAXIMUM_AGE_MS = 5 * 60_000;
const MAXIMUM_RECEIPT_AGE_MS = 24 * 60 * 60_000;

function canonicalJson(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("evaluator_visual_non_finite_number");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value !== "object") throw new Error("evaluator_visual_unsupported_payload_value");
  const row = value as Record<string, unknown>;
  return `{${Object.keys(row).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(row[key])}`).join(",")}}`;
}

function hashBytes(bytes: Buffer): string {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

function hashCanonical(value: unknown): string {
  return hashBytes(Buffer.from(canonicalJson(value), "utf8"));
}

function signingKeyBytes(value: string | Buffer): Buffer {
  const bytes = Buffer.isBuffer(value) ? Buffer.from(value) : Buffer.from(value, "utf8");
  if (bytes.length < 32) throw new Error("evaluator_visual_signing_key_must_be_at_least_32_bytes");
  return bytes;
}

function signReceipt(payload: UnsignedVisualReceipt, key: string | Buffer): string {
  return crypto.createHmac("sha256", signingKeyBytes(key)).update(canonicalJson(payload)).digest("hex");
}

function isWithin(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function isSupportedImage(bytes: Buffer): boolean {
  const png = bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  const jpeg = bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8 &&
    bytes[bytes.length - 2] === 0xff && bytes[bytes.length - 1] === 0xd9;
  return png || jpeg;
}

function isSupportedPdf(bytes: Buffer): boolean {
  if (bytes.length < 9 || bytes.subarray(0, 5).toString("ascii") !== "%PDF-") return false;
  return bytes.subarray(Math.max(0, bytes.length - 1024)).toString("latin1").includes("%%EOF");
}

function requiredIdentity(value: unknown, field: string): string {
  const normalized = String(value ?? "").trim();
  if (!normalized || normalized.length > 256) throw new Error(`evaluator_visual_${field}_invalid`);
  return normalized;
}

function requiredSha256(value: unknown, field: string): string {
  const normalized = String(value ?? "").trim().toLowerCase();
  if (!SHA256_PATTERN.test(normalized)) throw new Error(`evaluator_visual_${field}_invalid`);
  return normalized;
}

function requiredNonce(value: unknown): string {
  const normalized = String(value ?? "").trim();
  if (!NONCE_PATTERN.test(normalized)) throw new Error("evaluator_visual_capture_nonce_invalid");
  return normalized;
}

function receiptMaximumAgeMs(value: unknown): number {
  const parsed = value === undefined ? DEFAULT_RECEIPT_MAXIMUM_AGE_MS : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0 || parsed > MAXIMUM_RECEIPT_AGE_MS) {
    throw new Error("evaluator_visual_maximum_receipt_age_ms_invalid");
  }
  return parsed;
}

function replayKey(run: ExistingConditionsEvaluatorExpectedRun): string {
  return hashCanonical({
    fixture_id: run.fixture_id,
    scope_id: run.scope_id,
    workflow_fingerprint_sha256: run.workflow_fingerprint_sha256,
    action_id: run.action_id,
    attempt_id: run.attempt_id,
    capture_nonce: run.capture_nonce,
    capture_name: run.capture_name,
    artifact_scope_root: run.artifact_scope_root,
    candidate_snapshot_sha256: run.candidate_snapshot_sha256,
    change_digest_sha256: run.change_digest_sha256
  });
}

function normalizedExpectedRun(value: ExistingConditionsEvaluatorExpectedRun): ExistingConditionsEvaluatorExpectedRun {
  const artifactScopeRoot = fs.realpathSync(path.resolve(value.artifact_scope_root));
  return {
    fixture_id: requiredIdentity(value.fixture_id, "fixture_id"),
    scope_id: requiredIdentity(value.scope_id, "scope_id"),
    workflow_fingerprint_sha256: requiredSha256(value.workflow_fingerprint_sha256, "workflow_fingerprint"),
    action_id: requiredIdentity(value.action_id, "action_id"),
    attempt_id: requiredIdentity(value.attempt_id, "attempt_id"),
    capture_nonce: requiredNonce(value.capture_nonce),
    capture_name: requiredIdentity(value.capture_name, "capture_name"),
    artifact_scope_root: artifactScopeRoot,
    candidate_snapshot_sha256: requiredSha256(value.candidate_snapshot_sha256, "candidate_snapshot_sha256"),
    change_digest_sha256: requiredSha256(value.change_digest_sha256, "change_digest_sha256")
  };
}

function timestampMs(value: unknown, field: string): number {
  const normalized = String(value ?? "").trim();
  const parsed = Date.parse(normalized);
  if (!normalized || !Number.isFinite(parsed) || new Date(parsed).toISOString() !== normalized) {
    throw new Error(`evaluator_visual_${field}_invalid`);
  }
  return parsed;
}

function bindArtifact(args: {
  filePath: string;
  artifactScopeRoot: string;
  mediaType: ExistingConditionsEvaluatorArtifactBinding["media_type"];
  postApplyCompletedAtMs: number;
  issuedAtMs: number;
  maximumClockSkewMs: number;
}): ExistingConditionsEvaluatorArtifactBinding {
  const root = fs.realpathSync(path.resolve(args.artifactScopeRoot));
  const filePath = fs.realpathSync(path.resolve(args.filePath));
  if (!fs.statSync(root).isDirectory() || !isWithin(root, filePath)) {
    throw new Error("evaluator_visual_artifact_outside_allowed_scope");
  }
  const stat = fs.statSync(filePath);
  if (!stat.isFile() || stat.size <= 0) throw new Error("evaluator_visual_artifact_must_be_nonempty_file");
  if (stat.mtimeMs < args.postApplyCompletedAtMs || stat.mtimeMs > args.issuedAtMs + args.maximumClockSkewMs) {
    throw new Error("evaluator_visual_artifact_is_not_post_apply_fresh");
  }
  const bytes = fs.readFileSync(filePath);
  if (args.mediaType === "image" ? !isSupportedImage(bytes) : !isSupportedPdf(bytes)) {
    throw new Error(`evaluator_visual_artifact_media_mismatch:${args.mediaType}`);
  }
  return {
    path: filePath,
    file_name: path.basename(filePath),
    sha256: hashBytes(bytes),
    byte_length: bytes.length,
    media_type: args.mediaType,
    modified_at: stat.mtime.toISOString()
  };
}

function validateArtifactBinding(args: {
  binding: ExistingConditionsEvaluatorArtifactBinding;
  artifactScopeRoot: string;
  expectedHash: string;
  mediaType: ExistingConditionsEvaluatorArtifactBinding["media_type"];
  postApplyCompletedAtMs: number;
  issuedAtMs: number;
  maximumClockSkewMs: number;
}): boolean {
  try {
    if (!args.binding || args.binding.media_type !== args.mediaType ||
        !SHA256_PATTERN.test(args.binding.sha256) || args.binding.sha256.toLowerCase() !== args.expectedHash.toLowerCase() ||
        !Number.isSafeInteger(args.binding.byte_length) || args.binding.byte_length <= 0 ||
        path.basename(args.binding.path) !== args.binding.file_name) return false;
    timestampMs(args.binding.modified_at, "artifact_modified_at");
    const actual = bindArtifact({
      filePath: args.binding.path,
      artifactScopeRoot: args.artifactScopeRoot,
      mediaType: args.mediaType,
      postApplyCompletedAtMs: args.postApplyCompletedAtMs,
      issuedAtMs: args.issuedAtMs,
      maximumClockSkewMs: args.maximumClockSkewMs
    });
    return actual.path === args.binding.path &&
      actual.file_name === args.binding.file_name &&
      actual.sha256 === args.binding.sha256.toLowerCase() &&
      actual.byte_length === args.binding.byte_length &&
      actual.modified_at === args.binding.modified_at;
  } catch {
    return false;
  }
}

function unsignedReceipt(receipt: ExistingConditionsEvaluatorVisualReceipt): UnsignedVisualReceipt {
  return {
    schema_version: 3,
    fixture_id: receipt.fixture_id,
    scope_id: receipt.scope_id,
    artifact_scope_root: receipt.artifact_scope_root,
    workflow_fingerprint_sha256: receipt.workflow_fingerprint_sha256,
    action_id: receipt.action_id,
    attempt_id: receipt.attempt_id,
    capture_nonce: receipt.capture_nonce,
    capture_name: receipt.capture_name,
    candidate_snapshot_sha256: receipt.candidate_snapshot_sha256,
    change_digest_sha256: receipt.change_digest_sha256,
    post_apply_completed_at: receipt.post_apply_completed_at,
    issued_at: receipt.issued_at,
    expires_at: receipt.expires_at,
    freshness_rule: receipt.freshness_rule,
    replay_key_sha256: receipt.replay_key_sha256,
    post_change_capture_sha256: receipt.post_change_capture_sha256,
    post_change_pdf_sha256: receipt.post_change_pdf_sha256,
    post_change_capture_artifact: receipt.post_change_capture_artifact,
    post_change_pdf_artifact: receipt.post_change_pdf_artifact,
    evaluator_review: receipt.evaluator_review,
    evaluator_authority: {
      boundary: "trusted_hmac_verifier_v1",
      algorithm: "hmac-sha256",
      key_id: receipt.evaluator_authority.key_id
    }
  };
}

export function existingConditionsEvaluatorSigningAuthorityFromEnvironment(): ExistingConditionsEvaluatorSigningAuthority {
  const key_id = String(process.env.OPERATOR_EXISTING_CONDITIONS_EVALUATOR_KEY_ID ?? "").trim();
  const signing_key = String(process.env.OPERATOR_EXISTING_CONDITIONS_EVALUATOR_HMAC_KEY ?? "");
  if (!key_id || !signing_key) throw new Error("existing_conditions_evaluator_authority_not_configured");
  signingKeyBytes(signing_key);
  return { key_id, signing_key };
}

export function existingConditionsEvaluatorValidationOptionsFromEnvironment(
  allowedArtifactRoot?: string
): ExistingConditionsEvaluatorVisualValidationOptions {
  const authority = existingConditionsEvaluatorSigningAuthorityFromEnvironment();
  const expectedRunJson = String(process.env.OPERATOR_EXISTING_CONDITIONS_EVALUATOR_EXPECTED_RUN_JSON ?? "").trim();
  let expectedRun: ExistingConditionsEvaluatorExpectedRun | undefined;
  if (expectedRunJson) {
    try {
      expectedRun = normalizedExpectedRun(JSON.parse(expectedRunJson) as ExistingConditionsEvaluatorExpectedRun);
    } catch {
      throw new Error("existing_conditions_evaluator_expected_run_invalid");
    }
  }
  return {
    ...(allowedArtifactRoot ? { allowed_artifact_root: allowedArtifactRoot } : {}),
    trusted_key_resolver: keyId => keyId === authority.key_id ? authority.signing_key : null,
    ...(expectedRun ? { expected_run: expectedRun } : {})
  };
}

export function createExistingConditionsEvaluatorVisualReceipt(input: {
  post_change_capture_path: string;
  post_change_pdf_path: string;
  artifact_scope_root: string;
  fixture_id?: string;
  scope_id?: string;
  workflow_fingerprint_sha256: string;
  action_id: string;
  attempt_id: string;
  capture_nonce: string;
  capture_name?: string;
  candidate_snapshot_sha256?: string;
  change_digest_sha256?: string;
  post_apply_completed_at: string;
  authority: ExistingConditionsEvaluatorSigningAuthority;
  review_status: "pass" | "needs_review" | "fail";
  notes?: string[];
  maximum_receipt_age_ms?: number;
}): ExistingConditionsEvaluatorVisualReceipt {
  const artifactScopeRoot = fs.realpathSync(path.resolve(input.artifact_scope_root));
  const fixtureId = requiredIdentity(input.fixture_id, "fixture_id");
  const scopeId = requiredIdentity(input.scope_id, "scope_id");
  const workflowFingerprint = requiredSha256(input.workflow_fingerprint_sha256, "workflow_fingerprint");
  const actionId = requiredIdentity(input.action_id, "action_id");
  const attemptId = requiredIdentity(input.attempt_id, "attempt_id");
  const captureNonce = requiredNonce(input.capture_nonce);
  const captureName = requiredIdentity(input.capture_name, "capture_name");
  const candidateSnapshotSha256 = requiredSha256(input.candidate_snapshot_sha256, "candidate_snapshot_sha256");
  const changeDigestSha256 = requiredSha256(input.change_digest_sha256, "change_digest_sha256");
  const maximumReceiptAgeMs = receiptMaximumAgeMs(input.maximum_receipt_age_ms);
  const postApplyCompletedAtMs = timestampMs(input.post_apply_completed_at, "post_apply_completed_at");
  const issuedAt = new Date().toISOString();
  const issuedAtMs = Date.parse(issuedAt);
  if (postApplyCompletedAtMs > issuedAtMs + DEFAULT_MAXIMUM_CLOCK_SKEW_MS) {
    throw new Error("evaluator_visual_post_apply_time_is_in_future");
  }
  const capture = bindArtifact({
    filePath: input.post_change_capture_path,
    artifactScopeRoot,
    mediaType: "image",
    postApplyCompletedAtMs,
    issuedAtMs,
    maximumClockSkewMs: DEFAULT_MAXIMUM_CLOCK_SKEW_MS
  });
  const pdf = bindArtifact({
    filePath: input.post_change_pdf_path,
    artifactScopeRoot,
    mediaType: "application/pdf",
    postApplyCompletedAtMs,
    issuedAtMs,
    maximumClockSkewMs: DEFAULT_MAXIMUM_CLOCK_SKEW_MS
  });
  if (capture.path === pdf.path) throw new Error("evaluator_visual_artifacts_must_be_distinct");
  if (capture.file_name !== captureName) throw new Error("evaluator_visual_capture_name_mismatch");
  if (issuedAtMs - postApplyCompletedAtMs > maximumReceiptAgeMs + DEFAULT_MAXIMUM_CLOCK_SKEW_MS) {
    throw new Error("evaluator_visual_post_apply_time_is_stale");
  }
  const notes = [...new Set((input.notes ?? []).map(note => note.trim()).filter(Boolean))];
  const keyId = requiredIdentity(input.authority?.key_id, "authority_key_id");
  const expectedRun: ExistingConditionsEvaluatorExpectedRun = {
    fixture_id: fixtureId,
    scope_id: scopeId,
    workflow_fingerprint_sha256: workflowFingerprint,
    action_id: actionId,
    attempt_id: attemptId,
    capture_nonce: captureNonce,
    capture_name: captureName,
    artifact_scope_root: artifactScopeRoot,
    candidate_snapshot_sha256: candidateSnapshotSha256,
    change_digest_sha256: changeDigestSha256
  };
  const payload: UnsignedVisualReceipt = {
    schema_version: 3,
    fixture_id: fixtureId,
    scope_id: scopeId,
    artifact_scope_root: artifactScopeRoot,
    workflow_fingerprint_sha256: workflowFingerprint,
    action_id: actionId,
    attempt_id: attemptId,
    capture_nonce: captureNonce,
    capture_name: captureName,
    candidate_snapshot_sha256: candidateSnapshotSha256,
    change_digest_sha256: changeDigestSha256,
    post_apply_completed_at: new Date(postApplyCompletedAtMs).toISOString(),
    issued_at: issuedAt,
    expires_at: new Date(issuedAtMs + maximumReceiptAgeMs).toISOString(),
    freshness_rule: "bounded_single_attempt_capture_v1",
    replay_key_sha256: replayKey(expectedRun),
    post_change_capture_sha256: capture.sha256,
    post_change_pdf_sha256: pdf.sha256,
    post_change_capture_artifact: capture,
    post_change_pdf_artifact: pdf,
    evaluator_review: {
      reviewer_role: "evaluator",
      review_status: input.review_status,
      notes
    },
    evaluator_authority: {
      boundary: "trusted_hmac_verifier_v1",
      algorithm: "hmac-sha256",
      key_id: keyId
    }
  };
  return {
    ...payload,
    evaluator_authority: {
      ...payload.evaluator_authority,
      signature: signReceipt(payload, input.authority.signing_key)
    }
  };
}

export function validateExistingConditionsEvaluatorVisualReceipt(
  receipt: ExistingConditionsEvaluatorVisualReceipt | null | undefined,
  options: ExistingConditionsEvaluatorVisualValidationOptions = {}
): boolean {
  try {
    if (!receipt || receipt.schema_version !== 3 ||
        !requiredIdentity(receipt.fixture_id, "fixture_id") ||
        !requiredIdentity(receipt.scope_id, "scope_id") ||
        !SHA256_PATTERN.test(receipt.workflow_fingerprint_sha256) ||
        !SHA256_PATTERN.test(receipt.candidate_snapshot_sha256) ||
        !SHA256_PATTERN.test(receipt.change_digest_sha256) ||
        !SHA256_PATTERN.test(receipt.replay_key_sha256) ||
        !SHA256_PATTERN.test(receipt.post_change_capture_sha256) ||
        !SHA256_PATTERN.test(receipt.post_change_pdf_sha256) ||
        !NONCE_PATTERN.test(receipt.capture_nonce)) return false;
    requiredIdentity(receipt.action_id, "action_id");
    requiredIdentity(receipt.attempt_id, "attempt_id");
    requiredIdentity(receipt.capture_name, "capture_name");
    if (receipt.freshness_rule !== "bounded_single_attempt_capture_v1") return false;
    const review = receipt.evaluator_review;
    if (!review || review.reviewer_role !== "evaluator" || !["pass", "needs_review", "fail"].includes(review.review_status)) return false;
    if (!Array.isArray(review.notes) || review.notes.some(note => typeof note !== "string" || !note.trim())) return false;
    const authority = receipt.evaluator_authority;
    if (!authority || authority.boundary !== "trusted_hmac_verifier_v1" || authority.algorithm !== "hmac-sha256" ||
        !SHA256_PATTERN.test(authority.signature)) return false;
    const trustedKey = options.trusted_key_resolver?.(requiredIdentity(authority.key_id, "authority_key_id"));
    if (!trustedKey) return false;

    const artifactScopeRoot = fs.realpathSync(path.resolve(receipt.artifact_scope_root));
    if (artifactScopeRoot !== receipt.artifact_scope_root) return false;
    if (options.allowed_artifact_root) {
      const allowedRoot = fs.realpathSync(path.resolve(options.allowed_artifact_root));
      if (artifactScopeRoot !== allowedRoot) return false;
    }
    const postApplyCompletedAtMs = timestampMs(receipt.post_apply_completed_at, "post_apply_completed_at");
    const issuedAtMs = timestampMs(receipt.issued_at, "issued_at");
    const expiresAtMs = timestampMs(receipt.expires_at, "expires_at");
    const maximumClockSkewMs = Number.isFinite(options.maximum_clock_skew_ms)
      ? Math.max(0, Number(options.maximum_clock_skew_ms))
      : DEFAULT_MAXIMUM_CLOCK_SKEW_MS;
    if (postApplyCompletedAtMs > issuedAtMs + maximumClockSkewMs) return false;
    if (expiresAtMs <= issuedAtMs || expiresAtMs - issuedAtMs > MAXIMUM_RECEIPT_AGE_MS) return false;
    const nowMs = Number.isFinite(options.now_ms) ? Number(options.now_ms) : Date.now();
    if (nowMs > expiresAtMs + maximumClockSkewMs || nowMs < issuedAtMs - maximumClockSkewMs) return false;
    const receiptRun: ExistingConditionsEvaluatorExpectedRun = {
      fixture_id: receipt.fixture_id,
      scope_id: receipt.scope_id,
      workflow_fingerprint_sha256: receipt.workflow_fingerprint_sha256.toLowerCase(),
      action_id: receipt.action_id,
      attempt_id: receipt.attempt_id,
      capture_nonce: receipt.capture_nonce,
      capture_name: receipt.capture_name,
      artifact_scope_root: receipt.artifact_scope_root,
      candidate_snapshot_sha256: receipt.candidate_snapshot_sha256.toLowerCase(),
      change_digest_sha256: receipt.change_digest_sha256.toLowerCase()
    };
    if (replayKey(receiptRun) !== receipt.replay_key_sha256.toLowerCase()) return false;
    if (receipt.post_change_capture_artifact.file_name !== receipt.capture_name) return false;
    if (options.expected_run) {
      const expected = normalizedExpectedRun(options.expected_run);
      if (canonicalJson(receiptRun) !== canonicalJson(expected)) return false;
    }
    if (!validateArtifactBinding({
      binding: receipt.post_change_capture_artifact,
      artifactScopeRoot,
      expectedHash: receipt.post_change_capture_sha256,
      mediaType: "image",
      postApplyCompletedAtMs,
      issuedAtMs,
      maximumClockSkewMs
    }) || !validateArtifactBinding({
      binding: receipt.post_change_pdf_artifact,
      artifactScopeRoot,
      expectedHash: receipt.post_change_pdf_sha256,
      mediaType: "application/pdf",
      postApplyCompletedAtMs,
      issuedAtMs,
      maximumClockSkewMs
    })) return false;

    const expectedSignature = signReceipt(unsignedReceipt(receipt), trustedKey);
    const actualBytes = Buffer.from(authority.signature.toLowerCase(), "hex");
    const expectedBytes = Buffer.from(expectedSignature, "hex");
    return actualBytes.length === expectedBytes.length && crypto.timingSafeEqual(actualBytes, expectedBytes);
  } catch {
    return false;
  }
}
