import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import test from "node:test";
import { canonicalJson, type JsonValue } from "../src/capabilities/tool_certification.js";
import {
  EPIC_0437_CANDIDATE_SOURCE_HASH,
  parseLaboratoryEvidenceDispatch
} from "../src/courier/laboratory_evidence.js";
import { verifyLaboratoryExecutionReceipt } from "../src/courier/laboratory_execution_receipt.js";

const hash = (value: string) => `sha256:${createHash("sha256").update(value, "utf8").digest("hex")}`;

function fixture() {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const jwk = publicKey.export({ format: "jwk" });
  const modulus = jwk.n!;
  const exponent = jwk.e!;
  const keyId = hash(canonicalJson({ algorithm: "RS256", exponent_base64url: exponent, modulus_base64url: modulus }));
  const evidence = parseLaboratoryEvidenceDispatch({
    schema: "revit-operator.laboratory-evidence-dispatch.v2",
    candidate_source_hash: EPIC_0437_CANDIDATE_SOURCE_HASH,
    policy_hash: `sha256:${"1".repeat(64)}`,
    policy_record_hash: `sha256:${"2".repeat(64)}`,
    evidence_record_hash: `sha256:${"3".repeat(64)}`,
    effect_hash: "sha256:0f19ae675c51b10854e3977070ad34e4898a004c4a724058f933c17233f37bf8",
    evidence_run_id: "a".repeat(32),
    evidence_step: "context-before",
    transport_kind: "courier",
    job_id: "b".repeat(64),
    correlation_id: "b".repeat(64),
    workflow: "epic-0437-live-l4",
    channel: "typed_mcp",
    alias: "observe_model_v1",
    production_certified: false
  });
  const result = { ok: true, document: { title: "Mechanical Sample" } };
  const receipt: Record<string, unknown> = {
    schema: "revit-operator.laboratory-execution-receipt.v1",
    request_id: "c".repeat(64), dispatch_id: "c".repeat(64),
    transport_request_nonce: "d".repeat(43), transport_server_epoch: "epoch",
    transport_issued_at_utc: "2026-08-08T12:00:00.000Z",
    laboratory_evidence: evidence,
    laboratory_evidence_hash: hash(canonicalJson(evidence as unknown as JsonValue)),
    laboratory_move_evidence: null,
    method: "GET", path: "/revit/context", body_present: false,
    raw_body_sha256: hash(""), canonical_body_sha256: hash(""),
    phase: "read", effect_id: "revit-operator.spatial-observation-readback.effect.v1",
    effect_hash: "sha256:0f19ae675c51b10854e3977070ad34e4898a004c4a724058f933c17233f37bf8",
    channel: "typed_mcp", alias: "observe_model_v1",
    document_fingerprint: `sha256:${"e".repeat(64)}`, document_session_id: "f".repeat(32),
    revit_process_id: 4242,
    revit_process_start_utc: "2026-08-08T12:00:00.000Z",
    revit_process_image_path: "C:\\Program Files\\Autodesk\\Revit 2024\\Revit.exe",
    native_common_assembly_path: "C:\\Operator\\RevitBridge.Common.dll",
    native_common_assembly_sha256: `sha256:${"4".repeat(64)}`,
    native_logic_assembly_path: "C:\\Operator\\RevitBridge.Logic.dll",
    native_logic_assembly_sha256: `sha256:${"5".repeat(64)}`,
    native_bridge_assembly_path: "C:\\Operator\\RevitBridge.dll",
    native_bridge_assembly_sha256: `sha256:${"6".repeat(64)}`,
    native_attestation_algorithm: "RS256", native_attestation_key_id: keyId,
    native_attestation_modulus_base64url: modulus, native_attestation_exponent_base64url: exponent,
    result_hash: hash(canonicalJson(result)), outcome: "read_completed", outcome_unknown: false,
    issued_at_utc: "2026-08-08T12:00:00.100Z"
  };
  receipt.native_attestation_signature = sign(
    "RSA-SHA256",
    Buffer.from(canonicalJson(receipt as JsonValue), "utf8"),
    privateKey
  ).toString("base64url");
  return {
    attached: { ...result, laboratory_execution_receipt: receipt }, evidence,
    trusted: { algorithm: "RS256" as const, key_id: keyId, modulus_base64url: modulus, exponent_base64url: "AQAB" as const }
  };
}

test("verifies an exact native-signed laboratory receipt against an independent key pin", () => {
  const value = fixture();
  const verified = verifyLaboratoryExecutionReceipt(value.attached, {
    expectedEvidence: value.evidence,
    trustedNativeAttestation: value.trusted,
    method: "GET",
    path: "/revit/context"
  });
  assert.equal(verified.receipt.outcome, "read_completed");
});

test("rejects dispatch tamper, result tamper, and a self-signed key that is not the trusted live key", () => {
  const value = fixture();
  const dispatchTamper = structuredClone(value.attached) as any;
  dispatchTamper.laboratory_execution_receipt.laboratory_evidence.evidence_step = "forged";
  assert.throws(() => verifyLaboratoryExecutionReceipt(dispatchTamper, { trustedNativeAttestation: value.trusted }), /hash|signature/);

  const resultTamper = structuredClone(value.attached);
  resultTamper.document.title = "Forged";
  assert.throws(() => verifyLaboratoryExecutionReceipt(resultTamper, { trustedNativeAttestation: value.trusted }), /result hash/);

  const independentlySignedForgery = fixture();
  assert.throws(() => verifyLaboratoryExecutionReceipt(independentlySignedForgery.attached, {
    trustedNativeAttestation: value.trusted
  }), /independently trusted live process key/);
});
