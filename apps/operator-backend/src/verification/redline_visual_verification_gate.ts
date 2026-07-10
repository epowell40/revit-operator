export type RedlineVisualGateStatus = "pass" | "fail" | "uncertain";

export type RedlineVisualGateActionType =
  | "duct_route"
  | "pipe_route"
  | "device_placement"
  | "text_note"
  | "resize_change"
  | "unknown";

export type RedlineVisualGateAuthority =
  | "deterministic_geometry"
  | "openai_vision"
  | "gemini_vision"
  | "hybrid";

export type RedlineVisualGatePoint = { x: number; y: number };

export type RedlineVisualGateAssertion = {
  name: string;
  status: RedlineVisualGateStatus;
  expected?: unknown;
  observed?: unknown;
  reason: string;
};

export type RedlineVisualGateLandmarkRelationship = {
  landmark: string;
  relation: string;
  status: RedlineVisualGateStatus;
  reason: string;
};

export type RedlineVisualGateInput = {
  action_type: RedlineVisualGateActionType;
  authority: RedlineVisualGateAuthority;
  redline_path?: string;
  before_capture_path?: string;
  after_capture_path?: string;
  after_capture_width_px?: number | null;
  after_capture_height_px?: number | null;
  after_capture_focus_crop?: {
    requested?: boolean;
    applied?: boolean;
  };
  visible_element_inventory?: unknown;
  intended_action?: Record<string, unknown>;
  intended_location?: string;
  observed_location?: string;
  intended_points?: RedlineVisualGatePoint[];
  actual_points?: RedlineVisualGatePoint[];
  model_write_required?: boolean;
  created_element_ids?: number[];
  created_fitting_ids?: number[];
  max_error_ft?: number | null;
  tolerance_ft?: number | null;
  deterministic_assertions?: RedlineVisualGateAssertion[];
  landmark_relationships?: RedlineVisualGateLandmarkRelationship[];
  vision_review?: {
    provider: "openai" | "gemini" | "none";
    status: RedlineVisualGateStatus;
    confidence?: number;
    reason: string;
  };
};

export type RedlineVisualGateResult = {
  status: RedlineVisualGateStatus;
  action_type: RedlineVisualGateActionType;
  authority: RedlineVisualGateAuthority;
  confidence: number;
  reason: string;
  evidence: {
    redline_path?: string;
    before_capture_path?: string;
    after_capture_path?: string;
    after_capture_quality?: {
      width_px?: number;
      height_px?: number;
      focus_crop?: {
        requested?: boolean;
        applied?: boolean;
      };
    };
    visible_element_inventory?: unknown;
  };
  intended_location?: string;
  observed_location?: string;
  intended_points?: RedlineVisualGatePoint[];
  actual_points?: RedlineVisualGatePoint[];
  model_write_required?: boolean;
  created_element_ids?: number[];
  created_fitting_ids?: number[];
  max_error_ft?: number | null;
  tolerance_ft?: number | null;
  landmark_relationships: RedlineVisualGateLandmarkRelationship[];
  assertions: RedlineVisualGateAssertion[];
  vision_review?: RedlineVisualGateInput["vision_review"];
};

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function textOf(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function finiteNumber(value: unknown): number | null {
  const n = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  return Number.isFinite(n) ? n : null;
}

function boolOf(value: unknown): boolean | undefined {
  if (typeof value === "boolean") return value;
  const text = textOf(value).toLowerCase();
  if (["true", "1", "yes", "y", "on"].includes(text)) return true;
  if (["false", "0", "no", "n", "off"].includes(text)) return false;
  return undefined;
}

function normalizeStatus(value: unknown, fallback: RedlineVisualGateStatus = "uncertain"): RedlineVisualGateStatus {
  const text = textOf(value).toLowerCase();
  return text === "pass" || text === "fail" || text === "uncertain" ? text : fallback;
}

function normalizeActionType(value: unknown): RedlineVisualGateActionType {
  const text = textOf(value).toLowerCase();
  return (
    text === "duct_route" ||
    text === "pipe_route" ||
    text === "device_placement" ||
    text === "text_note" ||
    text === "resize_change"
  ) ? text : "unknown";
}

function normalizeAuthority(value: unknown): RedlineVisualGateAuthority {
  const text = textOf(value).toLowerCase();
  return (
    text === "deterministic_geometry" ||
    text === "openai_vision" ||
    text === "gemini_vision" ||
    text === "hybrid"
  ) ? text : "hybrid";
}

function normalizePoint(value: unknown): RedlineVisualGatePoint | null {
  const obj = asRecord(value);
  if (!obj) return null;
  const x = finiteNumber(obj.x);
  const y = finiteNumber(obj.y);
  if (x === null || y === null) return null;
  return { x, y };
}

function normalizePoints(value: unknown): RedlineVisualGatePoint[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const points = value.map(normalizePoint).filter((point): point is RedlineVisualGatePoint => !!point);
  return points.length > 0 ? points : undefined;
}

function normalizeIdArray(value: unknown): number[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const ids = value
    .map(finiteNumber)
    .filter((id): id is number => id !== null && Number.isFinite(id))
    .map(id => Math.trunc(id))
    .filter(id => id > 0);
  return ids.length > 0 ? Array.from(new Set(ids)) : undefined;
}

function normalizeFocusCrop(value: unknown): RedlineVisualGateInput["after_capture_focus_crop"] | undefined {
  const obj = asRecord(value);
  if (!obj) return undefined;
  const requested = boolOf(obj.requested ?? obj.requestedFocusCrop ?? obj.focusRequested);
  const applied = boolOf(obj.applied ?? obj.wasApplied ?? obj.focusApplied);
  if (requested === undefined && applied === undefined) return undefined;
  return {
    ...(requested !== undefined ? { requested } : {}),
    ...(applied !== undefined ? { applied } : {})
  };
}

function normalizeAssertion(value: unknown): RedlineVisualGateAssertion | null {
  const obj = asRecord(value);
  if (!obj) return null;
  const name = textOf(obj.name);
  const reason = textOf(obj.reason);
  if (!name || !reason) return null;
  return {
    name,
    status: normalizeStatus(obj.status),
    ...(obj.expected !== undefined ? { expected: obj.expected } : {}),
    ...(obj.observed !== undefined ? { observed: obj.observed } : {}),
    reason
  };
}

function normalizeRelationship(value: unknown): RedlineVisualGateLandmarkRelationship | null {
  const obj = asRecord(value);
  if (!obj) return null;
  const landmark = textOf(obj.landmark);
  const relation = textOf(obj.relation);
  const reason = textOf(obj.reason);
  if (!landmark || !relation || !reason) return null;
  return {
    landmark,
    relation,
    status: normalizeStatus(obj.status),
    reason
  };
}

export function normalizeRedlineVisualVerificationGateInput(value: unknown): RedlineVisualGateInput {
  const obj = asRecord(value) ?? {};
  const afterCapture = asRecord(obj.after_capture ?? obj.afterCapture ?? obj.capture ?? obj.image) ?? {};
  const afterImage = asRecord(afterCapture.image) ?? {};
  const focusCrop = normalizeFocusCrop(obj.after_capture_focus_crop ?? obj.afterCaptureFocusCrop ?? afterCapture.focusCrop ?? afterCapture.focus_crop);
  const width = finiteNumber(obj.after_capture_width_px ?? obj.afterCaptureWidthPx ?? afterCapture.widthPx ?? afterCapture.width ?? afterCapture.imageWidth ?? afterImage.widthPx ?? afterImage.width);
  const height = finiteNumber(obj.after_capture_height_px ?? obj.afterCaptureHeightPx ?? afterCapture.heightPx ?? afterCapture.height ?? afterCapture.imageHeight ?? afterImage.heightPx ?? afterImage.height);
  const visionRaw = asRecord(obj.vision_review ?? obj.visionReview);
  const provider = textOf(visionRaw?.provider).toLowerCase();
  const visionProvider = provider === "openai" || provider === "gemini" || provider === "none" ? provider : "none";
  const visionReview = visionRaw
    ? {
        provider: visionProvider,
        status: normalizeStatus(visionRaw.status, "uncertain"),
        ...(finiteNumber(visionRaw.confidence) !== null ? { confidence: finiteNumber(visionRaw.confidence)! } : {}),
        reason: textOf(visionRaw.reason) || "Vision review did not provide a reason."
      } satisfies NonNullable<RedlineVisualGateInput["vision_review"]>
    : undefined;
  const deterministicAssertionsRaw = obj.deterministic_assertions ?? obj.deterministicAssertions;
  const relationshipsRaw = obj.landmark_relationships ?? obj.landmarkRelationships;

  return {
    action_type: normalizeActionType(obj.action_type ?? obj.actionType),
    authority: normalizeAuthority(obj.authority),
    ...(textOf(obj.redline_path ?? obj.redlinePath) ? { redline_path: textOf(obj.redline_path ?? obj.redlinePath) } : {}),
    ...(textOf(obj.before_capture_path ?? obj.beforeCapturePath) ? { before_capture_path: textOf(obj.before_capture_path ?? obj.beforeCapturePath) } : {}),
    ...(textOf(obj.after_capture_path ?? obj.afterCapturePath) ? { after_capture_path: textOf(obj.after_capture_path ?? obj.afterCapturePath) } : {}),
    ...(width !== null ? { after_capture_width_px: width } : {}),
    ...(height !== null ? { after_capture_height_px: height } : {}),
    ...(focusCrop ? { after_capture_focus_crop: focusCrop } : {}),
    ...(obj.visible_element_inventory !== undefined || obj.visibleElementInventory !== undefined ? { visible_element_inventory: obj.visible_element_inventory ?? obj.visibleElementInventory } : {}),
    ...(asRecord(obj.intended_action ?? obj.intendedAction) ? { intended_action: asRecord(obj.intended_action ?? obj.intendedAction)! } : {}),
    ...(textOf(obj.intended_location ?? obj.intendedLocation) ? { intended_location: textOf(obj.intended_location ?? obj.intendedLocation) } : {}),
    ...(textOf(obj.observed_location ?? obj.observedLocation) ? { observed_location: textOf(obj.observed_location ?? obj.observedLocation) } : {}),
    ...(normalizePoints(obj.intended_points ?? obj.intendedPoints) ? { intended_points: normalizePoints(obj.intended_points ?? obj.intendedPoints)! } : {}),
    ...(normalizePoints(obj.actual_points ?? obj.actualPoints) ? { actual_points: normalizePoints(obj.actual_points ?? obj.actualPoints)! } : {}),
    ...((obj.model_write_required ?? obj.modelWriteRequired) === true ? { model_write_required: true } : {}),
    ...(normalizeIdArray(obj.created_element_ids ?? obj.createdElementIds) ? { created_element_ids: normalizeIdArray(obj.created_element_ids ?? obj.createdElementIds)! } : {}),
    ...(normalizeIdArray(obj.created_fitting_ids ?? obj.createdFittingIds) ? { created_fitting_ids: normalizeIdArray(obj.created_fitting_ids ?? obj.createdFittingIds)! } : {}),
    ...(finiteNumber(obj.max_error_ft ?? obj.maxErrorFt) !== null ? { max_error_ft: finiteNumber(obj.max_error_ft ?? obj.maxErrorFt)! } : {}),
    ...(finiteNumber(obj.tolerance_ft ?? obj.toleranceFt) !== null ? { tolerance_ft: finiteNumber(obj.tolerance_ft ?? obj.toleranceFt)! } : {}),
    ...(Array.isArray(deterministicAssertionsRaw)
      ? { deterministic_assertions: deterministicAssertionsRaw.map(normalizeAssertion).filter((entry): entry is RedlineVisualGateAssertion => !!entry) }
      : {}),
    ...(Array.isArray(relationshipsRaw)
      ? { landmark_relationships: relationshipsRaw.map(normalizeRelationship).filter((entry): entry is RedlineVisualGateLandmarkRelationship => !!entry) }
      : {}),
    ...(visionReview ? { vision_review: visionReview } : {})
  };
}

function pointCountMatches(input: RedlineVisualGateInput): RedlineVisualGateAssertion | null {
  if (!input.intended_points || !input.actual_points) return null;
  return {
    name: "point_count_matches",
    status: input.intended_points.length === input.actual_points.length ? "pass" : "fail",
    expected: input.intended_points.length,
    observed: input.actual_points.length,
    reason: input.intended_points.length === input.actual_points.length
      ? "Actual route point count matches intended route point count."
      : "Actual route point count does not match intended route point count."
  };
}

function endpointErrorWithinTolerance(input: RedlineVisualGateInput): RedlineVisualGateAssertion | null {
  const maxError = finiteNumber(input.max_error_ft);
  const tolerance = finiteNumber(input.tolerance_ft);
  if (maxError === null || tolerance === null) return null;
  return {
    name: "endpoint_error_within_tolerance",
    status: maxError <= tolerance ? "pass" : "fail",
    expected: { max_error_ft_lte: tolerance },
    observed: { max_error_ft: maxError },
    reason: maxError <= tolerance
      ? "Created geometry is within endpoint/centerline tolerance."
      : "Created geometry is outside endpoint/centerline tolerance."
  };
}

function afterCapturePresent(input: RedlineVisualGateInput): RedlineVisualGateAssertion {
  const ok = !!input.after_capture_path?.trim();
  return {
    name: "post_change_capture_present",
    status: ok ? "pass" : "uncertain",
    expected: "post-change highlighted capture path",
    observed: input.after_capture_path || null,
    reason: ok
      ? "A post-change highlighted capture is available for review."
      : "No post-change highlighted capture is available, so visual verification is incomplete."
  };
}

function afterCaptureDiffersFromBefore(input: RedlineVisualGateInput): RedlineVisualGateAssertion | null {
  const before = input.before_capture_path?.trim();
  const after = input.after_capture_path?.trim();
  if (!before || !after) return null;
  const ok = before.toLowerCase() !== after.toLowerCase();
  return {
    name: "post_change_capture_differs_from_before",
    status: ok ? "pass" : "fail",
    expected: "distinct before and post-change capture paths",
    observed: {
      before_capture_path: before,
      after_capture_path: after
    },
    reason: ok
      ? "Before and post-change captures are distinct artifacts."
      : "Post-change visual verification reused the before-capture artifact, so it cannot prove the modeled redline is visible after the write."
  };
}

function afterCaptureQualityOk(input: RedlineVisualGateInput, minDimensionPx = 512): RedlineVisualGateAssertion | null {
  const width = finiteNumber(input.after_capture_width_px);
  const height = finiteNumber(input.after_capture_height_px);
  const focusCrop = input.after_capture_focus_crop;
  const hasQualityEvidence = width !== null || height !== null || focusCrop?.requested !== undefined || focusCrop?.applied !== undefined;
  if (!hasQualityEvidence) return null;
  const dimensionOk = (width === null || width >= minDimensionPx) && (height === null || height >= minDimensionPx);
  const focusOk = focusCrop?.requested === true ? focusCrop.applied === true : true;
  const ok = dimensionOk && focusOk;
  return {
    name: "post_change_capture_quality_ok",
    status: ok ? "pass" : "fail",
    expected: {
      min_dimension_px_when_reported: minDimensionPx,
      requested_focus_crop_applied: true
    },
    observed: {
      ...(width !== null ? { width_px: width } : {}),
      ...(height !== null ? { height_px: height } : {}),
      ...(focusCrop ? { focus_crop: focusCrop } : {})
    },
    reason: ok
      ? "Post-change capture quality metadata is sufficient for visual review."
      : "Post-change capture quality metadata is insufficient: reported dimensions must be at least 512 px and requested focus crops must be applied."
  };
}

function modelWriteEvidencePresent(input: RedlineVisualGateInput): RedlineVisualGateAssertion | null {
  if (!input.model_write_required) return null;
  const createdIds = [...(input.created_element_ids ?? []), ...(input.created_fitting_ids ?? [])].filter(id => Number.isFinite(id) && id > 0);
  const ok = createdIds.length > 0;
  return {
    name: "model_write_evidence_present",
    status: ok ? "pass" : "fail",
    expected: "created model element or fitting id",
    observed: {
      created_element_ids: input.created_element_ids ?? [],
      created_fitting_ids: input.created_fitting_ids ?? []
    },
    reason: ok
      ? "Created model element/fitting IDs are present for the modeled redline write."
      : "Modeled redline completion requires created model element/fitting IDs, but none were provided."
  };
}

function routeSegmentWriteEvidenceMatches(input: RedlineVisualGateInput): RedlineVisualGateAssertion | null {
  if (!input.model_write_required) return null;
  if (input.action_type !== "duct_route" && input.action_type !== "pipe_route") return null;
  const pointCount = Math.max(input.intended_points?.length ?? 0, input.actual_points?.length ?? 0);
  if (pointCount < 2) return null;

  const expectedSegmentCount = pointCount - 1;
  const createdSegmentIds = (input.created_element_ids ?? []).filter(id => Number.isFinite(id) && id > 0);
  const ok = createdSegmentIds.length >= expectedSegmentCount;
  return {
    name: "route_segment_write_evidence_matches",
    status: ok ? "pass" : "fail",
    expected: { min_created_route_element_ids: expectedSegmentCount },
    observed: {
      created_element_ids: createdSegmentIds,
      created_fitting_ids: input.created_fitting_ids ?? []
    },
    reason: ok
      ? "Created route element IDs cover each requested route segment."
      : "Modeled duct/pipe redline completion requires a created route element ID for each requested route segment; fitting IDs alone are not enough evidence."
  };
}

function aggregateStatus(assertions: RedlineVisualGateAssertion[], relationships: RedlineVisualGateLandmarkRelationship[], visionStatus?: RedlineVisualGateStatus): RedlineVisualGateStatus {
  const statuses = [
    ...assertions.map(a => a.status),
    ...relationships.map(r => r.status),
    ...(visionStatus ? [visionStatus] : [])
  ];
  if (statuses.some(s => s === "fail")) return "fail";
  if (statuses.length === 0 || statuses.some(s => s === "uncertain")) return "uncertain";
  return "pass";
}

function confidenceFor(status: RedlineVisualGateStatus, assertions: RedlineVisualGateAssertion[], relationships: RedlineVisualGateLandmarkRelationship[], visionConfidence?: number): number {
  if (status === "fail") return 0.95;
  if (status === "uncertain") return 0.35;
  const base = relationships.length > 0 ? 0.9 : 0.82;
  const assertionPenalty = assertions.some(a => a.status !== "pass") ? 0.25 : 0;
  const vision = finiteNumber(visionConfidence);
  return Math.max(0, Math.min(1, vision === null ? base - assertionPenalty : Math.min(base, vision)));
}

export function evaluateRedlineVisualVerificationGate(input: RedlineVisualGateInput): RedlineVisualGateResult {
  const assertions = [
    afterCapturePresent(input),
    afterCaptureDiffersFromBefore(input),
    afterCaptureQualityOk(input),
    modelWriteEvidencePresent(input),
    routeSegmentWriteEvidenceMatches(input),
    pointCountMatches(input),
    endpointErrorWithinTolerance(input),
    ...(Array.isArray(input.deterministic_assertions) ? input.deterministic_assertions : [])
  ].filter((entry): entry is RedlineVisualGateAssertion => !!entry);
  const relationships = Array.isArray(input.landmark_relationships) ? input.landmark_relationships : [];
  const visionStatus = input.vision_review?.provider && input.vision_review.provider !== "none"
    ? input.vision_review.status
    : undefined;
  const status = aggregateStatus(assertions, relationships, visionStatus);
  const failed = [...assertions, ...relationships].find(entry => entry.status === "fail");
  const uncertain = [...assertions, ...relationships].find(entry => entry.status === "uncertain");
  const reason = failed
    ? failed.reason
    : uncertain
      ? uncertain.reason
      : input.vision_review?.provider && input.vision_review.provider !== "none"
        ? input.vision_review.reason
        : "Deterministic geometry and post-change visual evidence satisfy the redline verification gate.";

  return {
    status,
    action_type: input.action_type,
    authority: input.authority,
    confidence: confidenceFor(status, assertions, relationships, input.vision_review?.confidence),
    reason,
    evidence: {
      ...(input.redline_path ? { redline_path: input.redline_path } : {}),
      ...(input.before_capture_path ? { before_capture_path: input.before_capture_path } : {}),
      ...(input.after_capture_path ? { after_capture_path: input.after_capture_path } : {}),
      ...(input.after_capture_width_px !== undefined || input.after_capture_height_px !== undefined || input.after_capture_focus_crop !== undefined ? {
        after_capture_quality: {
          ...(input.after_capture_width_px !== undefined && input.after_capture_width_px !== null ? { width_px: input.after_capture_width_px } : {}),
          ...(input.after_capture_height_px !== undefined && input.after_capture_height_px !== null ? { height_px: input.after_capture_height_px } : {}),
          ...(input.after_capture_focus_crop ? { focus_crop: input.after_capture_focus_crop } : {})
        }
      } : {}),
      ...(input.visible_element_inventory !== undefined ? { visible_element_inventory: input.visible_element_inventory } : {})
    },
    ...(input.intended_location ? { intended_location: input.intended_location } : {}),
    ...(input.observed_location ? { observed_location: input.observed_location } : {}),
    ...(input.intended_points ? { intended_points: input.intended_points } : {}),
    ...(input.actual_points ? { actual_points: input.actual_points } : {}),
    ...(input.model_write_required !== undefined ? { model_write_required: input.model_write_required } : {}),
    ...(input.created_element_ids ? { created_element_ids: input.created_element_ids } : {}),
    ...(input.created_fitting_ids ? { created_fitting_ids: input.created_fitting_ids } : {}),
    ...(input.max_error_ft !== undefined ? { max_error_ft: input.max_error_ft } : {}),
    ...(input.tolerance_ft !== undefined ? { tolerance_ft: input.tolerance_ft } : {}),
    landmark_relationships: relationships,
    assertions,
    ...(input.vision_review ? { vision_review: input.vision_review } : {})
  };
}
