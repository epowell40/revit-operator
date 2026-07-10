export type RedlineTagWorkflowOperation = "move" | "align" | "text_edit";

export type RedlineTagWorkflowStatus =
  | "success"
  | "failed"
  | "needs_human_review"
  | "target_not_found"
  | "invalid_parameter"
  | "verification_failed"
  | "deferred_live_inputs";

export type RedlineTagWorkflowPoint = {
  x: number;
  y: number;
  z?: number;
};

export type RedlineTagWorkflowAction = {
  operation?: RedlineTagWorkflowOperation | string;
  target?: "tag" | string;
  viewId?: number;
  tagId?: number;
  taggedElementId?: number;
  displayValue?: string;
  tagKind?: string;
  moveVector?: RedlineTagWorkflowPoint;
  targetPosition?: RedlineTagWorkflowPoint;
  alignToTagId?: number;
  alignToPosition?: RedlineTagWorkflowPoint;
  alignAxis?: "x" | "y" | "both" | string;
  expectedDisplayValue?: string;
  replacementValue?: string;
  valueSourceElementId?: number;
  valueSourceParameterName?: string;
  dryRun?: boolean;
  apply?: boolean;
};

export type RedlineTagWorkflowContext = {
  views?: Array<{
    view_id?: number;
    viewId?: number;
    id?: number;
    name?: string;
    view_type?: string;
    viewType?: string;
  }>;
  elements?: Array<{
    element_id?: number;
    elementId?: number;
    id?: number;
    category?: string;
    parameters?: Record<string, string>;
  }>;
  tags?: RedlineTagWorkflowTag[];
};

export type RedlineTagWorkflowTag = {
  tag_id?: number;
  tagId?: number;
  id?: number;
  view_id?: number;
  viewId?: number;
  category?: string;
  tag_kind?: string;
  tagKind?: string;
  tagged_element_id?: number;
  taggedElementId?: number;
  display_value?: string;
  displayValue?: string;
  visibleText?: string;
  head_position?: RedlineTagWorkflowPoint;
  headPosition?: RedlineTagWorkflowPoint;
  leader?: Record<string, unknown>;
  value_source?: {
    element_id?: number;
    elementId?: number;
    parameter_name?: string;
    parameterName?: string;
  };
  valueSource?: {
    element_id?: number;
    elementId?: number;
    parameter_name?: string;
    parameterName?: string;
  };
};

export type RedlineTagWorkflowValidation = {
  status: RedlineTagWorkflowStatus;
  ok: boolean;
  reasons: string[];
  taxonomy: {
    operation_class: "move" | "tag" | "text_edit";
    target_class: "tag";
    context_class: "annotation";
    evidence_requirements: Array<"move_effect_ids" | "annotation_inventory" | "visual_gate" | "parameter_readback">;
  };
  target?: {
    tagId: number;
    viewId?: number;
    category: string;
    taggedElementId?: number;
    displayValue?: string;
    headPosition?: RedlineTagWorkflowPoint;
    valueSourceElementId?: number;
    valueSourceParameterName?: string;
  };
  beforeAfterIntent?: {
    before: RedlineTagWorkflowPoint | string;
    after: RedlineTagWorkflowPoint | string;
  };
  requiredLiveInputs: string[];
};

export type RedlineTagWorkflowPlan = {
  status: RedlineTagWorkflowStatus;
  validation: RedlineTagWorkflowValidation;
  endpoint: "/revit/move-elements" | "/revit/set-parameter";
  adapterOperation: RedlineTagWorkflowOperation;
  request: Record<string, unknown>;
  requiredContext: string[];
  requiredEvidence: RedlineTagWorkflowValidation["taxonomy"]["evidence_requirements"];
};

export type RedlineTagWorkflowExecution = {
  status: RedlineTagWorkflowStatus;
  validation: RedlineTagWorkflowValidation;
  plan: RedlineTagWorkflowPlan;
  executionSource: "mock";
  executionMode: "dry_run_simulation" | "mock_apply_simulation" | "deferred_contract";
  liveBridgeCall: false;
  writeGrantRequired: false;
  mockOnly: true;
  mockApplied: boolean;
  annotationInventory?: {
    kind: "annotation_inventory";
    tagId: number;
    taggedElementId?: number;
    displayValue?: string;
    beforeHeadPosition?: RedlineTagWorkflowPoint;
    afterHeadPosition?: RedlineTagWorkflowPoint;
    leaderPreserved: boolean;
  };
  moveEffectIds?: number[];
  parameterReadback?: {
    kind: "parameter_readback";
    elementId: number;
    parameterName: string;
    before?: string;
    after: string;
  };
  message: string;
};

export type RedlineTagWorkflowVerification = {
  status: RedlineTagWorkflowStatus;
  ok: boolean;
  checks: Array<{
    name: string;
    ok: boolean;
    expected: unknown;
    actual: unknown;
  }>;
};

function normalizedText(value: unknown): string {
  return String(value ?? "").trim();
}

function finiteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function elementId(value: unknown): number | null {
  return Number.isInteger(value) && Number(value) > 0 ? Number(value) : null;
}

function tagId(tag: RedlineTagWorkflowTag): number | null {
  return elementId(tag.tag_id ?? tag.tagId ?? tag.id);
}

function viewId(tag: RedlineTagWorkflowTag): number | undefined {
  return elementId(tag.view_id ?? tag.viewId) ?? undefined;
}

function taggedElementId(tag: RedlineTagWorkflowTag): number | undefined {
  return elementId(tag.tagged_element_id ?? tag.taggedElementId) ?? undefined;
}

function displayValue(tag: RedlineTagWorkflowTag): string {
  return normalizedText(tag.display_value ?? tag.displayValue ?? tag.visibleText);
}

function valueSource(tag: RedlineTagWorkflowTag): { elementId?: number; parameterName?: string } {
  const source = tag.value_source ?? tag.valueSource;
  return {
    elementId: elementId(source?.element_id ?? source?.elementId) ?? undefined,
    parameterName: normalizedText(source?.parameter_name ?? source?.parameterName) || undefined
  };
}

function point(value: unknown): RedlineTagWorkflowPoint | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as Record<string, unknown>;
  if (!finiteNumber(candidate.x) || !finiteNumber(candidate.y)) return null;
  const z = finiteNumber(candidate.z) ? candidate.z : 0;
  return { x: candidate.x, y: candidate.y, z };
}

function addPoints(a: RedlineTagWorkflowPoint, b: RedlineTagWorkflowPoint): RedlineTagWorkflowPoint {
  return { x: a.x + b.x, y: a.y + b.y, z: (a.z ?? 0) + (b.z ?? 0) };
}

function subtractPoints(a: RedlineTagWorkflowPoint, b: RedlineTagWorkflowPoint): RedlineTagWorkflowPoint {
  return { x: a.x - b.x, y: a.y - b.y, z: (a.z ?? 0) - (b.z ?? 0) };
}

function samePoint(a: RedlineTagWorkflowPoint | undefined, b: RedlineTagWorkflowPoint | undefined): boolean {
  if (!a || !b) return false;
  return Math.abs(a.x - b.x) < 0.000001 && Math.abs(a.y - b.y) < 0.000001 && Math.abs((a.z ?? 0) - (b.z ?? 0)) < 0.000001;
}

function taxonomyFor(operation: string): RedlineTagWorkflowValidation["taxonomy"] {
  if (operation === "text_edit") {
    return {
      operation_class: "text_edit",
      target_class: "tag",
      context_class: "annotation",
      evidence_requirements: ["annotation_inventory", "parameter_readback"]
    };
  }
  return {
    operation_class: operation === "move" ? "move" : "tag",
    target_class: "tag",
    context_class: "annotation",
    evidence_requirements: ["move_effect_ids", "annotation_inventory", "visual_gate"]
  };
}

function findTag(action: RedlineTagWorkflowAction, context: RedlineTagWorkflowContext): { tag?: RedlineTagWorkflowTag; reason?: string } {
  const tags = context.tags ?? [];
  const wantedTagId = elementId(action.tagId);
  if (wantedTagId !== null) {
    const found = tags.find((tag) => tagId(tag) === wantedTagId);
    return found ? { tag: found } : { reason: "tag id not found in mock annotation inventory" };
  }

  const wantedElementId = elementId(action.taggedElementId);
  const wantedDisplay = normalizedText(action.displayValue);
  const matches = tags.filter((tag) => {
    const elementMatches = wantedElementId !== null && taggedElementId(tag) === wantedElementId;
    const valueMatches = Boolean(wantedDisplay) && displayValue(tag) === wantedDisplay;
    return elementMatches || valueMatches;
  });
  if (matches.length === 1) return { tag: matches[0] };
  if (matches.length > 1) return { reason: "ambiguous tag target: provide exact tag id" };
  return { reason: "missing exact tag id or existing tag context in mock annotation inventory" };
}

function resolveMoveAfter(action: RedlineTagWorkflowAction, before: RedlineTagWorkflowPoint): RedlineTagWorkflowPoint | null {
  const vector = point(action.moveVector);
  if (vector) return addPoints(before, vector);
  return point(action.targetPosition);
}

function resolveAlignAfter(action: RedlineTagWorkflowAction, context: RedlineTagWorkflowContext, before: RedlineTagWorkflowPoint): RedlineTagWorkflowPoint | null {
  const explicit = point(action.alignToPosition);
  let reference = explicit;
  const alignToTagId = elementId(action.alignToTagId);
  if (!reference && alignToTagId !== null) {
    const tag = (context.tags ?? []).find((entry) => tagId(entry) === alignToTagId);
    reference = point(tag?.head_position ?? tag?.headPosition);
  }
  if (!reference) return null;

  const axis = normalizedText(action.alignAxis || "x");
  if (axis === "x") return { ...before, x: reference.x };
  if (axis === "y") return { ...before, y: reference.y };
  if (axis === "both") return { x: reference.x, y: reference.y, z: before.z ?? reference.z ?? 0 };
  return null;
}

export function validateRedlineTagWorkflow(
  action: RedlineTagWorkflowAction,
  context: RedlineTagWorkflowContext
): RedlineTagWorkflowValidation {
  const reasons: string[] = [];
  const operation = normalizedText(action.operation || "move");
  const target = normalizedText(action.target || "tag");

  if (!["move", "align", "text_edit"].includes(operation)) reasons.push(`unsupported operation '${operation || "<missing>"}'; expected move, align, or text_edit`);
  if (target !== "tag") reasons.push(`unsupported target '${target || "<missing>"}'; expected tag`);

  const taxonomy = taxonomyFor(operation);
  if (reasons.length > 0) {
    return { status: "invalid_parameter", ok: false, reasons, taxonomy, requiredLiveInputs: [] };
  }

  const { tag, reason } = findTag(action, context);
  if (!tag) {
    return { status: "target_not_found", ok: false, reasons: [reason ?? "tag target not found"], taxonomy, requiredLiveInputs: ["annotation_inventory"] };
  }

  const resolvedTagId = tagId(tag);
  if (resolvedTagId === null) {
    return { status: "target_not_found", ok: false, reasons: ["tag target is missing a valid tag id"], taxonomy, requiredLiveInputs: ["annotation_inventory"] };
  }

  const tagKind = normalizedText(action.tagKind);
  const resolvedKind = normalizedText(tag.tag_kind ?? tag.tagKind ?? tag.category);
  if (tagKind && resolvedKind && !resolvedKind.toLowerCase().includes(tagKind.toLowerCase())) {
    return { status: "needs_human_review", ok: false, reasons: [`unsupported tag kind '${resolvedKind}' for requested '${tagKind}'`], taxonomy, requiredLiveInputs: ["annotation_inventory"] };
  }

  const before = point(tag.head_position ?? tag.headPosition);
  const baseTarget = {
    tagId: resolvedTagId,
    viewId: viewId(tag),
    category: normalizedText(tag.category),
    taggedElementId: taggedElementId(tag),
    displayValue: displayValue(tag) || undefined,
    headPosition: before ?? undefined,
    valueSourceElementId: valueSource(tag).elementId,
    valueSourceParameterName: valueSource(tag).parameterName
  };

  if (operation === "text_edit") {
    const replacementValue = normalizedText(action.replacementValue);
    const sourceElementId = elementId(action.valueSourceElementId) ?? baseTarget.valueSourceElementId;
    const sourceParameterName = normalizedText(action.valueSourceParameterName) || baseTarget.valueSourceParameterName;
    if (!replacementValue) reasons.push("missing replacement tag value/text");
    if (!sourceElementId || !sourceParameterName) reasons.push("missing live inputs for tag text update: source element id and source parameter name");
    if (reasons.length > 0) {
      return { status: "deferred_live_inputs", ok: false, reasons, taxonomy, target: baseTarget, requiredLiveInputs: ["tag display text readback", "tag value source parameter"] };
    }
    return {
      status: "deferred_live_inputs",
      ok: false,
      reasons: ["tag value/text update is contract-only in this slice; live parameter write/readback is deferred"],
      taxonomy,
      target: { ...baseTarget, valueSourceElementId: sourceElementId, valueSourceParameterName: sourceParameterName },
      beforeAfterIntent: { before: displayValue(tag), after: replacementValue },
      requiredLiveInputs: ["set-parameter write permission", "before/after visible tag text readback", "source parameter revert evidence"]
    };
  }

  if (!before) {
    return { status: "invalid_parameter", ok: false, reasons: ["missing geometry: tag head position is required for move/align"], taxonomy, target: baseTarget, requiredLiveInputs: ["tag head position"] };
  }

  const after = operation === "move" ? resolveMoveAfter(action, before) : resolveAlignAfter(action, context, before);
  if (!after) {
    const reasonText = operation === "move"
      ? "missing movement input: provide moveVector or targetPosition"
      : "missing alignment input: provide alignToTagId or alignToPosition with alignAxis x, y, or both";
    return { status: "invalid_parameter", ok: false, reasons: [reasonText], taxonomy, target: baseTarget, requiredLiveInputs: operation === "move" ? ["move vector or target position"] : ["alignment reference"] };
  }

  if (samePoint(before, after)) {
    return { status: "needs_human_review", ok: false, reasons: ["requested tag operation produces no position change"], taxonomy, target: baseTarget, beforeAfterIntent: { before, after }, requiredLiveInputs: [] };
  }

  return {
    status: "success",
    ok: true,
    reasons: [],
    taxonomy,
    target: baseTarget,
    beforeAfterIntent: { before, after },
    requiredLiveInputs: []
  };
}

export function planRedlineTagWorkflowDryRun(
  action: RedlineTagWorkflowAction,
  context: RedlineTagWorkflowContext
): RedlineTagWorkflowPlan {
  const validation = validateRedlineTagWorkflow(action, context);
  const operation = normalizedText(action.operation || "move") as RedlineTagWorkflowOperation;
  const before = typeof validation.beforeAfterIntent?.before === "object" ? validation.beforeAfterIntent.before as RedlineTagWorkflowPoint : undefined;
  const after = typeof validation.beforeAfterIntent?.after === "object" ? validation.beforeAfterIntent.after as RedlineTagWorkflowPoint : undefined;
  const vector = before && after ? subtractPoints(after, before) : point(action.moveVector);
  const textUpdate = operation === "text_edit";

  return {
    status: validation.status,
    validation,
    endpoint: textUpdate ? "/revit/set-parameter" : "/revit/move-elements",
    adapterOperation: operation,
    request: textUpdate
      ? {
        dryRun: true,
        apply: false,
        mockOnly: true,
        operationClass: "text_edit",
        targetClass: "tag",
        tagId: validation.target?.tagId,
        elementId: validation.target?.valueSourceElementId ?? action.valueSourceElementId,
        parameterName: validation.target?.valueSourceParameterName ?? normalizedText(action.valueSourceParameterName),
        expectedExistingValue: normalizedText(action.expectedDisplayValue || validation.target?.displayValue),
        requestedTextOrValue: normalizedText(action.replacementValue),
        readbackRequired: true
      }
      : {
        dryRun: true,
        apply: false,
        mockOnly: true,
        operationClass: validation.taxonomy.operation_class,
        targetClass: "tag",
        ids: validation.target ? [validation.target.tagId] : [],
        mode: "vector",
        vectorX: vector?.x ?? 0,
        vectorY: vector?.y ?? 0,
        vectorZ: vector?.z ?? 0,
        beforeHeadPosition: before,
        afterHeadPosition: after,
        preserveLeaderGeometry: true,
        readbackRequired: true
      },
    requiredContext: textUpdate
      ? ["exact tag id", "tag display text", "source element id", "source parameter name", "replacement value"]
      : ["exact tag id or unique existing tag context", "tag head position", operation === "move" ? "move vector or target position" : "alignment reference"],
    requiredEvidence: validation.taxonomy.evidence_requirements
  };
}

export function executeRedlineTagWorkflowMock(
  action: RedlineTagWorkflowAction,
  context: RedlineTagWorkflowContext
): RedlineTagWorkflowExecution {
  const plan = planRedlineTagWorkflowDryRun(action, context);
  const validation = plan.validation;
  const operation = plan.adapterOperation;

  if (operation === "text_edit") {
    return {
      status: "deferred_live_inputs",
      validation,
      plan,
      executionSource: "mock",
      executionMode: "deferred_contract",
      liveBridgeCall: false,
      writeGrantRequired: false,
      mockOnly: true,
      mockApplied: false,
      parameterReadback: validation.target?.valueSourceElementId && validation.target.valueSourceParameterName
        ? {
          kind: "parameter_readback",
          elementId: validation.target.valueSourceElementId,
          parameterName: validation.target.valueSourceParameterName,
          before: validation.target.displayValue,
          after: normalizedText(action.replacementValue)
        }
        : undefined,
      message: "Tag value/text update is adapter-contract-only in this slice; live source-parameter write and visible tag readback are deferred."
    };
  }

  if (!validation.ok || !validation.target) {
    return {
      status: validation.status,
      validation,
      plan,
      executionSource: "mock",
      executionMode: "dry_run_simulation",
      liveBridgeCall: false,
      writeGrantRequired: false,
      mockOnly: true,
      mockApplied: false,
      message: validation.reasons.join("; ") || "tag workflow validation failed"
    };
  }

  const before = validation.beforeAfterIntent?.before as RedlineTagWorkflowPoint;
  const after = validation.beforeAfterIntent?.after as RedlineTagWorkflowPoint;
  return {
    status: "success",
    validation,
    plan,
    executionSource: "mock",
    executionMode: action.apply === true ? "mock_apply_simulation" : "dry_run_simulation",
    liveBridgeCall: false,
    writeGrantRequired: false,
    mockOnly: true,
    mockApplied: action.apply === true,
    annotationInventory: {
      kind: "annotation_inventory",
      tagId: validation.target.tagId,
      taggedElementId: validation.target.taggedElementId,
      displayValue: validation.target.displayValue,
      beforeHeadPosition: before,
      afterHeadPosition: after,
      leaderPreserved: true
    },
    moveEffectIds: [validation.target.tagId],
    message: action.apply === true
      ? "Mock apply simulation produced move_effect_ids and annotation_inventory evidence without live Revit calls."
      : "Dry-run tag workflow plan produced without live Revit calls."
  };
}

export function verifyRedlineTagWorkflow(
  action: RedlineTagWorkflowAction,
  execution: RedlineTagWorkflowExecution,
  observed?: { headPosition?: RedlineTagWorkflowPoint; displayValue?: string }
): RedlineTagWorkflowVerification {
  const operation = normalizedText(action.operation || "move");
  const checks: RedlineTagWorkflowVerification["checks"] = [];

  if (operation === "text_edit") {
    const requestedValue = normalizedText(action.replacementValue);
    const actualValue = normalizedText(observed?.displayValue ?? execution.parameterReadback?.after);
    checks.push({
      name: "tag_text_contract_deferred",
      ok: execution.status === "deferred_live_inputs",
      expected: "deferred_live_inputs",
      actual: execution.status
    });
    checks.push({
      name: "requested_tag_value_present",
      ok: Boolean(requestedValue),
      expected: "non-empty replacement value",
      actual: requestedValue
    });
    checks.push({
      name: "tag_value_readback_matches_requested_value",
      ok: Boolean(requestedValue) && actualValue === requestedValue,
      expected: requestedValue,
      actual: actualValue
    });
    return { status: checks.every((check) => check.ok) ? "deferred_live_inputs" : "verification_failed", ok: checks.every((check) => check.ok), checks };
  }

  const expectedPosition = execution.annotationInventory?.afterHeadPosition;
  const actualPosition = observed?.headPosition ?? execution.annotationInventory?.afterHeadPosition;
  checks.push({
    name: "move_effect_ids_include_tag",
    ok: Boolean(execution.validation.target?.tagId && execution.moveEffectIds?.includes(execution.validation.target.tagId)),
    expected: execution.validation.target?.tagId,
    actual: execution.moveEffectIds
  });
  checks.push({
    name: "annotation_inventory_after_position_matches_plan",
    ok: samePoint(expectedPosition, actualPosition),
    expected: expectedPosition,
    actual: actualPosition
  });
  checks.push({
    name: "leader_geometry_preserved",
    ok: execution.annotationInventory?.leaderPreserved === true,
    expected: true,
    actual: execution.annotationInventory?.leaderPreserved
  });

  const ok = execution.status === "success" && checks.every((check) => check.ok);
  return {
    status: ok ? "success" : "verification_failed",
    ok,
    checks
  };
}
