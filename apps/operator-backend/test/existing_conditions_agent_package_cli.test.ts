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
      source_render_sha256: sha256(sourceRenderPath),
      redacted_model_capture_sha256: sha256(surroundingCapturePath),
      artifacts: deltaArtifacts
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
      "--architectural-delta-receipt", deltaReceiptPath
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
    assert.equal(packageValue.derived_evidence.length, 5);
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
