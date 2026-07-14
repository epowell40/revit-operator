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

test("package CLI copies and hash-binds optional registration and type-catalog artifacts", () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "existing-conditions-agent-package-"));
  try {
    const modelPath = path.join(temp, "redacted.rvt");
    const pdfPath = path.join(temp, "source.pdf");
    const registrationPath = path.join(temp, "registration-input.json");
    const typeCatalogPath = path.join(temp, "type-catalog-input.json");
    const outDir = path.join(temp, "agent");
    fs.writeFileSync(modelPath, "model", "utf8");
    fs.writeFileSync(pdfPath, "%PDF-1.7\n", "utf8");
    fs.writeFileSync(registrationPath, `${JSON.stringify({ schema_version: 1, verified: true })}\n`, "utf8");
    fs.writeFileSync(typeCatalogPath, `${JSON.stringify({ schema_version: 1, mappings: [] })}\n`, "utf8");

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
      "--type-mapping-artifact", typeCatalogPath
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
    const controller = JSON.parse(fs.readFileSync(path.join(outDir, "controller_state.json"), "utf8"));
    assert.deepEqual(controller.state.expected_visible_evidence, [
      { role: "source_pdf", sha256: sha256(path.join(outDir, "source_evidence.pdf")) },
      { role: "source_to_model_registration", sha256: sha256(registrationCopy) },
      { role: "approved_type_catalog", sha256: sha256(typeCatalogCopy) }
    ]);
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});
