import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createCanvas } from "@napi-rs/canvas";
import {
  renderSheetRouteChromaticCoverageOverlayV1,
  validateSheetRouteChromaticCoverageV1,
  type SheetRouteChromaticCoverageInputV1
} from "../src/existing_conditions/sheet_route_chromatic_coverage.js";

function sha256(filePath: string): string {
  return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

function fixture(candidateEndU = 0.9): { directory: string; imagePath: string; input: SheetRouteChromaticCoverageInputV1 } {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "sheet-route-chromatic-coverage-"));
  const imagePath = path.join(directory, "source.png");
  const canvas = createCanvas(200, 120);
  const context = canvas.getContext("2d");
  context.fillStyle = "#ffffff";
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.strokeStyle = "hsl(0 100% 45%)";
  context.lineWidth = 3;
  context.beginPath();
  context.moveTo(20, 50);
  context.lineTo(180, 50);
  context.moveTo(120, 50);
  context.lineTo(120, 105);
  context.stroke();
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
      source_view_key: "sheet-a",
      expected_hue_degrees: 0,
      hue_tolerance_degrees: 12,
      minimum_chroma: 80,
      route_buffer_radius_px: 5,
      minimum_coverage_fraction: 0.8,
      minimum_uncovered_component_pixels: 5,
      interpretation: {
        schema_version: 1,
        package_id: "candidate-a",
        coordinate_space: "normalized_uv_top_left",
        view_keys: ["sheet-a"],
        source_marks: [],
        primitives: [{
          primitive_id: "main",
          source_view_key: "sheet-a",
          source_mark_ids: [],
          kind: "route_segment",
          points: [{ u: 0.1, v: 50 / 120 }, { u: candidateEndU, v: 50 / 120 }],
          confidence: { geometry: 0.9, classification: 0.5, topology: 0.5, visibility: 0.9 }
        }]
      }
    }
  };
}

test("reverse chromatic coverage accepts a route that explains most source pixels", async () => {
  const { input } = fixture();
  input.interpretation.primitives.push({
    primitive_id: "branch",
    source_view_key: "sheet-a",
    source_mark_ids: [],
    kind: "route_segment",
    points: [{ u: 0.6, v: 50 / 120 }, { u: 0.6, v: 105 / 120 }],
    confidence: { geometry: 0.9, classification: 0.5, topology: 0.5, visibility: 0.9 }
  });
  const receipt = await validateSheetRouteChromaticCoverageV1(input);
  assert.equal(receipt.schema, "operator.sheet_route_chromatic_coverage.v1");
  assert.equal(receipt.accepted, true);
  assert.ok(receipt.coverage_fraction > 0.95);
  assert.equal(receipt.native_write_allowed, false);
  assert.match(receipt.capability_boundary, /do not establish discipline, system, size/i);
});

test("reverse chromatic coverage rejects a short candidate and locates missed source components", async () => {
  const { directory, imagePath, input } = fixture(0.35);
  const receipt = await validateSheetRouteChromaticCoverageV1(input);
  assert.equal(receipt.accepted, false);
  assert.ok(receipt.coverage_fraction < 0.5);
  assert.ok(receipt.uncovered_components.length >= 1);
  assert.equal(receipt.exact_next_repair, "reinterpret_uncovered_chromatic_regions_before_candidate_seal");
  const outputPath = path.join(directory, "overlay.png");
  const overlay = await renderSheetRouteChromaticCoverageOverlayV1({
    source_image_path: imagePath,
    interpretation: input.interpretation,
    receipt,
    output_path: outputPath
  });
  assert.equal(overlay.sha256, sha256(outputPath));
  assert.ok(fs.statSync(outputPath).size > 0);
});

test("reverse chromatic coverage rejects stale source and candidate hashes", async () => {
  const { directory, imagePath, input } = fixture();
  await assert.rejects(
    validateSheetRouteChromaticCoverageV1({ ...input, source_image_sha256: "0".repeat(64) }),
    /source_image_hash_mismatch/
  );
  const receipt = await validateSheetRouteChromaticCoverageV1(input);
  const changed = structuredClone(input.interpretation);
  changed.package_id = "changed";
  await assert.rejects(
    renderSheetRouteChromaticCoverageOverlayV1({
      source_image_path: imagePath,
      interpretation: changed,
      receipt,
      output_path: path.join(directory, "invalid.png")
    }),
    /overlay_interpretation_hash_mismatch/
  );
});
