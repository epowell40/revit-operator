export type RedlineTextNoteEditStatus =
  | "success"
  | "failed"
  | "needs_human_review"
  | "target_not_found"
  | "invalid_parameter"
  | "verification_failed";

export type RedlineTextNoteEditPoint = {
  x: number;
  y: number;
  z?: number;
};

export type RedlineTextNoteEditAction = {
  operation?: "text_edit" | string;
  target?: "text" | "text_note" | string;
  viewId?: number;
  textNoteId?: number;
  expectedExistingText?: string;
  replacementText?: string;
  dryRun?: boolean;
  apply?: boolean;
  revertAfterVerify?: boolean;
};

export type RedlineTextNoteEditContext = {
  views?: Array<{
    view_id?: number;
    viewId?: number;
    id?: number;
    name?: string;
    view_type?: string;
    viewType?: string;
  }>;
  text_notes?: RedlineTextNoteEditTextNote[];
  textNotes?: RedlineTextNoteEditTextNote[];
};

export type RedlineTextNoteEditTextNote = {
  text_note_id?: number;
  textNoteId?: number;
  element_id?: number;
  elementId?: number;
  id?: number;
  view_id?: number;
  viewId?: number;
  text?: string;
  visibleText?: string;
  position?: RedlineTextNoteEditPoint;
};

export type RedlineTextNoteEditValidation = {
  status: RedlineTextNoteEditStatus;
  ok: boolean;
  reasons: string[];
  taxonomy: {
    operation_class: "text_edit";
    target_class: "text";
    context_class: "annotation";
    evidence_requirements: ["annotation_inventory"];
  };
  target?: {
    textNoteId: number;
    viewId?: number;
    existingText: string;
    position?: RedlineTextNoteEditPoint;
  };
};

export type RedlineTextNoteEditPlan = {
  status: RedlineTextNoteEditStatus;
  validation: RedlineTextNoteEditValidation;
  endpoint: "/revit/replace-text-note";
  request: Record<string, unknown>;
  requiredContext: string[];
  requiredEvidence: ["annotation_inventory"];
};

export type RedlineTextNoteEditExecution = {
  status: RedlineTextNoteEditStatus;
  validation: RedlineTextNoteEditValidation;
  plan: RedlineTextNoteEditPlan;
  executionSource: "mock";
  executionMode: "dry_run_simulation" | "mock_apply_simulation";
  liveBridgeCall: false;
  writeGrantRequired: false;
  mockOnly: true;
  mockApplied: boolean;
  annotationInventory?: {
    kind: "annotation_inventory";
    textNoteId: number;
    viewId?: number;
    position?: RedlineTextNoteEditPoint;
    before: string;
    after: string;
    revertedTo?: string;
  };
  message: string;
};

export type RedlineTextNoteEditVerification = {
  status: RedlineTextNoteEditStatus;
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

function textNoteId(note: RedlineTextNoteEditTextNote): number | null {
  return elementId(note.text_note_id ?? note.textNoteId ?? note.element_id ?? note.elementId ?? note.id);
}

function viewId(note: RedlineTextNoteEditTextNote): number | undefined {
  return elementId(note.view_id ?? note.viewId) ?? undefined;
}

function noteText(note: RedlineTextNoteEditTextNote): string {
  return normalizedText(note.text ?? note.visibleText);
}

function textNotes(context: RedlineTextNoteEditContext): RedlineTextNoteEditTextNote[] {
  return context.text_notes ?? context.textNotes ?? [];
}

function point(value: unknown): RedlineTextNoteEditPoint | undefined {
  if (!value || typeof value !== "object") return undefined;
  const candidate = value as Record<string, unknown>;
  const x = candidate.x;
  const y = candidate.y;
  const z = candidate.z;
  if (typeof x !== "number" || !Number.isFinite(x) || typeof y !== "number" || !Number.isFinite(y)) return undefined;
  return { x, y, z: typeof z === "number" && Number.isFinite(z) ? z : 0 };
}

function baseTaxonomy(): RedlineTextNoteEditValidation["taxonomy"] {
  return {
    operation_class: "text_edit",
    target_class: "text",
    context_class: "annotation",
    evidence_requirements: ["annotation_inventory"]
  };
}

function findTextNote(
  action: RedlineTextNoteEditAction,
  context: RedlineTextNoteEditContext
): { note?: RedlineTextNoteEditTextNote; reason?: string } {
  const notes = textNotes(context);
  const wantedId = elementId(action.textNoteId);
  const wantedViewId = elementId(action.viewId);
  if (wantedId !== null) {
    const found = notes.find((note) => textNoteId(note) === wantedId && (wantedViewId === null || viewId(note) === wantedViewId));
    return found ? { note: found } : { reason: "text note id not found in mock annotation inventory" };
  }

  const expectedText = normalizedText(action.expectedExistingText);
  if (!expectedText) return { reason: "missing exact text note id or expected existing text" };
  const matches = notes.filter((note) => {
    const viewMatches = wantedViewId === null || viewId(note) === wantedViewId;
    return viewMatches && noteText(note) === expectedText;
  });
  if (matches.length === 1) return { note: matches[0] };
  if (matches.length > 1) return { reason: "ambiguous text note target: provide exact text note id" };
  return { reason: "text note target not found in mock annotation inventory" };
}

export function validateRedlineTextNoteEdit(
  action: RedlineTextNoteEditAction,
  context: RedlineTextNoteEditContext
): RedlineTextNoteEditValidation {
  const reasons: string[] = [];
  const operation = normalizedText(action.operation || "text_edit");
  const target = normalizedText(action.target || "text");
  const replacementText = normalizedText(action.replacementText);

  if (operation !== "text_edit") reasons.push(`unsupported operation '${operation || "<missing>"}'; expected text_edit`);
  if (!["text", "text_note"].includes(target)) reasons.push(`unsupported target '${target || "<missing>"}'; expected text or text_note`);
  if (!replacementText) reasons.push("missing replacement text");

  const taxonomy = baseTaxonomy();
  if (reasons.length > 0) return { status: "invalid_parameter", ok: false, reasons, taxonomy };

  const { note, reason } = findTextNote(action, context);
  if (!note) return { status: "target_not_found", ok: false, reasons: [reason ?? "text note target not found"], taxonomy };

  const resolvedTextNoteId = textNoteId(note);
  if (resolvedTextNoteId === null) return { status: "target_not_found", ok: false, reasons: ["text note target is missing a valid id"], taxonomy };

  const existingText = noteText(note);
  const expectedExistingText = normalizedText(action.expectedExistingText);
  const targetPayload = {
    textNoteId: resolvedTextNoteId,
    viewId: viewId(note),
    existingText,
    position: point(note.position)
  };

  if (expectedExistingText && existingText !== expectedExistingText) {
    return {
      status: "needs_human_review",
      ok: false,
      reasons: [`original-text mismatch: expected '${expectedExistingText}' but mock readback found '${existingText}'`],
      taxonomy,
      target: targetPayload
    };
  }

  if (existingText === replacementText) {
    return {
      status: "needs_human_review",
      ok: false,
      reasons: ["requested text note edit produces no text change"],
      taxonomy,
      target: targetPayload
    };
  }

  return {
    status: "success",
    ok: true,
    reasons: [],
    taxonomy,
    target: targetPayload
  };
}

export function planRedlineTextNoteEditDryRun(
  action: RedlineTextNoteEditAction,
  context: RedlineTextNoteEditContext
): RedlineTextNoteEditPlan {
  const validation = validateRedlineTextNoteEdit(action, context);
  const target = validation.target;
  return {
    status: validation.status,
    validation,
    endpoint: "/revit/replace-text-note",
    request: {
      dryRun: true,
      apply: false,
      mockOnly: true,
      targetKind: "text_note",
      textNote: {
        ...(target?.viewId ? { viewId: target.viewId } : {}),
        ...(target?.textNoteId ? { textNoteId: target.textNoteId } : {}),
        expectedExistingText: normalizedText(action.expectedExistingText || target?.existingText),
        text: normalizedText(action.replacementText),
        readbackRequired: true,
        revertAfterVerify: action.revertAfterVerify === true
      },
      operationClass: "text_edit",
      targetClass: "text",
      evidenceRequirements: ["annotation_inventory"]
    },
    requiredContext: [
      "existing visible text note id or unique expected text",
      "view id when the target is not globally unique",
      "expected existing text",
      "replacement text"
    ],
    requiredEvidence: ["annotation_inventory"]
  };
}

export function executeRedlineTextNoteEditMock(
  action: RedlineTextNoteEditAction,
  context: RedlineTextNoteEditContext
): RedlineTextNoteEditExecution {
  const plan = planRedlineTextNoteEditDryRun(action, context);
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
      message: validation.reasons.join("; ") || "text note edit validation failed"
    };
  }

  const after = normalizedText(action.replacementText);
  const before = validation.target.existingText;
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
      textNoteId: validation.target.textNoteId,
      viewId: validation.target.viewId,
      position: validation.target.position,
      before,
      after,
      ...(action.revertAfterVerify === true ? { revertedTo: before } : {})
    },
    message: action.apply === true
      ? "Mock apply simulation produced before/after text note annotation_inventory without live Revit calls."
      : "Dry-run text note edit plan produced without live Revit calls."
  };
}

export function verifyRedlineTextNoteEdit(
  action: RedlineTextNoteEditAction,
  execution: RedlineTextNoteEditExecution,
  readbackText?: string,
  revertReadbackText?: string
): RedlineTextNoteEditVerification {
  const requestedText = normalizedText(action.replacementText);
  const actualReadback = normalizedText(readbackText ?? execution.annotationInventory?.after);
  const checks: RedlineTextNoteEditVerification["checks"] = [
    {
      name: "requested_text_present",
      ok: Boolean(requestedText),
      expected: "non-empty replacement text",
      actual: requestedText
    },
    {
      name: "annotation_inventory_after_text_matches_request",
      ok: Boolean(requestedText) && actualReadback === requestedText,
      expected: requestedText,
      actual: actualReadback
    }
  ];

  if (action.revertAfterVerify === true) {
    const expectedRevert = normalizedText(execution.annotationInventory?.before);
    const actualRevert = normalizedText(revertReadbackText ?? execution.annotationInventory?.revertedTo);
    checks.push({
      name: "revert_readback_matches_original_text",
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
