import assert from "node:assert/strict";
import test from "node:test";
import { TEST_NATIVE_EXECUTION_ATTESTATION } from "./lib/certifiedMoveNativeAttestation.testSupport.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { normalizeSpatialObservationInput, normalizeSpatialObservationV1, observeModelV1, readCertifiedMoveTargetsV1, readSpatialObservationImage } from "./spatialObservationV1.js";

const mapping = { mode: "2d_affine", topLeftXyz: [0, 10, 0], topRightXyz: [10, 10, 0], bottomLeftXyz: [0, 0, 0] };
const tinyPng = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO6nS7sAAAAASUVORK5CYII=", "base64");
function payload() { return { frameId: "frame-7", path: "C:\\tmp\\frame-7.png", widthPx: 1600, heightPx: 900, viewId: 42, viewName: "Level 1", mapping, count: 2, scanned: 3, truncated: true, items: [
  { elementId: 12, source: { scope: "host" }, pinned: false, groupId: null, groupIdReadSucceeded: true, category: "Walls", anchor: { image: { normalizedX: 0.2, normalizedY: 0.3 } }, orientation: { planAzimuthRadians: 1.2, locationKind: "point", locationPoint: { x: 1, y: 2, z: 3 } } },
  { elementId: 12, source: { scope: "linked", linkInstanceId: 9 }, category: "Doors", bbox: { image: { normalizedMinX: 0.4, normalizedMinY: 0.5, normalizedMaxX: 0.5, normalizedMaxY: 0.6 } }, hostProvenance: { source: "linked" } }
] , document: { sessionId: "123e4567e89b42d3a456426614174000", nativeExecutionAttestation: TEST_NATIVE_EXECUTION_ATTESTATION, projectIdentity: { fingerprint: "a".repeat(64) }, activeView: { id: 42 } } }; }

test("normalizes host and linked evidence without requiring an anchor", () => {
  const observation = normalizeSpatialObservationV1(payload()); const items = observation.items as Array<Record<string, unknown>>;
  assert.equal(observation.schemaVersion, "spatial-observation/v1"); assert.equal(items[0]?.sourceScopedId, "host:12"); assert.equal(items[1]?.sourceScopedId, "link:9:12");
  assert.equal(items[1]?.groundingStatus, "bbox"); assert.deepEqual(observation.mapping, mapping); assert.equal((items[1]?.hostProvenance as any)?.source, "linked");
});
test("reports grounding only for usable projected or model coordinates", () => {
  const items = [
    { elementId: 1, sourceScopedId: "host:1", anchor: {} },
    { elementId: 2, sourceScopedId: "host:2", geometry: { kind: "none" } },
    { elementId: 3, sourceScopedId: "host:3", geometry: { kind: "point", point: { x: 1, y: 2, z: 3 } } },
    { elementId: 4, sourceScopedId: "host:4", geometry: { kind: "curve", start: { x: 1, y: 2 }, end: { x: 3, y: 4 } } },
    { elementId: 5, sourceScopedId: "host:5", bbox: { model: { min: { x: 0, y: 0, z: 0 }, max: { x: 1, y: 1, z: 1 } } } },
    { elementId: 6, sourceScopedId: "host:6", anchor: { image: { normalizedX: 0.2, normalizedY: 0.4 } } },
    { elementId: 7, sourceScopedId: "host:7", geometry: { kind: "point", point: { model: { x: 7, y: 8, z: 9 }, image: { normalizedX: 0.7, normalizedY: 0.8 } } } },
    { elementId: 8, sourceScopedId: "host:8", anchor: { point: { model: { x: 2, y: 3, z: 4 } } } },
    { elementId: 9, sourceScopedId: "host:9", geometry: { kind: "point", point: [1, 2] } },
    { elementId: 10, sourceScopedId: "host:10", anchor: { x: 10, y: 20 } },
    { elementId: 11, sourceScopedId: "host:11", anchor: { image: { x: 100, y: 200 } } },
    { elementId: 12, sourceScopedId: "host:12", anchor: { xPx: 300, yPx: 400 } },
    { elementId: 13, sourceScopedId: "host:13", geometry: { kind: "point", point: { x: 1, y: 2, z: Number.POSITIVE_INFINITY } } }
  ];
  const observation = normalizeSpatialObservationV1({ ...payload(), count: items.length, scanned: items.length, truncated: false, items });
  assert.deepEqual((observation.items as any[]).map(item => item.groundingStatus), ["ungrounded", "ungrounded", "geometry", "ungrounded", "bbox", "anchored", "geometry", "anchored", "ungrounded", "ungrounded", "anchored", "anchored", "ungrounded"]);
});
test("rejects malformed frame contracts and bounds native inputs", () => {
  assert.throws(() => normalizeSpatialObservationV1({ ...payload(), path: "" }), /image path is required/); assert.throws(() => normalizeSpatialObservationV1({ ...payload(), count: 1 }), /count must equal/);
  assert.throws(() => normalizeSpatialObservationV1({ ...payload(), items: [payload().items[0], payload().items[0]] }), /sourceScopedId must be unique/);
  for (const malformedMapping of [
    {},
    { mode: "not_affine", topLeftXyz: [0, 10, 0], topRightXyz: [10, 10, 0], bottomLeftXyz: [0, 0, 0] },
    { mode: "2d_affine", topLeftXyz: [0, 10], topRightXyz: [10, 10, 0], bottomLeftXyz: [0, 0, 0] },
    { mode: "2d_affine", topLeftXyz: [0, 10, 0], topRightXyz: [10, Number.NaN, 0], bottomLeftXyz: [0, 0, 0] }
  ]) assert.throws(() => normalizeSpatialObservationV1({ ...payload(), mapping: malformedMapping }), /mapping must use 2d_affine/);
  for (const degenerateMapping of [
    { mode: "2d_affine", topLeftXyz: [0, 10, 0], topRightXyz: [0, 10, 0], bottomLeftXyz: [0, 0, 0] },
    { mode: "2d_affine", topLeftXyz: [0, 10, 0], topRightXyz: [10, 10, 0], bottomLeftXyz: [20, 10, 0] }
  ]) assert.throws(() => normalizeSpatialObservationV1({ ...payload(), mapping: degenerateMapping }), /non-degenerate axes/);
  assert.throws(() => normalizeSpatialObservationInput({ imageSize: 4097 }), /256 to 4096/); assert.throws(() => normalizeSpatialObservationInput({ limit: 2001 }), /1 to 2000/); assert.throws(() => normalizeSpatialObservationInput({ modelBounds: [0, 0, 0, 1, 1] }), /minX/);
  assert.deepEqual(normalizeSpatialObservationInput({ imageSize: 1200, limit: 12, includeLinked: true, modelBounds: [0, 0, 0, 1, 1, 1] }), { imageSize: 1200, limit: 12, includeLinked: true, modelBounds: [0, 0, 0, 1, 1, 1], includeMapping: true, includeGeometry: true });
});
test("secure image reads enforce real workspace confinement, byte bounds, and PNG/JPEG signatures", () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "spatial-observation-test-"));
  const workspaceRoot = path.join(tempRoot, "workspace");
  const outsideRoot = path.join(tempRoot, "outside");
  const outsideImage = path.join(outsideRoot, "outside.png");
  const priorRoot = process.env.OPERATOR_WORKSPACE_ROOT;
  const priorLocalAppData = process.env.LOCALAPPDATA;
  const fakeLocalAppData = path.join(tempRoot, "local-app-data");
  const nativeCaptureRoot = path.join(fakeLocalAppData, "RevitOperator", "Workspace");
  const nativeCaptureImage = path.join(nativeCaptureRoot, "native-capture.png");
  fs.mkdirSync(workspaceRoot);
  fs.mkdirSync(outsideRoot);
  fs.mkdirSync(nativeCaptureRoot, { recursive: true });
  fs.writeFileSync(outsideImage, tinyPng);
  fs.writeFileSync(nativeCaptureImage, tinyPng);
  const insideImage = path.join(workspaceRoot, "inside.dat");
  const oversizedImage = path.join(workspaceRoot, "oversized.png");
  const unsupportedImage = path.join(workspaceRoot, "unsupported.png");
  fs.writeFileSync(insideImage, tinyPng);
  fs.writeFileSync(oversizedImage, Buffer.concat([tinyPng, Buffer.alloc(64)]));
  fs.writeFileSync(unsupportedImage, Buffer.from([0x42, 0x4d, 0, 0, 0, 0]));
  const linkedOutside = path.join(workspaceRoot, "linked-outside");
  fs.symlinkSync(outsideRoot, linkedOutside, "junction");
  process.env.OPERATOR_WORKSPACE_ROOT = workspaceRoot;
  process.env.LOCALAPPDATA = fakeLocalAppData;
  try {
    assert.equal(normalizeSpatialObservationV1({ ...payload(), scanned: 3, truncated: false }).scanned, 3);
    const inside = readSpatialObservationImage(insideImage);
    assert.equal(inside.ok, true);
    if (inside.ok) assert.equal(inside.mimeType, "image/png");
    const nativeCapture = readSpatialObservationImage(nativeCaptureImage);
    assert.equal(nativeCapture.ok, true);
    if (nativeCapture.ok) assert.equal(nativeCapture.mimeType, "image/png");
    assert.match(readSpatialObservationImage(outsideImage).ok ? "" : (readSpatialObservationImage(outsideImage) as any).reason, /outside the workspace/);
    const linked = readSpatialObservationImage(path.join(linkedOutside, "outside.png"));
    assert.equal(linked.ok, false);
    if (!linked.ok) assert.match(linked.reason, /resolves outside/);
    const oversized = readSpatialObservationImage(oversizedImage, tinyPng.length);
    assert.equal(oversized.ok, false);
    if (!oversized.ok) assert.match(oversized.reason, /exceeds/);
    const unsupported = readSpatialObservationImage(unsupportedImage);
    assert.equal(unsupported.ok, false);
    if (!unsupported.ok) assert.match(unsupported.reason, /supported PNG or JPEG/);
    const raceDir = path.join(workspaceRoot, "race");
    const raceBackup = path.join(workspaceRoot, "race-original");
    const raceImage = path.join(raceDir, "outside.png");
    fs.mkdirSync(raceDir);
    fs.writeFileSync(raceImage, tinyPng);
    const raced = readSpatialObservationImage(raceImage, 5 * 1024 * 1024, {
      afterResolve: () => {
        fs.renameSync(raceDir, raceBackup);
        fs.symlinkSync(outsideRoot, raceDir, "junction");
      },
      afterOpen: () => {
        fs.rmSync(raceDir);
        fs.renameSync(raceBackup, raceDir);
      }
    });
    assert.equal(raced.ok, false);
    if (!raced.ok) assert.match(raced.reason, /identity does not match/);
  } finally {
    if (priorRoot === undefined) delete process.env.OPERATOR_WORKSPACE_ROOT;
    else process.env.OPERATOR_WORKSPACE_ROOT = priorRoot;
    if (priorLocalAppData === undefined) delete process.env.LOCALAPPDATA;
    else process.env.LOCALAPPDATA = priorLocalAppData;
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});
test("wrapper calls the existing primitive once and returns structured and image content", async () => {
  const calls: unknown[] = []; const result = await observeModelV1({}, async (route, method, body) => { calls.push({ route, method, body }); return payload(); }, () => ({ ok: true, data: tinyPng.toString("base64"), mimeType: "image/png" }));
  assert.equal(calls.length, 1); assert.equal((calls[0] as any).route, "/revit/export-visible-elements"); assert.equal(result.content.length, 2); assert.equal(result.content[1]?.type, "image");
  const observation = JSON.parse((result.content[0] as any).text); assert.equal(observation.certifiedTargetCount, 1); assert.equal(observation.document.documentSessionId, payload().document.sessionId);
});
test("wrapper preserves structured evidence and explains an unavailable image", async () => {
  const result = await observeModelV1({}, async () => payload(), () => ({ ok: false, reason: "image is not a supported PNG or JPEG payload" }));
  assert.equal(result.content.length, 1);
  const observation = JSON.parse((result.content[0] as any).text);
  assert.match(observation.warnings[0], /Observation image unavailable/);
  assert.match(observation.warnings[0], /PNG or JPEG/);
});
test("certified target readback takes no caller ids and projects exact fresh-observation XYZ", async () => {
  const calls: unknown[] = [];
  const result = await readCertifiedMoveTargetsV1(async (route, method, body) => {
    calls.push({ route, method, body });
    return payload();
  });
  assert.deepEqual(calls, [{ route: "/revit/export-visible-elements", method: "POST", body: {
    imageSize: 2200, limit: 500, includeMapping: true, includeGeometry: true
  } }]);
  const readback = JSON.parse(result.content[0]!.text);
  assert.equal(readback.schemaVersion, "certified-move-target-readback/v1");
  assert.deepEqual(readback.targets, [{
    observationId: "frame-7", sourceScopedId: "host:12", elementId: 12,
    pointXyz: { x: 1, y: 2, z: 3 }, pinned: false, groupIdReadSucceeded: true, groupId: null,
    category: "Walls", familyName: null, typeName: null
  }]);
});
