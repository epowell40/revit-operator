import crypto from "node:crypto";
import {
  solveExistingConditionsRegistration,
  type ExistingConditionsPlanPoint,
  type ExistingConditionsRegistrationInput
} from "./registration.js";
import type { ExistingConditionsAmbiguity } from "./controller.js";
import {
  validatePlanTraceSourceAccountingV1,
  type PlanTraceSourceAccountingContext,
  type PlanTraceSourceAccountingInputV1
} from "./plan_trace_source_accounting.js";
import type { CompiledMepDraftPlan, MepDraftAction } from "./mep_draft_plan.js";

type Bounds2d = {
  min: ExistingConditionsPlanPoint;
  max: ExistingConditionsPlanPoint;
};

export type ProvisionalPlanTraceDraftInputV1 = {
  schema_version: 1;
  fixture_id: string;
  scope_id: string;
  source_pdf_sha256: string;
  visible_evidence: Array<{ role: string; sha256: string }>;
  registered_render: {
    evidence_role: string;
    sha256: string;
    width_px: number;
    height_px: number;
    access_scope: "agent_visible";
  };
  frame_reference: {
    evidence_role: string;
    evidence_sha256: string;
  };
  registration: ExistingConditionsRegistrationInput;
  source_accounting: PlanTraceSourceAccountingInputV1;
  expected_source_contract_sha256: string;
  expected_source_geometry_sha256: string;
  expected_draft_candidate_fingerprint_sha256: string;
  level_name: string;
  level_elevation_ft: number;
  view_reference: {
    reference_key: string;
    element_id: number;
    category: string;
    role: string;
    evidence_role: string;
    evidence_sha256: string;
  };
  view_type: "FloorPlan" | "EngineeringPlan" | "CeilingPlan";
  explicit_unscored_user_direction: true;
  user_direction_reference: string;
  maximum_created_elements?: number;
};

export type ProvisionalPlanTraceDraftContext = {
  source_accounting: PlanTraceSourceAccountingContext;
  registered_frame_receipt: {
    schema_version: 1;
    evidence_kind: "registered_render_to_model_frame";
    fixture_id: string;
    scope_id: string;
    source_pdf_sha256: string;
    registered_render_sha256: string;
    width_px: number;
    height_px: number;
    coordinate_space: "registered_render_pixels_top_left";
    model_bounds: Bounds2d;
    registration_receipt_sha256: string;
    access_scope: "agent_visible";
  };
  native_view_inventory: {
    schema_version: 1;
    evidence_kind: "native_view_inventory";
    fixture_id: string;
    scope_id: string;
    access_scope: "agent_visible";
    views: Array<{
      reference_key: string;
      element_id: number;
      category: string;
      role: string;
      view_type: "FloorPlan" | "EngineeringPlan" | "CeilingPlan";
      level_name: string;
      level_elevation_ft: number;
    }>;
  };
};

function clean(value: unknown): string {
  return String(value ?? "").trim();
}

function normalized(value: unknown): string {
  return clean(value).toLowerCase().replace(/[\s_-]+/g, " ");
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

function finite(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`${label}_must_be_finite`);
  return value;
}

function positiveInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || Number(value) <= 0) throw new Error(`${label}_must_be_positive_integer`);
  return Number(value);
}

function point(value: ExistingConditionsPlanPoint, label: string): ExistingConditionsPlanPoint {
  if (!value || typeof value !== "object") throw new Error(`${label}_is_required`);
  return {
    x: finite(value.x, `${label}_x`),
    y: finite(value.y, `${label}_y`)
  };
}

function bounds(value: Bounds2d, label: string): Bounds2d {
  if (!value || typeof value !== "object") throw new Error(`${label}_is_required`);
  const min = point(value.min, `${label}_min`);
  const max = point(value.max, `${label}_max`);
  if (max.x <= min.x || max.y <= min.y) throw new Error(`${label}_must_have_positive_extent`);
  return { min, max };
}

function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${canonical(object[key])}`).join(",")}}`;
}

function fingerprint(value: unknown): string {
  return crypto.createHash("sha256").update(canonical(value)).digest("hex");
}

export function provisionalPlanTraceEvidenceSha256(value: unknown): string {
  return fingerprint(value);
}

function pixelToModel(
  pixel: ExistingConditionsPlanPoint,
  modelBounds: Bounds2d,
  width: number,
  height: number
): ExistingConditionsPlanPoint {
  return {
    x: modelBounds.min.x + pixel.x / width * (modelBounds.max.x - modelBounds.min.x),
    y: modelBounds.max.y - pixel.y / height * (modelBounds.max.y - modelBounds.min.y)
  };
}

export function compileProvisionalPlanTraceDraftV1(
  input: ProvisionalPlanTraceDraftInputV1,
  context: ProvisionalPlanTraceDraftContext
): CompiledMepDraftPlan {
  if (!input || input.schema_version !== 1) throw new Error("provisional_plan_trace_draft_requires_schema_v1");
  const fixtureId = requiredText(input.fixture_id, "provisional_plan_trace_fixture_id");
  const scopeId = requiredText(input.scope_id, "provisional_plan_trace_scope_id");
  const sourcePdfHash = sha256(input.source_pdf_sha256, "provisional_plan_trace_source_pdf_sha256");
  if (!Array.isArray(input.visible_evidence) || input.visible_evidence.length === 0) {
    throw new Error("provisional_plan_trace_visible_evidence_is_required");
  }
  const visibleEvidence = input.visible_evidence.map((entry, index) => ({
    role: requiredText(entry.role, `provisional_plan_trace_visible_evidence_${index}_role`),
    sha256: sha256(entry.sha256, `provisional_plan_trace_visible_evidence_${index}_sha256`)
  }));
  const evidenceByRole = new Map(visibleEvidence.map((entry) => [normalized(entry.role), entry.sha256]));
  if (evidenceByRole.size !== visibleEvidence.length) {
    throw new Error("provisional_plan_trace_visible_evidence_roles_must_be_unique");
  }
  if (evidenceByRole.get("source pdf") !== sourcePdfHash) {
    throw new Error("provisional_plan_trace_source_pdf_hash_mismatch");
  }

  const render = input.registered_render;
  if (!render || render.access_scope !== "agent_visible") {
    throw new Error("provisional_plan_trace_render_must_be_agent_visible");
  }
  const renderRole = requiredText(render.evidence_role, "provisional_plan_trace_render_evidence_role");
  if (/ground\s*truth|evaluator|withheld/i.test(renderRole)) {
    throw new Error("provisional_plan_trace_render_evidence_role_forbidden");
  }
  const renderHash = sha256(render.sha256, "provisional_plan_trace_render_sha256");
  const width = positiveInteger(render.width_px, "provisional_plan_trace_render_width_px");
  const height = positiveInteger(render.height_px, "provisional_plan_trace_render_height_px");
  if (evidenceByRole.get(normalized(renderRole)) !== renderHash) {
    throw new Error("provisional_plan_trace_render_visible_evidence_hash_mismatch");
  }

  const levelName = requiredText(input.level_name, "provisional_plan_trace_level_name");
  const levelElevationFt = finite(input.level_elevation_ft, "provisional_plan_trace_level_elevation_ft");
  if (!["FloorPlan", "EngineeringPlan", "CeilingPlan"].includes(input.view_type)) {
    throw new Error("provisional_plan_trace_view_type_invalid");
  }
  if (input.explicit_unscored_user_direction !== true) {
    throw new Error("provisional_plan_trace_requires_explicit_unscored_user_direction");
  }
  requiredText(input.user_direction_reference, "provisional_plan_trace_user_direction_reference");

  if (input.source_accounting.scope_id !== scopeId) {
    throw new Error("provisional_plan_trace_accounting_scope_mismatch");
  }
  if (sha256(input.source_accounting.source_image_sha256, "provisional_plan_trace_accounting_source_sha256") !== renderHash) {
    throw new Error("provisional_plan_trace_accounting_render_hash_mismatch");
  }
  if (!context?.source_accounting || !Array.isArray(context.source_accounting.evidence_sets)) {
    throw new Error("provisional_plan_trace_source_accounting_context_is_required");
  }
  for (const [index, evidenceSet] of context.source_accounting.evidence_sets.entries()) {
    if (evidenceSet.receipt.width_px !== width || evidenceSet.receipt.height_px !== height) {
      throw new Error(`provisional_plan_trace_accounting_frame_mismatch:${index}`);
    }
  }
  const accounting = validatePlanTraceSourceAccountingV1(input.source_accounting, context.source_accounting);
  if (sha256(input.expected_source_contract_sha256, "expected_source_contract_sha256") !== accounting.source_contract_sha256) {
    throw new Error("provisional_plan_trace_source_contract_fingerprint_mismatch");
  }
  if (sha256(input.expected_source_geometry_sha256, "expected_source_geometry_sha256") !== accounting.source_geometry_sha256) {
    throw new Error("provisional_plan_trace_source_geometry_fingerprint_mismatch");
  }
  if (sha256(input.expected_draft_candidate_fingerprint_sha256, "expected_draft_candidate_fingerprint_sha256")
    !== accounting.draft_candidate_fingerprint_sha256) {
    throw new Error("provisional_plan_trace_draft_candidate_fingerprint_mismatch");
  }

  const registration = solveExistingConditionsRegistration(input.registration);
  if (!registration.verified) throw new Error("provisional_plan_trace_registration_not_verified");
  if (registration.source_evidence_sha256 !== sourcePdfHash) {
    throw new Error("provisional_plan_trace_registration_source_hash_mismatch");
  }

  const frameReference = input.frame_reference;
  if (!frameReference || typeof frameReference !== "object") {
    throw new Error("provisional_plan_trace_frame_reference_is_required");
  }
  const frameEvidenceRole = requiredText(
    frameReference.evidence_role,
    "provisional_plan_trace_frame_evidence_role"
  );
  const frameEvidenceHash = sha256(
    frameReference.evidence_sha256,
    "provisional_plan_trace_frame_evidence_sha256"
  );
  if (evidenceByRole.get(normalized(frameEvidenceRole)) !== frameEvidenceHash) {
    throw new Error("provisional_plan_trace_frame_evidence_hash_mismatch");
  }
  if (["source pdf", normalized(renderRole)].includes(normalized(frameEvidenceRole))) {
    throw new Error("provisional_plan_trace_frame_requires_independent_evidence");
  }
  const frameReceipt = context?.registered_frame_receipt;
  if (!frameReceipt
    || frameReceipt.schema_version !== 1
    || frameReceipt.evidence_kind !== "registered_render_to_model_frame"
    || frameReceipt.access_scope !== "agent_visible") {
    throw new Error("provisional_plan_trace_registered_frame_receipt_is_required");
  }
  if (provisionalPlanTraceEvidenceSha256(frameReceipt) !== frameEvidenceHash) {
    throw new Error("provisional_plan_trace_registered_frame_receipt_hash_mismatch");
  }
  if (requiredText(frameReceipt.fixture_id, "provisional_plan_trace_frame_fixture_id") !== fixtureId
    || requiredText(frameReceipt.scope_id, "provisional_plan_trace_frame_scope_id") !== scopeId) {
    throw new Error("provisional_plan_trace_registered_frame_scope_mismatch");
  }
  if (sha256(frameReceipt.source_pdf_sha256, "provisional_plan_trace_frame_source_pdf_sha256") !== sourcePdfHash
    || sha256(frameReceipt.registered_render_sha256, "provisional_plan_trace_frame_render_sha256") !== renderHash) {
    throw new Error("provisional_plan_trace_registered_frame_source_relationship_mismatch");
  }
  if (frameReceipt.width_px !== width || frameReceipt.height_px !== height
    || frameReceipt.coordinate_space !== "registered_render_pixels_top_left") {
    throw new Error("provisional_plan_trace_registered_frame_render_mismatch");
  }
  if (sha256(
    frameReceipt.registration_receipt_sha256,
    "provisional_plan_trace_frame_registration_receipt_sha256"
  ) !== provisionalPlanTraceEvidenceSha256(registration)) {
    throw new Error("provisional_plan_trace_registered_frame_registration_mismatch");
  }
  const modelBounds = bounds(frameReceipt.model_bounds, "provisional_plan_trace_model_bounds");

  const viewReference = input.view_reference;
  if (!viewReference || typeof viewReference !== "object") {
    throw new Error("provisional_plan_trace_view_reference_is_required");
  }
  const viewReferenceKey = requiredText(viewReference.reference_key, "provisional_plan_trace_view_reference_key");
  const viewElementId = positiveInteger(viewReference.element_id, "provisional_plan_trace_view_element_id");
  const viewRole = requiredText(viewReference.role, "provisional_plan_trace_view_role");
  if (!new Set(["view", "ost views"]).has(normalized(viewReference.category))) {
    throw new Error("provisional_plan_trace_view_reference_category_mismatch");
  }
  const viewEvidenceRole = requiredText(viewReference.evidence_role, "provisional_plan_trace_view_evidence_role");
  const viewEvidenceHash = sha256(viewReference.evidence_sha256, "provisional_plan_trace_view_evidence_sha256");
  if (evidenceByRole.get(normalized(viewEvidenceRole)) !== viewEvidenceHash) {
    throw new Error("provisional_plan_trace_view_evidence_hash_mismatch");
  }
  if (["source pdf", normalized(renderRole), normalized(frameEvidenceRole)].includes(normalized(viewEvidenceRole))) {
    throw new Error("provisional_plan_trace_view_reference_requires_native_evidence");
  }
  const nativeViewInventory = context?.native_view_inventory;
  if (!nativeViewInventory
    || nativeViewInventory.schema_version !== 1
    || nativeViewInventory.evidence_kind !== "native_view_inventory"
    || nativeViewInventory.access_scope !== "agent_visible"
    || !Array.isArray(nativeViewInventory.views)
    || nativeViewInventory.views.length === 0
    || nativeViewInventory.views.length > 10_000) {
    throw new Error("provisional_plan_trace_native_view_inventory_is_required");
  }
  if (provisionalPlanTraceEvidenceSha256(nativeViewInventory) !== viewEvidenceHash) {
    throw new Error("provisional_plan_trace_native_view_inventory_hash_mismatch");
  }
  if (requiredText(nativeViewInventory.fixture_id, "provisional_plan_trace_view_inventory_fixture_id") !== fixtureId
    || requiredText(nativeViewInventory.scope_id, "provisional_plan_trace_view_inventory_scope_id") !== scopeId) {
    throw new Error("provisional_plan_trace_native_view_inventory_scope_mismatch");
  }
  const inventoryKeys = new Set<string>();
  for (const [index, view] of nativeViewInventory.views.entries()) {
    const key = requiredText(view.reference_key, `provisional_plan_trace_inventory_view_${index}_reference_key`);
    if (inventoryKeys.has(key)) throw new Error(`provisional_plan_trace_inventory_view_reference_duplicate:${key}`);
    inventoryKeys.add(key);
    positiveInteger(view.element_id, `provisional_plan_trace_inventory_view_${key}_element_id`);
    requiredText(view.category, `provisional_plan_trace_inventory_view_${key}_category`);
    requiredText(view.role, `provisional_plan_trace_inventory_view_${key}_role`);
    requiredText(view.level_name, `provisional_plan_trace_inventory_view_${key}_level_name`);
    finite(view.level_elevation_ft, `provisional_plan_trace_inventory_view_${key}_level_elevation_ft`);
    if (!["FloorPlan", "EngineeringPlan", "CeilingPlan"].includes(view.view_type)) {
      throw new Error(`provisional_plan_trace_inventory_view_${key}_type_invalid`);
    }
  }
  const inventoryView = nativeViewInventory.views.find((view) => view.reference_key === viewReferenceKey);
  if (!inventoryView
    || inventoryView.element_id !== viewElementId
    || normalized(inventoryView.category) !== normalized(viewReference.category)
    || normalized(inventoryView.role) !== normalized(viewRole)
    || inventoryView.view_type !== input.view_type
    || clean(inventoryView.level_name) !== levelName
    || Math.abs(inventoryView.level_elevation_ft - levelElevationFt) > 1e-9) {
    throw new Error("provisional_plan_trace_view_reference_inventory_mismatch");
  }

  const actions: MepDraftAction[] = accounting.draft_candidates.map((candidate) => {
    const curves: Array<{
      kind: "line";
      a: { xyz: [number, number, number] };
      b: { xyz: [number, number, number] };
    }> = [];
    for (const sourcePath of candidate.source_paths) {
      const points = sourcePath.points.map((entry) => pixelToModel(entry, modelBounds, width, height));
      for (let index = 1; index < points.length; index += 1) {
        const a = points[index - 1]!;
        const b = points[index]!;
        curves.push({
          kind: "line",
          a: { xyz: [a.x, a.y, levelElevationFt] },
          b: { xyz: [b.x, b.y, levelElevationFt] }
        });
      }
    }
    if (curves.length === 0) throw new Error(`provisional_plan_trace_candidate_has_no_segments:${candidate.candidate_id}`);
    const common = {
      viewId: viewElementId,
      curves,
      expectedViewType: input.view_type,
      expectedLevelName: levelName,
      projectToViewPlane: true
    };
    return {
      action_key: `trace:${candidate.candidate_id}`,
      observation_ids: [candidate.candidate_id],
      method: "POST",
      path: "/revit/draw-detail-curves",
      depends_on: [],
      dry_run_body: { ...common, dryRun: true },
      apply_body: { ...common, dryRun: false },
      expected_created_min: curves.length,
      expected_created_max: curves.length,
      provisional_plan_representation: {
        native_category: "OST_Lines",
        representation_role: "view_specific_plan_route_trace",
        source_observation_kind: "plan_trace_route_candidate",
        source_candidate_id: candidate.candidate_id,
        source_path_count: candidate.source_paths.length,
        continuity: candidate.continuity,
        modeled_element_created: false,
        modeled_device_created: false,
        modeled_route_created: false,
        native_medium_classified: false,
        benchmark_credit: false,
        complete_scope_credit: false
      }
    };
  });

  const maximumCreatedElements = input.maximum_created_elements == null
    ? 500
    : positiveInteger(input.maximum_created_elements, "provisional_plan_trace_maximum_created_elements");
  if (maximumCreatedElements > 500) {
    throw new Error("provisional_plan_trace_maximum_created_elements_must_not_exceed_500");
  }
  const expectedCreated = actions.reduce((sum, entry) => sum + entry.expected_created_max, 0);
  if (expectedCreated > maximumCreatedElements) {
    throw new Error(`provisional_plan_trace_creation_budget_exceeded:${expectedCreated}/${maximumCreatedElements}`);
  }

  const ambiguities: ExistingConditionsAmbiguity[] = accounting.preserved_unresolved_candidates.map((candidate) => ({
    id: `clarify:${candidate.candidate_id}`,
    topic: `${candidate.discipline} source trace geometry`,
    description: candidate.note,
    material: true,
    confidence: 0,
    choices: [],
    related_plan_keys: [candidate.candidate_id],
    material_attributes: ["route geometry role"],
    resolution: null,
    resolution_basis: null,
    resolution_evidence_reference: null
  }));
  const planFingerprint = fingerprint({
    input,
    source_contract_sha256: accounting.source_contract_sha256,
    source_geometry_sha256: accounting.source_geometry_sha256,
    draft_candidate_fingerprint_sha256: accounting.draft_candidate_fingerprint_sha256
  });
  const promotedIds = accounting.draft_candidates.map((candidate) => candidate.candidate_id);
  const deferredIds = accounting.preserved_unresolved_candidates.map((candidate) => candidate.candidate_id);
  const warnings = [
    "Plan-visible route geometry is emitted as view-specific DetailCurves only; no native pipe, duct, conduit, connector, system, size, type, elevation, or continuity-across-gap claim is made.",
    "Color is optional corroboration. The draft is bound to exact registered source paths and remains useful when the record document is black and white.",
    ...accounting.promotion_follow_up_items.map((item) => `${item.candidate_id}: ${item.question}`)
  ];

  return {
    schema_version: 1,
    status: actions.length > 0 ? "partially_ready" : "clarification_required",
    partial_promotion_policy: "defer_ambiguous_observations",
    promoted_observation_ids: promotedIds,
    deferred_observation_ids: deferredIds,
    provisional_observation_ids: promotedIds,
    fixture_id: fixtureId,
    scope_id: scopeId,
    input_fingerprint_sha256: planFingerprint,
    registration,
    source_observations: accounting.draft_candidates.map((candidate) => ({
      observation_id: candidate.candidate_id,
      evidence_role: renderRole,
      discipline: candidate.discipline,
      category: "OST_Lines",
      role: `provisional ${candidate.discipline} route trace`,
      visibility: "clear",
      confidence: 1,
      supported_attributes: ["location", "source path geometry", "provisional plan representation"]
    })),
    plan_elements: accounting.draft_candidates.map((candidate) => ({
      plan_key: candidate.candidate_id,
      discipline: candidate.discipline,
      category: "OST_Lines",
      role: `provisional ${candidate.discipline} route trace`,
      action: "create",
      confidence: 1,
      assumptions: [
        "view-specific DetailCurves only; no modeled MEP route is created",
        `source continuity is ${candidate.continuity.replaceAll("_", " ")}; separate source paths are not joined`,
        `native promotion remains pending for ${candidate.native_attributes_pending.join(", ")}`
      ],
      source_observation_ids: [candidate.candidate_id],
      required_source_attributes: ["location", "source path geometry", "provisional plan representation"]
    })),
    ambiguities,
    actions,
    blockers: [],
    warnings
  };
}
