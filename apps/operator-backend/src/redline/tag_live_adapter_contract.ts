import {
  planRedlineTagWorkflowDryRun,
  type RedlineTagWorkflowAction,
  type RedlineTagWorkflowContext,
  type RedlineTagWorkflowPoint
} from "./tag_workflow_skill.js";

export type RedlineTagLiveAdapterStatus =
  | "ready_for_live_dry_run"
  | "missing_live_inputs"
  | "needs_human_review"
  | "unsupported_operation";

export type RedlineTagLiveAdapterEvidence = {
  viewId?: number;
  tagId?: number;
  taggedElementId?: number;
  expectedTagText?: string;
  expectedCategory?: string;
  beforeHeadPosition?: RedlineTagWorkflowPoint;
  afterHeadPosition?: RedlineTagWorkflowPoint;
  finalHeadPosition?: RedlineTagWorkflowPoint;
  moveDryRunIds?: number[];
  movedIds?: number[];
  revertDryRunIds?: number[];
  revertedIds?: number[];
  beforeAnnotationInventoryPath?: string;
  afterAnnotationInventoryPath?: string;
  finalAnnotationInventoryPath?: string;
  beforeVisualGateArtifact?: string;
  afterVisualGateArtifact?: string;
  finalVisualGateArtifact?: string;
  leaderPreserved?: boolean;
  readyToRunOverride?: boolean;
};

export type RedlineTagLiveAdapterOperation =
  | {
      path: "/revit/export-visible-elements";
      purpose: "before_annotation_inventory" | "after_annotation_inventory" | "final_annotation_inventory";
      request: Record<string, unknown>;
    }
  | {
      path: "/revit/move-elements";
      purpose: "move_dry_run" | "move_apply" | "revert_dry_run" | "revert_apply";
      request: Record<string, unknown>;
    };

export type RedlineTagLiveAdapterReadiness = {
  status: RedlineTagLiveAdapterStatus;
  ready_for_live_dry_run: boolean;
  ready_to_run: false;
  benchmark_task_id: "demo_redline_move_tag" | null;
  workflow: "redline_move" | null;
  reasons: string[];
  missing_live_inputs: string[];
  required_evidence: string[];
  request_candidate?: {
    workflow: "redline_move";
    request: Record<string, unknown>;
    ready_to_run: false;
    live_request_status: "needs_live_request_override";
    promotion_blockers: string[];
  };
  adapter_operations: RedlineTagLiveAdapterOperation[];
};

function isPositiveInteger(value: unknown): value is number {
  return Number.isInteger(value) && Number(value) > 0;
}

function nonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function point(value: unknown): RedlineTagWorkflowPoint | undefined {
  if (!value || typeof value !== "object") return undefined;
  const candidate = value as Record<string, unknown>;
  return typeof candidate.x === "number" && Number.isFinite(candidate.x) &&
    typeof candidate.y === "number" && Number.isFinite(candidate.y)
    ? { x: candidate.x, y: candidate.y, z: typeof candidate.z === "number" && Number.isFinite(candidate.z) ? candidate.z : 0 }
    : undefined;
}

function asObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function positiveIds(value: unknown): number[] {
  const values = Array.isArray(value) ? value : [value];
  return Array.from(new Set(values.map((entry) => Number(entry)).filter((entry) => Number.isInteger(entry) && entry > 0)));
}

function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    const text = typeof value === "string" ? value.trim() : "";
    if (text) return text;
  }
  return undefined;
}

function idsInclude(ids: number[] | undefined, id: number | undefined): boolean {
  return isPositiveInteger(id) && Array.isArray(ids) && ids.includes(id);
}

function vectorFromPlan(planRequest: Record<string, unknown>): RedlineTagWorkflowPoint {
  return {
    x: typeof planRequest.vectorX === "number" ? planRequest.vectorX : 0,
    y: typeof planRequest.vectorY === "number" ? planRequest.vectorY : 0,
    z: typeof planRequest.vectorZ === "number" ? planRequest.vectorZ : 0
  };
}

function tagPoint(action: RedlineTagWorkflowAction, context: RedlineTagWorkflowContext): RedlineTagWorkflowPoint | undefined {
  const plan = planRedlineTagWorkflowDryRun(action, context);
  return point(plan.validation.target?.headPosition);
}

function hasNoOpVector(vector: RedlineTagWorkflowPoint): boolean {
  return Math.abs(vector.x) < 0.000001 && Math.abs(vector.y) < 0.000001 && Math.abs(vector.z ?? 0) < 0.000001;
}

function moveEvidenceMissing(tagId: number | undefined, evidence: RedlineTagLiveAdapterEvidence): string[] {
  const missing: string[] = [];
  if (!idsInclude(evidence.moveDryRunIds, tagId)) missing.push("move_dry_run_ids");
  if (!idsInclude(evidence.movedIds, tagId)) missing.push("move_applied_ids");
  if (!idsInclude(evidence.revertDryRunIds, tagId)) missing.push("revert_dry_run_ids");
  if (!idsInclude(evidence.revertedIds, tagId)) missing.push("revert_applied_ids");
  return missing;
}

export function evidenceFromRedlineMoveSummary(
  summary: unknown,
  options: {
    viewId?: number;
    tagId?: number;
    taggedElementId?: number;
    expectedTagText?: string;
    expectedCategory?: string;
    visualGateArtifactPath?: string;
    leaderPreserved?: boolean;
  } = {}
): RedlineTagLiveAdapterEvidence {
  const data = asObject(summary);
  const tagId = isPositiveInteger(options.tagId) ? options.tagId : positiveIds(data.createdId)[0] ?? positiveIds(data.targetIds)[0];
  const captureBefore = firstString(data.beforeCapturePath);
  const captureAfter = firstString(data.afterCapturePath);
  const captureFinal = firstString(data.finalCapturePath);
  const visualGateArtifactPath = firstString(options.visualGateArtifactPath);
  return {
    viewId: options.viewId,
    tagId,
    taggedElementId: options.taggedElementId,
    expectedTagText: options.expectedTagText,
    expectedCategory: options.expectedCategory,
    beforeHeadPosition: point(data.beforePoint),
    afterHeadPosition: point(data.afterPoint),
    finalHeadPosition: point(data.finalPoint),
    moveDryRunIds: positiveIds(data.dryMovedIds),
    movedIds: positiveIds(data.movedIds),
    revertDryRunIds: positiveIds(data.revertDryMovedIds),
    revertedIds: positiveIds(data.revertedMovedIds),
    beforeAnnotationInventoryPath: captureBefore,
    afterAnnotationInventoryPath: captureAfter,
    finalAnnotationInventoryPath: captureFinal,
    beforeVisualGateArtifact: visualGateArtifactPath ?? captureBefore,
    afterVisualGateArtifact: visualGateArtifactPath ?? captureAfter,
    finalVisualGateArtifact: visualGateArtifactPath ?? captureFinal,
    leaderPreserved: typeof options.leaderPreserved === "boolean" ? options.leaderPreserved : data.leaderPreserved === true ? true : undefined
  };
}

export function evaluateRedlineTagLiveAdapterReadiness(
  action: RedlineTagWorkflowAction,
  context: RedlineTagWorkflowContext,
  evidence: RedlineTagLiveAdapterEvidence = {}
): RedlineTagLiveAdapterReadiness {
  const plan = planRedlineTagWorkflowDryRun(action, context);
  const operation = plan.adapterOperation;
  const reasons: string[] = [];
  const missing = new Set<string>();
  const requiredEvidence = [
    "exact_tag_id",
    "tag_target_view_id",
    "tagged_element_readback",
    "tag_head_position_before",
    "move_dry_run_ids",
    "move_applied_ids",
    "revert_dry_run_ids",
    "revert_applied_ids",
    "annotation_inventory_before_after_final",
    "visual_gate_before_after_final",
    "leader_geometry_preserved_or_not_applicable"
  ];

  if (operation === "text_edit") {
    return {
      status: "unsupported_operation",
      ready_for_live_dry_run: false,
      ready_to_run: false,
      benchmark_task_id: null,
      workflow: null,
      reasons: ["tag text/value edits require a parameter-write adapter, not the move-tag live adapter"],
      missing_live_inputs: ["tag_value_source_parameter", "visible_tag_text_readback", "parameter_revert_evidence"],
      required_evidence: ["tag_value_source_parameter", "parameter_readback", "visible_tag_text_readback", "revert_evidence"],
      adapter_operations: []
    };
  }

  if (!plan.validation.ok || !plan.validation.target) {
    return {
      status: plan.validation.status === "needs_human_review" ? "needs_human_review" : "missing_live_inputs",
      ready_for_live_dry_run: false,
      ready_to_run: false,
      benchmark_task_id: "demo_redline_move_tag",
      workflow: "redline_move",
      reasons: plan.validation.reasons.length > 0 ? plan.validation.reasons : ["tag workflow validation did not produce a grounded move/align target"],
      missing_live_inputs: plan.validation.requiredLiveInputs,
      required_evidence: requiredEvidence,
      adapter_operations: []
    };
  }

  const target = plan.validation.target;
  const viewId = evidence.viewId ?? target.viewId ?? action.viewId;
  const tagId = evidence.tagId ?? target.tagId;
  const taggedElementId = evidence.taggedElementId ?? target.taggedElementId ?? action.taggedElementId;
  const expectedTagText = evidence.expectedTagText ?? target.displayValue ?? action.displayValue;
  const vector = vectorFromPlan(plan.request);

  if (!isPositiveInteger(viewId)) missing.add("tag_target_view_id");
  if (!isPositiveInteger(tagId)) missing.add("exact_tag_id");
  if (!isPositiveInteger(taggedElementId)) missing.add("tagged_element_id");
  if (!nonEmpty(expectedTagText)) missing.add("existing_tag_text_or_display_value");
  if (!point(evidence.beforeHeadPosition) && !tagPoint(action, context)) missing.add("tag_head_position_before");
  if (hasNoOpVector(vector)) missing.add("non_zero_move_or_alignment_vector");
  for (const missingMove of moveEvidenceMissing(tagId, evidence)) missing.add(missingMove);
  if (!nonEmpty(evidence.beforeAnnotationInventoryPath)) missing.add("before_annotation_inventory");
  if (!nonEmpty(evidence.afterAnnotationInventoryPath)) missing.add("after_annotation_inventory");
  if (!nonEmpty(evidence.finalAnnotationInventoryPath)) missing.add("final_annotation_inventory_after_revert");
  if (!nonEmpty(evidence.beforeVisualGateArtifact)) missing.add("before_visual_gate_artifact");
  if (!nonEmpty(evidence.afterVisualGateArtifact)) missing.add("after_visual_gate_artifact");
  if (!nonEmpty(evidence.finalVisualGateArtifact)) missing.add("final_visual_gate_artifact_after_revert");
  if (evidence.leaderPreserved !== true) missing.add("leader_geometry_preservation_evidence");

  const moveRequest = {
    ids: [tagId],
    mode: "vector",
    vectorX: vector.x,
    vectorY: vector.y,
    vectorZ: vector.z ?? 0,
    behavior: "allOrNothing"
  };
  const captureRequest = {
    viewId,
    includeMapping: true,
    includeGeometry: true,
    imageSize: 1800
  };
  const adapterOperations: RedlineTagLiveAdapterOperation[] = isPositiveInteger(viewId) && isPositiveInteger(tagId)
    ? [
        { path: "/revit/export-visible-elements", purpose: "before_annotation_inventory", request: captureRequest },
        { path: "/revit/move-elements", purpose: "move_dry_run", request: { ...moveRequest, dryRun: true } },
        { path: "/revit/move-elements", purpose: "move_apply", request: { ...moveRequest, dryRun: false } },
        { path: "/revit/export-visible-elements", purpose: "after_annotation_inventory", request: captureRequest },
        { path: "/revit/move-elements", purpose: "revert_dry_run", request: { ...moveRequest, vectorX: -vector.x, vectorY: -vector.y, vectorZ: -(vector.z ?? 0), dryRun: true } },
        { path: "/revit/move-elements", purpose: "revert_apply", request: { ...moveRequest, vectorX: -vector.x, vectorY: -vector.y, vectorZ: -(vector.z ?? 0), dryRun: false } },
        { path: "/revit/export-visible-elements", purpose: "final_annotation_inventory", request: captureRequest }
      ]
    : [];

  const promotionBlockers = Array.from(missing);
  if (evidence.readyToRunOverride === true) {
    reasons.push("readyToRunOverride was supplied but this contract does not mark live execution ready without benchmark validation and GUI visual proof");
  }
  if (promotionBlockers.length > 0) reasons.push("live tag move/align promotion is missing required Revit evidence");

  return {
    status: promotionBlockers.length === 0 ? "ready_for_live_dry_run" : "missing_live_inputs",
    ready_for_live_dry_run: promotionBlockers.length === 0,
    ready_to_run: false,
    benchmark_task_id: "demo_redline_move_tag",
    workflow: "redline_move",
    reasons,
    missing_live_inputs: promotionBlockers,
    required_evidence: requiredEvidence,
    request_candidate: {
      workflow: "redline_move",
      request: {
        viewId,
        targetKind: "tag",
        toleranceFt: 0.05,
        tag: {
          existingTagIds: [tagId],
          elementIds: isPositiveInteger(taggedElementId) ? [taggedElementId] : [],
          readbackRequired: true
        },
        existingTarget: {
          moveExisting: true,
          elementIds: [tagId],
          expectedCategory: evidence.expectedCategory ?? target.category,
          expectedTagText,
          taggedElementIds: isPositiveInteger(taggedElementId) ? [taggedElementId] : [],
          readbackRequired: true
        },
        move: {
          mode: "vector",
          vectorX: vector.x,
          vectorY: vector.y,
          vectorZ: vector.z ?? 0,
          behavior: "allOrNothing"
        },
        dryRunPreflightReviewed: true,
        visualVerify: true,
        revertAfterVerify: true
      },
      ready_to_run: false,
      live_request_status: "needs_live_request_override",
      promotion_blockers: promotionBlockers
    },
    adapter_operations: adapterOperations
  };
}
