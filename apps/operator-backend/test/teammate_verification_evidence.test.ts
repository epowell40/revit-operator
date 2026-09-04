import assert from "node:assert/strict";
import test from "node:test";

import {
  explicitTargetAbsenceV2,
  explicitVerificationV2,
  substantiveReadbackV2,
  verificationObservationPayloadV2
} from "../src/teammate_verification_evidence.js";

test("generic completion and availability metadata cannot impersonate postcondition verification", () => {
  assert.equal(explicitVerificationV2({ complete: true, result: { available: true } }), false);
  assert.equal(explicitVerificationV2({ inventory: { complete: true, total: 509 } }), false);
  assert.equal(explicitVerificationV2({ request: { verified: true }, metadata: { complete: true } }), false);
});

test("only an explicit verifier assertion is recognized as generic verification", () => {
  assert.equal(explicitVerificationV2({ verified: true }), true);
  assert.equal(explicitVerificationV2({ verification: { status: "passed" } }), true);
  assert.equal(explicitVerificationV2({ postcondition: { satisfied: true } }), true);
  assert.equal(explicitVerificationV2({ verification: { status: "failed", satisfied: false } }), false);
});

test("V2 verification consumes the immutable Observation payload rather than request/control wrappers", () => {
  const rawPayload = { items: [{ elementId: 42, name: "Target" }] };
  const envelope = {
    request: { verified: true },
    structuredContent: {
      observation: { raw_payload: rawPayload },
      operation_result_v2: { complete: true }
    }
  };
  assert.deepEqual(verificationObservationPayloadV2(envelope), rawPayload);
  assert.equal(explicitVerificationV2(verificationObservationPayloadV2(envelope)), false);
  assert.equal(substantiveReadbackV2(verificationObservationPayloadV2(envelope)), true);
});

test("deletion proof requires explicit absence without a contradictory result collection", () => {
  assert.equal(explicitTargetAbsenceV2({ exists: false, items: [] }), true);
  assert.equal(explicitTargetAbsenceV2({ exists: false, items: [{ elementId: 42 }] }), false);
  assert.equal(explicitTargetAbsenceV2({ metadata: { exists: false }, items: [] }), false);
});
