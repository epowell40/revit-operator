import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import assert from "node:assert/strict";
import test from "node:test";
import { createCanvas } from "@napi-rs/canvas";
import { buildArchitecturalMeasurementOverlay } from "../src/existing_conditions/architectural_pixel_measurement.js";
import {
  buildArchitecturalSourceDelta,
  type ArchitecturalSourceDeltaInput
} from "../src/existing_conditions/architectural_source_delta.js";
import { buildArchitecturalWallLineCandidates } from "../src/existing_conditions/architectural_wall_line_candidates.js";
import { assertExistingConditionsContract } from "../src/existing_conditions/contract_validation.js";

const SOURCE_HASH = "7".repeat(64);

function sha256(filePath: string): string {
  return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

function drawFixture(
  filePath: string,
  includeTargets: boolean,
  targets: Array<[[number, number], [number, number]]>
): void {
  const canvas = createCanvas(600, 360);
  const context = canvas.getContext("2d");
  context.fillStyle = "#ffffff";
  context.fillRect(0, 0, 600, 360);
  context.strokeStyle = "#000000";
  context.lineWidth = 4;
  context.beginPath();
  context.moveTo(20, 330);
  context.lineTo(580, 330);
  context.stroke();
  if (includeTargets) {
    context.lineWidth = 5;
    for (const [start, end] of targets) {
      context.beginPath();
      context.moveTo(start[0], start[1]);
      context.lineTo(end[0], end[1]);
      context.stroke();
    }
    context.lineWidth = 3;
    context.strokeRect(280, 40, 45, 30);
  }
  fs.writeFileSync(filePath, canvas.toBuffer("image/png"));
}

function deltaInput(sourcePath: string, redactedPath: string, fixtureId: string): ArchitecturalSourceDeltaInput {
  return {
    schema_version: 1,
    fixture_id: fixtureId,
    scope_id: "parallel-wall-line-scope",
    source_render: {
      path: sourcePath,
      sha256: sha256(sourcePath),
      width_px: 600,
      height_px: 360,
      source_sheet_bounds: { min: { x: 0, y: 0 }, max: { x: 20, y: 12 } }
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
      width_px: 600,
      height_px: 360,
      model_frame: {
        top_left: { x: 0, y: 12 },
        top_right: { x: 20, y: 12 },
        bottom_left: { x: 0, y: 0 }
      }
    },
    scope_model_bounds: { min: { x: 0, y: 0 }, max: { x: 20, y: 12 } },
    output_width_px: 600,
    ink_luminance_threshold: 220,
    redacted_ink_dilation_px: 2
  };
}

async function buildFixture(
  temp: string,
  fixtureId: string,
  targets: Array<[[number, number], [number, number]]>
) {
  const sourcePath = path.join(temp, `${fixtureId}-source.png`);
  const redactedPath = path.join(temp, `${fixtureId}-redacted.png`);
  drawFixture(sourcePath, true, targets);
  drawFixture(redactedPath, false, targets);
  const delta = await buildArchitecturalSourceDelta(
    deltaInput(sourcePath, redactedPath, fixtureId),
    path.join(temp, `${fixtureId}-delta`)
  );
  const deltaReceiptPath = path.join(temp, `${fixtureId}-delta-receipt.json`);
  fs.writeFileSync(deltaReceiptPath, `${JSON.stringify(delta, null, 2)}\n`, "utf8");
  const measurement = await buildArchitecturalMeasurementOverlay(
    delta,
    sha256(deltaReceiptPath),
    path.join(temp, `${fixtureId}-measurement`)
  );
  const measurementReceiptPath = path.join(temp, `${fixtureId}-measurement-receipt.json`);
  fs.writeFileSync(measurementReceiptPath, `${JSON.stringify(measurement, null, 2)}\n`, "utf8");
  return { delta, deltaReceiptPath, measurement, measurementReceiptPath };
}

test("wall-line extraction preserves overlapping parallel alternatives instead of auto-selecting one", async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "architectural-wall-line-candidates-"));
  try {
    const fixture = await buildFixture(temp, "parallel-a", [
      [[50, 70], [550, 230]],
      [[50, 130], [550, 290]]
    ]);
    const receipt = await buildArchitecturalWallLineCandidates(
      fixture.delta,
      sha256(fixture.deltaReceiptPath),
      fixture.measurement,
      sha256(fixture.measurementReceiptPath),
      path.join(temp, "candidates"),
      { maximum_candidates: 8, minimum_length_ft: 3, maximum_wall_interruption_ft: 1 }
    );
    assert.equal(receipt.status, "clarification_required");
    assert.ok(receipt.candidates.length >= 2);
    assert.ok(receipt.ambiguities.some((entry) => entry.reason === "parallel_overlapping_wall_lines"));
    assert.match(receipt.clarification_question ?? "", /Confirm the intended wall centerline\/host candidate/);
    assert.equal("selected_candidate_id" in receipt, false);
    assert.equal(receipt.candidates.every((candidate) => candidate.pixel_points.every(
      (point) => point.x >= 0 && point.x <= 600 && point.y >= 0 && point.y <= 360
    )), true);
    assert.equal(fs.existsSync(receipt.overlay.path), true);
    assert.equal(sha256(receipt.overlay.path), receipt.overlay.sha256);
    const longDiagonal = receipt.candidates.filter((candidate) => candidate.length_ft >= 15 && candidate.angle_degrees > 10 && candidate.angle_degrees < 30);
    assert.ok(longDiagonal.length >= 2, JSON.stringify(receipt.candidates, null, 2));

    const receiptPath = path.join(temp, "candidate-receipt.json");
    const cliOutDir = path.join(temp, "cli-candidates");
    const cli = path.resolve(process.cwd(), "dist/src/tools/existing_conditions_fixture.js");
    const cliRun = spawnSync(process.execPath, [
      cli,
      "build-architectural-wall-candidates",
      "--delta-receipt", fixture.deltaReceiptPath,
      "--measurement-receipt", fixture.measurementReceiptPath,
      "--out-dir", cliOutDir,
      "--out", receiptPath
    ], { cwd: process.cwd(), encoding: "utf8" });
    assert.equal(cliRun.status, 0, cliRun.stderr || cliRun.stdout);
    assert.equal(JSON.parse(fs.readFileSync(receiptPath, "utf8")).status, "clarification_required");
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

test("wall-line extraction is geometry-sensitive and rejects hash-bound receipt drift", async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "architectural-wall-line-perturbation-"));
  try {
    const first = await buildFixture(temp, "parallel-base", [
      [[50, 70], [550, 230]],
      [[50, 130], [550, 290]]
    ]);
    const second = await buildFixture(temp, "parallel-perturbed", [
      [[90, 35], [520, 260]],
      [[60, 92], [490, 317]]
    ]);
    const firstReceipt = await buildArchitecturalWallLineCandidates(
      first.delta,
      sha256(first.deltaReceiptPath),
      first.measurement,
      sha256(first.measurementReceiptPath),
      path.join(temp, "first-candidates"),
      { maximum_candidates: 8, minimum_length_ft: 3, maximum_wall_interruption_ft: 1 }
    );
    const secondReceipt = await buildArchitecturalWallLineCandidates(
      second.delta,
      sha256(second.deltaReceiptPath),
      second.measurement,
      sha256(second.measurementReceiptPath),
      path.join(temp, "second-candidates"),
      { maximum_candidates: 8, minimum_length_ft: 3, maximum_wall_interruption_ft: 1 }
    );
    assert.equal(firstReceipt.status, "clarification_required");
    assert.equal(secondReceipt.status, "clarification_required");
    assert.notDeepEqual(
      firstReceipt.candidates.slice(0, 2).map((entry) => entry.candidate_id),
      secondReceipt.candidates.slice(0, 2).map((entry) => entry.candidate_id)
    );
    assert.ok(Math.abs(firstReceipt.candidates[0]!.angle_degrees - secondReceipt.candidates[0]!.angle_degrees) >= 5);

    const changedMeasurement = structuredClone(first.measurement);
    changedMeasurement.architectural_delta_receipt_sha256 = "0".repeat(64);
    await assert.rejects(
      buildArchitecturalWallLineCandidates(
        first.delta,
        sha256(first.deltaReceiptPath),
        changedMeasurement,
        sha256(first.measurementReceiptPath),
        path.join(temp, "invalid-candidates")
      ),
      /architectural_wall_line_delta_receipt_mismatch/
    );
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

test("wall-candidate clarification is strict, evidence-bound, and non-writing", () => {
  const clarification = {
    schema_version: 1,
    fixture_id: "parallel-a",
    scope_id: "parallel-wall-line-scope",
    status: "clarification_required",
    candidate_receipt_sha256: "8".repeat(64),
    selected_candidate_id: null,
    material_ambiguity: true,
    question: "Confirm the intended wall centerline and both endpoints.",
    candidate_ids_requiring_resolution: ["line-a", "line-b"],
    evidence_basis: [
      "source_pdf_render",
      "source_to_model_registration",
      "architectural_source_redacted_delta",
      "architectural_wall_line_candidates",
      "architectural_wall_line_candidate_overlay"
    ],
    native_write: false
  };
  assert.doesNotThrow(() => assertExistingConditionsContract("architectural_wall_candidate_clarification", clarification));
  assert.throws(
    () => assertExistingConditionsContract("architectural_wall_candidate_clarification", { ...clarification, unbound_note: "no" }),
    /additional properties/
  );
});
