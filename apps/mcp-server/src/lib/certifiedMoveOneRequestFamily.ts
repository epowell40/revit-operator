import { createHash, createPublicKey, randomBytes, verify } from "node:crypto";
import { resolveCertifiedMoveTarget } from "./certifiedMoveTargetLedger.js";

/**
 * Contract material for the first reversible-write certification tranche.
 * This module is deliberately unexposed: it prepares a request-family binding
 * but does not change tool exposure, write grants, or native authorization.
 */
export const CERTIFIED_MOVE_ONE_REQUEST_FAMILY_V1 = "revit-operator.certified-move-one.request-family.v1";
export const CERTIFIED_MOVE_ONE_MAX_DISPLACEMENT_FEET = 2;

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type Phase = "preview" | "apply";

export type CertifiedMoveOneRequest = {
  phase: Phase;
  documentFingerprint: string;
  documentSessionId: string;
  sourceScopedId: string;
  elementId: number;
  observationId: string;
  observationBindingHash: string;
  nativeAttestationKeyId: string;
  nativeAttestationModulusBase64Url: string;
  nativeAttestationExponentBase64Url: string;
  vectorFeet: { x: number; y: number; z: number };
  previewInstanceHash?: string;
  previewReceiptHash?: string;
};

export type CertifiedMoveOneAdmission = {
  familyId: typeof CERTIFIED_MOVE_ONE_REQUEST_FAMILY_V1;
  familyHash: string;
  requestInstanceHash: string;
  admissionSessionId: string;
  request: CertifiedMoveOneRequest;
  outboundBody: {
    ids: number[];
    mode: "vector";
    vectorX: number;
    vectorY: number;
    vectorZ: number;
    dryRun: boolean;
    behavior: "allOrNothing";
    moveTogether: false;
    options: { failOnPinned: true; unpinIfAllowed: false };
  };
};

export type CertifiedMoveExecutionContext = Readonly<{
  transportKind: "direct" | "courier";
  dispatchId: string;
  correlationId: string;
  executionSessionId: string;
  executorId: string;
  certificationEnvelopeHash: string;
  completionChallengeHash: string | null;
}>;

export class CertifiedMoveOneRequestError extends Error {
  constructor(readonly code: string, message: string) { super(`[${code}] ${message}`); }
}

// Admission objects are process-local capabilities. A structurally identical
// JSON object cannot skip the reviewed validator on the execution path.
const admittedRequests = new WeakSet<object>();
const issuedExecutionContexts = new WeakSet<object>();
const admissionSessionId = randomBytes(16).toString("hex");
type PreviewPolicyBinding = Readonly<{
  policyHash: string;
  policyRecordHash: string;
  evidenceRecordHash: string;
  effectHash: string;
  channel: string;
  alias: string;
}>;
type ProductionPreviewReceiptRecord = Readonly<{
  lane: "production";
  previewAdmission: CertifiedMoveOneAdmission;
  token: string;
  receiptHash: string;
  policy: PreviewPolicyBinding;
}>;
type LaboratoryPreviewReceiptRecord = Readonly<{
  lane: "laboratory_evidence";
  previewAdmission: CertifiedMoveOneAdmission;
  token: string;
  receiptHash: string;
  receiptJson: string;
}>;
type PreviewReceiptRecord = ProductionPreviewReceiptRecord | LaboratoryPreviewReceiptRecord;
const issuedPreviewReceipts = new Map<string, PreviewReceiptRecord>();
const applyPreviewLineage = new WeakMap<object, PreviewReceiptRecord>();
export type CertifiedMoveOneTransportBinding = Readonly<{
  schema: "revit-operator.certified-request-family-admission.v1";
  family_id: string;
  family_hash: string;
  request_instance_hash: string;
  admission_session_id: string;
  phase: Phase;
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
  outbound_body_sha256: string;
}>;
const transportBindings = new WeakMap<object, CertifiedMoveOneTransportBinding>();

const FAMILY_MATERIAL: Json = {
  family: CERTIFIED_MOVE_ONE_REQUEST_FAMILY_V1,
  route: { method: "POST", path: "/revit/move-elements", alias: "revit_move_one_certified" },
  target: { exactlyOne: true, hostDocumentOnly: true, pointLocatedOnly: true, linked: false, grouped: false, pinned: false },
  vector: { unit: "feet", finite: true, maxEuclideanMagnitude: CERTIFIED_MOVE_ONE_MAX_DISPLACEMENT_FEET },
  options: { behavior: "allOrNothing", moveTogether: false, failOnPinned: true, unpinIfAllowed: false },
  lineage: {
    documentFingerprint: true, documentSessionId: true, sourceScopedId: true,
    observationId: true, observationBindingHash: true,
    nativeExecutionAttestationKey: true,
    runtimeIssuedSingleUsePreviewReceipt: true, previewRequiredForApply: true
  }
};

function canonical(value: Json): string {
  if (value === null || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new CertifiedMoveOneRequestError("MOVE_ONE_VECTOR_INVALID", "All vector values must be finite.");
    return JSON.stringify(value);
  }
  if (typeof value === "string") return JSON.stringify(value.normalize("NFC"));
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key.normalize("NFC"))}:${canonical(value[key]!)}`).join(",")}}`;
}

function digest(value: Json): string { return `sha256:${createHash("sha256").update(canonical(value), "utf8").digest("hex")}`; }
function rawDigest(value: string): string { return `sha256:${createHash("sha256").update(value, "utf8").digest("hex")}`; }
function object(value: unknown, name: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)) {
    throw new CertifiedMoveOneRequestError("MOVE_ONE_REQUEST_INVALID", `${name} must be a plain object.`);
  }
  return value as Record<string, unknown>;
}
function exactKeys(value: Record<string, unknown>, keys: readonly string[], name: string): void {
  const found = Object.keys(value).sort(); const expected = [...keys].sort();
  if (found.length !== expected.length || found.some((key, index) => key !== expected[index])) {
    throw new CertifiedMoveOneRequestError("MOVE_ONE_REQUEST_INVALID", `${name} has missing or unknown fields.`);
  }
}
function nonempty(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim() || value !== value.normalize("NFC")) throw new CertifiedMoveOneRequestError("MOVE_ONE_REQUEST_INVALID", `${name} must be a nonempty NFC string.`);
  return value;
}
function sha256(value: unknown, name: string): string {
  const text = nonempty(value, name);
  if (!/^sha256:[0-9a-f]{64}$/.test(text)) throw new CertifiedMoveOneRequestError("MOVE_ONE_REQUEST_INVALID", `${name} must be a lowercase sha256 digest.`);
  return text;
}

export const CERTIFIED_MOVE_ONE_REQUEST_FAMILY_HASH = digest(FAMILY_MATERIAL);

function samePreviewLineage(preview: CertifiedMoveOneRequest, apply: CertifiedMoveOneRequest): boolean {
  return preview.documentFingerprint === apply.documentFingerprint
    && preview.documentSessionId === apply.documentSessionId
    && preview.sourceScopedId === apply.sourceScopedId
    && preview.elementId === apply.elementId
    && preview.observationId === apply.observationId
    && preview.observationBindingHash === apply.observationBindingHash
    && preview.nativeAttestationKeyId === apply.nativeAttestationKeyId
    && preview.nativeAttestationModulusBase64Url === apply.nativeAttestationModulusBase64Url
    && preview.nativeAttestationExponentBase64Url === apply.nativeAttestationExponentBase64Url
    && preview.vectorFeet.x === apply.vectorFeet.x
    && preview.vectorFeet.y === apply.vectorFeet.y
    && preview.vectorFeet.z === apply.vectorFeet.z;
}

/** Validates the model-facing profile and produces the legacy handler's exact body. */
export function admitCertifiedMoveOneRequest(input: unknown): CertifiedMoveOneAdmission {
  const raw = object(input, "request");
  exactKeys(raw, ["phase", "elementId", "observationId", "vectorFeet", "previewReceipt"], "request");
  if (raw.phase !== "preview" && raw.phase !== "apply") throw new CertifiedMoveOneRequestError("MOVE_ONE_REQUEST_INVALID", "phase must be preview or apply.");
  const phase = raw.phase;
  const vector = object(raw.vectorFeet, "vectorFeet"); exactKeys(vector, ["x", "y", "z"], "vectorFeet");
  for (const key of ["x", "y", "z"] as const) if (typeof vector[key] !== "number" || !Number.isFinite(vector[key])) throw new CertifiedMoveOneRequestError("MOVE_ONE_VECTOR_INVALID", `vectorFeet.${key} must be finite.`);
  const magnitude = Math.hypot(vector.x as number, vector.y as number, vector.z as number);
  if (magnitude <= 0 || magnitude > CERTIFIED_MOVE_ONE_MAX_DISPLACEMENT_FEET) throw new CertifiedMoveOneRequestError("MOVE_ONE_VECTOR_OUT_OF_BOUNDS", `Vector magnitude must be greater than zero and at most ${CERTIFIED_MOVE_ONE_MAX_DISPLACEMENT_FEET} feet.`);
  if (!Number.isSafeInteger(raw.elementId) || (raw.elementId as number) <= 0) throw new CertifiedMoveOneRequestError("MOVE_ONE_TARGET_INVALID", "elementId must be one positive safe integer.");
  const previewReceipt = raw.previewReceipt === undefined ? undefined : nonempty(raw.previewReceipt, "previewReceipt");
  if ((phase === "preview" && previewReceipt !== undefined) || (phase === "apply" && !previewReceipt)) {
    throw new CertifiedMoveOneRequestError("MOVE_ONE_PREVIEW_LINEAGE_INVALID", "Preview may not carry preview lineage; apply requires one runtime-issued preview receipt.");
  }
  const target = resolveCertifiedMoveTarget(raw.observationId, raw.elementId);
  let previewRecord: PreviewReceiptRecord | undefined;
  if (phase === "apply") {
    previewRecord = issuedPreviewReceipts.get(previewReceipt!);
    // Single-use is enforced before any downstream authorization or dispatch.
    // A caller must reconcile an unknown outcome instead of replaying it.
    issuedPreviewReceipts.delete(previewReceipt!);
    if (!previewRecord) throw new CertifiedMoveOneRequestError("MOVE_ONE_PREVIEW_LINEAGE_INVALID", "Apply requires one exact, locally issued, unused preview receipt.");
  }
  const request: CertifiedMoveOneRequest = {
    phase,
    documentFingerprint: target.documentFingerprint,
    documentSessionId: target.documentSessionId,
    sourceScopedId: target.sourceScopedId,
    elementId: target.elementId,
    observationId: target.observationId,
    observationBindingHash: target.observationBindingHash,
    nativeAttestationKeyId: target.nativeAttestationKeyId,
    nativeAttestationModulusBase64Url: target.nativeAttestationModulusBase64Url,
    nativeAttestationExponentBase64Url: target.nativeAttestationExponentBase64Url,
    vectorFeet: { x: vector.x as number, y: vector.y as number, z: vector.z as number },
    ...(previewRecord ? {
      previewInstanceHash: previewRecord.previewAdmission.requestInstanceHash,
      previewReceiptHash: previewRecord.receiptHash
    } : {})
  };
  const outboundBody = {
    ids: [request.elementId], mode: "vector" as const,
    vectorX: request.vectorFeet.x, vectorY: request.vectorFeet.y, vectorZ: request.vectorFeet.z,
    dryRun: request.phase === "preview", behavior: "allOrNothing" as const, moveTogether: false as const,
    options: { failOnPinned: true as const, unpinIfAllowed: false as const }
  };
  const requestInstanceHash = digest({ familyHash: CERTIFIED_MOVE_ONE_REQUEST_FAMILY_HASH, admissionSessionId, request: request as unknown as Json, outboundBody: outboundBody as unknown as Json });
  if (previewRecord) {
    if (previewRecord.previewAdmission.admissionSessionId !== admissionSessionId
      || !samePreviewLineage(previewRecord.previewAdmission.request, request)) {
      throw new CertifiedMoveOneRequestError("MOVE_ONE_PREVIEW_LINEAGE_INVALID", "Apply requires one exact, locally issued, unused preview for the same document, source, observation, target, and vector.");
    }
  }
  const admission = Object.freeze({ familyId: CERTIFIED_MOVE_ONE_REQUEST_FAMILY_V1, familyHash: CERTIFIED_MOVE_ONE_REQUEST_FAMILY_HASH, requestInstanceHash, admissionSessionId, request, outboundBody });
  admittedRequests.add(admission);
  if (previewRecord) applyPreviewLineage.set(admission, previewRecord);
  transportBindings.set(admission, Object.freeze({
    schema: "revit-operator.certified-request-family-admission.v1",
    family_id: admission.familyId,
    family_hash: admission.familyHash,
    request_instance_hash: admission.requestInstanceHash,
    admission_session_id: admission.admissionSessionId,
    phase: admission.request.phase,
    preview_instance_hash: admission.request.previewInstanceHash ?? null,
    preview_receipt: previewRecord?.token ?? null,
    preview_receipt_hash: admission.request.previewReceiptHash ?? null,
    document_fingerprint: admission.request.documentFingerprint,
    document_session_id: admission.request.documentSessionId,
    source_scoped_id: admission.request.sourceScopedId,
    element_id: admission.request.elementId,
    observation_id: admission.request.observationId,
    observation_binding_hash: admission.request.observationBindingHash,
    native_attestation_key_id: admission.request.nativeAttestationKeyId,
    native_attestation_modulus_base64url: admission.request.nativeAttestationModulusBase64Url,
    native_attestation_exponent_base64url: admission.request.nativeAttestationExponentBase64Url,
    outbound_body_sha256: rawDigest(canonical(admission.outboundBody as unknown as Json))
  }));
  return admission;
}

export function isCertifiedMoveOneAdmission(value: unknown): value is CertifiedMoveOneAdmission {
  return !!value && typeof value === "object" && admittedRequests.has(value as object);
}

/**
 * Internal transport proof boundary. Callers cannot manufacture a structurally
 * similar object that the final receipt verifier will accept.
 */
export function issueCertifiedMoveExecutionContext(input: CertifiedMoveExecutionContext): CertifiedMoveExecutionContext {
  if ((input.transportKind !== "direct" && input.transportKind !== "courier")
    || !/^(?:[0-9a-f]{32}|[0-9a-f]{64})$/.test(input.dispatchId)
    || input.correlationId !== input.dispatchId
    || typeof input.executionSessionId !== "string" || !input.executionSessionId
    || typeof input.executorId !== "string" || !input.executorId
    || !/^sha256:[0-9a-f]{64}$/.test(input.certificationEnvelopeHash)
    || (input.transportKind === "direct" && input.completionChallengeHash !== null)
    || (input.transportKind === "courier" && !/^sha256:[0-9a-f]{64}$/.test(input.completionChallengeHash ?? ""))) {
    throw new CertifiedMoveOneRequestError("MOVE_ONE_EXECUTION_CONTEXT_INVALID", "Certified execution context is incomplete or malformed.");
  }
  const context = Object.freeze({ ...input });
  issuedExecutionContexts.add(context);
  return context;
}

function policyBinding(value: unknown): PreviewPolicyBinding {
  const raw = object(value, "preview policy binding");
  exactKeys(raw, ["policyHash", "policyRecordHash", "evidenceRecordHash", "effectHash", "channel", "alias"], "preview policy binding");
  return Object.freeze({
    policyHash: sha256(raw.policyHash, "policyHash"),
    policyRecordHash: sha256(raw.policyRecordHash, "policyRecordHash"),
    evidenceRecordHash: sha256(raw.evidenceRecordHash, "evidenceRecordHash"),
    effectHash: sha256(raw.effectHash, "effectHash"),
    channel: nonempty(raw.channel, "channel"), alias: nonempty(raw.alias, "alias")
  });
}

function exactPreviewResult(value: unknown, elementId: number): void {
  const result = object(value, "preview result");
  if (result.rolledBack !== true || !Array.isArray(result.movedIds) || result.movedIds.length !== 1 || result.movedIds[0] !== elementId) {
    throw new CertifiedMoveOneRequestError("MOVE_ONE_PREVIEW_RESULT_INVALID", "Preview receipt requires exact one-element native rollback proof.");
  }
  if (!Array.isArray(result.skipped) || result.skipped.length !== 0 || !Array.isArray(result.snapshots) || result.snapshots.length !== 1) {
    throw new CertifiedMoveOneRequestError("MOVE_ONE_PREVIEW_RESULT_INVALID", "Preview receipt requires one successful snapshot and no skipped target.");
  }
  const snapshot = object(result.snapshots[0], "preview snapshot");
  if (snapshot.id !== elementId || !snapshot.before || !snapshot.after) {
    throw new CertifiedMoveOneRequestError("MOVE_ONE_PREVIEW_RESULT_INVALID", "Preview snapshot does not bind the exact moved target and before/after state.");
  }
}

const EXECUTION_RECEIPT_KEYS = [
  "schema", "phase", "request_instance_hash", "family_id", "family_hash", "document_fingerprint",
  "document_session_id", "source_scoped_id", "element_id", "observation_id", "observation_binding_hash",
  "admission_session_id", "policy_hash", "policy_record_hash", "evidence_record_hash", "effect_hash",
  "channel", "alias", "transport_kind", "dispatch_id", "correlation_id", "execution_session_id",
  "executor_id", "certification_envelope_hash", "completion_challenge_hash",
  "preview_receipt_schema", "preview_receipt_hash", "preview_instance_hash",
  "preview_admission_session_id", "preview_issued_at_utc",
  "outcome", "affected_element_ids", "outcome_unknown", "result_hash",
  "native_attestation_key_id", "native_attestation_signature"
] as const;

const CERTIFIED_MOVE_RESULT_KEYS = [
  "status", "movedIds", "skipped", "warnings", "snapshots", "movedTogether", "rolledBack",
  "certified_execution_receipt"
] as const;

function doubleBits(value: unknown, name: string): string {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new CertifiedMoveOneRequestError("MOVE_ONE_EXECUTION_ATTESTATION_INVALID", `${name} must be a finite number.`);
  }
  const buffer = Buffer.allocUnsafe(8);
  buffer.writeDoubleBE(value, 0);
  return buffer.toString("hex");
}

function certifiedMoveResultProjection(
  result: Record<string, unknown>,
  phase: Phase,
  elementId: number
): Json {
  exactKeys(
    result,
    phase === "preview" ? [...CERTIFIED_MOVE_RESULT_KEYS, "certified_preview_receipt"] : CERTIFIED_MOVE_RESULT_KEYS,
    "certified move result"
  );
  const expectedStatus = phase === "preview" ? "Dry Run" : "Moved";
  const expectedRolledBack = phase === "preview";
  if (result.status !== expectedStatus
    || result.movedTogether !== false
    || result.rolledBack !== expectedRolledBack
    || !Array.isArray(result.movedIds) || result.movedIds.length !== 1 || result.movedIds[0] !== elementId
    || !Array.isArray(result.skipped) || result.skipped.length !== 0
    || !Array.isArray(result.warnings) || result.warnings.some(item => typeof item !== "string")
    || !Array.isArray(result.snapshots) || result.snapshots.length !== 1) {
    throw new CertifiedMoveOneRequestError(
      "MOVE_ONE_EXECUTION_ATTESTATION_INVALID",
      "Native move result does not prove the exact certified one-element outcome."
    );
  }
  const snapshot = object(result.snapshots[0], "certified move snapshot");
  exactKeys(snapshot, ["id", "before", "after"], "certified move snapshot");
  if (snapshot.id !== elementId) {
    throw new CertifiedMoveOneRequestError("MOVE_ONE_EXECUTION_ATTESTATION_INVALID", "Native move snapshot does not match the certified target.");
  }
  const projectPoint = (value: unknown, name: string): Json => {
    const point = object(value, name);
    exactKeys(point, ["kind", "pointXyz"], name);
    if (point.kind !== "LocationPoint" || !Array.isArray(point.pointXyz) || point.pointXyz.length !== 3) {
      throw new CertifiedMoveOneRequestError("MOVE_ONE_EXECUTION_ATTESTATION_INVALID", `${name} must be an exact LocationPoint snapshot.`);
    }
    return {
      kind: "LocationPoint",
      point_bits: point.pointXyz.map((coordinate, index) => doubleBits(coordinate, `${name}.pointXyz[${index}]`))
    };
  };
  return {
    status: expectedStatus,
    movedIds: [elementId],
    skipped: [],
    warnings: result.warnings as string[],
    snapshots: [{
      id: elementId,
      before: projectPoint(snapshot.before, "certified move snapshot.before"),
      after: projectPoint(snapshot.after, "certified move snapshot.after")
    }],
    movedTogether: false,
    rolledBack: expectedRolledBack
  };
}

function exactApplyResult(value: unknown, elementId: number): void {
  const result = object(value, "apply result");
  if (result.status !== "Moved" || result.rolledBack !== false || result.movedTogether !== false
    || !Array.isArray(result.movedIds) || result.movedIds.length !== 1 || result.movedIds[0] !== elementId
    || !Array.isArray(result.skipped) || result.skipped.length !== 0
    || !Array.isArray(result.snapshots) || result.snapshots.length !== 1) {
    throw new CertifiedMoveOneRequestError("MOVE_ONE_APPLY_RESULT_INVALID", "Apply receipt requires one exact committed element, no skipped target, and no rollback.");
  }
  const snapshot = object(result.snapshots[0], "apply snapshot");
  if (snapshot.id !== elementId || !snapshot.before || !snapshot.after) {
    throw new CertifiedMoveOneRequestError("MOVE_ONE_APPLY_RESULT_INVALID", "Apply snapshot does not bind the exact moved target and before/after state.");
  }
}

/**
 * Final model-facing outcome boundary. The native Revit-thread receipt must
 * repeat the exact sealed admission and the policy decision used to dispatch;
 * a handler-shaped result alone is never accepted as proof of execution.
 */
export function assertCertifiedMoveExecutionReceipt(
  admission: CertifiedMoveOneAdmission,
  policyValue: unknown,
  resultValue: unknown,
  executionContext: CertifiedMoveExecutionContext
): void {
  if (!isCertifiedMoveOneAdmission(admission)) {
    throw new CertifiedMoveOneRequestError("MOVE_ONE_ADMISSION_INVALID", "Admission was not issued by this runtime.");
  }
  if (!executionContext || typeof executionContext !== "object" || !issuedExecutionContexts.has(executionContext as object)) {
    throw new CertifiedMoveOneRequestError("MOVE_ONE_EXECUTION_CONTEXT_INVALID", "Execution context was not issued by an authenticated transport boundary.");
  }
  if (admission.request.phase === "preview") exactPreviewResult(resultValue, admission.request.elementId);
  else exactApplyResult(resultValue, admission.request.elementId);

  const result = object(resultValue, "certified move result");
  const receipt = object(result.certified_execution_receipt, "certified execution receipt");
  exactKeys(receipt, EXECUTION_RECEIPT_KEYS, "certified execution receipt");
  const policy = policyBinding(policyValue);
  const expected: ReadonlyArray<readonly [unknown, unknown]> = [
    [receipt.schema, "revit-operator.certified-family-execution-receipt.v1"],
    [receipt.phase, admission.request.phase],
    [receipt.request_instance_hash, admission.requestInstanceHash],
    [receipt.family_id, admission.familyId],
    [receipt.family_hash, admission.familyHash],
    [receipt.document_fingerprint, admission.request.documentFingerprint],
    [receipt.document_session_id, admission.request.documentSessionId],
    [receipt.source_scoped_id, admission.request.sourceScopedId],
    [receipt.element_id, admission.request.elementId],
    [receipt.observation_id, admission.request.observationId],
    [receipt.observation_binding_hash, admission.request.observationBindingHash],
    [receipt.admission_session_id, admission.admissionSessionId],
    [receipt.policy_hash, policy.policyHash],
    [receipt.policy_record_hash, policy.policyRecordHash],
    [receipt.evidence_record_hash, policy.evidenceRecordHash],
    [receipt.effect_hash, policy.effectHash],
    [receipt.channel, policy.channel],
    [receipt.alias, policy.alias],
    [receipt.transport_kind, executionContext.transportKind],
    [receipt.dispatch_id, executionContext.dispatchId],
    [receipt.correlation_id, executionContext.correlationId],
    [receipt.execution_session_id, executionContext.executionSessionId],
    [receipt.executor_id, executionContext.executorId],
    [receipt.certification_envelope_hash, executionContext.certificationEnvelopeHash],
    [receipt.completion_challenge_hash, executionContext.completionChallengeHash],
    [receipt.outcome, admission.request.phase === "preview" ? "rolled_back" : "committed"],
    [receipt.outcome_unknown, false],
    [receipt.native_attestation_key_id, admission.request.nativeAttestationKeyId]
  ];
  if (expected.some(([actual, wanted]) => actual !== wanted)
    || !Array.isArray(receipt.affected_element_ids)
    || receipt.affected_element_ids.length !== 1
    || receipt.affected_element_ids[0] !== admission.request.elementId) {
    throw new CertifiedMoveOneRequestError(
      "MOVE_ONE_EXECUTION_RECEIPT_INVALID",
      "Native execution receipt does not match the exact family, request, document, target, policy, effect, channel, or outcome."
    );
  }
  if (admission.request.phase === "preview") {
    const previewReceipt = object(result.certified_preview_receipt, "native preview receipt");
    exactKeys(previewReceipt, ["schema", "preview_receipt", "preview_receipt_hash", "preview_instance_hash", "admission_session_id", "issued_at_utc"], "native preview receipt");
    const token = nonempty(previewReceipt.preview_receipt, "native preview receipt token");
    if (!/^cmpr1_[A-Za-z0-9_-]{43}$/.test(token)
      || previewReceipt.schema !== "revit-operator.certified-move-preview-receipt.v1"
      || previewReceipt.preview_receipt_hash !== rawDigest(token)
      || previewReceipt.preview_instance_hash !== admission.requestInstanceHash
      || previewReceipt.admission_session_id !== admission.admissionSessionId
      || typeof previewReceipt.issued_at_utc !== "string"
      || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(previewReceipt.issued_at_utc)
      || receipt.preview_receipt_schema !== previewReceipt.schema
      || receipt.preview_receipt_hash !== previewReceipt.preview_receipt_hash
      || receipt.preview_instance_hash !== previewReceipt.preview_instance_hash
      || receipt.preview_admission_session_id !== previewReceipt.admission_session_id
      || receipt.preview_issued_at_utc !== previewReceipt.issued_at_utc) {
      throw new CertifiedMoveOneRequestError("MOVE_ONE_EXECUTION_ATTESTATION_INVALID", "Signed execution receipt does not bind the exact native preview capability.");
    }
  } else if (receipt.preview_receipt_schema !== null
    || receipt.preview_receipt_hash !== null
    || receipt.preview_instance_hash !== null
    || receipt.preview_admission_session_id !== null
    || receipt.preview_issued_at_utc !== null
    || result.certified_preview_receipt !== undefined) {
    throw new CertifiedMoveOneRequestError("MOVE_ONE_EXECUTION_ATTESTATION_INVALID", "Apply execution receipt must not mint or claim preview lineage.");
  }
  if (receipt.result_hash !== rawDigest(canonical(certifiedMoveResultProjection(result, admission.request.phase, admission.request.elementId)))
    || typeof receipt.native_attestation_signature !== "string"
    || !/^[A-Za-z0-9_-]+$/.test(receipt.native_attestation_signature)) {
    throw new CertifiedMoveOneRequestError("MOVE_ONE_EXECUTION_ATTESTATION_INVALID", "Native execution result attestation is invalid.");
  }
  const { native_attestation_signature: _signature, ...signedReceipt } = receipt;
  try {
    const key = createPublicKey({
      key: {
        kty: "RSA",
        alg: "RS256",
        n: admission.request.nativeAttestationModulusBase64Url,
        e: admission.request.nativeAttestationExponentBase64Url
      },
      format: "jwk"
    });
    if (!verify(
      "sha256",
      Buffer.from(canonical(signedReceipt as unknown as Json), "utf8"),
      key,
      Buffer.from(receipt.native_attestation_signature, "base64url")
    )) throw new Error("signature mismatch");
  } catch {
    throw new CertifiedMoveOneRequestError(
      "MOVE_ONE_EXECUTION_ATTESTATION_INVALID",
      "Execution receipt was not signed by the exact native authority observed for this request."
    );
  }
}

/** Retains the native-issued, single-use receipt only after rollback proof. */
export function issueCertifiedMovePreviewReceipt(admission: CertifiedMoveOneAdmission, policyValue: unknown, result: unknown): string {
  if (!isCertifiedMoveOneAdmission(admission) || admission.request.phase !== "preview") {
    throw new CertifiedMoveOneRequestError("MOVE_ONE_PREVIEW_RESULT_INVALID", "Only an admitted preview may issue lineage.");
  }
  exactPreviewResult(result, admission.request.elementId);
  const resultObject = object(result, "preview result");
  const receipt = object(resultObject.certified_preview_receipt, "native preview receipt");
  exactKeys(receipt, ["schema", "preview_receipt", "preview_receipt_hash", "preview_instance_hash", "admission_session_id", "issued_at_utc"], "native preview receipt");
  if (receipt.schema !== "revit-operator.certified-move-preview-receipt.v1") {
    throw new CertifiedMoveOneRequestError("MOVE_ONE_PREVIEW_RESULT_INVALID", "Native preview receipt schema is invalid.");
  }
  const token = nonempty(receipt.preview_receipt, "native preview receipt token");
  if (!/^cmpr1_[A-Za-z0-9_-]{43}$/.test(token)) throw new CertifiedMoveOneRequestError("MOVE_ONE_PREVIEW_RESULT_INVALID", "Native preview receipt token is invalid.");
  const receiptHash = sha256(receipt.preview_receipt_hash, "native preview receipt hash");
  if (receiptHash !== rawDigest(token)
    || receipt.preview_instance_hash !== admission.requestInstanceHash
    || receipt.admission_session_id !== admissionSessionId
    || typeof receipt.issued_at_utc !== "string"
    || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(receipt.issued_at_utc)) {
    throw new CertifiedMoveOneRequestError("MOVE_ONE_PREVIEW_RESULT_INVALID", "Native preview receipt does not bind the exact admitted preview.");
  }
  issuedPreviewReceipts.set(token, Object.freeze({ lane: "production", previewAdmission: admission, token, receiptHash, policy: policyBinding(policyValue) }));
  return token;
}

/**
 * Internal bridge for the evidence-only wrapper. The wrapper verifies the full
 * native-signed preview receipt before registering this lineage. Production
 * authorization rejects this distinct lane below.
 */
export function registerLaboratoryMovePreviewLineage(
  admission: CertifiedMoveOneAdmission,
  receiptJson: string,
  receiptHash: string,
  env: NodeJS.ProcessEnv = process.env
): string {
  if (env.REVIT_OPERATOR_MODE !== "development"
    || env.OPERATOR_TOOL_EXPOSURE_PROFILE !== "laboratory"
    || env.OPERATOR_CERTIFICATION_PROTECTED_LABORATORY !== "1"
    || !isCertifiedMoveOneAdmission(admission)
    || admission.request.phase !== "preview"
    || typeof receiptJson !== "string"
    || !/^sha256:[0-9a-f]{64}$/.test(receiptHash)
    || rawDigest(receiptJson) !== receiptHash) {
    throw new CertifiedMoveOneRequestError("MOVE_ONE_PREVIEW_RESULT_INVALID", "Laboratory preview lineage registration is invalid.");
  }
  const token = `lmepr1_${randomBytes(32).toString("base64url")}`;
  issuedPreviewReceipts.set(token, Object.freeze({
    lane: "laboratory_evidence",
    previewAdmission: admission,
    token,
    receiptHash,
    receiptJson
  }));
  return token;
}

export function readLaboratoryMovePreviewLineage(admission: CertifiedMoveOneAdmission): Readonly<{
  previewRequestInstanceHash: string;
  previewExecutionReceiptSha256: string;
  previewExecutionReceiptJson: string;
}> | null {
  if (!isCertifiedMoveOneAdmission(admission)) throw new CertifiedMoveOneRequestError("MOVE_ONE_ADMISSION_INVALID", "Admission was not issued by this runtime.");
  if (admission.request.phase === "preview") return null;
  const prior = applyPreviewLineage.get(admission);
  if (!prior || prior.lane !== "laboratory_evidence") {
    throw new CertifiedMoveOneRequestError("MOVE_ONE_PREVIEW_LINEAGE_INVALID", "Apply requires exact laboratory evidence preview lineage.");
  }
  return Object.freeze({
    previewRequestInstanceHash: prior.previewAdmission.requestInstanceHash,
    previewExecutionReceiptSha256: prior.receiptHash,
    previewExecutionReceiptJson: prior.receiptJson
  });
}

/** Apply is denied if policy/effect/channel/alias rotated after the preview. */
export function assertCertifiedMoveApplyPolicyLineage(admission: CertifiedMoveOneAdmission, policyValue: unknown): void {
  if (!isCertifiedMoveOneAdmission(admission)) throw new CertifiedMoveOneRequestError("MOVE_ONE_ADMISSION_INVALID", "Admission was not issued by this runtime.");
  if (admission.request.phase !== "apply") return;
  const prior = applyPreviewLineage.get(admission);
  if (!prior) throw new CertifiedMoveOneRequestError("MOVE_ONE_PREVIEW_LINEAGE_INVALID", "Apply preview lineage is unavailable.");
  if (prior.lane !== "production") {
    throw new CertifiedMoveOneRequestError("MOVE_ONE_PREVIEW_LINEAGE_INVALID", "Laboratory evidence lineage cannot authorize production execution.");
  }
  const current = policyBinding(policyValue);
  // Preview and apply deliberately use distinct policy records/effect hashes.
  // The policy set, family lineage, channel, and alias must remain unchanged;
  // the current apply record is independently authorized at this call.
  for (const key of ["policyHash", "channel", "alias"] as const) {
    if (prior.policy[key] !== current[key]) throw new CertifiedMoveOneRequestError("MOVE_ONE_PREVIEW_LINEAGE_STALE", `Preview authorization changed at ${key}.`);
  }
}

/** Brand-checked serialization boundary for direct and courier transports. */
export function readCertifiedMoveOneTransportBinding(admission: CertifiedMoveOneAdmission): CertifiedMoveOneTransportBinding {
  if (!isCertifiedMoveOneAdmission(admission)) throw new CertifiedMoveOneRequestError("MOVE_ONE_ADMISSION_INVALID", "Admission was not issued by this runtime.");
  const binding = transportBindings.get(admission);
  if (!binding) throw new CertifiedMoveOneRequestError("MOVE_ONE_ADMISSION_INVALID", "Admission transport binding is unavailable.");
  return binding;
}
