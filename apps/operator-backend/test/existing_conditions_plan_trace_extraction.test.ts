import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import test from "node:test";
import { createCanvas, type Canvas } from "@napi-rs/canvas";
import {
  extractPlanTraces,
  extractPlanTracesFromPixels as extractPlanTracesFromBoundPixels,
  renderPlanTraceExtractionPreview,
  sha256PlanTracePixelBuffer,
  type PlanTraceExtractionInput,
  type PlanTracePixelBuffer,
  type PlanTracePixelExtractionInput
} from "../src/existing_conditions/plan_trace_extraction.js";

const HASH = "a".repeat(64);

function extractPlanTracesFromPixels(
  pixels: PlanTracePixelBuffer,
  input: Omit<PlanTracePixelExtractionInput, "source_pixel_sha256">
) {
  return extractPlanTracesFromBoundPixels(pixels, {
    ...input,
    source_pixel_sha256: sha256PlanTracePixelBuffer(pixels)
  });
}

function rgbaFixture(): { width: number; height: number; data: Uint8ClampedArray } {
  const canvas = createCanvas(120, 90);
  const context = canvas.getContext("2d");
  context.fillStyle = "#ffffff";
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.strokeStyle = "rgb(20, 180, 70)";
  context.lineWidth = 5;
  context.lineCap = "square";
  context.beginPath();
  context.moveTo(15, 20);
  context.lineTo(95, 20);
  context.lineTo(95, 70);
  context.moveTo(55, 20);
  context.lineTo(55, 55);
  context.stroke();
  context.fillStyle = "rgb(20, 180, 70)";
  context.fillRect(8, 75, 2, 2);
  const image = context.getImageData(0, 0, canvas.width, canvas.height);
  return { width: canvas.width, height: canvas.height, data: image.data };
}

function extractionInput(): Omit<PlanTraceExtractionInput, "source_image_path"> {
  return {
    schema_version: 1,
    source_image_sha256: HASH,
    target_rgb: { r: 20, g: 180, b: 70 },
    maximum_color_distance: 20,
    minimum_chroma: 80,
    minimum_component_pixels: 20,
    simplify_tolerance_px: 1,
    scope_polygon: [{ x: 5, y: 5 }, { x: 110, y: 5 }, { x: 110, y: 80 }, { x: 5, y: 80 }]
  };
}

function pixelsFromCanvas(canvas: Canvas): { width: number; height: number; data: Uint8ClampedArray } {
  const image = canvas.getContext("2d").getImageData(0, 0, canvas.width, canvas.height);
  return { width: canvas.width, height: canvas.height, data: image.data };
}

function topologyInput(): Omit<PlanTraceExtractionInput, "source_image_path"> {
  return {
    schema_version: 1,
    source_image_sha256: HASH,
    target_rgb: { r: 20, g: 180, b: 70 },
    maximum_color_distance: 20,
    minimum_chroma: 80,
    minimum_component_pixels: 10,
    simplify_tolerance_px: 0
  };
}

test("extracts a thick branched route as one centerline component and rejects short color noise", () => {
  const receipt = extractPlanTracesFromPixels(rgbaFixture(), extractionInput());
  assert.equal(receipt.components.length, 1);
  assert.equal(receipt.retained_pixel_count < receipt.matched_pixel_count, true);
  assert.equal(receipt.components[0]!.pixel_count > 500, true);
  assert.equal(receipt.components[0]!.polylines.length, 3);
  assert.equal(receipt.components[0]!.polylines.some((line) => line.length_px > 35), true);
  const points = receipt.components[0]!.polylines.flatMap((line) => line.points);
  assert.equal(points.some((point) => Math.hypot(point.x - 15, point.y - 20) <= 4), true);
  assert.equal(points.some((point) => Math.hypot(point.x - 95, point.y - 70) <= 4), true);
  assert.match(receipt.usage_constraints.join(" "), /does not establish.*venting topology/i);
});

test("pixel-level extraction rejects altered RGBA bytes under a frozen pixel digest", () => {
  const original = rgbaFixture();
  const sourcePixelSha256 = sha256PlanTracePixelBuffer(original);
  const altered = { ...original, data: new Uint8ClampedArray(original.data) };
  altered.data[0] = altered.data[0] === 255 ? 254 : altered.data[0] + 1;

  assert.throws(
    () => extractPlanTracesFromBoundPixels(altered, {
      ...extractionInput(),
      source_pixel_sha256: sourcePixelSha256
    }),
    /source_pixel_sha256_mismatch/
  );
});

test("derives the target RGB from explicit hash-bound source pixels", () => {
  const fixture = rgbaFixture();
  const { target_rgb: _targetRgb, ...base } = extractionInput();
  const receipt = extractPlanTracesFromPixels(fixture, {
    ...base,
    target_rgb_sample_points: [{ x: 30, y: 20 }, { x: 55, y: 40 }, { x: 95, y: 60 }]
  });
  assert.deepEqual(receipt.extraction_policy.target_rgb, { r: 20, g: 180, b: 70 });
  assert.deepEqual(receipt.extraction_policy.target_rgb_sample_points, [
    { x: 30, y: 20 },
    { x: 55, y: 40 },
    { x: 95, y: 60 }
  ]);
  assert.deepEqual(
    receipt.extraction_policy.target_rgb_sample_values?.map((entry) => entry.rgb),
    [
      { r: 20, g: 180, b: 70 },
      { r: 20, g: 180, b: 70 },
      { r: 20, g: 180, b: 70 }
    ]
  );
  assert.equal(receipt.components.length, 1);
  assert.match(receipt.extraction_policy_sha256, /^[a-f0-9]{64}$/);
});

test("sampled target RGB fails closed for ambiguous, invalid, or non-chromatic samples", () => {
  const fixture = rgbaFixture();
  assert.throws(
    () => extractPlanTracesFromPixels(fixture, {
      ...extractionInput(),
      target_rgb_sample_points: [{ x: 30, y: 20 }]
    }),
    /exactly_one_plan_trace_pixel_selector_is_required/
  );
  const { target_rgb: _targetRgb, ...base } = extractionInput();
  assert.throws(
    () => extractPlanTracesFromPixels(fixture, base),
    /exactly_one_plan_trace_pixel_selector_is_required/
  );
  assert.throws(
    () => extractPlanTracesFromPixels(fixture, {
      ...base,
      target_rgb_sample_points: [{ x: 120, y: 20 }]
    }),
    /target_rgb_sample_point_0_x_must_be_integer_between_0_and_119/
  );
  assert.throws(
    () => extractPlanTracesFromPixels(fixture, {
      ...base,
      target_rgb_sample_points: [{ x: 0, y: 0 }]
    }),
    /target_rgb_sample_point_chroma_below_minimum:0/
  );
});

test("extracts monochrome ink without depending on drawing color", () => {
  const canvas = createCanvas(120, 70);
  const context = canvas.getContext("2d");
  context.fillStyle = "#ffffff";
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.lineWidth = 3;
  context.strokeStyle = "rgb(0, 0, 0)";
  context.beginPath();
  context.moveTo(10, 20);
  context.lineTo(110, 20);
  context.stroke();
  context.strokeStyle = "rgb(90, 90, 90)";
  context.setLineDash([12, 8]);
  context.beginPath();
  context.moveTo(10, 42);
  context.lineTo(110, 42);
  context.stroke();
  context.setLineDash([]);
  context.strokeStyle = "rgb(180, 0, 0)";
  context.beginPath();
  context.moveTo(10, 58);
  context.lineTo(110, 58);
  context.stroke();

  const receipt = extractPlanTracesFromPixels(pixelsFromCanvas(canvas), {
    schema_version: 1,
    source_image_sha256: HASH,
    monochrome_ink: { maximum_luminance: 120, maximum_chroma: 8 },
    minimum_component_pixels: 8,
    simplify_tolerance_px: 0,
    line_style_analysis: {
      maximum_angle_difference_degrees: 5,
      maximum_perpendicular_offset_px: 2,
      maximum_gap_px: 12,
      minimum_dash_segments: 3
    }
  });
  assert.deepEqual(receipt.extraction_policy.monochrome_ink, {
    maximum_luminance: 120,
    maximum_chroma: 8
  });
  assert.equal(receipt.extraction_policy.target_rgb, undefined);
  const points = receipt.components.flatMap((component) => component.polylines.flatMap((line) => line.points));
  assert.equal(points.some((point) => Math.abs(point.y - 20) <= 2), true);
  assert.equal(points.some((point) => Math.abs(point.y - 42) <= 2), true);
  assert.equal(points.some((point) => Math.abs(point.y - 58) <= 2), false);
  assert.equal(receipt.line_style_hypotheses?.length, 1);
  assert.equal(receipt.line_style_hypotheses?.[0]?.style, "dashed_candidate");
  assert.equal((receipt.line_style_hypotheses?.[0]?.segment_count ?? 0) >= 3, true);
  assert.equal(Math.abs(receipt.line_style_hypotheses?.[0]?.orientation_degrees ?? 90) <= 1, true);
  assert.equal((receipt.line_style_hypotheses?.[0]?.median_gap_px ?? 0) > 0, true);
  assert.match(receipt.usage_constraints.join(" "), /color is optional corroboration/i);
  assert.match(receipt.usage_constraints.join(" "), /clear monochrome geometry.*editable provisional route/i);
  assert.match(receipt.usage_constraints.join(" "), /legend.*required.*classify/i);
  assert.match(receipt.extraction_policy_sha256, /^[a-f0-9]{64}$/);
});

test("monochrome selector is mutually exclusive with color selectors", () => {
  assert.throws(
    () => extractPlanTracesFromPixels(rgbaFixture(), {
      ...extractionInput(),
      monochrome_ink: { maximum_luminance: 120, maximum_chroma: 8 }
    }),
    /exactly_one_plan_trace_pixel_selector_is_required/
  );
  assert.throws(
    () => extractPlanTracesFromPixels(rgbaFixture(), {
      schema_version: 1,
      source_image_sha256: HASH,
      monochrome_ink: { maximum_luminance: 300, maximum_chroma: 8 }
    }),
    /monochrome_ink_maximum_luminance_out_of_range/
  );
  assert.throws(
    () => extractPlanTracesFromPixels(rgbaFixture(), {
      schema_version: 1,
      source_image_sha256: HASH,
      monochrome_ink: { maximum_luminance: 120, maximum_chroma: 8 },
      line_style_analysis: {
        maximum_angle_difference_degrees: 5,
        maximum_perpendicular_offset_px: 2,
        maximum_gap_px: 12,
        minimum_dash_segments: 2
      }
    }),
    /line_style_minimum_dash_segments_out_of_range/
  );
});

test("collapses thick X-junction pixels into exactly four branches", () => {
  const canvas = createCanvas(101, 101);
  const context = canvas.getContext("2d");
  context.fillStyle = "#ffffff";
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.strokeStyle = "rgb(20, 180, 70)";
  context.lineWidth = 7;
  context.beginPath();
  context.moveTo(10, 10);
  context.lineTo(90, 90);
  context.moveTo(90, 10);
  context.lineTo(10, 90);
  context.stroke();
  const receipt = extractPlanTracesFromPixels(pixelsFromCanvas(canvas), topologyInput());
  assert.equal(receipt.components.length, 1);
  assert.equal(receipt.components[0]!.polylines.length, 4);
  assert.equal(receipt.components[0]!.polylines.every((line) => line.closed === false), true);
  assert.equal(receipt.components[0]!.polylines.every((line) => line.length_px > 40), true);
});

test("preserves a pure loop and collapses a lollipop attachment without an internal junction edge", () => {
  const pureLoop = createCanvas(101, 101);
  const pureContext = pureLoop.getContext("2d");
  pureContext.fillStyle = "#ffffff";
  pureContext.fillRect(0, 0, pureLoop.width, pureLoop.height);
  pureContext.strokeStyle = "rgb(20, 180, 70)";
  pureContext.lineWidth = 5;
  pureContext.beginPath();
  pureContext.arc(50, 50, 28, 0, Math.PI * 2);
  pureContext.stroke();
  const pureReceipt = extractPlanTracesFromPixels(pixelsFromCanvas(pureLoop), topologyInput());
  assert.equal(pureReceipt.components[0]!.polylines.length, 1);
  assert.equal(pureReceipt.components[0]!.polylines[0]!.closed, true);

  const lollipop = createCanvas(101, 115);
  const lollipopContext = lollipop.getContext("2d");
  lollipopContext.fillStyle = "#ffffff";
  lollipopContext.fillRect(0, 0, lollipop.width, lollipop.height);
  lollipopContext.strokeStyle = "rgb(20, 180, 70)";
  lollipopContext.lineWidth = 5;
  lollipopContext.beginPath();
  lollipopContext.arc(50, 45, 28, 0, Math.PI * 2);
  lollipopContext.moveTo(50, 73);
  lollipopContext.lineTo(50, 105);
  lollipopContext.stroke();
  const lollipopReceipt = extractPlanTracesFromPixels(pixelsFromCanvas(lollipop), topologyInput());
  assert.equal(lollipopReceipt.components.length, 1);
  assert.equal(lollipopReceipt.components[0]!.polylines.length, 2);
  assert.equal(lollipopReceipt.components[0]!.polylines.filter((line) => line.closed).length, 1);
});

test("does not invent continuity across a dashed plan trace", () => {
  const canvas = createCanvas(120, 40);
  const context = canvas.getContext("2d");
  context.fillStyle = "#ffffff";
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.strokeStyle = "rgb(20, 180, 70)";
  context.lineWidth = 3;
  context.beginPath();
  context.moveTo(10, 20);
  context.lineTo(50, 20);
  context.moveTo(70, 20);
  context.lineTo(110, 20);
  context.stroke();
  const receipt = extractPlanTracesFromPixels(pixelsFromCanvas(canvas), topologyInput());
  assert.equal(receipt.components.length, 2);
  assert.equal(receipt.components.every((component) => component.polylines.length === 1), true);
});

test("preserves distinct raw branches when simplification would collapse them to duplicate endpoints", () => {
  const canvas = createCanvas(90, 70);
  const context = canvas.getContext("2d");
  context.fillStyle = "#ffffff";
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.strokeStyle = "rgb(20, 180, 70)";
  context.lineWidth = 3;
  context.beginPath();
  context.moveTo(8, 35);
  context.lineTo(28, 35);
  context.lineTo(43, 29);
  context.lineTo(58, 35);
  context.lineTo(43, 41);
  context.lineTo(28, 35);
  context.moveTo(58, 35);
  context.lineTo(80, 35);
  context.stroke();
  const receipt = extractPlanTracesFromPixels(pixelsFromCanvas(canvas), {
    ...topologyInput(),
    simplify_tolerance_px: 8
  });
  const keys = receipt.components[0]!.polylines.map((polyline) => {
    const encode = (points: typeof polyline.points) => points.map((point) => `${point.x},${point.y}`).join(";");
    const forward = encode(polyline.points);
    const reverse = encode([...polyline.points].reverse());
    return forward < reverse ? forward : reverse;
  });
  assert.equal(new Set(keys).size, keys.length);
  assert.equal(receipt.components[0]!.polylines.some((polyline) => polyline.points.length > 2), true);
});

test("derives one centerline from a solid outlined network instead of promoting both boundaries", () => {
  const canvas = createCanvas(140, 90);
  const context = canvas.getContext("2d");
  context.fillStyle = "#ffffff";
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.strokeStyle = "rgb(20, 180, 70)";
  context.lineWidth = 3;
  context.strokeRect(15, 25, 105, 30);
  const receipt = extractPlanTracesFromPixels(pixelsFromCanvas(canvas), {
    ...topologyInput(),
    interpretation_mode: "outlined_network_centerline",
    maximum_interior_span_px: 40,
    minimum_parallel_support_px: 20,
    simplify_tolerance_px: 2
  });
  assert.equal(receipt.components.length, 1);
  assert.equal((receipt.derived_fill_pixel_count ?? 0) > 2_000, true);
  const longLines = receipt.components[0]!.polylines.filter((polyline) => polyline.length_px > 70);
  assert.equal(longLines.length, 1);
  const meanY = longLines[0]!.points.reduce((sum, point) => sum + point.y, 0) / longLines[0]!.points.length;
  assert.equal(Math.abs(meanY - 40) <= 2, true);
  assert.equal(longLines[0]!.points.some((point) => Math.abs(point.y - 25) <= 2), false);
  assert.equal(longLines[0]!.points.some((point) => Math.abs(point.y - 55) <= 2), false);
  assert.match(receipt.usage_constraints.join(" "), /connected symbols.*explicit source accounting/i);
});

test("outlined-network mode does not bridge short dashed boundary fragments without parallel support", () => {
  const canvas = createCanvas(140, 90);
  const context = canvas.getContext("2d");
  context.fillStyle = "#ffffff";
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.strokeStyle = "rgb(20, 180, 70)";
  context.lineWidth = 3;
  context.setLineDash([8, 12]);
  context.beginPath();
  context.moveTo(10, 25);
  context.lineTo(130, 25);
  context.moveTo(10, 55);
  context.lineTo(130, 55);
  context.stroke();
  const receipt = extractPlanTracesFromPixels(pixelsFromCanvas(canvas), {
    ...topologyInput(),
    interpretation_mode: "outlined_network_centerline",
    maximum_interior_span_px: 40,
    minimum_parallel_support_px: 15,
    simplify_tolerance_px: 1
  });
  assert.equal(receipt.derived_fill_pixel_count, 0);
  assert.equal(receipt.components.length > 2, true);
});

test("outlined-network parameters fail closed outside their explicit mode", () => {
  assert.throws(
    () => extractPlanTracesFromPixels(rgbaFixture(), { ...extractionInput(), maximum_interior_span_px: 30 }),
    /parameters_require_outlined_network_centerline_mode/
  );
  assert.throws(
    () => extractPlanTracesFromPixels(rgbaFixture(), {
      ...extractionInput(),
      interpretation_mode: "outlined_network_centerline"
    }),
    /maximum_interior_span_px_must_be_finite/
  );
});

test("scope and color policy prevent unrelated or low-chroma lines from entering the trace", () => {
  const fixture = rgbaFixture();
  const outsideScope = extractPlanTracesFromPixels(fixture, {
    ...extractionInput(),
    scope_polygon: [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 }]
  });
  assert.equal(outsideScope.components.length, 0);
  const impossibleChroma = extractPlanTracesFromPixels(fixture, { ...extractionInput(), minimum_chroma: 250 });
  assert.equal(impossibleChroma.matched_pixel_count, 0);
  assert.throws(
    () => extractPlanTracesFromPixels(fixture, { ...extractionInput(), source_image_sha256: "not-a-hash" }),
    /must_be_sha256/
  );
  assert.throws(
    () => extractPlanTracesFromPixels(fixture, {
      ...extractionInput(),
      scope_polygon: [{ x: 0, y: 0 }, { x: 100, y: 80 }, { x: 100, y: 0 }, { x: 0, y: 80 }]
    }),
    /scope_polygon_(has_zero_area|self_intersects)/
  );
  assert.throws(
    () => extractPlanTracesFromPixels(fixture, {
      ...extractionInput(),
      scope_polygon: [{ x: 0, y: 0 }, { x: 120, y: 0 }, { x: 121, y: 90 }]
    }),
    /scope_polygon_vertex_outside_image/
  );
});

test("file extraction is bound to the exact source image hash", async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "plan-trace-extraction-"));
  try {
    const filePath = path.join(temp, "trace.png");
    const fixture = rgbaFixture();
    const canvas = createCanvas(fixture.width, fixture.height);
    const context = canvas.getContext("2d");
    const imageData = context.createImageData(fixture.width, fixture.height);
    imageData.data.set(fixture.data);
    context.putImageData(imageData, 0, 0);
    fs.writeFileSync(filePath, canvas.toBuffer("image/png"));
    const actualHash = crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
    const extractionPromise = extractPlanTraces({
      ...extractionInput(),
      source_image_path: filePath,
      source_image_sha256: actualHash
    });
    const replacement = createCanvas(fixture.width, fixture.height);
    replacement.getContext("2d").fillStyle = "#ff0000";
    replacement.getContext("2d").fillRect(0, 0, fixture.width, fixture.height);
    fs.writeFileSync(filePath, replacement.toBuffer("image/png"));
    const receipt = await extractionPromise;
    assert.equal(receipt.source_image_sha256, actualHash);
    assert.match(receipt.source_pixel_sha256 ?? "", /^[a-f0-9]{64}$/);
    assert.equal(receipt.matched_pixel_count > 0, true);
    assert.match(receipt.extraction_policy_sha256, /^[a-f0-9]{64}$/);

    fs.writeFileSync(filePath, canvas.toBuffer("image/png"));
    const previewPath = path.join(temp, "trace-preview.png");
    const previewPromise = renderPlanTraceExtractionPreview(filePath, receipt, previewPath);
    fs.writeFileSync(filePath, replacement.toBuffer("image/png"));
    const preview = await previewPromise;
    assert.equal(fs.existsSync(previewPath), true);
    assert.equal(preview.sha256, crypto.createHash("sha256").update(fs.readFileSync(previewPath)).digest("hex"));
    await assert.rejects(
      () => extractPlanTraces({ ...extractionInput(), source_image_path: filePath }),
      /source_image_sha256_mismatch/
    );
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});
