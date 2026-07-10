export type RedlineScheduleTextEditStatus =
  | "success"
  | "failed"
  | "needs_human_review"
  | "target_not_found"
  | "invalid_parameter"
  | "verification_failed";

export type RedlineScheduleTextEditAction = {
  operation?: "text_edit" | string;
  target?: "schedule" | string;
  scheduleId?: number;
  scheduleName?: string;
  rowKey?: string;
  rowIndex?: number;
  cellId?: string;
  fieldName?: string;
  expectedExistingValue?: string;
  replacementValue?: string;
  dryRun?: boolean;
  apply?: boolean;
  revertAfterVerify?: boolean;
};

export type RedlineScheduleTextEditContext = {
  schedules?: RedlineScheduleTextEditSchedule[];
};

export type RedlineScheduleTextEditSchedule = {
  schedule_id?: number;
  scheduleId?: number;
  id?: number;
  name?: string;
  fields?: string[];
  rows?: RedlineScheduleTextEditRow[];
};

export type RedlineScheduleTextEditRow = {
  row_key?: string;
  rowKey?: string;
  row_index?: number;
  rowIndex?: number;
  cell_id?: string;
  cellId?: string;
  element_id?: number;
  elementId?: number;
  values?: Record<string, string>;
};

export type RedlineScheduleTextEditValidation = {
  status: RedlineScheduleTextEditStatus;
  ok: boolean;
  reasons: string[];
  taxonomy: {
    operation_class: "text_edit";
    target_class: "schedule";
    context_class: "schedule";
    evidence_requirements: ["schedule_readback"];
  };
  target?: {
    scheduleId: number | null;
    scheduleName: string;
    elementId?: number;
    rowKey?: string;
    rowIndex?: number;
    cellId?: string;
    fieldName: string;
    existingValue: string;
  };
};

export type RedlineScheduleTextEditPlan = {
  status: RedlineScheduleTextEditStatus;
  validation: RedlineScheduleTextEditValidation;
  endpoint: "/revit/set-parameter";
  request: Record<string, unknown>;
  scheduleReadbackRequest: Record<string, unknown>;
  requiredContext: string[];
  requiredEvidence: ["schedule_readback"];
};

export type RedlineScheduleTextEditExecution = {
  status: RedlineScheduleTextEditStatus;
  validation: RedlineScheduleTextEditValidation;
  plan: RedlineScheduleTextEditPlan;
  executionSource: "mock";
  executionMode: "dry_run_simulation" | "mock_apply_simulation";
  liveBridgeCall: false;
  writeGrantRequired: false;
  mockApplied: boolean;
  scheduleReadback?: {
    kind: "schedule_cell";
    scheduleId: number | null;
    scheduleName: string;
    rowKey?: string;
    rowIndex?: number;
    cellId?: string;
    field: string;
    before: string;
    after: string;
    revertedTo?: string;
  };
  message: string;
};

export type RedlineScheduleTextEditVerification = {
  status: RedlineScheduleTextEditStatus;
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

function scheduleId(schedule: RedlineScheduleTextEditSchedule): number | null {
  const value = schedule.schedule_id ?? schedule.scheduleId ?? schedule.id;
  return Number.isInteger(value) && Number(value) > 0 ? Number(value) : null;
}

function rowKey(row: RedlineScheduleTextEditRow): string {
  return normalizedText(row.row_key ?? row.rowKey);
}

function rowIndex(row: RedlineScheduleTextEditRow): number | null {
  const value = row.row_index ?? row.rowIndex;
  return Number.isInteger(value) && Number(value) >= 0 ? Number(value) : null;
}

function cellId(row: RedlineScheduleTextEditRow): string {
  return normalizedText(row.cell_id ?? row.cellId);
}

function rowElementId(row: RedlineScheduleTextEditRow): number | null {
  const value = row.element_id ?? row.elementId;
  return Number.isInteger(value) && Number(value) > 0 ? Number(value) : null;
}

function findSchedule(action: RedlineScheduleTextEditAction, context: RedlineScheduleTextEditContext): RedlineScheduleTextEditSchedule | null {
  const schedules = context.schedules ?? [];
  const wantedId = Number.isInteger(action.scheduleId) && Number(action.scheduleId) > 0 ? Number(action.scheduleId) : null;
  const wantedName = normalizedText(action.scheduleName).toLowerCase();
  return schedules.find((schedule) => {
    if (wantedId !== null && scheduleId(schedule) === wantedId) return true;
    return Boolean(wantedName) && normalizedText(schedule.name).toLowerCase() === wantedName;
  }) ?? null;
}

function findRow(action: RedlineScheduleTextEditAction, schedule: RedlineScheduleTextEditSchedule): RedlineScheduleTextEditRow | null {
  const rows = schedule.rows ?? [];
  const wantedKey = normalizedText(action.rowKey);
  const wantedCellId = normalizedText(action.cellId);
  const wantedIndex = Number.isInteger(action.rowIndex) && Number(action.rowIndex) >= 0 ? Number(action.rowIndex) : null;
  if (wantedKey) {
    return rows.find((row) => rowKey(row) === wantedKey) ?? null;
  }
  if (wantedCellId) {
    return rows.find((row) => cellId(row) === wantedCellId) ?? null;
  }
  if (wantedIndex !== null) {
    return rows.find((row, index) => rowIndex(row) === wantedIndex || index === wantedIndex) ?? null;
  }
  return null;
}

function actionHasRowScope(action: RedlineScheduleTextEditAction): boolean {
  return Boolean(normalizedText(action.rowKey) || normalizedText(action.cellId)) ||
    (Number.isInteger(action.rowIndex) && Number(action.rowIndex) >= 0);
}

function fieldValue(row: RedlineScheduleTextEditRow, fieldName: string): string | null {
  const values = row.values ?? {};
  if (Object.prototype.hasOwnProperty.call(values, fieldName)) return String(values[fieldName]);
  const normalizedField = fieldName.toLowerCase();
  const key = Object.keys(values).find((entry) => entry.toLowerCase() === normalizedField);
  return key ? String(values[key]) : null;
}

export function validateRedlineScheduleTextEdit(
  action: RedlineScheduleTextEditAction,
  context: RedlineScheduleTextEditContext
): RedlineScheduleTextEditValidation {
  const reasons: string[] = [];
  const operation = normalizedText(action.operation || "text_edit");
  const target = normalizedText(action.target || "schedule");
  const fieldName = normalizedText(action.fieldName);
  const replacementValue = normalizedText(action.replacementValue);

  if (operation !== "text_edit") reasons.push(`unsupported operation '${operation || "<missing>"}'; expected text_edit`);
  if (target !== "schedule") reasons.push(`unsupported target '${target || "<missing>"}'; expected schedule`);
  if (!Number.isInteger(action.scheduleId) && !normalizedText(action.scheduleName)) reasons.push("missing schedule target: provide scheduleId or scheduleName");
  if (!fieldName) reasons.push("missing field/cell target: provide fieldName");
  if (!actionHasRowScope(action)) reasons.push("missing field/cell target: provide rowKey, rowIndex, or cellId");
  if (!replacementValue) reasons.push("missing replacement value");

  const base = {
    taxonomy: {
      operation_class: "text_edit" as const,
      target_class: "schedule" as const,
      context_class: "schedule" as const,
      evidence_requirements: ["schedule_readback"] as ["schedule_readback"]
    }
  };

  if (reasons.length > 0) {
    return { ...base, status: "invalid_parameter", ok: false, reasons };
  }

  const schedule = findSchedule(action, context);
  if (!schedule) {
    return { ...base, status: "target_not_found", ok: false, reasons: ["schedule target not found in mock context"] };
  }

  const row = findRow(action, schedule);
  if (!row) {
    return { ...base, status: "target_not_found", ok: false, reasons: ["schedule row/cell target not found in mock context"] };
  }

  const fields = schedule.fields ?? [];
  const resolvedField = fields.find((field) => field.toLowerCase() === fieldName.toLowerCase()) ?? fieldName;
  if (fields.length > 0 && !fields.some((field) => field.toLowerCase() === fieldName.toLowerCase())) {
    return { ...base, status: "target_not_found", ok: false, reasons: [`schedule field '${fieldName}' not found in mock context`] };
  }

  const existingValue = fieldValue(row, resolvedField);
  if (existingValue === null) {
    return { ...base, status: "target_not_found", ok: false, reasons: [`schedule cell value for '${resolvedField}' not found in mock context`] };
  }

  const expectedExistingValue = normalizedText(action.expectedExistingValue);
  if (expectedExistingValue && existingValue !== expectedExistingValue) {
    return {
      ...base,
      status: "needs_human_review",
      ok: false,
      reasons: [`original-value mismatch: expected '${expectedExistingValue}' but mock readback found '${existingValue}'`],
      target: {
        scheduleId: scheduleId(schedule),
        scheduleName: normalizedText(schedule.name),
        ...(rowElementId(row) !== null ? { elementId: rowElementId(row) ?? undefined } : {}),
        ...(rowKey(row) ? { rowKey: rowKey(row) } : {}),
        ...(rowIndex(row) !== null ? { rowIndex: rowIndex(row) ?? undefined } : {}),
        ...(cellId(row) ? { cellId: cellId(row) } : {}),
        fieldName: resolvedField,
        existingValue
      }
    };
  }

  return {
    ...base,
    status: "success",
    ok: true,
    reasons: [],
    target: {
      scheduleId: scheduleId(schedule),
      scheduleName: normalizedText(schedule.name),
      ...(rowElementId(row) !== null ? { elementId: rowElementId(row) ?? undefined } : {}),
      ...(rowKey(row) ? { rowKey: rowKey(row) } : {}),
      ...(rowIndex(row) !== null ? { rowIndex: rowIndex(row) ?? undefined } : {}),
      ...(cellId(row) ? { cellId: cellId(row) } : {}),
      fieldName: resolvedField,
      existingValue
    }
  };
}

export function planRedlineScheduleTextEditDryRun(
  action: RedlineScheduleTextEditAction,
  context: RedlineScheduleTextEditContext
): RedlineScheduleTextEditPlan {
  const validation = validateRedlineScheduleTextEdit(action, context);
  const target = validation.target;
  const replacementValue = normalizedText(action.replacementValue);
  const request: Record<string, unknown> = {
    changes: target?.elementId
      ? [{ elementId: target.elementId, parameterName: target.fieldName, value: replacementValue }]
      : [],
    preserveTextCase: true,
    dryRun: true,
    apply: false,
    operationClass: "text_edit",
    targetClass: "schedule",
    scheduleId: target?.scheduleId,
    scheduleName: target?.scheduleName,
    targetRowKey: target?.rowKey,
    targetRowIndex: target?.rowIndex,
    targetCellId: target?.cellId,
    targetFieldName: target?.fieldName,
    expectedExistingValue: normalizedText(action.expectedExistingValue),
    requestedTextOrValue: replacementValue,
    revertAfterVerify: action.revertAfterVerify === true,
    evidenceRequirements: ["schedule_readback"],
    readbackRequired: true
  };
  const scheduleReadbackRequest: Record<string, unknown> = {
    scheduleId: target?.scheduleId,
    scheduleName: target?.scheduleName,
    delimiter: "comma",
    expectedRowKey: target?.rowKey,
    expectedFieldName: target?.fieldName,
    expectedValue: replacementValue
  };

  return {
    status: validation.status,
    validation,
    endpoint: "/revit/set-parameter",
    request,
    scheduleReadbackRequest,
    requiredContext: [
      "existing schedule id or name",
      "backing element id",
      "row key, row index, or cell id",
      "target field name",
      "expected existing value",
      "replacement value"
    ],
    requiredEvidence: ["schedule_readback"]
  };
}

export function executeRedlineScheduleTextEditMock(
  action: RedlineScheduleTextEditAction,
  context: RedlineScheduleTextEditContext
): RedlineScheduleTextEditExecution {
  const plan = planRedlineScheduleTextEditDryRun(action, context);
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
      mockApplied: false,
      message: validation.reasons.join("; ") || "schedule text edit validation failed"
    };
  }

  const after = normalizedText(action.replacementValue);
  const before = validation.target.existingValue;
  return {
    status: "success",
    validation,
    plan: {
      ...plan,
      request: {
        ...plan.request,
        dryRun: true,
        apply: false,
        mockOnly: true
      }
    },
    executionSource: "mock",
    executionMode: action.apply === true ? "mock_apply_simulation" : "dry_run_simulation",
    liveBridgeCall: false,
    writeGrantRequired: false,
    mockApplied: action.apply === true,
    scheduleReadback: {
      kind: "schedule_cell",
      scheduleId: validation.target.scheduleId,
      scheduleName: validation.target.scheduleName,
      ...(validation.target.rowKey ? { rowKey: validation.target.rowKey } : {}),
      ...(validation.target.rowIndex !== undefined ? { rowIndex: validation.target.rowIndex } : {}),
      ...(validation.target.cellId ? { cellId: validation.target.cellId } : {}),
      field: validation.target.fieldName,
      before,
      after,
      ...(action.revertAfterVerify === true ? { revertedTo: before } : {})
    },
    message: action.apply === true
      ? "Mock apply simulation produced before/after schedule_readback evidence without live Revit calls."
      : "Dry-run schedule text edit plan produced without live Revit calls."
  };
}

export function verifyRedlineScheduleTextEdit(
  action: RedlineScheduleTextEditAction,
  execution: RedlineScheduleTextEditExecution,
  readbackValue?: string,
  revertReadbackValue?: string
): RedlineScheduleTextEditVerification {
  const requestedValue = normalizedText(action.replacementValue);
  const actualReadback = normalizedText(readbackValue ?? execution.scheduleReadback?.after);
  const checks = [
    {
      name: "requested_value_present",
      ok: Boolean(requestedValue),
      expected: "non-empty replacement value",
      actual: requestedValue
    },
    {
      name: "readback_matches_requested_value",
      ok: Boolean(requestedValue) && actualReadback === requestedValue,
      expected: requestedValue,
      actual: actualReadback
    }
  ];

  if (action.revertAfterVerify === true) {
    const expectedRevert = normalizedText(execution.scheduleReadback?.before);
    const actualRevert = normalizedText(revertReadbackValue ?? execution.scheduleReadback?.revertedTo);
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
