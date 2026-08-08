import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import {
  admitCertifiedMoveOneRequest,
  CERTIFIED_MOVE_ONE_REQUEST_FAMILY_HASH,
  CERTIFIED_MOVE_ONE_REQUEST_FAMILY_V1,
  issueCertifiedMovePreviewReceipt
} from "./certifiedMoveOneRequestFamily.js";
import {
  assertIssuedFamilyEnvelopeForDispatch,
  createCertificationEnvelope
} from "./certifiedExecutionEnvelope.js";
import { canonicalToolExposureJson, type ToolExposureDecision } from "./toolExposurePolicy.js";
import { clearCertifiedMoveTargetLedgerForTests, registerCertifiedSpatialObservation } from "./certifiedMoveTargetLedger.js";
import { TEST_NATIVE_EXECUTION_ATTESTATION } from "./certifiedMoveNativeAttestation.testSupport.js";
import { protectNativeTransportRequest } from "./nativeTransport.js";

const hash = (character: string): string => `sha256:${character.repeat(64)}`;

function admittedPreview() {
  clearCertifiedMoveTargetLedgerForTests();
  registerCertifiedSpatialObservation(
    { document: { sessionId: "123e4567e89b42d3a456426614174000", nativeExecutionAttestation: TEST_NATIVE_EXECUTION_ATTESTATION, projectIdentity: { fingerprint: "a".repeat(64) }, activeView: { id: 42 } } },
    { observationId: "frame_01", viewId: 42, items: [{ elementId: 4821, sourceScopedId: "host:4821", groundingStatus: "anchored", pinned: false, groupId: null, groupIdReadSucceeded: true, orientation: { locationKind: "point", locationPoint: { x: 1, y: 2, z: 3 } } }] }
  );
  return admitCertifiedMoveOneRequest({
    phase: "preview",
    elementId: 4821,
    observationId: "frame_01",
    vectorFeet: { x: 1, y: 0, z: 0 },
    previewReceipt: undefined
  });
}

function certifiedDecision(requestHash: string): ToolExposureDecision {
  return {
    allowed: true,
    mode: "certified",
    runtimeMode: "production",
    method: "POST",
    path: "/revit/move-elements",
    channel: "typed_mcp",
    requestHash,
    effectHash: hash("b"),
    knownRoute: true,
    reasonCodes: ["CERTIFIED_TYPED_MCP_EXPOSED"],
    policyHash: hash("c"),
    policyRecordHash: hash("d"),
    evidenceRecordHash: hash("e"),
    requestFamily: {
      schema: "revit-operator.certified-request-family.v1",
      id: CERTIFIED_MOVE_ONE_REQUEST_FAMILY_V1,
      validator_hash: CERTIFIED_MOVE_ONE_REQUEST_FAMILY_HASH
    },
    requestInstanceHash: requestHash,
    policyTrustSource: "bundled",
    alias: "revit_move_one_certified"
  };
}

test("family envelope is issued only from an opaque validator admission and binds the exact direct/courier bytes", () => {
  const admission = admittedPreview();
  const bodyJson = canonicalToolExposureJson(admission.outboundBody);
  const envelope = createCertificationEnvelope({
    decision: certifiedDecision(admission.requestInstanceHash),
    bodyPresent: true,
    bodyJson,
    certifiedMoveOneAdmission: admission
  });
  assert.equal(envelope.version, 2);
  if (envelope.version !== 2) assert.fail("expected request-family envelope");
  assert.equal(envelope.request_family_admission.request_instance_hash, admission.requestInstanceHash);
  assert.equal(envelope.request_family_admission.document_session_id, "123e4567e89b42d3a456426614174000");
  assert.match(envelope.request_family_admission.admission_session_id, /^[0-9a-f]{32}$/);
  assert.equal(envelope.request_family_admission.preview_receipt, null);
  assert.equal(envelope.request_family_admission.outbound_body_sha256, envelope.body_sha256);
  assert.equal(assertIssuedFamilyEnvelopeForDispatch({
    envelope,
    method: "POST",
    path: "/revit/move-elements",
    bodyJson,
    channel: "typed_mcp",
    alias: "revit_move_one_certified"
  }), envelope);
  const protectedRequest = protectNativeTransportRequest({
    operatorToken: "0123456789abcdef0123456789abcdef",
    serverEpoch: Buffer.alloc(32, 7).toString("base64url"),
    method: "POST",
    path: "/revit/move-elements",
    bodyJson,
    channel: "typed_mcp",
    alias: "revit_move_one_certified",
    certificationEnvelope: envelope,
    issuedAtUnixMs: 1_700_000_000_000,
    requestId: "0123456789abcdef0123456789abcdef",
    requestNonce: Buffer.alloc(32, 8),
    iv: Buffer.alloc(16, 9)
  });
  assert.match(protectedRequest.envelopeJson, /^\{"v":"revit-operator\.native-transport\.v1"/);
  assert.throws(() => assertIssuedFamilyEnvelopeForDispatch({
    envelope: { ...envelope },
    method: "POST",
    path: "/revit/move-elements",
    bodyJson,
    channel: "typed_mcp",
    alias: "revit_move_one_certified"
  }), /locally issued/);
  assert.throws(() => protectNativeTransportRequest({
    operatorToken: "0123456789abcdef0123456789abcdef",
    serverEpoch: Buffer.alloc(32, 7).toString("base64url"),
    method: "POST", path: "/revit/move-elements", bodyJson,
    channel: "typed_mcp", alias: "revit_move_one_certified",
    certificationEnvelope: { ...envelope }
  }), /request-family admission is invalid/);
  assert.throws(() => assertIssuedFamilyEnvelopeForDispatch({
    envelope,
    method: "POST",
    path: "/revit/move-elements",
    bodyJson: canonicalToolExposureJson({ ...admission.outboundBody, dryRun: false }),
    channel: "typed_mcp",
    alias: "revit_move_one_certified"
  }), /exact request boundary/);
  assert.throws(() => createCertificationEnvelope({
    decision: certifiedDecision(admission.requestInstanceHash),
    bodyPresent: true,
    bodyJson,
    certifiedMoveOneAdmission: { ...admission }
  }), /validator-issued/);
});

test("apply envelope carries native-issued preview lineage without exposing a caller-authored serialization path", () => {
  const preview = admittedPreview();
  const token = `cmpr1_${"A".repeat(43)}`;
  const tokenHash = `sha256:${createHash("sha256").update(token, "utf8").digest("hex")}`;
  const policy = {
    policyHash: hash("c"), policyRecordHash: hash("d"), evidenceRecordHash: hash("e"), effectHash: hash("b"),
    channel: "typed_mcp", alias: "revit_move_one_certified"
  };
  const issued = issueCertifiedMovePreviewReceipt(preview, policy, {
    rolledBack: true,
    movedIds: [4821],
    skipped: [],
    snapshots: [{ id: 4821, before: { x: 0 }, after: { x: 1 } }],
    certified_preview_receipt: {
      schema: "revit-operator.certified-move-preview-receipt.v1",
      preview_receipt: token,
      preview_receipt_hash: tokenHash,
      preview_instance_hash: preview.requestInstanceHash,
      admission_session_id: preview.admissionSessionId,
      issued_at_utc: "2035-01-02T03:04:05.006Z"
    }
  });
  assert.equal(issued, token);
  const apply = admitCertifiedMoveOneRequest({
    phase: "apply", elementId: 4821, observationId: "frame_01",
    vectorFeet: { x: 1, y: 0, z: 0 }, previewReceipt: token
  });
  const bodyJson = canonicalToolExposureJson(apply.outboundBody);
  const envelope = createCertificationEnvelope({
    decision: certifiedDecision(apply.requestInstanceHash),
    bodyPresent: true,
    bodyJson,
    certifiedMoveOneAdmission: apply
  });
  if (envelope.version !== 2) assert.fail("expected request-family envelope");
  assert.equal(envelope.request_family_admission.preview_instance_hash, preview.requestInstanceHash);
  assert.equal(envelope.request_family_admission.preview_receipt, token);
  assert.equal(envelope.request_family_admission.preview_receipt_hash, tokenHash);
  assert.throws(() => admitCertifiedMoveOneRequest({
    phase: "apply", elementId: 4821, observationId: "frame_01",
    vectorFeet: { x: 1, y: 0, z: 0 }, previewReceipt: token
  }), /PREVIEW_LINEAGE_INVALID/);
});
