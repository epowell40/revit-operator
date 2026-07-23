import assert from "node:assert/strict";
import test from "node:test";
import { createCanvas } from "@napi-rs/canvas";
import { scoreSheetPixelRouteEvidenceV1 } from "../src/existing_conditions/sheet_pixel_evidence.js";
import type { SheetPixelInterpretationInputV1 } from "../src/existing_conditions/sheet_pixel_interpretation.js";

function interpretation(): SheetPixelInterpretationInputV1 {
  const primitive = (primitive_id: string, points: Array<{ u: number; v: number }>) => ({
    primitive_id,
    source_view_key: "view",
    source_mark_ids: [`mark-${primitive_id}`],
    kind: "route_segment" as const,
    points,
    endpoints: [],
    claims: {},
    confidence: { geometry: 0.99, classification: 0.99, topology: 0.99, visibility: 0.99 }
  });
  return {
    schema_version: 1,
    package_id: "pixel-evidence",
    coordinate_space: "normalized_uv_top_left",
    view_keys: ["view"],
    source_marks: [
      { source_mark_id: "mark-supported", source_view_key: "view", disposition: { status: "candidate", primitive_ids: ["supported"] } },
      { source_mark_id: "mark-overextended", source_view_key: "view", disposition: { status: "candidate", primitive_ids: ["overextended"] } },
      { source_mark_id: "mark-blank", source_view_key: "view", disposition: { status: "candidate", primitive_ids: ["blank"] } }
    ],
    primitives: [
      primitive("supported", [{ u: 0.1, v: 0.25 }, { u: 0.9, v: 0.25 }]),
      primitive("overextended", [{ u: 0.5, v: 0.45 }, { u: 0.5, v: 0.95 }]),
      primitive("blank", [{ u: 0.1, v: 0.8 }, { u: 0.9, v: 0.8 }])
    ]
  };
}

test("raster evidence accepts supported routes and rejects blank or overextended spans", () => {
  const canvas = createCanvas(200, 120);
  const context = canvas.getContext("2d");
  context.fillStyle = "white";
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.strokeStyle = "black";
  context.lineWidth = 3;
  context.beginPath();
  context.moveTo(20, 30);
  context.lineTo(180, 30);
  context.moveTo(100, 54);
  context.lineTo(100, 72);
  context.stroke();
  const pixels = context.getImageData(0, 0, canvas.width, canvas.height);
  const result = scoreSheetPixelRouteEvidenceV1({
    pixels: { width: canvas.width, height: canvas.height, data: pixels.data },
    interpretation: interpretation(),
    policy: { corridor_radius_px: 3 }
  });

  const evidence = new Map(result.route_evidence.map(item => [item.primitive_id, item]));
  assert.equal(evidence.get("supported")?.status, "accepted_raster_support");
  assert.equal(evidence.get("overextended")?.status, "rejected_raster_extent");
  assert.ok((evidence.get("overextended")?.longest_unsupported_run_fraction ?? 0) > 0.5);
  assert.equal(evidence.get("blank")?.status, "rejected_raster_extent");
});

test("raw model confidence cannot override missing raster support", () => {
  const canvas = createCanvas(100, 100);
  const context = canvas.getContext("2d");
  context.fillStyle = "white";
  context.fillRect(0, 0, 100, 100);
  const pixels = context.getImageData(0, 0, 100, 100);
  const input = interpretation();
  input.primitives = [input.primitives[2]!];
  input.source_marks = [input.source_marks[2]!];

  const result = scoreSheetPixelRouteEvidenceV1({ pixels: { width: 100, height: 100, data: pixels.data }, interpretation: input });
  assert.equal(result.route_evidence[0]?.status, "rejected_raster_extent");
});

test("chromatic routes use coherent hue support and do not inherit black-symbol overlap", () => {
  const canvas = createCanvas(200, 120);
  const context = canvas.getContext("2d");
  context.fillStyle = "white";
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.strokeStyle = "#00ff00";
  context.lineWidth = 3;
  context.beginPath();
  context.moveTo(20, 30);
  context.lineTo(180, 30);
  context.moveTo(68, 70);
  context.lineTo(80, 70);
  context.stroke();
  context.strokeStyle = "black";
  context.beginPath();
  context.moveTo(20, 70);
  context.lineTo(80, 70);
  context.stroke();
  const pixels = context.getImageData(0, 0, canvas.width, canvas.height);
  const input = interpretation();
  input.source_marks = [
    { source_mark_id: "mark-colored", source_view_key: "view", disposition: { status: "candidate", primitive_ids: ["colored"] } },
    { source_mark_id: "mark-black-overlap", source_view_key: "view", disposition: { status: "candidate", primitive_ids: ["black-overlap"] } }
  ];
  input.primitives = [
    {
      ...input.primitives[0]!,
      primitive_id: "colored",
      source_mark_ids: ["mark-colored"],
      points: [{ u: 0.1, v: 0.25 }, { u: 0.9, v: 0.25 }]
    },
    {
      ...input.primitives[0]!,
      primitive_id: "black-overlap",
      source_mark_ids: ["mark-black-overlap"],
      points: [{ u: 0.1, v: 70 / 120 }, { u: 0.4, v: 70 / 120 }]
    }
  ];

  const result = scoreSheetPixelRouteEvidenceV1({
    pixels: { width: canvas.width, height: canvas.height, data: pixels.data },
    interpretation: input,
    policy: { corridor_radius_px: 3 }
  });
  const evidence = new Map(result.route_evidence.map(item => [item.primitive_id, item]));
  assert.equal(evidence.get("colored")?.support_modality, "chromatic_line");
  assert.equal(evidence.get("colored")?.status, "accepted_raster_support");
  assert.ok(Math.abs((evidence.get("colored")?.coherent_hue_degrees ?? 0) - 120) <= 15);
  assert.equal(evidence.get("black-overlap")?.support_modality, "chromatic_line");
  assert.equal(evidence.get("black-overlap")?.status, "rejected_raster_extent");
  assert.equal(evidence.get("black-overlap")?.monochrome_support_fraction, 1);
});
