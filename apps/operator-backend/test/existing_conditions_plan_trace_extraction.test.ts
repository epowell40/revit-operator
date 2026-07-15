import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import test from "node:test";
import { createCanvas, type Canvas } from "@napi-rs/canvas";
import {
  extractPlanTraces,
  extractPlanTracesFromPixels,
  renderPlanTraceExtractionPreview,
  type PlanTraceExtractionInput
} from "../src/existing_conditions/plan_trace_extraction.js";

const HASH = "a".repeat(64);

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
