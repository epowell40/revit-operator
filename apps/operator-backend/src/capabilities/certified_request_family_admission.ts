import { createHash } from "node:crypto";
import { canonicalJson, computeEffectHash, sha256, type JsonValue, type ToolExposurePolicyRecord } from "./tool_certification.js";

export const CERTIFIED_REQUEST_FAMILY_ADMISSION_SCHEMA = "revit-operator.certified-request-family-admission.v1";
export const CERTIFIED_MOVE_ONE_REQUEST_FAMILY_ID = "revit-operator.certified-move-one.request-family.v1";
export const CERTIFIED_MOVE_ONE_REQUEST_FAMILY_HASH = "sha256:24906494c42d86326cfba2c4b76318e8172f83f9cb65cd8aa0c84f7e1281e0de";
export const CERTIFIED_MOVE_ONE_PREVIEW_EFFECT_HASH = "sha256:4b9d9a0b4beb537b1db23b84aa3a2319497c0250fcc55ede2d87107d06ae428b";
export const CERTIFIED_MOVE_ONE_APPLY_EFFECT_HASH = "sha256:4da2bf877ae0747d17dec5123defd1912193bd2b9c59b57f7dd8d4aa7b7e1e7b";

const SHA256 = /^sha256:[0-9a-f]{64}$/;
const ADMISSION_KEYS = [
  "schema", "family_id", "family_hash", "request_instance_hash", "phase", "preview_instance_hash",
  "preview_receipt", "preview_receipt_hash", "document_fingerprint", "document_session_id", "source_scoped_id",
  "element_id", "observation_id", "observation_binding_hash", "admission_session_id", "outbound_body_sha256",
  "native_attestation_key_id", "native_attestation_modulus_base64url", "native_attestation_exponent_base64url"
] as const;
const BODY_KEYS = ["ids", "mode", "vectorX", "vectorY", "vectorZ", "dryRun", "behavior", "moveTogether", "options"] as const;
const OPTION_KEYS = ["failOnPinned", "unpinIfAllowed"] as const;

export type CertifiedRequestFamilyAdmission = {
  schema: typeof CERTIFIED_REQUEST_FAMILY_ADMISSION_SCHEMA;
  family_id: typeof CERTIFIED_MOVE_ONE_REQUEST_FAMILY_ID;
  family_hash: string;
  request_instance_hash: string;
  phase: "preview" | "apply";
  preview_instance_hash: string | null;
  preview_receipt: string | null;
  preview_receipt_hash: string | null;
  document_fingerprint: string;
  document_session_id: string;
  source_scoped_id: string;
  element_id: number;
  observation_id: string;
  observation_binding_hash: string;
  native_attestation_key_id: string;
  native_attestation_modulus_base64url: string;
  native_attestation_exponent_base64url: string;
  admission_session_id: string;
  outbound_body_sha256: string;
};

export type ValidatedCertifiedRequestFamilyAdmission = Readonly<CertifiedRequestFamilyAdmission>;

export class CertifiedRequestFamilyAdmissionError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "CertifiedRequestFamilyAdmissionError";
  }
}

const validatedAdmissions = new WeakSet<object>();
const finalizedInstances = new Set<string>();
const consumedPreviewReceipts = new Set<string>();

function denied(message: string): never {
  throw new CertifiedRequestFamilyAdmissionError("CERTIFICATION_REQUEST_FAMILY_DENIED", message);
}

function replayDenied(message: string): never {
  throw new CertifiedRequestFamilyAdmissionError("CERTIFICATION_REQUEST_FAMILY_REPLAY_DENIED", message);
}

function object(value: unknown, location: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)) {
    denied(`${location} must be a plain object.`);
  }
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[], location: string): void {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    denied(`${location} has missing or unknown fields.`);
  }
}

function hash(value: unknown, location: string): string {
  if (typeof value !== "string" || !SHA256.test(value)) denied(`${location} must be a canonical SHA-256 digest.`);
  return value as string;
}

function nfcText(value: unknown, location: string): string {
  if (typeof value !== "string" || !value || value !== value.normalize("NFC") || /[\u0000-\u001f\u007f]/.test(value)) {
    denied(`${location} must be a nonempty NFC string without control characters.`);
  }
  return value as string;
}

function rawDigest(value: string): string {
  return `sha256:${createHash("sha256").update(value, "utf8").digest("hex")}`;
}

/**
 * Independently validates the serialized family capability against the reviewed
 * validator. No caller-authored family fields are consulted by policy code
 * unless this function has recomputed both body and request-instance identities.
 */
export function validateCertifiedRequestFamilyAdmission(
  value: unknown,
  input: { method: string; path: string; body: JsonValue; bodyJson: string }
): ValidatedCertifiedRequestFamilyAdmission {
  if (input.method !== "POST" || input.path !== "/revit/move-elements") {
    denied("The certified move family is bound to one exact method and path.");
  }
  const raw = object(value, "request_family_admission");
  exactKeys(raw, ADMISSION_KEYS, "request_family_admission");
  if (raw.schema !== CERTIFIED_REQUEST_FAMILY_ADMISSION_SCHEMA
    || raw.family_id !== CERTIFIED_MOVE_ONE_REQUEST_FAMILY_ID
    || raw.family_hash !== CERTIFIED_MOVE_ONE_REQUEST_FAMILY_HASH) {
    denied("Request-family schema, identity, or reviewed validator hash is not recognized.");
  }
  const phase = raw.phase;
  if (phase !== "preview" && phase !== "apply") denied("Request-family phase must be preview or apply.");
  const previewInstanceHash = raw.preview_instance_hash === null ? null : hash(raw.preview_instance_hash, "preview_instance_hash");
  const previewReceiptHash = raw.preview_receipt_hash === null ? null : hash(raw.preview_receipt_hash, "preview_receipt_hash");
  const previewReceipt = raw.preview_receipt === null ? null : nfcText(raw.preview_receipt, "preview_receipt");
  if ((phase === "preview" && (previewInstanceHash !== null || previewReceipt !== null || previewReceiptHash !== null))
    || (phase === "apply" && (previewInstanceHash === null || previewReceipt === null || previewReceiptHash === null))) {
    denied("Preview lineage does not match the admitted phase.");
  }
  if (previewReceipt !== null
    && (!/^cmpr1_[A-Za-z0-9_-]{43}$/.test(previewReceipt) || rawDigest(previewReceipt) !== previewReceiptHash)) {
    denied("Preview receipt or its independently computed digest is invalid.");
  }
  const documentFingerprint = hash(raw.document_fingerprint, "document_fingerprint");
  if (typeof raw.document_session_id !== "string"
    || !/^[0-9a-f]{32}$/.test(raw.document_session_id)) {
    denied("document_session_id must be a canonical lowercase Guid N identity.");
  }
  const documentSessionId = raw.document_session_id;
  const sourceScopedId = nfcText(raw.source_scoped_id, "source_scoped_id");
  const observationId = nfcText(raw.observation_id, "observation_id");
  const observationBindingHash = hash(raw.observation_binding_hash, "observation_binding_hash");
  const nativeAttestationKeyId = hash(raw.native_attestation_key_id, "native_attestation_key_id");
  const nativeAttestationModulus = nfcText(raw.native_attestation_modulus_base64url, "native_attestation_modulus_base64url");
  const nativeAttestationExponent = nfcText(raw.native_attestation_exponent_base64url, "native_attestation_exponent_base64url");
  if (!/^[A-Za-z0-9_-]{256,512}$/.test(nativeAttestationModulus)
    || !/^[A-Za-z0-9_-]{1,16}$/.test(nativeAttestationExponent)
    || nativeAttestationKeyId !== sha256({
      algorithm: "RS256",
      exponent_base64url: nativeAttestationExponent,
      modulus_base64url: nativeAttestationModulus
    } as never)) {
    denied("Native execution attestation key binding is invalid.");
  }
  if (typeof raw.admission_session_id !== "string" || !/^[0-9a-f]{32}$/.test(raw.admission_session_id)) {
    denied("admission_session_id must be 32 lowercase hexadecimal characters.");
  }
  const admissionSessionId = raw.admission_session_id;
  if (!Number.isSafeInteger(raw.element_id) || (raw.element_id as number) <= 0) denied("element_id must be one positive safe integer.");
  const elementId = raw.element_id as number;
  const expectedObservationBinding = rawDigest([
    observationId,
    documentFingerprint,
    documentSessionId,
    sourceScopedId,
    String(elementId),
    nativeAttestationKeyId
  ].join("\n"));
  if (observationBindingHash !== expectedObservationBinding) denied("Observation binding hash does not match the exact document/session/source/target lineage.");
  const requestInstanceHash = hash(raw.request_instance_hash, "request_instance_hash");
  const outboundBodySha256 = hash(raw.outbound_body_sha256, "outbound_body_sha256");

  const body = object(input.body, "certified move outbound body");
  exactKeys(body, BODY_KEYS, "certified move outbound body");
  const options = object(body.options, "certified move options");
  exactKeys(options, OPTION_KEYS, "certified move options");
  if (!Array.isArray(body.ids) || body.ids.length !== 1 || body.ids[0] !== elementId
    || body.mode !== "vector" || body.behavior !== "allOrNothing" || body.moveTogether !== false
    || options.failOnPinned !== true || options.unpinIfAllowed !== false
    || body.dryRun !== (phase === "preview")) {
    denied("Outbound body is outside the exact reviewed move-one family.");
  }
  const vector = [body.vectorX, body.vectorY, body.vectorZ];
  if (vector.some(value => typeof value !== "number" || !Number.isFinite(value))) denied("Move vector must be finite.");
  const [x, y, z] = vector as [number, number, number];
  const magnitude = Math.hypot(x, y, z);
  if (magnitude <= 0 || magnitude > 2) denied("Move vector magnitude is outside the reviewed bound.");
  if (canonicalJson(input.body) !== input.bodyJson || rawDigest(input.bodyJson) !== outboundBodySha256) {
    denied("Outbound body hash does not match the exact canonical dispatched body bytes.");
  }

  const request = {
    phase,
    documentFingerprint,
    documentSessionId,
    sourceScopedId,
    elementId,
    observationId,
    observationBindingHash,
    nativeAttestationKeyId,
    nativeAttestationModulusBase64Url: nativeAttestationModulus,
    nativeAttestationExponentBase64Url: nativeAttestationExponent,
    vectorFeet: { x, y, z },
    ...(previewInstanceHash === null ? {} : { previewInstanceHash, previewReceiptHash })
  };
  const expectedInstanceHash = sha256({
    familyHash: CERTIFIED_MOVE_ONE_REQUEST_FAMILY_HASH,
    admissionSessionId,
    request,
    outboundBody: input.body
  } as never);
  if (requestInstanceHash !== expectedInstanceHash) denied("Request-instance hash does not match the exact normalized request and outbound body.");

  const admission = Object.freeze({
    schema: CERTIFIED_REQUEST_FAMILY_ADMISSION_SCHEMA,
    family_id: CERTIFIED_MOVE_ONE_REQUEST_FAMILY_ID,
    family_hash: CERTIFIED_MOVE_ONE_REQUEST_FAMILY_HASH,
    request_instance_hash: requestInstanceHash,
    phase,
    preview_instance_hash: previewInstanceHash,
    preview_receipt: previewReceipt,
    preview_receipt_hash: previewReceiptHash,
    document_fingerprint: documentFingerprint,
    document_session_id: documentSessionId,
    source_scoped_id: sourceScopedId,
    element_id: elementId,
    observation_id: observationId,
    observation_binding_hash: observationBindingHash,
    native_attestation_key_id: nativeAttestationKeyId,
    native_attestation_modulus_base64url: nativeAttestationModulus,
    native_attestation_exponent_base64url: nativeAttestationExponent,
    admission_session_id: admissionSessionId,
    outbound_body_sha256: outboundBodySha256
  }) as ValidatedCertifiedRequestFamilyAdmission;
  validatedAdmissions.add(admission);
  return admission;
}

export function assertValidatedCertifiedRequestFamilyAdmission(value: unknown): asserts value is ValidatedCertifiedRequestFamilyAdmission {
  if (!value || typeof value !== "object" || !validatedAdmissions.has(value as object)) {
    denied("Request-family policy admission was not produced by the local reviewed validator.");
  }
}

export function certifiedRequestFamilyEffectHash(admission: ValidatedCertifiedRequestFamilyAdmission): string {
  assertValidatedCertifiedRequestFamilyAdmission(admission);
  return admission.phase === "preview" ? CERTIFIED_MOVE_ONE_PREVIEW_EFFECT_HASH : CERTIFIED_MOVE_ONE_APPLY_EFFECT_HASH;
}

export function assertPolicyBindsCertifiedRequestFamily(
  admission: ValidatedCertifiedRequestFamilyAdmission,
  record: ToolExposurePolicyRecord
): void {
  assertValidatedCertifiedRequestFamilyAdmission(admission);
  if (record.request_family?.schema !== "revit-operator.certified-request-family.v1"
    || record.request_family.id !== admission.family_id
    || record.request_family.validator_hash !== admission.family_hash) {
    denied("Current policy does not bind the exact reviewed request-family validator.");
  }
  if (record.effect_hash !== certifiedRequestFamilyExpectedEffectHash(admission)) {
    denied("Current policy effect does not match the independently derived request-family phase and body.");
  }
}

/** Never accepts a caller-selected effect for a validated family instance. */
export function certifiedRequestFamilyExpectedEffectHash(
  admission: ValidatedCertifiedRequestFamilyAdmission
): string {
  assertValidatedCertifiedRequestFamilyAdmission(admission);
  return computeEffectHash({ resolved_effect: admission.phase === "preview" ? "preview" : "write" });
}

/** Final call-time replay consumption. Native issues and independently owns preview receipts after rollback. */
export function finalizeCertifiedRequestFamilyAdmission(
  admission: ValidatedCertifiedRequestFamilyAdmission,
  bodyJson: string
): void {
  assertValidatedCertifiedRequestFamilyAdmission(admission);
  if (finalizedInstances.has(admission.request_instance_hash)) replayDenied("This exact request-family instance has already been finalized.");
  // Retain the body parameter so callers cannot accidentally finalize a
  // different object without first passing the structural validator.
  if (rawDigest(bodyJson) !== admission.outbound_body_sha256) denied("Finalized body differs from the admitted outbound body.");
  if (admission.phase === "apply") {
    if (consumedPreviewReceipts.has(admission.preview_receipt_hash!)) {
      replayDenied("This native rollback preview receipt has already been consumed.");
    }
    // Consume before dispatch. Unknown post-dispatch mutation outcomes must
    // never restore a preview capability for automatic retry.
    consumedPreviewReceipts.add(admission.preview_receipt_hash!);
  }
  finalizedInstances.add(admission.request_instance_hash);
}
