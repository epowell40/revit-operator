import crypto from "node:crypto";

export type SheetTopologyDiscipline = "architectural" | "mechanical" | "plumbing" | "electrical";
export type SheetTopologyPrimitiveKind =
  | "wall_segment"
  | "route_segment"
  | "opening"
  | "point_symbol"
  | "annotation";

export type SheetTopologyPoint = { x: number; y: number; z?: number };

export type SheetTopologySourceViewV1 = {
  view_key: string;
  sheet_key: string;
  source_sha256: string;
  registration_sha256: string;
  discipline: SheetTopologyDiscipline;
  level_key: string;
  phase_key: string;
  role: "main_plan" | "enlarged_plan" | "part_plan" | "architectural_plan" | "detail";
  resolution_rank: number;
  registration: {
    verified: boolean;
    rms_residual_ft: number;
    maximum_residual_ft: number;
    confidence: number;
  };
};

export type SheetTopologyClaimV1 = {
  value: string;
  confidence: number;
  basis: "legible_source_evidence" | "approved_project_mapping" | "provider_hypothesis" | "unresolved";
};

export type SheetTopologyEndpointV1 = {
  endpoint_key: string;
  point: SheetTopologyPoint;
  outward_direction_xy: [number, number];
  boundary: "internal" | "view_boundary" | "sheet_continuation";
  continuation_key?: string;
};

export type SheetTopologyPrimitiveV1 = {
  primitive_id: string;
  source_view_key: string;
  source_mark_ids: string[];
  kind: SheetTopologyPrimitiveKind;
  points: SheetTopologyPoint[];
  endpoints?: SheetTopologyEndpointV1[];
  claims?: {
    system?: SheetTopologyClaimV1;
    size?: SheetTopologyClaimV1;
    type?: SheetTopologyClaimV1;
    family?: SheetTopologyClaimV1;
    host?: SheetTopologyClaimV1;
    elevation?: SheetTopologyClaimV1;
    vertical_extent?: SheetTopologyClaimV1;
  };
  confidence: {
    geometry: number;
    classification: number;
    topology: number;
    visibility: number;
  };
  independently_reversible: boolean;
};

export type SheetTopologySourceMarkV1 = {
  source_mark_id: string;
  source_view_key: string;
  disposition:
    | { status: "candidate"; primitive_ids: string[] }
    | { status: "unresolved"; reason: string }
    | { status: "approved_exclusion"; reason: string; approved: true };
};

export type SheetTopologyCalibrationBinV1 = {
  discipline: SheetTopologyDiscipline | "*";
  primitive_kind: SheetTopologyPrimitiveKind | "*";
  raw_confidence_min: number;
  raw_confidence_max: number;
  trials: number;
  successes: number;
  fixture_count: number;
};

export type SheetTopologyCalibrationProfileV1 = {
  schema_version: 1;
  profile_id: string;
  provenance: {
    outcomes_sha256: string;
    prediction_count: number;
    fixture_count: number;
    evaluator_receipt_sha256s: string[];
    truth_revealed_only_after_seal: true;
  };
  bins: SheetTopologyCalibrationBinV1[];
};

export type SheetTopologyCompilationPolicyV1 = {
  endpoint_tolerance_ft: number;
  duplicate_tolerance_ft: number;
  minimum_opposed_direction_dot: number;
  maximum_registration_residual_ft: number;
  minimum_geometry_confidence: number;
  minimum_calibration_trials: number;
  minimum_calibration_fixtures: number;
  minimum_batch_precision_lower_bound: number;
  minimum_single_action_precision_lower_bound: number;
  orthogonal_angle_tolerance_degrees: number;
};

export const DEFAULT_SHEET_TOPOLOGY_COMPILATION_POLICY_V1: SheetTopologyCompilationPolicyV1 = {
  endpoint_tolerance_ft: 1 / 8 / 12,
  duplicate_tolerance_ft: 1 / 8 / 12,
  minimum_opposed_direction_dot: 0.9,
  maximum_registration_residual_ft: 1 / 8 / 12,
  minimum_geometry_confidence: 0.9,
  minimum_calibration_trials: 20,
  minimum_calibration_fixtures: 3,
  minimum_batch_precision_lower_bound: 0.9,
  minimum_single_action_precision_lower_bound: 0.7,
  orthogonal_angle_tolerance_degrees: 2
};

export type SheetTopologyCompilationInputV1 = {
  schema_version: 1;
  package_id: string;
  coordinate_space: "model_xyz_feet";
  source_views: SheetTopologySourceViewV1[];
  source_marks: SheetTopologySourceMarkV1[];
  primitives: SheetTopologyPrimitiveV1[];
};

/** Server-owned evidence. Candidate/provider output must not supply its own calibration or registration trust. */
export type SheetTopologyCompilationContextV1 = {
  trusted_source_views: SheetTopologySourceViewV1[];
  calibration_profile: SheetTopologyCalibrationProfileV1;
  policy?: Partial<SheetTopologyCompilationPolicyV1>;
};

export type SheetTopologyConnectionV1 = {
  connection_id: string;
  primitive_ids: [string, string];
  endpoint_keys: [string, string];
  basis: "explicit_continuation" | "registered_endpoint_proximity";
  scope: "within_view" | "cross_view" | "cross_sheet";
  status: "accepted" | "provisional";
};

export type SheetTopologyJunctionV1 = {
  junction_id: string;
  primitive_ids: string[];
  endpoint_keys: string[];
  point: SheetTopologyPoint;
  kind: "elbow_or_offset" | "tee_or_branch" | "multiway";
  basis: "registered_endpoint_junction";
  scope: "within_view" | "cross_view" | "cross_sheet";
  status: "accepted" | "provisional";
};

export type SheetTopologyPrimitiveDecisionV1 = {
  primitive_id: string;
  canonical_primitive_id: string;
  decision: "native_batch" | "single_action" | "deferred" | "duplicate";
  raw_confidence: number;
  calibrated_precision_lower_bound: number | null;
  calibration_trials: number;
  calibration_fixtures: number;
  reasons: string[];
};

export type CompiledSheetTopologyV1 = {
  schema_version: 1;
  package_id: string;
  input_fingerprint_sha256: string;
  calibration_profile_sha256: string;
  status: "ready" | "partially_ready" | "blocked";
  source_accounting_closure: number;
  canonical_primitive_ids: string[];
  source_mark_ids_by_canonical_primitive: Record<string, string[]>;
  connections: SheetTopologyConnectionV1[];
  junctions: SheetTopologyJunctionV1[];
  component_by_primitive_id: Record<string, string>;
  frontier_endpoint_keys: string[];
  decisions: SheetTopologyPrimitiveDecisionV1[];
  native_batch_groups: Array<{ batch_key: string; primitive_ids: string[] }>;
  single_action_primitive_ids: string[];
  deferred_primitive_ids: string[];
  duplicate_primitive_ids: string[];
  conflicts: string[];
  warnings: string[];
};

function clean(value: unknown): string {
  return String(value ?? "").trim();
}

function requiredText(value: unknown, label: string): string {
  const result = clean(value);
  if (!result) throw new Error(`${label}_is_required`);
  return result;
}

function finite(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`${label}_must_be_finite`);
  return value;
}

function unit(value: unknown, label: string): number {
  const result = finite(value, label);
  if (result < 0 || result > 1) throw new Error(`${label}_must_be_between_zero_and_one`);
  return result;
}

function positive(value: unknown, label: string): number {
  const result = finite(value, label);
  if (result <= 0) throw new Error(`${label}_must_be_positive`);
  return result;
}

function sha256(value: unknown, label: string): string {
  const result = clean(value).toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(result)) throw new Error(`${label}_must_be_sha256`);
  return result;
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

function point(value: SheetTopologyPoint, label: string): SheetTopologyPoint {
  if (!value || typeof value !== "object") throw new Error(`${label}_is_required`);
  const result: SheetTopologyPoint = { x: finite(value.x, `${label}_x`), y: finite(value.y, `${label}_y`) };
  if (value.z !== undefined) result.z = finite(value.z, `${label}_z`);
  return result;
}

function distance(a: SheetTopologyPoint, b: SheetTopologyPoint): number {
  const dz = (a.z ?? 0) - (b.z ?? 0);
  return Math.hypot(a.x - b.x, a.y - b.y, dz);
}

function normalizedDirection(value: [number, number], label: string): [number, number] {
  if (!Array.isArray(value) || value.length !== 2) throw new Error(`${label}_must_have_two_values`);
  const x = finite(value[0], `${label}_x`);
  const y = finite(value[1], `${label}_y`);
  const length = Math.hypot(x, y);
  if (length <= 1e-9) throw new Error(`${label}_must_be_nonzero`);
  return [x / length, y / length];
}

function claim(value: SheetTopologyClaimV1 | undefined, label: string): SheetTopologyClaimV1 | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object") throw new Error(`${label}_invalid`);
  const basis = value.basis;
  if (!["legible_source_evidence", "approved_project_mapping", "provider_hypothesis", "unresolved"].includes(basis)) {
    throw new Error(`${label}_basis_invalid`);
  }
  return { value: requiredText(value.value, `${label}_value`), confidence: unit(value.confidence, `${label}_confidence`), basis };
}

function claimsCompatible(a: SheetTopologyPrimitiveV1, b: SheetTopologyPrimitiveV1): boolean {
  for (const key of ["system", "size", "type", "family", "host", "elevation", "vertical_extent"] as const) {
    const left = clean(a.claims?.[key]?.value).toLowerCase();
    const right = clean(b.claims?.[key]?.value).toLowerCase();
    if (left && right && left !== right) return false;
  }
  return true;
}

function connectionClaimsResolved(primitive: SheetTopologyPrimitiveV1, discipline: SheetTopologyDiscipline): boolean {
  if (discipline === "architectural" || primitive.kind !== "route_segment") return true;
  if (discipline === "mechanical" || discipline === "plumbing") return claimResolved(primitive.claims?.system);
  return claimResolved(primitive.claims?.type);
}

function requiredClaims(primitive: SheetTopologyPrimitiveV1, discipline: SheetTopologyDiscipline): Array<keyof NonNullable<SheetTopologyPrimitiveV1["claims"]>> {
  if (primitive.kind === "wall_segment") return ["type", "vertical_extent"];
  if (primitive.kind === "opening") return ["family", "type", "host"];
  if (primitive.kind === "route_segment") {
    if (discipline === "mechanical" || discipline === "plumbing") return ["system", "size", "type", "elevation"];
    if (discipline === "electrical") return ["size", "type", "elevation"];
  }
  if (primitive.kind === "point_symbol") return discipline === "electrical" ? ["family", "type", "host"] : ["family", "type"];
  return [];
}

function claimResolved(value: SheetTopologyClaimV1 | undefined): boolean {
  return Boolean(value && value.basis !== "provider_hypothesis" && value.basis !== "unresolved" && value.confidence >= 0.9);
}

function isOrthogonal(points: SheetTopologyPoint[], toleranceDegrees: number): boolean {
  if (points.length !== 2) return false;
  const dx = Math.abs(points[1]!.x - points[0]!.x);
  const dy = Math.abs(points[1]!.y - points[0]!.y);
  if (dx <= 1e-9 || dy <= 1e-9) return true;
  const angle = Math.atan2(dy, dx) * 180 / Math.PI;
  return angle <= toleranceDegrees || Math.abs(90 - angle) <= toleranceDegrees;
}

function sameLinearGeometry(a: SheetTopologyPrimitiveV1, b: SheetTopologyPrimitiveV1, tolerance: number): boolean {
  if (a.points.length !== 2 || b.points.length !== 2) return false;
  return (distance(a.points[0]!, b.points[0]!) <= tolerance && distance(a.points[1]!, b.points[1]!) <= tolerance)
    || (distance(a.points[0]!, b.points[1]!) <= tolerance && distance(a.points[1]!, b.points[0]!) <= tolerance);
}

function wilsonLowerBound(successes: number, trials: number): number {
  if (trials <= 0) return 0;
  const z = 1.959963984540054;
  const p = successes / trials;
  const denominator = 1 + z * z / trials;
  const center = p + z * z / (2 * trials);
  const margin = z * Math.sqrt((p * (1 - p) + z * z / (4 * trials)) / trials);
  return Math.max(0, (center - margin) / denominator);
}

function calibrationFor(
  profile: SheetTopologyCalibrationProfileV1,
  discipline: SheetTopologyDiscipline,
  kind: SheetTopologyPrimitiveKind,
  raw: number
): { trials: number; fixtures: number; lower: number | null } {
  const matches = profile.bins.filter(bin =>
    (bin.discipline === discipline || bin.discipline === "*")
    && (bin.primitive_kind === kind || bin.primitive_kind === "*")
    && raw >= bin.raw_confidence_min
    && (raw < bin.raw_confidence_max || (raw === 1 && bin.raw_confidence_max === 1))
  ).sort((a, b) => {
    const specificityA = Number(a.discipline !== "*") + Number(a.primitive_kind !== "*");
    const specificityB = Number(b.discipline !== "*") + Number(b.primitive_kind !== "*");
    if (specificityA !== specificityB) return specificityB - specificityA;
    return (a.raw_confidence_max - a.raw_confidence_min) - (b.raw_confidence_max - b.raw_confidence_min);
  });
  const selected = matches[0];
  return selected
    ? { trials: selected.trials, fixtures: selected.fixture_count, lower: wilsonLowerBound(selected.successes, selected.trials) }
    : { trials: 0, fixtures: 0, lower: null };
}

class DisjointSet {
  private readonly parent = new Map<string, string>();
  add(value: string): void { if (!this.parent.has(value)) this.parent.set(value, value); }
  find(value: string): string {
    const parent = this.parent.get(value);
    if (!parent) throw new Error(`sheet_topology_unknown_component_member:${value}`);
    if (parent === value) return value;
    const root = this.find(parent);
    this.parent.set(value, root);
    return root;
  }
  union(a: string, b: string): void {
    const left = this.find(a);
    const right = this.find(b);
    if (left === right) return;
    this.parent.set(left < right ? right : left, left < right ? left : right);
  }
}

export function compileSheetTopologyV1(
  input: SheetTopologyCompilationInputV1,
  context: SheetTopologyCompilationContextV1
): CompiledSheetTopologyV1 {
  if (!input || input.schema_version !== 1) throw new Error("sheet_topology_compilation_requires_schema_v1");
  if (input.coordinate_space !== "model_xyz_feet") throw new Error("sheet_topology_compilation_coordinate_space_invalid");
  if (!context || typeof context !== "object") throw new Error("sheet_topology_compilation_context_required");
  const packageId = requiredText(input.package_id, "sheet_topology_package_id");
  if (!Array.isArray(input.source_views) || input.source_views.length === 0) throw new Error("sheet_topology_source_views_required");
  if (!Array.isArray(input.source_marks) || input.source_marks.length === 0) throw new Error("sheet_topology_source_marks_required");
  if (!Array.isArray(input.primitives)) throw new Error("sheet_topology_primitives_required");
  if (!context.calibration_profile || context.calibration_profile.schema_version !== 1) throw new Error("sheet_topology_calibration_profile_v1_required");
  if (!Array.isArray(context.trusted_source_views) || context.trusted_source_views.length === 0) throw new Error("sheet_topology_trusted_source_views_required");

  const policy = { ...DEFAULT_SHEET_TOPOLOGY_COMPILATION_POLICY_V1, ...(context.policy ?? {}) };
  positive(policy.endpoint_tolerance_ft, "sheet_topology_endpoint_tolerance_ft");
  positive(policy.duplicate_tolerance_ft, "sheet_topology_duplicate_tolerance_ft");
  unit(policy.minimum_opposed_direction_dot, "sheet_topology_minimum_opposed_direction_dot");
  positive(policy.maximum_registration_residual_ft, "sheet_topology_maximum_registration_residual_ft");
  unit(policy.minimum_geometry_confidence, "sheet_topology_minimum_geometry_confidence");
  if (!Number.isSafeInteger(policy.minimum_calibration_trials) || policy.minimum_calibration_trials < 1) throw new Error("sheet_topology_minimum_calibration_trials_invalid");
  if (!Number.isSafeInteger(policy.minimum_calibration_fixtures) || policy.minimum_calibration_fixtures < 1) throw new Error("sheet_topology_minimum_calibration_fixtures_invalid");
  unit(policy.minimum_batch_precision_lower_bound, "sheet_topology_minimum_batch_precision_lower_bound");
  unit(policy.minimum_single_action_precision_lower_bound, "sheet_topology_minimum_single_action_precision_lower_bound");
  positive(policy.orthogonal_angle_tolerance_degrees, "sheet_topology_orthogonal_angle_tolerance_degrees");

  const views = new Map<string, SheetTopologySourceViewV1>();
  const trustedViews = new Map(context.trusted_source_views.map(value => [clean(value.view_key), value]));
  if (trustedViews.size !== context.trusted_source_views.length) throw new Error("sheet_topology_duplicate_trusted_source_view");
  for (const [index, value] of input.source_views.entries()) {
    const key = requiredText(value.view_key, `sheet_topology_view_${index}_key`);
    if (views.has(key)) throw new Error(`sheet_topology_duplicate_view:${key}`);
    requiredText(value.sheet_key, `sheet_topology_view_${key}_sheet_key`);
    requiredText(value.level_key, `sheet_topology_view_${key}_level_key`);
    requiredText(value.phase_key, `sheet_topology_view_${key}_phase_key`);
    if (!["architectural", "mechanical", "plumbing", "electrical"].includes(value.discipline)) throw new Error(`sheet_topology_view_${key}_discipline_invalid`);
    if (!["main_plan", "enlarged_plan", "part_plan", "architectural_plan", "detail"].includes(value.role)) throw new Error(`sheet_topology_view_${key}_role_invalid`);
    sha256(value.source_sha256, `sheet_topology_view_${key}_source_sha256`);
    sha256(value.registration_sha256, `sheet_topology_view_${key}_registration_sha256`);
    if (!Number.isSafeInteger(value.resolution_rank) || value.resolution_rank < 0) throw new Error(`sheet_topology_view_${key}_resolution_rank_invalid`);
    unit(value.registration.confidence, `sheet_topology_view_${key}_registration_confidence`);
    const rmsResidual = finite(value.registration.rms_residual_ft, `sheet_topology_view_${key}_registration_rms`);
    const maximumResidual = finite(value.registration.maximum_residual_ft, `sheet_topology_view_${key}_registration_maximum`);
    if (rmsResidual < 0 || maximumResidual < rmsResidual) throw new Error(`sheet_topology_view_${key}_registration_residuals_invalid`);
    const trusted = trustedViews.get(key);
    if (!trusted || digest(trusted) !== digest(value)) throw new Error(`sheet_topology_source_view_not_trusted:${key}`);
    views.set(key, value);
  }

  const bins = context.calibration_profile.bins;
  requiredText(context.calibration_profile.profile_id, "sheet_topology_calibration_profile_id");
  const calibrationProvenance = context.calibration_profile.provenance;
  if (!calibrationProvenance || typeof calibrationProvenance !== "object") throw new Error("sheet_topology_calibration_provenance_required");
  sha256(calibrationProvenance.outcomes_sha256, "sheet_topology_calibration_outcomes_sha256");
  if (!Number.isSafeInteger(calibrationProvenance.prediction_count) || calibrationProvenance.prediction_count < 1) throw new Error("sheet_topology_calibration_prediction_count_invalid");
  if (!Number.isSafeInteger(calibrationProvenance.fixture_count) || calibrationProvenance.fixture_count < 1) throw new Error("sheet_topology_calibration_fixture_count_invalid");
  if (!Array.isArray(calibrationProvenance.evaluator_receipt_sha256s) || calibrationProvenance.evaluator_receipt_sha256s.length === 0) throw new Error("sheet_topology_calibration_evaluator_receipts_required");
  calibrationProvenance.evaluator_receipt_sha256s.forEach((value, index) => sha256(value, `sheet_topology_calibration_evaluator_receipt_${index}`));
  if (calibrationProvenance.truth_revealed_only_after_seal !== true) throw new Error("sheet_topology_calibration_requires_blind_sealed_outcomes");
  if (!Array.isArray(bins) || bins.length === 0) throw new Error("sheet_topology_calibration_bins_required");
  for (const [index, bin] of bins.entries()) {
    if (bin.discipline !== "*" && !["architectural", "mechanical", "plumbing", "electrical"].includes(bin.discipline)) throw new Error(`sheet_topology_calibration_bin_${index}_discipline_invalid`);
    if (bin.primitive_kind !== "*" && !["wall_segment", "route_segment", "opening", "point_symbol", "annotation"].includes(bin.primitive_kind)) throw new Error(`sheet_topology_calibration_bin_${index}_primitive_kind_invalid`);
    unit(bin.raw_confidence_min, `sheet_topology_calibration_bin_${index}_min`);
    unit(bin.raw_confidence_max, `sheet_topology_calibration_bin_${index}_max`);
    if (bin.raw_confidence_max <= bin.raw_confidence_min) throw new Error(`sheet_topology_calibration_bin_${index}_range_invalid`);
    if (!Number.isSafeInteger(bin.trials) || bin.trials < 1 || !Number.isSafeInteger(bin.successes) || bin.successes < 0 || bin.successes > bin.trials
      || !Number.isSafeInteger(bin.fixture_count) || bin.fixture_count < 1 || bin.fixture_count > bin.trials) {
      throw new Error(`sheet_topology_calibration_bin_${index}_counts_invalid`);
    }
    for (let previousIndex = 0; previousIndex < index; previousIndex += 1) {
      const previous = bins[previousIndex]!;
      if (previous.discipline !== bin.discipline || previous.primitive_kind !== bin.primitive_kind) continue;
      const overlaps = Math.max(previous.raw_confidence_min, bin.raw_confidence_min) < Math.min(previous.raw_confidence_max, bin.raw_confidence_max);
      if (overlaps) throw new Error(`sheet_topology_calibration_bins_overlap:${previousIndex}:${index}`);
    }
  }

  const primitives = new Map<string, SheetTopologyPrimitiveV1>();
  const endpoints = new Map<string, { primitive: SheetTopologyPrimitiveV1; endpoint: SheetTopologyEndpointV1; direction: [number, number] }>();
  for (const [index, value] of input.primitives.entries()) {
    const id = requiredText(value.primitive_id, `sheet_topology_primitive_${index}_id`);
    if (primitives.has(id)) throw new Error(`sheet_topology_duplicate_primitive:${id}`);
    const view = views.get(requiredText(value.source_view_key, `sheet_topology_primitive_${id}_view_key`));
    if (!view) throw new Error(`sheet_topology_unknown_primitive_view:${id}`);
    if (!["wall_segment", "route_segment", "opening", "point_symbol", "annotation"].includes(value.kind)) throw new Error(`sheet_topology_primitive_kind_invalid:${id}`);
    if (!Array.isArray(value.source_mark_ids) || value.source_mark_ids.length === 0) throw new Error(`sheet_topology_primitive_source_marks_required:${id}`);
    if (!Array.isArray(value.points) || value.points.length === 0) throw new Error(`sheet_topology_primitive_points_required:${id}`);
    value.points = value.points.map((entry, pointIndex) => point(entry, `sheet_topology_primitive_${id}_point_${pointIndex}`));
    unit(value.confidence.geometry, `sheet_topology_primitive_${id}_geometry_confidence`);
    unit(value.confidence.classification, `sheet_topology_primitive_${id}_classification_confidence`);
    unit(value.confidence.topology, `sheet_topology_primitive_${id}_topology_confidence`);
    unit(value.confidence.visibility, `sheet_topology_primitive_${id}_visibility_confidence`);
    for (const key of ["system", "size", "type", "family", "host", "elevation", "vertical_extent"] as const) {
      const normalized = claim(value.claims?.[key], `sheet_topology_primitive_${id}_${key}`);
      if (normalized) (value.claims ??= {})[key] = normalized;
    }
    const normalizedEndpoints = (value.endpoints ?? []).map((entry, endpointIndex) => {
      const endpointKey = requiredText(entry.endpoint_key, `sheet_topology_primitive_${id}_endpoint_${endpointIndex}_key`);
      if (endpoints.has(endpointKey)) throw new Error(`sheet_topology_duplicate_endpoint:${endpointKey}`);
      const normalized: SheetTopologyEndpointV1 = {
        ...entry,
        endpoint_key: endpointKey,
        point: point(entry.point, `sheet_topology_endpoint_${endpointKey}_point`),
        outward_direction_xy: normalizedDirection(entry.outward_direction_xy, `sheet_topology_endpoint_${endpointKey}_direction`),
        ...(clean(entry.continuation_key) ? { continuation_key: clean(entry.continuation_key) } : {})
      };
      if (!["internal", "view_boundary", "sheet_continuation"].includes(normalized.boundary)) throw new Error(`sheet_topology_endpoint_boundary_invalid:${endpointKey}`);
      if (normalized.boundary === "internal" && normalized.continuation_key) throw new Error(`sheet_topology_internal_endpoint_cannot_have_continuation:${endpointKey}`);
      if (normalized.boundary === "sheet_continuation" && !normalized.continuation_key) throw new Error(`sheet_topology_sheet_continuation_key_required:${endpointKey}`);
      const atPrimitiveEnd = distance(normalized.point, value.points[0]!) <= policy.endpoint_tolerance_ft
        || distance(normalized.point, value.points[value.points.length - 1]!) <= policy.endpoint_tolerance_ft;
      if (!atPrimitiveEnd) throw new Error(`sheet_topology_endpoint_not_on_primitive_end:${endpointKey}`);
      endpoints.set(endpointKey, { primitive: value, endpoint: normalized, direction: normalized.outward_direction_xy });
      return normalized;
    });
    value.endpoints = normalizedEndpoints;
    primitives.set(id, value);
  }

  const sourceMarkIds = new Set<string>();
  const sourceMarksById = new Map<string, SheetTopologySourceMarkV1>();
  for (const [index, mark] of input.source_marks.entries()) {
    const markId = requiredText(mark.source_mark_id, `sheet_topology_source_mark_${index}_id`);
    if (sourceMarkIds.has(markId)) throw new Error(`sheet_topology_duplicate_source_mark:${markId}`);
    sourceMarkIds.add(markId);
    sourceMarksById.set(markId, mark);
    if (!views.has(requiredText(mark.source_view_key, `sheet_topology_source_mark_${markId}_view_key`))) throw new Error(`sheet_topology_source_mark_unknown_view:${markId}`);
    if (mark.disposition.status === "candidate") {
      if (!Array.isArray(mark.disposition.primitive_ids) || mark.disposition.primitive_ids.length === 0) throw new Error(`sheet_topology_source_mark_candidate_empty:${markId}`);
      for (const primitiveId of mark.disposition.primitive_ids) {
        const primitive = primitives.get(primitiveId);
        if (!primitive) throw new Error(`sheet_topology_source_mark_unknown_primitive:${markId}:${primitiveId}`);
        if (primitive.source_view_key !== mark.source_view_key) throw new Error(`sheet_topology_source_mark_view_mismatch:${markId}:${primitiveId}`);
        if (!primitive.source_mark_ids.includes(markId)) throw new Error(`sheet_topology_source_mark_not_cited_by_primitive:${markId}:${primitiveId}`);
      }
    } else {
      requiredText(mark.disposition.reason, `sheet_topology_source_mark_${markId}_reason`);
      if (mark.disposition.status === "approved_exclusion" && mark.disposition.approved !== true) throw new Error(`sheet_topology_source_mark_exclusion_not_approved:${markId}`);
    }
  }
  for (const primitive of primitives.values()) {
    for (const markId of primitive.source_mark_ids) {
      if (!sourceMarkIds.has(markId)) throw new Error(`sheet_topology_primitive_unknown_source_mark:${primitive.primitive_id}:${markId}`);
      const mark = sourceMarksById.get(markId)!;
      if (mark.disposition.status !== "candidate" || !mark.disposition.primitive_ids.includes(primitive.primitive_id)) {
        throw new Error(`sheet_topology_primitive_not_registered_by_source_mark:${primitive.primitive_id}:${markId}`);
      }
    }
  }

  const conflicts: string[] = [];
  const warnings: string[] = [];
  const canonicalById = new Map<string, string>();
  const candidates = [...primitives.values()].sort((a, b) => a.primitive_id.localeCompare(b.primitive_id));
  for (const current of candidates) {
    canonicalById.set(current.primitive_id, current.primitive_id);
    if (current.kind !== "route_segment" && current.kind !== "wall_segment") continue;
    const currentView = views.get(current.source_view_key)!;
    for (const previous of candidates) {
      if (previous.primitive_id >= current.primitive_id) break;
      if (previous.kind !== current.kind || canonicalById.get(previous.primitive_id) !== previous.primitive_id) continue;
      const previousView = views.get(previous.source_view_key)!;
      if (previousView.discipline !== currentView.discipline || previousView.level_key !== currentView.level_key) continue;
      if (!sameLinearGeometry(previous, current, policy.duplicate_tolerance_ft)) continue;
      if (!claimsCompatible(previous, current)) {
        conflicts.push(`duplicate_geometry_claim_conflict:${previous.primitive_id}:${current.primitive_id}`);
        continue;
      }
      const preferred = previousView.resolution_rank > currentView.resolution_rank
        || (previousView.resolution_rank === currentView.resolution_rank && previous.confidence.geometry >= current.confidence.geometry)
        ? previous : current;
      const duplicate = preferred === previous ? current : previous;
      canonicalById.set(duplicate.primitive_id, preferred.primitive_id);
      canonicalById.set(preferred.primitive_id, preferred.primitive_id);
    }
  }

  const canonicalIds = [...primitives.keys()].filter(id => canonicalById.get(id) === id).sort();
  const disjoint = new DisjointSet();
  canonicalIds.forEach(id => disjoint.add(id));
  const connections: SheetTopologyConnectionV1[] = [];
  const junctions: SheetTopologyJunctionV1[] = [];
  const connectedEndpointKeys = new Set<string>();

  const addConnection = (leftKey: string, rightKey: string, basis: SheetTopologyConnectionV1["basis"]): void => {
    const left = endpoints.get(leftKey)!;
    const right = endpoints.get(rightKey)!;
    const leftId = canonicalById.get(left.primitive.primitive_id)!;
    const rightId = canonicalById.get(right.primitive.primitive_id)!;
    if (leftId === rightId) return;
    const leftView = views.get(left.primitive.source_view_key)!;
    const rightView = views.get(right.primitive.source_view_key)!;
    const scope = leftView.sheet_key !== rightView.sheet_key ? "cross_sheet" : leftView.view_key !== rightView.view_key ? "cross_view" : "within_view";
    const status = claimsCompatible(left.primitive, right.primitive)
      && connectionClaimsResolved(left.primitive, leftView.discipline)
      && connectionClaimsResolved(right.primitive, rightView.discipline)
      ? "accepted" : "provisional";
    const pair = [leftKey, rightKey].sort() as [string, string];
    connections.push({
      connection_id: `connection:${digest(pair).slice(0, 20)}`,
      primitive_ids: [leftId, rightId].sort() as [string, string],
      endpoint_keys: pair,
      basis,
      scope,
      status
    });
    connectedEndpointKeys.add(leftKey);
    connectedEndpointKeys.add(rightKey);
    disjoint.union(leftId, rightId);
  };

  const compatibleEndpointPair = (leftKey: string, rightKey: string): string | null => {
    const left = endpoints.get(leftKey)!;
    const right = endpoints.get(rightKey)!;
    const leftId = canonicalById.get(left.primitive.primitive_id)!;
    const rightId = canonicalById.get(right.primitive.primitive_id)!;
    if (leftId === rightId) return "same_primitive";
    if (left.primitive.kind !== right.primitive.kind) return "primitive_kind_mismatch";
    if (left.primitive.kind !== "route_segment" && left.primitive.kind !== "wall_segment") return "primitive_kind_not_connectable";
    if (left.primitive.confidence.geometry < policy.minimum_geometry_confidence
      || right.primitive.confidence.geometry < policy.minimum_geometry_confidence) return "geometry_confidence_below_threshold";
    const leftView = views.get(left.primitive.source_view_key)!;
    const rightView = views.get(right.primitive.source_view_key)!;
    if (leftView.discipline !== rightView.discipline) return "discipline_mismatch";
    if (leftView.level_key !== rightView.level_key) return "level_mismatch";
    if (!claimsCompatible(left.primitive, right.primitive)) return "claim_mismatch";
    if (distance(left.endpoint.point, right.endpoint.point) > policy.endpoint_tolerance_ft) return "endpoint_distance_exceeded";
    const dot = left.direction[0] * right.direction[0] + left.direction[1] * right.direction[1];
    if (dot > -policy.minimum_opposed_direction_dot) return "directions_not_opposed";
    return null;
  };

  const compatibleJunctionPair = (leftKey: string, rightKey: string): string | null => {
    const left = endpoints.get(leftKey)!;
    const right = endpoints.get(rightKey)!;
    const leftId = canonicalById.get(left.primitive.primitive_id)!;
    const rightId = canonicalById.get(right.primitive.primitive_id)!;
    if (leftId === rightId) return "same_primitive";
    if (left.primitive.kind !== right.primitive.kind) return "primitive_kind_mismatch";
    if (left.primitive.kind !== "route_segment" && left.primitive.kind !== "wall_segment") return "primitive_kind_not_connectable";
    if (left.primitive.confidence.geometry < policy.minimum_geometry_confidence
      || right.primitive.confidence.geometry < policy.minimum_geometry_confidence) return "geometry_confidence_below_threshold";
    const leftView = views.get(left.primitive.source_view_key)!;
    const rightView = views.get(right.primitive.source_view_key)!;
    if (leftView.discipline !== rightView.discipline) return "discipline_mismatch";
    if (leftView.level_key !== rightView.level_key) return "level_mismatch";
    if (!claimsCompatible(left.primitive, right.primitive)) return "claim_mismatch";
    if (distance(left.endpoint.point, right.endpoint.point) > policy.endpoint_tolerance_ft) return "endpoint_distance_exceeded";
    return null;
  };

  const addJunction = (memberKeys: string[]): void => {
    const members = [...memberKeys].sort();
    const memberValues = members.map(key => endpoints.get(key)!);
    const primitiveIds = [...new Set(memberValues.map(value => canonicalById.get(value.primitive.primitive_id)!))].sort();
    if (primitiveIds.length < 2) return;
    const memberViews = memberValues.map(value => views.get(value.primitive.source_view_key)!);
    const sheetKeys = new Set(memberViews.map(value => value.sheet_key));
    const viewKeys = new Set(memberViews.map(value => value.view_key));
    const scope = sheetKeys.size > 1 ? "cross_sheet" : viewKeys.size > 1 ? "cross_view" : "within_view";
    const status = memberValues.every(value => {
      const view = views.get(value.primitive.source_view_key)!;
      return connectionClaimsResolved(value.primitive, view.discipline);
    }) && memberValues.every((left, leftIndex) => memberValues.every((right, rightIndex) =>
      leftIndex >= rightIndex || claimsCompatible(left.primitive, right.primitive)
    )) ? "accepted" : "provisional";
    const pointCount = memberValues.length;
    const junctionPoint: SheetTopologyPoint = {
      x: memberValues.reduce((sum, value) => sum + value.endpoint.point.x, 0) / pointCount,
      y: memberValues.reduce((sum, value) => sum + value.endpoint.point.y, 0) / pointCount,
      ...(memberValues.some(value => value.endpoint.point.z !== undefined)
        ? { z: memberValues.reduce((sum, value) => sum + (value.endpoint.point.z ?? 0), 0) / pointCount }
        : {})
    };
    junctions.push({
      junction_id: `junction:${digest(members).slice(0, 20)}`,
      primitive_ids: primitiveIds,
      endpoint_keys: members,
      point: junctionPoint,
      kind: members.length === 2 ? "elbow_or_offset" : members.length === 3 ? "tee_or_branch" : "multiway",
      basis: "registered_endpoint_junction",
      scope,
      status
    });
    for (const key of members) connectedEndpointKeys.add(key);
    for (let index = 1; index < primitiveIds.length; index += 1) disjoint.union(primitiveIds[0]!, primitiveIds[index]!);
  };

  const explicitGroups = new Map<string, string[]>();
  for (const [endpointKey, value] of endpoints) {
    if (canonicalById.get(value.primitive.primitive_id) !== value.primitive.primitive_id) continue;
    const key = clean(value.endpoint.continuation_key);
    if (key) (explicitGroups.get(key) ?? explicitGroups.set(key, []).get(key)!).push(endpointKey);
  }
  for (const [key, members] of explicitGroups) {
    if (members.length !== 2) {
      conflicts.push(`continuation_key_requires_exact_pair:${key}:${members.length}`);
      continue;
    }
    const reason = compatibleEndpointPair(members[0]!, members[1]!);
    if (reason) conflicts.push(`continuation_key_incompatible:${key}:${members.join(",")}:${reason}`);
    else addConnection(members[0]!, members[1]!, "explicit_continuation");
  }

  const remaining = [...endpoints.keys()].filter(key => {
    const value = endpoints.get(key)!;
    return canonicalById.get(value.primitive.primitive_id) === value.primitive.primitive_id
      && !connectedEndpointKeys.has(key)
      && !clean(value.endpoint.continuation_key);
  }).sort();
  const endpointAdjacency = new Map<string, string[]>();
  for (const leftKey of remaining) {
    endpointAdjacency.set(leftKey, remaining.filter(rightKey => rightKey !== leftKey && compatibleJunctionPair(leftKey, rightKey) === null));
  }
  const visitedEndpoints = new Set<string>();
  for (const seedKey of remaining) {
    if (visitedEndpoints.has(seedKey) || connectedEndpointKeys.has(seedKey)) continue;
    const cluster: string[] = [];
    const queue = [seedKey];
    while (queue.length > 0) {
      const currentKey = queue.shift()!;
      if (visitedEndpoints.has(currentKey) || connectedEndpointKeys.has(currentKey)) continue;
      visitedEndpoints.add(currentKey);
      cluster.push(currentKey);
      for (const neighbor of endpointAdjacency.get(currentKey) ?? []) {
        if (!visitedEndpoints.has(neighbor) && !connectedEndpointKeys.has(neighbor)) queue.push(neighbor);
      }
    }
    if (cluster.length < 2) continue;
    const isClique = cluster.every((leftKey, leftIndex) => cluster.every((rightKey, rightIndex) =>
      leftIndex === rightIndex || compatibleJunctionPair(leftKey, rightKey) === null
    ));
    if (!isClique) {
      conflicts.push(`ambiguous_endpoint_cluster:${cluster.sort().join(",")}`);
      continue;
    }
    if (cluster.length === 2 && compatibleEndpointPair(cluster[0]!, cluster[1]!) === null) {
      addConnection(cluster[0]!, cluster[1]!, "registered_endpoint_proximity");
    } else {
      addJunction(cluster);
    }
  }

  const decisions: SheetTopologyPrimitiveDecisionV1[] = [];
  for (const primitive of candidates) {
    const canonicalId = canonicalById.get(primitive.primitive_id)!;
    if (canonicalId !== primitive.primitive_id) {
      decisions.push({ primitive_id: primitive.primitive_id, canonical_primitive_id: canonicalId, decision: "duplicate", raw_confidence: 0, calibrated_precision_lower_bound: null, calibration_trials: 0, calibration_fixtures: 0, reasons: ["overlapping_view_duplicate"] });
      continue;
    }
    const view = views.get(primitive.source_view_key)!;
    const raw = Math.min(primitive.confidence.geometry, primitive.confidence.classification, primitive.confidence.topology, primitive.confidence.visibility, view.registration.confidence);
    const calibration = calibrationFor(context.calibration_profile, view.discipline, primitive.kind, raw);
    const reasons: string[] = [];
    if (!view.registration.verified) reasons.push("registration_not_verified");
    if (view.registration.maximum_residual_ft > policy.maximum_registration_residual_ft) reasons.push("registration_residual_exceeded");
    if (primitive.confidence.geometry < policy.minimum_geometry_confidence) reasons.push("geometry_confidence_below_threshold");
    if (calibration.trials < policy.minimum_calibration_trials || calibration.lower === null) reasons.push("calibration_support_insufficient");
    if (calibration.fixtures < policy.minimum_calibration_fixtures) reasons.push("calibration_fixture_diversity_insufficient");
    if (!primitive.independently_reversible) reasons.push("primitive_not_independently_reversible");
    if ((primitive.kind === "route_segment" || primitive.kind === "wall_segment") && !isOrthogonal(primitive.points, policy.orthogonal_angle_tolerance_degrees)) reasons.push("not_straight_orthogonal_segment");
    const unresolvedClaims = requiredClaims(primitive, view.discipline).filter(key => !claimResolved(primitive.claims?.[key]));
    if (unresolvedClaims.length > 0) reasons.push(`material_claims_unresolved:${unresolvedClaims.join(",")}`);
    const primitiveEndpointKeys = (primitive.endpoints ?? []).map(endpoint => endpoint.endpoint_key);
    const hasConflict = conflicts.some(entry =>
      entry.includes(`:${primitive.primitive_id}:`)
      || entry.endsWith(`:${primitive.primitive_id}`)
      || primitiveEndpointKeys.some(endpointKey => entry.includes(endpointKey))
    );
    if (hasConflict) reasons.push("topology_conflict_present");
    const eligibleBatchKind = primitive.kind === "route_segment" || primitive.kind === "wall_segment";
    const canBatch = eligibleBatchKind && reasons.length === 0 && calibration.lower! >= policy.minimum_batch_precision_lower_bound;
    const canSingle = view.registration.verified
      && view.registration.maximum_residual_ft <= policy.maximum_registration_residual_ft
      && primitive.confidence.geometry >= policy.minimum_geometry_confidence
      && calibration.trials >= policy.minimum_calibration_trials
      && calibration.fixtures >= policy.minimum_calibration_fixtures
      && calibration.lower !== null
      && calibration.lower >= policy.minimum_single_action_precision_lower_bound;
    const decision = canBatch ? "native_batch" : canSingle ? "single_action" : "deferred";
    if (!canBatch && canSingle && calibration.lower! < policy.minimum_batch_precision_lower_bound) reasons.push("calibrated_precision_below_batch_threshold");
    decisions.push({
      primitive_id: primitive.primitive_id,
      canonical_primitive_id: canonicalId,
      decision,
      raw_confidence: raw,
      calibrated_precision_lower_bound: calibration.lower,
      calibration_trials: calibration.trials,
      calibration_fixtures: calibration.fixtures,
      reasons: [...new Set(reasons)].sort()
    });
  }

  const componentByPrimitiveId: Record<string, string> = {};
  for (const id of canonicalIds) {
    const root = disjoint.find(id);
    const componentId = `component:${digest(root).slice(0, 16)}`;
    componentByPrimitiveId[id] = componentId;
  }
  for (const [id, canonicalId] of canonicalById) componentByPrimitiveId[id] = componentByPrimitiveId[canonicalId]!;

  const batchGroups = new Map<string, string[]>();
  for (const decision of decisions.filter(entry => entry.decision === "native_batch")) {
    const primitive = primitives.get(decision.primitive_id)!;
    const view = views.get(primitive.source_view_key)!;
    const key = `batch:${view.discipline}:${view.level_key}:${componentByPrimitiveId[primitive.primitive_id]}`;
    (batchGroups.get(key) ?? batchGroups.set(key, []).get(key)!).push(primitive.primitive_id);
  }
  const frontierEndpointKeys = [...endpoints.entries()]
    .filter(([key, value]) => canonicalById.get(value.primitive.primitive_id) === value.primitive.primitive_id && !connectedEndpointKeys.has(key) && value.endpoint.boundary !== "internal")
    .map(([key]) => key).sort();
  if (frontierEndpointKeys.length > 0) warnings.push(`unresolved_frontier_endpoints:${frontierEndpointKeys.length}`);

  const sourceMarkIdsByCanonicalPrimitive: Record<string, string[]> = {};
  for (const primitive of primitives.values()) {
    const canonicalId = canonicalById.get(primitive.primitive_id)!;
    const marks = new Set(sourceMarkIdsByCanonicalPrimitive[canonicalId] ?? []);
    primitive.source_mark_ids.forEach(markId => marks.add(markId));
    sourceMarkIdsByCanonicalPrimitive[canonicalId] = [...marks].sort();
  }

  const single = decisions.filter(entry => entry.decision === "single_action").map(entry => entry.primitive_id).sort();
  const deferred = decisions.filter(entry => entry.decision === "deferred").map(entry => entry.primitive_id).sort();
  const duplicates = decisions.filter(entry => entry.decision === "duplicate").map(entry => entry.primitive_id).sort();
  const status = conflicts.length > 0 && canonicalIds.length === deferred.length
    ? "blocked"
    : deferred.length > 0 || conflicts.length > 0 || single.length > 0 || frontierEndpointKeys.length > 0
      ? "partially_ready"
      : "ready";

  return {
    schema_version: 1,
    package_id: packageId,
    input_fingerprint_sha256: digest(input),
    calibration_profile_sha256: digest(context.calibration_profile),
    status,
    source_accounting_closure: input.source_marks.length === sourceMarkIds.size ? 1 : sourceMarkIds.size / input.source_marks.length,
    canonical_primitive_ids: canonicalIds,
    source_mark_ids_by_canonical_primitive: sourceMarkIdsByCanonicalPrimitive,
    connections: connections.sort((a, b) => a.connection_id.localeCompare(b.connection_id)),
    junctions: junctions.sort((a, b) => a.junction_id.localeCompare(b.junction_id)),
    component_by_primitive_id: componentByPrimitiveId,
    frontier_endpoint_keys: frontierEndpointKeys,
    decisions,
    native_batch_groups: [...batchGroups.entries()].map(([batch_key, primitive_ids]) => ({ batch_key, primitive_ids: primitive_ids.sort() })).sort((a, b) => a.batch_key.localeCompare(b.batch_key)),
    single_action_primitive_ids: single,
    deferred_primitive_ids: deferred,
    duplicate_primitive_ids: duplicates,
    conflicts: [...new Set(conflicts)].sort(),
    warnings: [...new Set(warnings)].sort()
  };
}
