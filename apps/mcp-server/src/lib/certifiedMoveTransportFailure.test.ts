import assert from "node:assert/strict";
import test from "node:test";
import { RevitBridgeCallError } from "./revitClient.js";
import { RevitCourierError } from "./revitCourier.js";
import { certifiedMovePostDispatchVerificationFailurePayload, certifiedMoveTransportFailurePayload } from "./certifiedMoveTransportFailure.js";

const hash = (character: string) => `sha256:${character.repeat(64)}`;
const binding = {
  requestInstanceHash: hash("a"), phase: "apply" as const,
  familyId: "revit-operator.certified-move-one.request-family.v1", familyHash: hash("b"),
  admissionSessionId: "1".repeat(32), documentFingerprint: hash("c"), documentSessionId: "2".repeat(32),
  sourceScopedId: "host:4821", elementId: 4821, observationId: "frame-1", observationBindingHash: hash("d"),
  nativeAttestationKeyId: hash("e"), previewInstanceHash: hash("f"), previewReceiptHash: hash("0"),
  policyHash: hash("1"), policyRecordHash: hash("2"), evidenceRecordHash: hash("3"), effectHash: hash("4"),
  outboundBodySha256: hash("5"),
  channel: "typed_mcp", alias: "revit_move_one_certified"
};

test("certified move transport failure preserves direct unknown-outcome truth", () => {
  const error = new RevitBridgeCallError({
    code: "revit_bridge_invalid_response",
    message: "response lost after dispatch",
    retryable: true,
    outcomeUnknown: true,
    method: "POST",
    path: "/revit/move-elements",
    correlationId: "9".repeat(32)
  });
  const payload = certifiedMoveTransportFailurePayload(error, binding)!;
  assert.equal(payload.code, "revit_bridge_invalid_response");
  assert.equal(payload.dispatch_id, "9".repeat(32));
  assert.equal(payload.correlation_id, "9".repeat(32));
  assert.equal(payload.outcome_unknown, true);
  assert.equal(payload.retryable, false);
  assert.equal(payload.reconciliation_required, true);
  assert.deepEqual(payload.certification_binding, {
    family_id: binding.familyId, family_hash: binding.familyHash, request_instance_hash: binding.requestInstanceHash,
    admission_session_id: binding.admissionSessionId, document_fingerprint: binding.documentFingerprint,
    document_session_id: binding.documentSessionId, source_scoped_id: binding.sourceScopedId, element_id: binding.elementId,
    observation_id: binding.observationId, observation_binding_hash: binding.observationBindingHash,
    native_attestation_key_id: binding.nativeAttestationKeyId, preview_instance_hash: binding.previewInstanceHash,
    preview_receipt_hash: binding.previewReceiptHash, policy_hash: binding.policyHash,
    policy_record_hash: binding.policyRecordHash, evidence_record_hash: binding.evidenceRecordHash,
    effect_hash: binding.effectHash, outbound_body_sha256: binding.outboundBodySha256,
    channel: binding.channel, alias: binding.alias
  });
});

test("certified move transport failure preserves courier classification and rejects ordinary errors", () => {
  const error = new RevitCourierError({
    code: "courier_execution_failed",
    message: "known pre-dispatch refusal",
    retryable: true,
    outcomeUnknown: false,
    jobId: "b".repeat(64)
  });
  const payload = certifiedMoveTransportFailurePayload(error, binding)!;
  assert.equal(payload.retryable, true);
  assert.equal(payload.outcome_unknown, false);
  assert.equal(payload.dispatch_id, "b".repeat(64));
  assert.equal(certifiedMoveTransportFailurePayload(new Error("ordinary"), binding), null);
});

test("certified move receipt-verification failure preserves exact dispatch and sealed binding", () => {
  const payload = certifiedMovePostDispatchVerificationFailurePayload(
    new Error("signed receipt projection mismatch"),
    binding,
    { dispatchId: "6".repeat(32), correlationId: "6".repeat(32) }
  );
  assert.equal(payload.dispatch_id, "6".repeat(32));
  assert.equal(payload.correlation_id, "6".repeat(32));
  assert.equal(payload.outcome_unknown, true);
  assert.equal(payload.retryable, false);
  assert.equal((payload.certification_binding as Record<string, unknown>).policy_hash, binding.policyHash);
  assert.equal((payload.certification_binding as Record<string, unknown>).preview_receipt_hash, binding.previewReceiptHash);
});

test("certified move preview receipt-verification failure is unknown and non-retryable", () => {
  const previewBinding = {
    ...binding,
    phase: "preview" as const,
    previewInstanceHash: null,
    previewReceiptHash: null
  };
  const payload = certifiedMovePostDispatchVerificationFailurePayload(
    new Error("rollback receipt projection mismatch"),
    previewBinding,
    { dispatchId: "7".repeat(32), correlationId: "7".repeat(32) }
  );
  assert.equal(payload.request_phase, "preview");
  assert.equal(payload.dispatch_id, "7".repeat(32));
  assert.equal(payload.outcome_unknown, true);
  assert.equal(payload.retryable, false);
  assert.equal(payload.reconciliation_required, true);
  assert.equal((payload.certification_binding as Record<string, unknown>).preview_instance_hash, null);
  assert.equal((payload.certification_binding as Record<string, unknown>).preview_receipt_hash, null);
});
