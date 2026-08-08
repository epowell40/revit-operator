import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { clearCertifiedMoveTargetLedgerForTests, registerCertifiedSpatialObservation } from "./certifiedMoveTargetLedger.js";
import { canonicalTestNativeJson, signTestNativeReceipt, TEST_NATIVE_EXECUTION_ATTESTATION } from "./certifiedMoveNativeAttestation.testSupport.js";
import { issueLaboratoryEvidenceDispatch } from "./laboratoryEvidenceDispatch.js";
import {
  admitLaboratoryMoveEvidenceRequest,
  consumeLaboratoryMoveEvidenceAdmission as consumeLaboratoryMoveEvidenceAdmissionRaw,
  issueLaboratoryMovePreviewLineage,
  LABORATORY_MOVE_APPLY_EFFECT_HASH,
  LABORATORY_MOVE_PREVIEW_EFFECT_HASH
} from "./laboratoryMoveEvidence.js";
import { canonicalToolExposureJson } from "./toolExposurePolicy.js";

const env = {
  REVIT_OPERATOR_MODE: "development",
  OPERATOR_TOOL_EXPOSURE_PROFILE: "laboratory",
  OPERATOR_CERTIFICATION_PROTECTED_LABORATORY: "1"
};
const elementId = 4821;
const observationId = "frame_01";
function consumeLaboratoryMoveEvidenceAdmission(input: Omit<Parameters<typeof consumeLaboratoryMoveEvidenceAdmissionRaw>[0], "policy">, environment = env) {
  const effectHash = input.admission.request.request.phase === "preview" ? LABORATORY_MOVE_PREVIEW_EFFECT_HASH : LABORATORY_MOVE_APPLY_EFFECT_HASH;
  return consumeLaboratoryMoveEvidenceAdmissionRaw({ ...input, policy: {
    policyHash: `sha256:${"1".repeat(64)}`, policyRecordHash: `sha256:${"2".repeat(64)}`,
    evidenceRecordHash: `sha256:${"3".repeat(64)}`, effectHash
  } }, environment);
}

function target(): void {
  clearCertifiedMoveTargetLedgerForTests();
  registerCertifiedSpatialObservation(
    { document: { sessionId: "123e4567e89b42d3a456426614174000", nativeExecutionAttestation: TEST_NATIVE_EXECUTION_ATTESTATION, projectIdentity: { fingerprint: "a".repeat(64) }, activeView: { id: 42 } } },
    { observationId, viewId: 42, items: [{ elementId, sourceScopedId: `host:${elementId}`, groundingStatus: "anchored", pinned: false, groupId: null, groupIdReadSucceeded: true, orientation: { locationKind: "point", locationPoint: { x: 1, y: 2, z: 3 } } }] }
  );
}

function signedPreviewResult(admission: ReturnType<typeof previewAdmission>, dto: ReturnType<typeof consumeLaboratoryMoveEvidenceAdmission>) {
  const hash = (value: string) => `sha256:${createHash("sha256").update(value, "utf8").digest("hex")}`;
  const projection = {
    admission_hash: dto.laboratory_move_evidence_admission_hash,
    run_nonce: dto.run_nonce,
    request_family_id: dto.request_family_id, request_family_hash: dto.request_family_hash,
    request_instance_hash: dto.request_instance_hash, admission_session_id: dto.admission_session_id,
    phase: dto.phase, effect_id: dto.effect_id, effect_hash: dto.effect_hash,
    policy_hash: dto.policy_hash, policy_record_hash: dto.policy_record_hash, evidence_record_hash: dto.evidence_record_hash,
    outbound_body_sha256: dto.outbound_body_sha256, document_fingerprint: dto.document_fingerprint,
    document_session_id: dto.document_session_id, source_scoped_id: dto.source_scoped_id,
    element_id: dto.element_id, observation_id: dto.observation_id, observation_binding_hash: dto.observation_binding_hash,
    native_attestation_key_id: dto.native_attestation_key_id,
    native_attestation_modulus_base64url: dto.native_attestation_modulus_base64url,
    native_attestation_exponent_base64url: dto.native_attestation_exponent_base64url,
    channel: dto.channel, alias: dto.alias, preview_lineage_receipt_hash: null
  };
  const laboratoryEvidence = {
    schema: "revit-operator.laboratory-evidence-dispatch.v2", candidate_source_hash: dto.candidate_source_hash,
    policy_hash: dto.policy_hash, policy_record_hash: dto.policy_record_hash, evidence_record_hash: dto.evidence_record_hash, effect_hash: dto.effect_hash,
    evidence_run_id: dto.evidence_run_id, evidence_step: "move-preview", transport_kind: "direct",
    job_id: null, correlation_id: null, workflow: "epic-0437-l4-move-preview", channel: dto.channel,
    alias: dto.alias, production_certified: false
  };
  const nativeResult = {
    status: "Dry Run", rolledBack: true, movedIds: [elementId], skipped: [], warnings: [], movedTogether: false,
    snapshots: [{ id: elementId, before: { kind: "LocationPoint", pointXyz: [1, 2, 3] }, after: { kind: "LocationPoint", pointXyz: [1.25, 2, 3] } }]
  };
  const receipt: Record<string, unknown> = {
    schema: "revit-operator.laboratory-execution-receipt.v1",
    request_id: "d".repeat(32), dispatch_id: "d".repeat(32), transport_request_nonce: "A".repeat(43),
    transport_server_epoch: "B".repeat(43), transport_issued_at_utc: "2035-01-02T03:04:05.006Z",
    laboratory_evidence: laboratoryEvidence, laboratory_evidence_hash: hash(canonicalTestNativeJson(laboratoryEvidence)),
    laboratory_move_evidence: projection,
    method: "POST", path: "/revit/move-elements", body_present: true,
    raw_body_sha256: dto.outbound_body_sha256, canonical_body_sha256: dto.outbound_body_sha256,
    phase: "preview", effect_id: dto.effect_id, effect_hash: dto.effect_hash, channel: dto.channel, alias: dto.alias,
    document_fingerprint: dto.document_fingerprint, document_session_id: dto.document_session_id,
    native_common_assembly_sha256: `sha256:${"4".repeat(64)}`,
    native_logic_assembly_sha256: `sha256:${"5".repeat(64)}`,
    native_bridge_assembly_sha256: `sha256:${"6".repeat(64)}`,
    native_attestation_algorithm: "RS256", native_attestation_key_id: TEST_NATIVE_EXECUTION_ATTESTATION.key_id,
    native_attestation_modulus_base64url: TEST_NATIVE_EXECUTION_ATTESTATION.modulus_base64url,
    native_attestation_exponent_base64url: TEST_NATIVE_EXECUTION_ATTESTATION.exponent_base64url,
    result_hash: hash(canonicalTestNativeJson(nativeResult)), outcome: "rolled_back", outcome_unknown: false,
    issued_at_utc: "2035-01-02T03:04:05.007Z"
  };
  receipt.native_attestation_signature = signTestNativeReceipt(receipt);
  return {
    ...nativeResult,
    laboratory_execution_receipt: receipt
  };
}

function previewAdmission() {
  target();
  const evidenceDispatch = issueLaboratoryEvidenceDispatch({
    evidenceRunId: "a".repeat(32), evidenceStep: "move-preview", workflow: "epic-0437-l4-move-preview", transportKind: "direct"
  }, env);
  return admitLaboratoryMoveEvidenceRequest({
    evidenceDispatch,
    request: { phase: "preview", elementId, observationId, vectorFeet: { x: 0.25, y: 0, z: 0 }, previewReceipt: undefined }
  }, env);
}

test("move evidence admission reuses exact typed validator and remains explicitly non-production", () => {
  const admission = previewAdmission();
  const bodyJson = canonicalToolExposureJson(admission.outboundBody);
  const dto = consumeLaboratoryMoveEvidenceAdmission({
    admission, method: "POST", path: "/revit/move-elements", bodyJson, channel: "typed_mcp", alias: "revit_move_one_certified"
  }, env);
  assert.equal(dto.production_certified, false);
  assert.equal(dto.request_instance_hash, admission.request.requestInstanceHash);
  assert.equal(dto.effect_hash, LABORATORY_MOVE_PREVIEW_EFFECT_HASH);
  assert.equal(dto.document_session_id, "123e4567e89b42d3a456426614174000");
  assert.equal(dto.element_id, elementId);
  assert.equal(dto.preview_lineage, null);
  assert.match(dto.laboratory_move_evidence_admission_hash, /^sha256:[0-9a-f]{64}$/);
  assert.throws(() => consumeLaboratoryMoveEvidenceAdmission({
    admission, method: "POST", path: "/revit/move-elements", bodyJson, channel: "typed_mcp", alias: "revit_move_one_certified"
  }, env), /replayed/);
});

test("move evidence admission rejects caller objects, body/alias/path substitution, and wrong lane", () => {
  const admission = previewAdmission();
  const bodyJson = canonicalToolExposureJson(admission.outboundBody);
  assert.throws(() => consumeLaboratoryMoveEvidenceAdmission({
    admission: { ...admission } as never, method: "POST", path: "/revit/move-elements", bodyJson, channel: "typed_mcp", alias: "revit_move_one_certified"
  }, env), /not issued/);
  for (const changed of [
    { method: "GET", path: "/revit/move-elements", bodyJson, channel: "typed_mcp", alias: "revit_move_one_certified" },
    { method: "POST", path: "/revit/delete", bodyJson, channel: "typed_mcp", alias: "revit_move_one_certified" },
    { method: "POST", path: "/revit/move-elements", bodyJson: bodyJson.replace("0.25", "0.5"), channel: "typed_mcp", alias: "revit_move_one_certified" },
    { method: "POST", path: "/revit/move-elements", bodyJson, channel: "generic_call", alias: "revit_call_tool" }
  ]) {
    const fresh = previewAdmission();
    assert.throws(() => consumeLaboratoryMoveEvidenceAdmission({ admission: fresh, ...changed }, env), /exact typed/);
  }
  assert.throws(() => consumeLaboratoryMoveEvidenceAdmission({
    admission, method: "POST", path: "/revit/move-elements", bodyJson, channel: "typed_mcp", alias: "revit_move_one_certified"
  }, { ...env, OPERATOR_CERTIFICATION_PROTECTED_LABORATORY: "0" }), /exact protected/);
});

test("native-signed preview lineage admits one exact apply and rejects replay or widening", () => {
  const preview = previewAdmission();
  const previewDto = consumeLaboratoryMoveEvidenceAdmission({
    admission: preview, method: "POST", path: "/revit/move-elements",
    bodyJson: canonicalToolExposureJson(preview.outboundBody), channel: "typed_mcp", alias: "revit_move_one_certified"
  }, env);
  const token = issueLaboratoryMovePreviewLineage(preview, signedPreviewResult(preview, previewDto), env);
  assert.throws(() => issueLaboratoryMovePreviewLineage(preview, signedPreviewResult(preview, previewDto), env), /already issued/);
  const dispatch = issueLaboratoryEvidenceDispatch({
    evidenceRunId: "a".repeat(32), evidenceStep: "move-apply", workflow: "epic-0437-l4-move-apply", transportKind: "direct"
  }, env);
  const apply = admitLaboratoryMoveEvidenceRequest({ evidenceDispatch: dispatch, request: {
    phase: "apply", elementId, observationId, vectorFeet: { x: 0.25, y: 0, z: 0 }, previewReceipt: token
  } }, env);
  const applyDto = consumeLaboratoryMoveEvidenceAdmission({
    admission: apply, method: "POST", path: "/revit/move-elements",
    bodyJson: canonicalToolExposureJson(apply.outboundBody), channel: "typed_mcp", alias: "revit_move_one_certified"
  }, env);
  assert.equal(applyDto.preview_lineage?.preview_request_instance_hash, previewDto.request_instance_hash);
  assert.equal(applyDto.preview_lineage?.preview_execution_receipt_sha256.startsWith("sha256:"), true);

  const replayDispatch = issueLaboratoryEvidenceDispatch({
    evidenceRunId: "a".repeat(32), evidenceStep: "move-replay", workflow: "epic-0437-l4-move-replay", transportKind: "direct"
  }, env);
  assert.throws(() => admitLaboratoryMoveEvidenceRequest({ evidenceDispatch: replayDispatch, request: {
    phase: "apply", elementId, observationId, vectorFeet: { x: 0.25, y: 0, z: 0 }, previewReceipt: token
  } }, env), /PREVIEW_LINEAGE_INVALID/);

  const preview2 = previewAdmission();
  const dto2 = consumeLaboratoryMoveEvidenceAdmission({ admission: preview2, method: "POST", path: "/revit/move-elements", bodyJson: canonicalToolExposureJson(preview2.outboundBody), channel: "typed_mcp", alias: "revit_move_one_certified" }, env);
  const token2 = issueLaboratoryMovePreviewLineage(preview2, signedPreviewResult(preview2, dto2), env);
  const widenedDispatch = issueLaboratoryEvidenceDispatch({ evidenceRunId: "a".repeat(32), evidenceStep: "move-widened", workflow: "epic-0437-l4-move-widened", transportKind: "direct" }, env);
  assert.throws(() => admitLaboratoryMoveEvidenceRequest({ evidenceDispatch: widenedDispatch, request: {
    phase: "apply", elementId, observationId, vectorFeet: { x: 0.5, y: 0, z: 0 }, previewReceipt: token2
  } }, env), /PREVIEW_LINEAGE_INVALID/);
});

test("preview lineage rejects document/session substitution", () => {
  const preview = previewAdmission();
  const dto = consumeLaboratoryMoveEvidenceAdmission({ admission: preview, method: "POST", path: "/revit/move-elements", bodyJson: canonicalToolExposureJson(preview.outboundBody), channel: "typed_mcp", alias: "revit_move_one_certified" }, env);
  const token = issueLaboratoryMovePreviewLineage(preview, signedPreviewResult(preview, dto), env);
  clearCertifiedMoveTargetLedgerForTests();
  registerCertifiedSpatialObservation(
    { document: { sessionId: "f".repeat(32), nativeExecutionAttestation: TEST_NATIVE_EXECUTION_ATTESTATION, projectIdentity: { fingerprint: "b".repeat(64) }, activeView: { id: 42 } } },
    { observationId, viewId: 42, items: [{ elementId, sourceScopedId: `host:${elementId}`, groundingStatus: "anchored", pinned: false, groupId: null, groupIdReadSucceeded: true, orientation: { locationKind: "point", locationPoint: { x: 1, y: 2, z: 3 } } }] }
  );
  const dispatch = issueLaboratoryEvidenceDispatch({ evidenceRunId: "a".repeat(32), evidenceStep: "session-substitution", workflow: "epic-0437-l4-session-substitution", transportKind: "direct" }, env);
  assert.throws(() => admitLaboratoryMoveEvidenceRequest({ evidenceDispatch: dispatch, request: {
    phase: "apply", elementId, observationId, vectorFeet: { x: 0.25, y: 0, z: 0 }, previewReceipt: token
  } }, env), /PREVIEW_LINEAGE_INVALID/);
});
