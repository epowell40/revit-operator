import assert from "node:assert/strict";
import test from "node:test";
import { clearCertifiedMoveTargetLedgerForTests, registerCertifiedSpatialObservation, resolveCertifiedMoveTarget } from "./certifiedMoveTargetLedger.js";

const sessionId = "123e4567e89b42d3a456426614174000";
const context = { document: { sessionId, projectIdentity: { fingerprint: "a".repeat(64) }, activeView: { id: 42 } } };
const observation = { observationId: "frame-1", viewId: 42, items: [
  { elementId: 17, sourceScopedId: "host:17", groundingStatus: "anchored", orientation: { locationKind: "point" } },
  { elementId: 18, sourceScopedId: "host:18", groundingStatus: "geometry", orientation: { locationKind: "curve" } },
  { elementId: 19, sourceScopedId: "link:2:19", groundingStatus: "anchored", orientation: { locationKind: "point" } }
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
    observationBindingHash: resolveCertifiedMoveTarget("frame-1", 17).observationBindingHash
  });
  assert.throws(() => resolveCertifiedMoveTarget("frame-1", 18), /not issued/);
  assert.throws(() => resolveCertifiedMoveTarget("frame-1", 19), /not issued/);
  assert.throws(() => resolveCertifiedMoveTarget("invented", 17), /not issued/);
});

test("rejects observation and document session substitution", () => {
  clearCertifiedMoveTargetLedgerForTests();
  assert.throws(() => registerCertifiedSpatialObservation({ ...context, document: { ...context.document, activeView: { id: 41 } } }, observation), /current active view/);
  assert.throws(() => registerCertifiedSpatialObservation({ ...context, document: { ...context.document, sessionId: "not-a-session" } }, observation), /session id is invalid/);
});
