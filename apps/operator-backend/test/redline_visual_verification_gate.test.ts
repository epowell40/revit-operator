import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import {
  evaluateRedlineVisualVerificationGate,
  normalizeRedlineVisualVerificationGateInput
} from "../src/verification/redline_visual_verification_gate.js";

const benchmarkManifestPath = "benchmarks/redline-visual-gate/manifest.json";

test("redline visual gate passes route with capture, matching endpoints, and landmark relationships", () => {
  const result = evaluateRedlineVisualVerificationGate({
    action_type: "duct_route",
    authority: "deterministic_geometry",
    redline_path: "artifacts/uploads/marked.pdf",
    before_capture_path: "artifacts/captures/before.jpg",
    after_capture_path: "artifacts/captures/after.jpg",
    intended_points: [{ x: 1, y: 2 }, { x: 5, y: 2 }],
    actual_points: [{ x: 1.1, y: 2 }, { x: 5.05, y: 2 }],
    max_error_ft: 0.1,
    tolerance_ft: 1,
    landmark_relationships: [
      {
        landmark: "bathroom/kitchen fixture band",
        relation: "route is plan south",
        status: "pass",
        reason: "Route center is in the expected lower room band."
      }
    ]
  });

  assert.equal(result.status, "pass");
  assert.equal(result.evidence.after_capture_path, "artifacts/captures/after.jpg");
  assert.equal(result.assertions.some(a => a.name === "endpoint_error_within_tolerance" && a.status === "pass"), true);
});

test("redline visual gate fails modeled route when model write evidence is required but missing", () => {
  const result = evaluateRedlineVisualVerificationGate({
    action_type: "pipe_route",
    authority: "deterministic_geometry",
    after_capture_path: "artifacts/captures/after.jpg",
    intended_points: [{ x: 1, y: 2 }, { x: 5, y: 2 }],
    actual_points: [{ x: 1, y: 2 }, { x: 5, y: 2 }],
    model_write_required: true,
    created_element_ids: [],
    created_fitting_ids: [],
    max_error_ft: 0,
    tolerance_ft: 1
  });

  assert.equal(result.status, "fail");
  assert.equal(result.assertions.some(a => a.name === "model_write_evidence_present" && a.status === "fail"), true);
  assert.match(result.reason, /requires created model element\/fitting IDs/i);
});

test("redline visual gate fails modeled route when created route segment ids do not cover requested segments", () => {
  const result = evaluateRedlineVisualVerificationGate({
    action_type: "pipe_route",
    authority: "deterministic_geometry",
    after_capture_path: "artifacts/captures/after.jpg",
    intended_points: [{ x: 1, y: 2 }, { x: 5, y: 2 }, { x: 5, y: 8 }],
    actual_points: [{ x: 1, y: 2 }, { x: 5, y: 2 }, { x: 5, y: 8 }],
    model_write_required: true,
    created_element_ids: [7001],
    created_fitting_ids: [7002, 7003],
    max_error_ft: 0,
    tolerance_ft: 1
  });

  assert.equal(result.status, "fail");
  assert.equal(result.assertions.some(a => a.name === "route_segment_write_evidence_matches" && a.status === "fail"), true);
  assert.match(result.reason, /created route element ID for each requested route segment/i);
});

test("redline visual gate fails when post-change capture reuses the before artifact", () => {
  const result = evaluateRedlineVisualVerificationGate({
    action_type: "duct_route",
    authority: "deterministic_geometry",
    before_capture_path: "artifacts/captures/route-before.jpg",
    after_capture_path: "artifacts/captures/route-before.jpg",
    intended_points: [{ x: 1, y: 2 }, { x: 5, y: 2 }],
    actual_points: [{ x: 1, y: 2 }, { x: 5, y: 2 }],
    model_write_required: true,
    created_element_ids: [7001],
    max_error_ft: 0,
    tolerance_ft: 1
  });

  assert.equal(result.status, "fail");
  assert.equal(result.assertions.some(a => a.name === "post_change_capture_differs_from_before" && a.status === "fail"), true);
  assert.match(result.reason, /reused the before-capture artifact/i);
});

test("redline visual gate fails when reported post-change capture dimensions are too small", () => {
  const result = evaluateRedlineVisualVerificationGate({
    action_type: "duct_route",
    authority: "deterministic_geometry",
    after_capture_path: "artifacts/captures/tiny-after.jpg",
    after_capture_width_px: 320,
    after_capture_height_px: 240,
    intended_points: [{ x: 1, y: 2 }, { x: 5, y: 2 }],
    actual_points: [{ x: 1, y: 2 }, { x: 5, y: 2 }],
    model_write_required: true,
    created_element_ids: [7001],
    max_error_ft: 0,
    tolerance_ft: 1
  });

  assert.equal(result.status, "fail");
  assert.equal(result.assertions.some(a => a.name === "post_change_capture_quality_ok" && a.status === "fail"), true);
  assert.deepEqual(result.evidence.after_capture_quality, { width_px: 320, height_px: 240 });
});

test("redline visual gate fails when requested focus crop was not applied", () => {
  const result = evaluateRedlineVisualVerificationGate(normalizeRedlineVisualVerificationGateInput({
    actionType: "pipe_route",
    authority: "deterministic_geometry",
    afterCapturePath: "artifacts/captures/focus-after.jpg",
    afterCapture: {
      widthPx: 1024,
      heightPx: 768,
      focusCrop: { requested: true, applied: false }
    },
    intendedPoints: [{ x: 1, y: 2 }, { x: 5, y: 2 }],
    actualPoints: [{ x: 1, y: 2 }, { x: 5, y: 2 }],
    modelWriteRequired: true,
    createdElementIds: [7001],
    maxErrorFt: 0,
    toleranceFt: 1
  }));

  assert.equal(result.status, "fail");
  assert.equal(result.assertions.some(a => a.name === "post_change_capture_quality_ok" && a.status === "fail"), true);
  assert.deepEqual(result.evidence.after_capture_quality, {
    width_px: 1024,
    height_px: 768,
    focus_crop: { requested: true, applied: false }
  });
});

test("redline visual gate fails one-axis false positive even when post-change capture exists", () => {
  const result = evaluateRedlineVisualVerificationGate({
    action_type: "duct_route",
    authority: "deterministic_geometry",
    after_capture_path: "artifacts/captures/after.jpg",
    intended_points: [{ x: 1, y: 2 }, { x: 5, y: 2 }],
    actual_points: [{ x: 1, y: 12 }, { x: 5, y: 12 }],
    max_error_ft: 10,
    tolerance_ft: 1,
    landmark_relationships: [
      {
        landmark: "target room/unit label band",
        relation: "route should be north of label and centered in target space",
        status: "fail",
        reason: "Route matches left/right span but is in the wrong north/south band."
      }
    ]
  });

  assert.equal(result.status, "fail");
  assert.match(result.reason, /wrong north\/south band|outside endpoint/i);
});

test("redline visual gate is uncertain without post-change capture evidence", () => {
  const result = evaluateRedlineVisualVerificationGate({
    action_type: "device_placement",
    authority: "hybrid",
    intended_action: { family: "receptacle", room_number: "405" },
    deterministic_assertions: [
      { name: "created_element_category", status: "pass", reason: "Created element is an electrical fixture." }
    ]
  });

  assert.equal(result.status, "uncertain");
  assert.equal(result.assertions.some(a => a.name === "post_change_capture_present" && a.status === "uncertain"), true);
});

test("redline visual gate honors model vision failure when provided", () => {
  const result = evaluateRedlineVisualVerificationGate({
    action_type: "pipe_route",
    authority: "gemini_vision",
    after_capture_path: "artifacts/captures/after.jpg",
    max_error_ft: 0,
    tolerance_ft: 1,
    vision_review: {
      provider: "gemini",
      status: "fail",
      confidence: 0.84,
      reason: "Highlighted pipe is parallel to the mark but one bay too far east."
    }
  });

  assert.equal(result.status, "fail");
  assert.equal(result.reason, "Highlighted pipe is parallel to the mark but one bay too far east.");
});

test("redline visual gate benchmark manifest covers required action classes and one-axis false positives", (t) => {
  if (!fs.existsSync(benchmarkManifestPath)) {
    t.skip("Standalone public core omits private or real benchmark assets.");
    return;
  }
  const manifest = JSON.parse(fs.readFileSync(benchmarkManifestPath, "utf8")) as any;
  const cases = Array.isArray(manifest.cases) ? manifest.cases : [];
  const actionTypes = new Set(cases.map((c: any) => c.action_type));

  for (const actionType of ["duct_route", "pipe_route", "device_placement", "text_note", "resize_change"]) {
    assert.equal(actionTypes.has(actionType), true, actionType);
  }
  assert.equal(cases.some((c: any) => /x-wrong/i.test(c.id) && c.expected_status === "fail"), true);
  assert.equal(cases.some((c: any) => /y-wrong/i.test(c.id) && c.expected_status === "fail"), true);
});

test("redline visual gate benchmark fixtures evaluate to expected statuses", (t) => {
  if (!fs.existsSync(benchmarkManifestPath)) {
    t.skip("Standalone public core omits private or real benchmark assets.");
    return;
  }
  const manifest = JSON.parse(fs.readFileSync(benchmarkManifestPath, "utf8")) as any;
  const cases = Array.isArray(manifest.cases) ? manifest.cases : [];
  assert.ok(cases.length > 0);

  for (const entry of cases) {
    const fixturePath = String(entry.fixture_path ?? "");
    assert.ok(fixturePath, `${entry.id} fixture_path`);
    const fixture = JSON.parse(fs.readFileSync(`benchmarks/redline-visual-gate/${fixturePath}`, "utf8"));
    for (const pathKey of ["redline_path", "before_capture_path", "after_capture_path"]) {
      const assetPath = fixture[pathKey];
      if (typeof assetPath === "string" && assetPath.trim()) {
        assert.equal(fs.existsSync(`benchmarks/redline-visual-gate/${assetPath}`), true, `${entry.id} ${pathKey} exists`);
      }
    }
    const result = evaluateRedlineVisualVerificationGate(normalizeRedlineVisualVerificationGateInput(fixture));
    assert.equal(result.status, entry.expected_status, entry.id);
  }
});

test("redline visual gate normalizes camelCase tool input for device placement", () => {
  const input = normalizeRedlineVisualVerificationGateInput({
    actionType: "device_placement",
    authority: "hybrid",
    redlinePath: "artifacts/uploads/device.png",
    beforeCapturePath: "artifacts/captures/device-before.jpg",
    afterCapturePath: "artifacts/captures/device-after.jpg",
    visibleElementInventory: { beforeVisibleCount: 2, afterVisibleCount: 3 },
    intendedAction: { family: "Duplex Receptacle", roomNumber: "405" },
    intendedLocation: "room 405, east wall",
    observedLocation: "created element 6001, room 405, east wall",
    deterministicAssertions: [
      { name: "created_category", status: "pass", reason: "Created element is an electrical fixture." }
    ],
    landmarkRelationships: [
      { landmark: "east wall of Unit 405", relation: "device is mounted on wall", status: "pass", reason: "Created device is on the intended wall segment." }
    ]
  });
  const result = evaluateRedlineVisualVerificationGate(input);

  assert.equal(input.action_type, "device_placement");
  assert.equal(result.status, "pass");
  assert.equal(result.evidence.after_capture_path, "artifacts/captures/device-after.jpg");
  assert.deepEqual(result.evidence.visible_element_inventory, { beforeVisibleCount: 2, afterVisibleCount: 3 });
  assert.equal(result.intended_location, "room 405, east wall");
  assert.equal(result.observed_location, "created element 6001, room 405, east wall");
});

test("redline visual gate supports text note verification examples", () => {
  const result = evaluateRedlineVisualVerificationGate({
    action_type: "text_note",
    authority: "deterministic_geometry",
    after_capture_path: "artifacts/captures/text-after.jpg",
    deterministic_assertions: [
      { name: "text_content_matches", status: "pass", expected: "12x10 supply duct", observed: "12x10 supply duct", reason: "Text content matches the redline." },
      { name: "text_location_matches", status: "pass", reason: "Text note is inside the marked annotation region." }
    ],
    landmark_relationships: [
      { landmark: "marked callout box", relation: "text note lies within box", status: "pass", reason: "Text note bbox overlaps the intended callout region." }
    ]
  });

  assert.equal(result.status, "pass");
  assert.equal(result.action_type, "text_note");
});

test("redline visual gate returns uncertain for resize change without clear observed visual delta", () => {
  const result = evaluateRedlineVisualVerificationGate({
    action_type: "resize_change",
    authority: "hybrid",
    after_capture_path: "artifacts/captures/resize-after.jpg",
    deterministic_assertions: [
      { name: "parameter_readback_matches", status: "pass", expected: "10 in", observed: "10 in", reason: "Parameter readback matches requested size." },
      { name: "visual_delta_clear", status: "uncertain", reason: "The capture highlights the element but does not make the size change visually distinguishable." }
    ]
  });

  assert.equal(result.status, "uncertain");
  assert.match(result.reason, /does not make the size change visually distinguishable/i);
});
