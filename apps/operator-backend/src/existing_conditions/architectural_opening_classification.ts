import type { ArchitecturalWallLineCandidateReceipt } from "./architectural_wall_line_candidates.js";

export type ArchitecturalOpeningClassificationCue =
  | "swing_arc"
  | "door_leaf"
  | "paired_jambs"
  | "parallel_glazing_lines"
  | "sill_line"
  | "annotation_occlusion"
  | "symbol_occlusion"
  | "insufficient_symbol";

export type ArchitecturalOpeningClassification = {
  opening_hypothesis_id: string;
  host_candidate_id: string;
  classification: "door" | "window" | "unknown";
  confidence: number;
  cues: ArchitecturalOpeningClassificationCue[];
  evidence_artifact_sha256s: string[];
  rationale: string;
  selected_host_candidate_id: null;
};

export type ArchitecturalOpeningClassificationReceipt = {
  schema_version: 1;
  artifact_role: "architectural_opening_classification";
  fixture_id: string;
  scope_id: string;
  candidate_receipt_sha256: string;
  status: "classified" | "clarification_required";
  classifications: ArchitecturalOpeningClassification[];
  native_write: false;
};

const DOOR_CUES = new Set<ArchitecturalOpeningClassificationCue>(["swing_arc", "door_leaf"]);
const WINDOW_CUES = new Set<ArchitecturalOpeningClassificationCue>(["parallel_glazing_lines", "sill_line"]);
const UNKNOWN_CUES = new Set<ArchitecturalOpeningClassificationCue>([
  "annotation_occlusion",
  "symbol_occlusion",
  "insufficient_symbol"
]);

function normalizedHash(value: string, label: string): string {
  const hash = value.trim().toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(hash)) throw new Error(`${label}_must_be_sha256`);
  return hash;
}

export function validateArchitecturalOpeningClassification(
  receipt: ArchitecturalOpeningClassificationReceipt,
  candidates: ArchitecturalWallLineCandidateReceipt,
  candidateReceiptSha256: string,
  minimumClassificationConfidence = 0.75
): void {
  if (receipt.fixture_id !== candidates.fixture_id || receipt.scope_id !== candidates.scope_id) {
    throw new Error("architectural_opening_classification_fixture_or_scope_mismatch");
  }
  if (normalizedHash(receipt.candidate_receipt_sha256, "candidate_receipt_sha256")
    !== normalizedHash(candidateReceiptSha256, "expected_candidate_receipt_sha256")) {
    throw new Error("architectural_opening_classification_candidate_receipt_hash_mismatch");
  }
  if (!Number.isFinite(minimumClassificationConfidence)
    || minimumClassificationConfidence < 0
    || minimumClassificationConfidence > 1) {
    throw new Error("architectural_opening_classification_minimum_confidence_invalid");
  }
  const openings = new Map(candidates.opening_gap_hypotheses.map((opening) => [opening.opening_hypothesis_id, opening]));
  if (openings.size === 0) throw new Error("architectural_opening_classification_requires_opening_hypotheses");
  if (receipt.classifications.length !== openings.size) {
    throw new Error("architectural_opening_classification_must_cover_every_hypothesis_exactly_once");
  }
  const crops = new Map(candidates.opening_evidence_crops.map((crop) => [crop.opening_hypothesis_id, crop]));
  const seen = new Set<string>();
  for (const classification of receipt.classifications) {
    if (seen.has(classification.opening_hypothesis_id)) throw new Error("architectural_opening_classification_duplicate_hypothesis");
    seen.add(classification.opening_hypothesis_id);
    const opening = openings.get(classification.opening_hypothesis_id);
    if (!opening) throw new Error(`architectural_opening_classification_unknown_hypothesis:${classification.opening_hypothesis_id}`);
    if (classification.host_candidate_id !== opening.host_candidate_id) {
      throw new Error(`architectural_opening_classification_host_mismatch:${classification.opening_hypothesis_id}`);
    }
    const crop = crops.get(classification.opening_hypothesis_id);
    if (!crop) throw new Error(`architectural_opening_classification_crop_missing:${classification.opening_hypothesis_id}`);
    const allowedHashes = new Set([
      crop.source_crop.sha256.toLowerCase(),
      crop.evidence_overlay.sha256.toLowerCase()
    ]);
    const suppliedHashes = classification.evidence_artifact_sha256s.map((hash) => normalizedHash(hash, "evidence_artifact_sha256"));
    if (suppliedHashes.length !== allowedHashes.size
      || suppliedHashes.some((hash) => !allowedHashes.has(hash))
      || allowedHashes.size !== new Set(suppliedHashes).size) {
      throw new Error(`architectural_opening_classification_must_bind_both_crop_artifacts:${classification.opening_hypothesis_id}`);
    }
    if (classification.classification === "door" && !classification.cues.some((cue) => DOOR_CUES.has(cue))) {
      throw new Error(`architectural_opening_classification_door_cue_required:${classification.opening_hypothesis_id}`);
    }
    if (classification.classification === "window" && !classification.cues.some((cue) => WINDOW_CUES.has(cue))) {
      throw new Error(`architectural_opening_classification_window_cue_required:${classification.opening_hypothesis_id}`);
    }
    if (classification.classification === "unknown" && !classification.cues.some((cue) => UNKNOWN_CUES.has(cue))) {
      throw new Error(`architectural_opening_classification_unknown_cue_required:${classification.opening_hypothesis_id}`);
    }
  }
  const fullyClassified = receipt.classifications.every(
    (classification) => classification.classification !== "unknown"
      && classification.confidence >= minimumClassificationConfidence
  );
  const expectedStatus = fullyClassified ? "classified" : "clarification_required";
  if (receipt.status !== expectedStatus) {
    throw new Error(`architectural_opening_classification_status_mismatch:expected_${expectedStatus}`);
  }
}
