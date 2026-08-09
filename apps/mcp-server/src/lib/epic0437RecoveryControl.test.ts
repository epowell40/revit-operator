import assert from "node:assert/strict";
import test from "node:test";
import { assertNoEpic0437DiscardRequired, routeEpic0437Recovery } from "./epic0437RecoveryControl.js";
import { TEST_NATIVE_EXECUTION_ATTESTATION } from "./certifiedMoveNativeAttestation.testSupport.js";
import type { LaboratoryNativeAttestationBinding } from "./laboratoryMoveEvidence.js";

const trusted: LaboratoryNativeAttestationBinding = {
  algorithm: "RS256", key_id: TEST_NATIVE_EXECUTION_ATTESTATION.key_id,
  modulus_base64url: TEST_NATIVE_EXECUTION_ATTESTATION.modulus_base64url, exponent_base64url: "AQAB"
};

function result(sessionId: string, key = trusted): Record<string, unknown> {
  return { laboratory_execution_receipt: {
    native_attestation_algorithm: key.algorithm,
    native_attestation_key_id: key.key_id,
    native_attestation_modulus_base64url: key.modulus_base64url,
    native_attestation_exponent_base64url: key.exponent_base64url,
    document_session_id: sessionId
  } };
}

test("rotated native recovery persists discard authority, invokes zero move callbacks, and blocks", () => {
  let moveCalls = 0;
  const routed = routeEpic0437Recovery({
    savedState: { preview_result: result("old-session"), evidence_run_id: "a".repeat(32) },
    trusted, currentDocumentSessionId: "new-session", nowUtc: "2026-08-08T17:30:00.000Z",
    sameSession: () => { moveCalls += 1; return "unsafe"; }
  });
  assert.equal(routed.kind, "discard_required");
  assert.equal(moveCalls, 0);
  if (routed.kind !== "discard_required") assert.fail("expected discard route");
  assert.equal(routed.state.state, "host_restart_discard_required");
  assert.equal(routed.state.outcome_unknown, true);
  assert.equal(routed.state.retryable, false);
  assert.throws(() => assertNoEpic0437DiscardRequired(["old.recovery.json"]), /cannot authorize another mutation/);
});

test("same native recovery enters only the fully verified callback path", () => {
  let verificationCalls = 0;
  const routed = routeEpic0437Recovery({
    savedState: { preview_result: result("same-session") }, trusted,
    currentDocumentSessionId: "same-session", nowUtc: "2026-08-08T17:30:00.000Z",
    sameSession: () => { verificationCalls += 1; return "verified-receipt"; }
  });
  assert.deepEqual(routed, { kind: "same_native_session", value: "verified-receipt" });
  assert.equal(verificationCalls, 1);
  assert.doesNotThrow(() => assertNoEpic0437DiscardRequired([]));
});
