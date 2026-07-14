import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createCanvas, loadImage } from "@napi-rs/canvas";
import assert from "node:assert/strict";
import test from "node:test";
import {
  buildArchitecturalSourceDelta,
  type ArchitecturalSourceDeltaInput
} from "../src/existing_conditions/architectural_source_delta.js";
import { auditArchitecturalRedactionVisibility } from "../src/existing_conditions/architectural_redaction_visibility_gate.js";
import type { ExistingConditionsGroundTruth } from "../src/benchmark/existing_conditions_reconstruction.js";

function sha256(filePath: string): string {
  return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

function drawFixture(filePath: string, lines: number[]): void {
  const canvas = createCanvas(200, 200);
  const context = canvas.getContext("2d");
  context.fillStyle = "#ffffff";
  context.fillRect(0, 0, 200, 200);
  context.strokeStyle = "#000000";
  context.lineWidth = 4;
  for (const x of lines) {
    context.beginPath();
    context.moveTo(x, 20);
    context.lineTo(x, 180);
    context.stroke();
  }
  fs.writeFileSync(filePath, canvas.toBuffer("image/png"));
}

function deltaInput(sourcePath: string, redactedPath: string): ArchitecturalSourceDeltaInput {
  return {
    schema_version: 1,
    fixture_id: "architectural-delta-independent-v1",
    scope_id: "synthetic-scope-19",
    source_render: {
      path: sourcePath,
      sha256: sha256(sourcePath),
      width_px: 200,
      height_px: 200,
      source_sheet_bounds: { min: { x: 0, y: 0 }, max: { x: 10, y: 10 } }
    },
    registration: {
      schema_version: 1,
      source_evidence_sha256: "4".repeat(64),
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

function architecturalTruth(): ExistingConditionsGroundTruth {
  return {
    schema_version: 1,
    fixture_id: "architectural-delta-independent-v1",
    scope_id: "synthetic-scope-19",
    discipline: "architectural",
    visible_evidence: [],
    snapshot: {
      native_readback: true,
      open_connector_count: 0,
      connections: [{ a: "target-window", b: "target-wall", kind: "host" }],
      elements: [
        {
          key: "target-wall",
          kind: "linear_element",
          discipline: "architectural",
          role: "wall",
          category: "Walls",
          endpoints: [{ x: 7, y: 9, z: 0 }, { x: 7, y: 1, z: 0 }]
        },
        {
          key: "target-window",
          kind: "family_instance",
          discipline: "architectural",
          role: "window",
          category: "Windows",
          location: { x: 7, y: 5, z: 0 },
          host_key: "target-wall"
        }
      ]
    }
  };
}

test("registered source/redacted delta suppresses common geometry and highlights source-only ink", async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "architectural-source-delta-"));
  try {
    const sourcePath = path.join(temp, "source.png");
    const redactedPath = path.join(temp, "redacted.png");
    const outDir = path.join(temp, "out");
    drawFixture(sourcePath, [40, 140]);
    drawFixture(redactedPath, [40]);
    const receipt = await buildArchitecturalSourceDelta(deltaInput(sourcePath, redactedPath), outDir);
    assert.equal(receipt.registration_verified, true);
    assert.equal(receipt.output_frame.width_px, 200);
    assert.equal(receipt.output_frame.height_px, 200);
    assert.match(receipt.usage_constraints[2] ?? "", /must never be interpreted as target walls/);
    for (const artifact of Object.values(receipt.artifacts)) {
      assert.equal(fs.existsSync(artifact.path), true);
      assert.equal(sha256(artifact.path), artifact.sha256);
    }
    const delta = await loadImage(receipt.artifacts.candidate_delta_mask.path);
    const canvas = createCanvas(200, 200);
    const context = canvas.getContext("2d");
    context.drawImage(delta, 0, 0);
    const pixels = context.getImageData(0, 0, 200, 200).data;
    const alphaAt = (x: number, y: number): number => pixels[(y * 200 + x) * 4 + 3]!;
    assert.equal(alphaAt(40, 100), 0, "common source/redacted line should be suppressed");
    assert.ok(alphaAt(140, 100) > 0, "source-only line should remain in the candidate delta");
    await assert.rejects(
      buildArchitecturalSourceDelta(deltaInput(sourcePath, redactedPath), outDir),
      /refusing_to_overwrite_architectural_source_delta/
    );
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

test("delta generation rejects unverified registration and changed visible image bytes", async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "architectural-source-delta-invalid-"));
  try {
    const sourcePath = path.join(temp, "source.png");
    const redactedPath = path.join(temp, "redacted.png");
    drawFixture(sourcePath, [40, 140]);
    drawFixture(redactedPath, [40]);
    const unverified = deltaInput(sourcePath, redactedPath);
    unverified.registration.verified = false;
    await assert.rejects(
      buildArchitecturalSourceDelta(unverified, path.join(temp, "unverified")),
      /requires_verified_registration/
    );
    const changed = deltaInput(sourcePath, redactedPath);
    changed.source_render.sha256 = "0".repeat(64);
    await assert.rejects(
      buildArchitecturalSourceDelta(changed, path.join(temp, "changed")),
      /source_render_sha256_mismatch/
    );
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

test("architectural redaction gate requires visible target removal and retained common background", async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "architectural-redaction-gate-"));
  try {
    const sourcePath = path.join(temp, "source.png");
    const redactedPath = path.join(temp, "redacted.png");
    drawFixture(sourcePath, [40, 140]);
    drawFixture(redactedPath, [40]);
    const receipt = await buildArchitecturalSourceDelta(deltaInput(sourcePath, redactedPath), path.join(temp, "pass"));
    const gate = await auditArchitecturalRedactionVisibility(architecturalTruth(), receipt);
    assert.equal(gate.passed, true);
    assert.equal(gate.targets.length, 2);
    assert.equal(gate.targets.every((target) => target.passed), true);
    assert.equal(gate.background.passed, true);
    assert.ok(gate.background.common_ink_pixels_outside_targets >= 100);
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

test("architectural redaction gate rejects an unredacted target", async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "architectural-redaction-target-fail-"));
  try {
    const sourcePath = path.join(temp, "source.png");
    const redactedPath = path.join(temp, "redacted.png");
    drawFixture(sourcePath, [40, 140]);
    drawFixture(redactedPath, [40, 140]);
    const receipt = await buildArchitecturalSourceDelta(deltaInput(sourcePath, redactedPath), path.join(temp, "out"));
    const gate = await auditArchitecturalRedactionVisibility(architecturalTruth(), receipt);
    assert.equal(gate.passed, false);
    assert.ok(gate.failure_classifications.includes("withheld_target_not_visibly_redacted"));
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

test("architectural redaction gate rejects a missing architectural background", async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "architectural-redaction-background-fail-"));
  try {
    const sourcePath = path.join(temp, "source.png");
    const redactedPath = path.join(temp, "redacted.png");
    drawFixture(sourcePath, [40, 140]);
    drawFixture(redactedPath, []);
    const receipt = await buildArchitecturalSourceDelta(deltaInput(sourcePath, redactedPath), path.join(temp, "out"));
    const gate = await auditArchitecturalRedactionVisibility(architecturalTruth(), receipt);
    assert.equal(gate.passed, false);
    assert.ok(gate.failure_classifications.includes("architectural_background_not_retained"));
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});
