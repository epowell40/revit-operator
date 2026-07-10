export type RedlineGraphicsOverrideLiveAdapterStatus =
  | "ready_for_live_dry_run"
  | "missing_live_inputs"
  | "needs_human_review"
  | "unsupported_operation";

export type RedlineGraphicsOverrideColor = {
  r: number;
  g: number;
  b: number;
};

export type RedlineGraphicsOverrideCreateFilter = {
  categoryName?: string;
  ruleParameterName?: string;
  ruleParameterStorageType?: "string" | "integer" | "double" | "element_id";
  ruleOperator?: string;
  ruleValue?: string;
  ruleValueElementId?: number;
  reviewed?: boolean;
};

export type RedlineGraphicsOverrideAction = {
  operation?: string;
  target?: string;
  viewId?: number;
  viewName?: string;
  sheetNumber?: string;
  categoryName?: string;
  filterId?: number;
  filterName?: string;
  filterVisible?: boolean;
  lineWeight?: number;
  color?: RedlineGraphicsOverrideColor;
  halftone?: boolean;
  requestedStyle?: string;
  createFilter?: RedlineGraphicsOverrideCreateFilter;
};

export type RedlineGraphicsOverrideEvidence = {
  viewId?: number;
  viewName?: string;
  categoryName?: string;
  filterId?: number;
  filterName?: string;
  dryRunPreflightReviewed?: boolean;
  beforeGraphicsReadbackPath?: string;
  afterGraphicsReadbackPath?: string;
  finalGraphicsReadbackPath?: string;
  postChangeCapturePath?: string;
  finalCapturePath?: string;
  appliedReadbackMatches?: boolean;
  revertReadbackMatches?: boolean;
  readyToRunOverride?: boolean;
};

export type RedlineGraphicsOverrideLiveAdapterOperation =
  | {
      path: "/revit/visibility";
      purpose: "visibility_dry_run" | "visibility_apply" | "visibility_revert";
      request: Record<string, unknown>;
    }
  | {
      path: "/revit/export-image";
      purpose: "before_visual_capture" | "after_visual_capture" | "final_visual_capture";
      request: Record<string, unknown>;
    };

export type RedlineGraphicsOverrideLiveAdapterReadiness = {
  status: RedlineGraphicsOverrideLiveAdapterStatus;
  ready_for_live_dry_run: boolean;
  ready_to_run: false;
  benchmark_task_id: "demo_documentation_primitives" | null;
  workflow: "documentation_primitives" | null;
  reasons: string[];
  missing_live_inputs: string[];
  required_evidence: string[];
  request_candidate?: {
    workflow: "documentation_primitives";
    request: Record<string, unknown>;
    ready_to_run: false;
    live_request_status: "needs_live_request_override";
    promotion_blockers: string[];
  };
  adapter_operations: RedlineGraphicsOverrideLiveAdapterOperation[];
};

function isPositiveInteger(value: unknown): value is number {
  return Number.isInteger(value) && Number(value) > 0;
}

function nonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function validColor(value: unknown): value is RedlineGraphicsOverrideColor {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  return ["r", "g", "b"].every((channel) => {
    const component = candidate[channel];
    return Number.isInteger(component) && Number(component) >= 0 && Number(component) <= 255;
  });
}

function hasRequestedOverride(action: RedlineGraphicsOverrideAction): boolean {
  return typeof action.lineWeight === "number" ||
    validColor(action.color) ||
    typeof action.halftone === "boolean" ||
    typeof action.filterVisible === "boolean" ||
    nonEmpty(action.requestedStyle);
}

function completeCreateFilter(createFilter: RedlineGraphicsOverrideCreateFilter | undefined): boolean {
  if (!Boolean(createFilter?.reviewed) ||
    !nonEmpty(createFilter?.categoryName) ||
    !nonEmpty(createFilter?.ruleParameterName) ||
    !nonEmpty(createFilter?.ruleOperator) ||
    !nonEmpty(createFilter?.ruleParameterStorageType)) {
    return false;
  }
  if (createFilter?.ruleParameterStorageType === "element_id") {
    return isPositiveInteger(createFilter.ruleValueElementId) || isPositiveInteger(Number(createFilter.ruleValue));
  }
  return nonEmpty(createFilter?.ruleValue);
}

function createFilterMissingInputs(createFilter: RedlineGraphicsOverrideCreateFilter | undefined): string[] {
  const missing: string[] = [];
  if (!Boolean(createFilter?.reviewed)) missing.push("reviewed_create_filter");
  if (!nonEmpty(createFilter?.categoryName)) missing.push("create_filter_category");
  if (!nonEmpty(createFilter?.ruleParameterName)) missing.push("create_filter_rule_parameter");
  if (!nonEmpty(createFilter?.ruleOperator)) missing.push("create_filter_rule_operator");
  if (!nonEmpty(createFilter?.ruleParameterStorageType)) missing.push("create_filter_rule_parameter_storage_type");
  if (createFilter?.ruleParameterStorageType === "element_id") {
    if (!isPositiveInteger(createFilter.ruleValueElementId) && !isPositiveInteger(Number(createFilter.ruleValue))) {
      missing.push("create_filter_rule_value_element_id");
    }
  } else if (!nonEmpty(createFilter?.ruleValue)) {
    missing.push("create_filter_rule_value");
  }
  return missing;
}

function buildCreateFilterForRequest(createFilter: RedlineGraphicsOverrideCreateFilter | undefined): RedlineGraphicsOverrideCreateFilter | undefined {
  if (!createFilter) return undefined;
  const requestCreateFilter: RedlineGraphicsOverrideCreateFilter = { ...createFilter };
  if (requestCreateFilter.ruleParameterStorageType === "element_id" && isPositiveInteger(requestCreateFilter.ruleValueElementId)) {
    requestCreateFilter.ruleValue = String(requestCreateFilter.ruleValueElementId);
  }
  return requestCreateFilter;
}

function legacyCompleteCreateFilter(createFilter: RedlineGraphicsOverrideCreateFilter | undefined): boolean {
  return Boolean(createFilter?.reviewed) &&
    nonEmpty(createFilter?.categoryName) &&
    nonEmpty(createFilter?.ruleParameterName) &&
    nonEmpty(createFilter?.ruleOperator) &&
    nonEmpty(createFilter?.ruleValue);
}

function unsupportedReason(target: string | undefined): string | null {
  if (!nonEmpty(target)) return null;
  if (target === "category_graphics" || target === "view_filter") return null;
  if (target === "view_template") return "view template graphics changes affect many views and require a separate reviewed adapter";
  if (target === "cad_link") return "CAD/link graphics overrides require link identity and layer readback before live promotion";
  if (target === "phase_graphics") return "phase graphics changes require phase/filter scoping before live promotion";
  return `unsupported graphics override target: ${target}`;
}

function requiredEvidenceForTarget(target: string | undefined): string[] {
  const shared = [
    "target_view_or_sheet_id",
    "dry_run_preflight_reviewed",
    "post_change_visual_capture",
    "final_revert_visual_capture",
    "revert_after_verify",
    "final_revert_readback"
  ];
  if (target === "view_filter") {
    return [
      ...shared,
      "view_filter_id_or_reviewed_create_filter",
      "requested_filter_graphics_override",
      "filter_graphics_readback"
    ];
  }
  return [
    ...shared,
    "category_name",
    "requested_category_graphics_override",
    "category_graphics_readback"
  ];
}

function addCommonEvidenceMissing(
  missing: Set<string>,
  action: RedlineGraphicsOverrideAction,
  evidence: RedlineGraphicsOverrideEvidence
): void {
  const viewId = evidence.viewId ?? action.viewId;
  if (!isPositiveInteger(viewId)) missing.add("target_view_or_sheet_id");
  if (evidence.dryRunPreflightReviewed !== true) missing.add("dry_run_preflight_reviewed");
  if (!nonEmpty(evidence.beforeGraphicsReadbackPath)) missing.add("before_graphics_readback");
  if (!nonEmpty(evidence.afterGraphicsReadbackPath)) missing.add("after_graphics_readback");
  if (!nonEmpty(evidence.finalGraphicsReadbackPath)) missing.add("final_revert_readback");
  if (!nonEmpty(evidence.postChangeCapturePath)) missing.add("post_change_visual_capture");
  if (!nonEmpty(evidence.finalCapturePath)) missing.add("final_revert_visual_capture");
  if (evidence.appliedReadbackMatches !== true) missing.add("applied_readback_matches");
  if (evidence.revertReadbackMatches !== true) missing.add("revert_readback_matches");
}

function buildCategoryRequest(action: RedlineGraphicsOverrideAction, evidence: RedlineGraphicsOverrideEvidence): Record<string, unknown> {
  return {
    viewId: evidence.viewId ?? action.viewId,
    categoryVisibility: {
      action: "set_category_override",
      categoryName: evidence.categoryName ?? action.categoryName,
      lineWeight: action.lineWeight,
      color: action.color,
      halftone: action.halftone,
      requestedStyle: action.requestedStyle,
      readbackRequired: true,
      revertAfterVerify: true
    },
    visualVerify: true,
    cleanupCreatedElements: false
  };
}

function buildFilterRequest(action: RedlineGraphicsOverrideAction, evidence: RedlineGraphicsOverrideEvidence): Record<string, unknown> {
  return {
    viewId: evidence.viewId ?? action.viewId,
    filterVisibility: {
      action: "apply_view_filter",
      filterId: evidence.filterId ?? action.filterId,
      filterName: evidence.filterName ?? action.filterName,
      filterVisible: action.filterVisible ?? true,
      lineWeight: action.lineWeight,
      color: action.color,
      halftone: action.halftone,
      requestedStyle: action.requestedStyle,
      createFilter: buildCreateFilterForRequest(action.createFilter),
      readbackRequired: true,
      revertAfterVerify: true
    },
    visualVerify: true,
    cleanupCreatedElements: false
  };
}

function adapterOperations(request: Record<string, unknown>, viewId: number | undefined): RedlineGraphicsOverrideLiveAdapterOperation[] {
  if (!isPositiveInteger(viewId)) return [];
  const captureRequest = { viewId, imageSize: 1800, includeAnnotations: true };
  return [
    { path: "/revit/export-image", purpose: "before_visual_capture", request: captureRequest },
    { path: "/revit/visibility", purpose: "visibility_dry_run", request: { ...request, dryRun: true } },
    { path: "/revit/visibility", purpose: "visibility_apply", request: { ...request, dryRun: false } },
    { path: "/revit/export-image", purpose: "after_visual_capture", request: captureRequest },
    { path: "/revit/visibility", purpose: "visibility_revert", request: { ...request, revertAfterVerify: true, dryRun: false } },
    { path: "/revit/export-image", purpose: "final_visual_capture", request: captureRequest }
  ];
}

export function evaluateRedlineGraphicsOverrideLiveAdapterReadiness(
  action: RedlineGraphicsOverrideAction,
  evidence: RedlineGraphicsOverrideEvidence = {}
): RedlineGraphicsOverrideLiveAdapterReadiness {
  const target = action.target;
  const unsupported = unsupportedReason(target);
  const requiredEvidence = requiredEvidenceForTarget(target);
  if (unsupported) {
    return {
      status: "unsupported_operation",
      ready_for_live_dry_run: false,
      ready_to_run: false,
      benchmark_task_id: null,
      workflow: null,
      reasons: [unsupported],
      missing_live_inputs: requiredEvidence,
      required_evidence: requiredEvidence,
      adapter_operations: []
    };
  }

  const missing = new Set<string>();
  const reasons: string[] = [];
  addCommonEvidenceMissing(missing, action, evidence);

  if (target === "view_filter") {
    if (!isPositiveInteger(evidence.filterId ?? action.filterId) && !completeCreateFilter(action.createFilter)) {
      missing.add("view_filter_id_or_reviewed_create_filter");
      for (const missingCreateFilterInput of createFilterMissingInputs(action.createFilter)) {
        missing.add(missingCreateFilterInput);
      }
      if (legacyCompleteCreateFilter(action.createFilter)) {
        missing.add("create_filter_rule_parameter_storage_type");
      }
    }
    if (!hasRequestedOverride(action)) missing.add("requested_filter_graphics_override");
    if (!nonEmpty(evidence.afterGraphicsReadbackPath)) missing.add("filter_graphics_readback");
  } else {
    if (!nonEmpty(evidence.categoryName ?? action.categoryName)) missing.add("category_name");
    if (!hasRequestedOverride(action)) missing.add("requested_category_graphics_override");
    if (!nonEmpty(evidence.afterGraphicsReadbackPath)) missing.add("category_graphics_readback");
  }

  const promotionBlockers = Array.from(missing);
  if (evidence.readyToRunOverride === true) {
    reasons.push("readyToRunOverride was supplied but this contract does not mark live execution ready without benchmark validation and GUI visual proof");
  }
  if (promotionBlockers.length > 0) {
    reasons.push("live graphics override promotion is missing required Revit evidence");
  }

  const request = target === "view_filter"
    ? buildFilterRequest(action, evidence)
    : buildCategoryRequest(action, evidence);
  const viewId = evidence.viewId ?? action.viewId;

  return {
    status: promotionBlockers.length === 0 ? "ready_for_live_dry_run" : "missing_live_inputs",
    ready_for_live_dry_run: promotionBlockers.length === 0,
    ready_to_run: false,
    benchmark_task_id: "demo_documentation_primitives",
    workflow: "documentation_primitives",
    reasons,
    missing_live_inputs: promotionBlockers,
    required_evidence: requiredEvidence,
    request_candidate: {
      workflow: "documentation_primitives",
      request,
      ready_to_run: false,
      live_request_status: "needs_live_request_override",
      promotion_blockers: promotionBlockers
    },
    adapter_operations: adapterOperations(request, viewId)
  };
}
