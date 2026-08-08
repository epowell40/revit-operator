import assert from "node:assert/strict";
import test from "node:test";
import { admitCertifiedMoveOneRequest, CERTIFIED_MOVE_ONE_REQUEST_FAMILY_HASH, CertifiedMoveOneRequestError } from "./certifiedMoveOneRequestFamily.js";

const base = { phase: "preview", documentFingerprint: `sha256:${"a".repeat(64)}`, sourceScopedId: "host:4821", elementId: 4821, observationId: "frame_01", vectorFeet: { x: 2, y: 0, z: 0 }, previewInstanceHash: undefined };

test("one-element profile produces a rollback-only all-or-nothing native body", () => {
  const admitted = admitCertifiedMoveOneRequest(base);
  assert.equal(admitted.familyHash, CERTIFIED_MOVE_ONE_REQUEST_FAMILY_HASH);
  assert.deepEqual(admitted.outboundBody, { ids: [4821], mode: "vector", vectorX: 2, vectorY: 0, vectorZ: 0, dryRun: true, behavior: "allOrNothing", moveTogether: false, options: { failOnPinned: true, unpinIfAllowed: false } });
});
test("apply requires and binds an exact preview lineage", () => {
  assert.throws(() => admitCertifiedMoveOneRequest({ ...base, phase: "apply" }), (error: unknown) => error instanceof CertifiedMoveOneRequestError && error.code === "MOVE_ONE_PREVIEW_LINEAGE_INVALID");
  const preview = admitCertifiedMoveOneRequest(base);
  const apply = admitCertifiedMoveOneRequest({ ...base, phase: "apply", previewInstanceHash: preview.requestInstanceHash });
  assert.equal(apply.outboundBody.dryRun, false);
  assert.equal(apply.request.previewInstanceHash, preview.requestInstanceHash);
});
test("profile rejects broadened targets, vectors, and option injection", () => {
  assert.throws(() => admitCertifiedMoveOneRequest({ ...base, elementId: 0 }), /TARGET_INVALID/);
  assert.throws(() => admitCertifiedMoveOneRequest({ ...base, vectorFeet: { x: 2.01, y: 0, z: 0 } }), /VECTOR_OUT_OF_BOUNDS/);
  assert.throws(() => admitCertifiedMoveOneRequest({ ...base, ids: [4821, 4822] }), /REQUEST_INVALID/);
});
