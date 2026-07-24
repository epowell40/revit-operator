import crypto from "node:crypto";
import type {
  SheetTopologyCalibrationProfileV1,
  SheetTopologyDiscipline,
  SheetTopologyPrimitiveKind
} from "./sheet_topology_compiler.js";

export type SheetTopologyBlindOutcomeV1 = {
  prediction_id: string;
  fixture_id: string;
  discipline: SheetTopologyDiscipline;
  primitive_kind: SheetTopologyPrimitiveKind;
  raw_confidence: number;
  correct: boolean;
  candidate_sha256: string;
  evaluator_receipt_sha256: string;
  candidate_sealed_at_utc: string;
  evaluated_at_utc: string;
  truth_revealed_after_candidate_seal: true;
};

export type SheetTopologyCalibrationBuildInputV1 = {
  schema_version: 1;
  profile_id: string;
  confidence_bin_edges: number[];
  outcomes: SheetTopologyBlindOutcomeV1[];
};

function clean(value: unknown): string {
  return String(value ?? "").trim();
}

function requiredText(value: unknown, label: string): string {
  const result = clean(value);
  if (!result) throw new Error(`${label}_is_required`);
  return result;
}

function sha256(value: unknown, label: string): string {
  const result = clean(value).toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(result)) throw new Error(`${label}_must_be_sha256`);
  return result;
}

function confidence(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) {
    throw new Error(`${label}_must_be_between_zero_and_one`);
  }
  return value;
}

function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object).sort().map(key => `${JSON.stringify(key)}:${canonical(object[key])}`).join(",")}}`;
}

function digest(value: unknown): string {
  return crypto.createHash("sha256").update(canonical(value)).digest("hex");
}

function timestamp(value: unknown, label: string): number {
  const text = requiredText(value, label);
  const milliseconds = Date.parse(text);
  if (!Number.isFinite(milliseconds)) throw new Error(`${label}_must_be_iso_timestamp`);
  return milliseconds;
}

export function buildSheetTopologyCalibrationProfileV1(
  input: SheetTopologyCalibrationBuildInputV1
): SheetTopologyCalibrationProfileV1 {
  if (!input || input.schema_version !== 1) throw new Error("sheet_topology_calibration_build_requires_schema_v1");
  const profileId = requiredText(input.profile_id, "sheet_topology_calibration_profile_id");
  if (!Array.isArray(input.confidence_bin_edges) || input.confidence_bin_edges.length < 2 || input.confidence_bin_edges.length > 21) {
    throw new Error("sheet_topology_calibration_bin_edges_invalid");
  }
  const edges = input.confidence_bin_edges.map((value, index) => confidence(value, `sheet_topology_calibration_edge_${index}`));
  if (edges[0] !== 0 || edges[edges.length - 1] !== 1) throw new Error("sheet_topology_calibration_bin_edges_must_span_zero_to_one");
  for (let index = 1; index < edges.length; index += 1) {
    if (edges[index]! <= edges[index - 1]!) throw new Error(`sheet_topology_calibration_bin_edges_not_increasing:${index}`);
  }
  if (!Array.isArray(input.outcomes) || input.outcomes.length === 0) throw new Error("sheet_topology_calibration_outcomes_required");

  const predictionIds = new Set<string>();
  const normalized = input.outcomes.map((outcome, index) => {
    const predictionId = requiredText(outcome.prediction_id, `sheet_topology_outcome_${index}_prediction_id`);
    if (predictionIds.has(predictionId)) throw new Error(`sheet_topology_calibration_duplicate_prediction:${predictionId}`);
    predictionIds.add(predictionId);
    const fixtureId = requiredText(outcome.fixture_id, `sheet_topology_outcome_${predictionId}_fixture_id`);
    if (!["architectural", "mechanical", "plumbing", "electrical"].includes(outcome.discipline)) {
      throw new Error(`sheet_topology_outcome_${predictionId}_discipline_invalid`);
    }
    if (!["wall_segment", "route_segment", "opening", "point_symbol", "annotation"].includes(outcome.primitive_kind)) {
      throw new Error(`sheet_topology_outcome_${predictionId}_primitive_kind_invalid`);
    }
    const rawConfidence = confidence(outcome.raw_confidence, `sheet_topology_outcome_${predictionId}_raw_confidence`);
    if (typeof outcome.correct !== "boolean") throw new Error(`sheet_topology_outcome_${predictionId}_correct_invalid`);
    const candidateHash = sha256(outcome.candidate_sha256, `sheet_topology_outcome_${predictionId}_candidate_sha256`);
    const evaluatorHash = sha256(outcome.evaluator_receipt_sha256, `sheet_topology_outcome_${predictionId}_evaluator_sha256`);
    const sealedAt = timestamp(outcome.candidate_sealed_at_utc, `sheet_topology_outcome_${predictionId}_sealed_at`);
    const evaluatedAt = timestamp(outcome.evaluated_at_utc, `sheet_topology_outcome_${predictionId}_evaluated_at`);
    if (outcome.truth_revealed_after_candidate_seal !== true || evaluatedAt < sealedAt) {
      throw new Error(`sheet_topology_outcome_not_blind_and_sealed:${predictionId}`);
    }
    return {
      prediction_id: predictionId,
      fixture_id: fixtureId,
      discipline: outcome.discipline,
      primitive_kind: outcome.primitive_kind,
      raw_confidence: rawConfidence,
      correct: outcome.correct,
      candidate_sha256: candidateHash,
      evaluator_receipt_sha256: evaluatorHash,
      candidate_sealed_at_utc: new Date(sealedAt).toISOString(),
      evaluated_at_utc: new Date(evaluatedAt).toISOString(),
      truth_revealed_after_candidate_seal: true as const
    };
  }).sort((a, b) => a.prediction_id.localeCompare(b.prediction_id));

  const groups = new Map<string, typeof normalized>();
  for (const outcome of normalized) {
    const key = `${outcome.discipline}:${outcome.primitive_kind}`;
    (groups.get(key) ?? groups.set(key, []).get(key)!).push(outcome);
  }
  const bins: SheetTopologyCalibrationProfileV1["bins"] = [];
  for (const key of [...groups.keys()].sort()) {
    const [discipline, primitiveKind] = key.split(":") as [SheetTopologyDiscipline, SheetTopologyPrimitiveKind];
    const outcomes = groups.get(key)!;
    for (let index = 0; index < edges.length - 1; index += 1) {
      const minimum = edges[index]!;
      const maximum = edges[index + 1]!;
      const members = outcomes.filter(outcome =>
        outcome.raw_confidence >= minimum
        && (outcome.raw_confidence < maximum || (outcome.raw_confidence === 1 && maximum === 1))
      );
      if (members.length === 0) continue;
      bins.push({
        discipline,
        primitive_kind: primitiveKind,
        raw_confidence_min: minimum,
        raw_confidence_max: maximum,
        trials: members.length,
        successes: members.filter(member => member.correct).length,
        fixture_count: new Set(members.map(member => member.fixture_id)).size
      });
    }
  }

  return {
    schema_version: 1,
    profile_id: profileId,
    provenance: {
      outcomes_sha256: digest(normalized),
      prediction_count: normalized.length,
      fixture_count: new Set(normalized.map(outcome => outcome.fixture_id)).size,
      evaluator_receipt_sha256s: [...new Set(normalized.map(outcome => outcome.evaluator_receipt_sha256))].sort(),
      truth_revealed_only_after_seal: true
    },
    bins
  };
}
