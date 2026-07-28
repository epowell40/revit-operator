import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import {
  createExistingConditionsEvaluatorVisualReceipt,
  validateExistingConditionsEvaluatorVisualReceipt
} from "../src/existing_conditions/evaluator_visual.js";

const PNG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 1]);
const PDF = Buffer.from("%PDF-1.4\n1 0 obj\n<<>>\nendobj\n%%EOF\n", "ascii");

function artifacts(): { root: string; capture: string; pdf: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "operator-evaluator-visual-"));
  const capture = path.join(root, "post.png");
  const pdf = path.join(root, "post.pdf");
  fs.writeFileSync(capture, PNG);
  fs.writeFileSync(pdf, PDF);
  return { root, capture, pdf };
}

test("creates and validates an evaluator-owned receipt bound to real artifact bytes", () => {
  const fixture = artifacts();
  const receipt = createExistingConditionsEvaluatorVisualReceipt({
    post_change_capture_path: fixture.capture,
    post_change_pdf_path: fixture.pdf,
    artifact_scope_root: fixture.root,
    review_status: "pass",
    notes: ["Tag is legible and clear of the device."]
  });
  assert.equal(validateExistingConditionsEvaluatorVisualReceipt(receipt, { allowed_artifact_root: fixture.root }), true);
  assert.equal(receipt.post_change_capture_sha256.length, 64);
  assert.equal(receipt.post_change_capture_artifact.byte_length, PNG.length);
});

test("rejects a visual receipt whose review was modified after sealing", () => {
  const fixture = artifacts();
  const receipt = createExistingConditionsEvaluatorVisualReceipt({
    post_change_capture_path: fixture.capture,
    post_change_pdf_path: fixture.pdf,
    artifact_scope_root: fixture.root,
    review_status: "needs_review"
  });
  receipt.evaluator_review.review_status = "pass";
  assert.equal(validateExistingConditionsEvaluatorVisualReceipt(receipt), false);
});

test("rejects SHA-shaped fabrication, missing paths, wrong media, scope escape, and changed bytes", () => {
  const fixture = artifacts();
  const receipt = createExistingConditionsEvaluatorVisualReceipt({
    post_change_capture_path: fixture.capture,
    post_change_pdf_path: fixture.pdf,
    artifact_scope_root: fixture.root,
    review_status: "pass"
  });
  const fabricated = JSON.parse(JSON.stringify(receipt));
  fabricated.post_change_capture_sha256 = "a".repeat(64);
  fabricated.post_change_capture_artifact.sha256 = "a".repeat(64);
  assert.equal(validateExistingConditionsEvaluatorVisualReceipt(fabricated), false);

  fs.writeFileSync(fixture.capture, Buffer.from("not an image", "utf8"));
  assert.equal(validateExistingConditionsEvaluatorVisualReceipt(receipt), false);
  assert.throws(() => createExistingConditionsEvaluatorVisualReceipt({
    post_change_capture_path: fixture.pdf,
    post_change_pdf_path: fixture.pdf,
    artifact_scope_root: fixture.root,
    review_status: "pass"
  }), /artifact_media_mismatch/);

  const outsideRoot = fs.mkdtempSync(path.join(os.tmpdir(), "operator-evaluator-outside-"));
  assert.throws(() => createExistingConditionsEvaluatorVisualReceipt({
    post_change_capture_path: path.join(outsideRoot, "missing.png"),
    post_change_pdf_path: fixture.pdf,
    artifact_scope_root: fixture.root,
    review_status: "pass"
  }));
});

test("evaluator visual CLI emits a byte-bound receipt and rejects artifacts outside its output scope", () => {
  const fixture = artifacts();
  const out = path.join(fixture.root, "visual-receipt.json");
  const cli = path.resolve("dist/src/tools/existing_conditions_fixture.js");
  const accepted = spawnSync(process.execPath, [
    cli,
    "evaluator-review-visual",
    "--post-capture", fixture.capture,
    "--post-pdf", fixture.pdf,
    "--status", "pass",
    "--out", out
  ], { encoding: "utf8" });
  assert.equal(accepted.status, 0, accepted.stderr);
  const receipt = JSON.parse(fs.readFileSync(out, "utf8"));
  assert.equal(validateExistingConditionsEvaluatorVisualReceipt(receipt, { allowed_artifact_root: fixture.root }), true);

  const outside = artifacts();
  const rejected = spawnSync(process.execPath, [
    cli,
    "evaluator-review-visual",
    "--post-capture", outside.capture,
    "--post-pdf", outside.pdf,
    "--status", "pass",
    "--out", out
  ], { encoding: "utf8" });
  assert.notEqual(rejected.status, 0);
  assert.match(rejected.stderr, /outside_allowed_scope/);
});
