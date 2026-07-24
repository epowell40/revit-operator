import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createCanvas } from "@napi-rs/canvas";
import { evaluateSourceNativePairHealthV1, type SourceNativePairHealthInputV1, type SourceNativePairRouteV1 } from "../src/existing_conditions/source_native_pair_health.js";

function write(directory: string, name: string, value: Buffer | string): { path: string; sha256: string } {
  const outputPath = path.join(directory, name);
  fs.writeFileSync(outputPath, value);
  return { path: outputPath, sha256: crypto.createHash("sha256").update(fs.readFileSync(outputPath)).digest("hex") };
}

function fixture(nativeRoutes?: SourceNativePairRouteV1[]): SourceNativePairHealthInputV1 {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "source-native-pair-health-"));
  const canvas = createCanvas(200, 120);
  const context = canvas.getContext("2d");
  context.fillStyle = "white";
  context.fillRect(0, 0, 200, 120);
  const image = write(directory, "source.png", canvas.toBuffer("image/png"));
  const sourceArtifact = write(directory, "source-routes.json", "source truth\n");
  const nativeArtifact = write(directory, "native-routes.json", "native truth\n");
  const sourceRoutes: SourceNativePairRouteV1[] = [
    { route_id: "main", points: [{ x: 20, y: 60 }, { x: 180, y: 60 }] },
    { route_id: "branch", points: [{ x: 100, y: 60 }, { x: 100, y: 20 }] }
  ];
  return {
    schema_version: 1,
    fixture_id: "pair-health-test",
    source_image_path: image.path,
    source_image_sha256: image.sha256,
    source_image_width_px: 200,
    source_image_height_px: 120,
    evaluator_source_routes: { artifact_path: sourceArtifact.path, artifact_sha256: sourceArtifact.sha256, coordinate_space: "source_pixel_top_left", routes: sourceRoutes },
    registered_native_routes: { artifact_path: nativeArtifact.path, artifact_sha256: nativeArtifact.sha256, coordinate_space: "source_pixel_top_left", routes: nativeRoutes ?? sourceRoutes },
    policy: { diagnostic_translation_maximum_px: 50, diagnostic_translation_coarse_step_px: 10, diagnostic_translation_fine_step_px: 1 }
  };
}

test("pair-health gate releases an exact registered source/native pair", async () => {
  const receipt = await evaluateSourceNativePairHealthV1(fixture());
  assert.equal(receipt.status, "pair_healthy");
  assert.equal(receipt.candidate_release_allowed, true);
  assert.equal(receipt.source_to_native.coverage_fraction, 1);
  assert.equal(receipt.native_to_source.coverage_fraction, 1);
  assert.equal(receipt.best_translation_diagnostic, null);
  assert.equal(receipt.evaluator_only, true);
  assert.equal(receipt.native_write_allowed, false);
});

test("pair-health gate rejects a translated pair and keeps translation diagnostic-only", async () => {
  const shifted: SourceNativePairRouteV1[] = [
    { route_id: "native-main", points: [{ x: 40, y: 50 }, { x: 200, y: 50 }] },
    { route_id: "native-branch", points: [{ x: 120, y: 50 }, { x: 120, y: 10 }] }
  ];
  const receipt = await evaluateSourceNativePairHealthV1(fixture(shifted));
  assert.equal(receipt.status, "pair_rejected");
  assert.equal(receipt.candidate_release_allowed, false);
  assert.ok(receipt.failed_gates.includes("source_to_native_coverage_below_minimum"));
  assert.ok(receipt.best_translation_diagnostic);
  assert.ok(Math.abs(receipt.best_translation_diagnostic!.dx_px + 20) <= 1);
  assert.ok(Math.abs(receipt.best_translation_diagnostic!.dy_px - 10) <= 1);
  assert.equal(receipt.best_translation_diagnostic!.acceptance_use, "diagnostic_only_never_candidate_repair_or_credit");
  assert.match(receipt.capability_boundary, /never exposes truth to the candidate/i);
});

test("pair-health gate rejects stale evaluator artifacts before measuring geometry", async () => {
  const input = fixture();
  input.evaluator_source_routes.artifact_sha256 = "0".repeat(64);
  await assert.rejects(evaluateSourceNativePairHealthV1(input), /source_route_artifact_hash_mismatch/);
});
