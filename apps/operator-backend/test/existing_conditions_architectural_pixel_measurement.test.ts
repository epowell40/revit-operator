import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import assert from "node:assert/strict";
import test from "node:test";
import { createCanvas } from "@napi-rs/canvas";
import {
  buildArchitecturalMeasurementOverlay,
  compileArchitecturalPixelMeasurementPreview,
  type ArchitecturalPixelMeasurementPackage
} from "../src/existing_conditions/architectural_pixel_measurement.js";
import {
  buildArchitecturalSourceDelta,
  type ArchitecturalSourceDeltaInput
} from "../src/existing_conditions/architectural_source_delta.js";
import { assertExistingConditionsContract } from "../src/existing_conditions/contract_validation.js";

const SOURCE_HASH = "4".repeat(64);

function sha256(filePath: string): string {
  return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

function drawFixture(filePath: string, includeTarget: boolean): void {
  const canvas = createCanvas(200, 200);
  const context = canvas.getContext("2d");
  context.fillStyle = "#ffffff";
  context.fillRect(0, 0, 200, 200);
  context.strokeStyle = "#000000";
  context.lineWidth = 4;
  context.beginPath();
  context.moveTo(40, 20);
  context.lineTo(40, 180);
  context.stroke();
  if (includeTarget) {
    context.beginPath();
    context.moveTo(20, 100);
    context.lineTo(180, 100);
    context.stroke();
  }
  fs.writeFileSync(filePath, canvas.toBuffer("image/png"));
}

function deltaInput(sourcePath: string, redactedPath: string): ArchitecturalSourceDeltaInput {
  return {
    schema_version: 1,
    fixture_id: "architectural-pixel-measurement-v1",
    scope_id: "synthetic-measurement-scope",
    source_render: {
      path: sourcePath,
      sha256: sha256(sourcePath),
      width_px: 200,
      height_px: 200,
      source_sheet_bounds: { min: { x: 0, y: 0 }, max: { x: 10, y: 10 } }
    },
    registration: {
      schema_version: 1,
      source_evidence_sha256: SOURCE_HASH,
      control_point_count: 3,
      scale: 1,
      rotation_degrees: 0,
      translation_ft: { x: 0, y: 0 },
      rms_error_ft: 0,
      maximum_error_ft: 0,
      max_rms_error_ft: 0.01,
      max_point_error_ft: 0.02,
      verified: true
    },
    redacted_model_capture: {
      path: redactedPath,
      sha256: sha256(redactedPath),
      width_px: 200,
      height_px: 200,
      model_frame: {
        top_left: { x: 0, y: 10 },
        top_right: { x: 10, y: 10 },
        bottom_left: { x: 0, y: 0 }
      }
    },
    scope_model_bounds: { min: { x: 0, y: 0 }, max: { x: 10, y: 10 } },
    output_width_px: 200,
    ink_luminance_threshold: 220,
    redacted_ink_dilation_px: 2
  };
}

function pixelPackage(measurementHash: string, overlayHash: string): ArchitecturalPixelMeasurementPackage {
  return {
    schema_version: 1,
    fixture_id: "architectural-pixel-measurement-v1",
    scope_id: "synthetic-measurement-scope",
    source_evidence_sha256: SOURCE_HASH,
    visible_evidence: [
      { role: "source_pdf", sha256: SOURCE_HASH },
      { role: "architectural_registered_measurement_overlay", sha256: overlayHash }
    ],
    registration: {
      source_evidence_sha256: SOURCE_HASH,
      control_points: [
        { source: { x: 0, y: 0 }, model: { x: 0, y: 0 } },
        { source: { x: 10, y: 0 }, model: { x: 10, y: 0 } },
        { source: { x: 0, y: 10 }, model: { x: 0, y: 10 } }
      ]
    },
    measurement_receipt_sha256: measurementHash,
    coordinate_space: "measurement_overlay_pixels_top_left",
    level_name: "L4",
    level_elevation_ft: 32,
    geometry_confidence_threshold: 0.75,
    material_confidence_threshold: 0.85,
    maximum_opening_host_distance_ft: 0.75,
    maximum_created_elements: 2,
    observations: [
      {
        kind: "wall",
        discipline: "architectural",
        observation_id: "measured-wall-1",
        visibility: "clear",
        confidence: 0.99,
        supported_attributes: ["location"],
        pixel_points: [{ x: 20, y: 100 }, { x: 180, y: 100 }]
      },
      {
        kind: "door",
        discipline: "architectural",
        observation_id: "measured-door-1",
        visibility: "clear",
        confidence: 0.95,
        supported_attributes: ["location", "host"],
        pixel_point: { x: 100, y: 110 },
        host_wall_observation_id: "measured-wall-1"
      }
    ]
  };
}

test("registered overlay and pixel compiler produce exact model geometry and project openings to hosts", async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "architectural-pixel-measurement-"));
  try {
    const sourcePath = path.join(temp, "source.png");
    const redactedPath = path.join(temp, "redacted.png");
    drawFixture(sourcePath, true);
    drawFixture(redactedPath, false);
    const delta = await buildArchitecturalSourceDelta(deltaInput(sourcePath, redactedPath), path.join(temp, "delta"));
    const measurement = await buildArchitecturalMeasurementOverlay(delta, "a".repeat(64), path.join(temp, "measurement"));
    assert.equal(fs.existsSync(measurement.overlay.path), true);
    assert.equal(sha256(measurement.overlay.path), measurement.overlay.sha256);
    assert.equal(measurement.output_frame.pixel_origin, "top_left");
    const measurementPath = path.join(temp, "measurement-receipt.json");
    fs.writeFileSync(measurementPath, `${JSON.stringify(measurement, null, 2)}\n`, "utf8");
    const measurementHash = sha256(measurementPath);
    const input = pixelPackage(measurementHash, measurement.overlay.sha256);
    assert.doesNotThrow(() => assertExistingConditionsContract("architectural_pixel_measurement", input));
    const compilation = compileArchitecturalPixelMeasurementPreview(input, measurement, measurementHash);
    assert.equal(compilation.compiled_preview.status, "preview_ready");
    assert.equal(compilation.compiled_preview.native_action, null);
    const wall = compilation.compiled_preview.preview_elements.find((entry) => entry.kind === "wall");
    const door = compilation.compiled_preview.preview_elements.find((entry) => entry.kind === "door");
    assert.deepEqual(wall?.geometry.points, [{ x: 1, y: 5 }, { x: 9, y: 5 }]);
    assert.deepEqual(door?.geometry.point, { x: 5, y: 5 });
    assert.equal(door?.geometry.host_wall_observation_id, "measured-wall-1");
    assert.equal(door?.geometry.chainage_ft, 4);
    assert.equal(compilation.converted_source_package.observations.every(
      (entry) => entry.evidence_role === "architectural_registered_measurement_overlay"
    ), true);
    const inputPath = path.join(temp, "pixel-observations.json");
    const compiledPath = path.join(temp, "compiled-preview.json");
    const convertedPath = path.join(temp, "converted-source.json");
    fs.writeFileSync(inputPath, `${JSON.stringify(input, null, 2)}\n`, "utf8");
    const cli = path.resolve(process.cwd(), "dist/src/tools/existing_conditions_fixture.js");
    const cliRun = spawnSync(process.execPath, [
      cli,
      "compile-architectural-pixel-preview",
      "--input", inputPath,
      "--measurement-receipt", measurementPath,
      "--out", compiledPath,
      "--source-out", convertedPath
    ], { cwd: process.cwd(), encoding: "utf8" });
    assert.equal(cliRun.status, 0, cliRun.stderr || cliRun.stdout);
    assert.equal(JSON.parse(fs.readFileSync(compiledPath, "utf8")).status, "preview_ready");
    assert.equal(JSON.parse(fs.readFileSync(convertedPath, "utf8")).observations[1].point.y, 5);
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

test("pixel compiler rejects receipt drift, out-of-frame points, and openings too far from their host", async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "architectural-pixel-measurement-invalid-"));
  try {
    const sourcePath = path.join(temp, "source.png");
    const redactedPath = path.join(temp, "redacted.png");
    drawFixture(sourcePath, true);
    drawFixture(redactedPath, false);
    const delta = await buildArchitecturalSourceDelta(deltaInput(sourcePath, redactedPath), path.join(temp, "delta"));
    const measurement = await buildArchitecturalMeasurementOverlay(delta, "b".repeat(64), path.join(temp, "measurement"));
    const input = pixelPackage("c".repeat(64), measurement.overlay.sha256);
    assert.throws(
      () => compileArchitecturalPixelMeasurementPreview(input, measurement, "d".repeat(64)),
      /measurement_receipt_sha256_mismatch/
    );
    const outside = structuredClone(input);
    const outsideWall = outside.observations[0];
    assert.equal(outsideWall?.kind, "wall");
    if (!outsideWall || outsideWall.kind !== "wall") throw new Error("expected synthetic wall observation");
    outsideWall.pixel_points[0].x = 201;
    assert.throws(
      () => compileArchitecturalPixelMeasurementPreview(outside, measurement, "c".repeat(64)),
      /outside_measurement_frame/
    );
    const distant = structuredClone(input);
    const distantDoor = distant.observations[1];
    assert.equal(distantDoor?.kind, "door");
    if (!distantDoor) throw new Error("expected synthetic opening observation");
    distantDoor.pixel_point.y = 150;
    assert.throws(
      () => compileArchitecturalPixelMeasurementPreview(distant, measurement, "c".repeat(64)),
      /opening_exceeds_host_projection_limit/
    );
    const unsupported = structuredClone(input) as unknown as Record<string, unknown>;
    (unsupported.observations as Array<Record<string, unknown>>)[0]!.hidden_model_point = { x: 1, y: 5 };
    assert.throws(
      () => assertExistingConditionsContract("architectural_pixel_measurement", unsupported),
      /invalid_existing_conditions_architectural_pixel_measurement_contract/
    );
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});
