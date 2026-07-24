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

test("host-trusted seeds scope completeness to one connected same-hue route network", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "sheet-route-network-scope-"));
  const imagePath = path.join(directory, "source.png");
  const canvas = createCanvas(220, 120);
  const context = canvas.getContext("2d");
  context.fillStyle = "#ffffff";
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.strokeStyle = "hsl(0 100% 45%)";
  context.lineWidth = 3;
  context.beginPath();
  context.moveTo(20, 30);
  context.lineTo(100, 30);
  context.moveTo(120, 90);
  context.lineTo(200, 90);
  context.stroke();
  fs.writeFileSync(imagePath, canvas.toBuffer("image/png"));
  const input: SheetRouteChromaticCoverageInputV1 = {
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
    interpretation: {
      schema_version: 1,
      package_id: "candidate-network-a",
      coordinate_space: "normalized_uv_top_left",
      view_keys: ["sheet-a"],
      source_marks: [],
      primitives: [{
        primitive_id: "selected-route",
        source_view_key: "sheet-a",
        source_mark_ids: [],
        kind: "route_segment",
        points: [{ u: 20 / 220, v: 30 / 120 }, { u: 100 / 220, v: 30 / 120 }],
        confidence: { geometry: 0.9, classification: 0.5, topology: 0.5, visibility: 0.9 }
      }]
    }
  };

  const unscoped = await validateSheetRouteChromaticCoverageV1(input);
  assert.equal(unscoped.accepted, false);
  assert.ok(unscoped.coverage_fraction < 0.6);

  const scoped = await validateSheetRouteChromaticCoverageV1({
    ...input,
    network_scope: {
      mode: "seeded_connected_components",
      seed_points_uv: [{ u: 60 / 220, v: 30 / 120 }],
      seed_basis: "host_trusted_source_mark",
      seed_evidence_sha256: "a".repeat(64),
      seed_radius_px: 5,
      adjacency_radius_px: 1
    }
  });
  assert.equal(scoped.accepted, true);
  assert.ok(scoped.coverage_fraction > 0.95);
  assert.equal(scoped.network_scope?.seeded_component_count, 1);
  assert.ok((scoped.network_scope?.excluded_qualifying_chromatic_pixel_count ?? 0) > 0);
  assert.equal(scoped.all_search_region_qualifying_chromatic_pixel_count, unscoped.qualifying_chromatic_pixel_count);
  assert.match(scoped.capability_boundary, /host-trusted, hash-bound chromatic components/i);
});

test("network scope fails closed on unbound or out-of-region seeds", async () => {
  const { input } = fixture();
  await assert.rejects(
    validateSheetRouteChromaticCoverageV1({
      ...input,
      search_region: { min: { x: 0, y: 0 }, max: { x: 100, y: 100 } },
      network_scope: {
        mode: "seeded_connected_components",
        seed_points_uv: [{ u: 0.9, v: 0.9 }],
        seed_basis: "host_trusted_continuation_anchor",
        seed_evidence_sha256: "c".repeat(64)
      }
    }),
    /network_scope_seed_outside_search_region/
  );
  await assert.rejects(
    validateSheetRouteChromaticCoverageV1({
      ...input,
      network_scope: {
        mode: "seeded_connected_components",
        seed_points_uv: [{ u: 0.2, v: 0.2 }],
        seed_basis: "host_trusted_continuation_anchor",
        seed_evidence_sha256: "not-a-hash"
      }
    }),
    /network_scope_seed_evidence_sha256_must_be_sha256/
  );
  const noSeededComponent = await validateSheetRouteChromaticCoverageV1({
    ...input,
    network_scope: {
      mode: "seeded_connected_components",
      seed_points_uv: [{ u: 0.05, v: 0.05 }],
      seed_basis: "host_trusted_source_mark",
      seed_evidence_sha256: "b".repeat(64),
      seed_radius_px: 1
    }
  });
  assert.equal(noSeededComponent.accepted, false);
  assert.equal(noSeededComponent.qualifying_chromatic_pixel_count, 0);
  assert.equal(noSeededComponent.network_scope?.seeded_component_count, 0);
});
