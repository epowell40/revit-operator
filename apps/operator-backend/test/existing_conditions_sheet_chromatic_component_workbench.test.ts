import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createCanvas } from "@napi-rs/canvas";
import { executeWorkbenchActions } from "../src/workbench/workbench_runner.js";

test("workbench exposes one terminal source-only chromatic component observation", async () => {
  const previousRoot = process.env.OPERATOR_WORKSPACE_ROOT;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "operator-chromatic-component-wb-"));
  process.env.OPERATOR_WORKSPACE_ROOT = root;
  try {
    const fixtures = path.join(root, "fixtures");
    fs.mkdirSync(fixtures, { recursive: true });
    const canvas = createCanvas(180, 80);
    const context = canvas.getContext("2d");
    context.fillStyle = "white";
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.strokeStyle = "#003fff";
    context.lineWidth = 3;
    for (const x of [30, 85, 140]) {
      context.beginPath();
      context.arc(x, 40, 8, 0, Math.PI * 2);
      context.moveTo(x - 11, 40);
      context.lineTo(x + 11, 40);
      context.stroke();
    }
    const source = canvas.toBuffer("image/png");
    const sourceHash = crypto.createHash("sha256").update(source).digest("hex");
    fs.writeFileSync(path.join(fixtures, "source.png"), source);
    fs.writeFileSync(path.join(fixtures, "input.json"), JSON.stringify({
      schema_version: 1,
      source_image_path: "fixtures/source.png",
      source_image_sha256: sourceHash,
      source_image_width_px: canvas.width,
      source_image_height_px: canvas.height,
      search_region: { min: { x: 0, y: 0 }, max: { x: canvas.width, y: canvas.height } },
      expected_hue_degrees: 225,
      hue_tolerance_degrees: 20,
      minimum_chroma: 80,
      minimum_component_pixels: 20,
      maximum_component_pixels: 500,
      minimum_component_width_px: 10,
      maximum_component_width_px: 30,
      minimum_component_height_px: 10,
      maximum_component_height_px: 30
    }));

    const results = await executeWorkbenchActions([{
      type: "detect_sheet_chromatic_components",
      input_file_path: "fixtures/input.json",
      overlay_output_path: "artifacts/components/overlay.png",
      receipt_output_path: "artifacts/components/receipt.json"
    }]);

    assert.equal(results.length, 1);
    assert.equal(results[0]?.ok, true);
    assert.match(results[0]?.summary ?? "", /candidates=3, qualifying_pixels=/);
    const details = results[0]?.details as any;
    assert.equal(details.candidates.length, 3);
    assert.ok(details.candidates.every((candidate: any) => candidate.native_write_allowed === false));
    assert.equal(fs.existsSync(path.join(root, "artifacts", "components", "overlay.png")), true);
    assert.equal(fs.existsSync(path.join(root, "artifacts", "components", "receipt.json")), true);
  } finally {
    if (previousRoot === undefined) delete process.env.OPERATOR_WORKSPACE_ROOT;
    else process.env.OPERATOR_WORKSPACE_ROOT = previousRoot;
    fs.rmSync(root, { recursive: true, force: true });
  }
});
