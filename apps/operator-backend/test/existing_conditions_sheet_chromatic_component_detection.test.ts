import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createCanvas } from "@napi-rs/canvas";
import {
  detectSheetChromaticComponentsV1,
  renderSheetChromaticComponentOverlayV1,
  type SheetChromaticComponentDetectionInputV1
} from "../src/existing_conditions/sheet_chromatic_component_detection.js";

function sha256(filePath: string): string {
  return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

function fixture(): { directory: string; imagePath: string; input: SheetChromaticComponentDetectionInputV1 } {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "sheet-chromatic-components-"));
  const imagePath = path.join(directory, "source.png");
  const canvas = createCanvas(220, 100);
  const context = canvas.getContext("2d");
  context.fillStyle = "#ffffff";
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.strokeStyle = "hsl(225 100% 50%)";
  context.lineWidth = 3;
  for (const centerX of [35, 90, 145]) {
    context.beginPath();
    context.arc(centerX, 40, 9, 0, Math.PI * 2);
    context.moveTo(centerX - 12, 40);
    context.lineTo(centerX + 12, 40);
    context.moveTo(centerX, 28);
    context.lineTo(centerX, 52);
    context.stroke();
  }
  context.strokeStyle = "hsl(0 100% 45%)";
  context.beginPath();
  context.arc(185, 40, 9, 0, Math.PI * 2);
  context.stroke();
  context.strokeStyle = "hsl(225 100% 50%)";
  context.lineWidth = 2;
  context.beginPath();
  context.moveTo(5, 80);
  context.lineTo(210, 80);
  context.stroke();
  context.fillStyle = "hsl(225 100% 50%)";
  context.fillRect(205, 5, 1, 1);
  fs.writeFileSync(imagePath, canvas.toBuffer("image/png"));
  return {
    directory,
    imagePath,
    input: {
      schema_version: 1,
      source_image_path: imagePath,
      source_image_sha256: sha256(imagePath),
      source_image_width_px: canvas.width,
      source_image_height_px: canvas.height,
      search_region: { min: { x: 0, y: 0 }, max: { x: canvas.width, y: canvas.height } },
      expected_hue_degrees: 225,
      hue_tolerance_degrees: 15,
      minimum_chroma: 80,
      minimum_component_pixels: 20,
      maximum_component_pixels: 500,
      minimum_component_width_px: 12,
      maximum_component_width_px: 30,
      minimum_component_height_px: 12,
      maximum_component_height_px: 30,
      minimum_fill_fraction: 0.05
    }
  };
}

test("chromatic component detection finds repeated same-hue glyphs without assigning native meaning", async () => {
  const { input } = fixture();
  const receipt = await detectSheetChromaticComponentsV1(input);
  assert.equal(receipt.schema, "operator.sheet_chromatic_component_detection.v1");
  assert.equal(receipt.candidates.length, 3);
  assert.deepEqual(receipt.candidates.map(candidate => Math.round(candidate.center.x)), [35, 90, 145]);
  assert.ok(receipt.candidates.every(candidate => candidate.native_write_allowed === false));
  assert.ok(receipt.candidates.every(candidate => Math.abs(candidate.coherent_hue_degrees - 225) < 2));
  assert.ok(receipt.rejected_component_counts.width_out_of_range >= 1, "the long same-hue line must be rejected by shape bounds");
  assert.ok(receipt.rejected_component_counts.too_few_pixels >= 1, "isolated same-hue noise must not become a candidate");
  assert.match(receipt.capability_boundary, /do not establish discipline, family, type, host, circuit, system, topology, or write authority/i);
});

test("chromatic component overlay stays bound to the accepted source bytes", async () => {
  const { directory, imagePath, input } = fixture();
  const receipt = await detectSheetChromaticComponentsV1(input);
  const outputPath = path.join(directory, "overlay.png");
  const overlay = await renderSheetChromaticComponentOverlayV1({ source_image_path: imagePath, receipt, output_path: outputPath });
  assert.equal(overlay.sha256, sha256(outputPath));
  assert.ok(fs.statSync(outputPath).size > 0);
  fs.appendFileSync(imagePath, "changed");
  await assert.rejects(
    renderSheetChromaticComponentOverlayV1({ source_image_path: imagePath, receipt, output_path: path.join(directory, "invalid.png") }),
    /overlay_source_hash_mismatch/
  );
});

test("chromatic component detection rejects a stale source hash", async () => {
  const { input } = fixture();
  await assert.rejects(
    detectSheetChromaticComponentsV1({ ...input, source_image_sha256: "0".repeat(64) }),
    /source_image_hash_mismatch/
  );
});
