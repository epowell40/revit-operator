import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createCanvas } from "@napi-rs/canvas";
import {
  evaluateSealedCandidateNativeRouteGradeV1,
  type SealedCandidateNativeRouteGradeInputV1
} from "../src/existing_conditions/sealed_candidate_native_route_grade.js";

function sha(bytes: Buffer): string { return crypto.createHash("sha256").update(bytes).digest("hex"); }
function writeJson(directory: string, name: string, value: unknown): { path: string; sha256: string } {
  const file = path.join(directory, name); const bytes = Buffer.from(`${JSON.stringify(value, null, 2)}\n`); fs.writeFileSync(file, bytes); return { path: file, sha256: sha(bytes) };
}
function fixture(endU = 0.8): SealedCandidateNativeRouteGradeInputV1 {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "sealed-candidate-grade-"));
  const canvas = createCanvas(100, 100); const imageBytes = canvas.toBuffer("image/png"); const imagePath = path.join(directory, "source.png"); fs.writeFileSync(imagePath, imageBytes);
  const candidate = writeJson(directory, "candidate.json", { interpretation: { coordinate_space: "normalized_uv_top_left", primitives: [{ primitive_id: "route-a", kind: "route_segment", points: [{ u: 0.1, v: 0.5 }, { u: endU, v: 0.5 }], claims: { type: { value: "round" }, size: { value: "4 inch" } } }] } });
  const seal = writeJson(directory, "seal.json", { sealed_at_utc: "2026-07-01T12:00:00.000Z", source_image_sha256: sha(imageBytes), candidate_sha256: candidate.sha256 });
  const native = writeJson(directory, "native.json", { coordinate_space: "source_pixel_top_left", routes: [{ route_id: "native-a", points: [{ x: 10, y: 50 }, { x: 80, y: 50 }], connector_shapes: ["Round"], parameters: { diameter: "4\"" } }] });
  return { schema_version: 1, fixture_id: "fixture-a", source_image_path: imagePath, source_image_sha256: sha(imageBytes), source_image_width_px: 100, source_image_height_px: 100,
    candidate_artifact_path: candidate.path, candidate_artifact_sha256: candidate.sha256, candidate_seal_path: seal.path, candidate_seal_sha256: seal.sha256,
    registered_native_route_artifact_path: native.path, registered_native_route_artifact_sha256: native.sha256, evaluated_at_utc: "2026-07-01T12:01:00.000Z", required_claims: ["profile", "size"],
    policy: { diagnostic_translation_maximum_px: 10, diagnostic_translation_coarse_step_px: 5, diagnostic_translation_fine_step_px: 1 } };
}

test("accepts hash-bound post-seal route geometry and declared claims", async () => {
  const receipt = await evaluateSealedCandidateNativeRouteGradeV1(fixture());
  assert.equal(receipt.status, "accepted_post_seal_native_grade"); assert.equal(receipt.truth_revealed_after_candidate_seal, true); assert.equal(receipt.geometry.source_to_native.coverage_fraction, 1); assert.equal(receipt.native_write_allowed, false);
});

test("rejects incomplete geometry and keeps diagnostic translation out of credit", async () => {
  const receipt = await evaluateSealedCandidateNativeRouteGradeV1(fixture(0.4));
  assert.equal(receipt.status, "candidate_repair_required"); assert.ok(receipt.failed_gates.some(gate => gate.includes("native_to_source"))); assert.ok(receipt.geometry.best_translation_diagnostic); assert.equal(receipt.geometry.best_translation_diagnostic?.acceptance_use, "diagnostic_only_never_candidate_repair_or_credit");
});

test("rejects evaluator truth dated before the immutable candidate seal", async () => {
  const input = fixture(); input.evaluated_at_utc = "2026-07-01T11:59:59.000Z";
  await assert.rejects(() => evaluateSealedCandidateNativeRouteGradeV1(input), /truth_must_follow_candidate_seal/);
});

test("rejects a candidate artifact that no longer matches its seal", async () => {
  const input = fixture(); fs.appendFileSync(input.candidate_artifact_path, " "); input.candidate_artifact_sha256 = sha(fs.readFileSync(input.candidate_artifact_path));
  await assert.rejects(() => evaluateSealedCandidateNativeRouteGradeV1(input), /seal_candidate_hash_mismatch/);
});
