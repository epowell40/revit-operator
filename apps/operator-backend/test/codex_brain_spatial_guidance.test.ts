import test from "node:test";
import assert from "node:assert/strict";
import { formatToolResultsForCodexForTest, getCodexBaseInstructionsForTest } from "../src/brains/codex_brain.js";

test("codex base instructions explicitly steer spatial export workflows", () => {
  const instructions = getCodexBaseInstructionsForTest();
  assert.match(instructions, /Spatial\/object-location rule:/);
  assert.match(instructions, /\/revit\/export-visible-elements/);
  assert.match(instructions, /\/revit\/pick-candidate-cluster/);
  assert.match(instructions, /host-aware\/exemplar-driven workflows/);
});

test("codex tool-result formatting includes compact spatial export summaries", () => {
  const formatted = formatToolResultsForCodexForTest([
    {
      action_id: "a1",
      method: "POST",
      path: "/revit/export-visible-elements",
      status: "done",
      result_json: {
        frameId: "frame-403",
        count: 2,
        items: [
          {
            elementId: 1465049,
            sourceScopedId: "host:1465049",
            categoryToken: "OST_ElectricalFixtures",
            hostBuiltInCategory: "OST_Walls",
            space: { number: "403", name: "Live/Work Unit 403" },
            anchor: {
              image: { x: 849.87, y: 796.4, normalizedX: 0.38648, normalizedY: 0.65171, insideFrame: true }
            },
            orientation: { planAzimuthRadians: 3.14159 }
          }
        ],
        mapping: {
          mode: "2d_affine",
          frameBasis: "exported_raster",
          rasterAspect: 1.7995,
          frameAspect: 1.7995,
          aspectCorrectionApplied: true,
          notes: "Per-element pixel/image coordinates are derived from the same exported-raster affine mapping used for the saved frame."
        }
      }
    }
  ] as any);

  assert.match(formatted, /result_json:/);
  assert.match(formatted, /"frameBasis":"exported_raster"/);
  assert.match(formatted, /"sourceScopedId":"host:1465049"/);
  assert.match(formatted, /"spaceCounts":\[\{"key":"403","count":1\}\]/);
});
