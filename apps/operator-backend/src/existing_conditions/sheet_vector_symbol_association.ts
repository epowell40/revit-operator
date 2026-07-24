import crypto from "node:crypto";
import fs from "node:fs";
import { loadImage } from "@napi-rs/canvas";
import type { MepRepeatedSymbolDetectionReceiptV1 } from "./mep_repeated_symbol_detection.js";
import type { SheetVectorTextExtractionReceiptV1, SheetVectorTextEntryV1 } from "./sheet_vector_text.js";

export type SheetVectorSymbolAssociationInputV1 = {
  schema_version: 1;
  source_image_path: string;
  source_image_sha256: string;
  source_image_width_px: number;
  source_image_height_px: number;
  vector_text_receipt_path: string;
  vector_text_receipt_sha256: string;
  repeated_symbol_receipt_path: string;
  repeated_symbol_receipt_sha256: string;
  required_label_text: string;
  allowed_role_hints?: string[];
  maximum_label_distance_px?: number;
  minimum_ambiguity_margin_px?: number;
  maximum_associations?: number;
};

type PixelPoint = { x: number; y: number };
type PixelBounds = { min: PixelPoint; max: PixelPoint };

export type SheetVectorSymbolAssociationV1 = {
  association_id: string;
  decision: "sealed_source_association";
  label_entry_id: string;
  label_text: string;
  label_point: PixelPoint;
  label_bounds: PixelBounds;
  candidate_id: string;
  template_id: string;
  role_hint: string;
  variant: string;
  candidate_bounds: PixelBounds;
  candidate_anchor: PixelPoint;
  label_to_candidate_distance_px: number;
  second_nearest_label_distance_px: number | null;
  ambiguity_margin_px: number | null;
  native_write_allowed: false;
};

export type SheetVectorSymbolAssociationReceiptV1 = {
  schema: "operator.sheet_vector_symbol_association.v1";
  source_image_sha256: string;
  source_image_width_px: number;
  source_image_height_px: number;
  vector_text_receipt_sha256: string;
  repeated_symbol_receipt_sha256: string;
  required_label_text: string;
  allowed_role_hints: string[];
  maximum_label_distance_px: number;
  minimum_ambiguity_margin_px: number;
  associations: SheetVectorSymbolAssociationV1[];
  rejected_candidates: Array<{
    candidate_id: string;
    reason: "no_matching_label_within_distance" | "ambiguous_label_association" | "label_already_claimed";
    nearest_label_entry_id: string | null;
    nearest_distance_px: number | null;
    second_nearest_distance_px: number | null;
  }>;
  native_write_allowed: false;
  capability_boundary: string;
};

function clean(value: unknown): string {
  return String(value ?? "").trim();
}

function normalized(value: unknown): string {
  return clean(value).normalize("NFKC").replace(/\s+/g, " ").toLowerCase();
}

function sha256(buffer: Buffer): string {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

function requiredSha(value: unknown, label: string): string {
  const result = clean(value).toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(result)) throw new Error(`${label}_must_be_sha256`);
  return result;
}

function integer(value: unknown, label: string, minimum: number, maximum: number): number {
  const result = Number(value);
  if (!Number.isSafeInteger(result) || result < minimum || result > maximum) {
    throw new Error(`${label}_must_be_integer_${minimum}_through_${maximum}`);
  }
  return result;
}

function finitePoint(value: unknown, label: string): PixelPoint {
  const point = value as Partial<PixelPoint> | null;
  const x = Number(point?.x);
  const y = Number(point?.y);
  if (!Number.isFinite(x) || !Number.isFinite(y)) throw new Error(`${label}_must_be_finite_point`);
  return { x, y };
}

function finiteBounds(value: unknown, label: string): PixelBounds {
  const bounds = value as Partial<PixelBounds> | null;
  const min = finitePoint(bounds?.min, `${label}_min`);
  const max = finitePoint(bounds?.max, `${label}_max`);
  if (max.x <= min.x || max.y <= min.y) throw new Error(`${label}_must_have_positive_extent`);
  return { min, max };
}

function readReceipt<T>(filePath: string, expectedHash: string, label: string): T {
  if (!filePath || !fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
    throw new Error(`${label}_not_found`);
  }
  const bytes = fs.readFileSync(filePath);
  if (bytes.length > 32 * 1024 * 1024) throw new Error(`${label}_exceeds_32_megabytes`);
  if (sha256(bytes) !== expectedHash) throw new Error(`${label}_hash_mismatch`);
  try {
    return JSON.parse(bytes.toString("utf8")) as T;
  } catch {
    throw new Error(`${label}_must_be_json`);
  }
}

function boundsDistance(first: PixelBounds, second: PixelBounds): number {
  const dx = Math.max(first.min.x - second.max.x, second.min.x - first.max.x, 0);
  const dy = Math.max(first.min.y - second.max.y, second.min.y - first.max.y, 0);
  return Math.hypot(dx, dy);
}

function stableAssociationId(labelEntryId: string, candidateId: string): string {
  return crypto.createHash("sha256").update(`${labelEntryId}|${candidateId}`).digest("hex").slice(0, 20);
}

export async function associateSheetVectorSymbolsV1(
  input: SheetVectorSymbolAssociationInputV1
): Promise<SheetVectorSymbolAssociationReceiptV1> {
  if (!input || typeof input !== "object" || Array.isArray(input) || input.schema_version !== 1) {
    throw new Error("sheet_vector_symbol_association_requires_schema_v1");
  }
  const sourcePath = clean(input.source_image_path);
  if (!sourcePath || !fs.existsSync(sourcePath) || !fs.statSync(sourcePath).isFile()) {
    throw new Error("sheet_vector_symbol_source_image_not_found");
  }
  const sourceBytes = fs.readFileSync(sourcePath);
  const sourceHash = requiredSha(input.source_image_sha256, "sheet_vector_symbol_source_image_sha256");
  if (sha256(sourceBytes) !== sourceHash) throw new Error("sheet_vector_symbol_source_image_hash_mismatch");
  const width = integer(input.source_image_width_px, "sheet_vector_symbol_source_image_width_px", 1, 20_000);
  const height = integer(input.source_image_height_px, "sheet_vector_symbol_source_image_height_px", 1, 20_000);
  if (width * height > 50_000_000) throw new Error("sheet_vector_symbol_source_image_exceeds_50000000_pixels");
  const image = await loadImage(sourceBytes);
  if (image.width !== width || image.height !== height) throw new Error("sheet_vector_symbol_source_image_dimensions_mismatch");

  const vectorReceiptHash = requiredSha(input.vector_text_receipt_sha256, "sheet_vector_symbol_vector_receipt_sha256");
  const repeatedReceiptHash = requiredSha(input.repeated_symbol_receipt_sha256, "sheet_vector_symbol_repeated_receipt_sha256");
  const vectorReceipt = readReceipt<SheetVectorTextExtractionReceiptV1>(
    clean(input.vector_text_receipt_path), vectorReceiptHash, "sheet_vector_symbol_vector_receipt"
  );
  const repeatedReceipt = readReceipt<MepRepeatedSymbolDetectionReceiptV1>(
    clean(input.repeated_symbol_receipt_path), repeatedReceiptHash, "sheet_vector_symbol_repeated_receipt"
  );
  if (vectorReceipt?.schema !== "operator.sheet_vector_text.v1" || vectorReceipt.native_write_allowed !== false) {
    throw new Error("sheet_vector_symbol_vector_receipt_invalid");
  }
  if (repeatedReceipt?.schema !== "operator.mep_repeated_symbol_detection.v1") {
    throw new Error("sheet_vector_symbol_repeated_receipt_invalid");
  }
  if (vectorReceipt.registered_render_sha256 !== sourceHash || repeatedReceipt.source_image_sha256 !== sourceHash) {
    throw new Error("sheet_vector_symbol_receipts_do_not_match_source_image");
  }
  if (vectorReceipt.render_width_px !== width || vectorReceipt.render_height_px !== height
    || repeatedReceipt.source_image_width_px !== width || repeatedReceipt.source_image_height_px !== height) {
    throw new Error("sheet_vector_symbol_receipt_dimensions_mismatch");
  }
  const requiredLabelText = clean(input.required_label_text);
  if (!requiredLabelText || requiredLabelText.length > 128) throw new Error("sheet_vector_symbol_required_label_text_invalid");
  const allowedRoleHints = [...new Set((input.allowed_role_hints ?? []).map(clean).filter(Boolean))];
  if (allowedRoleHints.length > 32) throw new Error("sheet_vector_symbol_allowed_role_hints_exceeds_32");
  const maximumDistance = integer(input.maximum_label_distance_px ?? 80, "sheet_vector_symbol_maximum_label_distance_px", 1, 2_000);
  const minimumMargin = integer(input.minimum_ambiguity_margin_px ?? 12, "sheet_vector_symbol_minimum_ambiguity_margin_px", 0, 2_000);
  const maximumAssociations = integer(input.maximum_associations ?? 500, "sheet_vector_symbol_maximum_associations", 1, 5_000);

  const labels = (Array.isArray(vectorReceipt.entries) ? vectorReceipt.entries : [])
    .filter((entry): entry is SheetVectorTextEntryV1 => normalized(entry?.text) === normalized(requiredLabelText))
    .map((entry) => ({ entry, bounds: finiteBounds(entry.pixel_bounds, `sheet_vector_symbol_label_${clean(entry.entry_id)}`) }));
  if (labels.length === 0) throw new Error("sheet_vector_symbol_no_matching_vector_labels");
  const candidates = (Array.isArray(repeatedReceipt.candidates) ? repeatedReceipt.candidates : [])
    .filter(candidate => candidate?.native_write_allowed === false)
    .filter(candidate => allowedRoleHints.length === 0 || allowedRoleHints.includes(clean(candidate.role_hint)));
  if (candidates.length === 0) throw new Error("sheet_vector_symbol_no_eligible_repeated_candidates");

  const proposals = candidates.map(candidate => {
    const candidateBounds = finiteBounds(candidate.pixel_bounds, `sheet_vector_symbol_candidate_${clean(candidate.candidate_id)}`);
    const ranked = labels.map(label => ({
      label,
      distance: boundsDistance(label.bounds, candidateBounds)
    })).sort((first, second) => first.distance - second.distance || clean(first.label.entry.entry_id).localeCompare(clean(second.label.entry.entry_id)));
    return { candidate, candidateBounds, ranked };
  }).sort((first, second) => (first.ranked[0]?.distance ?? Infinity) - (second.ranked[0]?.distance ?? Infinity)
    || clean(first.candidate.candidate_id).localeCompare(clean(second.candidate.candidate_id)));

  const claimedLabels = new Set<string>();
  const associations: SheetVectorSymbolAssociationV1[] = [];
  const rejected: SheetVectorSymbolAssociationReceiptV1["rejected_candidates"] = [];
  for (const proposal of proposals) {
    const nearest = proposal.ranked[0] ?? null;
    const second = proposal.ranked[1] ?? null;
    const candidateId = clean(proposal.candidate.candidate_id);
    if (!nearest || nearest.distance > maximumDistance) {
      rejected.push({
        candidate_id: candidateId,
        reason: "no_matching_label_within_distance",
        nearest_label_entry_id: nearest ? clean(nearest.label.entry.entry_id) : null,
        nearest_distance_px: nearest?.distance ?? null,
        second_nearest_distance_px: second?.distance ?? null
      });
      continue;
    }
    const margin = second ? second.distance - nearest.distance : null;
    if (margin !== null && margin < minimumMargin) {
      rejected.push({
        candidate_id: candidateId,
        reason: "ambiguous_label_association",
        nearest_label_entry_id: clean(nearest.label.entry.entry_id),
        nearest_distance_px: nearest.distance,
        second_nearest_distance_px: second?.distance ?? null
      });
      continue;
    }
    const labelEntryId = clean(nearest.label.entry.entry_id);
    if (claimedLabels.has(labelEntryId)) {
      rejected.push({
        candidate_id: candidateId,
        reason: "label_already_claimed",
        nearest_label_entry_id: labelEntryId,
        nearest_distance_px: nearest.distance,
        second_nearest_distance_px: second?.distance ?? null
      });
      continue;
    }
    claimedLabels.add(labelEntryId);
    associations.push({
      association_id: stableAssociationId(labelEntryId, candidateId),
      decision: "sealed_source_association",
      label_entry_id: labelEntryId,
      label_text: clean(nearest.label.entry.text),
      label_point: finitePoint(nearest.label.entry.pixel_point, `sheet_vector_symbol_label_point_${labelEntryId}`),
      label_bounds: nearest.label.bounds,
      candidate_id: candidateId,
      template_id: clean(proposal.candidate.template_id),
      role_hint: clean(proposal.candidate.role_hint),
      variant: clean(proposal.candidate.variant),
      candidate_bounds: proposal.candidateBounds,
      candidate_anchor: finitePoint(proposal.candidate.anchor, `sheet_vector_symbol_candidate_anchor_${candidateId}`),
      label_to_candidate_distance_px: nearest.distance,
      second_nearest_label_distance_px: second?.distance ?? null,
      ambiguity_margin_px: margin,
      native_write_allowed: false
    });
    if (associations.length >= maximumAssociations) break;
  }

  return {
    schema: "operator.sheet_vector_symbol_association.v1",
    source_image_sha256: sourceHash,
    source_image_width_px: width,
    source_image_height_px: height,
    vector_text_receipt_sha256: vectorReceiptHash,
    repeated_symbol_receipt_sha256: repeatedReceiptHash,
    required_label_text: requiredLabelText,
    allowed_role_hints: allowedRoleHints,
    maximum_label_distance_px: maximumDistance,
    minimum_ambiguity_margin_px: minimumMargin,
    associations,
    rejected_candidates: rejected,
    native_write_allowed: false,
    capability_boundary: "This receipt seals a source-image label-to-glyph association only. It cannot establish native family, type, host, circuit, elevation, model coordinates, or Revit write authority."
  };
}
