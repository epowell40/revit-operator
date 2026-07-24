import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createCanvas } from "@napi-rs/canvas";
import { compileSheetOverlapRoutesV1, type SheetOverlapRouteCompilationInputV1, type SheetOverlapRouteTileV1 } from "../src/existing_conditions/sheet_overlap_route_compiler.js";
import type { SheetPixelInterpretationInputV1, SheetPixelPrimitiveV1 } from "../src/existing_conditions/sheet_pixel_interpretation.js";
import type { SheetRouteChromaticCoverageReceiptV1 } from "../src/existing_conditions/sheet_route_chromatic_coverage.js";

function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object).sort().map(key => `${JSON.stringify(key)}:${canonical(object[key])}`).join(",")}}`;
}

function digest(value: unknown): string {
  return crypto.createHash("sha256").update(canonical(value)).digest("hex");
}

function writeImage(directory: string, name: string, width: number, height: number): { path: string; sha256: string } {
  const outputPath = path.join(directory, name);
  const canvas = createCanvas(width, height);
  const context = canvas.getContext("2d");
  context.fillStyle = "#fff";
  context.fillRect(0, 0, width, height);
  const output = canvas.toBuffer("image/png");
  fs.writeFileSync(outputPath, output);
  return { path: outputPath, sha256: crypto.createHash("sha256").update(output).digest("hex") };
}

function primitive(id: string, viewKey: string, points: Array<{ u: number; v: number }>, system = "hydronic supply"): SheetPixelPrimitiveV1 {
  return {
    primitive_id: id,
    source_view_key: viewKey,
    source_mark_ids: [`mark-${id}`],
    kind: "route_segment",
    points,
    claims: { system: { value: system, confidence: 0.95, basis: "legible_source_evidence" } },
    confidence: { geometry: 0.95, classification: 0.95, topology: 0.9, visibility: 0.95 }
  };
}

function tile(args: { directory: string; viewKey: string; bounds: { min: { x: number; y: number }; max: { x: number; y: number } }; primitives: SheetPixelPrimitiveV1[] }): SheetOverlapRouteTileV1 {
  const width = (args.bounds.max.x - args.bounds.min.x) * 2;
  const height = (args.bounds.max.y - args.bounds.min.y) * 2;
  const image = writeImage(args.directory, `${args.viewKey}.png`, width, height);
  const interpretation: SheetPixelInterpretationInputV1 = {
    schema_version: 1,
    package_id: `package-${args.viewKey}`,
    coordinate_space: "normalized_uv_top_left",
    view_keys: [args.viewKey],
    source_marks: args.primitives.map(value => ({ source_mark_id: value.source_mark_ids[0]!, source_view_key: args.viewKey, disposition: { status: "candidate", primitive_ids: [value.primitive_id] } })),
    primitives: args.primitives
  };
  const receipt: SheetRouteChromaticCoverageReceiptV1 = {
    schema: "operator.sheet_route_chromatic_coverage.v1",
    source_image_sha256: image.sha256,
    source_image_width_px: width,
    source_image_height_px: height,
    source_view_key: args.viewKey,
    interpretation_sha256: digest(interpretation),
    package_id: interpretation.package_id,
    search_region: { min: { x: 0, y: 0 }, max: { x: width, y: height } },
    policy: { expected_hue_degrees: 0, hue_tolerance_degrees: 20, minimum_chroma: 50, maximum_luminance: 245, route_buffer_radius_px: 7, minimum_coverage_fraction: 0.7, uncovered_adjacency_radius_px: 1, minimum_uncovered_component_pixels: 8, maximum_reported_uncovered_components: 100 },
    candidate_route_primitive_ids: args.primitives.map(value => value.primitive_id),
    qualifying_chromatic_pixel_count: 100,
    covered_chromatic_pixel_count: 100,
    uncovered_chromatic_pixel_count: 0,
    coverage_fraction: 1,
    uncovered_component_count: 0,
    uncovered_components: [],
    accepted: true,
    exact_next_repair: "none",
    native_write_allowed: false,
    capability_boundary: "test"
  };
  return { view_key: args.viewKey, source_image_path: image.path, source_image_sha256: image.sha256, source_image_width_px: width, source_image_height_px: height, parent_pixel_bounds: args.bounds, interpretation, route_coverage_receipt: receipt };
}

function fixture(): SheetOverlapRouteCompilationInputV1 {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "sheet-overlap-route-"));
  const parent = writeImage(directory, "parent.png", 300, 200);
  return {
    schema_version: 1,
    package_id: "overlap-fixture",
    parent_view_key: "parent",
    parent_image_path: parent.path,
    parent_image_sha256: parent.sha256,
    parent_image_width_px: 300,
    parent_image_height_px: 200,
    tiles: [
      tile({
        directory,
        viewKey: "west",
        bounds: { min: { x: 0, y: 0 }, max: { x: 200, y: 200 } },
        primitives: [
          primitive("main-west", "west", [{ u: 0, v: 0.5 }, { u: 1, v: 0.5 }]),
          primitive("branch", "west", [{ u: 0.75, v: 0.5 }, { u: 0.75, v: 0.1 }])
        ]
      }),
      tile({
        directory,
        viewKey: "east",
        bounds: { min: { x: 100, y: 0 }, max: { x: 300, y: 200 } },
        primitives: [primitive("main-east", "east", [{ u: 0, v: 0.505 }, { u: 1, v: 0.505 }], "hydronic_supply")]
      })
    ]
  };
}

test("overlap compiler removes partial duplicate spans and splits an endpoint-supported tee", async () => {
  const receipt = await compileSheetOverlapRoutesV1(fixture());
  assert.equal(receipt.status, "source_graph_compiled");
  assert.equal(receipt.source_route_accounting_closure, 1);
  assert.equal(receipt.source_route_member_count, 3);
  assert.ok(receipt.overlapping_source_member_count >= 2);
  assert.equal(receipt.junctions.filter(value => value.kind === "tee_or_branch").length, 1);
  assert.equal(receipt.junctions.find(value => value.kind === "tee_or_branch")?.canonical_route_ids.length, 3);
  assert.ok(receipt.canonical_route_count >= 4);
  assert.equal(receipt.parent_interpretation.primitives.length, receipt.canonical_route_count);
  assert.equal(receipt.native_write_allowed, false);
  assert.match(receipt.capability_boundary, /does not establish native size, system, elevation, connectivity/i);
});

test("overlap compiler blocks incompatible claims on the same registered span", async () => {
  const input = fixture();
  input.tiles[1]!.interpretation.primitives[0]!.claims!.system!.value = "domestic cold water";
  input.tiles[1]!.route_coverage_receipt.interpretation_sha256 = digest(input.tiles[1]!.interpretation);
  const receipt = await compileSheetOverlapRoutesV1(input);
  assert.equal(receipt.status, "blocked");
  assert.ok(receipt.conflicts.some(value => value.includes("overlap_claim_conflict")));
  assert.equal(receipt.exact_next_repair, "resolve_overlap_route_conflicts");
});

test("overlap compiler rejects a stale or unaccepted tile coverage receipt", async () => {
  const input = fixture();
  input.tiles[0]!.route_coverage_receipt.accepted = false;
  await assert.rejects(compileSheetOverlapRoutesV1(input), /coverage_receipt_mismatch_or_not_accepted/);
});
