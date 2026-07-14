import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import assert from "node:assert/strict";
import test from "node:test";

const SOURCE_HASH = "9".repeat(64);

function writeJson(filePath: string, value: unknown): void {
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

test("architectural preview CLI emits a non-writing preview and an evidence-backed exact dry-run action", () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "existing-conditions-architectural-preview-"));
  try {
    const inputPath = path.join(temp, "preview-input.json");
    const resolutionsPath = path.join(temp, "resolutions.json");
    const previewPath = path.join(temp, "preview.json");
    const promotionPath = path.join(temp, "promotion.json");
    const actionPath = path.join(temp, "action.json");
    writeJson(inputPath, {
      schema_version: 1,
      fixture_id: "architectural-preview-cli-v1",
      scope_id: "scope-cli",
      source_evidence_sha256: SOURCE_HASH,
      visible_evidence: [{ role: "source_pdf", sha256: SOURCE_HASH }],
      registration: {
        source_evidence_sha256: SOURCE_HASH,
        control_points: [
          { source: { x: 0, y: 0 }, model: { x: 0, y: 0 } },
          { source: { x: 10, y: 0 }, model: { x: 10, y: 0 } },
          { source: { x: 0, y: 10 }, model: { x: 0, y: 10 } }
        ]
      },
      level_name: "L4",
      level_elevation_ft: 32,
      maximum_created_elements: 2,
      observations: [
        {
          kind: "wall",
          discipline: "architectural",
          observation_id: "wall-cli-1",
          visibility: "clear",
          confidence: 0.99,
          supported_attributes: ["location"],
          points: [{ x: 0, y: 0 }, { x: 10, y: 0 }]
        },
        {
          kind: "door",
          discipline: "architectural",
          observation_id: "door-cli-1",
          visibility: "clear",
          confidence: 0.98,
          supported_attributes: ["location", "host", "width"],
          point: { x: 5, y: 0 },
          host_wall_observation_id: "wall-cli-1",
          width_ft: 3
        }
      ]
    });
    writeJson(resolutionsPath, [
      {
        observation_id: "wall-cli-1",
        attributes: [
          { attribute: "type", value: "Interior Partition", basis: "project_precedent", evidence_reference: "catalog:wall-1" },
          { attribute: "thickness", value: 0.5, basis: "project_precedent", evidence_reference: "catalog:wall-1" },
          { attribute: "height", value: 10, basis: "project_precedent", evidence_reference: "analog:wall-1" }
        ]
      },
      {
        observation_id: "door-cli-1",
        attributes: [
          { attribute: "family", value: "Single-Flush", basis: "project_precedent", evidence_reference: "catalog:door-1" },
          { attribute: "type", value: "36 x 84", basis: "project_precedent", evidence_reference: "catalog:door-1" },
          { attribute: "height", value: 7, basis: "project_precedent", evidence_reference: "catalog:door-1" }
        ]
      }
    ]);

    const cli = path.resolve(process.cwd(), "dist/src/tools/existing_conditions_fixture.js");
    const previewRun = spawnSync(process.execPath, [
      cli, "compile-architectural-preview", "--input", inputPath, "--out", previewPath
    ], { cwd: process.cwd(), encoding: "utf8" });
    assert.equal(previewRun.status, 0, previewRun.stderr || previewRun.stdout);
    const preview = JSON.parse(fs.readFileSync(previewPath, "utf8"));
    assert.equal(preview.status, "preview_ready");
    assert.equal(preview.native_action, null);
    assert.deepEqual(preview.preview_elements[1].geometry.point, { x: 5, y: 0 });

    const promotionRun = spawnSync(process.execPath, [
      cli, "promote-architectural-preview",
      "--input", inputPath,
      "--resolutions", resolutionsPath,
      "--out", promotionPath,
      "--action-out", actionPath
    ], { cwd: process.cwd(), encoding: "utf8" });
    assert.equal(promotionRun.status, 0, promotionRun.stderr || promotionRun.stdout);
    const promotion = JSON.parse(fs.readFileSync(promotionPath, "utf8"));
    const action = JSON.parse(fs.readFileSync(actionPath, "utf8"));
    assert.equal(promotion.compiled_plan.status, "ready");
    assert.equal(action.dryRun, true);
    assert.equal(action.requireExactWallTypes, true);
    assert.equal(action.requireExactOpeningTypes, true);
    assert.deepEqual(action.geometry.elements[0].path, [[0, 0], [10, 0]]);
    assert.equal(action.geometry.elements[1].hostWallId, "wall-cli-1");
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});
