import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createCanvas } from "@napi-rs/canvas";
import {
  compareCalibratedExistingConditionsCrops,
  type CalibratedCropComparisonInput
} from "../src/existing_conditions/calibrated_crop_comparator.js";

function sha256(filePath: string): string {
  return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

function writeImage(filePath: string, accent: string): void {
  const canvas = createCanvas(100, 100);
  const context = canvas.getContext("2d");
  context.fillStyle = "#ffffff";
  context.fillRect(0, 0, 100, 100);
  context.strokeStyle = accent;
  context.lineWidth = 3;
  context.beginPath();
  context.moveTo(10, 20);
  context.lineTo(90, 20);
  context.lineTo(90, 85);
  context.stroke();
  fs.writeFileSync(filePath, canvas.toBuffer("image/png"));
}

function fixture(): {
  directory: string;
  input: CalibratedCropComparisonInput;
} {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "calibrated-crop-comparator-"));
  const sourcePath = path.join(directory, "source.png");
  const candidatePath = path.join(directory, "candidate.png");
  writeImage(sourcePath, "#e25b21");
  writeImage(candidatePath, "#234fbd");
  return {
    directory,
    input: {
      schema_version: 1,
      fixture_id: "generic-mep-comparator",
      scope_id: "bounded-room",
      source_image: {
        path: sourcePath,
        sha256: sha256(sourcePath),
        width_px: 100,
        height_px: 100
      },
      candidate_image: {
        path: candidatePath,
        sha256: sha256(candidatePath),
        width_px: 100,
        height_px: 100,
        frame_id: "frame-100",
        view_id: 100,
        model_frame: {
          top_left: { x: 100, y: 200, z: 10 },
          top_right: { x: 200, y: 200, z: 10 },
          bottom_left: { x: 100, y: 100, z: 10 }
        }
      },
      controls: [
        {
          control_id: "northwest-envelope",
          kind: "exterior_corner",
          source_pixel: { x: 10, y: 10 },
          candidate_pixel: { x: 10, y: 10 },
          confidence: 0.99,
          accepted: true,
          target_excluded: true,
          source_reference: "source visible exterior corner",
          candidate_reference: "candidate visible exterior corner"
        },
        {
          control_id: "northeast-grid",
          kind: "grid_intersection",
          source_pixel: { x: 90, y: 10 },
          candidate_pixel: { x: 90, y: 10 },
          confidence: 0.98,
          accepted: true,
          target_excluded: true,
          source_reference: "source visible grid intersection",
          candidate_reference: "candidate visible grid intersection"
        },
        {
          control_id: "southwest-shaft",
          kind: "shaft_corner",
          source_pixel: { x: 10, y: 90 },
          candidate_pixel: { x: 10, y: 90 },
          confidence: 0.97,
          accepted: true,
          target_excluded: true,
          source_reference: "source visible shaft corner",
          candidate_reference: "candidate visible shaft corner"
        }
      ],
      features: [
        {
          feature_id: "retained-pipe-run",
          role: "domestic cold water main",
          source_points: [{ x: 40, y: 40 }, { x: 70, y: 40 }],
          candidate_points: [{ x: 30, y: 50 }, { x: 60, y: 50 }],
          candidate_element_ids: [501, 502]
        }
      ]
    }
  };
}

test("accepted calibration emits an exact rigid move dry-run and hash-bound overlay", async () => {
  const { directory, input } = fixture();
  const receipt = await compareCalibratedExistingConditionsCrops(
    input,
    path.join(directory, "evidence")
  );

  assert.equal(receipt.accepted, true);
  assert.equal(receipt.blockers.length, 0);
  assert.equal(receipt.residuals.rms_px, 0);
  assert.equal(receipt.transform.source_pixels_to_candidate_pixels.scale, 1);
  assert.equal(receipt.feature_repairs[0]?.disposition, "dry_run_ready");
  assert.deepEqual(receipt.feature_repairs[0]?.mean_delta_ft, {
    x: 10.101010101010104,
    y: 10.101010101010104,
    z: 0
  });
  assert.deepEqual(receipt.proposed_dry_run_actions, [
    {
      path: "/revit/move-elements",
      body: {
        elementIds: [501, 502],
        mode: "vector",
        vectorX: 10.101010101010104,
        vectorY: 10.101010101010104,
        vectorZ: 0,
        allOrNothing: true,
        dryRun: true
      }
    }
  ]);
  assert.equal(fs.existsSync(receipt.artifacts.calibrated_overlay.path), true);
  assert.equal(sha256(receipt.artifacts.calibrated_overlay.path), receipt.artifacts.calibrated_overlay.sha256);
  assert.equal(receipt.artifacts.comparison.width_px, 300);
  assert.match(receipt.transform.candidate_pixels_to_model.x_formula, /width - 1/);
  assert.match(receipt.usage_constraints.join(" "), /Rejected calibration produces no proposed dry-run actions/);
});

test("native raster endpoints map exactly to the frozen model frame", async () => {
  const { directory, input } = fixture();
  input.features = [{
    feature_id: "right-raster-edge",
    role: "native frame endpoint check",
    source_points: [{ x: 99, y: 0 }],
    candidate_points: [{ x: 0, y: 0 }],
    candidate_element_ids: [700]
  }];
  const receipt = await compareCalibratedExistingConditionsCrops(
    input,
    path.join(directory, "native-frame-endpoint")
  );

  assert.deepEqual(receipt.feature_repairs[0]?.target_model_points[0], { x: 200, y: 200, z: 10 });
  assert.deepEqual(receipt.feature_repairs[0]?.current_model_points[0], { x: 100, y: 200, z: 10 });
  assert.deepEqual(receipt.feature_repairs[0]?.mean_delta_ft, { x: 100, y: 0, z: 0 });
});

test("failed residual gate keeps diagnostics but emits no action", async () => {
  const { directory, input } = fixture();
  input.controls = [
    ...input.controls,
    {
      control_id: "bad-fourth-control",
      kind: "column_center",
      source_pixel: { x: 90, y: 90 },
      candidate_pixel: { x: 70, y: 70 },
      confidence: 0.95,
      accepted: true,
      target_excluded: true,
      source_reference: "source visible column center",
      candidate_reference: "candidate visible but mismatched column center"
    }
  ];
  const receipt = await compareCalibratedExistingConditionsCrops(
    input,
    path.join(directory, "rejected-evidence")
  );

  assert.equal(receipt.accepted, false);
  assert.equal(receipt.blockers.length > 0, true);
  assert.deepEqual(receipt.proposed_dry_run_actions, []);
  assert.equal(receipt.feature_repairs[0]?.disposition, "evidence_only");
  assert.equal(fs.existsSync(receipt.artifacts.calibrated_overlay.path), true);
});

test("non-rigid feature reports exact endpoint deltas without inventing a move", async () => {
  const { directory, input } = fixture();
  input.features = [{
    feature_id: "retained-duct-run",
    role: "rectangular supply duct",
    source_points: [{ x: 40, y: 40 }, { x: 70, y: 40 }],
    candidate_points: [{ x: 30, y: 50 }, { x: 70, y: 55 }],
    candidate_element_ids: [601, 602]
  }];
  const receipt = await compareCalibratedExistingConditionsCrops(
    input,
    path.join(directory, "reshape-evidence")
  );

  assert.equal(receipt.accepted, true);
  assert.equal(receipt.feature_repairs[0]?.disposition, "reshape_required");
  assert.deepEqual(receipt.proposed_dry_run_actions, []);
  assert.equal(receipt.feature_repairs[0]?.point_deltas_ft.length, 2);
  assert.match(receipt.feature_repairs[0]?.exact_next_repair ?? "", /disconnect, reshape or extend, reconnect/);
});

test("hash drift and permissive thresholds fail closed", async () => {
  const first = fixture();
  first.input.source_image.sha256 = "0".repeat(64);
  await assert.rejects(
    compareCalibratedExistingConditionsCrops(first.input, path.join(first.directory, "hash-fail")),
    /source_image_sha256_mismatch/
  );

  const second = fixture();
  second.input.thresholds = {
    maximum_rms_residual_px: 3.01,
    maximum_point_residual_px: 3,
    maximum_normalized_point_residual: 0.005
  };
  await assert.rejects(
    compareCalibratedExistingConditionsCrops(second.input, path.join(second.directory, "threshold-fail")),
    /calibrated_comparison_threshold_is_too_permissive/
  );
});

test("controls must be accepted, target-excluded, stable, and non-collinear", async () => {
  const first = fixture();
  first.input.controls[0] = {
    ...first.input.controls[0]!,
    target_excluded: false
  } as any;
  await assert.rejects(
    compareCalibratedExistingConditionsCrops(first.input, path.join(first.directory, "target-fail")),
    /control_must_be_accepted_and_target_excluded/
  );

  const second = fixture();
  second.input.controls = second.input.controls.map((control, index) => ({
    ...control,
    source_pixel: { x: 10 + index * 20, y: 10 + index * 20 }
  }));
  await assert.rejects(
    compareCalibratedExistingConditionsCrops(second.input, path.join(second.directory, "collinear-fail")),
    /source_controls_must_be_non_collinear/
  );
});

test("out-of-frame points, clustered controls, and degenerate model frames fail closed", async () => {
  const first = fixture();
  first.input.controls[0] = {
    ...first.input.controls[0]!,
    source_pixel: { x: 100, y: 10 }
  };
  await assert.rejects(
    compareCalibratedExistingConditionsCrops(first.input, path.join(first.directory, "bounds-fail")),
    /source_pixel_outside_raster_bounds/
  );

  const second = fixture();
  second.input.controls = second.input.controls.map((control, index) => ({
    ...control,
    source_pixel: [
      { x: 10, y: 10 },
      { x: 12, y: 10 },
      { x: 10, y: 12 }
    ][index]!,
    candidate_pixel: [
      { x: 20, y: 20 },
      { x: 22, y: 20 },
      { x: 20, y: 22 }
    ][index]!
  }));
  const clustered = await compareCalibratedExistingConditionsCrops(
    second.input,
    path.join(second.directory, "spread-fail")
  );
  assert.equal(clustered.accepted, false);
  assert.match(clustered.blockers.join(" "), /control_spread_below_threshold/);
  assert.deepEqual(clustered.proposed_dry_run_actions, []);

  const third = fixture();
  third.input.candidate_image.model_frame.bottom_left = {
    ...third.input.candidate_image.model_frame.top_left
  };
  await assert.rejects(
    compareCalibratedExistingConditionsCrops(third.input, path.join(third.directory, "frame-fail")),
    /candidate_model_frame_is_degenerate/
  );
});
