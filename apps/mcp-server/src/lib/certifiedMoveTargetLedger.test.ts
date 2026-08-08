import assert from "node:assert/strict";
import test from "node:test";
import { clearCertifiedMoveTargetLedgerForTests, listCertifiedMoveTargets, registerCertifiedSpatialObservation, resolveCertifiedMoveTarget } from "./certifiedMoveTargetLedger.js";
import { TEST_NATIVE_EXECUTION_ATTESTATION } from "./certifiedMoveNativeAttestation.testSupport.js";

const sessionId = "123e4567e89b42d3a456426614174000";
const context = { document: { sessionId, nativeExecutionAttestation: TEST_NATIVE_EXECUTION_ATTESTATION, projectIdentity: { fingerprint: "a".repeat(64) }, activeView: { id: 42 } } };
const observation = { observationId: "frame-1", viewId: 42, items: [
  { elementId: 17, sourceScopedId: "host:17", groundingStatus: "anchored", pinned: false, groupId: null, category: "Mechanical Equipment", familyName: "Pump", typeName: "P-1", orientation: { locationKind: "point", locationPoint: { x: 1, y: 2, z: 3 } } },
  { elementId: 18, sourceScopedId: "host:18", groundingStatus: "geometry", orientation: { locationKind: "curve" } },
  { elementId: 19, sourceScopedId: "link:2:19", groundingStatus: "anchored", orientation: { locationKind: "point", locationPoint: { x: 4, y: 5, z: 6 } } },
  { elementId: 20, sourceScopedId: "host:20", groundingStatus: "anchored", pinned: true, groupId: null, orientation: { locationKind: "point", locationPoint: { x: 4, y: 5, z: 6 } } },
  { elementId: 21, sourceScopedId: "host:21", groundingStatus: "anchored", pinned: false, groupId: 99, orientation: { locationKind: "point", locationPoint: { x: 4, y: 5, z: 6 } } }
] };

test("mints exact host point target bindings only from a native observation plus current context", () => {
  clearCertifiedMoveTargetLedgerForTests();
  const enriched = registerCertifiedSpatialObservation(context, observation);
  assert.equal(enriched.certifiedTargetCount, 1);
  assert.deepEqual(resolveCertifiedMoveTarget("frame-1", 17), {
    observationId: "frame-1",
    documentFingerprint: `sha256:${"a".repeat(64)}`,
    documentSessionId: sessionId,
    sourceScopedId: "host:17",
    elementId: 17,
    observationBindingHash: resolveCertifiedMoveTarget("frame-1", 17).observationBindingHash,
    nativeAttestationKeyId: TEST_NATIVE_EXECUTION_ATTESTATION.key_id,
    nativeAttestationModulusBase64Url: TEST_NATIVE_EXECUTION_ATTESTATION.modulus_base64url,
    nativeAttestationExponentBase64Url: TEST_NATIVE_EXECUTION_ATTESTATION.exponent_base64url,
    pointXyz: { x: 1, y: 2, z: 3 },
    category: "Mechanical Equipment",
    familyName: "Pump",
    typeName: "P-1"
  });
  assert.deepEqual(listCertifiedMoveTargets("frame-1"), [{
    observationId: "frame-1", sourceScopedId: "host:17", elementId: 17,
    pointXyz: { x: 1, y: 2, z: 3 }, category: "Mechanical Equipment", familyName: "Pump", typeName: "P-1"
  }]);
  assert.throws(() => resolveCertifiedMoveTarget("frame-1", 18), /not issued/);
  assert.throws(() => resolveCertifiedMoveTarget("frame-1", 19), /not issued/);
  assert.throws(() => resolveCertifiedMoveTarget("frame-1", 20), /not issued/);
  assert.throws(() => resolveCertifiedMoveTarget("frame-1", 21), /not issued/);
  assert.throws(() => resolveCertifiedMoveTarget("invented", 17), /not issued/);
});

test("rejects observation and document session substitution", () => {
  clearCertifiedMoveTargetLedgerForTests();
  assert.throws(() => registerCertifiedSpatialObservation({ ...context, document: { ...context.document, activeView: { id: 41 } } }, observation), /current active view/);
  assert.throws(() => registerCertifiedSpatialObservation({ ...context, document: { ...context.document, sessionId: "not-a-session" } }, observation), /session id is invalid/);
});
