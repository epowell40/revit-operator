import { normalizeTextNoteTextV1, textNoteRoundTripMatchesV1 } from "@revitoperator/text-note-round-trip-v1";
import { nativeArtifactReceiptEffectV1 } from "@revitoperator/assignment-kernel-v2-contracts";
import { admitsMepDuctPreview } from "./mepDuctPreviewEvidence.js";

type Scalar = string | number | boolean | null;

export type PreviewSemanticFactV2 = Readonly<{
  fact_id: string;
  fact_class: "control" | "domain";
  value: Scalar;
}>;

export type PreviewSemanticEvidenceV2 = Readonly<{
  recognized: boolean;
  admitted: boolean;
  facts: readonly PreviewSemanticFactV2[];
}>;

type Field = Readonly<{
  present: boolean;
  valid: boolean;
  value?: Scalar;
}>;

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function normalizedFieldName(value: string): string {
  return value.normalize("NFKC").replace(/([a-z0-9])([A-Z])/g, "$1_$2").replace(/[\s-]+/g, "_").toLowerCase();
}

function scalar(value: unknown): value is Scalar {
  return value === null || ["string", "number", "boolean"].includes(typeof value);
}

function field(row: Record<string, unknown>, names: readonly string[]): Field {
  const accepted = new Set(names.map(normalizedFieldName));
  const matches = Object.entries(row).filter(([key]) => accepted.has(normalizedFieldName(key)));
  if (matches.length === 0) return { present: false, valid: false };
  if (matches.some(([, value]) => !scalar(value))) return { present: true, valid: false };
  const encoded = new Set(matches.map(([, value]) => JSON.stringify(value)));
  return encoded.size === 1
    ? { present: true, valid: true, value: matches[0]![1] as Scalar }
    : { present: true, valid: false };
}

/** Mirrors TextNoteTextCanonicalizer.Normalize without trimming user content. */
export function normalizeTextNoteTextV2(value: string): string {
  return normalizeTextNoteTextV1(value);
}

function text(fieldValue: Field): string | null {
  return fieldValue.valid && typeof fieldValue.value === "string" ? fieldValue.value : null;
}

function boolean(fieldValue: Field): boolean | null {
  return fieldValue.valid && typeof fieldValue.value === "boolean" ? fieldValue.value : null;
}

function sameIdentity(left: Field, right: Field): boolean {
  if (!left.valid || !right.valid || left.value === null || right.value === null) return false;
  return String(left.value) === String(right.value);
}

function admitsFamilyInstancePreview(input: Readonly<{
  payload: unknown;
  requestBody: unknown;
  requestedEffect: "read" | "preview" | "apply" | undefined;
  authoritativePreview: boolean;
}>): boolean {
  if (!input.authoritativePreview || input.requestedEffect !== "preview") return false;
  const request = object(input.requestBody), result = object(input.payload), transaction = object(result.transaction);
  if (request.dryRun !== true || result.status !== "Dry Run" || result.dryRun !== true
    || transaction.status !== "rolled_back" || transaction.committed !== false) return false;
  for (const key of ["modified_element_ids", "affected_element_ids", "added_element_ids", "deleted_element_ids"]) {
    if (!Array.isArray(transaction[key]) || (transaction[key] as unknown[]).length !== 0) return false;
  }
  if (result.id !== undefined || result.instances !== undefined || result.createdElementIds !== undefined) return false;
  // A sheet/view target is not echoed with enough identity to prove this
  // route's source binding. Keep those modes fail-closed until separately typed.
  if (request.viewId !== undefined || request.sheetNumber !== undefined || result.targetView !== null) return false;
  const family = typeof request.familyName === "string" ? request.familyName.trim() : "";
  const symbol = typeof (request.symbolName ?? request.typeName) === "string"
    ? String(request.symbolName ?? request.typeName).trim() : "";
  const level = typeof request.levelName === "string" ? request.levelName.trim() : "";
  if (!family || !symbol || !level
    || typeof result.familyName !== "string" || result.familyName.trim().toLowerCase() !== family.toLowerCase()
    || typeof result.symbolName !== "string" || result.symbolName.trim().toLowerCase() !== symbol.toLowerCase()
    || typeof result.levelName !== "string" || result.levelName.trim().toLowerCase() !== level.toLowerCase()) return false;
  const count = request.count === undefined ? 1 : request.count;
  if (!Number.isInteger(count) || (count as number) < 1 || (count as number) > 200
    || result.requestedCount !== count) return false;
  const numeric = (value: unknown, fallback?: number): number | null =>
    value === undefined && fallback !== undefined ? fallback
      : typeof value === "number" && Number.isFinite(value) ? value : null;
  const x = numeric(request.x), y = numeric(request.y), z = numeric(request.z);
  const dx = numeric(request.spacingX, 0), dy = numeric(request.spacingY, 0), dz = numeric(request.spacingZ, 0);
  const rotation = numeric(request.rotationDegrees, 0);
  if ([x, y, z, dx, dy, dz, rotation].some(value => value === null)) return false;
  const planned = result.planned;
  if (!Array.isArray(planned) || planned.length !== count) return false;
  const near = (observed: unknown, expected: number): boolean =>
    typeof observed === "number" && Number.isFinite(observed) && Math.abs(observed - expected) <= 1e-6;
  return planned.every((raw, index) => {
    const row = object(raw);
    return row.index === index
      && row.id === undefined && row.elementId === undefined
      && near(row.x, x! + index * dx!)
      && near(row.y, y! + index * dy!)
      && near(row.z, z! + index * dz!)
      && near(row.rotationDegrees, rotation!);
  });
}

function admitsBulkFamilyPreview(input: Readonly<{
  payload: unknown;
  requestBody: unknown;
  requestedEffect: "read" | "preview" | "apply" | undefined;
  authoritativePreview: boolean;
}>): boolean {
  if (!input.authoritativePreview || input.requestedEffect !== "preview") return false;
  const request = object(input.requestBody), result = object(input.payload), transaction = object(result.transaction);
  if (request.dryRun !== true || result.status !== "Planned" || result.error !== null
    || result.familyPlacementType !== "OneLevelBased" || result.requiresExplicitHost !== false
    || result.unhostedWorkPlanePlacementAllowed !== false || result.placedCount !== 0
    || result.skippedCount !== 0 || result.failedCount !== 0
    || result.selectedWorksetId !== null || result.selectedWorksetName !== null
    || !Array.isArray(result.elementIds) || result.elementIds.length !== 0
    || !Array.isArray(result.warnings) || result.warnings.length !== 0
    || transaction.status !== "rolled_back" || transaction.committed !== false) return false;
  for (const key of ["modified_element_ids", "affected_element_ids", "added_element_ids", "deleted_element_ids"]) {
    if (!Array.isArray(transaction[key]) || (transaction[key] as unknown[]).length !== 0) return false;
  }
  if (!Number.isSafeInteger(request.familySymbolId) || (request.familySymbolId as number) <= 0
    || !Number.isSafeInteger(request.viewId) || (request.viewId as number) <= 0
    || typeof request.levelName !== "string" || !request.levelName.trim()
    || request.worksetId !== undefined || request.worksetName !== undefined
    || request.allowUnhostedWorkPlanePlacement === true) return false;
  const instances = request.instances, rows = result.results;
  if (!Array.isArray(instances) || !Array.isArray(rows) || instances.length < 1
    || instances.length > 200 || rows.length !== instances.length) return false;
  const near = (observed: unknown, expected: unknown): boolean =>
    typeof observed === "number" && Number.isFinite(observed)
    && typeof expected === "number" && Number.isFinite(expected)
    && Math.abs(observed - expected) <= 1e-6;
  return instances.every((raw, index) => {
    const requested = object(raw), row = object(rows[index]);
    const bbox = [row.bboxMinX, row.bboxMinY, row.bboxMinZ, row.bboxMaxX, row.bboxMaxY, row.bboxMaxZ];
    return requested.coordinateMode === "absolute_model"
      && requested.levelName === undefined && requested.hostElementId === undefined
      && requested.linkedHostElementId === undefined && requested.parameters === undefined
      && (requested.rotationDegrees === undefined || requested.rotationDegrees === 0)
      && row.index === index && row.status === "planned" && row.reason === "dryRun: rolled back"
      && row.elementId === null && row.coordinateMode === "absolute_model"
      && row.familySymbolId === request.familySymbolId
      && row.hostElementId === null && row.linkedHostElementId === null
      && row.absoluteModelLocationVerified === true
      && typeof row.absoluteModelCorrectionDistanceFt === "number"
      && Number.isFinite(row.absoluteModelCorrectionDistanceFt) && row.absoluteModelCorrectionDistanceFt >= 0
      && row.inTargetViewCollector === true && row.viewSpecificBoundingBoxAvailable === true
      && Array.isArray(row.warnings) && row.warnings.length === 0
      && near(row.requestedLocationX, requested.x) && near(row.locationX, requested.x)
      && near(row.requestedLocationY, requested.y) && near(row.locationY, requested.y)
      && near(row.requestedLocationZ, requested.z) && near(row.locationZ, requested.z)
      && bbox.every(value => typeof value === "number" && Number.isFinite(value))
      && (row.bboxMinX as number) <= (row.locationX as number) && (row.locationX as number) <= (row.bboxMaxX as number)
      && (row.bboxMinY as number) <= (row.locationY as number) && (row.locationY as number) <= (row.bboxMaxY as number)
      && (row.bboxMinZ as number) <= (row.locationZ as number) && (row.locationZ as number) <= (row.bboxMaxZ as number);
  });
}

/**
 * Produces route-typed semantic evidence for a native rollback preview.
 * Unknown routes are denied by default: native success and rollback truth are
 * necessary effect evidence, but are not sufficient proof that the requested
 * domain proposal was actually evaluated.
 */
export function previewSemanticEvidenceV2(input: Readonly<{
  path: string;
  payload: unknown;
  requestBody: unknown;
  requestedEffect: "read" | "preview" | "apply" | undefined;
  authoritativePreview: boolean;
}>): PreviewSemanticEvidenceV2 {
  const path = input.path.toLowerCase();
  if (path === "/revit/existing-conditions-mep-draft-workflow") {
    const request = object(input.requestBody), result = object(input.payload);
    const requested = Array.isArray(request.operations) ? request.operations.map(object) : [];
    const reported = Array.isArray(result.operations) ? result.operations.map(object) : [];
    const outputs = Array.isArray(result.operationOutputs) ? result.operationOutputs.map(object) : [];
    const transient = Array.isArray(result.transientCreatedElementIds) ? result.transientCreatedElementIds : [];
    const residual = result.residualCreatedElementIds;
    const target = object(result.targetView), acceptance = object(result.targetViewAcceptance);
    const idsValid = transient.length > 0 && transient.every(id => Number.isSafeInteger(id) && (id as number) > 0)
      && new Set(transient).size === transient.length;
    const operationsMatch = requested.length > 0 && requested.length === reported.length && reported.length === outputs.length
      && requested.every((row, index) => row.action_key === reported[index]?.actionKey
        && row.path === reported[index]?.path && row.action_key === outputs[index]?.action_key
        && JSON.stringify(outputs[index]?.created_element_ids) === JSON.stringify(reported[index]?.transientCreatedElementIds));
    const allReportedIds = reported.flatMap(row => Array.isArray(row.transientCreatedElementIds) ? row.transientCreatedElementIds : []);
    const admitted = input.authoritativePreview && input.requestedEffect === "preview"
      && request.dryRun === true && result.dryRun === true
      && result.schema === "operator.existing_conditions_mep_draft_workflow.v1"
      && result.status === "DryRunReady" && result.transactionGroupRolledBack === true
      && result.rollbackVerified === true && result.atomic === true && result.error === null
      && Array.isArray(residual) && residual.length === 0
      && Array.isArray(result.createdElementIds) && result.createdElementIds.length === 0
      && idsValid && operationsMatch && JSON.stringify(allReportedIds) === JSON.stringify(transient)
      && result.operationCount === requested.length
      && typeof request.stageKey === "string" && request.stageKey.length > 0 && result.stageKey === request.stageKey
      && typeof request.inputFingerprintSha256 === "string"
      && /^[a-f0-9]{64}$/i.test(request.inputFingerprintSha256)
      && result.inputFingerprintSha256 === request.inputFingerprintSha256
      && (!Number.isSafeInteger(request.targetViewId) || target.id === request.targetViewId)
      && (request.requireAllCreatedElementsVisibleInTargetView !== true || acceptance.passed === true);
    return { recognized: true, admitted, facts: admitted ? [
      { fact_id: "task.preview_valid", fact_class: "domain", value: true },
      { fact_id: "task.preview_created_element_count", fact_class: "domain", value: transient.length }
    ] : [] };
  }
  if (path === "/revit/create-family-instance") {
    const admitted = admitsFamilyInstancePreview(input);
    return { recognized: true, admitted, facts: admitted ? [
      { fact_id: "task.preview_valid", fact_class: "domain", value: true }
    ] : [] };
  }
  if (path === "/revit/place-families") {
    const admitted = admitsBulkFamilyPreview(input);
    return { recognized: true, admitted, facts: admitted ? [
      { fact_id: "task.preview_valid", fact_class: "domain", value: true }
    ] : [] };
  }
  if (path === "/revit/create-duct" || path === "/revit/create-mep-route" && object(input.payload).kind === "duct") {
    const admitted = input.authoritativePreview && input.requestedEffect === "preview"
      && admitsMepDuctPreview(path, input.payload, input.requestBody);
    return { recognized: true, admitted, facts: admitted ? [
      { fact_id: "task.preview_valid", fact_class: "domain", value: true }
    ] : [] };
  }
  if (path === "/revit/export-elements-xlsx") {
    const result = object(input.payload), receipt = object(result.artifact_receipt), request = object(input.requestBody);
    const ids = request.elementIds, names = request.parameterNames;
    const admitted = input.authoritativePreview && input.requestedEffect === "preview" && result.ok === true && result.dryRun === true
      && nativeArtifactReceiptEffectV1(receipt, "POST", path, "preview") === "none"
      && Array.isArray(ids) && ids.length > 0 && ids.length <= 2000 && ids.every(id => Number.isSafeInteger(id) && id > 0)
      && new Set(ids).size === ids.length && JSON.stringify(result.selectedElementIds) === JSON.stringify(ids)
      && result.selectedCount === ids.length && Array.isArray(names) && names.length > 0 && names.length <= 100
      && names.every(name => typeof name === "string" && name.trim().length > 0)
      && new Set(names.map(name => String(name).trim().toLowerCase())).size === names.length
      && result.parameterCount === names.length && JSON.stringify(result.parameterNames) === JSON.stringify(names.map(name => String(name).trim()))
      && typeof result.path === "string" && JSON.stringify(receipt.expected_output_paths) === JSON.stringify([result.path]);
    return { recognized: true, admitted, facts: admitted ? [
      { fact_id: "task.preview_valid", fact_class: "domain", value: true },
      { fact_id: "artifact.planned_output_count", fact_class: "domain", value: 1 }
    ] : [] };
  }
  if (path === "/revit/export-pdf" || path === "/revit/print") {
    const result = object(input.payload), receipt = object(result.artifact_receipt), request = object(input.requestBody);
    const sheets = Array.isArray(result.selectedSheets) ? result.selectedSheets.map(object) : [];
    const outputs = object(result.preflight).outputs;
    const requestedIds = Array.isArray(request.viewIds) ? request.viewIds : null;
    const ids = sheets.map(s => s.viewId);
    const admitted = input.authoritativePreview && input.requestedEffect === "preview" && result.ok === true && result.dryRun === true
      && nativeArtifactReceiptEffectV1(receipt, "POST", path, "preview") === "none"
      && Number.isInteger(result.selectedCount) && result.selectedCount === sheets.length && sheets.length > 0
      && ids.every(id => typeof id === "number" && Number.isInteger(id) && id > 0) && new Set(ids).size === ids.length
      && (!requestedIds || requestedIds.length === ids.length && requestedIds.every(id => ids.includes(id)))
      && Array.isArray(outputs) && JSON.stringify(outputs) === JSON.stringify(receipt.expected_output_paths);
    return { recognized: true, admitted, facts: admitted ? [
      { fact_id: "task.preview_valid", fact_class: "domain", value: true },
      { fact_id: "artifact.planned_output_count", fact_class: "domain", value: (outputs as unknown[]).length }
    ] : [] };
  }
  if (path !== "/revit/replace-text-note" && path !== "/revit/set-text-note-text") {
    return { recognized: false, admitted: false, facts: [] };
  }

  const result = object(input.payload);
  const request = object(input.requestBody);
  const resultTarget = field(result, ["text_note_id", "textNoteId", "element_id", "elementId"]);
  const requestTarget = field(request, ["text_note_id", "textNoteId", "element_id", "elementId"]);
  const before = text(field(result, ["before"]));
  const after = text(field(result, ["after"]));
  const proposed = text(field(result, ["proposed_text", "proposedText"]));
  const requested = text(field(request, ["new_text", "newText"]));
  const changed = boolean(field(result, ["changed"]));
  const dryRun = boolean(field(result, ["dry_run", "dryRun"]));

  const targetMatches = sameIdentity(resultTarget, requestTarget);
  const proposalMatches = proposed !== null && requested !== null
    && normalizeTextNoteTextV2(proposed) === normalizeTextNoteTextV2(requested);
  const stateUnchanged = before !== null && after !== null
    && normalizeTextNoteTextV2(before) === normalizeTextNoteTextV2(after);
  const changedConsistent = before !== null && proposed !== null && changed !== null
    && changed === !textNoteRoundTripMatchesV1(proposed, before);
  const admitted = input.requestedEffect === "preview"
    && input.authoritativePreview
    && dryRun === true
    && targetMatches
    && proposalMatches
    && stateUnchanged
    && changedConsistent;

  const facts: PreviewSemanticFactV2[] = [];
  if (resultTarget.valid && resultTarget.value !== undefined) {
    facts.push({ fact_id: "text_note.element_id", fact_class: "domain", value: resultTarget.value });
  }
  if (before !== null) facts.push({ fact_id: "text_note.before", fact_class: "domain", value: before });
  if (after !== null) facts.push({ fact_id: "text_note.after", fact_class: "domain", value: after });
  if (proposed !== null) facts.push({ fact_id: "text_note.proposed", fact_class: "domain", value: proposed });
  if (changed !== null) facts.push({ fact_id: "text_note.changed", fact_class: "domain", value: changed });
  if (input.requestedEffect === "preview") {
    facts.push(
      { fact_id: "control.preview_semantic_adapter_available", fact_class: "control", value: true },
      { fact_id: "control.preview_proposal_present", fact_class: "control", value: proposed !== null },
      { fact_id: "control.preview_proposal_matches_request", fact_class: "control", value: proposalMatches },
      { fact_id: "control.preview_target_matches_request", fact_class: "control", value: targetMatches },
      { fact_id: "control.preview_actual_state_unchanged", fact_class: "control", value: stateUnchanged },
      { fact_id: "control.preview_changed_consistent", fact_class: "control", value: changedConsistent }
    );
  }
  if (admitted) facts.push({ fact_id: "task.preview_valid", fact_class: "domain", value: true });
  return { recognized: true, admitted, facts };
}
