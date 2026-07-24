import test from "node:test";
import assert from "node:assert/strict";
import {
  createExistingConditionsEvaluatorVisualReceipt,
  validateExistingConditionsEvaluatorVisualReceipt
} from "../src/existing_conditions/evaluator_visual.js";

test("creates and validates an evaluator-owned visual receipt", () => {
  const receipt = createExistingConditionsEvaluatorVisualReceipt({
    post_change_capture_sha256: "a".repeat(64),
    post_change_pdf_sha256: "b".repeat(64),
    review_status: "pass",
    notes: ["Tag is legible and clear of the device."]
  });
  assert.equal(validateExistingConditionsEvaluatorVisualReceipt(receipt), true);
});

test("rejects a visual receipt whose review was modified after sealing", () => {
  const receipt = createExistingConditionsEvaluatorVisualReceipt({
    post_change_capture_sha256: "a".repeat(64),
    post_change_pdf_sha256: "b".repeat(64),
    review_status: "needs_review"
  });
  receipt.evaluator_review.review_status = "pass";
  assert.equal(validateExistingConditionsEvaluatorVisualReceipt(receipt), false);
});
