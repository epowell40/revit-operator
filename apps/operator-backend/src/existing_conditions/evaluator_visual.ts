import crypto from "node:crypto";

export type ExistingConditionsEvaluatorVisualReceipt = {
  post_change_capture_sha256: string;
  post_change_pdf_sha256: string;
  evaluator_review: {
    reviewer_role: "evaluator";
    review_status: "pass" | "needs_review" | "fail";
    notes: string[];
    receipt_sha256: string;
  };
};

type VisualReceiptPayload = Omit<ExistingConditionsEvaluatorVisualReceipt["evaluator_review"], "receipt_sha256"> & {
  post_change_capture_sha256: string;
  post_change_pdf_sha256: string;
};

const SHA256_PATTERN = /^[a-f0-9]{64}$/i;

function receiptHash(payload: VisualReceiptPayload): string {
  return crypto.createHash("sha256").update(JSON.stringify(payload)).digest("hex");
}

export function createExistingConditionsEvaluatorVisualReceipt(input: {
  post_change_capture_sha256: string;
  post_change_pdf_sha256: string;
  review_status: "pass" | "needs_review" | "fail";
  notes?: string[];
}): ExistingConditionsEvaluatorVisualReceipt {
  if (!SHA256_PATTERN.test(input.post_change_capture_sha256)) throw new Error("invalid_post_change_capture_sha256");
  if (!SHA256_PATTERN.test(input.post_change_pdf_sha256)) throw new Error("invalid_post_change_pdf_sha256");
  const notes = [...new Set((input.notes ?? []).map((note) => note.trim()).filter(Boolean))];
  const payload: VisualReceiptPayload = {
    post_change_capture_sha256: input.post_change_capture_sha256.toLowerCase(),
    post_change_pdf_sha256: input.post_change_pdf_sha256.toLowerCase(),
    reviewer_role: "evaluator",
    review_status: input.review_status,
    notes
  };
  return {
    post_change_capture_sha256: payload.post_change_capture_sha256,
    post_change_pdf_sha256: payload.post_change_pdf_sha256,
    evaluator_review: {
      reviewer_role: payload.reviewer_role,
      review_status: payload.review_status,
      notes: payload.notes,
      receipt_sha256: receiptHash(payload)
    }
  };
}

export function validateExistingConditionsEvaluatorVisualReceipt(
  receipt: ExistingConditionsEvaluatorVisualReceipt | null | undefined
): boolean {
  if (!receipt || !SHA256_PATTERN.test(receipt.post_change_capture_sha256) || !SHA256_PATTERN.test(receipt.post_change_pdf_sha256)) return false;
  const review = receipt.evaluator_review;
  if (!review || review.reviewer_role !== "evaluator" || !["pass", "needs_review", "fail"].includes(review.review_status)) return false;
  if (!Array.isArray(review.notes) || review.notes.some((note) => typeof note !== "string" || !note.trim())) return false;
  if (!SHA256_PATTERN.test(review.receipt_sha256)) return false;
  const payload: VisualReceiptPayload = {
    post_change_capture_sha256: receipt.post_change_capture_sha256.toLowerCase(),
    post_change_pdf_sha256: receipt.post_change_pdf_sha256.toLowerCase(),
    reviewer_role: "evaluator",
    review_status: review.review_status,
    notes: review.notes
  };
  return receiptHash(payload) === review.receipt_sha256.toLowerCase();
}
