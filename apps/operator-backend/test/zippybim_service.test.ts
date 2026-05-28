import test from "node:test";
import assert from "node:assert/strict";
import { normalizeZippyBimPrediction } from "../src/zippybim/service.js";

test("normalizeZippyBimPrediction keeps valid walls/doors and summarizes counts", () => {
  const result = normalizeZippyBimPrediction(
    {
      metadata: {
        source: "ZippyBIM AI Reconstruction v2",
        units: "feet",
        raster_image: "abc123"
      },
      elements: [
        { element: "wall", path: [[0, 0], [10, 0]], thickness: 0.5 },
        { element: "door", position: [5, 0], width: 3, height: 7 },
        { element: "raw_segment", path: [[0, 0], [0, 8]] },
        { element: "wall", path: [[0, 0]] },
        { element: "door", position: ["x", 2] }
      ],
      debug: {
        door_detection_unavailable_reason: "door model not loaded"
      }
    },
    "artifacts/uploads/test.pdf",
    "test.pdf"
  );

  assert.equal(result.source_relative_path, "artifacts/uploads/test.pdf");
  assert.equal(result.summary.wall_count, 1);
  assert.equal(result.summary.door_count, 1);
  assert.equal(result.summary.raw_segment_count, 1);
  assert.deepEqual(result.summary.warnings, ["door model not loaded"]);
  assert.equal(result.geometry.elements.length, 3);
  assert.equal(result.geometry.metadata.raster_image, "abc123");
});

test("normalizeZippyBimPrediction warns when no valid wall segments are returned", () => {
  const result = normalizeZippyBimPrediction(
    {
      metadata: { source: "test" },
      elements: [{ element: "door", position: [1, 2] }]
    },
    "artifacts/uploads/test.pdf",
    "test.pdf"
  );

  assert.equal(result.summary.wall_count, 0);
  assert.ok(result.summary.warnings.includes("Prediction returned no wall segments."));
});
