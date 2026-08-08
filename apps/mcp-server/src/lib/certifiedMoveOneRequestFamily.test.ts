import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import {
  admitCertifiedMoveOneRequest,
  assertCertifiedMoveExecutionReceipt,
  assertCertifiedMoveApplyPolicyLineage,
  CERTIFIED_MOVE_ONE_REQUEST_FAMILY_HASH,
  CertifiedMoveOneRequestError,
  issueCertifiedMoveExecutionContext,
  issueCertifiedMovePreviewReceipt,
  readCertifiedMoveOneTransportBinding
} from "./certifiedMoveOneRequestFamily.js";
import { clearCertifiedMoveTargetLedgerForTests, registerCertifiedSpatialObservation } from "./certifiedMoveTargetLedger.js";
import { canonicalTestCertifiedMoveResult, signTestNativeReceipt, TEST_NATIVE_EXECUTION_ATTESTATION } from "./certifiedMoveNativeAttestation.testSupport.js";

const elementId = 4821;
const observationId = "frame_01";
const sessionId = "123e4567e89b42d3a456426614174000";
const base = { phase: "preview", elementId, observationId, vectorFeet: { x: 2, y: 0, z: 0 }, previewReceipt: undefined };
const policy = {
  policyHash: `sha256:${"1".repeat(64)}`,
  policyRecordHash: `sha256:${"2".repeat(64)}`,
  evidenceRecordHash: `sha256:${"3".repeat(64)}`,
  effectHash: `sha256:${"4".repeat(64)}`,
  channel: "typed_mcp",
  alias: "revit_move_one_certified"
};

function issueTarget(): void {
  clearCertifiedMoveTargetLedgerForTests();
  registerCertifiedSpatialObservation(
    { document: { sessionId, nativeExecutionAttestation: TEST_NATIVE_EXECUTION_ATTESTATION, projectIdentity: { fingerprint: "a".repeat(64) }, activeView: { id: 42 } } },
    { observationId, viewId: 42, items: [{ elementId, sourceScopedId: `host:${elementId}`, groundingStatus: "anchored", pinned: false, groupId: null, orientation: { locationKind: "point", locationPoint: { x: 1, y: 2, z: 3 } } }] }
  );
}

function nativePreviewResult(preview: ReturnType<typeof admitCertifiedMoveOneRequest>, token = `cmpr1_${"A".repeat(43)}`): Record<string, unknown> {
  const nativeResult = {
    status: "Dry Run", rolledBack: true, movedIds: [elementId], skipped: [], warnings: [],
    snapshots: [{ id: elementId, before: { kind: "LocationPoint", pointXyz: [0, 0, 0] }, after: { kind: "LocationPoint", pointXyz: [2, 0, 0] } }], movedTogether: false
  };
  const previewReceipt = {
      schema: "revit-operator.certified-move-preview-receipt.v1",
      preview_receipt: token,
      preview_receipt_hash: `sha256:${createHash("sha256").update(token, "utf8").digest("hex")}`,
      preview_instance_hash: preview.requestInstanceHash,
      admission_session_id: preview.admissionSessionId,
      issued_at_utc: "2035-01-02T03:04:05.006Z"
  };
  return {
    ...nativeResult,
    certified_preview_receipt: previewReceipt,
    certified_execution_receipt: executionReceipt(preview, "rolled_back", nativeResult, previewReceipt)
  };
}

const directContext = issueCertifiedMoveExecutionContext({
  transportKind: "direct",
  dispatchId: "d".repeat(32),
  correlationId: "d".repeat(32),
  executionSessionId: "test-admission-session",
  executorId: TEST_NATIVE_EXECUTION_ATTESTATION.key_id,
  certificationEnvelopeHash: `sha256:${"8".repeat(64)}`,
  completionChallengeHash: null
});

function executionReceipt(
  admission: ReturnType<typeof admitCertifiedMoveOneRequest>,
  outcome: "rolled_back" | "committed",
  nativeResult: Record<string, unknown>,
  previewReceipt?: Record<string, unknown>
): Record<string, unknown> {
  const receipt: Record<string, unknown> = {
    schema: "revit-operator.certified-family-execution-receipt.v1",
    phase: admission.request.phase,
    request_instance_hash: admission.requestInstanceHash,
    family_id: admission.familyId,
    family_hash: admission.familyHash,
    document_fingerprint: admission.request.documentFingerprint,
    document_session_id: admission.request.documentSessionId,
    source_scoped_id: admission.request.sourceScopedId,
    element_id: admission.request.elementId,
    observation_id: admission.request.observationId,
    observation_binding_hash: admission.request.observationBindingHash,
    admission_session_id: admission.admissionSessionId,
    policy_hash: policy.policyHash,
    policy_record_hash: policy.policyRecordHash,
    evidence_record_hash: policy.evidenceRecordHash,
    effect_hash: policy.effectHash,
    channel: policy.channel,
    alias: policy.alias,
    transport_kind: directContext.transportKind,
    dispatch_id: directContext.dispatchId,
    correlation_id: directContext.correlationId,
    execution_session_id: directContext.executionSessionId,
    executor_id: directContext.executorId,
    certification_envelope_hash: directContext.certificationEnvelopeHash,
    completion_challenge_hash: directContext.completionChallengeHash,
    preview_receipt_schema: previewReceipt?.schema ?? null,
    preview_receipt_hash: previewReceipt?.preview_receipt_hash ?? null,
    preview_instance_hash: previewReceipt?.preview_instance_hash ?? null,
    preview_admission_session_id: previewReceipt?.admission_session_id ?? null,
    preview_issued_at_utc: previewReceipt?.issued_at_utc ?? null,
    outcome,
    affected_element_ids: [admission.request.elementId],
    outcome_unknown: false,
    result_hash: `sha256:${createHash("sha256").update(canonicalTestCertifiedMoveResult(nativeResult), "utf8").digest("hex")}`,
    native_attestation_key_id: TEST_NATIVE_EXECUTION_ATTESTATION.key_id
  };
  receipt.native_attestation_signature = signTestNativeReceipt(receipt);
  return receipt;
}

test("one-element profile derives target identity from the observation ledger and produces the exact rollback body", () => {
  issueTarget();
  const admitted = admitCertifiedMoveOneRequest(base);
  assert.equal(admitted.familyHash, CERTIFIED_MOVE_ONE_REQUEST_FAMILY_HASH);
  assert.equal(admitted.request.documentSessionId, sessionId);
  assert.equal(admitted.request.sourceScopedId, `host:${elementId}`);
  assert.deepEqual(admitted.outboundBody, { ids: [elementId], mode: "vector", vectorX: 2, vectorY: 0, vectorZ: 0, dryRun: true, behavior: "allOrNothing", moveTogether: false, options: { failOnPinned: true, unpinIfAllowed: false } });
  assert.equal(readCertifiedMoveOneTransportBinding(admitted).preview_receipt, null);
});

test("apply requires a native rollback receipt, consumes it once, and binds exact policy lineage", () => {
  issueTarget();
  assert.throws(() => admitCertifiedMoveOneRequest({ ...base, phase: "apply" }), (error: unknown) => error instanceof CertifiedMoveOneRequestError && error.code === "MOVE_ONE_PREVIEW_LINEAGE_INVALID");
  const preview = admitCertifiedMoveOneRequest(base);
  const receipt = issueCertifiedMovePreviewReceipt(preview, policy, nativePreviewResult(preview));
  const apply = admitCertifiedMoveOneRequest({ ...base, phase: "apply", previewReceipt: receipt });
  assert.equal(apply.outboundBody.dryRun, false);
  assert.equal(apply.request.previewInstanceHash, preview.requestInstanceHash);
  assert.equal(readCertifiedMoveOneTransportBinding(apply).preview_receipt, receipt);
  assert.doesNotThrow(() => assertCertifiedMoveApplyPolicyLineage(apply, policy));
  assert.throws(() => assertCertifiedMoveApplyPolicyLineage(apply, { ...policy, policyHash: `sha256:${"9".repeat(64)}` }), /PREVIEW_LINEAGE_STALE/);
  assert.throws(() => admitCertifiedMoveOneRequest({ ...base, phase: "apply", previewReceipt: receipt }), /PREVIEW_LINEAGE_INVALID/);
});

test("preview receipt issuance rejects caller tokens and incomplete rollback proof", () => {
  issueTarget();
  const preview = admitCertifiedMoveOneRequest(base);
  assert.throws(() => issueCertifiedMovePreviewReceipt(preview, policy, { ...nativePreviewResult(preview), rolledBack: false }), /PREVIEW_RESULT_INVALID/);
  assert.throws(() => issueCertifiedMovePreviewReceipt(preview, policy, { ...nativePreviewResult(preview), movedIds: [999] }), /PREVIEW_RESULT_INVALID/);
  const forged = nativePreviewResult(preview) as any;
  forged.certified_preview_receipt.preview_receipt_hash = `sha256:${"0".repeat(64)}`;
  assert.throws(() => issueCertifiedMovePreviewReceipt(preview, policy, forged), /PREVIEW_RESULT_INVALID/);
});

test("final wrapper accepts only the exact native execution receipt", () => {
  issueTarget();
  const preview = admitCertifiedMoveOneRequest(base);
  const result = nativePreviewResult(preview);
  assert.doesNotThrow(() => assertCertifiedMoveExecutionReceipt(preview, policy, result, directContext));
  assert.throws(() => assertCertifiedMoveExecutionReceipt(preview, policy, {
    ...result,
    certified_execution_receipt: { ...(result.certified_execution_receipt as object), effect_hash: `sha256:${"9".repeat(64)}` }
  }, directContext), /EXECUTION_RECEIPT_INVALID/);
  assert.throws(() => assertCertifiedMoveExecutionReceipt(preview, policy, {
    ...result,
    certified_execution_receipt: undefined
  }, directContext), /REQUEST_INVALID/);
  assert.throws(() => assertCertifiedMoveExecutionReceipt(preview, policy, {
    ...result,
    certified_preview_receipt: {
      ...(result.certified_preview_receipt as object),
      preview_receipt: `cmpr1_${"B".repeat(43)}`
    }
  }, directContext), /ATTESTATION_INVALID/);
  const courierContext = issueCertifiedMoveExecutionContext({
    transportKind: "courier",
    dispatchId: "e".repeat(64),
    correlationId: "e".repeat(64),
    executionSessionId: "courier-session",
    executorId: "courier-executor",
    certificationEnvelopeHash: `sha256:${"8".repeat(64)}`,
    completionChallengeHash: `sha256:${"7".repeat(64)}`
  });
  assert.throws(() => assertCertifiedMoveExecutionReceipt(preview, policy, result, courierContext), /EXECUTION_RECEIPT_INVALID/);
});

test("profile rejects unobserved targets, broadened vectors, and option injection", () => {
  clearCertifiedMoveTargetLedgerForTests();
  assert.throws(() => admitCertifiedMoveOneRequest(base), /not issued/);
  issueTarget();
  assert.throws(() => admitCertifiedMoveOneRequest({ ...base, elementId: 0 }), /positive safe integer/);
  assert.throws(() => admitCertifiedMoveOneRequest({ ...base, vectorFeet: { x: 2.01, y: 0, z: 0 } }), /VECTOR_OUT_OF_BOUNDS/);
  assert.throws(() => admitCertifiedMoveOneRequest({ ...base, ids: [elementId, elementId + 1] }), /REQUEST_INVALID/);
});
