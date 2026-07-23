import assert from "node:assert/strict";
import test from "node:test";
import { createCanvas } from "@napi-rs/canvas";
import { scoreSheetPixelEvidenceV1, scoreSheetPixelRouteEvidenceV1 } from "../src/existing_conditions/sheet_pixel_evidence.js";
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

test("host-selected chromatic point evidence rejects monochrome architectural false positives", () => {
  const canvas = createCanvas(180, 100);
  const context = canvas.getContext("2d");
  context.fillStyle = "white";
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.strokeStyle = "#788cff";
  context.lineWidth = 3;
  context.beginPath();
  context.arc(40, 50, 9, 0, Math.PI * 2);
  context.moveTo(40, 34);
  context.lineTo(40, 41);
  context.moveTo(40, 59);
  context.lineTo(40, 66);
  context.moveTo(24, 50);
  context.lineTo(31, 50);
  context.moveTo(49, 50);
  context.lineTo(56, 50);
  context.stroke();
  context.strokeStyle = "black";
  context.beginPath();
  context.moveTo(82, 42);
  context.lineTo(98, 58);
  context.moveTo(98, 42);
  context.lineTo(82, 58);
  context.stroke();
  const point = (primitive_id: string, x: number) => ({
    primitive_id,
    source_view_key: "view",
    source_mark_ids: [`mark-${primitive_id}`],
    kind: "point_symbol" as const,
    points: [{ u: x / (canvas.width - 1), v: 50 / (canvas.height - 1) }],
    endpoints: [],
    claims: {},
    confidence: { geometry: 0.99, classification: 0.5, topology: 1, visibility: 1 }
  });
  const primitives = [point("blue-symbol", 40), point("black-architecture", 90), point("blank", 140)];
  const input: SheetPixelInterpretationInputV1 = {
    schema_version: 1,
    package_id: "chromatic-point-evidence",
    coordinate_space: "normalized_uv_top_left",
    view_keys: ["view"],
    source_marks: primitives.map(value => ({
      source_mark_id: `mark-${value.primitive_id}`,
      source_view_key: "view",
      disposition: { status: "candidate", primitive_ids: [value.primitive_id] }
    })),
    primitives
  };
  const pixels = context.getImageData(0, 0, canvas.width, canvas.height);
  const result = scoreSheetPixelEvidenceV1({
    pixels: { width: canvas.width, height: canvas.height, data: pixels.data },
    interpretation: input,
    policy: {
      point_support_mode: "chromatic",
      point_radius_px: 20,
      point_minimum_supported_pixel_count: 8,
      point_provisional_supported_pixel_count: 4,
      point_expected_hue_degrees: 225,
      point_hue_tolerance_degrees: 30
    }
  });
  const evidence = new Map(result.point_evidence.map(item => [item.primitive_id, item]));
  assert.equal(evidence.get("blue-symbol")?.status, "accepted_raster_support");
  assert.equal(evidence.get("blue-symbol")?.support_modality, "chromatic_symbol");
  assert.ok((evidence.get("blue-symbol")?.coherent_hue_degrees ?? 0) >= 210);
  assert.equal(evidence.get("black-architecture")?.status, "rejected_raster_extent");
  assert.ok((evidence.get("black-architecture")?.monochrome_pixel_count ?? 0) > 0);
  assert.equal(evidence.get("blank")?.status, "rejected_raster_extent");
});
