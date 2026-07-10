export type RedlineUpdateParameterStatus =
  | "success"
  | "failed"
  | "needs_human_review"
  | "target_not_found"
  | "invalid_parameter"
  | "verification_failed";

export type RedlineUpdateParameterAction = {
  operation?: "parameter_edit" | "update_parameter" | string;
  target?: "model_parameter" | "element_parameter" | "tag_source_parameter" | string;
  elementId?: number;
  category?: string;
  familyName?: string;
  typeName?: string;
  parameterName?: string;
  expectedExistingValue?: string;
  replacementValue?: string;
  viewId?: number;
  visualViewId?: number;
  dryRun?: boolean;
  apply?: boolean;
  revertAfterVerify?: boolean;
};

export type RedlineUpdateParameterContext = {
  elements?: RedlineUpdateParameterElement[];
  tags?: Array<{
    tag_id?: number;
    tagId?: number;
    tagged_element_id?: number;
    taggedElementId?: number;
    display_value?: string;
    displayValue?: string;
    value_source?: {
      element_id?: number;
      elementId?: number;
      parameter_name?: string;
      parameterName?: string;
    };
  }>;
};

export type RedlineUpdateParameterElement = {
  element_id?: number;
  elementId?: number;
  id?: number;
  category?: string;
  family?: string;
  familyName?: string;
  type?: string;
  typeName?: string;
  parameters?: Record<string, string>;
};

export type RedlineUpdateParameterValidation = {
  status: RedlineUpdateParameterStatus;
  ok: boolean;
  reasons: string[];
  taxonomy: {
    operation_class: "parameter_edit";
    target_class: "model_parameter";
    context_class: "host_model";
    evidence_requirements: ["parameter_readback"];
  };
  target?: {
    elementId: number;
    category?: string;
    familyName?: string;
    typeName?: string;
    parameterName: string;
    existingValue: string;
  };
};

export type RedlineUpdateParameterPlan = {
  status: RedlineUpdateParameterStatus;
  validation: RedlineUpdateParameterValidation;
  endpoint: "/revit/set-parameter";
  benchmarkTaskId: "demo_redline_update_parameter";
  request: Record<string, unknown>;
  requiredContext: string[];
  requiredEvidence: ["parameter_readback"];
};

export type RedlineUpdateParameterExecution = {
  status: RedlineUpdateParameterStatus;
  validation: RedlineUpdateParameterValidation;
  plan: RedlineUpdateParameterPlan;
  executionSource: "mock";
  executionMode: "dry_run_simulation" | "mock_apply_simulation";
  liveBridgeCall: false;
  writeGrantRequired: false;
  mockOnly: true;
  mockApplied: boolean;
  parameterReadback?: {
    kind: "parameter_readback";
    elementId: number;
    parameterName: string;
    before: string;
    after: string;
    revertedTo?: string;
  };
  message: string;
};

export type RedlineUpdateParameterVerification = {
  status: RedlineUpdateParameterStatus;
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

function elementId(value: unknown): number | null {
  return Number.isInteger(value) && Number(value) > 0 ? Number(value) : null;
}

function elements(context: RedlineUpdateParameterContext): RedlineUpdateParameterElement[] {
  return context.elements ?? [];
}

function elementIdentifier(element: RedlineUpdateParameterElement): number | null {
  return elementId(element.element_id ?? element.elementId ?? element.id);
}

function elementCategory(element: RedlineUpdateParameterElement): string {
  return normalizedText(element.category);
}

function elementFamily(element: RedlineUpdateParameterElement): string {
  return normalizedText(element.family ?? element.familyName);
}

function elementType(element: RedlineUpdateParameterElement): string {
  return normalizedText(element.type ?? element.typeName);
}

function parameterValue(element: RedlineUpdateParameterElement, parameterName: string): string | null {
  const parameters = element.parameters ?? {};
  if (Object.prototype.hasOwnProperty.call(parameters, parameterName)) return String(parameters[parameterName]);
  const wanted = parameterName.toLowerCase();
  const key = Object.keys(parameters).find((entry) => entry.toLowerCase() === wanted);
  return key ? String(parameters[key]) : null;
}

function resolvedParameterName(element: RedlineUpdateParameterElement, parameterName: string): string {
  const parameters = element.parameters ?? {};
  const key = Object.keys(parameters).find((entry) => entry.toLowerCase() === parameterName.toLowerCase());
  return key ?? parameterName;
}

function matchesText(actual: string, expected: string): boolean {
  return !expected || actual.toLowerCase() === expected.toLowerCase();
}

function findElement(
  action: RedlineUpdateParameterAction,
  context: RedlineUpdateParameterContext
): { element?: RedlineUpdateParameterElement; reason?: string } {
  const allElements = elements(context);
  const wantedId = elementId(action.elementId);
  if (wantedId !== null) {
    const found = allElements.find((element) => elementIdentifier(element) === wantedId);
    return found ? { element: found } : { reason: "element id not found in mock parameter context" };
  }

  const category = normalizedText(action.category);
  const familyName = normalizedText(action.familyName);
  const typeName = normalizedText(action.typeName);
  if (!category && !familyName && !typeName) return { reason: "missing element id or unique category/family/type target" };

  const matches = allElements.filter((element) =>
    matchesText(elementCategory(element), category) &&
    matchesText(elementFamily(element), familyName) &&
    matchesText(elementType(element), typeName)
  );
  if (matches.length === 1) return { element: matches[0] };
  if (matches.length > 1) return { reason: "ambiguous parameter target: provide exact element id" };
  return { reason: "parameter target not found in mock context" };
}

function taxonomy(): RedlineUpdateParameterValidation["taxonomy"] {
  return {
    operation_class: "parameter_edit",
    target_class: "model_parameter",
    context_class: "host_model",
    evidence_requirements: ["parameter_readback"]
  };
}

export function validateRedlineUpdateParameter(
  action: RedlineUpdateParameterAction,
  context: RedlineUpdateParameterContext
): RedlineUpdateParameterValidation {
  const reasons: string[] = [];
  const operation = normalizedText(action.operation || "parameter_edit");
  const target = normalizedText(action.target || "model_parameter");
  const parameterName = normalizedText(action.parameterName);
  const replacementValue = normalizedText(action.replacementValue);

  if (!["parameter_edit", "update_parameter"].includes(operation)) reasons.push(`unsupported operation '${operation || "<missing>"}'; expected parameter_edit`);
  if (!["model_parameter", "element_parameter", "tag_source_parameter"].includes(target)) {
    reasons.push(`unsupported target '${target || "<missing>"}'; expected model_parameter, element_parameter, or tag_source_parameter`);
  }
  if (!parameterName) reasons.push("missing parameter name");
  if (!replacementValue) reasons.push("missing replacement value");
  if (reasons.length > 0) return { status: "invalid_parameter", ok: false, reasons, taxonomy: taxonomy() };

  const { element, reason } = findElement(action, context);
  if (!element) return { status: "target_not_found", ok: false, reasons: [reason ?? "parameter target not found"], taxonomy: taxonomy() };

  const resolvedElementId = elementIdentifier(element);
  if (resolvedElementId === null) return { status: "target_not_found", ok: false, reasons: ["parameter target is missing a valid element id"], taxonomy: taxonomy() };

  const resolvedName = resolvedParameterName(element, parameterName);
  const existingValue = parameterValue(element, resolvedName);
  if (existingValue === null) {
    return { status: "target_not_found", ok: false, reasons: [`parameter '${parameterName}' not found in mock context`], taxonomy: taxonomy() };
  }

  const expectedExistingValue = normalizedText(action.expectedExistingValue);
  const targetPayload = {
    elementId: resolvedElementId,
    category: elementCategory(element) || undefined,
    familyName: elementFamily(element) || undefined,
    typeName: elementType(element) || undefined,
    parameterName: resolvedName,
    existingValue
  };

  if (expectedExistingValue && existingValue !== expectedExistingValue) {
    return {
      status: "needs_human_review",
      ok: false,
      reasons: [`original-value mismatch: expected '${expectedExistingValue}' but mock readback found '${existingValue}'`],
      taxonomy: taxonomy(),
      target: targetPayload
    };
  }

  if (existingValue === replacementValue) {
    return {
      status: "needs_human_review",
      ok: false,
      reasons: ["requested parameter edit produces no value change"],
      taxonomy: taxonomy(),
      target: targetPayload
    };
  }

  return {
    status: "success",
    ok: true,
    reasons: [],
    taxonomy: taxonomy(),
    target: targetPayload
  };
}

export function planRedlineUpdateParameterDryRun(
  action: RedlineUpdateParameterAction,
  context: RedlineUpdateParameterContext
): RedlineUpdateParameterPlan {
  const validation = validateRedlineUpdateParameter(action, context);
  const target = validation.target;
  return {
    status: validation.status,
    validation,
    endpoint: "/revit/set-parameter",
    benchmarkTaskId: "demo_redline_update_parameter",
    request: {
      dryRun: true,
      apply: false,
      mockOnly: true,
      readbackRequired: true,
      operationClass: "parameter_edit",
      targetClass: "model_parameter",
      evidenceRequirements: ["parameter_readback"],
      ...(target?.elementId ? { elementIds: [target.elementId] } : {}),
      ...(target?.parameterName ? { parameterName: target.parameterName } : {}),
      expectedExistingValue: normalizedText(action.expectedExistingValue || target?.existingValue),
      value: normalizedText(action.replacementValue),
      revertAfterVerify: action.revertAfterVerify === true,
      ...(elementId(action.viewId) ? { viewId: elementId(action.viewId) } : {}),
      ...(elementId(action.visualViewId ?? action.viewId) ? { visualViewId: elementId(action.visualViewId ?? action.viewId) } : {})
    },
    requiredContext: [
      "exact element id or unique category/family/type target",
      "parameter name",
      "expected existing value",
      "replacement value",
      "parameter readback"
    ],
    requiredEvidence: ["parameter_readback"]
  };
}

export function executeRedlineUpdateParameterMock(
  action: RedlineUpdateParameterAction,
  context: RedlineUpdateParameterContext
): RedlineUpdateParameterExecution {
  const plan = planRedlineUpdateParameterDryRun(action, context);
  const validation = plan.validation;
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
      message: validation.reasons.join("; ") || "parameter update validation failed"
    };
  }

  const before = validation.target.existingValue;
  const after = normalizedText(action.replacementValue);
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
    parameterReadback: {
      kind: "parameter_readback",
      elementId: validation.target.elementId,
      parameterName: validation.target.parameterName,
      before,
      after,
      ...(action.revertAfterVerify === true ? { revertedTo: before } : {})
    },
    message: action.apply === true
      ? "Mock apply simulation produced before/after parameter_readback without live Revit calls."
      : "Dry-run parameter update plan produced without live Revit calls."
  };
}

export function verifyRedlineUpdateParameter(
  action: RedlineUpdateParameterAction,
  execution: RedlineUpdateParameterExecution,
  readbackValue?: string,
  revertReadbackValue?: string
): RedlineUpdateParameterVerification {
  const requestedValue = normalizedText(action.replacementValue);
  const actualReadback = normalizedText(readbackValue ?? execution.parameterReadback?.after);
  const checks: RedlineUpdateParameterVerification["checks"] = [
    {
      name: "requested_value_present",
      ok: Boolean(requestedValue),
      expected: "non-empty replacement value",
      actual: requestedValue
    },
    {
      name: "parameter_readback_matches_requested_value",
      ok: Boolean(requestedValue) && actualReadback === requestedValue,
      expected: requestedValue,
      actual: actualReadback
    }
  ];

  if (action.revertAfterVerify === true) {
    const expectedRevert = normalizedText(execution.parameterReadback?.before);
    const actualRevert = normalizedText(revertReadbackValue ?? execution.parameterReadback?.revertedTo);
    checks.push({
      name: "revert_readback_matches_original_value",
      ok: Boolean(expectedRevert) && actualRevert === expectedRevert,
      expected: expectedRevert,
      actual: actualRevert
    });
  }

  const ok = execution.status === "success" && checks.every((check) => check.ok);
  return {
    status: ok ? "success" : "verification_failed",
    ok,
    checks
  };
}
