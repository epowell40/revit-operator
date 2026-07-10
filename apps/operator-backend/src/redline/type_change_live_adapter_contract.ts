export type RedlineTypeChangeLiveAdapterStatus =
  | "ready_for_live_dry_run"
  | "missing_live_inputs"
  | "needs_human_review"
  | "unsupported_operation";

export type RedlineTypeChangeTarget =
  | "duct"
  | "mep_accessory"
  | "device"
  | "receptacle"
  | "light"
  | "family_instance"
  | "text"
  | "unknown";

export type RedlineTypeChangeAction = {
  operation?: string;
  target?: RedlineTypeChangeTarget | string;
  elementIds?: number[];
  category?: string;
  visualViewId?: number;
  targetTypeId?: number;
  targetTypeName?: string;
  sourceTypeGrounding?: {
    expectedCurrentTypeId?: number;
    expectedCurrentTypeName?: string;
  };
  sourceFamilyGrounding?: {
    expectedFamilyName?: string;
    expectedTypeName?: string;
    expectedCategory?: string;
  };
};

export type RedlineTypeChangeEvidence = {
  elementIds?: number[];
  category?: string;
  visualViewId?: number;
  currentTypeId?: number;
  currentTypeName?: string;
  targetTypeId?: number;
  targetTypeName?: string;
  targetFamilyName?: string;
  dryRunPreflightReviewed?: boolean;
  targetTypeCompatibilityReviewed?: boolean;
  dryRunChangedIds?: number[];
  appliedChangedIds?: number[];
  readbackTypeId?: number;
  readbackTypeName?: string;
  postChangeCapturePath?: string;
  postChangeCaptureViewId?: number;
  revertDryRunIds?: number[];
  revertedIds?: number[];
  finalTypeId?: number;
  finalTypeName?: string;
  summaryArtifactPath?: string;
  readyToRunOverride?: boolean;
};

export type RedlineTypeChangeBenchmarkTaskId =
  | "demo_redline_type_change_duct"
  | "demo_redline_type_change_mep_accessory"
  | "demo_redline_type_change_device";

export type RedlineTypeChangeLiveAdapterOperation =
  | {
      path: "/revit/change-element-type";
      purpose: "type_change_dry_run" | "type_change_apply" | "type_change_readback" | "revert_dry_run" | "revert_apply" | "revert_readback";
      request: Record<string, unknown>;
    }
  | {
      path: "/revit/export-image";
      purpose: "post_change_visual_capture";
      request: Record<string, unknown>;
    };

export type RedlineTypeChangeLiveAdapterReadiness = {
  status: RedlineTypeChangeLiveAdapterStatus;
  ready_for_live_dry_run: boolean;
  ready_to_run: false;
  benchmark_task_id: RedlineTypeChangeBenchmarkTaskId | null;
  workflow: "redline_type_change" | null;
  reasons: string[];
  missing_live_inputs: string[];
  required_evidence: string[];
  request_candidate?: {
    workflow: "redline_type_change";
    request: Record<string, unknown>;
    ready_to_run: false;
    live_request_status: "needs_live_request_override";
    promotion_blockers: string[];
  };
  adapter_operations: RedlineTypeChangeLiveAdapterOperation[];
};

function isPositiveInteger(value: unknown): value is number {
  return Number.isInteger(value) && Number(value) > 0;
}

function nonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function positiveIds(values: unknown): number[] {
  return Array.isArray(values) ? values.filter(isPositiveInteger) : [];
}

function includesAll(actual: number[] | undefined, expected: number[]): boolean {
  return expected.length > 0 && expected.every((id) => Array.isArray(actual) && actual.includes(id));
}

function normalizedTarget(target: string | undefined): RedlineTypeChangeTarget {
  const normalized = (target ?? "unknown").trim().toLowerCase();
  if (normalized === "duct") return "duct";
  if (normalized === "mep_accessory" || normalized === "air_terminal" || normalized === "diffuser" || normalized === "grille") return "mep_accessory";
  if (normalized === "device") return "device";
  if (normalized === "receptacle") return "receptacle";
  if (normalized === "light") return "light";
  if (normalized === "family_instance") return "family_instance";
  if (normalized === "text" || normalized === "text_note") return "text";
  return "unknown";
}

function benchmarkTaskForTarget(target: RedlineTypeChangeTarget): RedlineTypeChangeBenchmarkTaskId | null {
  if (target === "duct") return "demo_redline_type_change_duct";
  if (target === "mep_accessory") return "demo_redline_type_change_mep_accessory";
  if (target === "device" || target === "receptacle" || target === "light" || target === "family_instance") return "demo_redline_type_change_device";
  return null;
}

function defaultCategoryForTarget(target: RedlineTypeChangeTarget): string | undefined {
  if (target === "duct") return "OST_DuctCurves";
  if (target === "receptacle") return "OST_ElectricalFixtures";
  if (target === "light") return "OST_LightingFixtures";
  return undefined;
}

function typeMatches(id: number | undefined, name: string | undefined, expectedId: number | undefined, expectedName: string | undefined): boolean {
  if (isPositiveInteger(expectedId)) return id === expectedId;
  if (nonEmpty(expectedName)) return (name ?? "").trim().toLowerCase() === expectedName.trim().toLowerCase();
  return false;
}

function requiredEvidenceForTarget(target: RedlineTypeChangeTarget): string[] {
  const shared = [
    "exact_element_ids",
    "source_type_readback",
    "compatible_target_type",
    "dry_run_preflight_reviewed",
    "target_type_compatibility_reviewed",
    "dry_run_changed_ids",
    "applied_changed_ids",
    "target_type_readback",
    "post_change_visual_capture",
    "revert_dry_run_ids",
    "revert_applied_ids",
    "original_type_revert_readback",
    "summary_artifact"
  ];
  if (target === "mep_accessory") {
    return [...shared, "source_family_category_grounding"];
  }
  return shared;
}

function unsupportedReason(target: RedlineTypeChangeTarget): string | null {
  if (target === "text") return "text type changes require a text-note style adapter, not element type-change execution";
  if (target === "unknown") return "unsupported type-change target: unknown";
  return null;
}

function addEvidenceMissing(
  missing: Set<string>,
  action: RedlineTypeChangeAction,
  evidence: RedlineTypeChangeEvidence,
  target: RedlineTypeChangeTarget
): void {
  const elementIds = positiveIds(evidence.elementIds).length > 0 ? positiveIds(evidence.elementIds) : positiveIds(action.elementIds);
  const targetTypeId = evidence.targetTypeId ?? action.targetTypeId;
  const targetTypeName = evidence.targetTypeName ?? action.targetTypeName;
  const sourceType = action.sourceTypeGrounding ?? {};
  const expectedCurrentTypeId = evidence.currentTypeId ?? sourceType.expectedCurrentTypeId;
  const expectedCurrentTypeName = evidence.currentTypeName ?? sourceType.expectedCurrentTypeName;

  if (elementIds.length <= 0) missing.add("exact_element_ids");
  if (!nonEmpty(evidence.category ?? action.category ?? defaultCategoryForTarget(target))) missing.add("source_category");
  if (!isPositiveInteger(action.visualViewId ?? evidence.visualViewId)) missing.add("visual_view_id");
  if (!isPositiveInteger(expectedCurrentTypeId) && !nonEmpty(expectedCurrentTypeName)) missing.add("source_type_readback");
  if (!isPositiveInteger(targetTypeId) && !nonEmpty(targetTypeName)) missing.add("compatible_target_type");
  if (evidence.dryRunPreflightReviewed !== true) missing.add("dry_run_preflight_reviewed");
  if (evidence.targetTypeCompatibilityReviewed !== true) missing.add("target_type_compatibility_reviewed");
  if (!includesAll(evidence.dryRunChangedIds, elementIds)) missing.add("dry_run_changed_ids");
  if (!includesAll(evidence.appliedChangedIds, elementIds)) missing.add("applied_changed_ids");
  if (!typeMatches(evidence.readbackTypeId, evidence.readbackTypeName, targetTypeId, targetTypeName)) missing.add("target_type_readback");
  if (!nonEmpty(evidence.postChangeCapturePath)) missing.add("post_change_visual_capture");
  if ((action.visualViewId ?? evidence.visualViewId) !== undefined && evidence.postChangeCaptureViewId !== (action.visualViewId ?? evidence.visualViewId)) {
    missing.add("post_change_capture_view_id");
  }
  if (!includesAll(evidence.revertDryRunIds, elementIds)) missing.add("revert_dry_run_ids");
  if (!includesAll(evidence.revertedIds, elementIds)) missing.add("revert_applied_ids");
  if (!typeMatches(evidence.finalTypeId, evidence.finalTypeName, expectedCurrentTypeId, expectedCurrentTypeName)) missing.add("original_type_revert_readback");
  if (!nonEmpty(evidence.summaryArtifactPath)) missing.add("summary_artifact");

  if (target === "mep_accessory") {
    const family = action.sourceFamilyGrounding ?? {};
    if (!nonEmpty(family.expectedFamilyName) || !nonEmpty(family.expectedTypeName) || !nonEmpty(family.expectedCategory)) {
      missing.add("source_family_category_grounding");
    }
  }
}

function buildRequest(
  action: RedlineTypeChangeAction,
  evidence: RedlineTypeChangeEvidence,
  target: RedlineTypeChangeTarget
): Record<string, unknown> {
  const elementIds = positiveIds(evidence.elementIds).length > 0 ? positiveIds(evidence.elementIds) : positiveIds(action.elementIds);
  const targetTypeId = evidence.targetTypeId ?? action.targetTypeId;
  const targetTypeName = evidence.targetTypeName ?? action.targetTypeName;
  const currentTypeId = evidence.currentTypeId ?? action.sourceTypeGrounding?.expectedCurrentTypeId;
  const currentTypeName = evidence.currentTypeName ?? action.sourceTypeGrounding?.expectedCurrentTypeName;
  const request: Record<string, unknown> = {
    elementIds,
    category: evidence.category ?? action.category ?? defaultCategoryForTarget(target),
    sourceTypeGrounding: {
      ...(isPositiveInteger(currentTypeId) ? { expectedCurrentTypeId: currentTypeId } : {}),
      ...(nonEmpty(currentTypeName) ? { expectedCurrentTypeName: currentTypeName } : {})
    },
    dryRunPreflightReviewed: true,
    targetTypeCompatibilityReviewed: true,
    visualViewId: action.visualViewId ?? evidence.visualViewId,
    visualVerify: true,
    revertAfterVerify: true
  };
  if (isPositiveInteger(targetTypeId)) request.targetTypeId = targetTypeId;
  else if (nonEmpty(targetTypeName)) request.targetTypeName = targetTypeName;
  if (target === "mep_accessory" && action.sourceFamilyGrounding) request.sourceFamilyGrounding = action.sourceFamilyGrounding;
  return request;
}

function adapterOperations(
  request: Record<string, unknown>,
  targetTypeId: number | undefined,
  sourceTypeId: number | undefined,
  sourceTypeName: string | undefined
): RedlineTypeChangeLiveAdapterOperation[] {
  const elementIds = positiveIds(request.elementIds);
  const visualViewId = request.visualViewId;
  if (elementIds.length <= 0) return [];
  const changeRequest = {
    ids: elementIds,
    category: request.category,
    ...(isPositiveInteger(targetTypeId) ? { typeId: targetTypeId } : { typeName: request.targetTypeName })
  };
  const revertRequest = {
    ids: elementIds,
    category: request.category,
    ...(isPositiveInteger(sourceTypeId) ? { typeId: sourceTypeId } : {}),
    ...(!isPositiveInteger(sourceTypeId) && nonEmpty(sourceTypeName) ? { typeName: sourceTypeName } : {})
  };
  const operations: RedlineTypeChangeLiveAdapterOperation[] = [
    { path: "/revit/change-element-type", purpose: "type_change_dry_run", request: { ...changeRequest, dryRun: true } },
    { path: "/revit/change-element-type", purpose: "type_change_apply", request: { ...changeRequest, dryRun: false } },
    { path: "/revit/change-element-type", purpose: "type_change_readback", request: { ...changeRequest, dryRun: true } }
  ];
  if (isPositiveInteger(visualViewId)) {
    operations.push({ path: "/revit/export-image", purpose: "post_change_visual_capture", request: { viewId: visualViewId, imageSize: 1800 } });
  }
  operations.push(
    { path: "/revit/change-element-type", purpose: "revert_dry_run", request: { ...revertRequest, dryRun: true } },
    { path: "/revit/change-element-type", purpose: "revert_apply", request: { ...revertRequest, dryRun: false } },
    { path: "/revit/change-element-type", purpose: "revert_readback", request: { ...revertRequest, dryRun: true } }
  );
  return operations;
}

export function evaluateRedlineTypeChangeLiveAdapterReadiness(
  action: RedlineTypeChangeAction,
  evidence: RedlineTypeChangeEvidence = {}
): RedlineTypeChangeLiveAdapterReadiness {
  const target = normalizedTarget(action.target);
  const taskId = benchmarkTaskForTarget(target);
  const unsupported = unsupportedReason(target);
  const requiredEvidence = requiredEvidenceForTarget(target);

  if (unsupported || !taskId) {
    return {
      status: "unsupported_operation",
      ready_for_live_dry_run: false,
      ready_to_run: false,
      benchmark_task_id: null,
      workflow: null,
      reasons: [unsupported ?? `unsupported type-change target: ${target}`],
      missing_live_inputs: requiredEvidence,
      required_evidence: requiredEvidence,
      adapter_operations: []
    };
  }

  const missing = new Set<string>();
  const reasons: string[] = [];
  addEvidenceMissing(missing, action, evidence, target);
  const promotionBlockers = Array.from(missing);
  if (evidence.readyToRunOverride === true) {
    reasons.push("readyToRunOverride was supplied but this contract does not mark live execution ready without benchmark validation and GUI visual proof");
  }
  if (promotionBlockers.length > 0) {
    reasons.push("live type-change promotion is missing required Revit evidence");
  }

  const request = buildRequest(action, evidence, target);
  return {
    status: promotionBlockers.length === 0 ? "ready_for_live_dry_run" : "missing_live_inputs",
    ready_for_live_dry_run: promotionBlockers.length === 0,
    ready_to_run: false,
    benchmark_task_id: taskId,
    workflow: "redline_type_change",
    reasons,
    missing_live_inputs: promotionBlockers,
    required_evidence: requiredEvidence,
    request_candidate: {
      workflow: "redline_type_change",
      request,
      ready_to_run: false,
      live_request_status: "needs_live_request_override",
      promotion_blockers: promotionBlockers
    },
    adapter_operations: adapterOperations(
      request,
      evidence.targetTypeId ?? action.targetTypeId,
      evidence.currentTypeId ?? action.sourceTypeGrounding?.expectedCurrentTypeId,
      evidence.currentTypeName ?? action.sourceTypeGrounding?.expectedCurrentTypeName
    )
  };
}
