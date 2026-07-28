import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export type ExistingConditionsEvaluatorArtifactBinding = {
  path: string;
  sha256: string;
  byte_length: number;
  media_type: "image" | "application/pdf";
};

export type ExistingConditionsEvaluatorVisualReceipt = {
  artifact_scope_root: string;
  post_change_capture_sha256: string;
  post_change_pdf_sha256: string;
  post_change_capture_artifact: ExistingConditionsEvaluatorArtifactBinding;
  post_change_pdf_artifact: ExistingConditionsEvaluatorArtifactBinding;
  evaluator_review: {
    reviewer_role: "evaluator";
    review_status: "pass" | "needs_review" | "fail";
    notes: string[];
    receipt_sha256: string;
  };
};

type VisualReceiptPayload = Omit<ExistingConditionsEvaluatorVisualReceipt["evaluator_review"], "receipt_sha256"> &
  Omit<ExistingConditionsEvaluatorVisualReceipt, "evaluator_review">;

const SHA256_PATTERN = /^[a-f0-9]{64}$/i;

function receiptHash(payload: VisualReceiptPayload): string {
  return crypto.createHash("sha256").update(JSON.stringify(payload)).digest("hex");
}

function hashBytes(bytes: Buffer): string {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

function isWithin(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function isSupportedImage(bytes: Buffer): boolean {
  const png = bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  const jpeg = bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8 &&
    bytes[bytes.length - 2] === 0xff && bytes[bytes.length - 1] === 0xd9;
  return png || jpeg;
}

function isSupportedPdf(bytes: Buffer): boolean {
  if (bytes.length < 9 || bytes.subarray(0, 5).toString("ascii") !== "%PDF-") return false;
  return bytes.subarray(Math.max(0, bytes.length - 1024)).toString("latin1").includes("%%EOF");
}

function bindArtifact(args: {
  filePath: string;
  artifactScopeRoot: string;
  mediaType: ExistingConditionsEvaluatorArtifactBinding["media_type"];
}): ExistingConditionsEvaluatorArtifactBinding {
  const root = fs.realpathSync(path.resolve(args.artifactScopeRoot));
  const filePath = fs.realpathSync(path.resolve(args.filePath));
  if (!fs.statSync(root).isDirectory() || !isWithin(root, filePath)) {
    throw new Error("evaluator_visual_artifact_outside_allowed_scope");
  }
  const stat = fs.statSync(filePath);
  if (!stat.isFile() || stat.size <= 0) throw new Error("evaluator_visual_artifact_must_be_nonempty_file");
  const bytes = fs.readFileSync(filePath);
  if (args.mediaType === "image" ? !isSupportedImage(bytes) : !isSupportedPdf(bytes)) {
    throw new Error(`evaluator_visual_artifact_media_mismatch:${args.mediaType}`);
  }
  return {
    path: filePath,
    sha256: hashBytes(bytes),
    byte_length: bytes.length,
    media_type: args.mediaType
  };
}

function validateArtifactBinding(args: {
  binding: ExistingConditionsEvaluatorArtifactBinding;
  artifactScopeRoot: string;
  expectedHash: string;
  mediaType: ExistingConditionsEvaluatorArtifactBinding["media_type"];
}): boolean {
  try {
    if (!args.binding || args.binding.media_type !== args.mediaType ||
        !SHA256_PATTERN.test(args.binding.sha256) || args.binding.sha256.toLowerCase() !== args.expectedHash.toLowerCase() ||
        !Number.isSafeInteger(args.binding.byte_length) || args.binding.byte_length <= 0) return false;
    const actual = bindArtifact({
      filePath: args.binding.path,
      artifactScopeRoot: args.artifactScopeRoot,
      mediaType: args.mediaType
    });
    return actual.path === args.binding.path &&
      actual.sha256 === args.binding.sha256.toLowerCase() &&
      actual.byte_length === args.binding.byte_length;
  } catch {
    return false;
  }
}

export function createExistingConditionsEvaluatorVisualReceipt(input: {
  post_change_capture_path: string;
  post_change_pdf_path: string;
  artifact_scope_root: string;
  review_status: "pass" | "needs_review" | "fail";
  notes?: string[];
}): ExistingConditionsEvaluatorVisualReceipt {
  const artifactScopeRoot = fs.realpathSync(path.resolve(input.artifact_scope_root));
  const capture = bindArtifact({
    filePath: input.post_change_capture_path,
    artifactScopeRoot,
    mediaType: "image"
  });
  const pdf = bindArtifact({
    filePath: input.post_change_pdf_path,
    artifactScopeRoot,
    mediaType: "application/pdf"
  });
  const notes = [...new Set((input.notes ?? []).map((note) => note.trim()).filter(Boolean))];
  const payload: VisualReceiptPayload = {
    artifact_scope_root: artifactScopeRoot,
    post_change_capture_sha256: capture.sha256,
    post_change_pdf_sha256: pdf.sha256,
    post_change_capture_artifact: capture,
    post_change_pdf_artifact: pdf,
    reviewer_role: "evaluator",
    review_status: input.review_status,
    notes
  };
  return {
    artifact_scope_root: payload.artifact_scope_root,
    post_change_capture_sha256: payload.post_change_capture_sha256,
    post_change_pdf_sha256: payload.post_change_pdf_sha256,
    post_change_capture_artifact: payload.post_change_capture_artifact,
    post_change_pdf_artifact: payload.post_change_pdf_artifact,
    evaluator_review: {
      reviewer_role: payload.reviewer_role,
      review_status: payload.review_status,
      notes: payload.notes,
      receipt_sha256: receiptHash(payload)
    }
  };
}

export function validateExistingConditionsEvaluatorVisualReceipt(
  receipt: ExistingConditionsEvaluatorVisualReceipt | null | undefined,
  options: { allowed_artifact_root?: string } = {}
): boolean {
  if (!receipt || !SHA256_PATTERN.test(receipt.post_change_capture_sha256) || !SHA256_PATTERN.test(receipt.post_change_pdf_sha256)) return false;
  const review = receipt.evaluator_review;
  if (!review || review.reviewer_role !== "evaluator" || !["pass", "needs_review", "fail"].includes(review.review_status)) return false;
  if (!Array.isArray(review.notes) || review.notes.some((note) => typeof note !== "string" || !note.trim())) return false;
  if (!SHA256_PATTERN.test(review.receipt_sha256)) return false;
  let artifactScopeRoot: string;
  try {
    artifactScopeRoot = fs.realpathSync(path.resolve(receipt.artifact_scope_root));
    if (artifactScopeRoot !== receipt.artifact_scope_root) return false;
    if (options.allowed_artifact_root) {
      const allowedRoot = fs.realpathSync(path.resolve(options.allowed_artifact_root));
      if (artifactScopeRoot !== allowedRoot) return false;
    }
  } catch {
    return false;
  }
  if (!validateArtifactBinding({
    binding: receipt.post_change_capture_artifact,
    artifactScopeRoot,
    expectedHash: receipt.post_change_capture_sha256,
    mediaType: "image"
  }) || !validateArtifactBinding({
    binding: receipt.post_change_pdf_artifact,
    artifactScopeRoot,
    expectedHash: receipt.post_change_pdf_sha256,
    mediaType: "application/pdf"
  })) return false;
  const payload: VisualReceiptPayload = {
    artifact_scope_root: artifactScopeRoot,
    post_change_capture_sha256: receipt.post_change_capture_sha256.toLowerCase(),
    post_change_pdf_sha256: receipt.post_change_pdf_sha256.toLowerCase(),
    post_change_capture_artifact: receipt.post_change_capture_artifact,
    post_change_pdf_artifact: receipt.post_change_pdf_artifact,
    reviewer_role: "evaluator",
    review_status: review.review_status,
    notes: review.notes
  };
  return receiptHash(payload) === review.receipt_sha256.toLowerCase();
}
