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
import {
  buildArchitecturalWallLineCandidates,
  deduplicateArchitecturalOpeningHypotheses,
  type ArchitecturalOpeningGapHypothesis,
  type ArchitecturalWallLineCandidate
} from "../src/existing_conditions/architectural_wall_line_candidates.js";
import {
  validateArchitecturalOpeningClassification,
  type ArchitecturalOpeningClassificationReceipt
} from "../src/existing_conditions/architectural_opening_classification.js";
import { assertExistingConditionsContract } from "../src/existing_conditions/contract_validation.js";

const SOURCE_HASH = "7".repeat(64);

function sha256(filePath: string): string {
  return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

function drawFixture(
  filePath: string,
  includeTargets: boolean,
  targets: Array<[[number, number], [number, number]]>,
  retainedSegments: Array<[[number, number], [number, number]]> = []
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
  for (const [start, end] of retainedSegments) {
    context.beginPath();
    context.moveTo(start[0], start[1]);
    context.lineTo(end[0], end[1]);
    context.stroke();
  }
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
  targets: Array<[[number, number], [number, number]]>,
  retainedSegments: Array<[[number, number], [number, number]]> = []
) {
  const sourcePath = path.join(temp, `${fixtureId}-source.png`);
  const redactedPath = path.join(temp, `${fixtureId}-redacted.png`);
  drawFixture(sourcePath, true, targets, retainedSegments);
  drawFixture(redactedPath, false, targets, retainedSegments);
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
    const faceMidline = receipt.candidates.find((candidate) => candidate.derivation === "parallel_face_midline");
    assert.ok(faceMidline, JSON.stringify(receipt.candidates, null, 2));
    assert.ok(faceMidline.face_separation_ft !== null && faceMidline.face_separation_ft >= 0.2);
    assert.equal(faceMidline.supporting_face_pixel_points?.length, 2);
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
    const cliReceipt = JSON.parse(fs.readFileSync(receiptPath, "utf8"));
    assert.equal(cliReceipt.status, "clarification_required");
    assert.equal(cliReceipt.policy.maximum_candidates, 12);
    assert.equal(cliReceipt.policy.minimum_opening_host_source_ink_coverage, 0.6);
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

test("wall-line extraction exposes connected paired-face centerlines as non-selecting junction hypotheses", async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "architectural-wall-junction-candidates-"));
  try {
    const fixture = await buildFixture(temp, "junction-a", [
      [[70, 80], [430, 80]],
      [[70, 100], [430, 100]],
      [[70, 80], [70, 310]],
      [[90, 100], [90, 310]]
    ]);
    const receipt = await buildArchitecturalWallLineCandidates(
      fixture.delta,
      sha256(fixture.deltaReceiptPath),
      fixture.measurement,
      sha256(fixture.measurementReceiptPath),
      path.join(temp, "junction-candidates"),
      {
        maximum_candidates: 12,
        minimum_length_ft: 3,
        maximum_wall_interruption_ft: 1,
        maximum_face_pair_separation_ft: 1.5
      }
    );
    assert.ok(receipt.junction_hypotheses.length > 0, JSON.stringify(receipt.candidates, null, 2));
    const junction = receipt.junction_hypotheses[0]!;
    assert.equal(junction.candidate_ids.length, 2);
    assert.ok(junction.angle_difference_degrees >= 80 && junction.angle_difference_degrees <= 100);
    assert.ok(junction.endpoint_distances_ft.every((distance) => distance <= 1.25));
    assert.ok(junction.pixel_point.x >= 60 && junction.pixel_point.x <= 110);
    assert.ok(junction.pixel_point.y >= 70 && junction.pixel_point.y <= 115);
    assert.equal(receipt.opening_gap_hypotheses.length, 0, JSON.stringify({
      candidates: receipt.candidates,
      openings: receipt.opening_gap_hypotheses
    }, null, 2));
    assert.equal("selected_candidate_id" in receipt, false);
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

test("wall-line extraction exposes a repeated wall-band gap as an unclassified host-bound opening hypothesis", async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "architectural-opening-gap-candidates-"));
  try {
    const fixture = await buildFixture(temp, "opening-gap-a", [
      [[40, 90], [210, 90]],
      [[310, 90], [560, 90]],
      [[40, 110], [210, 110]],
      [[310, 110], [560, 110]]
    ]);
    const receipt = await buildArchitecturalWallLineCandidates(
      fixture.delta,
      sha256(fixture.deltaReceiptPath),
      fixture.measurement,
      sha256(fixture.measurementReceiptPath),
      path.join(temp, "opening-gap-candidates"),
      {
        maximum_candidates: 12,
        minimum_length_ft: 3,
        maximum_wall_interruption_ft: 4,
        maximum_face_pair_separation_ft: 1.5,
        opening_gap_minimum_confirming_profiles: 2
      }
    );
    assert.ok(receipt.opening_gap_hypotheses.length > 0, JSON.stringify(receipt.candidates, null, 2));
    const opening = receipt.opening_gap_hypotheses.find((entry) => entry.width_ft >= 2.5 && entry.width_ft <= 4.5);
    assert.ok(opening, JSON.stringify(receipt.opening_gap_hypotheses, null, 2));
    assert.equal(opening.kind, "unclassified_opening_gap");
    assert.ok(receipt.candidates.some((candidate) => candidate.candidate_id === opening.host_candidate_id));
    assert.ok(opening.confirming_profile_count >= 2);
    assert.ok(opening.flank_ink_coverage >= 0.55);
    assert.ok(opening.gap_ink_coverage <= 0.15);
    assert.ok(opening.pixel_center.x >= 190 && opening.pixel_center.x <= 330);
    const crop = receipt.opening_evidence_crops.find(
      (entry) => entry.opening_hypothesis_id === opening.opening_hypothesis_id
    );
    assert.ok(crop);
    assert.equal(crop.host_candidate_id, opening.host_candidate_id);
    assert.equal(fs.existsSync(crop.source_crop.path), true);
    assert.equal(fs.existsSync(crop.evidence_overlay.path), true);
    assert.equal(sha256(crop.source_crop.path), crop.source_crop.sha256);
    assert.equal(sha256(crop.evidence_overlay.path), crop.evidence_overlay.sha256);
    assert.equal(crop.source_crop.width_px, crop.evidence_overlay.width_px);
    assert.equal(crop.source_crop.height_px, crop.evidence_overlay.height_px);

    const candidateReceiptSha256 = "8".repeat(64);
    const classified: ArchitecturalOpeningClassificationReceipt = {
      schema_version: 1,
      artifact_role: "architectural_opening_classification",
      fixture_id: receipt.fixture_id,
      scope_id: receipt.scope_id,
      candidate_receipt_sha256: candidateReceiptSha256,
      status: "classified",
      classifications: receipt.opening_gap_hypotheses.map((hypothesis) => {
        const evidence = receipt.opening_evidence_crops.find(
          (entry) => entry.opening_hypothesis_id === hypothesis.opening_hypothesis_id
        )!;
        return {
          opening_hypothesis_id: hypothesis.opening_hypothesis_id,
          host_candidate_id: hypothesis.host_candidate_id,
          classification: "door" as const,
          confidence: 0.9,
          cues: ["swing_arc" as const, "paired_jambs" as const],
          evidence_artifact_sha256s: [evidence.source_crop.sha256, evidence.evidence_overlay.sha256],
          rationale: "A bounded swing arc and jamb evidence are visible in the crop.",
          selected_host_candidate_id: null
        };
      }),
      native_write: false
    };
    assert.doesNotThrow(() => assertExistingConditionsContract("architectural_opening_classification", classified));
    assert.doesNotThrow(() => validateArchitecturalOpeningClassification(
      classified,
      receipt,
      candidateReceiptSha256
    ));
    const candidateReceiptPath = path.join(temp, "opening-candidate-receipt.json");
    const classificationPath = path.join(temp, "opening-classification.json");
    const validatedPath = path.join(temp, "opening-classification-validated.json");
    fs.writeFileSync(candidateReceiptPath, `${JSON.stringify(receipt, null, 2)}\n`, "utf8");
    const cliClassification = { ...classified, candidate_receipt_sha256: sha256(candidateReceiptPath) };
    fs.writeFileSync(classificationPath, `${JSON.stringify(cliClassification, null, 2)}\n`, "utf8");
    const classificationCli = spawnSync(process.execPath, [
      path.resolve(process.cwd(), "dist/src/tools/existing_conditions_fixture.js"),
      "validate-architectural-opening-classification",
      "--candidate-receipt", candidateReceiptPath,
      "--classification", classificationPath,
      "--out", validatedPath
    ], { cwd: process.cwd(), encoding: "utf8" });
    assert.equal(classificationCli.status, 0, classificationCli.stderr || classificationCli.stdout);
    assert.deepEqual(JSON.parse(fs.readFileSync(validatedPath, "utf8")), cliClassification);
    assert.throws(
      () => validateArchitecturalOpeningClassification(
        { ...classified, status: "clarification_required" },
        receipt,
        candidateReceiptSha256
      ),
      /status_mismatch/
    );
    assert.throws(
      () => validateArchitecturalOpeningClassification({
        ...classified,
        classifications: classified.classifications.map((entry, index) => index === 0
          ? { ...entry, host_candidate_id: "line-wrong" }
          : entry)
      }, receipt, candidateReceiptSha256),
      /host_mismatch/
    );

    const uncertain: ArchitecturalOpeningClassificationReceipt = {
      ...classified,
      status: "clarification_required",
      classifications: classified.classifications.map((entry, index) => index === 0 ? {
        ...entry,
        classification: "unknown" as const,
        confidence: 0.4,
        cues: ["annotation_occlusion" as const, "insufficient_symbol" as const],
        rationale: "Annotations obscure the source symbol, so the opening cannot be classified safely."
      } : entry)
    };
    assert.doesNotThrow(() => validateArchitecturalOpeningClassification(
      uncertain,
      receipt,
      candidateReceiptSha256
    ));
    assert.throws(
      () => assertExistingConditionsContract("architectural_opening_classification", {
        ...uncertain,
        classifications: uncertain.classifications.map((entry, index) => index === 0
          ? { ...entry, inferred_width_ft: 3 }
          : entry)
      }),
      /additional properties/
    );
    assert.equal("selected_candidate_id" in receipt, false);
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

test("opening-gap discovery ignores retained background ink crossing a source-only wall opening", async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "architectural-opening-gap-retained-clutter-"));
  try {
    const fixture = await buildFixture(temp, "opening-gap-retained-clutter", [
      [[40, 90], [210, 90]],
      [[310, 90], [560, 90]],
      [[40, 110], [210, 110]],
      [[310, 110], [560, 110]]
    ], [
      [[230, 40], [230, 160]],
      [[260, 40], [260, 160]],
      [[290, 40], [290, 160]]
    ]);
    const receipt = await buildArchitecturalWallLineCandidates(
      fixture.delta,
      sha256(fixture.deltaReceiptPath),
      fixture.measurement,
      sha256(fixture.measurementReceiptPath),
      path.join(temp, "opening-gap-retained-clutter-candidates"),
      {
        maximum_candidates: 12,
        minimum_length_ft: 3,
        maximum_wall_interruption_ft: 4,
        maximum_face_pair_separation_ft: 1.5,
        opening_gap_minimum_confirming_profiles: 2
      }
    );
    const opening = receipt.opening_gap_hypotheses.find((entry) => entry.width_ft >= 2.5 && entry.width_ft <= 4.5);
    assert.ok(opening, JSON.stringify(receipt.opening_gap_hypotheses, null, 2));
    assert.ok(opening.pixel_center.x >= 190 && opening.pixel_center.x <= 330);
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

test("opening-gap discovery recovers a paired wall opening through source-only tag and swing-symbol interference", async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "architectural-opening-gap-symbol-interference-"));
  try {
    const fixture = await buildFixture(temp, "opening-gap-symbol-interference", [
      [[250, 30], [250, 100]],
      [[270, 30], [270, 100]],
      [[250, 240], [250, 330]],
      [[270, 240], [270, 330]],
      // Door leaf and bounded swing approximation within the opening.
      [[270, 100], [390, 100]],
      [[390, 100], [365, 150]],
      [[365, 150], [315, 205]],
      [[315, 205], [270, 240]],
      // Room-tag-like source-only strokes crossing both wall-face profiles.
      [[220, 155], [300, 155]],
      [[220, 185], [300, 185]],
      [[240, 145], [240, 195]],
      [[280, 145], [280, 195]]
    ]);
    const receipt = await buildArchitecturalWallLineCandidates(
      fixture.delta,
      sha256(fixture.deltaReceiptPath),
      fixture.measurement,
      sha256(fixture.measurementReceiptPath),
      path.join(temp, "symbol-interference-candidates"),
      {
        maximum_candidates: 16,
        minimum_length_ft: 2,
        maximum_face_pair_separation_ft: 1.5
      }
    );
    const opening = receipt.opening_gap_hypotheses.find((entry) => entry.width_ft >= 3.5 && entry.width_ft <= 5.5);
    assert.ok(opening, JSON.stringify({
      candidates: receipt.candidates,
      openings: receipt.opening_gap_hypotheses
    }, null, 2));
    const host = receipt.candidates.find((candidate) => candidate.candidate_id === opening.host_candidate_id);
    assert.ok(host);
    assert.ok(Math.abs(host.angle_degrees - 90) <= 1);
    assert.ok(host.face_separation_ft !== null && host.face_separation_ft >= 0.4 && host.face_separation_ft <= 0.9);
    assert.ok(host.source_ink_coverage >= 0.6, JSON.stringify(host, null, 2));
    assert.equal(receipt.opening_gap_hypotheses.filter(
      (entry) => entry.width_ft >= 3.5 && entry.width_ft <= 5.5
    ).length, 1, JSON.stringify(receipt.opening_gap_hypotheses, null, 2));
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

test("opening-gap discovery rejects a one-sided face interruption", async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "architectural-opening-gap-one-sided-"));
  try {
    const fixture = await buildFixture(temp, "opening-gap-one-sided", [
      [[250, 30], [250, 330]],
      [[270, 30], [270, 100]],
      [[270, 240], [270, 330]]
    ]);
    const receipt = await buildArchitecturalWallLineCandidates(
      fixture.delta,
      sha256(fixture.deltaReceiptPath),
      fixture.measurement,
      sha256(fixture.measurementReceiptPath),
      path.join(temp, "one-sided-candidates"),
      {
        maximum_candidates: 16,
        minimum_length_ft: 2,
        maximum_face_pair_separation_ft: 1.5
      }
    );
    const host = receipt.candidates.find((candidate) => candidate.derivation === "parallel_face_midline"
      && Math.abs(candidate.angle_degrees - 90) <= 1
      && candidate.face_separation_ft !== null
      && candidate.face_separation_ft >= 0.4
      && candidate.face_separation_ft <= 0.9);
    assert.ok(host, JSON.stringify(receipt.candidates, null, 2));
    assert.equal(receipt.policy.minimum_opening_host_source_ink_coverage, 0.6);
    assert.equal(receipt.opening_gap_hypotheses.some(
      (opening) => opening.host_candidate_id === host.candidate_id
    ), false, JSON.stringify(receipt.opening_gap_hypotheses, null, 2));
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

test("face pairing preserves common narrow partition faces below candidate dedupe tolerance", async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "architectural-narrow-wall-face-pair-"));
  try {
    const fixture = await buildFixture(temp, "narrow-wall-face-pair", [
      [[40, 90], [210, 90]],
      [[310, 90], [560, 90]],
      [[40, 102], [210, 102]],
      [[310, 102], [560, 102]]
    ]);
    const receipt = await buildArchitecturalWallLineCandidates(
      fixture.delta,
      sha256(fixture.deltaReceiptPath),
      fixture.measurement,
      sha256(fixture.measurementReceiptPath),
      path.join(temp, "narrow-wall-face-pair-candidates"),
      {
        maximum_candidates: 12,
        minimum_length_ft: 3,
        maximum_wall_interruption_ft: 4,
        maximum_face_pair_separation_ft: 1.5,
        opening_gap_minimum_confirming_profiles: 2
      }
    );
    const narrowPair = receipt.candidates.find((candidate) => candidate.derivation === "parallel_face_midline"
      && candidate.face_separation_ft !== null
      && candidate.face_separation_ft >= 0.3
      && candidate.face_separation_ft <= 0.65
      && receipt.opening_gap_hypotheses.some((opening) => opening.host_candidate_id === candidate.candidate_id));
    assert.ok(narrowPair, JSON.stringify(receipt.candidates, null, 2));
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

test("face pairing rejects sparse parallel annotation clutter", async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "architectural-sparse-face-clutter-"));
  try {
    const sparse = Array.from({ length: 8 }, (_, index) => {
      const x = 40 + index * 65;
      return [[x, 230], [x + 12, 230]] as [[number, number], [number, number]];
    });
    const fixture = await buildFixture(temp, "sparse-face-clutter", [
      [[40, 90], [210, 90]],
      [[310, 90], [560, 90]],
      [[40, 102], [210, 102]],
      [[310, 102], [560, 102]],
      ...sparse,
      ...sparse.map((line) => [[line[0][0], 250], [line[1][0], 250]] as [[number, number], [number, number]])
    ]);
    const receipt = await buildArchitecturalWallLineCandidates(
      fixture.delta,
      sha256(fixture.deltaReceiptPath),
      fixture.measurement,
      sha256(fixture.measurementReceiptPath),
      path.join(temp, "sparse-face-clutter-candidates"),
      {
        maximum_candidates: 12,
        minimum_length_ft: 3,
        maximum_wall_interruption_ft: 4,
        maximum_face_pair_separation_ft: 1.5
      }
    );
    assert.ok(receipt.candidates.some((candidate) => candidate.derivation === "parallel_face_midline"
      && candidate.face_separation_ft !== null
      && candidate.face_separation_ft >= 0.3
      && candidate.face_separation_ft <= 0.5));
    assert.equal(receipt.candidates.some((candidate) => candidate.derivation === "parallel_face_midline"
      && Math.abs(candidate.angle_degrees) <= 1
      && candidate.pixel_points.reduce((sum, point) => sum + point.y, 0) / 2 >= 200), false,
    JSON.stringify(receipt.candidates, null, 2));
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

test("window-symbol discovery binds split glazing strokes to a continuous redacted wall host", async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "architectural-window-symbol-host-"));
  try {
    const fixture = await buildFixture(temp, "window-symbol-host", [
      [[220, 182], [294, 182]],
      [[306, 182], [380, 182]],
      [[220, 198], [294, 198]],
      [[306, 198], [380, 198]],
      [[210, 175], [210, 205]],
      [[390, 175], [390, 205]]
    ], [
      [[40, 170], [560, 170]],
      [[40, 210], [560, 210]]
    ]);
    const receipt = await buildArchitecturalWallLineCandidates(
      fixture.delta,
      sha256(fixture.deltaReceiptPath),
      fixture.measurement,
      sha256(fixture.measurementReceiptPath),
      path.join(temp, "window-symbol-candidates"),
      {
        maximum_candidates: 12,
        minimum_length_ft: 2,
        maximum_face_pair_separation_ft: 2
      }
    );
    const symbols = receipt.opening_gap_hypotheses.filter(
      (entry) => entry.kind === "unclassified_opening_symbol"
    );
    assert.equal(symbols.length, 1, JSON.stringify(receipt.opening_gap_hypotheses, null, 2));
    const opening = symbols[0]!;
    assert.equal(opening.evidence_basis, "source_symbol_on_redacted_wall");
    assert.ok(opening.width_ft >= 5.2 && opening.width_ft <= 6.1, JSON.stringify(opening, null, 2));
    assert.ok(opening.pixel_center.x >= 285 && opening.pixel_center.x <= 315);
    assert.ok(opening.evidence_score >= 0.85);
    const host = receipt.candidates.find((candidate) => candidate.candidate_id === opening.host_candidate_id);
    assert.ok(host);
    assert.equal(host.evidence_source, "redacted_model");
    assert.equal(host.derivation, "parallel_face_midline");
    assert.ok(host.supporting_face_pixel_points);
    assert.ok(Math.abs(host.angle_degrees) <= 1);
    const crop = receipt.opening_evidence_crops.find(
      (entry) => entry.opening_hypothesis_id === opening.opening_hypothesis_id
    );
    assert.ok(crop);
    assert.equal(sha256(crop.source_crop.path), crop.source_crop.sha256);
    assert.equal(sha256(crop.evidence_overlay.path), crop.evidence_overlay.sha256);
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

test("window-symbol discovery rejects one longitudinal stroke on an otherwise continuous wall", async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "architectural-window-symbol-one-line-"));
  try {
    const fixture = await buildFixture(temp, "window-symbol-one-line", [
      [[210, 190], [390, 190]],
      [[250, 175], [250, 205]],
      [[350, 175], [350, 205]]
    ], [
      [[40, 170], [560, 170]],
      [[40, 210], [560, 210]]
    ]);
    const receipt = await buildArchitecturalWallLineCandidates(
      fixture.delta,
      sha256(fixture.deltaReceiptPath),
      fixture.measurement,
      sha256(fixture.measurementReceiptPath),
      path.join(temp, "one-line-candidates"),
      { maximum_candidates: 12, minimum_length_ft: 2, maximum_face_pair_separation_ft: 2 }
    );
    assert.equal(receipt.opening_gap_hypotheses.some(
      (entry) => entry.kind === "unclassified_opening_symbol"
    ), false, JSON.stringify(receipt.opening_gap_hypotheses, null, 2));
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

test("window-symbol discovery rejects parallel annotation strokes away from the redacted wall band", async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "architectural-window-symbol-offset-annotation-"));
  try {
    const fixture = await buildFixture(temp, "window-symbol-offset-annotation", [
      [[210, 70], [390, 70]],
      [[210, 86], [390, 86]]
    ], [
      [[40, 170], [560, 170]],
      [[40, 210], [560, 210]]
    ]);
    const receipt = await buildArchitecturalWallLineCandidates(
      fixture.delta,
      sha256(fixture.deltaReceiptPath),
      fixture.measurement,
      sha256(fixture.measurementReceiptPath),
      path.join(temp, "offset-annotation-candidates"),
      { maximum_candidates: 12, minimum_length_ft: 2, maximum_face_pair_separation_ft: 2 }
    );
    assert.equal(receipt.opening_gap_hypotheses.some(
      (entry) => entry.kind === "unclassified_opening_symbol"
    ), false, JSON.stringify(receipt.opening_gap_hypotheses, null, 2));
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

test("window-symbol discovery rejects unclosed paired annotation strokes inside the host band", async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "architectural-window-symbol-same-side-annotation-"));
  try {
    const fixture = await buildFixture(temp, "window-symbol-same-side-annotation", [
      [[210, 174], [390, 174]],
      [[210, 182], [390, 182]]
    ], [
      [[40, 170], [560, 170]],
      [[40, 210], [560, 210]]
    ]);
    const receipt = await buildArchitecturalWallLineCandidates(
      fixture.delta,
      sha256(fixture.deltaReceiptPath),
      fixture.measurement,
      sha256(fixture.measurementReceiptPath),
      path.join(temp, "same-side-annotation-candidates"),
      { maximum_candidates: 12, minimum_length_ft: 2, maximum_face_pair_separation_ft: 2 }
    );
    assert.equal(receipt.opening_gap_hypotheses.some(
      (entry) => entry.kind === "unclassified_opening_symbol"
    ), false, JSON.stringify(receipt.opening_gap_hypotheses, null, 2));
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

test("window-symbol discovery keeps adjacent windows separate across an ordinary wall pier", async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "architectural-window-symbol-adjacent-"));
  try {
    const fixture = await buildFixture(temp, "window-symbol-adjacent", [
      [[140, 182], [240, 182]],
      [[140, 198], [240, 198]],
      [[130, 175], [130, 205]],
      [[250, 175], [250, 205]],
      [[300, 182], [400, 182]],
      [[300, 198], [400, 198]],
      [[290, 175], [290, 205]],
      [[410, 175], [410, 205]]
    ], [
      [[40, 170], [560, 170]],
      [[40, 210], [560, 210]]
    ]);
    const receipt = await buildArchitecturalWallLineCandidates(
      fixture.delta,
      sha256(fixture.deltaReceiptPath),
      fixture.measurement,
      sha256(fixture.measurementReceiptPath),
      path.join(temp, "adjacent-window-candidates"),
      { maximum_candidates: 12, minimum_length_ft: 2, maximum_face_pair_separation_ft: 2 }
    );
    const symbols = receipt.opening_gap_hypotheses.filter(
      (entry) => entry.kind === "unclassified_opening_symbol"
    );
    assert.equal(symbols.length, 2, JSON.stringify(symbols, null, 2));
    assert.ok(symbols.every((entry) => entry.width_ft < 5), JSON.stringify(symbols, null, 2));
    assert.ok(Math.abs(symbols[0]!.pixel_center.x - symbols[1]!.pixel_center.x) > 100);
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

test("physical opening dedup prefers source-symbol evidence without collapsing an adjacent opening or parallel wall", () => {
  const opening = (
    id: string,
    center: { x: number; y: number },
    width: number,
    basis: ArchitecturalOpeningGapHypothesis["evidence_basis"]
  ): ArchitecturalOpeningGapHypothesis => ({
    opening_hypothesis_id: id,
    rank: 1,
    kind: basis === "source_symbol_on_redacted_wall" ? "unclassified_opening_symbol" : "unclassified_opening_gap",
    host_candidate_id: `host-${id}`,
    pixel_center: center,
    model_center: center,
    width_ft: width,
    host_chainage_ft: center.x,
    host_chainage_ratio: 0.5,
    profile_axis_degrees: 0,
    confirming_profile_count: 2,
    profile_offset_range_ft: [-0.5, 0.5],
    flank_ink_coverage: 0.9,
    gap_ink_coverage: 0,
    profile_ink_coverage: 0.9,
    evidence_score: basis === "source_symbol_on_redacted_wall" ? 0.91 : 0.95,
    evidence_basis: basis
  });
  const distinct = deduplicateArchitecturalOpeningHypotheses([
    opening("symbol", { x: 5, y: 0 }, 4.4, "source_symbol_on_redacted_wall"),
    opening("gap-a", { x: 5.02, y: 0.2 }, 4, "wall_face_gap"),
    opening("gap-b", { x: 4.98, y: 0.22 }, 4.05, "wall_face_gap"),
    opening("adjacent", { x: 10, y: 0 }, 3.5, "source_symbol_on_redacted_wall"),
    opening("parallel-wall", { x: 5, y: 0.6 }, 4, "wall_face_gap")
  ], {
    opening_gap_axis_snap_tolerance_degrees: 8,
    duplicate_separation_ft: 0.65,
    maximum_opening_gap_hypotheses: 12
  });
  assert.deepEqual(distinct.map((entry) => entry.opening_hypothesis_id), ["symbol", "adjacent", "parallel-wall"]);
  assert.deepEqual(distinct.map((entry) => entry.rank), [1, 2, 3]);
});

test("physical opening dedup collapses alternate hosts that reuse the same wall face", () => {
  const opening = (id: string, host: string, y: number, width: number): ArchitecturalOpeningGapHypothesis => ({
    opening_hypothesis_id: id,
    rank: 1,
    kind: "unclassified_opening_symbol",
    host_candidate_id: host,
    pixel_center: { x: 5, y },
    model_center: { x: 5, y },
    width_ft: width,
    host_chainage_ft: 5,
    host_chainage_ratio: 0.5,
    profile_axis_degrees: 0,
    confirming_profile_count: 2,
    profile_offset_range_ft: [-0.5, 0.5],
    flank_ink_coverage: 0.9,
    gap_ink_coverage: 0,
    profile_ink_coverage: 0.9,
    evidence_score: host === "primary" ? 0.96 : 0.88,
    evidence_basis: "source_symbol_on_redacted_wall"
  });
  const host = (
    id: string,
    centerY: number,
    separation: number,
    faces: [[{ x: number; y: number }, { x: number; y: number }], [{ x: number; y: number }, { x: number; y: number }]]
  ): ArchitecturalWallLineCandidate => ({
    candidate_id: id,
    rank: 1,
    derivation: "parallel_face_midline",
    pixel_points: [{ x: 0, y: centerY }, { x: 10, y: centerY }],
    model_points: [{ x: 0, y: centerY }, { x: 10, y: centerY }],
    face_separation_ft: separation,
    supporting_face_pixel_points: faces,
    supporting_face_model_points: faces,
    angle_degrees: 0,
    length_ft: 10,
    candidate_coverage: 1,
    source_ink_coverage: 1,
    rank_score: 1,
    evidence_source: "redacted_model"
  });
  const primary = host("primary", 0, 1, [[{ x: 0, y: -0.5 }, { x: 10, y: -0.5 }], [{ x: 0, y: 0.5 }, { x: 10, y: 0.5 }]]);
  const alternate = host("alternate", -0.66, 0.32, [[{ x: 0, y: -0.82 }, { x: 10, y: -0.82 }], [{ x: 0, y: -0.5 }, { x: 10, y: -0.5 }]]);
  const separate = host("separate", 1.2, 0.4, [[{ x: 0, y: 1 }, { x: 10, y: 1 }], [{ x: 0, y: 1.4 }, { x: 10, y: 1.4 }]]);
  const distinct = deduplicateArchitecturalOpeningHypotheses([
    opening("primary-opening", "primary", 0, 4.5),
    opening("alternate-opening", "alternate", -0.66, 4),
    opening("separate-opening", "separate", 1.2, 4)
  ], {
    opening_gap_axis_snap_tolerance_degrees: 8,
    duplicate_separation_ft: 0.65,
    maximum_opening_gap_hypotheses: 12
  }, [primary, alternate, separate]);
  assert.deepEqual(distinct.map((entry) => entry.opening_hypothesis_id), ["primary-opening", "separate-opening"]);
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
