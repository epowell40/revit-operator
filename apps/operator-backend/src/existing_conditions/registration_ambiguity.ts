import crypto from "node:crypto";
import {
  solveExistingConditionsRegistration,
  transformExistingConditionsPlanPoint,
  type ExistingConditionsPlanPoint,
  type ExistingConditionsRegistrationInput,
  type ExistingConditionsRegistrationReceipt
} from "./registration.js";
import { assertExistingConditionsContract } from "./contract_validation.js";

export type ExistingConditionsRegistrationAmbiguityCandidateV1 = {
  candidate_id: string;
  registration: ExistingConditionsRegistrationInput;
  independent_evidence_score: number;
  independent_evidence_support_count: number;
  evidence_kind: "retained_non_target_mask" | "agent_visible_context_render" | "agent_visible_semantic_crop_set";
  evidence_role: string;
  evidence_sha256: string;
  access_scope: "agent_visible";
  target_regions_excluded: true;
};

export type ExistingConditionsRegistrationSemanticAnchorV1 = {
  anchor_id: string;
  source: ExistingConditionsPlanPoint;
  model: ExistingConditionsPlanPoint;
  evidence_role: string;
  evidence_sha256: string;
  access_scope: "agent_visible";
  non_repeating_context: true;
  target_regions_excluded: true;
};

export type ExistingConditionsRegistrationAmbiguityPolicyV1 = {
  minimum_distinct_candidate_displacement_ft?: number;
  minimum_independent_evidence_score?: number;
  minimum_independent_evidence_margin?: number;
  minimum_independent_evidence_support_count?: number;
  minimum_semantic_anchor_count?: number;
  maximum_semantic_anchor_error_ft?: number;
  minimum_semantic_anchor_rms_margin_ft?: number;
};

export type ExistingConditionsRegistrationAmbiguityInputV1 = {
  schema_version: 1;
  source_evidence_sha256: string;
  selected_candidate_id: string;
  source_bounds: {
    min: ExistingConditionsPlanPoint;
    max: ExistingConditionsPlanPoint;
  };
  candidate_search_complete: true;
  evaluated_candidate_count: number;
  candidates: ExistingConditionsRegistrationAmbiguityCandidateV1[];
  semantic_anchors?: ExistingConditionsRegistrationSemanticAnchorV1[];
  policy?: ExistingConditionsRegistrationAmbiguityPolicyV1;
};

export type ExistingConditionsRegistrationAmbiguityCandidateSummaryV1 = {
  candidate_id: string;
  independent_evidence_score: number;
  independent_evidence_support_count: number;
  semantic_anchor_rms_error_ft?: number;
  semantic_anchor_maximum_error_ft?: number;
  selected: boolean;
};

export type ExistingConditionsRegistrationAmbiguityReceiptV1 = {
  schema_version: 1;
  source_evidence_sha256: string;
  input_fingerprint_sha256: string;
  selected_candidate_id: string;
  selected_registration: ExistingConditionsRegistrationReceipt;
  evaluated_candidate_count: number;
  retained_candidate_count: number;
  distinct_candidate_count: number;
  independent_evidence_margin?: number;
  semantic_anchor_rms_margin_ft?: number;
  accepted_basis: "semantic_anchors" | "independent_evidence_margin" | null;
  verified: boolean;
  blockers: string[];
  candidate_summaries: ExistingConditionsRegistrationAmbiguityCandidateSummaryV1[];
  usage_constraints: string[];
};

type EvaluatedCandidate = {
  candidate: ExistingConditionsRegistrationAmbiguityCandidateV1;
  registration: ExistingConditionsRegistrationReceipt;
  semantic_anchor_rms_error_ft?: number;
  semantic_anchor_maximum_error_ft?: number;
};

const DEFAULT_POLICY = {
  minimum_distinct_candidate_displacement_ft: 1,
  minimum_independent_evidence_score: 0.2,
  minimum_independent_evidence_margin: 0.05,
  minimum_independent_evidence_support_count: 8,
  minimum_semantic_anchor_count: 3,
  maximum_semantic_anchor_error_ft: 0.25,
  minimum_semantic_anchor_rms_margin_ft: 0.5
} as const;
const MAX_ABSOLUTE_COORDINATE = 10_000_000;
const MAX_CONTROL_POINTS_PER_CANDIDATE = 100;
const MAX_SEMANTIC_ANCHORS = 1_000;
const MINIMUM_SEMANTIC_ANCHOR_MODEL_SEPARATION_FT = 1;
const MINIMUM_SEMANTIC_ANCHOR_SOURCE_SEPARATION_FRACTION = 0.005;

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`).join(",")}}`;
}

function fingerprint(value: unknown): string {
  return crypto.createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function requiredText(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0) throw new Error(`${label}_is_required`);
  return value.trim();
}

function finite(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`${label}_must_be_finite`);
  return value;
}

function bounded(value: unknown, label: string, min: number, max: number): number {
  const parsed = finite(value, label);
  if (parsed < min || parsed > max) throw new Error(`${label}_must_be_between_${min}_and_${max}`);
  return parsed;
}

function positive(value: unknown, label: string): number {
  const parsed = finite(value, label);
  if (parsed <= 0) throw new Error(`${label}_must_be_positive`);
  return parsed;
}

function positiveInteger(value: unknown, label: string): number {
  const parsed = finite(value, label);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error(`${label}_must_be_positive_integer`);
  return parsed;
}

function sha256(value: unknown, label: string): string {
  const normalized = requiredText(value, label).toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(normalized)) throw new Error(`${label}_must_be_sha256`);
  return normalized;
}

function visibleEvidenceRole(value: unknown, label: string): string {
  const role = requiredText(value, label);
  const words = role.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  if (/\b(withheld|evaluator|evaluation|scorer|oracle|gold|golden|benchmark|secret|hidden|holdout)\b/.test(words)
    || /\b(ground|target|native|withheld|evaluator|label) truth\b/.test(words)
    || /\b(answer|solution) key\b/.test(words)
    || /\b(reference|canonical|expected) answer\b/.test(words)
    || /\b(native inventory|source model|original model|gold standard)\b/.test(words)) {
    throw new Error(`${label}_must_be_agent_visible_non_target_evidence`);
  }
  return role;
}

function checkedPoint(value: ExistingConditionsPlanPoint, label: string): ExistingConditionsPlanPoint {
  if (!value || typeof value !== "object") throw new Error(`${label}_is_required`);
  const x = finite(value.x, `${label}_x`);
  const y = finite(value.y, `${label}_y`);
  if (Math.abs(x) > MAX_ABSOLUTE_COORDINATE || Math.abs(y) > MAX_ABSOLUTE_COORDINATE) {
    throw new Error(`${label}_coordinate_out_of_bounds`);
  }
  return { x, y };
}

function nonCollinear(points: ExistingConditionsPlanPoint[]): boolean {
  if (points.length < 3) return false;
  const xs = points.map((entry) => entry.x);
  const ys = points.map((entry) => entry.y);
  const spanSquared = (Math.max(...xs) - Math.min(...xs)) ** 2 + (Math.max(...ys) - Math.min(...ys)) ** 2;
  if (!Number.isFinite(spanSquared) || spanSquared <= 1e-12) return false;
  const origin = points[0]!;
  return points.slice(1).some((first, firstIndex) => points.slice(firstIndex + 2).some((second) => {
    const ax = first.x - origin.x;
    const ay = first.y - origin.y;
    const bx = second.x - origin.x;
    const by = second.y - origin.y;
    return Math.abs(ax * by - ay * bx) / spanSquared >= 0.001;
  }));
}

function requirePairwiseSeparation(
  points: ExistingConditionsPlanPoint[],
  minimumSeparation: number,
  error: string
): void {
  for (let first = 0; first < points.length; first += 1) {
    for (let second = first + 1; second < points.length; second += 1) {
      const a = points[first]!;
      const b = points[second]!;
      if (Math.hypot(a.x - b.x, a.y - b.y) < minimumSeparation) throw new Error(error);
    }
  }
}

function transformDisplacementFt(
  first: ExistingConditionsRegistrationReceipt,
  second: ExistingConditionsRegistrationReceipt,
  samplePoints: ExistingConditionsPlanPoint[]
): number {
  const displacement = Math.max(...samplePoints.map((entry) => {
    const a = transformExistingConditionsPlanPoint(first, entry);
    const b = transformExistingConditionsPlanPoint(second, entry);
    for (const point of [a, b]) {
      if (!Number.isFinite(point.x) || !Number.isFinite(point.y)
        || Math.abs(point.x) > MAX_ABSOLUTE_COORDINATE
        || Math.abs(point.y) > MAX_ABSOLUTE_COORDINATE) {
        throw new Error("registration_candidate_transformed_bounds_invalid");
      }
    }
    return Math.hypot(a.x - b.x, a.y - b.y);
  }));
  if (!Number.isFinite(displacement)) throw new Error("registration_candidate_displacement_must_be_finite");
  return displacement;
}

function selectDistinctRepresentatives(
  candidates: EvaluatedCandidate[],
  samplePoints: ExistingConditionsPlanPoint[],
  minimumDisplacementFt: number,
  rank: (candidate: EvaluatedCandidate) => number
): EvaluatedCandidate[] {
  const sorted = [...candidates].sort((left, right) => {
    const difference = rank(right) - rank(left);
    return difference !== 0 ? difference : left.candidate.candidate_id.localeCompare(right.candidate.candidate_id);
  });
  const representatives: EvaluatedCandidate[] = [];
  for (const candidate of sorted) {
    if (representatives.some((entry) =>
      transformDisplacementFt(candidate.registration, entry.registration, samplePoints) < minimumDisplacementFt
    )) continue;
    representatives.push(candidate);
  }
  return representatives;
}

export function assessExistingConditionsRegistrationAmbiguity(
  input: ExistingConditionsRegistrationAmbiguityInputV1
): ExistingConditionsRegistrationAmbiguityReceiptV1 {
  assertExistingConditionsContract("registration_ambiguity", input);
  if (!input || typeof input !== "object" || input.schema_version !== 1) {
    throw new Error("registration_ambiguity_requires_schema_v1");
  }
  const sourceHash = sha256(input.source_evidence_sha256, "source_evidence_sha256");
  const selectedCandidateId = requiredText(input.selected_candidate_id, "selected_candidate_id");
  if (input.candidate_search_complete !== true) throw new Error("registration_candidate_search_must_be_complete");
  const evaluatedCandidateCount = positiveInteger(input.evaluated_candidate_count, "evaluated_candidate_count");
  if (!Array.isArray(input.candidates) || input.candidates.length < 2 || input.candidates.length > 1_000) {
    throw new Error("registration_ambiguity_requires_two_to_1000_candidates");
  }
  if (evaluatedCandidateCount < input.candidates.length) {
    throw new Error("evaluated_candidate_count_cannot_be_less_than_retained_candidates");
  }

  const min = checkedPoint(input.source_bounds?.min, "source_bounds_min");
  const max = checkedPoint(input.source_bounds?.max, "source_bounds_max");
  if (max.x <= min.x || max.y <= min.y) throw new Error("source_bounds_must_have_positive_extent");
  const samplePoints = [
    min,
    { x: max.x, y: min.y },
    max,
    { x: min.x, y: max.y },
    { x: (min.x + max.x) / 2, y: (min.y + max.y) / 2 }
  ];

  const policy = {
    minimum_distinct_candidate_displacement_ft: input.policy?.minimum_distinct_candidate_displacement_ft == null
      ? DEFAULT_POLICY.minimum_distinct_candidate_displacement_ft
      : positive(input.policy.minimum_distinct_candidate_displacement_ft, "minimum_distinct_candidate_displacement_ft"),
    minimum_independent_evidence_score: input.policy?.minimum_independent_evidence_score == null
      ? DEFAULT_POLICY.minimum_independent_evidence_score
      : bounded(input.policy.minimum_independent_evidence_score, "minimum_independent_evidence_score", 0, 1),
    minimum_independent_evidence_margin: input.policy?.minimum_independent_evidence_margin == null
      ? DEFAULT_POLICY.minimum_independent_evidence_margin
      : bounded(input.policy.minimum_independent_evidence_margin, "minimum_independent_evidence_margin", 0, 1),
    minimum_independent_evidence_support_count: input.policy?.minimum_independent_evidence_support_count == null
      ? DEFAULT_POLICY.minimum_independent_evidence_support_count
      : positiveInteger(input.policy.minimum_independent_evidence_support_count, "minimum_independent_evidence_support_count"),
    minimum_semantic_anchor_count: input.policy?.minimum_semantic_anchor_count == null
      ? DEFAULT_POLICY.minimum_semantic_anchor_count
      : positiveInteger(input.policy.minimum_semantic_anchor_count, "minimum_semantic_anchor_count"),
    maximum_semantic_anchor_error_ft: input.policy?.maximum_semantic_anchor_error_ft == null
      ? DEFAULT_POLICY.maximum_semantic_anchor_error_ft
      : positive(input.policy.maximum_semantic_anchor_error_ft, "maximum_semantic_anchor_error_ft"),
    minimum_semantic_anchor_rms_margin_ft: input.policy?.minimum_semantic_anchor_rms_margin_ft == null
      ? DEFAULT_POLICY.minimum_semantic_anchor_rms_margin_ft
      : positive(input.policy.minimum_semantic_anchor_rms_margin_ft, "minimum_semantic_anchor_rms_margin_ft")
  };
  if (policy.minimum_distinct_candidate_displacement_ft < DEFAULT_POLICY.minimum_distinct_candidate_displacement_ft
    || policy.minimum_independent_evidence_score < DEFAULT_POLICY.minimum_independent_evidence_score
    || policy.minimum_independent_evidence_margin < DEFAULT_POLICY.minimum_independent_evidence_margin
    || policy.minimum_independent_evidence_support_count < DEFAULT_POLICY.minimum_independent_evidence_support_count
    || policy.minimum_semantic_anchor_count < DEFAULT_POLICY.minimum_semantic_anchor_count
    || policy.maximum_semantic_anchor_error_ft > DEFAULT_POLICY.maximum_semantic_anchor_error_ft
    || policy.minimum_semantic_anchor_rms_margin_ft < DEFAULT_POLICY.minimum_semantic_anchor_rms_margin_ft) {
    throw new Error("registration_ambiguity_policy_cannot_be_more_permissive_than_defaults");
  }
  if (policy.minimum_semantic_anchor_count > MAX_SEMANTIC_ANCHORS) {
    throw new Error("minimum_semantic_anchor_count_exceeds_limit");
  }

  const ids = new Set<string>();
  let commonEvidenceRole: string | null = null;
  let commonEvidenceHash: string | null = null;
  const evaluated: EvaluatedCandidate[] = input.candidates.map((candidate, index) => {
    const id = requiredText(candidate.candidate_id, `candidate_${index}_id`);
    if (ids.has(id)) throw new Error(`registration_candidate_id_duplicate:${id}`);
    ids.add(id);
    if (candidate.target_regions_excluded !== true) {
      throw new Error(`registration_candidate_target_regions_must_be_excluded:${id}`);
    }
    if (candidate.access_scope !== "agent_visible") {
      throw new Error(`registration_candidate_must_be_agent_visible:${id}`);
    }
    if (!["retained_non_target_mask", "agent_visible_context_render", "agent_visible_semantic_crop_set"]
      .includes(candidate.evidence_kind)) {
      throw new Error(`registration_candidate_evidence_kind_invalid:${id}`);
    }
    if (!Array.isArray(candidate.registration?.control_points)
      || candidate.registration.control_points.length < 3
      || candidate.registration.control_points.length > MAX_CONTROL_POINTS_PER_CANDIDATE) {
      throw new Error(`registration_candidate_control_point_limit_invalid:${id}`);
    }
    const evidenceRole = visibleEvidenceRole(candidate.evidence_role, `candidate_${index}_evidence_role`);
    const evidenceHash = sha256(candidate.evidence_sha256, `candidate_${index}_evidence_sha256`);
    commonEvidenceRole ??= evidenceRole;
    commonEvidenceHash ??= evidenceHash;
    if (evidenceRole !== commonEvidenceRole || evidenceHash !== commonEvidenceHash) {
      throw new Error("registration_candidates_must_share_one_independent_evidence_set");
    }
    const checkedControls = candidate.registration.control_points.map((controlPoint, controlIndex) => ({
      source: checkedPoint(controlPoint.source, `candidate_${index}_control_${controlIndex}_source`),
      model: checkedPoint(controlPoint.model, `candidate_${index}_control_${controlIndex}_model`)
    }));
    if (checkedControls.some((entry) => entry.source.x < min.x || entry.source.x > max.x
      || entry.source.y < min.y || entry.source.y > max.y)) {
      throw new Error(`registration_candidate_control_source_outside_bounds:${id}`);
    }
    const controlSourceXs = checkedControls.map((entry) => entry.source.x);
    const controlSourceYs = checkedControls.map((entry) => entry.source.y);
    const controlSourceSpan = Math.hypot(
      Math.max(...controlSourceXs) - Math.min(...controlSourceXs),
      Math.max(...controlSourceYs) - Math.min(...controlSourceYs)
    );
    const sourceBoundsSpan = Math.hypot(max.x - min.x, max.y - min.y);
    if (controlSourceSpan < sourceBoundsSpan * 0.01) {
      throw new Error(`registration_candidate_control_span_is_ill_conditioned:${id}`);
    }
    if (!nonCollinear(checkedControls.map((entry) => entry.source))
      || !nonCollinear(checkedControls.map((entry) => entry.model))) {
      throw new Error(`registration_candidate_control_points_are_ill_conditioned:${id}`);
    }
    const checkedRegistration: ExistingConditionsRegistrationInput = {
      ...candidate.registration,
      control_points: checkedControls
    };
    const registration = solveExistingConditionsRegistration(checkedRegistration);
    if (registration.source_evidence_sha256 !== sourceHash) {
      throw new Error(`registration_candidate_source_hash_mismatch:${id}`);
    }
    if (registration.max_rms_error_ft > 0.25 || registration.max_point_error_ft > 0.25) {
      throw new Error(`registration_candidate_tolerance_too_permissive:${id}`);
    }
    if (!registration.verified) throw new Error(`registration_candidate_not_verified:${id}`);
    return {
      candidate: {
        ...candidate,
        candidate_id: id,
        independent_evidence_score: bounded(
          candidate.independent_evidence_score,
          `candidate_${index}_independent_evidence_score`,
          0,
          1
        ),
        independent_evidence_support_count: positiveInteger(
          candidate.independent_evidence_support_count,
          `candidate_${index}_independent_evidence_support_count`
        ),
        evidence_role: evidenceRole,
        evidence_sha256: evidenceHash
      },
      registration
    };
  });
  const selected = evaluated.find((entry) => entry.candidate.candidate_id === selectedCandidateId);
  if (!selected) throw new Error("selected_registration_candidate_not_found");

  if (input.semantic_anchors != null
    && (!Array.isArray(input.semantic_anchors) || input.semantic_anchors.length > MAX_SEMANTIC_ANCHORS)) {
    throw new Error("semantic_anchor_limit_exceeded");
  }
  const anchors = input.semantic_anchors == null ? [] : input.semantic_anchors.map((anchor, index) => {
    const id = requiredText(anchor.anchor_id, `semantic_anchor_${index}_id`);
    if (anchor.access_scope !== "agent_visible") throw new Error(`semantic_anchor_${index}_must_be_agent_visible`);
    if (anchor.non_repeating_context !== true) throw new Error(`semantic_anchor_${index}_must_be_non_repeating`);
    if (anchor.target_regions_excluded !== true) throw new Error(`semantic_anchor_${index}_must_exclude_target_regions`);
    const evidenceRole = visibleEvidenceRole(anchor.evidence_role, `semantic_anchor_${index}_evidence_role`);
    const evidenceHash = sha256(anchor.evidence_sha256, `semantic_anchor_${index}_evidence_sha256`);
    const source = checkedPoint(anchor.source, `semantic_anchor_${index}_source`);
    if (source.x < min.x || source.x > max.x || source.y < min.y || source.y > max.y) {
      throw new Error(`semantic_anchor_${index}_source_must_be_within_source_bounds`);
    }
    return {
      id,
      source,
      model: checkedPoint(anchor.model, `semantic_anchor_${index}_model`),
      evidenceRole,
      evidenceHash
    };
  });
  if (new Set(anchors.map((entry) => entry.id)).size !== anchors.length) {
    throw new Error("semantic_anchor_ids_must_be_unique");
  }
  if (new Set(anchors.map((entry) => entry.evidenceRole.toLowerCase())).size !== anchors.length
    || new Set(anchors.map((entry) => entry.evidenceHash)).size !== anchors.length) {
    throw new Error("semantic_anchors_require_unique_hash_bound_context_evidence");
  }
  if (anchors.some((entry) => entry.evidenceRole.toLowerCase() === commonEvidenceRole?.toLowerCase()
    || entry.evidenceHash === commonEvidenceHash)) {
    throw new Error("semantic_anchor_context_must_be_independent_of_candidate_score_evidence");
  }
  const minimumSourceSeparation = Math.max(
    Math.min(max.x - min.x, max.y - min.y) * MINIMUM_SEMANTIC_ANCHOR_SOURCE_SEPARATION_FRACTION,
    1e-6
  );
  requirePairwiseSeparation(
    anchors.map((entry) => entry.source),
    minimumSourceSeparation,
    "semantic_anchor_source_points_are_not_independent"
  );
  requirePairwiseSeparation(
    anchors.map((entry) => entry.model),
    MINIMUM_SEMANTIC_ANCHOR_MODEL_SEPARATION_FT,
    "semantic_anchor_model_points_are_not_independent"
  );
  if (anchors.length > 0 && !nonCollinear(anchors.map((entry) => entry.source))) {
    throw new Error("semantic_anchor_source_points_must_be_non_collinear");
  }
  if (anchors.length > 0 && !nonCollinear(anchors.map((entry) => entry.model))) {
    throw new Error("semantic_anchor_model_points_must_be_non_collinear");
  }
  for (const candidate of evaluated) {
    if (anchors.length === 0) continue;
    const errors = anchors.map((anchor) => {
      const transformed = checkedPoint(
        transformExistingConditionsPlanPoint(candidate.registration, anchor.source),
        `registration_candidate_${candidate.candidate.candidate_id}_semantic_anchor_transform`
      );
      const error = Math.hypot(transformed.x - anchor.model.x, transformed.y - anchor.model.y);
      if (!Number.isFinite(error)) throw new Error("semantic_anchor_error_must_be_finite");
      return error;
    });
    candidate.semantic_anchor_rms_error_ft = Math.sqrt(errors.reduce((sum, value) => sum + value * value, 0) / errors.length);
    candidate.semantic_anchor_maximum_error_ft = Math.max(...errors);
  }

  const scoreRepresentatives = selectDistinctRepresentatives(
    evaluated,
    samplePoints,
    policy.minimum_distinct_candidate_displacement_ft,
    (entry) => entry.candidate.independent_evidence_score
  );
  const scoreSelected = scoreRepresentatives.find((entry) => entry.candidate.candidate_id === selectedCandidateId);
  const scoreRunnerUp = scoreRepresentatives.find((entry) => entry.candidate.candidate_id !== selectedCandidateId);
  const independentMargin = scoreSelected && scoreRunnerUp
    ? scoreSelected.candidate.independent_evidence_score - scoreRunnerUp.candidate.independent_evidence_score
    : undefined;
  const independentPass = Boolean(
    scoreSelected
    && scoreRunnerUp
    && scoreRepresentatives[0]?.candidate.candidate_id === selectedCandidateId
    && scoreSelected.candidate.independent_evidence_score >= policy.minimum_independent_evidence_score
    && scoreSelected.candidate.independent_evidence_support_count >= policy.minimum_independent_evidence_support_count
    && scoreRunnerUp.candidate.independent_evidence_support_count >= policy.minimum_independent_evidence_support_count
    && independentMargin != null
    && independentMargin >= policy.minimum_independent_evidence_margin
  );

  const anchorRepresentatives = anchors.length > 0
    ? selectDistinctRepresentatives(
        evaluated,
        samplePoints,
        policy.minimum_distinct_candidate_displacement_ft,
        (entry) => -(entry.semantic_anchor_rms_error_ft ?? Number.POSITIVE_INFINITY)
      )
    : [];
  const anchorSelected = anchorRepresentatives.find((entry) => entry.candidate.candidate_id === selectedCandidateId);
  const anchorRunnerUp = anchorRepresentatives.find((entry) => entry.candidate.candidate_id !== selectedCandidateId);
  const semanticMargin = anchorSelected?.semantic_anchor_rms_error_ft != null
    && anchorRunnerUp?.semantic_anchor_rms_error_ft != null
    ? anchorRunnerUp.semantic_anchor_rms_error_ft - anchorSelected.semantic_anchor_rms_error_ft
    : undefined;
  const semanticPass = Boolean(
    anchors.length >= policy.minimum_semantic_anchor_count
    && anchorSelected
    && anchorRunnerUp
    && anchorRepresentatives[0]?.candidate.candidate_id === selectedCandidateId
    && anchorSelected.semantic_anchor_maximum_error_ft != null
    && anchorSelected.semantic_anchor_maximum_error_ft <= policy.maximum_semantic_anchor_error_ft
    && semanticMargin != null
    && semanticMargin >= policy.minimum_semantic_anchor_rms_margin_ft
  );

  const blockers: string[] = [];
  if (scoreRepresentatives.length < 2 && anchorRepresentatives.length < 2) {
    blockers.push("registration_requires_two_materially_distinct_candidate_transforms");
  }
  if (!semanticPass && !independentPass) {
    blockers.push("registration_selection_lacks_decisive_non_repeating_anchor_or_independent_margin");
  }
  const acceptedBasis = semanticPass
    ? "semantic_anchors"
    : independentPass
      ? "independent_evidence_margin"
      : null;

  return {
    schema_version: 1,
    source_evidence_sha256: sourceHash,
    input_fingerprint_sha256: fingerprint(input),
    selected_candidate_id: selectedCandidateId,
    selected_registration: selected.registration,
    evaluated_candidate_count: evaluatedCandidateCount,
    retained_candidate_count: evaluated.length,
    distinct_candidate_count: Math.max(scoreRepresentatives.length, anchorRepresentatives.length),
    independent_evidence_margin: independentMargin,
    semantic_anchor_rms_margin_ft: semanticMargin,
    accepted_basis: acceptedBasis,
    verified: blockers.length === 0,
    blockers,
    candidate_summaries: evaluated.map((entry) => ({
      candidate_id: entry.candidate.candidate_id,
      independent_evidence_score: entry.candidate.independent_evidence_score,
      independent_evidence_support_count: entry.candidate.independent_evidence_support_count,
      semantic_anchor_rms_error_ft: entry.semantic_anchor_rms_error_ft,
      semantic_anchor_maximum_error_ft: entry.semantic_anchor_maximum_error_ft,
      selected: entry.candidate.candidate_id === selectedCandidateId
    })),
    usage_constraints: [
      "This gate compares materially distinct registration candidates using agent-visible evidence outside target regions.",
      "Semantic-anchor acceptance requires separately hash-bound local context for each spatially independent, non-repeating anchor; caller claims remain auditable rather than evaluator-issued truth.",
      "A passing receipt does not identify MEP symbols, authorize native writes, or replace native geometry and topology scoring.",
      "Candidate-search completeness and evidence-set provenance remain caller-auditable claims bound into the receipt fingerprint."
    ]
  };
}
