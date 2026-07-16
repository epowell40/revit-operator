import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import assert from "node:assert/strict";
import test from "node:test";

function sha256(filePath: string): string {
  return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

test("package CLI copies and hash-binds optional registration, type-catalog, and derived architectural evidence", () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "existing-conditions-agent-package-"));
  try {
    const modelPath = path.join(temp, "redacted.rvt");
    const pdfPath = path.join(temp, "source.pdf");
    const registrationPath = path.join(temp, "registration-input.json");
    const typeCatalogPath = path.join(temp, "type-catalog-input.json");
    const deltaSourceDir = path.join(temp, "delta-source");
    fs.mkdirSync(deltaSourceDir);
    const deltaArtifacts = Object.fromEntries(["source_aligned", "redacted_aligned", "candidate_delta_mask", "comparison"].map((name) => {
      const artifactPath = path.join(deltaSourceDir, `${name}.png`);
      fs.writeFileSync(artifactPath, `${name}-bytes`, "utf8");
      return [name, { path: artifactPath, sha256: sha256(artifactPath), width_px: 10, height_px: 10 }];
    }));
    const deltaReceiptPath = path.join(temp, "delta-receipt.json");
    const measurementOverlayPath = path.join(temp, "measurement-overlay.png");
    const measurementReceiptPath = path.join(temp, "measurement-receipt.json");
    const wallCandidateOverlayPath = path.join(temp, "wall-candidate-overlay.png");
    const openingSourceCropPath = path.join(temp, "opening-source.png");
    const openingEvidenceOverlayPath = path.join(temp, "opening-overlay.png");
    const wallCandidateReceiptPath = path.join(temp, "wall-candidate-receipt.json");
    const sourceRenderPath = path.join(temp, "source-render.png");
    const surroundingCapturePath = path.join(temp, "surrounding-capture.jpg");
    const outDir = path.join(temp, "agent");
    fs.writeFileSync(modelPath, "model", "utf8");
    fs.writeFileSync(pdfPath, "%PDF-1.7\n", "utf8");
    fs.writeFileSync(registrationPath, `${JSON.stringify({ schema_version: 1, verified: true })}\n`, "utf8");
    fs.writeFileSync(typeCatalogPath, `${JSON.stringify({ schema_version: 1, mappings: [] })}\n`, "utf8");
    fs.writeFileSync(sourceRenderPath, "source-render-bytes", "utf8");
    fs.writeFileSync(surroundingCapturePath, "surrounding-capture-bytes", "utf8");
    fs.writeFileSync(deltaReceiptPath, `${JSON.stringify({
      schema_version: 1,
      artifact_role: "architectural_source_redacted_delta",
      fixture_id: "package-artifacts-v1",
      scope_id: "scope",
      registration_verified: true,
      registration_source_evidence_sha256: "e".repeat(64),
      source_render_sha256: sha256(sourceRenderPath),
      redacted_model_capture_sha256: sha256(surroundingCapturePath),
      output_frame: { width_px: 10, height_px: 10 },
      artifacts: deltaArtifacts
    })}\n`, "utf8");
    fs.writeFileSync(measurementOverlayPath, "measurement-overlay-bytes", "utf8");
    fs.writeFileSync(measurementReceiptPath, `${JSON.stringify({
      schema_version: 1,
      artifact_role: "architectural_registered_measurement_overlay",
      fixture_id: "package-artifacts-v1",
      scope_id: "scope",
      architectural_delta_receipt_sha256: sha256(deltaReceiptPath),
      registration_source_evidence_sha256: "e".repeat(64),
      source_aligned_sha256: deltaArtifacts.source_aligned.sha256,
      candidate_delta_mask_sha256: deltaArtifacts.candidate_delta_mask.sha256,
      overlay: {
        path: measurementOverlayPath,
        sha256: sha256(measurementOverlayPath),
        width_px: 10,
        height_px: 10
      }
    })}\n`, "utf8");
    fs.writeFileSync(wallCandidateOverlayPath, "wall-candidate-overlay-bytes", "utf8");
    fs.writeFileSync(openingSourceCropPath, "opening-source-bytes", "utf8");
    fs.writeFileSync(openingEvidenceOverlayPath, "opening-overlay-bytes", "utf8");
    fs.writeFileSync(wallCandidateReceiptPath, `${JSON.stringify({
      schema_version: 1,
      artifact_role: "architectural_wall_line_candidates",
      fixture_id: "package-artifacts-v1",
      scope_id: "scope",
      architectural_delta_receipt_sha256: sha256(deltaReceiptPath),
      measurement_receipt_sha256: sha256(measurementReceiptPath),
      source_aligned_sha256: deltaArtifacts.source_aligned.sha256,
      candidate_delta_mask_sha256: deltaArtifacts.candidate_delta_mask.sha256,
      status: "clarification_required",
      policy: {},
      candidates: [{
        candidate_id: "line-a",
        rank: 1,
        pixel_points: [{ x: 1, y: 1 }, { x: 9, y: 9 }],
        model_points: [{ x: 1, y: 9 }, { x: 9, y: 1 }],
        angle_degrees: 45,
        length_ft: 8,
        candidate_coverage: 1,
        source_ink_coverage: 1,
        rank_score: 1
      }],
      junction_hypotheses: [],
      opening_gap_hypotheses: [{
        opening_hypothesis_id: "opening-a",
        rank: 1,
        kind: "unclassified_opening_gap",
        host_candidate_id: "line-a",
        pixel_center: { x: 5, y: 5 },
        model_center: { x: 5, y: 5 },
        width_ft: 3,
        host_chainage_ft: 4,
        host_chainage_ratio: 0.5,
        profile_axis_degrees: 45,
        confirming_profile_count: 3,
        profile_offset_range_ft: [-0.2, 0.2],
        flank_ink_coverage: 1,
        gap_ink_coverage: 0,
        profile_ink_coverage: 1,
        evidence_score: 0.9
      }],
      opening_evidence_crops: [{
        opening_hypothesis_id: "opening-a",
        host_candidate_id: "line-a",
        crop_bounds_px: { min_x: 0, min_y: 0, max_x: 10, max_y: 10 },
        source_crop: {
          path: openingSourceCropPath,
          sha256: sha256(openingSourceCropPath),
          width_px: 10,
          height_px: 10
        },
        evidence_overlay: {
          path: openingEvidenceOverlayPath,
          sha256: sha256(openingEvidenceOverlayPath),
          width_px: 10,
          height_px: 10
        }
      }],
      ambiguities: [],
      clarification_question: "Confirm the line.",
      overlay: {
        path: wallCandidateOverlayPath,
        sha256: sha256(wallCandidateOverlayPath),
        width_px: 10,
        height_px: 10
      },
      usage_constraints: []
    })}\n`, "utf8");

    const cli = path.resolve(process.cwd(), "dist/src/tools/existing_conditions_fixture.js");
    const result = spawnSync(process.execPath, [
      cli, "package",
      "--fixture-id", "package-artifacts-v1",
      "--scope-id", "scope",
      "--redacted-model", modelPath,
      "--source-pdf", pdfPath,
      "--out-dir", outDir,
      "--view-id", "1",
      "--discipline", "architectural",
      "--allowed-categories", "OST_Walls,OST_Doors,OST_Windows",
      "--model-bounds", "0,0,0,10,10,10",
      "--image-region", "0,0,1,1",
      "--registration-artifact", registrationPath,
      "--type-mapping-artifact", typeCatalogPath,
      "--source-pdf-render", sourceRenderPath,
      "--surrounding-model-capture", surroundingCapturePath,
      "--architectural-delta-receipt", deltaReceiptPath,
      "--architectural-measurement-receipt", measurementReceiptPath,
      "--architectural-wall-candidate-receipt", wallCandidateReceiptPath
    ], { cwd: process.cwd(), encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr || result.stdout);

    const packageValue = JSON.parse(fs.readFileSync(path.join(outDir, "agent_package.json"), "utf8"));
    const registrationCopy = path.join(outDir, "source_to_model_registration.json");
    const typeCatalogCopy = path.join(outDir, "approved_type_catalog.json");
    assert.deepEqual(packageValue.registration_artifact, {
      role: "source_to_model_registration",
      path: registrationCopy,
      sha256: sha256(registrationCopy)
    });
    assert.deepEqual(packageValue.type_mapping_artifact, {
      role: "approved_type_catalog",
      path: typeCatalogCopy,
      sha256: sha256(typeCatalogCopy)
    });
    assert.equal(packageValue.derived_evidence.length, 11);
    assert.equal(packageValue.derived_evidence.some(({ role }: { role: string }) => role === "architectural_opening_source_crop"), true);
    assert.equal(packageValue.derived_evidence.some(({ role }: { role: string }) => role === "architectural_opening_evidence_overlay"), true);
    assert.deepEqual(packageValue.evidence.map(({ role }: { role: string }) => role), [
      "source_pdf", "source_pdf_render", "surrounding_model_capture"
    ]);
    for (const artifact of packageValue.derived_evidence) {
      assert.equal(fs.existsSync(artifact.path), true);
      assert.equal(artifact.sha256, sha256(artifact.path));
    }
    const controller = JSON.parse(fs.readFileSync(path.join(outDir, "controller_state.json"), "utf8"));
    assert.deepEqual(controller.state.expected_visible_evidence, [
      { role: "source_pdf", sha256: sha256(path.join(outDir, "source_evidence.pdf")) },
      { role: "source_pdf_render", sha256: sha256(path.join(outDir, "source_evidence_page_1.png")) },
      { role: "surrounding_model_capture", sha256: sha256(path.join(outDir, "surrounding_model_capture.jpg")) },
      { role: "source_to_model_registration", sha256: sha256(registrationCopy) },
      { role: "approved_type_catalog", sha256: sha256(typeCatalogCopy) },
      ...packageValue.derived_evidence.map(({ role, sha256: hash }: { role: string; sha256: string }) => ({ role, sha256: hash }))
    ]);
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

test("capture CLI rejects evaluator-only linked scopes before native bridge access", () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "existing-conditions-linked-scope-"));
  try {
    const scopePath = path.join(temp, "linked-scope.json");
    fs.writeFileSync(scopePath, `${JSON.stringify({
      schema_version: 1,
      frame_id: "frame-linked",
      view_id: 101,
      host_scope_required: false,
      scope_mode: "host_and_linked",
      selected_element_ids: [],
      selected_scoped_ids: ["link:9:50"],
      selected_count: 1,
      selected: [{ element_id: 50, source_scoped_id: "link:9:50", source_scope: "linked", category: "Doors", selection_basis: "point_inside" }]
    })}\n`, "utf8");
    const cli = path.resolve(process.cwd(), "dist/src/tools/existing_conditions_fixture.js");
    const result = spawnSync(process.execPath, [
      cli, "capture",
      "--view-id", "101",
      "--scope", scopePath,
      "--out-dir", path.join(temp, "capture")
    ], { cwd: process.cwd(), encoding: "utf8" });

    assert.notEqual(result.status, 0);
    assert.match(`${result.stderr}\n${result.stdout}`, /linked scopes are evaluator-only/);
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});
