import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
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
const KEY_ID = "existing-conditions-evaluator-test-key";
const SIGNING_KEY = "test-only-existing-conditions-evaluator-signing-key-0001";
const ATTACKER_KEY = "attacker-controlled-existing-conditions-key-material-0001";

function artifacts(): { root: string; capture: string; pdf: string; postApplyCompletedAt: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "operator-evaluator-visual-"));
  const capture = path.join(root, "post.png");
  const pdf = path.join(root, "post.pdf");
  const postApplyCompletedAt = new Date(Date.now() - 1_000).toISOString();
  fs.writeFileSync(capture, PNG);
  fs.writeFileSync(pdf, PDF);
  return { root, capture, pdf, postApplyCompletedAt };
}

function signedReceipt(fixture = artifacts(), signingKey = SIGNING_KEY, keyId = KEY_ID) {
  return createExistingConditionsEvaluatorVisualReceipt({
    post_change_capture_path: fixture.capture,
    post_change_pdf_path: fixture.pdf,
    artifact_scope_root: fixture.root,
    workflow_fingerprint_sha256: "a".repeat(64),
    action_id: "apply-existing-conditions-stage",
    attempt_id: crypto.randomUUID(),
    capture_nonce: crypto.randomBytes(18).toString("base64url"),
    post_apply_completed_at: fixture.postApplyCompletedAt,
    authority: { key_id: keyId, signing_key: signingKey },
    review_status: "pass",
    notes: ["Tag is legible and clear of the device."]
  });
}

function validation(root?: string) {
  return {
    ...(root ? { allowed_artifact_root: root } : {}),
    trusted_key_resolver: (keyId: string) => keyId === KEY_ID ? SIGNING_KEY : null
  };
}

test("accepts fresh evaluator-issued evidence bound to artifacts and apply identity", () => {
  const fixture = artifacts();
  const receipt = signedReceipt(fixture);
  assert.equal(validateExistingConditionsEvaluatorVisualReceipt(receipt, validation(fixture.root)), true);
  assert.equal(validateExistingConditionsEvaluatorVisualReceipt(receipt), false);
  assert.equal(receipt.schema_version, 2);
  assert.equal(receipt.evaluator_authority.key_id, KEY_ID);
  assert.equal(receipt.post_change_capture_artifact.byte_length, PNG.length);
  assert.equal(receipt.post_change_capture_artifact.file_name, "post.png");
  assert.equal(receipt.attempt_id.length > 0, true);
});

test("rejects modified and self-issued pass provenance", () => {
  const receipt = signedReceipt();
  receipt.evaluator_review.review_status = "fail";
  assert.equal(validateExistingConditionsEvaluatorVisualReceipt(receipt, validation()), false);

  const identityReceipt = signedReceipt();
  for (const [field, value] of [
    ["action_id", "different-action"],
    ["attempt_id", "different-attempt"],
    ["capture_nonce", "differentnonce000000000000"],
    ["post_apply_completed_at", new Date(Date.parse(identityReceipt.post_apply_completed_at) - 1_000).toISOString()]
  ] as const) {
    const modified = structuredClone(identityReceipt);
    modified[field] = value;
    assert.equal(validateExistingConditionsEvaluatorVisualReceipt(modified, validation()), false, field);
  }

  const attackerFixture = artifacts();
  const selfIssued = signedReceipt(attackerFixture, ATTACKER_KEY, "candidate-self-issued-key");
  assert.equal(validateExistingConditionsEvaluatorVisualReceipt(selfIssued, validation(attackerFixture.root)), false);
});

test("rejects captures whose filesystem freshness predates the apply completion", () => {
  const fixture = artifacts();
  const stale = new Date(Date.now() - 60_000);
  fs.utimesSync(fixture.capture, stale, stale);
  fs.utimesSync(fixture.pdf, stale, stale);
  assert.throws(() => signedReceipt(fixture), /artifact_is_not_post_apply_fresh/);
});

test("rejects fabricated hashes, changed bytes, wrong media, and scope escape", () => {
  const fixture = artifacts();
  const receipt = signedReceipt(fixture);
  const fabricated = structuredClone(receipt);
  fabricated.post_change_capture_sha256 = "a".repeat(64);
  fabricated.post_change_capture_artifact.sha256 = "a".repeat(64);
  assert.equal(validateExistingConditionsEvaluatorVisualReceipt(fabricated, validation(fixture.root)), false);

  fs.writeFileSync(fixture.capture, Buffer.from("not an image", "utf8"));
  assert.equal(validateExistingConditionsEvaluatorVisualReceipt(receipt, validation(fixture.root)), false);

  const wrongMedia = artifacts();
  assert.throws(() => createExistingConditionsEvaluatorVisualReceipt({
    post_change_capture_path: wrongMedia.pdf,
    post_change_pdf_path: wrongMedia.capture,
    artifact_scope_root: wrongMedia.root,
    workflow_fingerprint_sha256: "b".repeat(64),
    action_id: "action",
    attempt_id: "attempt",
    capture_nonce: crypto.randomBytes(18).toString("base64url"),
    post_apply_completed_at: wrongMedia.postApplyCompletedAt,
    authority: { key_id: KEY_ID, signing_key: SIGNING_KEY },
    review_status: "pass"
  }), /artifact_media_mismatch/);

  const outside = artifacts();
  assert.throws(() => createExistingConditionsEvaluatorVisualReceipt({
    post_change_capture_path: outside.capture,
    post_change_pdf_path: fixture.pdf,
    artifact_scope_root: fixture.root,
    workflow_fingerprint_sha256: "b".repeat(64),
    action_id: "action",
    attempt_id: "attempt",
    capture_nonce: crypto.randomBytes(18).toString("base64url"),
    post_apply_completed_at: fixture.postApplyCompletedAt,
    authority: { key_id: KEY_ID, signing_key: SIGNING_KEY },
    review_status: "pass"
  }), /outside_allowed_scope/);
});

test("evaluator visual CLI uses runtime authority and emits a verifiable V2 receipt", () => {
  const fixture = artifacts();
  const out = path.join(fixture.root, "visual-receipt.json");
  const cli = path.resolve("dist/src/tools/existing_conditions_fixture.js");
  const baseArgs = [
    cli,
    "evaluator-review-visual",
    "--post-capture", fixture.capture,
    "--post-pdf", fixture.pdf,
    "--workflow-fingerprint-sha256", "c".repeat(64),
    "--action-id", "cli-action",
    "--attempt-id", "cli-attempt",
    "--capture-nonce", crypto.randomBytes(18).toString("base64url"),
    "--post-apply-completed-at", fixture.postApplyCompletedAt,
    "--status", "pass",
    "--out", out
  ];
  const env = {
    ...process.env,
    OPERATOR_EXISTING_CONDITIONS_EVALUATOR_KEY_ID: KEY_ID,
    OPERATOR_EXISTING_CONDITIONS_EVALUATOR_HMAC_KEY: SIGNING_KEY
  };
  const accepted = spawnSync(process.execPath, baseArgs, { encoding: "utf8", env });
  assert.equal(accepted.status, 0, accepted.stderr);
  const receipt = JSON.parse(fs.readFileSync(out, "utf8"));
  assert.equal(validateExistingConditionsEvaluatorVisualReceipt(receipt, validation(fixture.root)), true);

  const outside = artifacts();
  const rejectedArgs = [...baseArgs];
  rejectedArgs[rejectedArgs.indexOf(fixture.capture)] = outside.capture;
  rejectedArgs[rejectedArgs.indexOf(fixture.pdf)] = outside.pdf;
  const rejected = spawnSync(process.execPath, rejectedArgs, { encoding: "utf8", env });
  assert.notEqual(rejected.status, 0);
  assert.match(rejected.stderr, /outside_allowed_scope/);
});
