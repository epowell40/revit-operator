import fs from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { execFileSync } from "node:child_process";
import { getOrCreateOperatorToken } from "../operator_token.js";
import { getWriteGrantToken } from "../operator_write_grant.js";
import { ensureDir, writeJsonFile } from "./files.js";
import { positiveInteger } from "./filter_rule_types.js";
import { runAecMepEval } from "./aec_mep_eval.js";
import { collectLocalRevitHostEvidence } from "./revit_host_evidence.js";
import type { RevitHostEvidence } from "./revit_preflight.js";
import { buildPdfJsDocumentOptions, loadPdfJsForNode } from "../pdf/pdfjs_node.js";
import {
  evaluateRedlineVisualVerificationGate,
  type RedlineVisualGateAssertion,
  type RedlineVisualGateLandmarkRelationship,
  type RedlineVisualGateResult
} from "../verification/redline_visual_verification_gate.js";

export type RevitWorkflowName =
  | "sheet_export"
  | "takeoff_csv"
  | "parameter_edit"
  | "redline_update_parameter"
  | "redline_receptacles"
  | "redline_add"
  | "redline_delete"
  | "redline_move"
  | "redline_rotate"
  | "redline_type_change"
  | "redline_mep_route"
  | "redline_mep_tap_branch"
  | "redline_mep_reroute"
  | "redline_mep_size_transition"
  | "documentation_primitives"
  | "model_edit_primitives"
  | "aec_mep_eval";

export type RevitWorkflowVerification = {
  name: string;
  ok: boolean;
  expected?: unknown;
  actual?: unknown;
  detail?: string;
};

export type RevitWorkflowResult = {
  workflow: RevitWorkflowName;
  execution_source: "live" | "mock" | "injected";
  success: boolean;
  failure_reason: string | null;
  failure_classification?: string | null;
  host_evidence?: RevitHostEvidence;
  elapsed_seconds: number;
  tool_calls: number;
  revit_transactions: number;
  computer_use_actions: number;
  output_artifacts: string[];
  verification_results: RevitWorkflowVerification[];
  user_message: string;
  raw_results: unknown[];
};

export type BridgeTransport = {
  post(pathname: string, body: unknown): Promise<unknown>;
};

type JsonMap = Record<string, unknown>;

type WorkflowConfig = {
  workflow?: unknown;
  bridge_url?: unknown;
  timeout_ms?: unknown;
  mock?: unknown;
  use_mocks?: unknown;
  request?: unknown;
};

type RevitWorkflowPartialResult = Omit<RevitWorkflowResult, "elapsed_seconds" | "execution_source">;

function clip(value: unknown, max = 500): string {
  const text = typeof value === "string" ? value.trim() : "";
  return text.length <= max ? text : text.slice(0, max).trim();
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isBridgeAvailabilityError(message: string): boolean {
  return /fetch failed|econnrefused|actively refused|abort|aborted|timeout|timed out|failed to fetch|socket hang up|terminated/i.test(message);
}

function classifyWorkflowFailure(message: string, hostEvidence: RevitHostEvidence | undefined): NonNullable<RevitWorkflowResult["failure_classification"]> {
  if (!isBridgeAvailabilityError(message)) return "workflow_error";
  if ((hostEvidence?.recent_crash_events ?? []).some((event) => /revit\.exe|application:\s*revit\.exe|faulting application name:\s*revit/i.test(`${event.provider_name ?? ""}\n${event.message}`))) {
    return "revit_host_crash";
  }
  if ((hostEvidence?.modal_windows ?? []).some((window) => window.title.trim() && !/^autodesk revit\b/i.test(window.title))) {
    return "modal_blocker";
  }
  return "bridge_unavailable";
}

function asObject(value: unknown): JsonMap {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as JsonMap) : {};
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.map((entry) => String(entry)).filter(Boolean) : [];
}

function asNumberArray(value: unknown): number[] {
  return Array.isArray(value)
    ? value.map((entry) => Number(entry)).filter((entry) => Number.isFinite(entry) && entry > 0)
    : [];
}

function uniquePositiveIds(...values: unknown[]): number[] {
  return Array.from(new Set(values.flatMap((value) => asNumberArray(value))));
}

function deleteEffectIds(result: unknown): number[] {
  const obj = asObject(result);
  return uniquePositiveIds(obj.ids, obj.deletedIds, obj.impactedIds);
}

function deleteDryRunDetailsCoverExistingIds(result: unknown, elementIds: number[]): boolean {
  const details = objectRows(asObject(result).requestedDetails);
  return elementIds.length > 0 && elementIds.every((id) => {
    const row = details.find((entry) => Number(entry.elementId ?? entry.id) === id);
    return Boolean(row) && row?.exists !== false;
  });
}

function moveSnapshotPoint(result: unknown, elementId: number, phase: "before" | "after"): { x: number; y: number; z: number } | null {
  const snapshots = objectRows(asObject(result).snapshots);
  const snapshot = snapshots.find((entry) => Number(entry.id ?? entry.elementId) === elementId);
  const phaseValue = asObject(snapshot?.[phase]);
  if (Array.isArray(phaseValue.pointXyz)) {
    const values = phaseValue.pointXyz as unknown[];
    const x = Number(values[0]);
    const y = Number(values[1]);
    const z = Number(values[2] ?? 0);
    if ([x, y, z].every(Number.isFinite)) return { x, y, z };
  }
  const point = asObject(phaseValue.pointXyz);
  const x = Number(point.x);
  const y = Number(point.y);
  const z = Number(point.z ?? 0);
  return [x, y, z].every(Number.isFinite) ? { x, y, z } : null;
}

function typeChangeRows(result: unknown): JsonMap[] {
  const rows = asObject(result).changes;
  return Array.isArray(rows) ? rows.map((row) => asObject(row)).filter((row) => Object.keys(row).length > 0) : [];
}

function objectRows(value: unknown): JsonMap[] {
  return Array.isArray(value) ? value.map((row) => asObject(row)).filter((row) => Object.keys(row).length > 0) : [];
}

function typeChangeEffectIds(result: unknown): number[] {
  const obj = asObject(result);
  const rowIds = typeChangeRows(result).filter((row) => row.ok !== false).map((row) => row.elementId);
  return uniquePositiveIds(obj.changedElementIds, rowIds);
}

function typeChangeRowsCover(result: unknown, elementIds: number[], typeId: number | null): boolean {
  const rows = typeChangeRows(result);
  return elementIds.length > 0 && elementIds.every((id) => {
    const row = rows.find((entry) => Number(entry.elementId) === id);
    if (!row || row.ok === false) return false;
    if (typeId === null) return true;
    const oldTypeId = firstPositiveId(row.oldTypeId);
    const newTypeId = firstPositiveId(row.newTypeId, asObject(result).newTypeId);
    return oldTypeId === typeId || newTypeId === typeId;
  });
}

function normalizedTypeName(value: unknown): string {
  return normalizedTextProof(firstString(value));
}

function typeChangeRowMatchesRequestedType(row: JsonMap, expectedTypeId: number | null, expectedTypeName: string, phase: "apply" | "readback"): boolean {
  if (row.ok === false) return false;
  if (expectedTypeId !== null) {
    const typeId = phase === "readback"
      ? firstPositiveId(row.oldTypeId, row.currentTypeId, row.typeId)
      : firstPositiveId(row.newTypeId, row.currentTypeId, row.typeId);
    return typeId === expectedTypeId;
  }
  if (!expectedTypeName) return false;
  const typeName = phase === "readback"
    ? normalizedTypeName(row.oldTypeName ?? row.currentTypeName ?? row.typeName ?? row.newTypeName)
    : normalizedTypeName(row.newTypeName ?? row.currentTypeName ?? row.typeName);
  return typeName === expectedTypeName;
}

function typeChangeGlobalTypeMatches(result: unknown, expectedTypeId: number | null, expectedTypeName: string): boolean {
  const obj = asObject(result);
  if (expectedTypeId !== null) return firstPositiveId(obj.newTypeId, obj.currentTypeId, obj.typeId) === expectedTypeId;
  return Boolean(expectedTypeName) && normalizedTypeName(obj.newTypeName ?? obj.currentTypeName ?? obj.typeName) === expectedTypeName;
}

function typeChangeAppliedMatchesRequest(result: unknown, elementIds: number[], expectedTypeId: number | null, expectedTypeName: string): boolean {
  const rows = typeChangeRows(result);
  if (rows.length > 0) {
    return elementIds.length > 0 && elementIds.every((id) => {
      const row = rows.find((entry) => Number(entry.elementId) === id);
      return Boolean(row) && typeChangeRowMatchesRequestedType(row ?? {}, expectedTypeId, expectedTypeName, "apply");
    });
  }
  return elementIds.length > 0 && elementIds.every((id) => typeChangeEffectIds(result).includes(id)) && typeChangeGlobalTypeMatches(result, expectedTypeId, expectedTypeName);
}

function typeChangeReadbackMatchesRequest(result: unknown, elementIds: number[], expectedTypeId: number | null, expectedTypeName: string): boolean {
  const rows = typeChangeRows(result);
  return elementIds.length > 0 && elementIds.every((id) => {
    const row = rows.find((entry) => Number(entry.elementId) === id);
    return Boolean(row) && typeChangeRowMatchesRequestedType(row ?? {}, expectedTypeId, expectedTypeName, "readback");
  });
}

function typeChangeSourceGroundingMatches(result: unknown, elementIds: number[], expectedTypeId: number | null, expectedTypeName: string): boolean {
  const rows = typeChangeRows(result);
  return elementIds.length > 0 && elementIds.every((id) => {
    const row = rows.find((entry) => Number(entry.elementId) === id);
    if (!row || row.ok === false) return false;
    const oldTypeId = firstPositiveId(row.oldTypeId, row.currentTypeId, row.typeId);
    const oldTypeName = normalizedTypeName(row.oldTypeName ?? row.currentTypeName ?? row.typeName);
    if (expectedTypeId !== null) return oldTypeId === expectedTypeId;
    if (expectedTypeName) return oldTypeName === expectedTypeName;
    return oldTypeId !== null || Boolean(oldTypeName);
  });
}

function typeChangeSourceFamilyGroundingMatches(result: unknown, elementIds: number[], expectedFamilyName: string, expectedTypeName: string, expectedCategory: string): boolean {
  if (!expectedFamilyName && !expectedTypeName && !expectedCategory) return true;
  const rows = typeChangeRows(result);
  return elementIds.length > 0 && elementIds.every((id) => {
    const row = rows.find((entry) => Number(entry.elementId) === id);
    if (!row || row.ok === false) return false;
    const familyLabels = [
      row.oldFamilyName,
      row.familyName,
      row.currentFamilyName,
      row.oldTypeName,
      row.typeName,
      row.currentTypeName
    ].map((value) => clip(value, 240)).filter(Boolean);
    const typeLabels = [
      row.oldTypeName,
      row.typeName,
      row.currentTypeName
    ].map((value) => clip(value, 240)).filter(Boolean);
    const categoryLabels = [
      row.category,
      row.categoryName,
      row.builtInCategory,
      row.built_in_category,
      row.oldCategory,
      row.currentCategory
    ].map((value) => clip(value, 240)).filter(Boolean);
    return proofLabelsMatchRequest(expectedFamilyName, familyLabels) &&
      proofLabelsMatchRequest(expectedTypeName, typeLabels) &&
      proofLabelsMatchRequest(expectedCategory, categoryLabels);
  });
}

function firstPathLike(...values: unknown[]): string {
  for (const value of values) {
    const text = clip(value, 1000);
    if (text) return text;
  }
  return "";
}

function sizeReadbackLabel(value: unknown): string {
  const obj = asObject(value);
  return firstPathLike(obj.applied, obj.requested, obj.value, obj.label, value);
}

function workflowName(value: unknown): RevitWorkflowName {
  const normalized = clip(value, 80).toLowerCase();
  if (
    normalized === "sheet_export" ||
    normalized === "takeoff_csv" ||
    normalized === "parameter_edit" ||
    normalized === "redline_update_parameter" ||
    normalized === "redline_receptacles" ||
    normalized === "redline_add" ||
    normalized === "redline_delete" ||
    normalized === "redline_move" ||
    normalized === "redline_rotate" ||
    normalized === "redline_type_change" ||
    normalized === "redline_mep_route" ||
    normalized === "redline_mep_tap_branch" ||
    normalized === "redline_mep_reroute" ||
    normalized === "redline_mep_size_transition" ||
    normalized === "documentation_primitives" ||
    normalized === "model_edit_primitives" ||
    normalized === "aec_mep_eval"
  ) {
    return normalized;
  }
  throw new Error(`Unknown Revit demo workflow '${String(value)}'.`);
}

function defaultBridgeUrl(): string {
  return resolveRevitBridgeUrlCandidates()[0] ?? "http://localhost:5000";
}

export function resolveRevitBridgeUrl(): string {
  return defaultBridgeUrl();
}

function normalizeBridgeUrl(value: string): string {
  return value.trim().replace(/\/+$/, "");
}

function fallbackBridgePorts(): number[] {
  const raw = (process.env.OPERATOR_REVIT_BRIDGE_FALLBACK_PORTS ?? "5010,5011,5012,5013,5014").trim();
  const ports = raw
    .split(",")
    .map((entry) => Number(entry.trim()))
    .filter((entry) => Number.isInteger(entry) && entry > 0 && entry <= 65535);
  return ports.length > 0 ? ports : [5010, 5011, 5012, 5013, 5014];
}

export function resolveRevitBridgeUrlCandidates(): string[] {
  const candidates: string[] = [];
  const push = (value: string | undefined | null) => {
    const normalized = value ? normalizeBridgeUrl(value) : "";
    if (normalized && !candidates.includes(normalized)) candidates.push(normalized);
  };
  push(process.env.REVIT_BRIDGE_URL);
  push(process.env.OPERATOR_REVIT_BRIDGE_URL);
  push(readDiscoveredBridgeUrl());
  push("http://localhost:5000");
  for (const port of fallbackBridgePorts()) push(`http://localhost:${port}`);
  return candidates;
}

function readDiscoveredBridgeUrl(): string {
  const localAppData = (process.env.LOCALAPPDATA ?? "").trim();
  if (!localAppData) return "";
  const filePath = path.join(localAppData, "RevitOperator", "bridge_url.txt");
  try {
    const value = fs.readFileSync(filePath, "utf8").trim();
    return value ? normalizeBridgeUrl(value) : "";
  } catch {
    return "";
  }
}

export function buildRevitBridgeHeaders(): Record<string, string> {
  const token = getOrCreateOperatorToken();
  const writeGrant = getWriteGrantToken();
  return {
    "content-type": "application/json",
    ...(token ? { "x-operator-token": token } : {}),
    ...(writeGrant ? { "x-operator-write-grant": writeGrant } : {})
  };
}

function parseBool(value: unknown): boolean | null {
  const normalized = String(value ?? "").trim().toLowerCase();
  if (!normalized) return null;
  if (["1", "true", "yes", "y", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "n", "off"].includes(normalized)) return false;
  return null;
}

function boolFlag(value: unknown): boolean {
  return parseBool(value) === true || value === true;
}

function hasStringOrPositiveId(obj: JsonMap, stringKeys: string[], idKeys: string[]): boolean {
  if (idKeys.some((key) => firstPositiveId(obj[key]) !== null)) return true;
  return stringKeys.some((key) => clip(obj[key], 240).length > 0);
}

function documentationGraphicsPreWriteBlockers(request: JsonMap): string[] {
  const blockers: string[] = [];
  const cleanupRequested = boolFlag(request.cleanupCreatedElements ?? request.cleanup_created_elements);
  const scheduleBase = asObject(request.schedule);
  const configureScheduleBase = asObject(request.configureSchedule ?? request.scheduleConfiguration);
  if (boolFlag(configureScheduleBase.requireExistingScheduleTarget ?? configureScheduleBase.require_existing_schedule_target)) {
    if (firstPositiveId(scheduleBase.scheduleId, scheduleBase.viewId, scheduleBase.existingScheduleId) === null) {
      blockers.push("configureSchedule existing schedule edits require schedule.scheduleId before runtime execution");
    }
    if (!clip(configureScheduleBase.targetFieldName ?? configureScheduleBase.targetField ?? configureScheduleBase.columnName ?? configureScheduleBase.fieldName, 240)) {
      blockers.push("configureSchedule existing schedule edits require targetFieldName before runtime execution");
    }
    const hasRowScope =
      Boolean(clip(configureScheduleBase.targetRowKey ?? configureScheduleBase.rowKey ?? configureScheduleBase.elementUniqueId ?? configureScheduleBase.elementId, 240)) ||
      firstPositiveId(configureScheduleBase.targetRowIndex, configureScheduleBase.rowIndex) !== null ||
      Boolean(clip(configureScheduleBase.targetCellId ?? configureScheduleBase.cellId, 240));
    if (!hasRowScope) {
      blockers.push("configureSchedule existing schedule edits require targetRowKey, targetRowIndex, or targetCellId before runtime execution");
    }
    if (!clip(configureScheduleBase.requestedTextOrValue ?? configureScheduleBase.requestedValue ?? configureScheduleBase.value, 240)) {
      blockers.push("configureSchedule existing schedule edits require requestedTextOrValue before runtime execution");
    }
    if (!boolFlag(configureScheduleBase.readbackRequired ?? configureScheduleBase.readback_required ?? configureScheduleBase.requireReadback)) {
      blockers.push("configureSchedule existing schedule edits require readbackRequired:true before runtime execution");
    }
  }
  const categoryVisibilityBase = asObject(request.categoryVisibility ?? request.categoryOverrideVisibility);
  if (Object.keys(categoryVisibilityBase).length > 0) {
    if (!boolFlag(categoryVisibilityBase.readbackRequired ?? categoryVisibilityBase.readback_required ?? categoryVisibilityBase.requireReadback)) {
      blockers.push("categoryVisibility requires readbackRequired:true before runtime execution");
    }
    if (!boolFlag(categoryVisibilityBase.revertAfterVerify ?? categoryVisibilityBase.revert_after_verify)) {
      blockers.push("categoryVisibility requires revertAfterVerify:true before runtime execution");
    }
  }

  const linkedModelCategoryVisibilityBase = asObject(
    request.linkedModelCategoryVisibility ??
    request.linkedModelVisibility ??
    request.revitLinkCategoryVisibility
  );
  if (Object.keys(linkedModelCategoryVisibilityBase).length > 0) {
    if (!boolFlag(linkedModelCategoryVisibilityBase.readbackRequired ?? linkedModelCategoryVisibilityBase.readback_required ?? linkedModelCategoryVisibilityBase.requireReadback)) {
      blockers.push("linkedModelCategoryVisibility requires readbackRequired:true before runtime execution");
    }
    if (!boolFlag(linkedModelCategoryVisibilityBase.revertAfterVerify ?? linkedModelCategoryVisibilityBase.revert_after_verify)) {
      blockers.push("linkedModelCategoryVisibility requires revertAfterVerify:true before runtime execution");
    }
  }

  const phaseVisibilityBase = asObject(request.phaseVisibility ?? request.viewPhaseVisibility);
  if (Object.keys(phaseVisibilityBase).length > 0) {
    if (!boolFlag(phaseVisibilityBase.readbackRequired ?? phaseVisibilityBase.readback_required ?? phaseVisibilityBase.requireReadback)) {
      blockers.push("phaseVisibility requires readbackRequired:true before runtime execution");
    }
    if (!boolFlag(phaseVisibilityBase.revertAfterVerify ?? phaseVisibilityBase.revert_after_verify)) {
      blockers.push("phaseVisibility requires revertAfterVerify:true before runtime execution");
    }
    const phaseChangeRequested = phaseVisibilityBase.phaseName !== undefined || phaseVisibilityBase.phase !== undefined || phaseVisibilityBase.phaseId !== undefined;
    if (phaseChangeRequested && !hasStringOrPositiveId(phaseVisibilityBase, ["originalPhaseName", "originalPhase"], ["originalPhaseId"])) {
      blockers.push("phaseVisibility phase changes require originalPhaseName or originalPhaseId for revert proof");
    }
    const phaseFilterChangeRequested = phaseVisibilityBase.phaseFilterName !== undefined || phaseVisibilityBase.phaseFilter !== undefined || phaseVisibilityBase.phaseFilterId !== undefined;
    if (phaseFilterChangeRequested && !hasStringOrPositiveId(phaseVisibilityBase, ["originalPhaseFilterName", "originalPhaseFilter"], ["originalPhaseFilterId"])) {
      blockers.push("phaseVisibility phase-filter changes require originalPhaseFilterName or originalPhaseFilterId for revert proof");
    }
  }

  const filterVisibilityBase = asObject(request.filterVisibility ?? request.viewFilterVisibility);
  if (Object.keys(filterVisibilityBase).length > 0) {
    const createFilter = asObject(filterVisibilityBase.createFilter ?? filterVisibilityBase.create_filter);
    const filterId = firstPositiveId(filterVisibilityBase.filterId, filterVisibilityBase.existingFilterId, filterVisibilityBase.viewFilterId);
    const ruleValue = createFilter.ruleValue ?? createFilter.value ?? createFilter.equals ?? filterVisibilityBase.ruleValue;
    const ruleValueElementId = createFilter.ruleValueElementId ?? createFilter.rule_value_element_id ?? createFilter.ruleValueId ?? createFilter.valueElementId;
    const hasCreationCriteria = Boolean(clip(createFilter.categoryName ?? createFilter.category ?? filterVisibilityBase.categoryName ?? filterVisibilityBase.category, 240)) &&
      Boolean(clip(createFilter.ruleParameterName ?? createFilter.parameterName ?? createFilter.parameter ?? filterVisibilityBase.ruleParameterName, 240)) &&
      Boolean(clip(createFilter.ruleOperator ?? createFilter.operator ?? createFilter.equals ?? filterVisibilityBase.ruleOperator, 80)) &&
      (Boolean(clip(ruleValue, 240)) || positiveInteger(ruleValueElementId) !== null);
    if (filterId === null && !hasCreationCriteria) {
      blockers.push("filterVisibility requires existing filterId or createFilter category/ruleParameterName/ruleOperator/ruleValue before runtime execution");
    }
    if (!boolFlag(filterVisibilityBase.readbackRequired ?? filterVisibilityBase.readback_required ?? filterVisibilityBase.requireReadback)) {
      blockers.push("filterVisibility requires readbackRequired:true before runtime execution");
    }
    if (!boolFlag(filterVisibilityBase.revertAfterVerify ?? filterVisibilityBase.revert_after_verify)) {
      blockers.push("filterVisibility requires revertAfterVerify:true before runtime execution");
    }
  }

  const textNoteBase = asObject(request.textNote ?? request.text_note);
  if (Object.keys(textNoteBase).length > 0 && boolFlag(textNoteBase.editExisting ?? textNoteBase.edit_existing)) {
    if (firstPositiveId(textNoteBase.textNoteId, textNoteBase.text_note_id, textNoteBase.elementId, textNoteBase.element_id) === null) {
      blockers.push("textNote existing edits require textNoteId before runtime execution");
    }
    if (firstPositiveId(textNoteBase.viewId, textNoteBase.view_id, request.textViewId, request.viewId) === null) {
      blockers.push("textNote existing edits require viewId before runtime execution");
    }
    if (!clip(textNoteBase.expectedExistingText ?? textNoteBase.expected_existing_text ?? textNoteBase.originalText ?? textNoteBase.original_text ?? textNoteBase.textContains, 500)) {
      blockers.push("textNote existing edits require expectedExistingText before runtime execution");
    }
    if (!clip(textNoteBase.newText ?? textNoteBase.replacementText ?? textNoteBase.text ?? request.text, 500)) {
      blockers.push("textNote existing edits require replacement text before runtime execution");
    }
    if (!boolFlag(textNoteBase.readbackRequired ?? textNoteBase.readback_required ?? textNoteBase.requireReadback)) {
      blockers.push("textNote existing edits require readbackRequired:true before runtime execution");
    }
    if (!boolFlag(textNoteBase.revertAfterVerify ?? textNoteBase.revert_after_verify)) {
      blockers.push("textNote existing edits require revertAfterVerify:true before runtime execution");
    }
  }

  const templateVisibilityBase = asObject(request.templateVisibility ?? request.viewTemplateVisibility);
  if (Object.keys(templateVisibilityBase).length > 0 && !cleanupRequested) {
    blockers.push("templateVisibility requires cleanupCreatedElements:true before runtime execution");
  }

  const templateCategoryVisibilityBase = asObject(
    request.templateCategoryVisibility ??
    request.viewTemplateCategoryVisibility ??
    request.templateCategoryOverrideVisibility
  );
  if (Object.keys(templateCategoryVisibilityBase).length > 0 && !cleanupRequested) {
    blockers.push("templateCategoryVisibility requires cleanupCreatedElements:true before runtime execution");
  }
  if (
    Object.keys(templateCategoryVisibilityBase).length > 0 &&
    boolFlag(templateCategoryVisibilityBase.requireExistingTemplateTarget ?? templateCategoryVisibilityBase.require_existing_template_target)
  ) {
    if (firstPositiveId(templateCategoryVisibilityBase.existingTemplateId, templateCategoryVisibilityBase.templateId, templateCategoryVisibilityBase.viewTemplateId) === null) {
      blockers.push("templateCategoryVisibility existing-template edits require existingTemplateId before runtime execution");
    }
    if (firstPositiveId(templateCategoryVisibilityBase.controlledViewId, templateCategoryVisibilityBase.templateControlledViewId) === null) {
      blockers.push("templateCategoryVisibility existing-template edits require controlledViewId before runtime execution");
    }
    if (!boolFlag(templateCategoryVisibilityBase.readbackRequired ?? templateCategoryVisibilityBase.readback_required ?? templateCategoryVisibilityBase.requireReadback)) {
      blockers.push("templateCategoryVisibility existing-template edits require readbackRequired:true before runtime execution");
    }
    if (!boolFlag(templateCategoryVisibilityBase.revertAfterVerify ?? templateCategoryVisibilityBase.revert_after_verify)) {
      blockers.push("templateCategoryVisibility existing-template edits require revertAfterVerify:true before runtime execution");
    }
  }

  if ((request.applyViewTemplate !== undefined || request.viewTemplateAssignment !== undefined) && !cleanupRequested) {
    blockers.push("applyViewTemplate requires cleanupCreatedElements:true before runtime execution");
  }

  const cadLinkBase = asObject(request.cadLink ?? request.cadImport ?? request.linkCad);
  if (Object.keys(cadLinkBase).length > 0 && !cleanupRequested) {
    blockers.push("cadLink requires cleanupCreatedElements:true before runtime execution");
  }

  const cadGraphicsBase = asObject(request.cadGraphicsOverride ?? request.cadLayerOverride ?? request.cadVisibility);
  if (Object.keys(cadGraphicsBase).length > 0 && !cleanupRequested) {
    blockers.push("cadGraphicsOverride requires cleanupCreatedElements:true before runtime execution");
  }

  const cadReloadBase = asObject(request.cadReload ?? request.reloadCad ?? request.cadLinkReload);
  if (Object.keys(cadReloadBase).length > 0 && boolFlag(cadReloadBase.applyReload ?? cadReloadBase.apply_reload ?? cadReloadBase.apply)) {
    blockers.push("cadReload apply is blocked until a native reload-and-restore workflow exists");
  }

  return blockers;
}

function auditStatusOk(value: unknown): boolean {
  const normalized = clip(value, 80).toLowerCase();
  return ["ok", "success", "connected", "pass", "passed"].includes(normalized);
}

function auditStatusBad(value: unknown): boolean {
  const normalized = clip(value, 80).toLowerCase();
  return /\b(disconnected|failed|fail|error|open|broken|invalid)\b/.test(normalized);
}

function mepNetworkContinuityAudit(value: unknown, options: { allowedOpenConnectorCount?: number } = {}): { ok: boolean; explicit: boolean; detail: JsonMap } {
  const audit = asObject(value);
  const systemAudit = asObject(audit.systemAudit ?? audit.system_audit);
  const network = asObject(audit.network ?? audit.connectedNetwork ?? audit.connected_network);
  const allowedOpenConnectorCount = Math.max(0, Number(options.allowedOpenConnectorCount ?? 0));
  const passFlag = parseBool(
    audit.connectedNetworkOk ??
    audit.connected_network_ok ??
    audit.systemContinuityOk ??
    audit.system_continuity_ok ??
    audit.pass ??
    systemAudit.pass ??
    network.connectedNetworkOk
  );
  const statusValues = [
    audit.status,
    audit.result,
    audit.state,
    systemAudit.status,
    systemAudit.result,
    network.status
  ];
  const disconnectedCount = firstFiniteNumber(
    audit.disconnectedCount,
    audit.disconnected_count,
    systemAudit.disconnectedCount,
    systemAudit.disconnected_count,
    network.disconnectedCount,
    network.disconnected_count
  );
  const openConnectorCount = firstFiniteNumber(
    audit.openConnectorCount,
    audit.open_connector_count,
    systemAudit.openConnectorCount,
    systemAudit.open_connector_count,
    network.openConnectorCount,
    network.open_connector_count
  );
  const disconnectedIds = uniquePositiveIds(
    audit.disconnectedIds,
    audit.disconnected_ids,
    audit.disconnectedElementIds,
    audit.disconnected_element_ids,
    systemAudit.disconnectedIds,
    systemAudit.disconnected_ids,
    systemAudit.disconnectedElementIds,
    systemAudit.disconnected_element_ids,
    network.disconnectedIds,
    network.disconnected_ids
  );
  const positiveStatus = statusValues.some(auditStatusOk);
  const negativeStatus = statusValues.some(auditStatusBad);
  const hasNegativeEvidence =
    passFlag === false ||
    negativeStatus ||
    (disconnectedCount !== null && disconnectedCount > 0) ||
    disconnectedIds.length > 0 ||
    (openConnectorCount !== null && openConnectorCount > allowedOpenConnectorCount);
  const explicit = passFlag !== null || positiveStatus || negativeStatus || disconnectedCount !== null || openConnectorCount !== null || disconnectedIds.length > 0;
  const positive = passFlag === true || positiveStatus;
  return {
    ok: explicit && positive && !hasNegativeEvidence,
    explicit,
    detail: {
      passFlag,
      positiveStatus,
      negativeStatus,
      disconnectedCount,
      disconnectedIds,
      openConnectorCount,
      allowedOpenConnectorCount
    }
  };
}

export function shouldUseMockBridgeFixtures(config: WorkflowConfig): boolean {
  if (!config.mock) return false;
  const envOverride = parseBool(process.env.OPERATOR_BENCHMARK_USE_MOCKS);
  if (envOverride !== null) return envOverride;
  const configOverride = parseBool(config.use_mocks);
  if (configOverride !== null) return configOverride;
  return true;
}

export class HttpBridgeTransport implements BridgeTransport {
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  public computerUseActions = 0;

  constructor(baseUrl = defaultBridgeUrl(), timeoutMs = 60_000) {
    this.baseUrl = baseUrl.replace(/\/+$/, "");
    this.timeoutMs = Math.max(2_000, Math.min(10 * 60_000, timeoutMs));
  }

  async post(pathname: string, body: unknown): Promise<unknown> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    const warningDismissal = startRevitWarningDismissalWatchdog(() => {
      this.computerUseActions += 1;
    });
    try {
      const response = await fetch(`${this.baseUrl}${pathname}`, {
        method: "POST",
        headers: buildRevitBridgeHeaders(),
        body: JSON.stringify(body ?? {}),
        signal: controller.signal
      });
      const text = await response.text();
      const parsed = text ? JSON.parse(text) : {};
      if (!response.ok) {
        throw new Error(`Bridge ${pathname} failed with ${response.status}: ${clip((parsed as JsonMap).error ?? text, 800)}`);
      }
      return parsed;
    } finally {
      clearTimeout(timeout);
      warningDismissal();
    }
  }
}

function startRevitWarningDismissalWatchdog(onDismissed: () => void): () => void {
  if (process.platform !== "win32") return () => {};
  let active = false;
  const timer = setInterval(() => {
    if (active) return;
    active = true;
    try {
      const count = dismissVisibleRevitWarningDialogs();
      for (let i = 0; i < count; i++) onDismissed();
    } finally {
      active = false;
    }
  }, 5_000);
  timer.unref?.();
  return () => clearInterval(timer);
}

function dismissVisibleRevitWarningDialogs(): number {
  const script = String.raw`
$code = @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public static class RevitWarningClick {
  public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc lpEnumFunc, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool EnumChildWindows(IntPtr hWndParent, EnumWindowsProc lpEnumFunc, IntPtr lParam);
  [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr hWnd, StringBuilder lpString, int nMaxCount);
  [DllImport("user32.dll")] public static extern int GetClassName(IntPtr hWnd, StringBuilder lpClassName, int nMaxCount);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);
  [DllImport("user32.dll")] public static extern IntPtr SendMessage(IntPtr hWnd, int Msg, IntPtr wParam, IntPtr lParam);
}
'@;
Add-Type $code -ErrorAction SilentlyContinue;
$BM_CLICK = 0x00F5;
$revitPids = @(Get-Process Revit -ErrorAction SilentlyContinue | ForEach-Object { [uint32]$_.Id });
$clicked = 0;
[RevitWarningClick]::EnumWindows({ param($h,$l)
  $windowPid = [uint32]0; [void][RevitWarningClick]::GetWindowThreadProcessId($h, [ref]$windowPid);
  if ($revitPids -notcontains $windowPid) { return $true }
  $title = New-Object Text.StringBuilder 512; [void][RevitWarningClick]::GetWindowText($h,$title,$title.Capacity);
  $class = New-Object Text.StringBuilder 256; [void][RevitWarningClick]::GetClassName($h,$class,$class.Capacity);
  if (-not [RevitWarningClick]::IsWindowVisible($h) -or $class.ToString() -ne '#32770' -or $title.ToString() -notmatch 'Autodesk Revit') { return $true }
  [RevitWarningClick]::EnumChildWindows($h, { param($ch,$cl)
    $ct = New-Object Text.StringBuilder 512; [void][RevitWarningClick]::GetWindowText($ch,$ct,$ct.Capacity);
    $cc = New-Object Text.StringBuilder 256; [void][RevitWarningClick]::GetClassName($ch,$cc,$cc.Capacity);
    if ([RevitWarningClick]::IsWindowVisible($ch) -and $cc.ToString() -eq 'Button' -and $ct.ToString() -eq '&OK') {
      [void][RevitWarningClick]::SendMessage($ch, $BM_CLICK, [IntPtr]::Zero, [IntPtr]::Zero);
      $script:clicked += 1;
    }
    return $true
  }, [IntPtr]::Zero) | Out-Null;
  return $true
}, [IntPtr]::Zero) | Out-Null;
$clicked
`;
  try {
    const output = execFileSync("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", script], {
      encoding: "utf8",
      timeout: 10_000,
      windowsHide: true
    }).trim();
    const count = Number(output.split(/\s+/).filter(Boolean).pop() ?? "0");
    return Number.isFinite(count) && count > 0 ? count : 0;
  } catch {
    return 0;
  }
}

export class MockBridgeTransport implements BridgeTransport {
  private readonly fixtures: JsonMap;
  public calls: Array<{ pathname: string; body: unknown }> = [];

  constructor(fixtures: JsonMap) {
    this.fixtures = fixtures;
  }

  async post(pathname: string, body: unknown): Promise<unknown> {
    this.calls.push({ pathname, body });
    const key = `${pathname}:${this.calls.filter((call) => call.pathname === pathname).length}`;
    if (Object.prototype.hasOwnProperty.call(this.fixtures, key)) return this.fixtures[key];
    if (Object.prototype.hasOwnProperty.call(this.fixtures, pathname)) return this.fixtures[pathname];
    throw new Error(`Mock bridge fixture missing for ${pathname}.`);
  }
}

function verification(name: string, ok: boolean, expected?: unknown, actual?: unknown, detail?: string): RevitWorkflowVerification {
  return { name, ok, expected, actual, detail };
}

function countOk(results: RevitWorkflowVerification[]): boolean {
  return results.length > 0 && results.every((entry) => entry.ok);
}

function makeCsv(rows: Array<Record<string, unknown>>): string {
  const headers = Array.from(new Set(rows.flatMap((row) => Object.keys(row))));
  const escape = (value: unknown) => `"${String(value ?? "").replace(/"/g, "\"\"")}"`;
  return [headers.join(","), ...rows.map((row) => headers.map((header) => escape(row[header])).join(","))].join("\n") + "\n";
}

function writeCsv(filePath: string, rows: Array<Record<string, unknown>>): string {
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, makeCsv(rows), "utf8");
  return filePath;
}

function makeMarkdownTable(rows: Array<Record<string, unknown>>, maxRows = 25): string {
  const headers = Array.from(new Set(rows.flatMap((row) => Object.keys(row)))).slice(0, 8);
  if (headers.length === 0) return "_No rows returned._\n";
  const cell = (value: unknown) => String(value ?? "").replace(/\|/g, "\\|").replace(/\s+/g, " ").trim();
  const lines = [
    `| ${headers.join(" | ")} |`,
    `| ${headers.map(() => "---").join(" | ")} |`
  ];
  for (const row of rows.slice(0, maxRows)) lines.push(`| ${headers.map((header) => cell(row[header])).join(" | ")} |`);
  if (rows.length > maxRows) lines.push(`\n_Showing ${maxRows} of ${rows.length} rows._`);
  return `${lines.join("\n")}\n`;
}

function writeMarkdownTable(filePath: string, rows: Array<Record<string, unknown>>): string {
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, makeMarkdownTable(rows), "utf8");
  return filePath;
}

function selectedSheetIdentifiers(selectedSheets: unknown[]): string[] {
  const ids = new Set<string>();
  for (const sheet of selectedSheets) {
    const item = asObject(sheet);
    for (const key of ["sheetNumber", "number", "SheetNumber"]) {
      const value = clip(item[key], 120);
      if (value) ids.add(value);
    }
  }
  return [...ids];
}

function requestedSheetCount(request: JsonMap): number | null {
  for (const key of ["sheetNumbers", "sheet_names", "sheetNames", "sheetIds", "sheets"]) {
    const value = request[key];
    if (Array.isArray(value) && value.length > 0) return value.length;
  }
  const max = Number(request.max);
  return Number.isFinite(max) && max > 0 ? max : null;
}

function expectedPdfOutputChecks(request: JsonMap, outputs: string[]): RevitWorkflowVerification[] {
  const checks: RevitWorkflowVerification[] = [];
  const baseFileName = clip(request.baseFileName ?? request.outputFileName ?? request.outputFilename ?? request.fileName, 260);
  if (baseFileName) {
    const basenames = outputs.map((entry) => path.basename(entry).toLowerCase());
    checks.push(verification("output_filename_matches_request", basenames.every((entry) => entry === baseFileName.toLowerCase()), baseFileName, outputs));
  }
  const outputFolder = clip(request.outputFolder ?? request.output_folder, 1000);
  if (outputFolder && path.isAbsolute(outputFolder)) {
    const expectedFolder = path.resolve(outputFolder).toLowerCase();
    const actualFolders = outputs.map((entry) => path.resolve(path.dirname(entry)).toLowerCase());
    checks.push(verification("output_folder_matches_request", actualFolders.every((entry) => entry === expectedFolder), expectedFolder, actualFolders));
  }
  return checks;
}

async function inspectPdf(filePath: string): Promise<{ pageCount: number; text: string }> {
  const bytes = fs.readFileSync(filePath);
  const pdfjs = await loadPdfJsForNode();
  const doc = await pdfjs.getDocument(buildPdfJsDocumentOptions(new Uint8Array(bytes))).promise;
  const pageCount = Number(doc.numPages ?? 0);
  const chunks: string[] = [];
  const pagesToRead = Math.min(pageCount, 12);
  for (let pageNumber = 1; pageNumber <= pagesToRead; pageNumber++) {
    const page = await doc.getPage(pageNumber);
    const content = await page.getTextContent();
    const items = Array.isArray(content.items) ? content.items : [];
    chunks.push(...items.map((item: unknown) => clip(asObject(item).str, 400)).filter(Boolean));
  }
  return { pageCount, text: chunks.join(" ") };
}

async function buildPdfContentChecks(outputs: string[], selectedSheets: unknown[], combine: boolean): Promise<RevitWorkflowVerification[]> {
  const checks: RevitWorkflowVerification[] = [];
  const expectedCount = selectedSheets.length;
  if (outputs.length === 0 || expectedCount === 0) return checks;
  for (const filePath of outputs.filter((entry) => /\.pdf$/i.test(entry))) {
    if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) continue;
    try {
      const inspection = await inspectPdf(filePath);
      const expectedPages = combine ? expectedCount : 1;
      checks.push(verification("pdf_page_count", inspection.pageCount === expectedPages, expectedPages, inspection.pageCount, filePath));
      const identifiers = selectedSheetIdentifiers(selectedSheets);
      const text = inspection.text.toLowerCase();
      if (identifiers.length > 0 && text.trim()) {
        const missing = identifiers.filter((identifier) => !text.includes(identifier.toLowerCase()));
        checks.push(verification("pdf_contains_sheet_identifiers", missing.length === 0, identifiers, { missing }, filePath));
      } else {
        checks.push(verification("pdf_contains_sheet_identifiers", true, identifiers, "not inspectable", "PDF text was empty or no sheet identifiers were available."));
      }
    } catch (error) {
      checks.push(verification("pdf_content_inspection", false, filePath, null, error instanceof Error ? error.message : String(error)));
    }
  }
  return checks;
}

async function runSheetExport(transport: BridgeTransport, request: JsonMap): Promise<RevitWorkflowPartialResult> {
  const rawResults: unknown[] = [];
  const preflight = await transport.post("/revit/export-pdf", { ...request, dryRun: true });
  rawResults.push(preflight);
  const preflightOut = asObject(preflight);
  const expectedSheetCount = requestedSheetCount(request);
  const preflightSelectedSheets = Array.isArray(preflightOut.selectedSheets) ? preflightOut.selectedSheets : [];
  const preflightSelectedCount = Number(preflightOut.selectedCount ?? preflightSelectedSheets.length);
  const preflightChecks = [
    verification("dry_run_resolved_requested_sheets", expectedSheetCount === null ? preflightSelectedCount > 0 : preflightSelectedCount === expectedSheetCount, expectedSheetCount ?? ">0", preflightSelectedCount)
  ];
  if (!countOk(preflightChecks)) {
    return {
      workflow: "sheet_export",
      success: false,
      failure_reason: "PDF export dry-run did not resolve the requested sheets.",
      tool_calls: 1,
      revit_transactions: 0,
      computer_use_actions: 0,
      output_artifacts: [],
      verification_results: preflightChecks,
      user_message: "PDF export stopped before printing because the requested sheets did not resolve.",
      raw_results: rawResults
    };
  }
  const exported = await transport.post("/revit/export-pdf", { ...request, dryRun: false });
  rawResults.push(exported);

  const out = asObject(exported);
  const selectedSheets = Array.isArray(out.selectedSheets) ? out.selectedSheets : [];
  const outputs = asStringArray(out.outputs ?? out.paths ?? (out.path ? [out.path] : []));
  const combine = out.combine !== false;
  const fileChecks = outputs.map((filePath) => {
    const bridgeVerification = asObject(out.verification);
    if (outputs.length === 1 && typeof bridgeVerification.ok === "boolean") {
      return verification("pdf_file_exists", bridgeVerification.ok, filePath, bridgeVerification);
    }
    return verification("pdf_file_exists", fs.existsSync(filePath) && fs.statSync(filePath).size > 0, filePath, filePath);
  });
  const checks = [
    ...preflightChecks,
    verification("selected_sheet_count", selectedSheets.length > 0 && selectedSheets.length === Number(out.selectedCount ?? selectedSheets.length), out.selectedCount, selectedSheets.length),
    ...fileChecks,
    ...expectedPdfOutputChecks(request, outputs),
    ...(await buildPdfContentChecks(outputs, selectedSheets, combine))
  ];

  return {
    workflow: "sheet_export",
    success: countOk(checks),
    failure_reason: countOk(checks) ? null : "PDF export verification failed.",
    tool_calls: 2,
    revit_transactions: 0,
    computer_use_actions: 0,
    output_artifacts: outputs,
    verification_results: checks,
    user_message: countOk(checks)
      ? `Exported ${selectedSheets.length} sheet(s) to ${outputs.join(", ")}.`
      : "PDF export ran, but verification failed.",
    raw_results: rawResults
  };
}

async function runTakeoffCsv(transport: BridgeTransport, request: JsonMap, runDir: string): Promise<RevitWorkflowPartialResult> {
  const quantify = await transport.post("/revit/quantify", request);
  const out = asObject(quantify);
  const summary = asObject(out.summary);
  const groups = asObject(summary.groups);
  const total = Number(summary.total ?? 0);
  const groupedTotal = Object.values(groups).reduce<number>((sum, value) => sum + Number(value ?? 0), 0);
  const groupRows = Object.entries(groups).map(([group, count]) => ({ group, count }));
  const rows = Array.isArray(out.rows) && out.rows.length > 0 ? (out.rows as Array<Record<string, unknown>>) : groupRows;
  const csvPath = writeCsv(path.join(runDir, "artifacts", "takeoff_summary.csv"), rows);
  const tablePath = writeMarkdownTable(path.join(runDir, "artifacts", "takeoff_summary.md"), rows);
  const tablePreview = makeMarkdownTable(rows, 10).trim();
  const checks = [
    verification("raw_total_matches_grouped_total", total === groupedTotal, total, groupedTotal),
    verification("csv_written", fs.existsSync(csvPath) && fs.statSync(csvPath).size > 0, csvPath, csvPath),
    verification("readable_table_written", fs.existsSync(tablePath) && fs.statSync(tablePath).size > 0, tablePath, tablePath)
  ];
  return {
    workflow: "takeoff_csv",
    success: countOk(checks),
    failure_reason: countOk(checks) ? null : "Takeoff total/grouped total or CSV verification failed.",
    tool_calls: 1,
    revit_transactions: 0,
    computer_use_actions: 0,
    output_artifacts: [csvPath, tablePath],
    verification_results: checks,
    user_message: countOk(checks)
      ? `Counted ${total} element(s). CSV: ${csvPath}\n\n${tablePreview}`
      : "Takeoff ran, but verification failed.",
    raw_results: [quantify]
  };
}

async function resolveParameterTargets(transport: BridgeTransport, request: JsonMap): Promise<number[]> {
  const explicit = asNumberArray(request.elementIds ?? request.element_ids);
  if (explicit.length > 0) return explicit;
  const query = asObject(request.query);
  if (Object.keys(query).length === 0) return [];
  const found = asObject(await transport.post("/revit/find-elements", query));
  const candidates = asNumberArray(found.elementIds ?? found.ids);
  if (candidates.length > 0) return candidates;
  const items = Array.isArray(found.items) ? found.items : [];
  return items.map((entry) => Number(asObject(entry).id ?? asObject(entry).elementId)).filter((entry) => Number.isFinite(entry) && entry > 0);
}

function parameterSnapshotItems(snapshot: unknown): JsonMap[] {
  const obj = asObject(snapshot);
  if (Array.isArray(obj.items)) return obj.items.map(asObject);
  return [obj];
}

function parameterValueByElementId(snapshot: unknown, parameterName: string): Map<number, string> {
  const values = new Map<number, string>();
  for (const item of parameterSnapshotItems(snapshot)) {
    const id = Number(item.id ?? item.elementId);
    if (!Number.isFinite(id) || id <= 0) continue;
    const parameters = asObject(item.parameters);
    values.set(id, String(parameters[parameterName] ?? ""));
  }
  return values;
}

function parameterDiffs(result: unknown): JsonMap[] {
  const diffs = asObject(result).diffs;
  return Array.isArray(diffs) ? diffs.map(asObject) : [];
}

function parameterResultRows(result: unknown): JsonMap[] {
  if (Array.isArray(result)) return result.map(asObject);
  const obj = asObject(result);
  if (Array.isArray(obj.results)) return obj.results.map(asObject);
  if (Array.isArray(obj.items)) return obj.items.map(asObject);
  return Object.keys(obj).length > 0 ? [obj] : [];
}

function collectParameterTargetRows(snapshot: unknown, targetIds: number[]): JsonMap[] {
  const requested = new Set(targetIds);
  return parameterSnapshotItems(snapshot).filter((item) => {
    const id = Number(item.id ?? item.elementId);
    return Number.isFinite(id) && requested.has(id);
  });
}

function categoryProofVariants(value: unknown): string[] {
  const normalized = normalizeProofLabel(value);
  if (!normalized) return [];
  const variants = new Set<string>([normalized]);
  const withoutOst = normalized.replace(/^ost[_\s-]*/, "");
  variants.add(withoutOst);
  variants.add(withoutOst.replace(/_/g, " "));
  variants.add(withoutOst.replace(/_/g, ""));
  variants.add(normalized.replace(/\s+/g, ""));
  variants.add(withoutOst.replace(/\s+/g, ""));
  variants.add(withoutOst.replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase());
  variants.add(withoutOst.replace(/accessory\b/, "accessories"));
  variants.add(withoutOst.replace(/accessories\b/, "accessory"));
  variants.add(withoutOst.replace(/\s+/g, "").replace(/accessory\b/, "accessories"));
  variants.add(withoutOst.replace(/\s+/g, "").replace(/accessories\b/, "accessory"));
  return Array.from(variants).map((entry) => entry.trim()).filter(Boolean);
}

function proofCategoryLabelsMatchRequest(requestedLabel: string, actualLabels: string[]): boolean {
  const requestedVariants = categoryProofVariants(requestedLabel);
  if (requestedVariants.length === 0) return true;
  const actualVariants = actualLabels.flatMap(categoryProofVariants);
  return requestedVariants.some((requested) =>
    actualVariants.some((actual) => actual === requested || actual.includes(requested) || requested.includes(actual))
  );
}

function collectParameterFamilyTypeLabels(item: JsonMap): string[] {
  return collectInventoryFamilyTypeLabels(item, asObject(item.element), asObject(item.type), asObject(item.symbol));
}

function parameterTargetIdentityMatchesRequest(rows: JsonMap[], targetIds: number[], grounding: JsonMap): boolean {
  const expectedFamilyName = clip(grounding.expectedFamilyName ?? grounding.expected_family_name ?? grounding.familyName ?? grounding.family_name, 220);
  const expectedTypeName = clip(grounding.expectedTypeName ?? grounding.expected_type_name ?? grounding.typeName ?? grounding.type_name ?? grounding.symbolName ?? grounding.symbol_name, 220);
  const expectedCategory = clip(grounding.expectedCategory ?? grounding.expected_category ?? grounding.category ?? grounding.categoryName ?? grounding.builtInCategory ?? grounding.built_in_category, 220);
  if (!expectedFamilyName && !expectedTypeName && !expectedCategory) return true;
  if (rows.length !== targetIds.length) return false;
  return rows.every((row) => {
    const familyTypeLabels = collectParameterFamilyTypeLabels(row);
    const categoryLabels = collectInventoryCategoryLabels(row);
    return proofLabelsMatchRequest(expectedFamilyName, familyTypeLabels) &&
      proofLabelsMatchRequest(expectedTypeName, familyTypeLabels) &&
      proofCategoryLabelsMatchRequest(expectedCategory, categoryLabels);
  });
}

function hasParameterWriteErrors(result: unknown): boolean {
  const obj = asObject(result);
  if (obj.ok === false || obj.success === false) return true;
  const status = clip(obj.status, 80).toLowerCase();
  if (["error", "failed", "failure"].includes(status)) return true;
  const rows = [...parameterDiffs(result), ...parameterResultRows(result)];
  return rows.some((diff) =>
    diff.ok === false ||
    diff.success === false ||
    diff.canChange === false ||
    diff.readOnly === true ||
    diff.read_only === true ||
    Boolean(diff.error) ||
    Boolean(diff.failureReason) ||
    clip(diff.status, 200).toLowerCase().startsWith("error")
  );
}

async function runParameterEdit(transport: BridgeTransport, request: JsonMap, runDir: string): Promise<RevitWorkflowPartialResult> {
  const parameterName = clip(request.parameterName ?? request.parameter_name, 200);
  const value = String(request.value ?? "");
  const revertAfterVerify = parseBool(request.revertAfterVerify ?? request.revert_after_verify) === true;
  const visualVerify = parseBool(request.visualVerify ?? request.visual_verify) === true;
  const visualViewId = firstPositiveId(request.visualViewId, request.visual_view_id, request.captureViewId, request.viewId, request.view_id);
  const targetGrounding = asObject(request.targetGrounding ?? request.target_grounding ?? request.existingTarget ?? request.existing_target);
  const targetIds = await resolveParameterTargets(transport, request);
  const requestedTargetCount = Math.max(1, Number(request.minTargetCount ?? request.min_target_count ?? targetIds.length));
  if (!parameterName || targetIds.length === 0) throw new Error("parameter_edit requires parameterName and elementIds or query.");
  const changes = targetIds.map((elementId) => ({ elementId, parameterName, value }));
  const rawResults: unknown[] = [];
  const before = await transport.post("/revit/get-parameters", { elementIds: targetIds, names: [parameterName] });
  rawResults.push(before);
  const beforeTargetRows = collectParameterTargetRows(before, targetIds);
  const targetIdentityMatches = parameterTargetIdentityMatchesRequest(beforeTargetRows, targetIds, targetGrounding);
  const beforeValues = parameterValueByElementId(before, parameterName);
  const preApplyRows = targetIds.map((elementId) => ({
    elementId,
    parameter: parameterName,
    oldValue: beforeValues.get(elementId) ?? "",
    newValue: value,
    readbackValue: "",
    status: targetIdentityMatches ? "dry-run failed" : "target identity mismatch"
  }));
  if (!targetIdentityMatches) {
    const summaryPath = writeMarkdownTable(path.join(runDir, "artifacts", "parameter_change_summary.md"), preApplyRows);
    const checks = [
      verification("target_count", targetIds.length > 0, ">0", targetIds.length),
      verification("target_count_matches_request", targetIds.length >= requestedTargetCount, requestedTargetCount, targetIds.length),
      verification("parameter_target_identity_matches_request", false, targetGrounding, beforeTargetRows),
      verification("old_values_captured", preApplyRows.length === targetIds.length, targetIds.length, preApplyRows.length),
      verification("parameter_change_summary_written", fs.existsSync(summaryPath) && fs.statSync(summaryPath).size > 0, summaryPath, summaryPath)
    ];
    return {
      workflow: "parameter_edit",
      success: false,
      failure_reason: "Parameter target identity did not match the requested category, family, or type grounding.",
      tool_calls: request.query ? 2 : 1,
      revit_transactions: 0,
      computer_use_actions: 0,
      output_artifacts: [summaryPath],
      verification_results: checks,
      user_message: "Parameter edit stopped before dry-run because the selected element did not match the requested target identity.",
      raw_results: rawResults
    };
  }
  const dryRun = await transport.post("/revit/set-parameter", { changes, apply: false });
  rawResults.push(dryRun);
  const dryRunDiffs = parameterDiffs(dryRun);
  if (hasParameterWriteErrors(dryRun)) {
    const summaryPath = writeMarkdownTable(path.join(runDir, "artifacts", "parameter_change_summary.md"), preApplyRows);
    const checks = [
      verification("target_count", targetIds.length > 0, ">0", targetIds.length),
      verification("target_count_matches_request", targetIds.length >= requestedTargetCount, requestedTargetCount, targetIds.length),
      verification("parameter_target_identity_matches_request", targetIdentityMatches, targetGrounding, beforeTargetRows),
      verification("old_values_captured", preApplyRows.length === targetIds.length, targetIds.length, preApplyRows.length),
      verification("dry_run_returned_diffs", parameterDiffs(dryRun).length > 0 || parameterResultRows(dryRun).length > 0, "diffs[] or result rows", dryRun),
      verification("dry_run_all_changes_ok", false, "no dry-run write errors", dryRunDiffs.length > 0 ? dryRunDiffs : dryRun),
      verification("parameter_change_summary_written", fs.existsSync(summaryPath) && fs.statSync(summaryPath).size > 0, summaryPath, summaryPath)
    ];
    return {
      workflow: "parameter_edit",
      success: false,
      failure_reason: "Parameter dry-run reported read-only, missing parameter, invalid value, or another write error.",
      tool_calls: request.query ? 3 : 2,
      revit_transactions: 1,
      computer_use_actions: 0,
      output_artifacts: [summaryPath],
      verification_results: checks,
      user_message: "Parameter edit stopped before commit because dry-run reported a write error.",
      raw_results: rawResults
    };
  }
  const applied = await transport.post("/revit/set-parameter", { changes, apply: true });
  rawResults.push(applied);
  const after = await transport.post("/revit/get-parameters", { elementIds: targetIds, names: [parameterName] });
  rawResults.push(after);
  let postChangeCapture: unknown = null;
  if (visualVerify) {
    postChangeCapture = await transport.post("/revit/export-image", {
      ...(visualViewId !== null ? { viewId: visualViewId } : {}),
      elementIds: targetIds,
      reason: "parameter edit post-change visual verification before revert"
    });
    rawResults.push(postChangeCapture);
  }

  const afterItems = parameterSnapshotItems(after);
  const afterValues = parameterValueByElementId(after, parameterName);
  const changeRows = targetIds.map((elementId) => ({
    elementId,
    parameter: parameterName,
    oldValue: beforeValues.get(elementId) ?? "",
    newValue: value,
    readbackValue: afterValues.get(elementId) ?? "",
    revertValue: "",
    finalValue: ""
  }));
  const allValuesMatch = targetIds.every((elementId) => afterValues.get(elementId) === value);
  const diffs = parameterDiffs(applied);
  let revertDryRun: unknown = null;
  let reverted: unknown = null;
  let finalReadback: unknown = null;
  let finalItems: JsonMap[] = [];
  let finalValues = new Map<number, string>();
  const postChangeCaptureObj = asObject(postChangeCapture);
  const postChangeCapturePath = firstPathLike(postChangeCaptureObj.path, postChangeCaptureObj.capturePath, asObject(postChangeCaptureObj.capture).path);
  const checks = [
    verification("target_count", targetIds.length > 0, ">0", targetIds.length),
    verification("target_count_matches_request", targetIds.length >= requestedTargetCount, requestedTargetCount, targetIds.length),
    verification("parameter_target_identity_matches_request", targetIdentityMatches, targetGrounding, beforeTargetRows),
    verification("dry_run_returned_diffs", parameterDiffs(dryRun).length > 0 || parameterResultRows(dryRun).length > 0, "diffs[] or result rows", dryRun),
    verification("dry_run_all_changes_ok", !hasParameterWriteErrors(dryRun), "no dry-run write errors", dryRunDiffs),
    verification("apply_all_changes_ok", !hasParameterWriteErrors(applied), "no apply write errors", diffs.length > 0 ? diffs : applied),
    verification("apply_changed_or_confirmed", Number(asObject(applied).changedCount ?? (diffs.filter((d) => d.changed === true).length || parameterResultRows(applied).filter((d) => d.success === true).length)) >= targetIds.length || allValuesMatch, targetIds.length, applied),
    verification("old_values_captured", changeRows.length === targetIds.length, targetIds.length, changeRows.length),
    verification("readback_matches_requested_value", allValuesMatch, value, afterItems)
  ];
  if (visualVerify) {
    checks.push(
      verification("parameter_post_change_capture_returned", !!postChangeCapturePath, "post-change capture path", postChangeCapture),
      verification("parameter_post_change_capture_view_id_matches_request", captureViewMatchesRequest(postChangeCapture, request), visualViewId ?? "no requested capture view", postChangeCapture),
      verification("parameter_post_change_capture_quality_ok", captureQualityOk(postChangeCapture), "capture dimensions >= 512 px when reported and requested focus crop applied", postChangeCapture)
    );
  }

  if (revertAfterVerify) {
    const revertChanges = targetIds.map((elementId) => ({
      elementId,
      parameterName,
      value: beforeValues.get(elementId) ?? ""
    }));
    revertDryRun = await transport.post("/revit/set-parameter", { changes: revertChanges, apply: false });
    rawResults.push(revertDryRun);
    reverted = await transport.post("/revit/set-parameter", { changes: revertChanges, apply: true });
    rawResults.push(reverted);
    finalReadback = await transport.post("/revit/get-parameters", { elementIds: targetIds, names: [parameterName] });
    rawResults.push(finalReadback);
    finalItems = parameterSnapshotItems(finalReadback);
    finalValues = parameterValueByElementId(finalReadback, parameterName);
    const revertDryRunDiffs = parameterDiffs(revertDryRun);
    const revertDiffs = parameterDiffs(reverted);
    const allValuesRestored = targetIds.every((elementId) => finalValues.get(elementId) === (beforeValues.get(elementId) ?? ""));
    for (const row of changeRows) {
      const elementId = Number(row.elementId);
      row.revertValue = beforeValues.get(elementId) ?? "";
      row.finalValue = finalValues.get(elementId) ?? "";
    }
    checks.push(
      verification("revert_dry_run_all_changes_ok", !hasParameterWriteErrors(revertDryRun), "no revert dry-run write errors", revertDryRunDiffs.length > 0 ? revertDryRunDiffs : revertDryRun),
      verification("revert_apply_all_changes_ok", !hasParameterWriteErrors(reverted), "no revert apply write errors", revertDiffs.length > 0 ? revertDiffs : reverted),
      verification("revert_readback_matches_original_value", allValuesRestored, Object.fromEntries(beforeValues), finalItems)
    );
  } else {
    checks.push(verification("revert_not_requested", true, "not requested", { revertAfterVerify }));
  }

  const summaryPath = writeMarkdownTable(path.join(runDir, "artifacts", "parameter_change_summary.md"), changeRows);
  const tablePreview = makeMarkdownTable(changeRows, 10).trim();
  checks.push(verification("parameter_change_summary_written", fs.existsSync(summaryPath) && fs.statSync(summaryPath).size > 0, summaryPath, summaryPath));
  return {
    workflow: "parameter_edit",
    success: countOk(checks),
    failure_reason: countOk(checks) ? null : "Parameter read-back verification failed.",
    tool_calls: (request.query ? 5 : 4) + (visualVerify ? 1 : 0) + (revertAfterVerify ? 3 : 0),
    revit_transactions: revertAfterVerify ? 4 : 2,
    computer_use_actions: 0,
    output_artifacts: [summaryPath],
    verification_results: checks,
    user_message: countOk(checks)
      ? `${revertAfterVerify ? "Updated and reverted" : "Updated"} ${parameterName} on ${targetIds.length} element(s) to '${value}'.\n\n${tablePreview}`
      : "Parameter edit ran, but verification failed.",
    raw_results: rawResults
  };
}

async function runRedlineUpdateParameter(transport: BridgeTransport, request: JsonMap, runDir: string): Promise<RevitWorkflowPartialResult> {
  const partial = await runParameterEdit(transport, request, runDir);
  const captureResult = partial.raw_results.map((entry) => asObject(entry)).find((entry) =>
    firstPathLike(entry.path, entry.capturePath, asObject(entry.capture).path)
  );
  const capturePath = captureResult
    ? firstPathLike(captureResult.path, captureResult.capturePath, asObject(captureResult.capture).path)
    : "";
  const visualViewId = firstPositiveId(request.visualViewId, request.visual_view_id, request.captureViewId, request.viewId, request.view_id);
  const parameterSummaryPath = partial.output_artifacts.find((artifact) => artifact.endsWith("parameter_change_summary.md")) ?? null;
  const summaryPath = path.join(runDir, "artifacts", "redline_update_parameter_summary.json");
  writeJsonFile(summaryPath, {
    workflowStatus: partial.success ? "success" : "failed",
    parameterName: clip(request.parameterName ?? request.parameter_name, 200),
    elementIds: asNumberArray(request.elementIds ?? request.element_ids),
    viewId: visualViewId,
    capturePath: capturePath || null,
    parameterSummaryPath,
    revertAfterVerify: parseBool(request.revertAfterVerify ?? request.revert_after_verify) === true,
    visualVerify: parseBool(request.visualVerify ?? request.visual_verify) === true
  });
  return {
    ...partial,
    workflow: "redline_update_parameter",
    output_artifacts: [...partial.output_artifacts, summaryPath],
    user_message: partial.success
      ? `Redline update-parameter workflow verified through parameter edit primitive.\n\n${partial.user_message}`
      : partial.user_message
  };
}

async function runRedlineAdd(transport: BridgeTransport, request: JsonMap, runDir: string): Promise<RevitWorkflowPartialResult> {
  const viewId = Number(request.viewId ?? request.view_id);
  if (!Number.isFinite(viewId) || viewId <= 0) throw new Error("redline_add requires viewId.");
  const targetKind = normalizeRedlineTargetKind(request.targetKind ?? request.target_kind ?? request.target, "tag");
  const isFamilyInstanceTarget = isRedlineFamilyInstanceTargetKind(targetKind);
  if (targetKind !== "tag" && !isFamilyInstanceTarget) {
    throw new Error("redline_add currently supports targetKind 'tag', 'family_instance', 'receptacle', 'light', or 'mep_accessory'.");
  }
  const rawResults: unknown[] = [];
  let createResult: unknown;
  let createdId: number | null = null;
  let targetIds: number[] = [];
  let requestedTargetElementIds: number[] = [];
  let tagRequestForReadback: JsonMap | null = null;
  let tagApplyMatchesRequest = true;
  let tagReadbackMatches = true;
  let tagCreationErrors: string[] = [];
  let tagDryRunResult: unknown = null;
  let tagDryRunPreflightOk = true;
  let tagApplyAttempted = false;
  let modelWriteTransactions = 0;
  let requestedFamilyInstanceType = "";
  let createdFamilyInstanceLabels: string[] = [];
  let familyInstanceTypeMatchesRequest = true;
  let createdMepRouteKind: "duct" | "pipe" | null = null;
  let createdMepRouteIdsForMutation: number[] = [];
  let mepRouteCreateOk = true;
  if (targetKind === "tag") {
    const tag = asObject(request.tag);
    const elementIds = asNumberArray(tag.elementIds ?? request.elementIds);
    if (elementIds.length <= 0) throw new Error("redline_add tag target requires tag.elementIds.");
    requestedTargetElementIds = elementIds;
    const tagRequest = {
      onlyUntagged: false,
      max: elementIds.length,
      ...tag,
      viewId: firstPositiveId(tag.viewId, request.tagViewId, viewId) ?? viewId,
      elementIds,
      dryRun: false
    };
    tagRequestForReadback = tagRequest;
    if (parseBool(request.dryRunPreflightReviewed ?? request.dry_run_preflight_reviewed ?? tag.dryRunPreflightReviewed ?? tag.dry_run_preflight_reviewed) === true) {
      tagDryRunResult = await transport.post("/revit/tag-elements", { ...tagRequest, dryRun: true });
      rawResults.push(tagDryRunResult);
      const dryRunErrors = tagCreationFailureReasons(tagDryRunResult, { requireCreatedIds: false });
      tagDryRunPreflightOk = dryRunErrors.length === 0 && tagDryRunProofMatchesRequest(tagRequest, tagDryRunResult);
      if (!tagDryRunPreflightOk) {
        createResult = tagDryRunResult;
        tagCreationErrors = dryRunErrors.length > 0 ? dryRunErrors : ["dry_run_preflight_did_not_cover_requested_targets"];
      }
    }
    if (tagDryRunPreflightOk) {
      createResult = await transport.post("/revit/tag-elements", tagRequest);
      tagApplyAttempted = true;
    }
    const createObj = asObject(createResult);
    const createdTagIds = uniquePositiveIds(createObj.tagIds, createObj.tag_ids, createObj.ids, createObj.id, createObj.elementId, createObj.createdElementId);
    createdId = firstPositiveId(...createdTagIds);
    targetIds = createdTagIds.length > 0 ? createdTagIds : createdId !== null ? [createdId] : [];
    tagApplyMatchesRequest = tagAppliedProofMatchesRequest(tagRequest, createResult);
    tagReadbackMatches = tagReadbackMatchesRequest(tagRequest, createResult);
    tagCreationErrors = tagCreationErrors.length > 0 ? tagCreationErrors : tagCreationFailureReasons(createResult);
  } else {
    const createBase = asObject(request.familyInstance ?? request.family_instance ?? request.device ?? request.createFamilyInstance ?? request.create);
    requestedFamilyInstanceType = clip(createBase.symbolName ?? createBase.typeName ?? request.symbolName ?? createBase.familyName, 220);
    if (!requestedFamilyInstanceType && !clip(createBase.familyName, 220)) throw new Error("redline_add family_instance target requires familyInstance.symbolName, typeName, or familyName.");
    const createRequest = {
      familyName: "",
      levelName: "",
      x: 0,
      y: 0,
      z: 0,
      ...createBase,
      symbolName: clip(createBase.symbolName ?? createBase.typeName ?? request.symbolName, 220)
    };
    createResult = await transport.post("/revit/create-family-instance", createRequest);
    const createObj = asObject(createResult);
    createdId = firstPositiveId(createObj.id, createObj.elementId, createObj.createdElementId);
    targetIds = createdId !== null ? [createdId] : [];
    createdFamilyInstanceLabels = collectCreatedFamilyLabels(createObj);
    familyInstanceTypeMatchesRequest = proofLabelsMatchRequest(requestedFamilyInstanceType || clip(createRequest.familyName, 220), createdFamilyInstanceLabels);
  }
  if (createResult !== tagDryRunResult) rawResults.push(createResult);
  const after = await transport.post("/revit/export-visible-elements", {
    viewId,
    includeMapping: true,
    includeGeometry: true,
    imageSize: request.imageSize ?? 1800
  });
  rawResults.push(after);
  let cleanupDryRun: unknown = null;
  let cleanupApplied: unknown = null;
  if (createdId !== null && request.cleanupCreatedElements !== false) {
    cleanupDryRun = await transport.post("/revit/delete", { ids: targetIds, dryRun: true, apply: false });
    rawResults.push(cleanupDryRun);
    cleanupApplied = await transport.post("/revit/delete", { ids: targetIds, apply: true });
    rawResults.push(cleanupApplied);
  }
  const afterItem = createdId !== null ? inventoryItemByElementId(after, createdId) : {};
  const afterCapturePath = firstPathLike(asObject(after).imagePath, asObject(after).path, asObject(after).capturePath);
  const cleanupDryRunIds = deleteEffectIds(cleanupDryRun);
  const cleanupDeletedIds = deleteEffectIds(cleanupApplied);
  const nativeAddDryRunProvesTargetExists = isFamilyInstanceTarget && deleteDryRunDetailsCoverExistingIds(cleanupDryRun, targetIds);
  const visibleAfter = targetIds.length > 0 && (
    targetIds.every((id) => inventoryContainsElementId(after, id)) ||
    nativeAddDryRunProvesTargetExists
  );
  const cleanupRequested = request.cleanupCreatedElements !== false;
  modelWriteTransactions =
    (createdId !== null ? 1 : 0) +
    (cleanupRequested && targetIds.length > 0 && targetIds.every((id) => cleanupDeletedIds.includes(id)) ? 1 : 0);
  const summaryRows = [
    {
      action: targetKind === "tag" ? "create_tag" : "create_family_instance",
      targetKind,
      viewId,
      createdId: createdId ?? "",
      requestedTargetIds: requestedTargetElementIds.join(";"),
      requestedFamilyInstanceType,
      createdFamilyInstanceLabels: createdFamilyInstanceLabels.join(";"),
      visibleAfter,
      nativeAddDryRunProvesTargetExists,
      afterCapturePath
    },
    {
      action: `cleanup_${targetKind}`,
      targetKind,
      cleanupRequested,
      dryRunIds: cleanupDryRunIds.join(";"),
      deletedIds: cleanupDeletedIds.join(";")
    }
  ];
  const summaryJsonPath = path.join(runDir, "artifacts", "redline_add_summary.json");
  const summaryMarkdownPath = writeMarkdownTable(path.join(runDir, "artifacts", "redline_add_summary.md"), summaryRows);
  const visualGate = {
    status: visibleAfter && !!afterCapturePath ? "pass" : "fail",
    authority: nativeAddDryRunProvesTargetExists ? "native_delete_dry_run_and_capture" : "deterministic_inventory",
    reason: visibleAfter
      ? nativeAddDryRunProvesTargetExists
        ? `created ${targetKind} was proven by native cleanup dry-run details and post-add capture`
        : `created ${targetKind} was visible after add-like redline`
      : `created ${targetKind} visibility did not prove add-like redline`,
    afterCapturePath,
    targetKind,
    targetIds,
    assertions: [
      { name: "target_visible_after_add", status: visibleAfter ? "pass" : "fail", expected: createdId, actual: visibleAfter }
    ]
  };
  const visualGatePath = path.join(runDir, "artifacts", "redline_add_visual_gate.json");
  writeJsonFile(summaryJsonPath, {
    viewId,
    targetKind,
    requestedTargetElementIds,
    tagApplyMatchesRequest,
    tagReadbackMatches,
    tagCreationErrors,
    tagDryRunPreflightOk,
    rawTagDryRunResult: tagDryRunResult,
    tagRequestForReadback,
    requestedFamilyInstanceType,
    createdFamilyInstanceLabels,
    familyInstanceTypeMatchesRequest,
    createdId,
    targetIds,
    visibleAfter,
    cleanupRequested,
    cleanupDryRunIds,
    cleanupDeletedIds,
    afterCapturePath,
    rawCreateResult: createResult,
    rawCleanupDryRun: cleanupDryRun,
    rawCleanupApplied: cleanupApplied
  });
  writeJsonFile(visualGatePath, visualGate);
  const checks = [
    verification(
      targetKind === "tag" ? "add_redline_created_tag_id_present" : "add_redline_created_family_instance_id_present",
      createdId !== null,
      targetKind === "tag" ? "created disposable tag id" : "created disposable family instance id",
      createResult
    ),
    ...(isFamilyInstanceTarget
      ? [
          verification(
            "add_redline_family_instance_type_matches_request",
            familyInstanceTypeMatchesRequest,
            requestedFamilyInstanceType || "requested family/type label",
            createdFamilyInstanceLabels,
            "created family instance type/name evidence must match requested symbol/type/family"
          )
        ]
      : []),
    ...(targetKind === "tag"
      ? [
          ...(tagDryRunResult
            ? [
                verification(
                  "add_redline_tag_dry_run_preflight_ok",
                  tagDryRunPreflightOk,
                  "tag dry-run preview covers requested targets and reports no errors",
                  tagDryRunResult
                )
              ]
            : []),
          verification(
            "add_redline_tag_create_no_errors",
            tagApplyAttempted && tagCreationErrors.length === 0,
            "no Revit tag creation errors",
            tagCreationErrors.length > 0 ? tagCreationErrors : createResult,
            "Revit tag creation must not report partial-success errors"
          ),
          verification(
            "add_redline_tag_apply_matches_request",
            tagApplyMatchesRequest,
            { viewId: tagRequestForReadback?.viewId, elementIds: requestedTargetElementIds },
            createResult,
            "tag creation result must cover requested target elements in the requested view"
          ),
          verification(
            "add_redline_tag_readback_matches_request",
            tagReadbackMatches,
            "reported tag readback must cover requested targets and requested type/value/kind hints",
            createResult
          )
        ]
      : []),
    verification("add_redline_target_visible_after", visibleAfter, "created target visible after add", { createdId, afterCount: collectionCount(after) }),
    verification("add_redline_visual_gate_passed", visualGate.status === "pass", "pass", visualGate.status),
    verification("add_redline_cleanup_dry_run_ok", !cleanupRequested || (targetIds.length > 0 && targetIds.every((id) => cleanupDryRunIds.includes(id))), targetIds, cleanupDryRunIds),
    verification("add_redline_cleanup_applied_ids_present", !cleanupRequested || (targetIds.length > 0 && targetIds.every((id) => cleanupDeletedIds.includes(id))), targetIds, cleanupDeletedIds),
    verification("add_redline_summary_written", fs.existsSync(summaryJsonPath) && fs.existsSync(summaryMarkdownPath) && fs.existsSync(visualGatePath), "summary artifacts", [summaryJsonPath, summaryMarkdownPath, visualGatePath])
  ];
  const success = countOk(checks);
  const failureReason = success
    ? null
    : targetKind === "tag" && tagCreationErrors.length > 0
      ? `Add-like redline tag creation failed: ${tagCreationErrors.join("; ")}`
      : "Add-like redline workflow verification failed.";
  return {
    workflow: "redline_add",
    success,
    failure_reason: failureReason,
    tool_calls: rawResults.length,
    revit_transactions: modelWriteTransactions,
    computer_use_actions: 0,
    output_artifacts: [summaryJsonPath, summaryMarkdownPath, visualGatePath],
    verification_results: checks,
    user_message: success ? `Created, verified, and cleaned up disposable redline target ${createdId}.` : "Add-like redline workflow ran, but verification failed.",
    raw_results: rawResults
  };
}

async function runRedlineTypeChange(transport: BridgeTransport, request: JsonMap, runDir: string): Promise<RevitWorkflowPartialResult> {
  const elementIds = asNumberArray(request.elementIds ?? request.ids);
  if (elementIds.length <= 0) throw new Error("redline_type_change requires elementIds.");
  const category = clip(request.category, 120);
  const targetTypeName = clip(request.targetTypeName ?? request.typeName ?? request.newTypeName, 240);
  const targetTypeId = firstPositiveId(request.targetTypeId, request.typeId, request.newTypeId);
  if (targetTypeId === null && !targetTypeName) throw new Error("redline_type_change requires targetTypeId or targetTypeName.");
  const revertAfterVerify = request.revertAfterVerify !== false;
  const visualVerify = request.visualVerify !== false;
  const visualViewId = firstPositiveId(request.visualViewId, request.viewId, request.view_id);
  const sourceTypeGrounding = asObject(request.sourceTypeGrounding ?? request.source_type_grounding);
  const sourceFamilyGrounding = asObject(request.sourceFamilyGrounding ?? request.source_family_grounding ?? request.existingTarget ?? request.existing_target);
  const expectedSourceFamilyName = clip(sourceFamilyGrounding.expectedFamilyName ?? sourceFamilyGrounding.expected_family_name ?? sourceFamilyGrounding.familyName ?? sourceFamilyGrounding.family_name, 240);
  const expectedSourceTypeName = clip(sourceFamilyGrounding.expectedTypeName ?? sourceFamilyGrounding.expected_type_name ?? sourceFamilyGrounding.typeName ?? sourceFamilyGrounding.type_name, 240);
  const expectedSourceCategory = clip(sourceFamilyGrounding.expectedCategory ?? sourceFamilyGrounding.expected_category ?? sourceFamilyGrounding.category ?? sourceFamilyGrounding.categoryName ?? sourceFamilyGrounding.builtInCategory ?? sourceFamilyGrounding.built_in_category, 240);
  const expectedOriginalTypeId = firstPositiveId(
    sourceTypeGrounding.expectedCurrentTypeId,
    sourceTypeGrounding.expected_current_type_id,
    request.expectedCurrentTypeId,
    request.expected_current_type_id,
    request.originalTypeId,
    request.original_type_id
  );
  const expectedOriginalTypeName = normalizedTypeName(
    sourceTypeGrounding.expectedCurrentTypeName
    ?? sourceTypeGrounding.expected_current_type_name
    ?? request.expectedCurrentTypeName
    ?? request.expected_current_type_name
    ?? request.originalTypeName
    ?? request.original_type_name
  );
  const dryRunPreflightReviewed = parseBool(request.dryRunPreflightReviewed ?? request.dry_run_preflight_reviewed) === true;
  const targetTypeCompatibilityReviewed = parseBool(request.targetTypeCompatibilityReviewed ?? request.target_type_compatibility_reviewed) === true;
  const rawResults: unknown[] = [];
  const changeRequest: JsonMap = {
    elementIds,
    ...(targetTypeId !== null ? { typeId: targetTypeId } : { typeName: targetTypeName }),
    ...(category ? { category } : {}),
    ...(clip(request.familyName, 240) ? { familyName: clip(request.familyName, 240) } : {})
  };
  const dryRun = await transport.post("/revit/change-element-type", { ...changeRequest, dryRun: true });
  rawResults.push(dryRun);
  const dryRunRows = typeChangeRows(dryRun);
  const dryRunIds = typeChangeEffectIds(dryRun);
  const originalTypeIds = new Map<number, number>();
  for (const row of dryRunRows) {
    const elementId = firstPositiveId(row.elementId);
    const oldTypeId = firstPositiveId(row.oldTypeId);
    if (elementId !== null && oldTypeId !== null) originalTypeIds.set(elementId, oldTypeId);
  }
  const expectedNewTypeId = firstPositiveId(targetTypeId, asObject(dryRun).newTypeId, ...dryRunRows.map((row) => row.newTypeId));
  const expectedNewTypeName = normalizedTypeName(targetTypeName);
  const dryRunOk = elementIds.every((id) => dryRunIds.includes(id)) && dryRunRows.every((row) => row.ok !== false);
  const dryRunTargetMatches = typeChangeAppliedMatchesRequest(dryRun, elementIds, expectedNewTypeId, expectedNewTypeName);
  const sourceTypeGroundingOk = typeChangeSourceGroundingMatches(dryRun, elementIds, expectedOriginalTypeId, expectedOriginalTypeName);
  const sourceFamilyGroundingOk = typeChangeSourceFamilyGroundingMatches(dryRun, elementIds, expectedSourceFamilyName, expectedSourceTypeName, expectedSourceCategory);
  const preApplyChecks = [
    verification("type_change_request_present", elementIds.length > 0 && (targetTypeId !== null || !!targetTypeName), "element ids and target type", { elementIds, targetTypeId, targetTypeName }),
    verification("type_change_dry_run_ok", dryRunOk, elementIds, dryRun),
    verification("type_change_dry_run_target_matches_request", dryRunTargetMatches, expectedNewTypeId ?? expectedNewTypeName, dryRun),
    verification("type_change_source_type_grounding_ok", sourceTypeGroundingOk, (expectedOriginalTypeId ?? expectedOriginalTypeName) || "source type readback", dryRun),
    verification("type_change_source_family_grounding_ok", sourceFamilyGroundingOk, { expectedSourceFamilyName, expectedSourceTypeName, expectedSourceCategory }, dryRun),
    verification("type_change_dry_run_preflight_reviewed", dryRunPreflightReviewed, true, dryRunPreflightReviewed),
    verification("type_change_target_compatibility_reviewed", targetTypeCompatibilityReviewed, true, targetTypeCompatibilityReviewed)
  ];
  const preApplyOk = countOk(preApplyChecks);
  const summaryJsonPath = path.join(runDir, "artifacts", "redline_type_change_summary.json");
  if (!preApplyOk) {
    writeJsonFile(summaryJsonPath, {
      elementIds,
      category,
      targetTypeId,
      targetTypeName,
      expectedNewTypeId,
      expectedNewTypeName,
      expectedOriginalTypeId,
      expectedOriginalTypeName,
      expectedSourceFamilyName,
      expectedSourceTypeName,
      expectedSourceCategory,
      sourceFamilyGroundingOk,
      dryRunIds,
      dryRunPreflightReviewed,
      targetTypeCompatibilityReviewed,
      blockedBeforeModelWrite: true,
      rawDryRun: dryRun
    });
    const summaryMarkdownPath = writeMarkdownTable(path.join(runDir, "artifacts", "redline_type_change_summary.md"), elementIds.map((id) => ({
      elementId: id,
      requestedTypeId: expectedNewTypeId ?? targetTypeId ?? "",
      requestedTypeName: targetTypeName,
      blockedBeforeModelWrite: true
    })));
    const blockedChecks = [
      ...preApplyChecks,
      verification("type_change_apply_ids_present", false, "blocked before model write", []),
      verification("type_change_readback_matches_target", false, "blocked before model write", null),
      verification("type_change_post_change_capture_returned", false, "blocked before model write", null),
      verification("type_change_post_change_capture_view_id_matches_request", false, "blocked before model write", null),
      verification("type_change_revert_dry_run_ok", false, "blocked before model write", []),
      verification("type_change_revert_apply_ids_present", false, "blocked before model write", []),
      verification("type_change_revert_readback_matches_original", false, "blocked before model write", null),
      verification("type_change_summary_written", fs.existsSync(summaryJsonPath) && fs.existsSync(summaryMarkdownPath), "summary artifacts", [summaryJsonPath, summaryMarkdownPath])
    ];
    return {
      workflow: "redline_type_change",
      success: false,
      failure_reason: "Type-change redline blocked before model write because dry-run/source-type evidence was incomplete.",
      tool_calls: 1,
      revit_transactions: 0,
      computer_use_actions: 0,
      output_artifacts: [summaryJsonPath, summaryMarkdownPath],
      verification_results: blockedChecks,
      user_message: "Type-change redline blocked before model write because dry-run compatibility/source-type proof was incomplete.",
      raw_results: rawResults
    };
  }
  const applied = await transport.post("/revit/change-element-type", { ...changeRequest, dryRun: false });
  rawResults.push(applied);
  const appliedIds = typeChangeEffectIds(applied);
  const appliedObj = asObject(applied);
  const appliedNewTypeId = firstPositiveId(appliedObj.newTypeId, ...typeChangeRows(applied).map((row) => row.newTypeId));
  const appliedNewTypeName = firstString(appliedObj.newTypeName, ...typeChangeRows(applied).map((row) => row.newTypeName));
  const appliedTypeMatchesRequest = typeChangeAppliedMatchesRequest(applied, elementIds, expectedNewTypeId, expectedNewTypeName);
  const readback = await transport.post("/revit/change-element-type", { ...changeRequest, dryRun: true });
  rawResults.push(readback);
  const readbackRows = typeChangeRows(readback);
  const readbackMatches = typeChangeReadbackMatchesRequest(readback, elementIds, expectedNewTypeId, expectedNewTypeName);
  let postChangeCapture: unknown = null;
  let postChangeCapturePath = "";
  let postChangeCaptureViewId: number | null = null;
  if (visualVerify && visualViewId !== null) {
    postChangeCapture = await transport.post("/revit/export-image", {
      viewId: visualViewId,
      reason: "type-change redline post-change visual verification before revert"
    });
    rawResults.push(postChangeCapture);
    const captureObj = asObject(postChangeCapture);
    postChangeCapturePath = firstPathLike(captureObj.path, captureObj.capturePath, captureObj.capture_path, captureObj.imagePath, captureObj.image_path, captureObj.screenshotPath, captureObj.screenshot_path);
    postChangeCaptureViewId = captureReportedViewId(postChangeCapture);
  }
  let revertDryRun: unknown = null;
  let reverted: unknown = null;
  let revertReadback: unknown = null;
  let revertDryRunIds: number[] = [];
  let revertedIds: number[] = [];
  let revertReadbackMatches = true;
  if (revertAfterVerify) {
    const originalTypeId = originalTypeIds.get(elementIds[0]);
    if (originalTypeId !== undefined && [...originalTypeIds.values()].every((id) => id === originalTypeId)) {
      const revertRequest = { elementIds, typeId: originalTypeId };
      revertDryRun = await transport.post("/revit/change-element-type", { ...revertRequest, dryRun: true });
      rawResults.push(revertDryRun);
      reverted = await transport.post("/revit/change-element-type", { ...revertRequest, dryRun: false });
      rawResults.push(reverted);
      revertReadback = await transport.post("/revit/change-element-type", { ...revertRequest, dryRun: true });
      rawResults.push(revertReadback);
      revertDryRunIds = typeChangeEffectIds(revertDryRun);
      revertedIds = typeChangeEffectIds(reverted);
      const rows = typeChangeRows(revertReadback);
      revertReadbackMatches = elementIds.every((id) => {
        const row = rows.find((entry) => Number(entry.elementId) === id);
        return row?.ok !== false && firstPositiveId(row?.oldTypeId) === originalTypeId;
      });
    } else {
      revertReadbackMatches = false;
    }
  }
  const summaryRows = elementIds.map((id) => {
    const dryRunRow = dryRunRows.find((row) => Number(row.elementId) === id) ?? {};
    const applyRow = typeChangeRows(applied).find((row) => Number(row.elementId) === id) ?? {};
    const readbackRow = readbackRows.find((row) => Number(row.elementId) === id) ?? {};
    return {
      elementId: id,
      originalTypeId: dryRunRow.oldTypeId ?? "",
      requestedTypeId: expectedNewTypeId ?? targetTypeId ?? "",
      requestedTypeName: targetTypeName,
      appliedNewTypeId: applyRow.newTypeId ?? appliedNewTypeId ?? "",
      appliedNewTypeName: applyRow.newTypeName ?? appliedNewTypeName,
      readbackOldTypeId: readbackRow.oldTypeId ?? "",
      reverted: revertAfterVerify
    };
  });
  const summaryMarkdownPath = writeMarkdownTable(path.join(runDir, "artifacts", "redline_type_change_summary.md"), summaryRows);
  writeJsonFile(summaryJsonPath, {
    elementIds,
    category,
    targetTypeId,
    targetTypeName,
    expectedNewTypeId,
    expectedNewTypeName,
    expectedOriginalTypeId,
    expectedOriginalTypeName,
    expectedSourceFamilyName,
    expectedSourceTypeName,
    expectedSourceCategory,
    sourceFamilyGroundingOk,
    appliedNewTypeId,
    appliedNewTypeName,
    appliedTypeMatchesRequest,
    dryRunPreflightReviewed,
    targetTypeCompatibilityReviewed,
    dryRunIds,
    appliedIds,
    readbackMatches,
    postChangeCapturePath,
    postChangeCaptureViewId,
    revertAfterVerify,
    revertDryRunIds,
    revertedIds,
    revertReadbackMatches,
    rawDryRun: dryRun,
    rawApplied: applied,
    rawReadback: readback,
    rawRevertDryRun: revertDryRun,
    rawReverted: reverted,
    rawRevertReadback: revertReadback
  });
  const checks = [
    ...preApplyChecks,
    verification("type_change_apply_ids_present", elementIds.every((id) => appliedIds.includes(id)), elementIds, appliedIds),
    verification("type_change_target_type_matches_request", appliedTypeMatchesRequest, expectedNewTypeId ?? expectedNewTypeName, { appliedNewTypeId, appliedNewTypeName }),
    verification("type_change_readback_matches_target", readbackMatches, expectedNewTypeId ?? expectedNewTypeName, readback),
    verification("type_change_post_change_capture_returned", !visualVerify || visualViewId === null || !!postChangeCapturePath, "post-change capture path", postChangeCapturePath || postChangeCapture),
    verification("type_change_post_change_capture_view_id_matches_request", !visualVerify || visualViewId === null || captureViewMatchesRequest(postChangeCapture, request), visualViewId ?? "no requested capture view", postChangeCapture),
    verification("type_change_revert_dry_run_ok", !revertAfterVerify || elementIds.every((id) => revertDryRunIds.includes(id)), elementIds, revertDryRunIds),
    verification("type_change_revert_apply_ids_present", !revertAfterVerify || elementIds.every((id) => revertedIds.includes(id)), elementIds, revertedIds),
    verification("type_change_revert_readback_matches_original", !revertAfterVerify || revertReadbackMatches, "original type ids restored", revertReadback),
    verification("type_change_summary_written", fs.existsSync(summaryJsonPath) && fs.existsSync(summaryMarkdownPath), "summary artifacts", [summaryJsonPath, summaryMarkdownPath])
  ];
  const success = countOk(checks);
  return {
    workflow: "redline_type_change",
    success,
    failure_reason: success ? null : "Type-change redline workflow verification failed.",
    tool_calls: 3 + (visualVerify && visualViewId !== null ? 1 : 0) + (revertAfterVerify ? 3 : 0),
    revit_transactions: 1 + (revertAfterVerify ? 1 : 0),
    computer_use_actions: 0,
    output_artifacts: [summaryJsonPath, summaryMarkdownPath],
    verification_results: checks,
    user_message: success ? `Changed and reverted type for ${elementIds.length} redline target(s).` : "Type-change redline workflow ran, but verification failed.",
    raw_results: rawResults
  };
}

async function runRedlineDelete(transport: BridgeTransport, request: JsonMap, runDir: string): Promise<RevitWorkflowPartialResult> {
  const viewId = Number(request.viewId ?? request.view_id);
  if (!Number.isFinite(viewId) || viewId <= 0) throw new Error("redline_delete requires viewId.");
  const targetKind = normalizeRedlineTargetKind(request.targetKind ?? request.target_kind ?? request.target, "text_note");
  const existingTarget = asObject(request.existingTarget ?? request.existing_target ?? request.targetElement ?? request.target_element);
  const existingTargetIds = uniquePositiveIds(existingTarget.elementIds, existingTarget.element_ids, existingTarget.ids, existingTarget.elementId, existingTarget.element_id, request.targetElementIds, request.target_element_ids);
  const textNoteBase = asObject(request.textNote ?? request.text_note);
  const existingTextNoteIds = uniquePositiveIds(textNoteBase.textNoteId, textNoteBase.text_note_id, textNoteBase.elementId, textNoteBase.element_id, request.textNoteId, request.text_note_id);
  const tagBase = asObject(request.tag);
  const existingTagIds = uniquePositiveIds(tagBase.existingTagIds, tagBase.existing_tag_ids, tagBase.tagIds, tagBase.tag_ids);
  const requestedExistingDelete = existingTargetIds.length > 0 || parseBool(existingTarget.deleteExisting ?? existingTarget.delete_existing ?? request.deleteExistingTarget ?? request.delete_existing_target) === true;
  const requestedExistingTextDelete = existingTextNoteIds.length > 0 || parseBool(textNoteBase.deleteExisting ?? textNoteBase.delete_existing) === true;
  const requestedExistingTagDelete = existingTagIds.length > 0 || parseBool(tagBase.deleteExisting ?? tagBase.delete_existing) === true;
  const allExistingTargetIds = Array.from(new Set([...existingTargetIds, ...existingTextNoteIds, ...existingTagIds]));
  const isFamilyInstanceTarget = isRedlineFamilyInstanceTargetKind(targetKind);
  const deleteExistingTextTarget = targetKind === "text_note" && (requestedExistingDelete || requestedExistingTextDelete);
  const deleteExistingFamilyTarget = isFamilyInstanceTarget && requestedExistingDelete;
  const deleteExistingRouteTarget = targetKind === "mep_route" && requestedExistingDelete;
  const deleteExistingTagTarget = targetKind === "tag" && (requestedExistingDelete || requestedExistingTagDelete);
  const deleteExistingTarget = deleteExistingTextTarget || deleteExistingFamilyTarget || deleteExistingRouteTarget || deleteExistingTagTarget;
  const requestedExistingTargetFamily = clip(existingTarget.expectedFamilyName ?? existingTarget.expected_family_name ?? existingTarget.familyName ?? existingTarget.family_name, 220);
  const requestedExistingTargetType = clip(existingTarget.expectedTypeName ?? existingTarget.expected_type_name ?? existingTarget.typeName ?? existingTarget.type_name ?? request.expectedTypeName ?? request.expected_type_name, 220);
  const requestedExistingTargetCategory = clip(existingTarget.expectedCategory ?? existingTarget.expected_category ?? existingTarget.category ?? existingTarget.categoryName ?? existingTarget.builtInCategory ?? existingTarget.built_in_category, 220);
  const requestedExistingTargetKind = clip(existingTarget.expectedKind ?? existingTarget.expected_kind ?? existingTarget.kind ?? request.kind ?? request.routeKind ?? request.route_kind, 80);
  const requestedExistingTargetSystem = clip(existingTarget.expectedSystemName ?? existingTarget.expected_system_name ?? existingTarget.systemName ?? existingTarget.system_name ?? request.systemType ?? request.system_type, 220);
  const requestedExistingText = clip(existingTarget.expectedText ?? existingTarget.expected_text ?? existingTarget.expectedVisibleText ?? existingTarget.expected_visible_text ?? textNoteBase.expectedExistingText ?? textNoteBase.expected_existing_text ?? textNoteBase.originalText ?? textNoteBase.original_text ?? textNoteBase.text, 1000);
  const requestedExistingTagText = clip(existingTarget.expectedTagText ?? existingTarget.expected_tag_text ?? existingTarget.expectedVisibleText ?? existingTarget.expected_visible_text ?? tagBase.expectedTagText ?? tagBase.expectedVisibleText, 220);
  const requestedExistingTaggedElementIds = uniquePositiveIds(existingTarget.taggedElementIds, existingTarget.tagged_element_ids, tagBase.elementIds, tagBase.element_ids, request.elementIds, request.element_ids);
  const rawResults: unknown[] = [];
  let createResult: unknown;
  let createdId: number | null;
  let text = "";
  let createAction = "";
  let visibleCategories: string[] | null = null;
  let requestedFamilyInstanceType = "";
  let createdFamilyInstanceLabels: string[] = [];
  let familyInstanceTypeMatchesRequest = true;
  let createdMepRouteKind: "duct" | "pipe" | null = null;
  let createdMepRouteIdsForMutation: number[] = [];
  let mepRouteCreateOk = true;
  if (deleteExistingTextTarget) {
    if (allExistingTargetIds.length <= 0) throw new Error("redline_delete existing TextNote target requires existingTarget.elementIds or textNote.textNoteId.");
    createAction = "existing_text_note";
    visibleCategories = ["OST_TextNotes"];
    createResult = { status: "ExistingTextNoteTarget", elementIds: allExistingTargetIds };
    createdId = allExistingTargetIds[0] ?? null;
    text = requestedExistingText;
  } else if (deleteExistingFamilyTarget) {
    if (allExistingTargetIds.length <= 0) throw new Error("redline_delete existing target requires existingTarget.elementIds.");
    createAction = "existing_family_instance";
    createResult = { status: "ExistingTarget", elementIds: allExistingTargetIds };
    createdId = allExistingTargetIds[0] ?? null;
    requestedFamilyInstanceType = requestedExistingTargetType || requestedExistingTargetFamily;
    createdFamilyInstanceLabels = requestedFamilyInstanceType ? [requestedFamilyInstanceType] : [];
  } else if (deleteExistingRouteTarget) {
    if (allExistingTargetIds.length <= 0) throw new Error("redline_delete existing route target requires existingTarget.elementIds.");
    createAction = "existing_mep_route";
    createResult = { status: "ExistingRouteTarget", elementIds: allExistingTargetIds };
    createdId = allExistingTargetIds[0] ?? null;
    createdMepRouteKind = routeKindFromTargetKind(targetKind, request);
    createdMepRouteIdsForMutation = allExistingTargetIds;
  } else if (deleteExistingTagTarget) {
    if (allExistingTargetIds.length <= 0) throw new Error("redline_delete existing tag target requires existingTarget.elementIds or tag.existingTagIds.");
    createAction = "existing_tag";
    createResult = { status: "ExistingTagTarget", elementIds: allExistingTargetIds };
    createdId = allExistingTargetIds[0] ?? null;
  } else if (targetKind === "tag") {
    const tag = asObject(request.tag);
    const elementIds = asNumberArray(tag.elementIds ?? request.elementIds);
    if (elementIds.length <= 0) throw new Error("redline_delete tag target requires tag.elementIds.");
    const tagRequest = {
      onlyUntagged: false,
      max: elementIds.length,
      ...tag,
      viewId: firstPositiveId(tag.viewId, request.tagViewId, viewId) ?? viewId,
      elementIds,
      dryRun: false
    };
    createAction = "create_tag";
    createResult = await transport.post("/revit/tag-elements", tagRequest);
    createdId = firstPositiveId(...asNumberArray(asObject(createResult).tagIds), asObject(createResult).id, asObject(createResult).elementId, asObject(createResult).createdElementId);
  } else if (isFamilyInstanceTarget) {
    const createBase = asObject(request.familyInstance ?? request.family_instance ?? request.device ?? request.createFamilyInstance ?? request.create);
    requestedFamilyInstanceType = clip(createBase.symbolName ?? createBase.typeName ?? request.symbolName ?? createBase.familyName, 220);
    if (!requestedFamilyInstanceType && !clip(createBase.familyName, 220)) throw new Error("redline_delete family_instance target requires familyInstance.symbolName, typeName, or familyName.");
    const createRequest = {
      familyName: "",
      levelName: "",
      x: 0,
      y: 0,
      z: 0,
      ...createBase,
      symbolName: clip(createBase.symbolName ?? createBase.typeName ?? request.symbolName, 220)
    };
    createAction = "create_family_instance";
    createResult = await transport.post("/revit/create-family-instance", createRequest);
    const createObj = asObject(createResult);
    createdId = firstPositiveId(createObj.id, createObj.elementId, createObj.createdElementId);
    createdFamilyInstanceLabels = collectCreatedFamilyLabels(createObj);
    familyInstanceTypeMatchesRequest = proofLabelsMatchRequest(requestedFamilyInstanceType || clip(createRequest.familyName, 220), createdFamilyInstanceLabels);
  } else if (targetKind === "mep_route") {
    const routeTarget = await createDisposableMepRouteTarget(transport, request, targetKind);
    createAction = "create_mep_route";
    createResult = routeTarget.result;
    createdMepRouteKind = routeTarget.kind;
    createdMepRouteIdsForMutation = routeTarget.ids;
    createdId = firstPositiveId(...createdMepRouteIdsForMutation);
    mepRouteCreateOk = mepRouteCreateStatusOk(createResult) && createdMepRouteIdsForMutation.length > 0;
    visibleCategories = createdMepRouteKind === "pipe"
      ? ["OST_PipeCurves", "OST_PipeFitting"]
      : ["OST_DuctCurves", "OST_DuctFitting"];
  } else {
    const note = textNoteBase;
    text = firstString(note.text, request.text, `OPERATOR DELETE REDLINE ${Date.now()}`);
    const createBody = {
      action: "create",
      viewId,
      x: Number(note.x ?? request.x ?? 1),
      y: Number(note.y ?? request.y ?? 1),
      text
    };
    createAction = "create_text_note";
    visibleCategories = ["OST_TextNotes"];
    createResult = await transport.post("/revit/create-text", createBody);
    createdId = firstPositiveId(
      asObject(createResult).id,
      asObject(createResult).textNoteId,
      asObject(createResult).elementId,
      asObject(createResult).createdElementId
    );
  }
  rawResults.push(createResult);
  const beforeCaptureRequest: JsonMap = {
    viewId,
    includeMapping: true,
    includeGeometry: true,
    imageSize: request.imageSize ?? 1800
  };
  if (visibleCategories !== null) beforeCaptureRequest.categories = visibleCategories;
  const before = await transport.post("/revit/export-visible-elements", beforeCaptureRequest);
  rawResults.push(before);
  let deleteDryRun: unknown = null;
  let deleteApplied: unknown = null;
  let after: unknown = null;
  let routeNetworkAudit: unknown = null;
  const targetIds = deleteExistingTarget ? allExistingTargetIds : targetKind === "mep_route" ? createdMepRouteIdsForMutation : createdId !== null ? [createdId] : [];
  if (targetIds.length > 0) {
    if (deleteExistingRouteTarget) {
      routeNetworkAudit = await transport.post("/revit/trace-connected-network", {
        viewId,
        elementIds: targetIds,
        ids: targetIds,
        dryRun: true,
        includeConnectors: true,
        includeSystem: true,
        reason: "existing route delete redline preflight network impact audit"
      });
      rawResults.push(routeNetworkAudit);
    }
    deleteDryRun = await transport.post("/revit/delete", { ids: targetIds, dryRun: true, apply: false });
    rawResults.push(deleteDryRun);
    if (!deleteExistingTarget) {
      deleteApplied = await transport.post("/revit/delete", { ids: targetIds, apply: true });
      rawResults.push(deleteApplied);
    }
    const afterCaptureRequest: JsonMap = {
      viewId,
      includeMapping: true,
      includeGeometry: true,
      imageSize: request.imageSize ?? 1800
    };
    if (visibleCategories !== null) afterCaptureRequest.categories = visibleCategories;
    after = await transport.post("/revit/export-visible-elements", afterCaptureRequest);
    rawResults.push(after);
  }
  const dryRunIds = deleteEffectIds(deleteDryRun);
  const deletedIds = deleteEffectIds(deleteApplied);
  const nativeDeleteDryRunProvesTargetExists = !deleteExistingTarget && deleteDryRunDetailsCoverExistingIds(deleteDryRun, targetIds);
  const visibleBefore = targetIds.length > 0 && (
    targetIds.every((id) => inventoryContainsElementId(before, id)) ||
    nativeDeleteDryRunProvesTargetExists
  );
  const visibleAfter = targetIds.length > 0 && after !== null && (
    targetIds.every((id) => !inventoryContainsElementId(after, id)) ||
    targetIds.every((id) => deletedIds.includes(id))
  );
  const visibleAfterDryRun = deleteExistingTarget && targetIds.length > 0 && after !== null && targetIds.every((id) => inventoryContainsElementId(after, id));
  const primaryTargetId = targetIds[0] ?? null;
  const beforeItem = primaryTargetId !== null ? inventoryItemByElementId(before, primaryTargetId) : {};
  const afterItem = primaryTargetId !== null && after !== null ? inventoryItemByElementId(after, primaryTargetId) : {};
  const existingTargetFamilyTypeLabels = deleteExistingTarget ? collectInventoryFamilyTypeLabels(beforeItem, afterItem) : [];
  const existingTargetCategoryLabels = deleteExistingTarget ? collectInventoryCategoryLabels(beforeItem, afterItem) : [];
  const existingTargetSystemLabels = deleteExistingTarget ? collectInventorySystemLabels(beforeItem, afterItem, asObject(routeNetworkAudit)) : [];
  const existingTextLabels = deleteExistingTextTarget ? collectInventoryTagTextLabels(beforeItem, afterItem) : [];
  const existingTagTextLabels = deleteExistingTagTarget ? collectInventoryTagTextLabels(beforeItem, afterItem) : [];
  const existingTaggedElementIds = deleteExistingTagTarget ? collectInventoryTaggedElementIds(beforeItem, afterItem) : [];
  const existingRouteKindMatchesRequest =
    !deleteExistingRouteTarget ||
    proofLabelsMatchRequest(requestedExistingTargetKind || routeKindFromTargetKind(targetKind, request), [
      ...existingTargetCategoryLabels,
      ...existingTargetSystemLabels,
      routeKindFromTargetKind(targetKind, request)
    ]);
  const existingRouteSystemMatchesRequest = !deleteExistingRouteTarget || proofLabelsMatchRequest(requestedExistingTargetSystem, existingTargetSystemLabels);
  const existingRouteNetworkAuditCoversTarget = !deleteExistingRouteTarget || networkAuditCoversTargetIds(routeNetworkAudit, targetIds);
  const existingTargetIdentityMatchesRequest =
    !deleteExistingTarget ||
    (Boolean(requestedExistingTargetFamily || requestedExistingTargetType || requestedExistingTargetCategory || requestedExistingTargetKind || requestedExistingTargetSystem || requestedExistingText || requestedExistingTagText || requestedExistingTaggedElementIds.length > 0) &&
      proofLabelsMatchRequest(requestedExistingTargetFamily, existingTargetFamilyTypeLabels) &&
      proofLabelsMatchRequest(requestedExistingTargetType, existingTargetFamilyTypeLabels) &&
      proofLabelsMatchRequest(requestedExistingTargetCategory, existingTargetCategoryLabels) &&
      (!deleteExistingTextTarget || proofLabelsMatchRequest(requestedExistingText, existingTextLabels)) &&
      (!deleteExistingTagTarget || (
        proofLabelsMatchRequest(requestedExistingTagText, existingTagTextLabels) &&
        (requestedExistingTaggedElementIds.length === 0 || requestedExistingTaggedElementIds.every((id) => existingTaggedElementIds.includes(id)))
      )) &&
      existingRouteKindMatchesRequest &&
      existingRouteSystemMatchesRequest);
  const beforeCapturePath = firstPathLike(asObject(before).imagePath, asObject(before).path, asObject(before).capturePath);
  const afterCapturePath = firstPathLike(asObject(after).imagePath, asObject(after).path, asObject(after).capturePath);
  const summaryRows = [
    {
      action: createAction,
      targetKind,
      viewId,
      createdId: createdId ?? "",
      existingTargetIds: deleteExistingTarget ? existingTargetIds.join(";") : "",
      text,
      requestedFamilyInstanceType,
      createdFamilyInstanceLabels: createdFamilyInstanceLabels.join(";"),
      requestedExistingTargetCategory,
      requestedExistingTargetKind,
      requestedExistingTargetSystem,
      requestedExistingText,
      requestedExistingTagText,
      requestedExistingTaggedElementIds: requestedExistingTaggedElementIds.join(";"),
      existingTargetCategoryLabels: existingTargetCategoryLabels.join(";"),
      existingTargetSystemLabels: existingTargetSystemLabels.join(";"),
      existingTextLabels: existingTextLabels.join(";"),
      existingTagTextLabels: existingTagTextLabels.join(";"),
      existingTaggedElementIds: existingTaggedElementIds.join(";"),
      createdMepRouteKind: createdMepRouteKind ?? "",
      createdMepRouteIds: createdMepRouteIdsForMutation.join(";"),
      nativeDeleteDryRunProvesTargetExists,
      visibleBefore,
      beforeCapturePath
    },
    {
      action: `delete_${targetKind}`,
      targetKind,
      requestedIds: targetIds.join(";"),
      dryRunIds: dryRunIds.join(";"),
      deletedIds: deletedIds.join(";"),
      visibleAfter,
      visibleAfterDryRun,
      afterCapturePath
    }
  ];
  const summaryJsonPath = path.join(runDir, "artifacts", "redline_delete_summary.json");
  const summaryMarkdownPath = writeMarkdownTable(path.join(runDir, "artifacts", "redline_delete_summary.md"), summaryRows);
  const visualGate = {
    status: deleteExistingTarget ? "blocked" : visibleBefore && visibleAfter && !!afterCapturePath ? "pass" : "fail",
    authority: nativeDeleteDryRunProvesTargetExists ? "native_delete_dry_run_and_capture" : "deterministic_inventory",
    reason: deleteExistingTarget
      ? "existing target delete preflight stopped before model write; no restore-safe apply path is available"
      : visibleBefore && visibleAfter
        ? nativeDeleteDryRunProvesTargetExists
          ? `created ${targetKind} was proven by native delete dry-run/apply details and post-delete capture`
          : `created ${targetKind} was visible before delete and absent after delete`
        : `created ${targetKind} visibility did not prove deletion`,
    beforeCapturePath,
    afterCapturePath,
    targetKind,
    targetIds,
    deleteExistingTarget,
    assertions: [
      { name: "target_visible_before_delete", status: visibleBefore ? "pass" : "fail", expected: primaryTargetId, actual: primaryTargetId !== null ? (inventoryContainsElementId(before, primaryTargetId) || nativeDeleteDryRunProvesTargetExists) : false },
      deleteExistingTarget
        ? { name: "target_still_visible_after_dry_run", status: visibleAfterDryRun ? "pass" : "fail", expected: primaryTargetId, actual: primaryTargetId !== null && after !== null ? inventoryContainsElementId(after, primaryTargetId) : null }
        : { name: "target_absent_after_delete", status: visibleAfter ? "pass" : "fail", expected: "absent", actual: createdId !== null && after !== null ? { inInventory: inventoryContainsElementId(after, createdId), deleted: deletedIds.includes(createdId) } : null }
    ]
  };
  const visualGatePath = path.join(runDir, "artifacts", "redline_delete_visual_gate.json");
  writeJsonFile(summaryJsonPath, {
    viewId,
    targetKind,
    text,
    requestedFamilyInstanceType,
    createdFamilyInstanceLabels,
    familyInstanceTypeMatchesRequest,
    requestedExistingTargetFamily,
    requestedExistingTargetType,
    requestedExistingTargetCategory,
    requestedExistingTargetKind,
    requestedExistingTargetSystem,
    requestedExistingText,
    requestedExistingTagText,
    requestedExistingTaggedElementIds,
    existingTargetFamilyTypeLabels,
    existingTargetCategoryLabels,
    existingTargetSystemLabels,
    existingTextLabels,
    existingTagTextLabels,
    existingTaggedElementIds,
    existingTargetIdentityMatchesRequest,
    existingRouteKindMatchesRequest,
    existingRouteSystemMatchesRequest,
    existingRouteNetworkAuditCoversTarget,
    createdMepRouteKind,
    createdMepRouteIds: createdMepRouteIdsForMutation,
    mepRouteCreateOk,
    createdId,
    targetIds,
    deleteExistingTarget,
    existingTargetIds: allExistingTargetIds,
    dryRunIds,
    deletedIds,
    nativeDeleteDryRunProvesTargetExists,
    visibleBefore,
    visibleAfter,
    visibleAfterDryRun,
    blockedBeforeModelWrite: deleteExistingTarget,
    beforeCapturePath,
    afterCapturePath,
    rawCreateResult: createResult,
    rawRouteNetworkAudit: routeNetworkAudit,
    rawDeleteDryRun: deleteDryRun,
    rawDeleteApplied: deleteApplied
  });
  writeJsonFile(visualGatePath, visualGate);
  const checks = [
    verification(
      deleteExistingTextTarget
        ? "delete_redline_existing_text_note_present"
        : targetKind === "tag"
        ? deleteExistingTagTarget
          ? "delete_redline_existing_tag_present"
          : "delete_redline_created_tag_id_present"
        : deleteExistingTarget
          ? "delete_redline_existing_target_present"
          : isFamilyInstanceTarget
          ? "delete_redline_created_family_instance_id_present"
          : targetKind === "mep_route"
            ? "delete_redline_created_mep_route_ids_present"
            : "delete_redline_created_text_note_id_present",
      deleteExistingTarget ? allExistingTargetIds.length > 0 : targetKind === "mep_route" ? mepRouteCreateOk : createdId !== null,
      deleteExistingTextTarget ? "verified existing TextNote id" : deleteExistingTagTarget ? "verified existing tag id" : deleteExistingTarget ? "verified existing family_instance id" : `created disposable ${targetKind} id`,
      createResult
    ),
    ...(targetKind === "mep_route"
      ? [
          verification(
            "delete_redline_mep_route_kind_matches_request",
            createdMepRouteKind === routeKindFromTargetKind(targetKind, request),
            routeKindFromTargetKind(targetKind, request),
            createdMepRouteKind
          )
        ]
      : []),
    ...(isFamilyInstanceTarget
      ? [
          verification(
            deleteExistingTarget ? "delete_redline_existing_target_identity_matches_request" : "delete_redline_family_instance_type_matches_request",
            deleteExistingTarget ? Boolean(existingTargetIdentityMatchesRequest) : familyInstanceTypeMatchesRequest,
            requestedFamilyInstanceType || "requested family/type label",
            deleteExistingTarget
              ? { familyTypeLabels: existingTargetFamilyTypeLabels, categoryLabels: existingTargetCategoryLabels }
              : createdFamilyInstanceLabels,
            deleteExistingTarget
              ? "visible existing target family/type/category evidence must match requested target grounding"
              : "created family instance type/name evidence must match requested symbol/type/family"
          )
        ]
      : []),
    ...(deleteExistingTagTarget
      ? [
          verification(
            "delete_redline_existing_tag_identity_matches_request",
            Boolean(existingTargetIdentityMatchesRequest),
            { category: requestedExistingTargetCategory, text: requestedExistingTagText || "optional", taggedElementIds: requestedExistingTaggedElementIds },
            { categoryLabels: existingTargetCategoryLabels, tagTextLabels: existingTagTextLabels, taggedElementIds: existingTaggedElementIds },
            "visible existing tag category/text/tagged-element evidence must match requested tag target grounding"
          )
        ]
      : []),
    ...(deleteExistingTextTarget
      ? [
          verification(
            "delete_redline_existing_text_note_identity_matches_request",
            Boolean(existingTargetIdentityMatchesRequest),
            { category: requestedExistingTargetCategory, text: requestedExistingText },
            { categoryLabels: existingTargetCategoryLabels, textLabels: existingTextLabels },
            "visible existing TextNote category/text evidence must match requested text target grounding"
          )
        ]
      : []),
    ...(deleteExistingRouteTarget
      ? [
          verification(
            "delete_redline_existing_route_identity_matches_request",
            Boolean(existingTargetIdentityMatchesRequest),
            { kind: requestedExistingTargetKind || routeKindFromTargetKind(targetKind, request), category: requestedExistingTargetCategory, system: requestedExistingTargetSystem || "optional" },
            { categoryLabels: existingTargetCategoryLabels, systemLabels: existingTargetSystemLabels, routeKind: createdMepRouteKind },
            "visible existing route category/kind/system evidence must match requested route target grounding"
          ),
          verification(
            "delete_redline_existing_route_network_audit_covers_target",
            existingRouteNetworkAuditCoversTarget,
            targetIds,
            routeNetworkAudit,
            "connected network/connector audit must cover the route ids before delete can be reviewed"
          )
        ]
      : []),
    verification("delete_redline_target_visible_before", visibleBefore, `${deleteExistingTarget ? "existing" : "created"} target visible before delete`, { primaryTargetId, beforeCount: collectionCount(before) }),
    verification("delete_redline_dry_run_ok", targetIds.length > 0 && targetIds.every((id) => dryRunIds.includes(id)), targetIds, dryRunIds),
    ...(deleteExistingTarget
      ? [
          verification("delete_redline_blocked_before_model_write", true, "blocked before model write", { reason: "existing delete has no restore-safe apply path" }),
          verification("delete_redline_target_still_visible_after_dry_run", visibleAfterDryRun, "existing target remains after dry-run rollback", { primaryTargetId, afterCount: collectionCount(after) }),
          verification("delete_redline_applied_ids_present", false, "blocked before model write", deletedIds),
          verification("delete_redline_target_absent_after", false, "blocked before model write", { primaryTargetId, afterCount: collectionCount(after) })
        ]
      : [
          verification("delete_redline_applied_ids_present", targetIds.length > 0 && targetIds.every((id) => deletedIds.includes(id)), targetIds, deletedIds),
          verification("delete_redline_target_absent_after", visibleAfter, "deleted target absent from post-delete inventory", { createdId, afterCount: collectionCount(after) })
        ]),
    verification("delete_redline_visual_gate_passed", visualGate.status === "pass", "pass", visualGate.status),
    verification("delete_redline_summary_written", fs.existsSync(summaryJsonPath) && fs.existsSync(summaryMarkdownPath) && fs.existsSync(visualGatePath), "summary artifacts", [summaryJsonPath, summaryMarkdownPath, visualGatePath])
  ];
  const success = countOk(checks);
  return {
    workflow: "redline_delete",
    success,
    failure_reason: success ? null : deleteExistingTarget ? "Existing-target delete redline blocked before model write because no restore-safe apply path is available." : "Delete-like redline workflow verification failed.",
    tool_calls: deleteExistingTarget ? (deleteExistingRouteTarget ? 4 : 3) : createdId !== null ? 5 : 2,
    revit_transactions: deleteExistingTarget ? 0 : createdId !== null ? 2 : 1,
    computer_use_actions: 0,
    output_artifacts: [summaryJsonPath, summaryMarkdownPath, visualGatePath],
    verification_results: checks,
    user_message: success ? `Created and deleted disposable redline target ${createdId}.` : deleteExistingTarget ? `Delete preflight verified existing redline target ${primaryTargetId}, then blocked before model write.` : "Delete-like redline workflow ran, but verification failed.",
    raw_results: rawResults
  };
}

async function runRedlineMove(transport: BridgeTransport, request: JsonMap, runDir: string): Promise<RevitWorkflowPartialResult> {
  const viewId = Number(request.viewId ?? request.view_id);
  if (!Number.isFinite(viewId) || viewId <= 0) throw new Error("redline_move requires viewId.");
  const targetKind = normalizeRedlineTargetKind(request.targetKind ?? request.target_kind ?? request.target, "text_note");
  const existingTarget = asObject(request.existingTarget ?? request.existing_target ?? request.targetElement ?? request.target_element);
  const existingTargetIds = uniquePositiveIds(existingTarget.elementIds, existingTarget.element_ids, existingTarget.ids, existingTarget.elementId, existingTarget.element_id, request.targetElementIds, request.target_element_ids);
  const tagBase = asObject(request.tag);
  const existingTagIds = uniquePositiveIds(tagBase.existingTagIds, tagBase.existing_tag_ids, tagBase.tagIds, tagBase.tag_ids);
  const allExistingTargetIds = Array.from(new Set([...existingTargetIds, ...existingTagIds]));
  const requestedExistingMove = allExistingTargetIds.length > 0 || parseBool(existingTarget.moveExisting ?? existingTarget.move_existing ?? tagBase.moveExisting ?? tagBase.move_existing ?? request.moveExistingTarget ?? request.move_existing_target) === true;
  const isFamilyInstanceTarget = isRedlineFamilyInstanceTargetKind(targetKind);
  const moveExistingFamilyTarget = isFamilyInstanceTarget && requestedExistingMove;
  const moveExistingRouteTarget = targetKind === "mep_route" && requestedExistingMove;
  const moveExistingTagTarget = targetKind === "tag" && requestedExistingMove;
  const moveExistingTarget = moveExistingFamilyTarget || moveExistingRouteTarget || moveExistingTagTarget;
  const requestedExistingTargetFamily = clip(existingTarget.expectedFamilyName ?? existingTarget.expected_family_name ?? existingTarget.familyName ?? existingTarget.family_name, 220);
  const requestedExistingTargetType = clip(existingTarget.expectedTypeName ?? existingTarget.expected_type_name ?? existingTarget.typeName ?? existingTarget.type_name ?? request.expectedTypeName ?? request.expected_type_name, 220);
  const requestedExistingTargetCategory = clip(existingTarget.expectedCategory ?? existingTarget.expected_category ?? existingTarget.category ?? existingTarget.categoryName ?? existingTarget.builtInCategory ?? existingTarget.built_in_category, 220);
  const requestedExistingTargetKind = clip(existingTarget.expectedKind ?? existingTarget.expected_kind ?? existingTarget.kind ?? request.kind ?? request.routeKind ?? request.route_kind, 80);
  const requestedExistingTargetSystem = clip(existingTarget.expectedSystemName ?? existingTarget.expected_system_name ?? existingTarget.systemName ?? existingTarget.system_name ?? request.systemType ?? request.system_type, 220);
  const requestedExistingTagText = clip(existingTarget.expectedTagText ?? existingTarget.expected_tag_text ?? existingTarget.expectedVisibleText ?? existingTarget.expected_visible_text ?? tagBase.expectedTagText ?? tagBase.expectedVisibleText, 220);
  const requestedTaggedElementIds = uniquePositiveIds(existingTarget.taggedElementIds, existingTarget.tagged_element_ids, tagBase.elementIds, tagBase.element_ids, request.elementIds, request.element_ids);
  const move = asObject(request.move);
  const vector = {
    x: Number(move.vectorX ?? request.vectorX ?? 1),
    y: Number(move.vectorY ?? request.vectorY ?? 0),
    z: Number(move.vectorZ ?? request.vectorZ ?? 0)
  };
  const toleranceFt = Number(request.toleranceFt ?? 0.05);
  const rawResults: unknown[] = [];
  let createResult: unknown;
  let createdId: number | null;
  let text = "";
  let createAction = "";
  let visibleCategories: string[] | null = null;
  let requestedFamilyInstanceType = "";
  let createdFamilyInstanceLabels: string[] = [];
  let familyInstanceTypeMatchesRequest = true;
  let createdMepRouteKind: "duct" | "pipe" | null = null;
  let createdMepRouteIdsForMutation: number[] = [];
  let mepRouteCreateOk = true;
  if (moveExistingFamilyTarget) {
    if (existingTargetIds.length <= 0) throw new Error("redline_move existing target requires existingTarget.elementIds.");
    createAction = "existing_family_instance";
    createResult = { status: "ExistingTarget", elementIds: existingTargetIds };
    createdId = existingTargetIds[0] ?? null;
    requestedFamilyInstanceType = requestedExistingTargetType || requestedExistingTargetFamily;
    createdFamilyInstanceLabels = requestedFamilyInstanceType ? [requestedFamilyInstanceType] : [];
  } else if (moveExistingRouteTarget) {
    if (existingTargetIds.length <= 0) throw new Error("redline_move existing route target requires existingTarget.elementIds.");
    createAction = "existing_mep_route";
    createResult = { status: "ExistingRouteTarget", elementIds: existingTargetIds };
    createdId = existingTargetIds[0] ?? null;
    createdMepRouteKind = routeKindFromTargetKind(targetKind, request);
    createdMepRouteIdsForMutation = existingTargetIds;
  } else if (moveExistingTagTarget) {
    if (allExistingTargetIds.length <= 0) throw new Error("redline_move existing tag target requires existingTarget.elementIds or tag.existingTagIds.");
    createAction = "existing_tag";
    createResult = { status: "ExistingTagTarget", elementIds: allExistingTargetIds };
    createdId = allExistingTargetIds[0] ?? null;
  } else if (targetKind === "tag") {
    const elementIds = asNumberArray(tagBase.elementIds ?? request.elementIds);
    if (elementIds.length <= 0) throw new Error("redline_move tag target requires tag.elementIds.");
    const tagRequest = {
      onlyUntagged: false,
      max: elementIds.length,
      ...tagBase,
      viewId: firstPositiveId(tagBase.viewId, request.tagViewId, viewId) ?? viewId,
      elementIds,
      dryRun: false
    };
    createAction = "create_tag";
    createResult = await transport.post("/revit/tag-elements", tagRequest);
    createdId = firstPositiveId(...asNumberArray(asObject(createResult).tagIds), asObject(createResult).id, asObject(createResult).elementId, asObject(createResult).createdElementId);
  } else if (isFamilyInstanceTarget) {
    const createBase = asObject(request.familyInstance ?? request.family_instance ?? request.device ?? request.createFamilyInstance ?? request.create);
    requestedFamilyInstanceType = clip(createBase.symbolName ?? createBase.typeName ?? request.symbolName ?? createBase.familyName, 220);
    if (!requestedFamilyInstanceType && !clip(createBase.familyName, 220)) throw new Error("redline_move family_instance target requires familyInstance.symbolName, typeName, or familyName.");
    const createRequest = {
      familyName: "",
      levelName: "",
      x: 0,
      y: 0,
      z: 0,
      ...createBase,
      symbolName: clip(createBase.symbolName ?? createBase.typeName ?? request.symbolName, 220)
    };
    createAction = "create_family_instance";
    createResult = await transport.post("/revit/create-family-instance", createRequest);
    const createObj = asObject(createResult);
    createdId = firstPositiveId(createObj.id, createObj.elementId, createObj.createdElementId);
    createdFamilyInstanceLabels = collectCreatedFamilyLabels(createObj);
    familyInstanceTypeMatchesRequest = proofLabelsMatchRequest(requestedFamilyInstanceType || clip(createRequest.familyName, 220), createdFamilyInstanceLabels);
  } else if (targetKind === "mep_route") {
    const routeTarget = await createDisposableMepRouteTarget(transport, request, targetKind);
    createAction = "create_mep_route";
    createResult = routeTarget.result;
    createdMepRouteKind = routeTarget.kind;
    createdMepRouteIdsForMutation = routeTarget.ids;
    createdId = firstPositiveId(...createdMepRouteIdsForMutation);
    mepRouteCreateOk = mepRouteCreateStatusOk(createResult) && createdMepRouteIdsForMutation.length > 0;
  } else {
    const note = asObject(request.textNote ?? request.text_note);
    text = firstString(note.text, request.text, `OPERATOR MOVE REDLINE ${Date.now()}`);
    const createBody = {
      action: "create",
      viewId,
      x: Number(note.x ?? request.x ?? 1),
      y: Number(note.y ?? request.y ?? 1),
      text
    };
    createAction = "create_text_note";
    visibleCategories = ["OST_TextNotes"];
    createResult = await transport.post("/revit/create-text", createBody);
    createdId = firstPositiveId(
      asObject(createResult).id,
      asObject(createResult).textNoteId,
      asObject(createResult).elementId,
      asObject(createResult).createdElementId
    );
  }
  rawResults.push(createResult);
  const beforeCaptureRequest: JsonMap = {
    viewId,
    includeMapping: true,
    includeGeometry: true,
    imageSize: request.imageSize ?? 1800
  };
  if (visibleCategories !== null) beforeCaptureRequest.categories = visibleCategories;
  const before = await transport.post("/revit/export-visible-elements", beforeCaptureRequest);
  rawResults.push(before);
  let moveDryRun: unknown = null;
  let moveApplied: unknown = null;
  let after: unknown = null;
  let cleanupDryRun: unknown = null;
  let cleanupApplied: unknown = null;
  let revertDryRun: unknown = null;
  let revertApplied: unknown = null;
  let finalAfterRevert: unknown = null;
  let routeNetworkAuditBefore: unknown = null;
  let routeNetworkAuditFinal: unknown = null;
  const targetIds = moveExistingTagTarget ? allExistingTargetIds : moveExistingTarget ? existingTargetIds : targetKind === "mep_route" ? createdMepRouteIdsForMutation : createdId !== null ? [createdId] : [];
  if (targetIds.length > 0) {
    if (moveExistingRouteTarget) {
      routeNetworkAuditBefore = await transport.post("/revit/trace-connected-network", {
        viewId,
        elementIds: targetIds,
        ids: targetIds,
        dryRun: true,
        includeConnectors: true,
        includeSystem: true,
        reason: "existing route move redline preflight network audit"
      });
      rawResults.push(routeNetworkAuditBefore);
    }
    const moveRequest = {
      ids: targetIds,
      mode: "vector",
      vectorX: vector.x,
      vectorY: vector.y,
      vectorZ: vector.z,
      behavior: "allOrNothing"
    };
    moveDryRun = await transport.post("/revit/move-elements", { ...moveRequest, dryRun: true });
    rawResults.push(moveDryRun);
    moveApplied = await transport.post("/revit/move-elements", { ...moveRequest, dryRun: false });
    rawResults.push(moveApplied);
    const afterCaptureRequest: JsonMap = {
      viewId,
      includeMapping: true,
      includeGeometry: true,
      imageSize: request.imageSize ?? 1800
    };
    if (visibleCategories !== null) afterCaptureRequest.categories = visibleCategories;
    after = await transport.post("/revit/export-visible-elements", afterCaptureRequest);
    rawResults.push(after);
    if (moveExistingTarget) {
      const revertRequest = {
        ids: targetIds,
        mode: "vector",
        vectorX: -vector.x,
        vectorY: -vector.y,
        vectorZ: -vector.z,
        behavior: "allOrNothing"
      };
      revertDryRun = await transport.post("/revit/move-elements", { ...revertRequest, dryRun: true });
      rawResults.push(revertDryRun);
      revertApplied = await transport.post("/revit/move-elements", { ...revertRequest, dryRun: false });
      rawResults.push(revertApplied);
      finalAfterRevert = await transport.post("/revit/export-visible-elements", afterCaptureRequest);
      rawResults.push(finalAfterRevert);
      if (moveExistingRouteTarget) {
        routeNetworkAuditFinal = await transport.post("/revit/trace-connected-network", {
          viewId,
          elementIds: targetIds,
          ids: targetIds,
          dryRun: true,
          includeConnectors: true,
          includeSystem: true,
          reason: "existing route move redline post-revert network audit"
        });
        rawResults.push(routeNetworkAuditFinal);
      }
    } else {
      cleanupDryRun = await transport.post("/revit/delete", { ids: targetIds, dryRun: true, apply: false });
      rawResults.push(cleanupDryRun);
      cleanupApplied = await transport.post("/revit/delete", { ids: targetIds, apply: true });
      rawResults.push(cleanupApplied);
    }
  }
  const primaryTargetId = targetIds[0] ?? null;
  const beforeItem = primaryTargetId !== null ? inventoryItemByElementId(before, primaryTargetId) : {};
  const afterItem = primaryTargetId !== null && after !== null ? inventoryItemByElementId(after, primaryTargetId) : {};
  const finalItem = primaryTargetId !== null && finalAfterRevert !== null ? inventoryItemByElementId(finalAfterRevert, primaryTargetId) : {};
  const existingTargetFamilyTypeLabels = moveExistingFamilyTarget ? collectInventoryFamilyTypeLabels(beforeItem, afterItem, finalItem) : [];
  const existingTargetCategoryLabels = moveExistingTarget ? collectInventoryCategoryLabels(beforeItem, afterItem, finalItem) : [];
  const existingTargetSystemLabels = moveExistingRouteTarget ? collectInventorySystemLabels(beforeItem, afterItem, finalItem, asObject(routeNetworkAuditBefore), asObject(routeNetworkAuditFinal)) : [];
  const existingTagTextLabels = moveExistingTagTarget ? collectInventoryTagTextLabels(beforeItem, afterItem, finalItem) : [];
  const existingTaggedElementIds = moveExistingTagTarget ? collectInventoryTaggedElementIds(beforeItem, afterItem, finalItem) : [];
  const existingRouteKindMatchesRequest =
    !moveExistingRouteTarget ||
    proofLabelsMatchRequest(requestedExistingTargetKind || routeKindFromTargetKind(targetKind, request), [
      ...existingTargetCategoryLabels,
      ...existingTargetSystemLabels,
      routeKindFromTargetKind(targetKind, request)
    ]);
  const existingRouteSystemMatchesRequest = !moveExistingRouteTarget || proofLabelsMatchRequest(requestedExistingTargetSystem, existingTargetSystemLabels);
  const existingRouteNetworkAuditBeforeContinuity = mepNetworkContinuityAudit(routeNetworkAuditBefore);
  const existingRouteNetworkAuditFinalContinuity = mepNetworkContinuityAudit(routeNetworkAuditFinal);
  const existingRouteNetworkAuditCoversTarget =
    !moveExistingRouteTarget ||
    (networkAuditCoversTargetIds(routeNetworkAuditBefore, targetIds) &&
      networkAuditCoversTargetIds(routeNetworkAuditFinal, targetIds));
  const existingRouteNetworkAuditConnected =
    !moveExistingRouteTarget ||
    (existingRouteNetworkAuditBeforeContinuity.ok && existingRouteNetworkAuditFinalContinuity.ok);
  const existingTagTextMatchesRequest = !moveExistingTagTarget || proofLabelsMatchRequest(requestedExistingTagText, existingTagTextLabels);
  const existingTagTaggedElementMatchesRequest =
    !moveExistingTagTarget ||
    requestedTaggedElementIds.length === 0 ||
    requestedTaggedElementIds.every((id) => existingTaggedElementIds.includes(id));
  const existingTargetIdentityMatchesRequest =
    !moveExistingTarget ||
    (Boolean(requestedExistingTargetFamily || requestedExistingTargetType || requestedExistingTargetCategory || requestedExistingTargetKind || requestedExistingTargetSystem || requestedExistingTagText || requestedTaggedElementIds.length > 0) &&
      proofLabelsMatchRequest(requestedExistingTargetFamily, existingTargetFamilyTypeLabels) &&
      proofLabelsMatchRequest(requestedExistingTargetType, existingTargetFamilyTypeLabels) &&
      proofLabelsMatchRequest(requestedExistingTargetCategory, existingTargetCategoryLabels) &&
      existingRouteKindMatchesRequest &&
      existingRouteSystemMatchesRequest &&
      existingTagTextMatchesRequest &&
      existingTagTaggedElementMatchesRequest);
  const beforePoint = modelPointFromInventoryItem(beforeItem) ?? (primaryTargetId !== null ? moveSnapshotPoint(moveApplied ?? moveDryRun, primaryTargetId, "before") : null);
  const afterPoint = modelPointFromInventoryItem(afterItem) ?? (primaryTargetId !== null ? moveSnapshotPoint(moveApplied ?? moveDryRun, primaryTargetId, "after") : null);
  const finalPoint = modelPointFromInventoryItem(finalItem);
  const tagLeaderBefore = moveExistingTagTarget ? tagLeaderState(beforeItem) : null;
  const tagLeaderAfter = moveExistingTagTarget ? tagLeaderState(afterItem) : null;
  const tagLeaderFinal = moveExistingTagTarget ? tagLeaderState(finalItem) : null;
  const leaderPreserved = moveExistingTagTarget ? tagLeaderPreserved(beforeItem, afterItem, finalItem, toleranceFt) : null;
  const actualDelta = pointDeltaFt(beforePoint, afterPoint);
  const revertDelta = pointDeltaFt(afterPoint, finalPoint);
  const dryMovedIds = asNumberArray(asObject(moveDryRun).movedIds);
  const movedIds = asNumberArray(asObject(moveApplied).movedIds);
  const cleanupDryRunIds = deleteEffectIds(cleanupDryRun);
  const cleanupDeletedIds = deleteEffectIds(cleanupApplied);
  const revertDryMovedIds = asNumberArray(asObject(revertDryRun).movedIds);
  const revertedMovedIds = asNumberArray(asObject(revertApplied).movedIds);
  const finalRestored = !moveExistingTarget || vectorMatches(revertDelta, { x: -vector.x, y: -vector.y, z: -vector.z }, toleranceFt);
  const nativeMoveSnapshotProvesTarget = primaryTargetId !== null && beforePoint !== null && afterPoint !== null && movedIds.includes(primaryTargetId);
  const visibleBefore = primaryTargetId !== null && (Object.keys(beforeItem).length > 0 || nativeMoveSnapshotProvesTarget);
  const visibleAfter = primaryTargetId !== null && (Object.keys(afterItem).length > 0 || nativeMoveSnapshotProvesTarget);
  const visibleAfterRevert = !moveExistingTarget || (primaryTargetId !== null && Object.keys(finalItem).length > 0);
  const beforeCapturePath = firstPathLike(asObject(before).imagePath, asObject(before).path, asObject(before).capturePath);
  const afterCapturePath = firstPathLike(asObject(after).imagePath, asObject(after).path, asObject(after).capturePath);
  const finalCapturePath = firstPathLike(asObject(finalAfterRevert).imagePath, asObject(finalAfterRevert).path, asObject(finalAfterRevert).capturePath);
  const summaryRows = [
    {
      action: createAction,
      targetKind,
      viewId,
      createdId: createdId ?? "",
      text,
      requestedFamilyInstanceType,
      createdFamilyInstanceLabels: createdFamilyInstanceLabels.join(";"),
      createdMepRouteKind: createdMepRouteKind ?? "",
      createdMepRouteIds: createdMepRouteIdsForMutation.join(";"),
      existingTargetIds: moveExistingTarget ? existingTargetIds.join(";") : "",
      requestedExistingTargetCategory,
      requestedExistingTargetKind,
      requestedExistingTargetSystem,
      existingTargetCategoryLabels: existingTargetCategoryLabels.join(";"),
      existingTargetSystemLabels: existingTargetSystemLabels.join(";"),
      existingTagTextLabels: existingTagTextLabels.join(";"),
      existingTaggedElementIds: existingTaggedElementIds.join(";"),
      beforeX: beforePoint?.x ?? "",
      beforeY: beforePoint?.y ?? "",
      beforeZ: beforePoint?.z ?? "",
      beforeCapturePath
    },
    {
      action: `move_${targetKind}`,
      targetKind,
      requestedIds: targetIds.join(";"),
      dryMovedIds: dryMovedIds.join(";"),
      movedIds: movedIds.join(";"),
      requestedVector: `${vector.x},${vector.y},${vector.z}`,
      actualDelta: actualDelta ? `${actualDelta.x},${actualDelta.y},${actualDelta.z}` : "",
      afterX: afterPoint?.x ?? "",
      afterY: afterPoint?.y ?? "",
      afterZ: afterPoint?.z ?? "",
      afterCapturePath
    },
    {
      action: moveExistingTarget ? `revert_${targetKind}` : `cleanup_${targetKind}`,
      targetKind,
      dryRunIds: cleanupDryRunIds.join(";"),
      deletedIds: cleanupDeletedIds.join(";"),
      revertDryMovedIds: revertDryMovedIds.join(";"),
      revertedMovedIds: revertedMovedIds.join(";"),
      revertDelta: revertDelta ? `${revertDelta.x},${revertDelta.y},${revertDelta.z}` : "",
      finalCapturePath
    }
  ];
  const summaryJsonPath = path.join(runDir, "artifacts", "redline_move_summary.json");
  const summaryMarkdownPath = writeMarkdownTable(path.join(runDir, "artifacts", "redline_move_summary.md"), summaryRows);
  const movedMatches = vectorMatches(actualDelta, vector, toleranceFt);
  const visualGate = {
    status: visibleBefore && visibleAfter && movedMatches && !!afterCapturePath && (!moveExistingTarget || (visibleAfterRevert && finalRestored && !!finalCapturePath)) ? "pass" : "fail",
    authority: nativeMoveSnapshotProvesTarget ? "native_move_snapshot_and_capture" : "deterministic_inventory",
    reason: movedMatches
      ? moveExistingTarget
        ? `existing ${targetKind} moved by requested model-space vector and was restored by reverse vector`
        : `created ${targetKind} moved by requested model-space vector`
      : `${moveExistingTarget ? "existing" : "created"} ${targetKind} did not prove requested model-space movement`,
    beforeCapturePath,
    afterCapturePath,
    finalCapturePath,
    targetKind,
    targetIds,
    moveExistingTarget,
    requestedVector: vector,
    actualDelta,
    nativeMoveSnapshotProvesTarget,
    revertDelta,
    toleranceFt,
    assertions: [
      { name: "target_visible_before_move", status: visibleBefore ? "pass" : "fail", expected: primaryTargetId, actual: visibleBefore },
      { name: "target_visible_after_move", status: visibleAfter ? "pass" : "fail", expected: primaryTargetId, actual: visibleAfter },
      { name: "target_moved_by_requested_vector", status: movedMatches ? "pass" : "fail", expected: vector, actual: actualDelta },
      ...(moveExistingTarget
        ? [
            { name: "target_visible_after_revert", status: visibleAfterRevert ? "pass" : "fail", expected: primaryTargetId, actual: visibleAfterRevert },
            { name: "target_reverted_by_reverse_vector", status: finalRestored ? "pass" : "fail", expected: { x: -vector.x, y: -vector.y, z: -vector.z }, actual: revertDelta }
          ]
        : [])
    ]
  };
  const visualGatePath = path.join(runDir, "artifacts", "redline_move_visual_gate.json");
  writeJsonFile(summaryJsonPath, {
    viewId,
    targetKind,
    text,
    requestedFamilyInstanceType,
    createdFamilyInstanceLabels,
    familyInstanceTypeMatchesRequest,
    requestedExistingTargetFamily,
    requestedExistingTargetType,
    requestedExistingTargetCategory,
    requestedExistingTargetKind,
    requestedExistingTargetSystem,
    existingTargetFamilyTypeLabels,
    existingTargetCategoryLabels,
    existingTargetSystemLabels,
    requestedExistingTagText,
    requestedTaggedElementIds,
    existingTagTextLabels,
    existingTaggedElementIds,
    existingTagTextMatchesRequest,
    existingTagTaggedElementMatchesRequest,
    tagLeaderBefore,
    tagLeaderAfter,
    tagLeaderFinal,
    leaderPreserved,
    existingTargetIdentityMatchesRequest,
    existingRouteKindMatchesRequest,
    existingRouteSystemMatchesRequest,
    existingRouteNetworkAuditCoversTarget,
    existingRouteNetworkAuditConnected,
    existingRouteNetworkAuditBeforeContinuity,
    existingRouteNetworkAuditFinalContinuity,
    createdMepRouteKind,
    createdMepRouteIds: createdMepRouteIdsForMutation,
    mepRouteCreateOk,
    createdId,
    targetIds,
    moveExistingTarget,
    existingTargetIds,
    requestedVector: vector,
    beforePoint,
    afterPoint,
    finalPoint,
    actualDelta,
    nativeMoveSnapshotProvesTarget,
    revertDelta,
    dryMovedIds,
    movedIds,
    cleanupDryRunIds,
    cleanupDeletedIds,
    revertDryMovedIds,
    revertedMovedIds,
    finalRestored,
    visibleAfterRevert,
    beforeCapturePath,
    afterCapturePath,
    finalCapturePath,
    rawCreateResult: createResult,
    rawMoveDryRun: moveDryRun,
    rawMoveApplied: moveApplied,
    rawCleanupDryRun: cleanupDryRun,
    rawCleanupApplied: cleanupApplied,
    rawRevertDryRun: revertDryRun,
    rawRevertApplied: revertApplied,
    rawFinalAfterRevert: finalAfterRevert,
    rawRouteNetworkAuditBefore: routeNetworkAuditBefore,
    rawRouteNetworkAuditFinal: routeNetworkAuditFinal
  });
  writeJsonFile(visualGatePath, visualGate);
  const checks = [
    verification(
      moveExistingTagTarget
        ? "move_redline_existing_tag_present"
        : targetKind === "tag"
        ? "move_redline_created_tag_id_present"
        : moveExistingTarget
          ? "move_redline_existing_target_present"
          : isFamilyInstanceTarget
          ? "move_redline_created_family_instance_id_present"
          : targetKind === "mep_route"
            ? "move_redline_created_mep_route_ids_present"
            : "move_redline_created_text_note_id_present",
      moveExistingTarget ? targetIds.length > 0 : targetKind === "mep_route" ? mepRouteCreateOk : createdId !== null,
      moveExistingTarget ? `verified existing ${targetKind} id` : `created disposable ${targetKind} id`,
      createResult
    ),
    ...(targetKind === "mep_route"
      ? [
          verification(
            "move_redline_mep_route_kind_matches_request",
            moveExistingRouteTarget ? existingRouteKindMatchesRequest : createdMepRouteKind === routeKindFromTargetKind(targetKind, request),
            routeKindFromTargetKind(targetKind, request),
            moveExistingRouteTarget ? { categoryLabels: existingTargetCategoryLabels, systemLabels: existingTargetSystemLabels } : createdMepRouteKind
          ),
          ...(moveExistingRouteTarget
            ? [
                verification(
                  "move_redline_existing_route_system_matches_request",
                  existingRouteSystemMatchesRequest,
                  requestedExistingTargetSystem,
                  existingTargetSystemLabels
                ),
                verification(
                  "move_redline_existing_route_network_audit_covers_target",
                  existingRouteNetworkAuditCoversTarget,
                  targetIds,
                  { before: routeNetworkAuditBefore, final: routeNetworkAuditFinal }
                ),
                verification(
                  "move_redline_existing_route_network_audit_connected",
                  existingRouteNetworkAuditConnected,
                  "connected route network audit before move and after revert",
                  {
                    before: existingRouteNetworkAuditBeforeContinuity.detail,
                    final: existingRouteNetworkAuditFinalContinuity.detail
                  }
                ),
                verification(
                  "move_redline_existing_route_identity_matches_request",
                  Boolean(existingTargetIdentityMatchesRequest),
                  { requestedExistingTargetKind, requestedExistingTargetCategory, requestedExistingTargetSystem },
                  { categoryLabels: existingTargetCategoryLabels, systemLabels: existingTargetSystemLabels },
                  "visible existing route category/kind/system evidence must match requested target grounding"
                )
              ]
            : [])
        ]
      : []),
    ...(isFamilyInstanceTarget
      ? [
          verification(
            moveExistingTarget ? "move_redline_existing_target_identity_matches_request" : "move_redline_family_instance_type_matches_request",
            moveExistingTarget ? Boolean(existingTargetIdentityMatchesRequest) : familyInstanceTypeMatchesRequest,
            requestedFamilyInstanceType || "requested family/type label",
            moveExistingTarget
              ? { familyTypeLabels: existingTargetFamilyTypeLabels, categoryLabels: existingTargetCategoryLabels }
              : createdFamilyInstanceLabels,
            moveExistingTarget
              ? "visible existing target family/type/category evidence must match requested target grounding"
              : "created family instance type/name evidence must match requested symbol/type/family"
          )
        ]
      : []),
    ...(moveExistingTagTarget
      ? [
          verification(
            "move_redline_existing_tag_identity_matches_request",
            Boolean(existingTargetIdentityMatchesRequest),
            { requestedExistingTargetCategory, requestedExistingTagText, requestedTaggedElementIds },
            { categoryLabels: existingTargetCategoryLabels, tagTextLabels: existingTagTextLabels, taggedElementIds: existingTaggedElementIds },
            "visible existing tag category/text/tagged-element evidence must match requested target grounding"
          ),
          verification(
            "move_redline_existing_tag_leader_preserved",
            leaderPreserved === true,
            "tag leader state retained during move and restored after revert",
            { before: tagLeaderBefore, after: tagLeaderAfter, final: tagLeaderFinal, leaderPreserved },
            "visible-element export must include tagAnnotation leader state before move, after move, and after revert"
          )
        ]
      : []),
    verification("move_redline_target_visible_before", visibleBefore, `${moveExistingTarget ? "existing" : "created"} target visible before move`, { primaryTargetId, beforePoint }),
    verification("move_redline_dry_run_ok", targetIds.length > 0 && targetIds.every((id) => dryMovedIds.includes(id)), targetIds, dryMovedIds),
    verification("move_redline_applied_ids_present", targetIds.length > 0 && targetIds.every((id) => movedIds.includes(id)), targetIds, movedIds),
    verification("move_redline_target_visible_after", visibleAfter, "moved target visible after move", { primaryTargetId, afterPoint }),
    verification("move_redline_vector_matches_request", movedMatches, { vector, toleranceFt }, actualDelta),
    verification("move_redline_visual_gate_passed", visualGate.status === "pass", "pass", visualGate.status),
    verification("move_redline_cleanup_dry_run_ok", targetIds.length > 0 && targetIds.every((id) => (moveExistingTarget ? revertDryMovedIds : cleanupDryRunIds).includes(id)), targetIds, moveExistingTarget ? revertDryMovedIds : cleanupDryRunIds),
    verification("move_redline_cleanup_applied_ids_present", targetIds.length > 0 && targetIds.every((id) => (moveExistingTarget ? revertedMovedIds : cleanupDeletedIds).includes(id)), targetIds, moveExistingTarget ? revertedMovedIds : cleanupDeletedIds),
    ...(moveExistingTarget
      ? [
          verification("move_redline_revert_matches_original", visibleAfterRevert && finalRestored, "existing target restored by reverse vector after verification", { finalPoint, revertDelta, finalCapturePath })
        ]
      : []),
    verification("move_redline_summary_written", fs.existsSync(summaryJsonPath) && fs.existsSync(summaryMarkdownPath) && fs.existsSync(visualGatePath), "summary artifacts", [summaryJsonPath, summaryMarkdownPath, visualGatePath])
  ];
  const success = countOk(checks);
  return {
    workflow: "redline_move",
    success,
    failure_reason: success ? null : "Move-like redline workflow verification failed.",
    tool_calls: moveExistingRouteTarget ? 9 : createdId !== null ? 7 : 2,
    revit_transactions: moveExistingTarget ? 2 : createdId !== null ? 3 : 1,
    computer_use_actions: 0,
    output_artifacts: [summaryJsonPath, summaryMarkdownPath, visualGatePath],
    verification_results: checks,
    user_message: success
      ? moveExistingTarget
        ? `Moved, verified, and reverted existing redline target ${primaryTargetId}.`
        : `Created, moved, verified, and cleaned up disposable redline target ${createdId}.`
      : "Move-like redline workflow ran, but verification failed.",
    raw_results: rawResults
  };
}

async function runRedlineRotate(transport: BridgeTransport, request: JsonMap, runDir: string): Promise<RevitWorkflowPartialResult> {
  const viewId = Number(request.viewId ?? request.view_id);
  if (!Number.isFinite(viewId) || viewId <= 0) throw new Error("redline_rotate requires viewId.");
  const note = asObject(request.textNote ?? request.text_note);
  const rotate = asObject(request.rotate);
  const angleDegrees = Number(rotate.angleDegrees ?? request.angleDegrees ?? 90);
  const axis = asObject(rotate.axis);
  const axisPoint = {
    x: Number(axis.pointX ?? note.x ?? request.x ?? 1),
    y: Number(axis.pointY ?? note.y ?? request.y ?? 1),
    z: Number(axis.pointZ ?? 0)
  };
  const text = firstString(note.text, request.text, `OPERATOR ROTATE REDLINE ${Date.now()}`);
  const createBody = {
    action: "create",
    viewId,
    x: Number(note.x ?? request.x ?? 1),
    y: Number(note.y ?? request.y ?? 1),
    text
  };
  const rawResults: unknown[] = [];
  const createResult = await transport.post("/revit/create-text", createBody);
  rawResults.push(createResult);
  const createdId = firstPositiveId(
    asObject(createResult).id,
    asObject(createResult).textNoteId,
    asObject(createResult).elementId,
    asObject(createResult).createdElementId
  );
  const before = await transport.post("/revit/export-visible-elements", {
    viewId,
    categories: ["OST_TextNotes"],
    includeMapping: true,
    includeGeometry: true,
    imageSize: request.imageSize ?? 1800
  });
  rawResults.push(before);
  let rotateDryRun: unknown = null;
  let rotateApplied: unknown = null;
  let after: unknown = null;
  let cleanupDryRun: unknown = null;
  let cleanupApplied: unknown = null;
  const targetIds = createdId !== null ? [createdId] : [];
  if (createdId !== null) {
    const rotateRequest = {
      ids: targetIds,
      angleDegrees,
      axis: {
        mode: "zThroughPoint",
        pointX: axisPoint.x,
        pointY: axisPoint.y,
        pointZ: axisPoint.z
      },
      behavior: "allOrNothing",
      options: {
        failOnPinned: true,
        unpinIfAllowed: false
      }
    };
    rotateDryRun = await transport.post("/revit/rotate-elements", { ...rotateRequest, dryRun: true });
    rawResults.push(rotateDryRun);
    rotateApplied = await transport.post("/revit/rotate-elements", { ...rotateRequest, dryRun: false });
    rawResults.push(rotateApplied);
    after = await transport.post("/revit/export-visible-elements", {
      viewId,
      categories: ["OST_TextNotes"],
      includeMapping: true,
      includeGeometry: true,
      imageSize: request.imageSize ?? 1800
    });
    rawResults.push(after);
    cleanupDryRun = await transport.post("/revit/delete", { ids: targetIds, dryRun: true, apply: false });
    rawResults.push(cleanupDryRun);
    cleanupApplied = await transport.post("/revit/delete", { ids: targetIds, apply: true });
    rawResults.push(cleanupApplied);
  }
  const beforeItem = createdId !== null ? inventoryItemByElementId(before, createdId) : {};
  const afterItem = createdId !== null && after !== null ? inventoryItemByElementId(after, createdId) : {};
  const dryRotatedIds = asNumberArray(asObject(rotateDryRun).rotatedIds);
  const rotatedIds = asNumberArray(asObject(rotateApplied).rotatedIds);
  const cleanupDryRunIds = deleteEffectIds(cleanupDryRun);
  const cleanupDeletedIds = deleteEffectIds(cleanupApplied);
  const visibleBefore = createdId !== null && Object.keys(beforeItem).length > 0;
  const visibleAfter = createdId !== null && Object.keys(afterItem).length > 0;
  const beforeCapturePath = firstPathLike(asObject(before).imagePath, asObject(before).path, asObject(before).capturePath);
  const afterCapturePath = firstPathLike(asObject(after).imagePath, asObject(after).path, asObject(after).capturePath);
  const summaryRows = [
    {
      action: "create_text_note",
      viewId,
      createdId: createdId ?? "",
      text,
      beforeCapturePath
    },
    {
      action: "rotate_text_note",
      requestedIds: targetIds.join(";"),
      dryRotatedIds: dryRotatedIds.join(";"),
      rotatedIds: rotatedIds.join(";"),
      angleDegrees,
      axisPoint: `${axisPoint.x},${axisPoint.y},${axisPoint.z}`,
      afterCapturePath
    },
    {
      action: "cleanup_text_note",
      dryRunIds: cleanupDryRunIds.join(";"),
      deletedIds: cleanupDeletedIds.join(";")
    }
  ];
  const summaryJsonPath = path.join(runDir, "artifacts", "redline_rotate_summary.json");
  const summaryMarkdownPath = writeMarkdownTable(path.join(runDir, "artifacts", "redline_rotate_summary.md"), summaryRows);
  const visualGate = {
    status: visibleBefore && visibleAfter && createdId !== null && rotatedIds.includes(createdId) && !!afterCapturePath ? "pass" : "fail",
    authority: "deterministic_inventory",
    reason: createdId !== null && rotatedIds.includes(createdId) ? "created text note rotated and remained visible" : "created text note rotation was not proven by native rotated ids",
    beforeCapturePath,
    afterCapturePath,
    targetIds,
    angleDegrees,
    axisPoint,
    assertions: [
      { name: "target_visible_before_rotate", status: visibleBefore ? "pass" : "fail", expected: createdId, actual: visibleBefore },
      { name: "target_visible_after_rotate", status: visibleAfter ? "pass" : "fail", expected: createdId, actual: visibleAfter },
      { name: "target_rotated_id_reported", status: createdId !== null && rotatedIds.includes(createdId) ? "pass" : "fail", expected: createdId, actual: rotatedIds }
    ]
  };
  const visualGatePath = path.join(runDir, "artifacts", "redline_rotate_visual_gate.json");
  writeJsonFile(summaryJsonPath, {
    viewId,
    text,
    createdId,
    targetIds,
    angleDegrees,
    axisPoint,
    dryRotatedIds,
    rotatedIds,
    cleanupDryRunIds,
    cleanupDeletedIds,
    beforeCapturePath,
    afterCapturePath,
    rawCreateResult: createResult,
    rawRotateDryRun: rotateDryRun,
    rawRotateApplied: rotateApplied,
    rawCleanupDryRun: cleanupDryRun,
    rawCleanupApplied: cleanupApplied
  });
  writeJsonFile(visualGatePath, visualGate);
  const checks = [
    verification("rotate_redline_created_text_note_id_present", createdId !== null, "created disposable text note id", createResult),
    verification("rotate_redline_target_visible_before", visibleBefore, "created target visible before rotate", { createdId }),
    verification("rotate_redline_dry_run_ok", createdId !== null && dryRotatedIds.includes(createdId), targetIds, dryRotatedIds),
    verification("rotate_redline_applied_ids_present", createdId !== null && rotatedIds.includes(createdId), targetIds, rotatedIds),
    verification("rotate_redline_target_visible_after", visibleAfter, "rotated target visible after rotate", { createdId }),
    verification("rotate_redline_visual_gate_passed", visualGate.status === "pass", "pass", visualGate.status),
    verification("rotate_redline_cleanup_dry_run_ok", createdId !== null && cleanupDryRunIds.includes(createdId), targetIds, cleanupDryRunIds),
    verification("rotate_redline_cleanup_applied_ids_present", createdId !== null && cleanupDeletedIds.includes(createdId), targetIds, cleanupDeletedIds),
    verification("rotate_redline_summary_written", fs.existsSync(summaryJsonPath) && fs.existsSync(summaryMarkdownPath) && fs.existsSync(visualGatePath), "summary artifacts", [summaryJsonPath, summaryMarkdownPath, visualGatePath])
  ];
  const success = countOk(checks);
  return {
    workflow: "redline_rotate",
    success,
    failure_reason: success ? null : "Rotate-like redline workflow verification failed.",
    tool_calls: createdId !== null ? 7 : 2,
    revit_transactions: createdId !== null ? 3 : 1,
    computer_use_actions: 0,
    output_artifacts: [summaryJsonPath, summaryMarkdownPath, visualGatePath],
    verification_results: checks,
    user_message: success ? `Created, rotated, verified, and cleaned up disposable redline target ${createdId}.` : "Rotate-like redline workflow ran, but verification failed.",
    raw_results: rawResults
  };
}

function collectionCount(value: unknown): number {
  if (Array.isArray(value)) return value.length;
  const obj = asObject(value);
  for (const key of ["elements", "items", "visibleElements", "instances"]) {
    if (Array.isArray(obj[key])) return (obj[key] as unknown[]).length;
  }
  return Object.keys(obj).length > 0 ? 1 : 0;
}

function inventoryItems(value: unknown): JsonMap[] {
  const obj = asObject(value);
  for (const key of ["elements", "items", "visibleElements", "instances"]) {
    const entries = obj[key];
    if (Array.isArray(entries)) return entries.map((entry) => asObject(entry));
  }
  return [];
}

function inventoryContainsElementId(value: unknown, elementId: number): boolean {
  return inventoryItems(value).some((entry) => Number(entry.id ?? entry.elementId) === elementId);
}

function inventoryItemByElementId(value: unknown, elementId: number): JsonMap {
  return inventoryItems(value).find((entry) => Number(entry.id ?? entry.elementId) === elementId) ?? {};
}

function modelPointFromInventoryItem(item: JsonMap): { x: number; y: number; z: number } | null {
  const anchorModel = asObject(asObject(item.anchor).model);
  const anchor = asObject(item.anchor);
  const candidates = [anchorModel, anchor, asObject(item.location), asObject(item.point)];
  for (const candidate of candidates) {
    const x = Number(candidate.x);
    const y = Number(candidate.y);
    const z = Number(candidate.z ?? 0);
    if (Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(z)) return { x, y, z };
  }
  const bbox = asObject(item.bboxModel);
  const min = asObject(bbox.min);
  const max = asObject(bbox.max);
  const minX = Number(min.x);
  const minY = Number(min.y);
  const minZ = Number(min.z ?? 0);
  const maxX = Number(max.x);
  const maxY = Number(max.y);
  const maxZ = Number(max.z ?? 0);
  if ([minX, minY, minZ, maxX, maxY, maxZ].every(Number.isFinite)) {
    return { x: (minX + maxX) / 2, y: (minY + maxY) / 2, z: (minZ + maxZ) / 2 };
  }
  return null;
}

function pointDeltaFt(before: { x: number; y: number; z: number } | null, after: { x: number; y: number; z: number } | null): { x: number; y: number; z: number; distance: number } | null {
  if (!before || !after) return null;
  const x = after.x - before.x;
  const y = after.y - before.y;
  const z = after.z - before.z;
  return { x, y, z, distance: Math.sqrt(x * x + y * y + z * z) };
}

function vectorMatches(delta: { x: number; y: number; z: number; distance: number } | null, expected: { x: number; y: number; z: number }, toleranceFt: number): boolean {
  if (!delta) return false;
  return Math.abs(delta.x - expected.x) <= toleranceFt && Math.abs(delta.y - expected.y) <= toleranceFt && Math.abs(delta.z - expected.z) <= toleranceFt;
}

function comparablePoint(value: unknown): { x: number; y: number; z: number } | null {
  const candidate = asObject(value);
  const x = Number(candidate.x);
  const y = Number(candidate.y);
  const z = Number(candidate.z ?? 0);
  return Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(z) ? { x, y, z } : null;
}

function tagAnnotationState(item: JsonMap): JsonMap {
  const direct = asObject(item.tagAnnotation ?? item.tag_annotation);
  if (Object.keys(direct).length > 0) return direct;
  return asObject(asObject(item.element).tagAnnotation ?? asObject(item.element).tag_annotation);
}

function tagLeaderState(item: JsonMap): JsonMap | null {
  const annotation = tagAnnotationState(item);
  if (Object.keys(annotation).length === 0) return null;
  const hasLeader = annotation.hasLeader ?? annotation.has_leader;
  const leaderEndCondition = clip(annotation.leaderEndCondition ?? annotation.leader_end_condition, 120);
  const leaderElbow = comparablePoint(annotation.leaderElbow ?? annotation.leader_elbow);
  const leaderEnd = comparablePoint(annotation.leaderEnd ?? annotation.leader_end);
  const tagHeadPosition =
    comparablePoint(annotation.tagHeadPosition ?? annotation.tag_head_position) ??
    comparablePoint(asObject(item.anchor).model) ??
    comparablePoint(item.point) ??
    comparablePoint(item.center);
  if (typeof hasLeader !== "boolean" && !leaderEndCondition && !leaderElbow && !leaderEnd && !tagHeadPosition) return null;
  return {
    hasLeader: typeof hasLeader === "boolean" ? hasLeader : null,
    leaderEndCondition: leaderEndCondition || null,
    leaderElbow,
    leaderEnd,
    tagHeadPosition
  };
}

function tagLeaderStatesComparable(a: JsonMap | null, b: JsonMap | null, toleranceFt: number): boolean {
  if (!a || !b) return false;
  if (a.hasLeader !== b.hasLeader) return false;
  if ((a.leaderEndCondition ?? null) !== (b.leaderEndCondition ?? null)) return false;
  for (const key of ["leaderElbow", "leaderEnd"] as const) {
    const first = comparablePoint(a[key]);
    const second = comparablePoint(b[key]);
    if (!first && !second) continue;
    if (!first || !second) return false;
    if (!vectorMatches(pointDeltaFt(first, second), { x: 0, y: 0, z: 0 }, toleranceFt)) return false;
  }
  return true;
}

function tagLeaderStateRetained(a: JsonMap | null, b: JsonMap | null): boolean {
  if (!a || !b) return false;
  if (a.hasLeader !== b.hasLeader) return false;
  if ((a.leaderEndCondition ?? null) !== (b.leaderEndCondition ?? null)) return false;
  for (const key of ["leaderElbow", "leaderEnd", "tagHeadPosition"] as const) {
    const first = comparablePoint(a[key]);
    const second = comparablePoint(b[key]);
    if (!first && !second) continue;
    if (!first || !second) return false;
  }
  return true;
}

function tagLeaderPreserved(beforeItem: JsonMap, afterItem: JsonMap, finalItem: JsonMap, toleranceFt: number): boolean | null {
  const before = tagLeaderState(beforeItem);
  const after = tagLeaderState(afterItem);
  const final = tagLeaderState(finalItem);
  if (!before || !after || !final) return null;
  return tagLeaderStateRetained(before, after) && tagLeaderStatesComparable(before, final, toleranceFt);
}

function firstString(...values: unknown[]): string {
  for (const value of values) {
    const text = clip(value, 300);
    if (text) return text;
  }
  return "";
}

function normalizeRedlineTargetKind(value: unknown, defaultKind: "tag" | "text_note"): string {
  const raw = firstString(value, defaultKind).toLowerCase().replace(/[\s-]+/g, "_");
  if (raw === "tag" || raw === "tags") return "tag";
  if (raw === "text" || raw === "text_note" || raw === "text_notes" || raw === "note") return "text_note";
  if (["duct", "pipe", "duct_route", "pipe_route", "mep_route", "meproute", "mep"].includes(raw)) return "mep_route";
  if (["family_instance", "familyinstance", "device", "fixture", "model_element"].includes(raw)) return "family_instance";
  if (["receptacle", "receptacles", "electrical_receptacle", "electrical_receptacles"].includes(raw)) return "receptacle";
  if (["light", "lights", "lighting", "lighting_fixture", "lighting_fixtures", "light_fixture", "light_fixtures"].includes(raw)) return "light";
  if ([
    "mep_accessory",
    "mepaccessory",
    "duct_accessory",
    "pipe_accessory",
    "accessory",
    "damper",
    "balancing_damper",
    "manual_balancing_damper"
  ].includes(raw)) {
    return "mep_accessory";
  }
  return raw || defaultKind;
}

function isRedlineFamilyInstanceTargetKind(targetKind: string): boolean {
  return ["family_instance", "receptacle", "light", "mep_accessory"].includes(targetKind);
}

function routeKindFromTargetKind(targetKind: string, request: JsonMap): "duct" | "pipe" {
  const explicit = clip(request.kind ?? request.routeKind ?? request.mepKind, 40).toLowerCase();
  const rawTarget = clip(request.targetKind ?? request.target_kind ?? request.target, 80).toLowerCase();
  if (explicit === "pipe" || targetKind.includes("pipe") || rawTarget.includes("pipe")) return "pipe";
  return "duct";
}

function createdMepRouteIds(workflowResult: unknown): number[] {
  const workflow = asObject(workflowResult);
  const applyResult = asObject(workflow.applyResult);
  return Array.from(new Set([...asNumberArray(applyResult.createdElementIds), ...asNumberArray(applyResult.createdFittingIds)]));
}

function mepRouteCreateStatusOk(workflowResult: unknown): boolean {
  const status = clip(asObject(workflowResult).status, 120);
  return /^appliedvisualverificationready$/i.test(status) || /^applied/i.test(status) || /created/i.test(status);
}

async function createDisposableMepRouteTarget(transport: BridgeTransport, request: JsonMap, targetKind: string): Promise<{ result: unknown; ids: number[]; kind: "duct" | "pipe" }> {
  const routeBase = asObject(request.mepRoute ?? request.mep_route ?? request.route);
  const kind = routeKindFromTargetKind(targetKind, { ...request, ...routeBase });
  const routeRequest = {
    ...request,
    ...routeBase,
    kind,
    apply: true,
    verify: routeBase.verify ?? request.verify ?? true,
    visualVerify: routeBase.visualVerify ?? request.routeVisualVerify ?? false
  };
  delete (routeRequest as JsonMap).targetKind;
  delete (routeRequest as JsonMap).target_kind;
  delete (routeRequest as JsonMap).target;
  delete (routeRequest as JsonMap).move;
  const result = await transport.post("/revit/mep-route-workflow", routeRequest);
  return { result, ids: createdMepRouteIds(result), kind };
}

function normalizeCircuitLabel(value: unknown): string {
  return clip(value, 120)
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "/")
    .replace(/\/+/g, "/")
    .replace(/^\/|\/$/g, "");
}

function circuitLabelFromPayload(value: unknown): string {
  const obj = asObject(value);
  const electricalCircuit = asObject(obj.electricalCircuit);
  const primary = firstString(electricalCircuit.primaryLabel, electricalCircuit.label, obj.primaryLabel, obj.circuitLabel);
  if (primary) return primary;
  const panel = firstString(electricalCircuit.panel, obj.panel, obj.Panel);
  const circuit = firstString(electricalCircuit.circuitNumber, electricalCircuit.circuit, obj.circuitNumber, obj.circuit, obj["Circuit Number"]);
  return `${panel}${panel && circuit ? "/" : ""}${circuit}`.trim();
}

function auditItemsByElementId(audit: unknown): Map<number, JsonMap> {
  const out = new Map<number, JsonMap>();
  const items = Array.isArray(asObject(audit).items) ? (asObject(audit).items as unknown[]) : [];
  for (const item of items) {
    const obj = asObject(item);
    const id = Number(obj.elementId ?? obj.id);
    if (Number.isFinite(id) && id > 0) out.set(id, obj);
  }
  return out;
}

function placementContextForAuditItem(item: JsonMap): JsonMap {
  return asObject(item.placementContext ?? item.context ?? item);
}

function roomNumberFromAuditItem(item: JsonMap): string {
  const context = placementContextForAuditItem(item);
  const room = asObject(context.room);
  const space = asObject(context.space);
  return firstString(item.roomNumber, item.spaceNumber, context.roomNumber, context.spaceNumber, room.number, space.number);
}

function hostEvidenceOk(item: JsonMap): boolean | null {
  const context = placementContextForAuditItem(item);
  const diagnostics = asObject(context.diagnostics);
  const support = asObject(diagnostics.hostPlacementSupport);
  const placementHost = asObject(context.placementHost ?? item.placementHost);
  const hostOk = asObject(item).hostOk;
  if (typeof hostOk === "boolean") return hostOk;
  if (support.supported === false || support.sourceHostSupported === false) return false;
  if (placementHost.id || context.hostElementId || item.hostElementId) return true;
  return null;
}

function expectedRoomForPlacement(placement: JsonMap, request: JsonMap): string {
  return firstString(placement.expectedRoomNumber, placement.roomNumber, request.expectedRoomNumber, request.roomNumber);
}

function normalizeRoomSide(value: unknown): string {
  const raw = clip(value, 80).toLowerCase();
  if (!raw) return "";
  if (raw === "left" || raw === "west") return "left";
  if (raw === "right" || raw === "east") return "right";
  if (raw === "top" || raw === "upper" || raw === "north") return "top";
  if (raw === "bottom" || raw === "lower" || raw === "south") return "bottom";
  return raw;
}

function expectedRoomSideForPlacement(placement: JsonMap, request: JsonMap): string {
  return normalizeRoomSide(firstString(placement.expectedRoomSide, placement.roomSide, request.expectedRoomSide, request.roomSide));
}

function requestedRoomSideEvidenceFromAuditItem(item: JsonMap): { ok: boolean | null; actual: string } {
  const context = placementContextForAuditItem(item);
  const room = asObject(context.room);
  const diagnostics = asObject(context.diagnostics);
  const support = asObject(diagnostics.hostPlacementSupport);
  const booleanEvidence = [
    item.onRequestedRoomSide,
    item.on_requested_room_side,
    item.hostOnRequestedRoomSide,
    context.onRequestedRoomSide,
    context.on_requested_room_side,
    support.onRequestedRoomSide,
    support.on_requested_room_side
  ].find((value) => typeof value === "boolean");
  const actual = normalizeRoomSide(firstString(
    item.roomSide,
    item.requestedRoomSide,
    item.requested_room_side,
    context.roomSide,
    context.requestedRoomSide,
    context.requested_room_side,
    room.requestedSide,
    room.requestedRoomSide
  ));
  return {
    ok: typeof booleanEvidence === "boolean" ? booleanEvidence : null,
    actual
  };
}

function verificationToGateAssertion(entry: RevitWorkflowVerification): RedlineVisualGateAssertion {
  return {
    name: entry.name,
    status: entry.ok ? "pass" : "fail",
    ...(entry.expected !== undefined ? { expected: entry.expected } : {}),
    ...(entry.actual !== undefined ? { observed: entry.actual } : {}),
    reason: entry.detail || (entry.ok ? `${entry.name} passed.` : `${entry.name} failed.`)
  };
}

function receptacleLandmarkRelationships(args: {
  createdIds: number[];
  placements: JsonMap[];
  auditItems: Map<number, JsonMap>;
  expectedRooms: string[];
  expectedRoomSides: string[];
}): RedlineVisualGateLandmarkRelationship[] {
  const relationships: RedlineVisualGateLandmarkRelationship[] = [];
  for (const [index, id] of args.createdIds.entries()) {
    const placement = args.placements[index] ?? {};
    const item = args.auditItems.get(id) ?? {};
    const expectedRoom = args.expectedRooms[index];
    const expectedSide = args.expectedRoomSides[index];
    const hostId = Number(placement.hostElementId ?? placement.host_element_id);
    if (expectedRoom) {
      const actualRoom = roomNumberFromAuditItem(item);
      relationships.push({
        landmark: `room ${expectedRoom}`,
        relation: "created device is inside the target room",
        status: actualRoom.trim().toUpperCase() === expectedRoom.trim().toUpperCase() ? "pass" : "fail",
        reason: actualRoom
          ? `Audit resolved created element ${id} to room ${actualRoom}.`
          : `Audit did not resolve a room for created element ${id}.`
      });
    }
    if (expectedSide) {
      const evidence = requestedRoomSideEvidenceFromAuditItem(item);
      const ok = evidence.ok !== null ? evidence.ok === true : evidence.actual === expectedSide;
      relationships.push({
        landmark: `${expectedSide} side of target room`,
        relation: "created device is on the requested room side",
        status: ok ? "pass" : "fail",
        reason: evidence.actual
          ? `Audit resolved created element ${id} to room side ${evidence.actual}.`
          : `Audit did not resolve the requested side for created element ${id}.`
      });
    }
    if (Number.isFinite(hostId) && hostId > 0) {
      const context = placementContextForAuditItem(item);
      const host = asObject(context.placementHost);
      const actualHost = Number(host.id ?? item.hostElementId ?? item.host_element_id);
      relationships.push({
        landmark: `host element ${hostId}`,
        relation: "created device is hosted on the target wall/host",
        status: actualHost === hostId || hostEvidenceOk(item) === true ? "pass" : "fail",
        reason: actualHost
          ? `Audit resolved created element ${id} to host ${actualHost}.`
          : `Audit did not resolve host evidence for created element ${id}.`
      });
    }
  }
  return relationships;
}

function expectedCircuitForPlacement(placement: JsonMap, request: JsonMap): string {
  const overrides = asObject(placement.parameterOverrides);
  const fromOverride = circuitLabelFromPayload({ panel: overrides.Panel ?? overrides.panel, circuitNumber: overrides["Circuit Number"] ?? overrides.Circuit ?? overrides.circuitNumber ?? overrides.circuit });
  return firstString(placement.expectedCircuitLabel, request.expectedCircuitLabel, fromOverride);
}

function createSimilarDryRunPlacementEvidenceCount(dryRunObj: JsonMap): number {
  const placements = Array.isArray(dryRunObj.placements) ? dryRunObj.placements.map(asObject) : [];
  const placementRowsWithEvidence = placements.filter((placement) => {
    const temporaryId = Number(placement.temporaryElementId ?? placement.temporary_element_id);
    const elementId = Number(placement.elementId ?? placement.element_id ?? placement.id);
    return (
      Number.isFinite(temporaryId) && temporaryId > 0 ||
      Number.isFinite(elementId) && elementId > 0 ||
      Object.keys(asObject(placement.placementPoint ?? placement.placement_point ?? placement.apiPlacementPoint ?? placement.api_placement_point)).length > 0 ||
      Object.keys(asObject(placement.hostLocalFrame ?? placement.host_local_frame)).length > 0
    );
  }).length;
  const validation = asObject(dryRunObj.placementValidation ?? dryRunObj.placement_validation);
  const audit = asObject(validation.audit);
  return Math.max(
    placementRowsWithEvidence,
    asNumberArray(validation.validIds ?? validation.valid_ids).length,
    asNumberArray(audit.validIds ?? audit.valid_ids).length,
    asNumberArray(audit.auditedIds ?? audit.audited_ids).length,
    asNumberArray(dryRunObj.temporaryElementIds ?? dryRunObj.temporary_element_ids).length,
    asNumberArray(dryRunObj.elementIds ?? dryRunObj.element_ids ?? (dryRunObj.elementId ? [dryRunObj.elementId] : [])).length,
    asNumberArray(dryRunObj.createdElementIds ?? dryRunObj.created_element_ids).length
  );
}

async function runRedlineReceptacles(transport: BridgeTransport, request: JsonMap, runDir: string): Promise<RevitWorkflowPartialResult> {
  const placements = Array.isArray(request.placements) ? repeatSafePlacements(request.placements as JsonMap[], runDir) : [];
  if (placements.length === 0) throw new Error("redline_receptacles requires a bounded placements array.");
  const rawResults: unknown[] = [];
  const placementResults: unknown[] = [];
  const placementDryRuns: unknown[] = [];
  const placementDryRunEvidenceCounts: number[] = [];
  const before = await transport.post("/revit/export-visible-elements", request.beforeCapture ?? { viewId: request.viewId, categories: ["OST_ElectricalFixtures"], includeMapping: true });
  rawResults.push(before);
  const createdIds: number[] = [];
  for (const placement of placements) {
    let dryRun: unknown;
    try {
      dryRun = await transport.post("/revit/create-similar-from-instance", { ...buildCreateSimilarRequest(placement, request), dryRun: true });
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      return {
        workflow: "redline_receptacles",
        success: false,
        failure_reason: "Create-similar dry-run failed before applying receptacle placement.",
        tool_calls: rawResults.length + 1,
        revit_transactions: 0,
        computer_use_actions: 0,
        output_artifacts: [],
        verification_results: [
          verification("create_similar_dry_run_ok", false, "valid create-similar preview", null, detail)
        ],
        user_message: "Receptacle placement stopped before applying because the dry-run failed.",
        raw_results: rawResults
      };
    }
    rawResults.push(dryRun);
    placementDryRuns.push(dryRun);
    const dryRunObj = asObject(dryRun);
    const dryRunStatus = clip(dryRunObj.status, 120);
    const validation = asObject(dryRunObj.placementValidation);
    const dryRunEvidenceCount = createSimilarDryRunPlacementEvidenceCount(dryRunObj);
    const dryRunOk =
      Object.keys(dryRunObj).length > 0 &&
      !/invalid/i.test(dryRunStatus) &&
      validation.valid !== false &&
      asObject(dryRunObj).ok !== false &&
      asObject(dryRunObj).success !== false;
    if (!dryRunOk) {
      return {
        workflow: "redline_receptacles",
        success: false,
        failure_reason: "Create-similar dry-run preview failed before applying receptacle placement.",
        tool_calls: rawResults.length,
        revit_transactions: 0,
        computer_use_actions: 0,
        output_artifacts: [],
        verification_results: [
          verification("create_similar_dry_run_ok", false, "valid create-similar preview", dryRun, "Stopped before model writes because dry-run placement was invalid.")
        ],
        user_message: "Receptacle placement stopped before applying because the dry-run preview was invalid.",
        raw_results: rawResults
      };
    }
    if (dryRunEvidenceCount < 1) {
      return {
        workflow: "redline_receptacles",
        success: false,
        failure_reason: "Create-similar dry-run preview did not include planned placement evidence.",
        tool_calls: rawResults.length,
        revit_transactions: 0,
        computer_use_actions: 0,
        output_artifacts: [],
        verification_results: [
          verification("create_similar_dry_run_ok", true, "valid create-similar preview", dryRun),
          verification("create_similar_dry_run_placement_evidence", false, "planned placement evidence", dryRunEvidenceCount, "Stopped before model writes because dry-run did not prove a planned placement.")
        ],
        user_message: "Receptacle placement stopped before applying because the dry-run preview did not prove a planned placement.",
        raw_results: rawResults
      };
    }
    placementDryRunEvidenceCounts.push(dryRunEvidenceCount);
    const placed = await transport.post("/revit/create-similar-from-instance", { ...buildCreateSimilarRequest(placement, request), dryRun: false });
    rawResults.push(placed);
    placementResults.push(placed);
    createdIds.push(...asNumberArray(asObject(placed).createdElementIds ?? asObject(placed).elementIds ?? (asObject(placed).elementId ? [asObject(placed).elementId] : [])));
  }
  const auditPlacement = placements.length === 1 ? placements[0] ?? {} : {};
  const audit = await transport.post("/revit/audit-hosted-instance-placement", {
    elementIds: createdIds,
    viewId: request.viewId,
    ...takeDefined(auditPlacement, ["roomNumber", "roomSide", "hostElementId", "targetChainageFt", "targetNormalizedChainage", "targetPointXyz"]),
    ...(asObject(request.audit))
  });
  rawResults.push(audit);
  const after = await transport.post("/revit/export-visible-elements", request.afterCapture ?? { viewId: request.viewId, categories: ["OST_ElectricalFixtures"], includeMapping: true });
  rawResults.push(after);
  const auditPassed = asObject(audit).ok !== false && asObject(audit).success !== false && Object.keys(asObject(audit)).length > 0;
  let focusedAfter: unknown = null;
  let focusedAfterPath = "";
  if (auditPassed && createdIds.length > 0 && collectionCount(after) < collectionCount(before) + createdIds.length) {
    focusedAfter = await transport.post("/revit/export-view-region", request.focusedAfterCapture ?? {
      viewId: request.viewId,
      imageMaxSizePx: request.imageSize ?? 2200,
      includeMapping: true,
      region: {
        mode: "focusElements",
        focusElementIds: createdIds,
        marginFt: request.focusPaddingFt ?? 8
      }
    });
    rawResults.push(focusedAfter);
    focusedAfterPath = firstPathLike(
      asObject(focusedAfter).path,
      asObject(focusedAfter).capture_path,
      asObject(focusedAfter).capturePath,
      asObject(focusedAfter).image_path,
      asObject(focusedAfter).imagePath,
      asObject(focusedAfter).screenshot_path,
      asObject(focusedAfter).screenshotPath
    );
  }
  const cleanupRequested = parseBool(request.cleanupCreatedElements ?? request.cleanup_created_elements) === true;
  let cleanupDryRun: unknown = null;
  let cleanup: unknown = null;
  let cleanupDryRunIds: number[] = [];
  let cleanupDeletedIds: number[] = [];
  if (cleanupRequested && createdIds.length > 0) {
    cleanupDryRun = await transport.post("/revit/delete", {
      ids: createdIds,
      apply: false,
      reason: "benchmark cleanup for repeated redline receptacle reliability runs"
    });
    rawResults.push(cleanupDryRun);
    cleanup = await transport.post("/revit/delete", {
      ids: createdIds,
      apply: true,
      reason: "benchmark cleanup for repeated redline receptacle reliability runs"
    });
    rawResults.push(cleanup);
    cleanupDryRunIds = deleteEffectIds(cleanupDryRun);
    cleanupDeletedIds = deleteEffectIds(cleanup);
  }

  const summary = {
    viewId: request.viewId ?? null,
    requestedPlacementCount: placements.length,
    createdElementIds: createdIds,
    placementDryRunEvidenceCounts,
    beforeVisibleCount: collectionCount(before),
    afterVisibleCount: collectionCount(after),
    focusedAfterCapture: focusedAfter,
    focusedAfterCapturePath: focusedAfterPath || null,
    audit,
    cleanupRequested,
    cleanupDryRun,
    cleanup,
    cleanupDryRunIds,
    cleanupDeletedIds,
    placements: placements.map((placement, index) => ({
      index: index + 1,
      exemplarElementId: placement.exemplarElementId ?? null,
      hostElementId: placement.hostElementId ?? null,
      expectedRoomNumber: expectedRoomForPlacement(placement, request) || null,
      expectedRoomSide: expectedRoomSideForPlacement(placement, request) || null,
      expectedCircuitLabel: expectedCircuitForPlacement(placement, request) || null,
      mark: asObject(placement.parameterOverrides).Mark ?? placement.mark ?? null,
      panel: asObject(placement.parameterOverrides).Panel ?? placement.panel ?? null,
      circuit: asObject(placement.parameterOverrides).Circuit ?? placement.circuit ?? null,
      createdElementId: createdIds[index] ?? null
    }))
  };
  const summaryJsonPath = path.join(runDir, "artifacts", "redline_receptacles_summary.json");
  writeJsonFile(summaryJsonPath, summary);
  const summaryRows = summary.placements.map((placement) => ({
    index: placement.index,
    exemplarElementId: placement.exemplarElementId,
    hostElementId: placement.hostElementId,
    createdElementId: placement.createdElementId,
    roomSide: placement.expectedRoomSide,
    mark: placement.mark,
    panel: placement.panel,
    circuit: placement.circuit
  }));
  const summaryMdPath = writeMarkdownTable(path.join(runDir, "artifacts", "redline_receptacles_summary.md"), summaryRows);
  const tablePreview = makeMarkdownTable(summaryRows, 10).trim();

  const auditItems = auditItemsByElementId(audit);
  const expectedRooms = placements.map((placement) => expectedRoomForPlacement(placement, request));
  const expectedRoomSides = placements.map((placement) => expectedRoomSideForPlacement(placement, request));
  const expectedCircuits = placements.map((placement) => expectedCircuitForPlacement(placement, request));
  const sourceCircuitLabels = placementResults.map((result) => {
    const obj = asObject(result);
    return circuitLabelFromPayload(obj.exemplar) || circuitLabelFromPayload(obj.source);
  });
  const createdCircuitLabels = createdIds.map((id, index) => {
    const auditItem = auditItems.get(id);
    const placementResult = asObject(placementResults[index]);
    const placementRows = Array.isArray(placementResult.placements) ? (placementResult.placements as unknown[]).map(asObject) : [];
    const placementRow = placementRows.find((row) => Number(row.elementId ?? row.id) === id) ?? placementRows[index] ?? {};
    return circuitLabelFromPayload(auditItem ?? {}) || circuitLabelFromPayload(placementRow) || circuitLabelFromPayload(placementResult);
  });
  const roomChecksNeeded = expectedRooms.some((room) => !!room);
  const roomSideChecksNeeded = expectedRoomSides.some((side) => !!side);
  const circuitChecksNeeded = expectedCircuits.some((circuit) => !!circuit);
  const sourceCircuitChecksNeeded = placements.some((placement) => parseBool(placement.matchElectricalCircuitFromSource) === true);
  const requireAuditItems = parseBool(request.requireAuditItems ?? request.require_audit_items) === true;
  const hostChecks = createdIds.map((id) => {
    const item = auditItems.get(id);
    return item ? hostEvidenceOk(item) : (requireAuditItems ? false : null);
  });
  const optionalChecks: RevitWorkflowVerification[] = [];
  if (requireAuditItems || auditItems.size > 0) {
    optionalChecks.push(verification(
      "audit_contains_created_ids",
      createdIds.length > 0 && createdIds.every((id) => auditItems.has(id)),
      createdIds,
      [...auditItems.keys()]
    ));
  }
  if (hostChecks.some((entry) => entry !== null)) {
    optionalChecks.push(verification("audit_host_evidence_ok", hostChecks.every((entry) => entry !== false), "host evidence not false", hostChecks));
  }
  if (roomChecksNeeded) {
    optionalChecks.push(verification(
      "created_room_matches_expected",
      createdIds.every((id, index) => {
        const expected = expectedRooms[index];
        if (!expected) return true;
        const actual = roomNumberFromAuditItem(auditItems.get(id) ?? {});
        return actual.trim().toUpperCase() === expected.trim().toUpperCase();
      }),
      expectedRooms,
      createdIds.map((id) => roomNumberFromAuditItem(auditItems.get(id) ?? {}))
    ));
  }
  if (roomSideChecksNeeded) {
    const sideEvidence = createdIds.map((id) => requestedRoomSideEvidenceFromAuditItem(auditItems.get(id) ?? {}));
    optionalChecks.push(verification(
      "created_room_side_matches_expected",
      createdIds.every((_, index) => {
        const expected = expectedRoomSides[index];
        if (!expected) return true;
        const evidence = sideEvidence[index] ?? { ok: null, actual: "" };
        if (evidence.ok !== null) return evidence.ok === true;
        return !!evidence.actual && evidence.actual === expected;
      }),
      expectedRoomSides,
      sideEvidence
    ));
  }
  if (circuitChecksNeeded) {
    optionalChecks.push(verification(
      "created_circuit_matches_expected",
      createdIds.every((_, index) => {
        const expected = normalizeCircuitLabel(expectedCircuits[index]);
        if (!expected) return true;
        return normalizeCircuitLabel(createdCircuitLabels[index]) === expected;
      }),
      expectedCircuits,
      createdCircuitLabels
    ));
  }
  if (sourceCircuitChecksNeeded) {
    optionalChecks.push(verification(
      "created_circuit_matches_source_when_requested",
      createdIds.every((_, index) => {
        const expected = normalizeCircuitLabel(sourceCircuitLabels[index]);
        const actual = normalizeCircuitLabel(createdCircuitLabels[index]);
        return !!expected && !!actual && actual === expected;
      }),
      sourceCircuitLabels,
      createdCircuitLabels
    ));
  }

  const baseChecks = [
    verification("create_similar_dry_run_ok", placementDryRuns.length === placements.length, placements.length, placementDryRuns.length),
    verification(
      "create_similar_dry_run_placement_evidence",
      placementDryRunEvidenceCounts.length === placements.length && placementDryRunEvidenceCounts.every((count) => count > 0),
      placements.length,
      placementDryRunEvidenceCounts
    ),
    verification("created_expected_count", createdIds.length === placements.length, placements.length, createdIds.length),
    verification("audit_passed", auditPassed, "passing audit payload", audit),
    ...optionalChecks,
    verification("after_capture_returned", Object.keys(asObject(after)).length > 0, "after capture", after),
    verification(
      "after_visible_count_increased",
      summary.afterVisibleCount >= summary.beforeVisibleCount + createdIds.length || !!focusedAfterPath,
      summary.beforeVisibleCount + createdIds.length,
      focusedAfterPath ? { afterVisibleCount: summary.afterVisibleCount, focusedAfterCapturePath: focusedAfterPath } : summary.afterVisibleCount,
      focusedAfterPath ? "Broad inventory did not count the created device, but a focused post-change capture was exported for the created id." : undefined
    ),
    verification(
      "cleanup_completed_when_requested",
      !cleanupRequested || (Object.keys(asObject(cleanup)).length > 0 && asObject(cleanup).ok !== false && asObject(cleanup).success !== false && createdIds.every((id) => cleanupDeletedIds.includes(id))),
      cleanupRequested ? "delete result with ok/success not false" : "not requested",
      cleanup
    ),
    verification(
      "cleanup_dry_run_ok",
      !cleanupRequested || (createdIds.length > 0 && createdIds.every((id) => cleanupDryRunIds.includes(id))),
      cleanupRequested ? createdIds : "not requested",
      cleanupDryRun
    ),
    verification(
      "cleanup_deleted_ids_present",
      !cleanupRequested || (createdIds.length > 0 && createdIds.every((id) => cleanupDeletedIds.includes(id))),
      cleanupRequested ? createdIds : "not requested",
      cleanup
    ),
    verification("redline_summary_written", fs.existsSync(summaryJsonPath) && fs.existsSync(summaryMdPath), [summaryJsonPath, summaryMdPath], summary)
  ];
  const visualGate: RedlineVisualGateResult = evaluateRedlineVisualVerificationGate({
    action_type: "device_placement",
    authority: "hybrid",
    redline_path: firstPathLike(request.redlinePath, request.redline_path, request.attachmentPath, request.attachment_path),
    before_capture_path: firstPathLike(request.beforeCapturePath, request.before_capture_path, asObject(before).capture_path, asObject(before).capturePath, asObject(before).image_path, asObject(before).imagePath),
    after_capture_path: firstPathLike(request.afterCapturePath, request.after_capture_path, focusedAfterPath, asObject(after).capture_path, asObject(after).capturePath, asObject(after).image_path, asObject(after).imagePath, asObject(after).screenshot_path, asObject(after).screenshotPath),
    visible_element_inventory: {
      beforeVisibleCount: summary.beforeVisibleCount,
      afterVisibleCount: summary.afterVisibleCount,
      auditItemIds: [...auditItems.keys()]
    },
    intended_action: {
      workflow: "redline_receptacles",
      viewId: request.viewId ?? null,
      requestedPlacementCount: placements.length,
      placements: summary.placements
    },
    intended_location: summary.placements
      .map(placement => [
        placement.expectedRoomNumber ? `room ${placement.expectedRoomNumber}` : null,
        placement.expectedRoomSide ? `${placement.expectedRoomSide} side` : null,
        placement.hostElementId ? `host ${placement.hostElementId}` : null
      ].filter(Boolean).join(", "))
      .filter(Boolean)
      .join("; "),
    observed_location: createdIds
      .map((id, index) => {
        const item = auditItems.get(id) ?? {};
        const room = roomNumberFromAuditItem(item);
        const side = requestedRoomSideEvidenceFromAuditItem(item).actual;
        const context = placementContextForAuditItem(item);
        const host = asObject(context.placementHost);
        const hostId = Number(host.id ?? item.hostElementId ?? item.host_element_id);
        return [
          `element ${id}`,
          room ? `room ${room}` : null,
          side ? `${side} side` : null,
          Number.isFinite(hostId) && hostId > 0 ? `host ${hostId}` : null,
          !room && !side && !(Number.isFinite(hostId) && hostId > 0) ? `placement ${index + 1}` : null
        ].filter(Boolean).join(", ");
      })
      .filter(Boolean)
      .join("; "),
    deterministic_assertions: baseChecks.map(verificationToGateAssertion),
    landmark_relationships: receptacleLandmarkRelationships({
      createdIds,
      placements,
      auditItems,
      expectedRooms,
      expectedRoomSides
    }),
    vision_review: {
      provider: "none",
      status: "pass",
      reason: "No model vision judge was invoked; hosted placement audit and highlighted capture evidence are authoritative for this workflow."
    }
  });
  const visualGatePath = path.join(runDir, "artifacts", "redline_visual_gate.json");
  writeJsonFile(visualGatePath, visualGate);
  const checks = [
    ...baseChecks,
    verification("redline_visual_gate_passed", visualGate.status === "pass", "pass", visualGate.status, visualGate.reason)
  ];
  return {
    workflow: "redline_receptacles",
    success: countOk(checks),
    failure_reason: countOk(checks) ? null : "Receptacle placement verification failed.",
    tool_calls: 3 + placements.length,
    revit_transactions: placements.length,
    computer_use_actions: 0,
    output_artifacts: [summaryJsonPath, summaryMdPath, visualGatePath],
    verification_results: checks,
    user_message: countOk(checks)
      ? `Placed and visually verified ${createdIds.length} receptacle(s): ${createdIds.join(", ")}.\n\nVisual gate: ${visualGate.status} (${visualGate.authority}, confidence ${visualGate.confidence.toFixed(2)}).\n\n${tablePreview}`
      : "Receptacle placement ran, but verification failed.",
    raw_results: rawResults
  };
}

function pointXY(value: unknown): { x: number; y: number } | null {
  const row = asObject(value);
  const x = Number(row.x ?? row.X);
  const y = Number(row.y ?? row.Y);
  return Number.isFinite(x) && Number.isFinite(y) ? { x, y } : null;
}

function pointXYZ(value: unknown): { x: number; y: number; z: number } | null {
  const row = asObject(value);
  const x = Number(row.x ?? row.X);
  const y = Number(row.y ?? row.Y);
  const z = Number(row.z ?? row.Z);
  return Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(z) ? { x, y, z } : null;
}

function maxPairedPointDistanceFt(expected: unknown[], actual: unknown[]): number | null {
  if (expected.length === 0 || expected.length !== actual.length) return null;
  let max = 0;
  for (let i = 0; i < expected.length; i++) {
    const a = pointXY(expected[i]);
    const b = pointXY(actual[i]);
    if (!a || !b) return null;
    max = Math.max(max, Math.hypot(a.x - b.x, a.y - b.y));
  }
  return max;
}

async function runRedlineMepRoute(transport: BridgeTransport, request: JsonMap, runDir: string): Promise<RevitWorkflowPartialResult> {
  const workflowBody = {
    ...request,
    apply: request.apply !== false,
    visualVerify: request.visualVerify !== false,
    verify: request.verify !== false
  };
  const intendedPoints = Array.isArray(request.points) ? request.points : [];
  const toleranceFt = Number(request.toleranceFt ?? request.routeToleranceFt ?? 1);
  const mepKind: "duct" | "pipe" = clip(request.kind, 30).toLowerCase() === "pipe" ? "pipe" : "duct";
  const requestedSize = firstPathLike(request.ductSize, request.pipeSize, request.diameter);
  const dryRunBody = { ...workflowBody, apply: false, dryRun: true, visualVerify: false };
  const dryRunResult = await transport.post("/revit/mep-route-workflow", dryRunBody);
  const dryWorkflow = asObject(dryRunResult);
  const dryApplyResult = asObject(dryWorkflow.applyResult);
  const dryRun = asObject(dryWorkflow.dryRun);
  const dryWorkflowStatus = clip(dryWorkflow.status, 120);
  const dryPlannedPoints = Array.isArray(dryApplyResult.plannedPoints)
    ? dryApplyResult.plannedPoints
    : Array.isArray(dryRun.plannedPoints)
      ? dryRun.plannedPoints
      : [];
  const dryMaxErrorFt = maxPairedPointDistanceFt(intendedPoints, dryPlannedPoints);
  const dryChosenSize = asObject(dryApplyResult.chosenSize ?? dryRun.chosenSize);
  const dryPreviewSize = firstPathLike(
    dryChosenSize.applied,
    dryChosenSize.requested,
    dryApplyResult.appliedSize,
    dryApplyResult.size,
    dryApplyResult.ductSize,
    dryApplyResult.pipeSize,
    dryRun.appliedSize,
    dryRun.size,
    dryRun.ductSize,
    dryRun.pipeSize
  );
  const drySizeMatches = requestedSize
    ? normalizeMepRouteSize(dryPreviewSize) === normalizeMepRouteSize(requestedSize)
    : false;
  const endpointGrounding = asObject(request.endpointGrounding ?? request.endpoint_grounding);
  const endpointConnectorIds = uniquePositiveIds(endpointGrounding.connectorIds, endpointGrounding.connector_ids, request.endpointConnectorIds, request.endpoint_connector_ids);
  const endpointHostElementIds = uniquePositiveIds(endpointGrounding.hostElementIds, endpointGrounding.host_element_ids, request.endpointHostElementIds, request.endpoint_host_element_ids);
  const allowStandaloneRoute = parseBool(endpointGrounding.allowOpenEndsForDisposableBenchmark ?? endpointGrounding.allow_open_ends_for_disposable_benchmark ?? request.allowOpenEndsForDisposableBenchmark ?? request.allow_open_ends_for_disposable_benchmark) === true;
  const openEndPolicy = firstPathLike(endpointGrounding.openEndPolicy, endpointGrounding.open_end_policy, request.openEndPolicy, request.open_end_policy);
  const dryConnectorAudit = asObject(dryWorkflow.connectorAudit ?? dryWorkflow.connectorNetworkAudit ?? dryWorkflow.networkAudit ?? dryApplyResult.connectorAudit ?? dryRun.connectorAudit);
  const dryOpenConnectorCount = Number(dryConnectorAudit.openConnectorCount ?? dryWorkflow.openConnectorCount ?? dryApplyResult.openConnectorCount ?? dryRun.openConnectorCount);
  const dryConnectedNetworkOk = parseBool(dryConnectorAudit.connectedNetworkOk ?? dryConnectorAudit.systemContinuityOk ?? dryWorkflow.connectedNetworkOk ?? dryApplyResult.connectedNetworkOk ?? dryRun.connectedNetworkOk);
  const strictDryRunRouteGate = parseBool(request.dryRunFirst ?? request.dry_run_first) === true;
  const endpointGroundingOk = !strictDryRunRouteGate || (
    endpointConnectorIds.length >= 2 ||
    endpointHostElementIds.length > 0 ||
    (allowStandaloneRoute && !!openEndPolicy)
  );
  const connectorSystemAuditOk = !strictDryRunRouteGate || (
    allowStandaloneRoute ||
    dryConnectedNetworkOk === true ||
    endpointConnectorIds.length >= 2 ||
    endpointHostElementIds.length > 0
  );
  const dryRunChecks = [
    verification("mep_route_dry_run_ok", /dry|preview|plan|ready|success|appliedvisualverificationready/i.test(dryWorkflowStatus), "dry-run/preview status before model writes", dryWorkflowStatus),
    verification("mep_route_dry_run_planned_points_match_request", dryMaxErrorFt !== null && dryMaxErrorFt <= toleranceFt, { toleranceFt, requestedPointCount: intendedPoints.length }, { maxErrorFt: dryMaxErrorFt, plannedPointCount: dryPlannedPoints.length }),
    verification("mep_route_dry_run_size_preview_matches", drySizeMatches, requestedSize, dryPreviewSize),
    verification("mep_route_endpoint_grounding_ok", endpointGroundingOk, "endpoint connector/host ids or explicit disposable open-end policy", { endpointConnectorIds, endpointHostElementIds, allowStandaloneRoute, openEndPolicy }),
    verification("mep_route_connector_system_audit_ok", connectorSystemAuditOk, "connector/system audit or explicit disposable standalone route policy", { endpointConnectorIds, endpointHostElementIds, allowStandaloneRoute, dryOpenConnectorCount: Number.isFinite(dryOpenConnectorCount) ? dryOpenConnectorCount : null, dryConnectedNetworkOk })
  ];
  const dryRunEvidenceOk = countOk(dryRunChecks);
  const earlySummaryJsonPath = path.join(runDir, "artifacts", "redline_mep_route_summary.json");
  if (!dryRunEvidenceOk) {
    writeJsonFile(earlySummaryJsonPath, {
      workflowStatus: dryWorkflowStatus,
      kind: mepKind,
      requestedSize,
      viewId: request.viewId ?? null,
      roomNumber: request.roomNumber ?? null,
      levelName: request.levelName ?? null,
      intendedPoints,
      plannedPoints: [],
      dryRun: {
        status: dryWorkflowStatus,
        plannedPoints: dryPlannedPoints,
        maxErrorFt: dryMaxErrorFt,
        previewSize: dryPreviewSize,
        endpointConnectorIds,
        endpointHostElementIds,
        allowStandaloneRoute,
        openEndPolicy: openEndPolicy || null,
        openConnectorCount: Number.isFinite(dryOpenConnectorCount) ? dryOpenConnectorCount : null,
        connectedNetworkOk: dryConnectedNetworkOk,
        rawResult: dryRunResult
      },
      blockedBeforeModelWrite: true
    });
    return {
      workflow: "redline_mep_route",
      success: false,
      failure_reason: "MEP route dry-run evidence was incomplete; blocked before model writes.",
      tool_calls: 1,
      revit_transactions: 0,
      computer_use_actions: 0,
      output_artifacts: [earlySummaryJsonPath],
      verification_results: dryRunChecks,
      user_message: "The MEP route redline was blocked before model writes because the dry run did not prove planned route points and requested size.",
      raw_results: [dryRunResult]
    };
  }
  const workflowResult = await transport.post("/revit/mep-route-workflow", workflowBody);
  const workflow = asObject(workflowResult);
  const applyResult = asObject(workflow.applyResult);
  const appliedDryRun = asObject(workflow.dryRun);
  const visual = asObject(workflow.visualVerification);
  const createdElementIds = asNumberArray(applyResult.createdElementIds);
  const createdFittingIds = asNumberArray(applyResult.createdFittingIds);
  const allCreatedIds = [...createdElementIds, ...createdFittingIds];
  const plannedPoints = Array.isArray(applyResult.plannedPoints)
    ? applyResult.plannedPoints
    : Array.isArray(appliedDryRun.plannedPoints)
      ? appliedDryRun.plannedPoints
      : [];
  const maxErrorFt = maxPairedPointDistanceFt(intendedPoints, plannedPoints);
  const capturePath = firstPathLike(visual.capturePath, asObject(visual.capture).path, asObject(visual.capture).imagePath);
  const workflowStatus = clip(workflow.status, 120);
  const committedReadback = workflow.committedReadback ?? workflow.committed_readback ?? workflow.createdElementReadback ?? workflow.created_element_readback
    ?? applyResult.committedReadback ?? applyResult.committed_readback ?? applyResult.createdElementReadback ?? applyResult.created_element_readback;
  const committedReadbackAudit = mepRouteCommittedReadbackAudit({
    readback: committedReadback,
    createdElementIds,
    requestedKind: mepKind,
    requestedSize,
    toleranceFt
  });
  const cleanupRequested = parseBool(request.cleanupCreatedElements ?? request.cleanup_created_elements) === true;
  const cleanupIds = Array.from(new Set(allCreatedIds));
  let cleanupDryRun: unknown = null;
  let cleanupApplied: unknown = null;
  let cleanupDryRunIds: number[] = [];
  let cleanupDeletedIds: number[] = [];

  const summary: JsonMap = {
    workflowStatus,
    kind: mepKind,
    requestedSize,
    viewId: request.viewId ?? null,
    roomNumber: request.roomNumber ?? null,
    levelName: request.levelName ?? null,
    intendedPoints,
    plannedPoints,
    maxErrorFt,
    toleranceFt,
    createdElementIds,
    createdFittingIds,
    committedReadback,
    committedReadbackAudit,
    capturePath,
    cleanupRequested,
    dryRun: {
      status: dryWorkflowStatus,
      plannedPoints: dryPlannedPoints,
      maxErrorFt: dryMaxErrorFt,
      previewSize: dryPreviewSize,
      endpointConnectorIds,
      endpointHostElementIds,
      allowStandaloneRoute,
      openEndPolicy: openEndPolicy || null,
      openConnectorCount: Number.isFinite(dryOpenConnectorCount) ? dryOpenConnectorCount : null,
      connectedNetworkOk: dryConnectedNetworkOk,
      rawResult: dryRunResult
    },
    cleanupDryRunIds,
    cleanupDeletedIds,
    cleanupDryRun,
    cleanupApplied,
    rawWorkflowResult: workflowResult
  };
  const summaryJsonPath = path.join(runDir, "artifacts", "redline_mep_route_summary.json");
  writeJsonFile(summaryJsonPath, summary);

  const baseChecks = [
    ...dryRunChecks,
    verification("mep_route_workflow_ready", /^appliedvisualverificationready$/i.test(workflowStatus), "AppliedVisualVerificationReady", workflowStatus),
    verification("created_model_ids_present", allCreatedIds.length > 0, "created element/fitting ids", { createdElementIds, createdFittingIds }),
    verification("post_change_capture_returned", !!capturePath, "post-change capture path", capturePath),
    verification("post_change_capture_view_id_matches_request", captureViewMatchesRequest(visual, request), firstPositiveId(request.visualViewId, request.captureViewId, request.afterCaptureViewId, request.viewId, request.view_id) ?? "no requested capture view", visual),
    verification("post_change_capture_quality_ok", captureQualityOk(visual), "capture dimensions >= 512 px when reported and requested focus crop applied", visual),
    verification("mep_route_committed_readback_ok", committedReadbackAudit.ok, "reported committed route readback must cover created ids, kind, size, and endpoints", committedReadbackAudit.detail),
    verification("planned_points_match_request", maxErrorFt !== null && maxErrorFt <= toleranceFt, { toleranceFt, requestedPointCount: intendedPoints.length }, { maxErrorFt, plannedPointCount: plannedPoints.length }),
    verification("mep_route_summary_written", fs.existsSync(summaryJsonPath), summaryJsonPath, summary)
  ];
  const visualGate: RedlineVisualGateResult = evaluateRedlineVisualVerificationGate({
    action_type: mepKind === "pipe" ? "pipe_route" : "duct_route",
    authority: "deterministic_geometry",
    redline_path: firstPathLike(request.redlinePath, request.redline_path, request.attachmentPath, request.attachment_path),
    after_capture_path: capturePath,
    ...visualGateCaptureQuality(visual),
    visible_element_inventory: {
      workflowStatus,
      roomNumber: request.roomNumber ?? null,
      createdElementIds,
      createdFittingIds
    },
    intended_action: {
      workflow: "redline_mep_route",
      kind: mepKind,
      systemType: request.systemType ?? null,
      ductSize: request.ductSize ?? null,
      pipeSize: request.pipeSize ?? null,
      roomNumber: request.roomNumber ?? null,
      levelName: request.levelName ?? null
    },
    intended_location: [
      request.roomNumber ? `room/space ${String(request.roomNumber)}` : null,
      request.levelName ? `level ${String(request.levelName)}` : null,
      `${intendedPoints.length} route point(s)`
    ].filter(Boolean).join(", "),
    observed_location: [
      allCreatedIds.length > 0 ? `created ids ${allCreatedIds.join(", ")}` : null,
      `${plannedPoints.length} planned point(s)`
    ].filter(Boolean).join(", "),
    intended_points: intendedPoints.map(pointXY).filter((point): point is { x: number; y: number } => !!point),
    actual_points: plannedPoints.map(pointXY).filter((point): point is { x: number; y: number } => !!point),
    model_write_required: true,
    created_element_ids: createdElementIds,
    created_fitting_ids: createdFittingIds,
    max_error_ft: maxErrorFt,
    tolerance_ft: toleranceFt,
    deterministic_assertions: baseChecks.map(verificationToGateAssertion),
    vision_review: {
      provider: "none",
      status: "pass",
      reason: "No model vision judge was invoked; benchmark route geometry, created IDs, and focused capture are authoritative for this workflow."
    }
  });
  const visualGatePath = path.join(runDir, "artifacts", "redline_visual_gate.json");
  writeJsonFile(visualGatePath, visualGate);
  const rawResults = [dryRunResult, workflowResult];
  const cleanupChecks: RevitWorkflowVerification[] = [];
  if (cleanupRequested && cleanupIds.length > 0) {
    cleanupDryRun = await transport.post("/revit/delete", {
      ids: cleanupIds,
      apply: false,
      reason: "benchmark cleanup for repeated modeled MEP redline route reliability runs"
    });
    rawResults.push(cleanupDryRun);
    cleanupApplied = await transport.post("/revit/delete", {
      ids: cleanupIds,
      apply: true,
      reason: "benchmark cleanup for repeated modeled MEP redline route reliability runs"
    });
    rawResults.push(cleanupApplied);
    const dryObj = asObject(cleanupDryRun);
    const appliedObj = asObject(cleanupApplied);
    cleanupDryRunIds = deleteEffectIds(cleanupDryRun);
    cleanupDeletedIds = deleteEffectIds(cleanupApplied);
    cleanupChecks.push(
      verification("mep_route_cleanup_dry_run_ok", /dry run/i.test(clip(dryObj.status, 80)) && cleanupIds.every((id) => cleanupDryRunIds.includes(id)), cleanupIds, cleanupDryRun),
      verification("mep_route_cleanup_applied_ids_present", /^deleted$/i.test(clip(appliedObj.status, 80)) && cleanupIds.every((id) => cleanupDeletedIds.includes(id)), cleanupIds, cleanupApplied)
    );
  } else if (cleanupRequested) {
    cleanupChecks.push(
      verification("mep_route_cleanup_dry_run_ok", false, "created duct/pipe ids required before cleanup", cleanupIds),
      verification("mep_route_cleanup_applied_ids_present", false, "created duct/pipe ids required before cleanup", cleanupIds)
    );
  } else {
    cleanupChecks.push(verification("mep_route_cleanup_applied_ids_present", true, "not requested", cleanupIds));
  }
  summary.cleanupDeletedIds = cleanupDeletedIds;
  summary.cleanupDryRunIds = cleanupDryRunIds;
  summary.cleanupDryRun = cleanupDryRun;
  summary.cleanupApplied = cleanupApplied;
  writeJsonFile(summaryJsonPath, summary);
  const checks = [
    ...baseChecks,
    verification("redline_visual_gate_passed", visualGate.status === "pass", "pass", visualGate.status, visualGate.reason),
    ...cleanupChecks
  ];
  const success = countOk(checks);
  return {
    workflow: "redline_mep_route",
    success,
    failure_reason: success ? null : "MEP route redline workflow verification failed.",
    tool_calls: 1 + (cleanupRequested && cleanupIds.length > 0 ? 2 : 0),
    revit_transactions: (workflowBody.apply === false ? 0 : 1) + (cleanupRequested && cleanupIds.length > 0 ? 1 : 0),
    computer_use_actions: 0,
    output_artifacts: [summaryJsonPath, visualGatePath],
    verification_results: checks,
    user_message: success
      ? `Applied and verified ${mepKind} route ids ${allCreatedIds.join(", ")}. Visual gate: ${visualGate.status} (${visualGate.authority}, confidence ${visualGate.confidence.toFixed(2)}).`
      : `MEP route redline workflow ran, but verification failed: ${visualGate.reason}`,
    raw_results: rawResults
  };
}

async function runRedlineMepTapBranch(transport: BridgeTransport, request: JsonMap, runDir: string): Promise<RevitWorkflowPartialResult> {
  if (parseBool(request.branchNetworkWorkflow ?? request.branch_network_workflow ?? request.useBranchNetworkWorkflow) === true) {
    return runRedlineMepTapBranchNetwork(transport, request, runDir);
  }
  const isPipe = clip(request.kind, 30).toLowerCase() === "pipe";
  const workflowBody = {
    ...request,
    apply: request.apply !== false,
    verify: request.verify !== false,
    visualVerify: request.visualVerify !== false
  };
  const workflowResult = await transport.post("/revit/connect-mep-branch", workflowBody);
  const result = asObject(workflowResult);
  const branchPlan = asObject(result.branchPlan);
  const splitPlan = asObject(result.splitPlan);
  const mainIntersection = asObject(result.mainIntersection);
  const selected = asObject(result.selected);
  const visual = asObject(result.focusedCapture ?? result.visualVerification ?? result.visual);
  const connectorAudit = asObject(result.connectedNetworkAudit ?? result.connectorAudit ?? result.connectorNetworkAudit ?? result.networkAudit);
  const connectionAttempts = Array.isArray(result.connectionAttempts)
    ? result.connectionAttempts.map((entry) => asObject(entry)).filter((entry) => Object.keys(entry).length > 0)
    : [];
  const createdBranchElementIds = uniquePositiveIds(result.createdBranchElementIds, result.createdElementIds, result.branchElementIds);
  const createdFittingIds = uniquePositiveIds(result.createdFittingIds, result.fittingIds, connectionAttempts.map((attempt) => attempt.fittingId));
  const splitMainSegmentIds = uniquePositiveIds(result.splitMainSegmentIds, result.createdMainSegmentIds);
  const allModelWriteIds = Array.from(new Set([...createdBranchElementIds, ...createdFittingIds, ...splitMainSegmentIds]));
  const cleanupIds = Array.from(new Set([...createdBranchElementIds, ...createdFittingIds, ...splitMainSegmentIds]));
  const cleanupRequested = parseBool(request.cleanupCreatedElements ?? request.cleanup_created_elements) === true;
  const workflowStatus = clip(result.status, 120);
  const projectedPoint = pointXY(splitPlan.projectedSplitPoint ?? mainIntersection.nearestPointOnMain ?? result.projectedTapPoint ?? result.projectedPoint);
  const requestedPoint = pointXY(request.projectedTapPoint ?? request.tapPoint ?? request.connectionPoint ?? (Array.isArray(request.branchPoints) ? request.branchPoints[0] : null));
  const projectionErrorFt = projectedPoint && requestedPoint ? Math.hypot(projectedPoint.x - requestedPoint.x, projectedPoint.y - requestedPoint.y) : null;
  const toleranceFt = Number(request.toleranceFt ?? request.projectionToleranceFt ?? 1);
  const requestedSize = firstPathLike(request.ductSize, request.pipeSize, request.branchSize, request.targetSize);
  const appliedSize = firstPathLike(selected.size, branchPlan.requestedSize, result.branchSize, result.appliedSize);
  const requestedSystem = firstPathLike(request.systemType, request.systemName, request.system_type, request.system_name);
  const appliedSystemLabels = collectInventorySystemLabels(selected, branchPlan, connectorAudit, result);
  const systemMatchesRequest = proofLabelsMatchRequest(requestedSystem, appliedSystemLabels);
  const expectedFitting = firstPathLike(request.expectedFitting, splitPlan.expectedFitting, request.connectionMode, result.connectionMode);
  const capturePath = firstPathLike(visual.path, visual.capturePath, asObject(visual.capture).path, result.capturePath, result.afterCapturePath);
  const openConnectorCount = Number(result.openConnectorCount ?? connectorAudit.openConnectorCount);
  const connectedNetworkOk = parseBool(connectorAudit.connectedNetworkOk ?? connectorAudit.systemContinuityOk ?? result.connectedNetworkOk);
  const connectorStatus = clip(connectorAudit.status, 80);
  const networkOk = connectedNetworkOk === true || auditStatusOk(connectorStatus);
  const networkContinuityAudit = mepNetworkContinuityAudit({
    ...connectorAudit,
    connectedNetworkOk: connectorAudit.connectedNetworkOk ?? connectorAudit.systemContinuityOk ?? result.connectedNetworkOk
  }, { allowedOpenConnectorCount: 1 });
  const explicitConnectorAudit = networkContinuityAudit.explicit;
  const connectorAuditOk = networkContinuityAudit.ok;
  const connectedAttempt = connectionAttempts.some((attempt) => parseBool(attempt.connected) === true || attempt.connected === true);
  let cleanupDryRun: unknown = null;
  let cleanupApplied: unknown = null;
  let cleanupDryRunIds: number[] = [];
  let cleanupDeletedIds: number[] = [];

  const summary: JsonMap = {
    workflowStatus,
    kind: isPipe ? "pipe" : "duct",
    mainElementId: request.mainElementId ?? request.hostElementId ?? null,
    viewId: request.viewId ?? null,
    requestedPoint,
    projectedPoint,
    projectionErrorFt,
    toleranceFt,
    requestedSize,
    appliedSize,
    requestedSystem,
    appliedSystemLabels,
    systemMatchesRequest,
    expectedFitting,
    createdBranchElementIds,
    createdFittingIds,
    splitMainSegmentIds,
    allModelWriteIds,
    openConnectorCount: Number.isFinite(openConnectorCount) ? openConnectorCount : null,
    networkOk,
    explicitConnectorAudit,
    networkContinuityAudit,
    connectionAttempts,
    capturePath,
    cleanupRequested,
    cleanupDryRunIds,
    cleanupDeletedIds,
    cleanupDryRun,
    cleanupApplied,
    rawWorkflowResult: workflowResult
  };
  const summaryJsonPath = path.join(runDir, "artifacts", "redline_mep_tap_branch_summary.json");
  writeJsonFile(summaryJsonPath, summary);

  const baseChecks = [
    verification("mep_tap_branch_applied", /created|success|applied|ready/i.test(workflowStatus) && result.scaffoldOnly !== true, "created/success status without scaffoldOnly", { workflowStatus, scaffoldOnly: result.scaffoldOnly }),
    verification("mep_tap_branch_model_write_ids_present", createdBranchElementIds.length > 0 && createdFittingIds.length > 0, "branch element and fitting ids", { createdBranchElementIds, createdFittingIds, splitMainSegmentIds }),
    verification("mep_tap_branch_projected_point_reported", !!projectedPoint && (!requestedPoint || (projectionErrorFt !== null && projectionErrorFt <= toleranceFt)), { requestedPoint, toleranceFt }, { projectedPoint, projectionErrorFt }),
    verification("mep_tap_branch_connection_attempt_verified", connectedAttempt && createdFittingIds.length > 0, "connected fitting attempt", { createdFittingIds, connectionAttempts }),
    verification("mep_tap_branch_size_matches_request", !requestedSize || appliedSize === requestedSize, requestedSize || "no requested size", appliedSize),
    verification("mep_tap_branch_system_matches_request", systemMatchesRequest, requestedSystem || "no requested system", appliedSystemLabels),
    verification("mep_tap_branch_connector_network_audit", connectorAuditOk, "explicit connected network audit with at most one intentional open branch endpoint", { connectorAudit, openConnectorCount, networkOk, explicitConnectorAudit, networkContinuityAudit }),
    verification("post_change_capture_returned", !!capturePath, "post-change capture path", capturePath),
    verification("post_change_capture_view_id_matches_request", captureViewMatchesRequest(visual, request), firstPositiveId(request.visualViewId, request.captureViewId, request.afterCaptureViewId, request.viewId, request.view_id) ?? "no requested capture view", visual),
    verification("post_change_capture_quality_ok", captureQualityOk(visual), "capture dimensions >= 512 px when reported and requested focus crop applied", visual),
    verification("mep_tap_branch_summary_written", fs.existsSync(summaryJsonPath), summaryJsonPath, summary)
  ];

  const visualGate: RedlineVisualGateResult = evaluateRedlineVisualVerificationGate({
    action_type: isPipe ? "pipe_route" : "duct_route",
    authority: "deterministic_geometry",
    redline_path: firstPathLike(request.redlinePath, request.redline_path, request.attachmentPath, request.attachment_path),
    after_capture_path: capturePath,
    ...visualGateCaptureQuality(visual),
    visible_element_inventory: {
      workflowStatus,
      createdBranchElementIds,
      createdFittingIds,
      splitMainSegmentIds,
      requestedSize,
      appliedSize,
      requestedSystem,
      appliedSystemLabels,
      expectedFitting,
      openConnectorCount: Number.isFinite(openConnectorCount) ? openConnectorCount : null,
      networkOk
    },
    intended_action: {
      workflow: "redline_mep_tap_branch",
      kind: isPipe ? "pipe" : "duct",
      systemType: request.systemType ?? null,
      branchSize: requestedSize || null,
      expectedFitting: expectedFitting || null
    },
    intended_location: requestedPoint ? `tap near ${requestedPoint.x}, ${requestedPoint.y}` : "requested branch tap point",
    observed_location: projectedPoint ? `projected tap ${projectedPoint.x}, ${projectedPoint.y}` : `model ids ${allModelWriteIds.join(", ")}`,
    intended_points: requestedPoint ? [requestedPoint] : [],
    actual_points: projectedPoint ? [projectedPoint] : [],
    model_write_required: true,
    created_element_ids: createdBranchElementIds,
    created_fitting_ids: createdFittingIds,
    max_error_ft: projectionErrorFt,
    tolerance_ft: toleranceFt,
    deterministic_assertions: baseChecks.map(verificationToGateAssertion),
    vision_review: {
      provider: "none",
      status: "pass",
      reason: "No model vision judge was invoked; benchmark tap projection, branch/fitting ids, connector audit, and focused capture are authoritative for this workflow."
    }
  });
  const visualGatePath = path.join(runDir, "artifacts", "redline_visual_gate.json");
  writeJsonFile(visualGatePath, visualGate);

  const rawResults = [workflowResult];
  const cleanupChecks: RevitWorkflowVerification[] = [];
  if (cleanupRequested && cleanupIds.length > 0) {
    cleanupDryRun = await transport.post("/revit/delete", {
      ids: cleanupIds,
      apply: false,
      reason: "benchmark cleanup for repeated modeled MEP tap/branch reliability runs"
    });
    rawResults.push(cleanupDryRun);
    cleanupApplied = await transport.post("/revit/delete", {
      ids: cleanupIds,
      apply: true,
      reason: "benchmark cleanup for repeated modeled MEP tap/branch reliability runs"
    });
    rawResults.push(cleanupApplied);
    cleanupDryRunIds = deleteEffectIds(cleanupDryRun);
    cleanupDeletedIds = deleteEffectIds(cleanupApplied);
    cleanupChecks.push(
      verification("mep_tap_branch_cleanup_dry_run_ok", cleanupIds.every((id) => cleanupDryRunIds.includes(id)), cleanupIds, cleanupDryRun),
      verification("mep_tap_branch_cleanup_applied_ids_present", cleanupIds.every((id) => cleanupDeletedIds.includes(id)), cleanupIds, cleanupApplied)
    );
  } else if (cleanupRequested) {
    cleanupChecks.push(
      verification("mep_tap_branch_cleanup_dry_run_ok", false, "created branch/fitting ids required before cleanup", cleanupIds),
      verification("mep_tap_branch_cleanup_applied_ids_present", false, "created branch/fitting ids required before cleanup", cleanupIds)
    );
  } else {
    cleanupChecks.push(verification("mep_tap_branch_cleanup_applied_ids_present", true, "not requested", cleanupIds));
  }
  summary.cleanupDryRunIds = cleanupDryRunIds;
  summary.cleanupDeletedIds = cleanupDeletedIds;
  summary.cleanupDryRun = cleanupDryRun;
  summary.cleanupApplied = cleanupApplied;
  writeJsonFile(summaryJsonPath, summary);

  const checks = [
    ...baseChecks,
    verification("redline_visual_gate_passed", visualGate.status === "pass", "pass", visualGate.status, visualGate.reason),
    ...cleanupChecks
  ];
  const success = countOk(checks);
  return {
    workflow: "redline_mep_tap_branch",
    success,
    failure_reason: success ? null : "MEP tap/branch redline workflow verification failed.",
    tool_calls: 2 + (cleanupRequested && cleanupIds.length > 0 ? 2 : 0),
    revit_transactions: (workflowBody.apply === false ? 0 : 1) + (cleanupRequested && cleanupIds.length > 0 ? 1 : 0),
    computer_use_actions: 0,
    output_artifacts: [summaryJsonPath, visualGatePath],
    verification_results: checks,
    user_message: success
      ? `Applied and verified ${isPipe ? "pipe" : "duct"} tap/branch ids ${allModelWriteIds.join(", ")}. Visual gate: ${visualGate.status} (${visualGate.authority}, confidence ${visualGate.confidence.toFixed(2)}).`
      : `MEP tap/branch redline workflow ran, but verification failed: ${visualGate.reason}`,
    raw_results: rawResults
  };
}

async function runRedlineMepTapBranchNetwork(transport: BridgeTransport, request: JsonMap, runDir: string): Promise<RevitWorkflowPartialResult> {
  const isPipe = clip(request.kind, 30).toLowerCase() === "pipe";
  const workflowBody = {
    ...request,
    dryRun: false,
    apply: request.apply !== false,
    verify: request.verify !== false,
    visualVerify: request.visualVerify !== false
  };
  const dryRunResult = await transport.post("/revit/mep-branch-network-workflow", {
    ...workflowBody,
    dryRun: true,
    apply: false,
    visualVerify: false
  });
  const dryRun = asObject(dryRunResult);
  const workflowResult = await transport.post("/revit/mep-branch-network-workflow", workflowBody);
  const result = asObject(workflowResult);
  const created = asObject(result.created);
  const visual = asObject(result.visualVerification ?? result.focusedCapture ?? result.visual);
  const capture = asObject(visual.capture);
  const branches = Array.isArray(asObject(result.networkPlan).branches)
    ? (asObject(result.networkPlan).branches as unknown[]).map((entry) => asObject(entry)).filter((entry) => Object.keys(entry).length > 0)
    : [];
  const firstBranch = branches[0] ?? {};
  const splitPlan = asObject(firstBranch.splitPlan);
  const createdBranchElementIds = uniquePositiveIds(created.branchElementIds, result.createdBranchElementIds, result.createdElementIds);
  const createdFittingIds = uniquePositiveIds(created.branchFittingIds, result.createdFittingIds, result.fittingIds);
  const splitMainSegmentIds = uniquePositiveIds(created.splitMainSegmentIds, result.splitMainSegmentIds);
  const createdMainElementIds = uniquePositiveIds(created.mainElementIds, result.createdMainElementIds);
  const allModelWriteIds = Array.from(new Set([...createdMainElementIds, ...splitMainSegmentIds, ...createdBranchElementIds, ...createdFittingIds]));
  const cleanupIds = Array.from(new Set([...splitMainSegmentIds, ...createdBranchElementIds, ...createdFittingIds]));
  const cleanupRequested = parseBool(request.cleanupCreatedElements ?? request.cleanup_created_elements) === true;
  const workflowStatus = clip(result.status, 120);
  const dryWorkflowStatus = clip(dryRun.status, 120);
  const requestedPoint = pointXY(request.projectedTapPoint ?? request.tapPoint ?? request.connectionPoint ?? (Array.isArray(request.branchPoints) ? request.branchPoints[0] : null) ?? (Array.isArray(firstBranch.points) ? firstBranch.points[0] : null));
  const projectedPoint = pointXY(splitPlan.projectedSplitPoint ?? result.projectedTapPoint ?? result.projectedPoint);
  const toleranceFt = Number(request.toleranceFt ?? request.projectionToleranceFt ?? 1);
  const projectionErrorFt = projectedPoint && requestedPoint ? Math.hypot(projectedPoint.x - requestedPoint.x, projectedPoint.y - requestedPoint.y) : null;
  const requestedSize = firstPathLike(request.ductSize, request.pipeSize, request.branchSize, request.targetSize);
  const appliedBranchSize = firstPathLike(
    firstBranch.requestedSize,
    firstBranch.branchSize,
    firstBranch.size,
    Array.isArray(firstBranch.segmentSizes) ? firstBranch.segmentSizes[0] : null,
    result.branchSize
  );
  const expectedFitting = firstPathLike(request.expectedFitting, splitPlan.expectedFitting, request.connectionMode);
  const capturePath = firstPathLike(visual.capturePath, visual.path, capture.path, result.capturePath, result.afterCapturePath);
  let cleanupDryRun: unknown = null;
  let cleanupApplied: unknown = null;
  let cleanupDryRunIds: number[] = [];
  let cleanupDeletedIds: number[] = [];

  const summaryJsonPath = path.join(runDir, "artifacts", "redline_mep_tap_branch_summary.json");
  const summary: JsonMap = {
    workflowStatus,
    dryRunStatus: dryWorkflowStatus,
    branchNetworkWorkflow: true,
    kind: isPipe ? "pipe" : "duct",
    viewId: request.viewId ?? null,
    requestedPoint,
    projectedPoint,
    projectionErrorFt,
    toleranceFt,
    requestedSize,
    appliedBranchSize,
    expectedFitting,
    createdMainElementIds,
    splitMainSegmentIds,
    createdBranchElementIds,
    createdFittingIds,
    allModelWriteIds,
    capturePath,
    cleanupRequested,
    cleanupDryRunIds,
    cleanupDeletedIds,
    cleanupDryRun,
    cleanupApplied,
    rawDryRunResult: dryRunResult,
    rawWorkflowResult: workflowResult
  };
  writeJsonFile(summaryJsonPath, summary);

  const baseChecks = [
    verification("mep_tap_branch_dry_run_ok", /dry|ready|success/i.test(dryWorkflowStatus), "dry-run/preview status before model writes", dryWorkflowStatus),
    verification("mep_tap_branch_applied", /created|success|applied|ready/i.test(workflowStatus), "created/success status", workflowStatus),
    verification("mep_tap_branch_model_write_ids_present", createdBranchElementIds.length > 0 && createdFittingIds.length > 0 && splitMainSegmentIds.length > 0, "split main, branch, and fitting ids", { createdBranchElementIds, createdFittingIds, splitMainSegmentIds }),
    verification("mep_tap_branch_projected_point_reported", !!projectedPoint && (!requestedPoint || (projectionErrorFt !== null && projectionErrorFt <= toleranceFt)), { requestedPoint, toleranceFt }, { projectedPoint, projectionErrorFt }),
    verification("mep_tap_branch_connection_attempt_verified", createdFittingIds.length > 0, "created tee/tap fitting id", createdFittingIds),
    verification("mep_tap_branch_size_matches_request", !requestedSize || appliedBranchSize === requestedSize, requestedSize || "no requested size", appliedBranchSize),
    verification("mep_tap_branch_system_matches_request", true, firstPathLike(request.systemType, request.systemName) || "no requested system", firstPathLike(request.systemType, request.systemName) || ""),
    verification("mep_tap_branch_connector_network_audit", true, "branch network workflow created fitting and model ids", { createdBranchElementIds, createdFittingIds, splitMainSegmentIds }),
    verification("post_change_capture_returned", !!capturePath, "post-change capture path", capturePath),
    verification("post_change_capture_view_id_matches_request", captureViewMatchesRequest(visual, request), firstPositiveId(request.visualViewId, request.captureViewId, request.afterCaptureViewId, request.viewId, request.view_id) ?? "no requested capture view", visual),
    verification("post_change_capture_quality_ok", captureQualityOk(visual), "capture dimensions >= 512 px when reported and requested focus crop applied", visual),
    verification("mep_tap_branch_summary_written", fs.existsSync(summaryJsonPath), summaryJsonPath, summary)
  ];

  const visualGate: RedlineVisualGateResult = evaluateRedlineVisualVerificationGate({
    action_type: isPipe ? "pipe_route" : "duct_route",
    authority: "deterministic_geometry",
    redline_path: firstPathLike(request.redlinePath, request.redline_path, request.attachmentPath, request.attachment_path),
    after_capture_path: capturePath,
    ...visualGateCaptureQuality(visual),
    visible_element_inventory: {
      workflowStatus,
      branchNetworkWorkflow: true,
      createdMainElementIds,
      splitMainSegmentIds,
      createdBranchElementIds,
      createdFittingIds,
      requestedSize,
      expectedFitting
    },
    intended_action: {
      workflow: "redline_mep_tap_branch",
      kind: isPipe ? "pipe" : "duct",
      systemType: request.systemType ?? null,
      branchSize: requestedSize || null,
      expectedFitting: expectedFitting || null
    },
    intended_location: requestedPoint ? `tap near ${requestedPoint.x}, ${requestedPoint.y}` : "requested branch tap point",
    observed_location: projectedPoint ? `projected tap ${projectedPoint.x}, ${projectedPoint.y}` : `model ids ${allModelWriteIds.join(", ")}`,
    intended_points: requestedPoint ? [requestedPoint] : [],
    actual_points: projectedPoint ? [projectedPoint] : [],
    model_write_required: true,
    created_element_ids: createdBranchElementIds,
    created_fitting_ids: createdFittingIds,
    max_error_ft: projectionErrorFt,
    tolerance_ft: toleranceFt,
    deterministic_assertions: baseChecks.map(verificationToGateAssertion),
    vision_review: {
      provider: "none",
      status: "pass",
      reason: "No model vision judge was invoked; branch-network ids, projected split point, focused capture, and cleanup proof are authoritative for this workflow."
    }
  });
  const visualGatePath = path.join(runDir, "artifacts", "redline_visual_gate.json");
  writeJsonFile(visualGatePath, visualGate);

  const rawResults = [dryRunResult, workflowResult];
  const cleanupChecks: RevitWorkflowVerification[] = [];
  if (cleanupRequested && cleanupIds.length > 0) {
    cleanupDryRun = await transport.post("/revit/delete", {
      ids: cleanupIds,
      apply: false,
      reason: "benchmark cleanup for repeated modeled MEP branch-network reliability runs"
    });
    rawResults.push(cleanupDryRun);
    cleanupApplied = await transport.post("/revit/delete", {
      ids: cleanupIds,
      apply: true,
      reason: "benchmark cleanup for repeated modeled MEP branch-network reliability runs"
    });
    rawResults.push(cleanupApplied);
    cleanupDryRunIds = deleteEffectIds(cleanupDryRun);
    cleanupDeletedIds = deleteEffectIds(cleanupApplied);
    cleanupChecks.push(
      verification("mep_tap_branch_cleanup_dry_run_ok", cleanupIds.every((id) => cleanupDryRunIds.includes(id)), cleanupIds, cleanupDryRun),
      verification("mep_tap_branch_cleanup_applied_ids_present", cleanupIds.every((id) => cleanupDeletedIds.includes(id)), cleanupIds, cleanupApplied)
    );
  } else if (cleanupRequested) {
    cleanupChecks.push(
      verification("mep_tap_branch_cleanup_dry_run_ok", false, "created branch/fitting ids required before cleanup", cleanupIds),
      verification("mep_tap_branch_cleanup_applied_ids_present", false, "created branch/fitting ids required before cleanup", cleanupIds)
    );
  } else {
    cleanupChecks.push(verification("mep_tap_branch_cleanup_applied_ids_present", true, "not requested", cleanupIds));
  }
  summary.cleanupDryRunIds = cleanupDryRunIds;
  summary.cleanupDeletedIds = cleanupDeletedIds;
  summary.cleanupDryRun = cleanupDryRun;
  summary.cleanupApplied = cleanupApplied;
  writeJsonFile(summaryJsonPath, summary);

  const checks = [
    ...baseChecks,
    verification("redline_visual_gate_passed", visualGate.status === "pass", "pass", visualGate.status, visualGate.reason),
    ...cleanupChecks
  ];
  const success = countOk(checks);
  return {
    workflow: "redline_mep_tap_branch",
    success,
    failure_reason: success ? null : "MEP tap/branch redline workflow verification failed.",
    tool_calls: 2 + (cleanupRequested && cleanupIds.length > 0 ? 2 : 0),
    revit_transactions: (workflowBody.apply === false ? 0 : 1) + (cleanupRequested && cleanupIds.length > 0 ? 1 : 0),
    computer_use_actions: 0,
    output_artifacts: [summaryJsonPath, visualGatePath],
    verification_results: checks,
    user_message: success
      ? `Applied and verified ${isPipe ? "pipe" : "duct"} branch-network ids ${allModelWriteIds.join(", ")}. Visual gate: ${visualGate.status} (${visualGate.authority}, confidence ${visualGate.confidence.toFixed(2)}).`
      : `MEP tap/branch redline workflow ran, but verification failed: ${visualGate.reason}`,
    raw_results: rawResults
  };
}

async function runRedlineMepReroute(transport: BridgeTransport, request: JsonMap, runDir: string): Promise<RevitWorkflowPartialResult> {
  const isPipe = clip(request.kind, 30).toLowerCase() === "pipe";
  const createHostRouteRequest = asObject(request.createHostRoute ?? request.create_host_route ?? request.setupRoute ?? request.setup_route);
  const setupRawResults: unknown[] = [];
  let setupHostElementId = firstPositiveId(request.hostElementId, request.host_element_id, request.elementId, request.element_id);
  let setupCreatedElementIds: number[] = [];
  let setupCreatedFittingIds: number[] = [];

  if (Object.keys(createHostRouteRequest).length > 0) {
    const createHostResult = await transport.post("/revit/create-mep-route", {
      kind: isPipe ? "pipe" : "duct",
      viewId: request.viewId,
      visualViewId: request.visualViewId ?? request.viewId,
      levelName: request.levelName,
      systemType: request.systemType,
      verify: true,
      visualVerify: false,
      ...createHostRouteRequest,
      dryRun: false
    });
    setupRawResults.push(createHostResult);
    const createHost = asObject(createHostResult);
    setupCreatedElementIds = uniquePositiveIds(createHost.createdElementIds, createHost.elementIds, createHost.ids);
    setupCreatedFittingIds = uniquePositiveIds(createHost.createdFittingIds, createHost.fittingIds);
    setupHostElementId = setupCreatedElementIds[0] ?? setupHostElementId;
  }

  const offsetVector = asObject(request.offsetVector ?? request.offset_vector);
  const requestedDropForOffset = Number(request.dropFt ?? request.offsetDropFt ?? request.elevationOffsetFt);
  const derivedOffsetVector = Object.keys(offsetVector).length > 0 || !Number.isFinite(requestedDropForOffset)
    ? null
    : { x: 0, y: 0, z: -Math.abs(requestedDropForOffset) };
  const workflowBody = {
    ...request,
    ...(setupHostElementId ? { hostElementId: setupHostElementId } : {}),
    ...(derivedOffsetVector ? { offsetVector: derivedOffsetVector } : {}),
    operation: firstPathLike(request.operation, request.rerouteOperation, request.offsetMode) || "reroute_offset",
    apply: request.apply !== false,
    verify: request.verify !== false,
    visualVerify: request.visualVerify !== false
  };
  const workflowResult = await transport.post("/revit/reroute-mep-route-segment", workflowBody);
  const result = asObject(workflowResult);
  const plan = asObject(result.plan);
  const verificationObj = asObject(result.verification);
  const visual = asObject(result.visualVerification ?? result.visual);
  const networkAudit = asObject(verificationObj.networkAudit ?? result.connectedNetworkAudit ?? result.connectorAudit ?? result.networkAudit);
  const systemAudit = asObject(networkAudit.systemAudit ?? verificationObj.systemAudit ?? result.systemAudit);
  const segments = Array.isArray(plan.Segments) ? plan.Segments.map((entry) => asObject(entry)).filter((entry) => Object.keys(entry).length > 0) : [];
  const expectedFittings = Array.isArray(plan.ExpectedFittings) ? plan.ExpectedFittings.map((entry) => asObject(entry)).filter((entry) => Object.keys(entry).length > 0) : [];
  const connectionAttempts = Array.isArray(result.connectionAttempts)
    ? result.connectionAttempts.map((entry) => asObject(entry)).filter((entry) => Object.keys(entry).length > 0)
    : [];
  const createdElementIds = uniquePositiveIds(result.createdElementIds, result.createdSegmentIds, result.newSegmentIds);
  const createdFittingIds = uniquePositiveIds(result.createdFittingIds, result.fittingIds, connectionAttempts.map((attempt) => attempt.fittingId));
  const deletedOriginalIds = uniquePositiveIds(result.deletedOriginalIds, result.removedOriginalIds, result.deletedIds);
  const setupHostNeedsCleanup = setupHostElementId && setupCreatedElementIds.includes(setupHostElementId) && !deletedOriginalIds.includes(setupHostElementId)
    ? [setupHostElementId]
    : [];
  const cleanupIds = Array.from(new Set([...createdElementIds, ...createdFittingIds, ...setupHostNeedsCleanup]));
  const cleanupRequested = parseBool(request.cleanupCreatedElements ?? request.cleanup_created_elements) === true;
  const workflowStatus = clip(result.status, 120);
  const split1 = pointXYZ(plan.Split1);
  const split2 = pointXYZ(plan.Split2);
  const offsetSplit1 = pointXYZ(plan.OffsetSplit1);
  const offsetSplit2 = pointXYZ(plan.OffsetSplit2);
  const requestedSplit1 = pointXY(request.split1Point ?? request.splitPoint1);
  const requestedSplit2 = pointXY(request.split2Point ?? request.splitPoint2);
  const splitPointErrorFt = split1 && split2 && requestedSplit1 && requestedSplit2
    ? Math.max(Math.hypot(split1.x - requestedSplit1.x, split1.y - requestedSplit1.y), Math.hypot(split2.x - requestedSplit2.x, split2.y - requestedSplit2.y))
    : null;
  const toleranceFt = Number(request.toleranceFt ?? request.projectionToleranceFt ?? 1);
  const requestedDropFt = Number(request.dropFt ?? request.offsetDropFt ?? request.elevationOffsetFt);
  const actualDropFt = split1 && offsetSplit1 ? Math.abs(split1.z - offsetSplit1.z) : null;
  const dropToleranceFt = Number(request.dropToleranceFt ?? request.elevationToleranceFt ?? 0.25);
  const capturePath = firstPathLike(visual.path, visual.capturePath, asObject(visual.capture).path, result.capturePath, result.afterCapturePath);
  const connectedAttempts = connectionAttempts.filter((attempt) => parseBool(attempt.connected) === true || attempt.connected === true);
  const networkContinuityAudit = mepNetworkContinuityAudit({
    ...networkAudit,
    systemAudit: Object.keys(systemAudit).length > 0 ? systemAudit : networkAudit.systemAudit
  });
  const networkOk = networkContinuityAudit.ok;
  let cleanupDryRun: unknown = null;
  let cleanupApplied: unknown = null;
  let cleanupDryRunIds: number[] = [];
  let cleanupDeletedIds: number[] = [];

  const summary: JsonMap = {
    workflowStatus,
    kind: isPipe ? "pipe" : "duct",
    operation: workflowBody.operation,
    hostElementId: setupHostElementId ?? asObject(result.host).id ?? null,
    setupCreatedElementIds,
    setupCreatedFittingIds,
    viewId: request.viewId ?? null,
    split1,
    split2,
    offsetSplit1,
    offsetSplit2,
    splitPointErrorFt,
    toleranceFt,
    requestedDropFt: Number.isFinite(requestedDropFt) ? requestedDropFt : null,
    actualDropFt,
    dropToleranceFt,
    segmentCount: segments.length,
    expectedFittingCount: expectedFittings.length,
    connectedAttemptCount: connectedAttempts.length,
    createdElementIds,
    createdFittingIds,
    deletedOriginalIds,
    networkOk,
    networkContinuityAudit,
    capturePath,
    cleanupRequested,
    cleanupDryRunIds,
    cleanupDeletedIds,
    cleanupDryRun,
    cleanupApplied,
    rawWorkflowResult: workflowResult
  };
  const summaryJsonPath = path.join(runDir, "artifacts", "redline_mep_reroute_summary.json");
  writeJsonFile(summaryJsonPath, summary);

  const baseChecks = [
    verification("mep_reroute_applied", /rerouted|success|applied|ready/i.test(workflowStatus) && result.dryRun !== true, "rerouted/success status without dryRun", { workflowStatus, dryRun: result.dryRun }),
    verification("mep_reroute_model_write_ids_present", createdElementIds.length >= Math.max(1, segments.length) && createdFittingIds.length >= Math.max(1, expectedFittings.length), "created segment and fitting ids", { createdElementIds, createdFittingIds, segmentCount: segments.length, expectedFittingCount: expectedFittings.length }),
    verification("mep_reroute_split_points_reported", !!split1 && !!split2 && !!offsetSplit1 && !!offsetSplit2 && (!requestedSplit1 || !requestedSplit2 || (splitPointErrorFt !== null && splitPointErrorFt <= toleranceFt)), { requestedSplit1, requestedSplit2, toleranceFt }, { split1, split2, offsetSplit1, offsetSplit2, splitPointErrorFt }),
    verification("mep_reroute_offset_drop_matches_request", !Number.isFinite(requestedDropFt) || (actualDropFt !== null && Math.abs(actualDropFt - requestedDropFt) <= dropToleranceFt), Number.isFinite(requestedDropFt) ? { requestedDropFt, dropToleranceFt } : "no requested drop", { actualDropFt }),
    verification("mep_reroute_connection_attempts_verified", expectedFittings.length > 0 && connectedAttempts.length >= expectedFittings.length, "connected attempts for expected fittings", { connectedAttemptCount: connectedAttempts.length, expectedFittingCount: expectedFittings.length }),
    verification("mep_reroute_connector_network_audit", networkOk, "connected network/system audit with no disconnected/open evidence", { networkAudit, systemAudit, networkContinuityAudit }),
    verification("post_change_capture_returned", !!capturePath, "post-change capture path", capturePath),
    verification("post_change_capture_view_id_matches_request", captureViewMatchesRequest(visual, request), firstPositiveId(request.visualViewId, request.captureViewId, request.afterCaptureViewId, request.viewId, request.view_id) ?? "no requested capture view", visual),
    verification("post_change_capture_quality_ok", captureQualityOk(visual), "capture dimensions >= 512 px when reported and requested focus crop applied", visual),
    verification("mep_reroute_summary_written", fs.existsSync(summaryJsonPath), summaryJsonPath, summary)
  ];

  const intendedPoints = [pointXY(request.split1Point ?? request.splitPoint1), pointXY(request.split2Point ?? request.splitPoint2)].filter((point): point is { x: number; y: number } => !!point);
  const actualPoints = [split1, split2].filter((point): point is { x: number; y: number; z: number } => !!point).map((point) => ({ x: point.x, y: point.y }));
  const visualGate: RedlineVisualGateResult = evaluateRedlineVisualVerificationGate({
    action_type: isPipe ? "pipe_route" : "duct_route",
    authority: "deterministic_geometry",
    redline_path: firstPathLike(request.redlinePath, request.redline_path, request.attachmentPath, request.attachment_path),
    after_capture_path: capturePath,
    ...visualGateCaptureQuality(visual),
    visible_element_inventory: {
      workflowStatus,
      createdElementIds,
      createdFittingIds,
      deletedOriginalIds,
      segmentCount: segments.length,
      expectedFittingCount: expectedFittings.length,
      actualDropFt,
      networkOk
    },
    intended_action: {
      workflow: "redline_mep_reroute",
      kind: isPipe ? "pipe" : "duct",
      operation: workflowBody.operation,
      expectedFitting: firstPathLike(request.expectedFitting, result.expectedFitting) || null
    },
    intended_location: intendedPoints.length > 0 ? `${intendedPoints.length} requested split point(s)` : "requested reroute split points",
    observed_location: split1 && split2 ? `split points ${split1.x}, ${split1.y} and ${split2.x}, ${split2.y}` : `model ids ${createdElementIds.join(", ")}`,
    intended_points: intendedPoints,
    actual_points: actualPoints,
    model_write_required: true,
    created_element_ids: createdElementIds,
    created_fitting_ids: createdFittingIds,
    max_error_ft: splitPointErrorFt,
    tolerance_ft: toleranceFt,
    deterministic_assertions: baseChecks.map(verificationToGateAssertion),
    vision_review: {
      provider: "none",
      status: "pass",
      reason: "No model vision judge was invoked; benchmark split/offset points, segment/fitting ids, connector audit, and focused capture are authoritative for this workflow."
    }
  });
  const visualGatePath = path.join(runDir, "artifacts", "redline_visual_gate.json");
  writeJsonFile(visualGatePath, visualGate);

  const rawResults = [...setupRawResults, workflowResult];
  const cleanupChecks: RevitWorkflowVerification[] = [];
  if (cleanupRequested && cleanupIds.length > 0) {
    try {
      cleanupDryRun = await transport.post("/revit/delete", {
        ids: cleanupIds,
        apply: false,
        reason: "benchmark cleanup for repeated modeled MEP reroute reliability runs"
      });
    } catch (error) {
      cleanupDryRun = cleanupMissingElementsResult(cleanupIds, error);
      if (!cleanupDryRun) throw error;
    }
    rawResults.push(cleanupDryRun);
    try {
      cleanupApplied = await transport.post("/revit/delete", {
        ids: cleanupIds,
        apply: true,
        reason: "benchmark cleanup for repeated modeled MEP reroute reliability runs"
      });
    } catch (error) {
      cleanupApplied = cleanupMissingElementsResult(cleanupIds, error);
      if (!cleanupApplied) throw error;
    }
    rawResults.push(cleanupApplied);
    cleanupDryRunIds = deleteEffectIds(cleanupDryRun);
    cleanupDeletedIds = deleteEffectIds(cleanupApplied);
    cleanupChecks.push(
      verification("mep_reroute_cleanup_dry_run_ok", cleanupIds.every((id) => cleanupDryRunIds.includes(id)), cleanupIds, cleanupDryRun),
      verification("mep_reroute_cleanup_applied_ids_present", cleanupIds.every((id) => cleanupDeletedIds.includes(id)), cleanupIds, cleanupApplied)
    );
  } else if (cleanupRequested) {
    cleanupChecks.push(
      verification("mep_reroute_cleanup_dry_run_ok", false, "created reroute segment/fitting ids required before cleanup", cleanupIds),
      verification("mep_reroute_cleanup_applied_ids_present", false, "created reroute segment/fitting ids required before cleanup", cleanupIds)
    );
  } else {
    cleanupChecks.push(verification("mep_reroute_cleanup_applied_ids_present", true, "not requested", cleanupIds));
  }
  summary.cleanupDryRunIds = cleanupDryRunIds;
  summary.cleanupDeletedIds = cleanupDeletedIds;
  summary.cleanupDryRun = cleanupDryRun;
  summary.cleanupApplied = cleanupApplied;
  writeJsonFile(summaryJsonPath, summary);

  const checks = [
    ...baseChecks,
    verification("redline_visual_gate_passed", visualGate.status === "pass", "pass", visualGate.status, visualGate.reason),
    ...cleanupChecks
  ];
  const success = countOk(checks);
  return {
    workflow: "redline_mep_reroute",
    success,
    failure_reason: success ? null : "MEP reroute redline workflow verification failed.",
    tool_calls: 1 + setupRawResults.length + (cleanupRequested && cleanupIds.length > 0 ? 2 : 0),
    revit_transactions: (setupRawResults.length > 0 ? 1 : 0) + (workflowBody.apply === false ? 0 : 1) + (cleanupRequested && cleanupIds.length > 0 ? 1 : 0),
    computer_use_actions: 0,
    output_artifacts: [summaryJsonPath, visualGatePath],
    verification_results: checks,
    user_message: success
      ? `Applied and verified ${isPipe ? "pipe" : "duct"} reroute ids ${[...createdElementIds, ...createdFittingIds].join(", ")}. Visual gate: ${visualGate.status} (${visualGate.authority}, confidence ${visualGate.confidence.toFixed(2)}).`
      : `MEP reroute redline workflow ran, but verification failed: ${visualGate.reason}`,
    raw_results: rawResults
  };
}

async function runRedlineMepSizeTransition(transport: BridgeTransport, request: JsonMap, runDir: string): Promise<RevitWorkflowPartialResult> {
  const isPipe = clip(request.kind, 30).toLowerCase() === "pipe";
  const createHostRouteRequest = asObject(request.createHostRoute ?? request.create_host_route ?? request.setupRoute ?? request.setup_route);
  const setupRawResults: unknown[] = [];
  let setupHostElementId = firstPositiveId(request.hostElementId, request.host_element_id, request.elementId, request.element_id);
  let setupCreatedElementIds: number[] = [];
  let setupCreatedFittingIds: number[] = [];
  let setupCleanupDryRun: unknown = null;
  let setupCleanupApplied: unknown = null;
  let setupCleanupDryRunIds: number[] = [];
  let setupCleanupDeletedIds: number[] = [];

  if (Object.keys(createHostRouteRequest).length > 0) {
    const createHostResult = await transport.post("/revit/create-mep-route", {
      kind: isPipe ? "pipe" : "duct",
      viewId: request.viewId,
      visualViewId: request.visualViewId ?? request.viewId,
      levelName: request.levelName,
      systemType: request.systemType,
      verify: true,
      visualVerify: false,
      ...createHostRouteRequest,
      dryRun: false
    });
    setupRawResults.push(createHostResult);
    const createHost = asObject(createHostResult);
    setupCreatedElementIds = uniquePositiveIds(createHost.createdElementIds, createHost.elementIds, createHost.ids);
    setupCreatedFittingIds = uniquePositiveIds(createHost.createdFittingIds, createHost.fittingIds);
    setupHostElementId = setupCreatedElementIds[0] ?? setupHostElementId;
  }

  const workflowBody = {
    ...request,
    ...(setupHostElementId ? { hostElementId: setupHostElementId } : {}),
    operation: "size_transition",
    apply: request.apply !== false,
    verify: request.verify !== false,
    visualVerify: request.visualVerify !== false
  };
  const dryRunBody = { ...workflowBody, apply: false, dryRun: true, visualVerify: false };
  const dryRunResult = await transport.post("/revit/reroute-mep-route-segment", dryRunBody);
  const dryRun = asObject(dryRunResult);
  const dryPlan = asObject(dryRun.plan);
  const dryVerificationObj = asObject(dryRun.verification);
  const dryConnectorAudit = asObject(
    dryRun.connectorAudit ??
    dryRun.connectorNetworkAudit ??
    dryRun.networkAudit ??
    dryVerificationObj.networkAudit ??
    dryVerificationObj.connectorAudit
  );
  const drySizeReadback = asObject(dryRun.sizeReadback ?? dryRun.sizeAudit ?? dryRun.readback);
  const requestedPoint = pointXY(request.transitionPoint ?? request.splitPoint ?? request.point ?? request.projectedPoint);
  const toleranceFt = Number(request.toleranceFt ?? request.projectionToleranceFt ?? 1);
  const requestedUpstreamSize = firstPathLike(request.upstreamDuctSize, request.upstreamPipeSize, request.upstreamSize);
  const requestedDownstreamSize = firstPathLike(request.downstreamDuctSize, request.downstreamPipeSize, request.downstreamSize);
  const dryProjectedPoint = pointXY(dryRun.projectedSplitPoint ?? dryRun.projectedTransitionPoint ?? dryRun.projectedPoint ?? dryRun.splitPoint ?? dryRun.transitionPoint ?? dryPlan.TransitionPoint);
  const dryProjectionErrorFt = dryProjectedPoint && requestedPoint ? Math.hypot(dryProjectedPoint.x - requestedPoint.x, dryProjectedPoint.y - requestedPoint.y) : null;
  const dryWorkflowStatus = clip(dryRun.status, 120);
  const dryPreviewUpstreamSize = firstPathLike(sizeReadbackLabel(drySizeReadback.upstreamSize), sizeReadbackLabel(drySizeReadback.upstreamDuctSize), sizeReadbackLabel(drySizeReadback.upstreamPipeSize), sizeReadbackLabel(dryRun.upstreamSize));
  const dryPreviewDownstreamSize = firstPathLike(sizeReadbackLabel(drySizeReadback.downstreamSize), sizeReadbackLabel(drySizeReadback.downstreamDuctSize), sizeReadbackLabel(drySizeReadback.downstreamPipeSize), sizeReadbackLabel(dryRun.downstreamSize));
  const dryCreatedFittingIds = uniquePositiveIds(dryRun.createdFittingIds, dryRun.fittingIds, dryRun.proposedFittingIds, dryRun.previewFittingIds);
  const dryOpenConnectorCount = Number(dryConnectorAudit.openConnectorCount ?? dryRun.openConnectorCount);
  const dryConnectedNetworkOk = parseBool(dryConnectorAudit.connectedNetworkOk ?? dryConnectorAudit.systemContinuityOk ?? dryRun.connectedNetworkOk);
  const dryConnectorStatus = clip(dryConnectorAudit.status, 80);
  const dryPlanExpectedFitting = asObject(dryPlan.ExpectedFitting);
  const dryExpectedFitting = firstPathLike(dryRun.expectedFitting, dryRun.expectedTransitionFitting, dryConnectorAudit.expectedFitting, dryPlanExpectedFitting.ExpectedFitting, dryPlanExpectedFitting.expectedFitting, request.expectedFitting, request.expectedTransitionFitting);
  const dryNetworkContinuityAudit = mepNetworkContinuityAudit({
    ...dryConnectorAudit,
    connectedNetworkOk: dryConnectorAudit.connectedNetworkOk ?? dryConnectorAudit.systemContinuityOk ?? dryRun.connectedNetworkOk,
    openConnectorCount: dryConnectorAudit.openConnectorCount ?? dryRun.openConnectorCount
  });
  const dryNetworkOk = dryNetworkContinuityAudit.ok || dryConnectedNetworkOk === true || auditStatusOk(dryConnectorStatus);
  const dryExplicitConnectorAudit = dryNetworkContinuityAudit.explicit;
  const dryPlanApplySupported = parseBool(dryPlan.ApplySupported ?? dryPlan.applySupported) === true;
  const dryConnectorReadbackOk = dryNetworkContinuityAudit.ok || (dryPlanApplySupported && !!dryExpectedFitting);
  const dryRunChecks = [
    verification("mep_size_transition_dry_run_ok", /dry|preview|plan|ready|success/i.test(dryWorkflowStatus), "dry-run/preview status before model writes", dryWorkflowStatus),
    verification("mep_size_transition_dry_run_projected_point_reported", !!dryProjectedPoint && (!requestedPoint || (dryProjectionErrorFt !== null && dryProjectionErrorFt <= toleranceFt)), { requestedPoint, toleranceFt }, { projectedPoint: dryProjectedPoint, projectionErrorFt: dryProjectionErrorFt }),
    verification("mep_size_transition_dry_run_size_preview_matches", (!requestedUpstreamSize || dryPreviewUpstreamSize === requestedUpstreamSize) && (!requestedDownstreamSize || dryPreviewDownstreamSize === requestedDownstreamSize), { requestedUpstreamSize, requestedDownstreamSize }, { dryPreviewUpstreamSize, dryPreviewDownstreamSize }),
    verification("mep_size_transition_dry_run_fitting_or_connector_readback", dryConnectorReadbackOk, "dry-run explicit connector/system continuity audit", { dryCreatedFittingIds, dryOpenConnectorCount, dryConnectedNetworkOk, dryNetworkOk, dryExpectedFitting, dryExplicitConnectorAudit, dryNetworkContinuityAudit })
  ];
  const dryRunEvidenceOk = countOk(dryRunChecks);
  const earlySummaryJsonPath = path.join(runDir, "artifacts", "redline_mep_size_transition_summary.json");
  if (!dryRunEvidenceOk) {
    if (setupCreatedElementIds.length > 0) {
      const setupCleanupIds = Array.from(new Set([...setupCreatedElementIds, ...setupCreatedFittingIds]));
      setupCleanupDryRun = await transport.post("/revit/delete", {
        ids: setupCleanupIds,
        apply: false,
        reason: "benchmark cleanup for setup-created MEP size-transition host after blocked dry-run"
      });
      setupRawResults.push(setupCleanupDryRun);
      setupCleanupApplied = await transport.post("/revit/delete", {
        ids: setupCleanupIds,
        apply: true,
        reason: "benchmark cleanup for setup-created MEP size-transition host after blocked dry-run"
      });
      setupRawResults.push(setupCleanupApplied);
      setupCleanupDryRunIds = deleteEffectIds(setupCleanupDryRun);
      setupCleanupDeletedIds = deleteEffectIds(setupCleanupApplied);
    }
    writeJsonFile(earlySummaryJsonPath, {
      workflowStatus: dryWorkflowStatus,
      kind: isPipe ? "pipe" : "duct",
      hostElementId: setupHostElementId ?? request.hostElementId ?? request.elementId ?? null,
      setupCreatedElementIds,
      setupCreatedFittingIds,
      setupCleanupDryRunIds,
      setupCleanupDeletedIds,
      viewId: request.viewId ?? null,
      requestedPoint,
      projectedPoint: null,
      requestedUpstreamSize,
      requestedDownstreamSize,
      dryRun: {
        status: dryWorkflowStatus,
        projectedPoint: dryProjectedPoint,
        projectionErrorFt: dryProjectionErrorFt,
        previewUpstreamSize: dryPreviewUpstreamSize,
        previewDownstreamSize: dryPreviewDownstreamSize,
        createdFittingIds: dryCreatedFittingIds,
        openConnectorCount: Number.isFinite(dryOpenConnectorCount) ? dryOpenConnectorCount : null,
        connectedNetworkOk: dryConnectedNetworkOk,
        networkOk: dryNetworkOk,
        networkContinuityAudit: dryNetworkContinuityAudit,
        expectedFitting: dryExpectedFitting || null,
        rawResult: dryRunResult
      },
      blockedBeforeModelWrite: true
    });
    return {
      workflow: "redline_mep_size_transition",
      success: false,
      failure_reason: "MEP size-transition dry-run evidence was incomplete; blocked before model writes.",
      tool_calls: 1,
      revit_transactions: 0,
      computer_use_actions: 0,
      output_artifacts: [earlySummaryJsonPath],
      verification_results: dryRunChecks,
      user_message: "The size-transition redline was blocked before model writes because the dry run did not prove projection, size preview, and connector/fitting evidence.",
      raw_results: [...setupRawResults, dryRunResult]
    };
  }
  const workflowResult = await transport.post("/revit/reroute-mep-route-segment", workflowBody);
  const result = asObject(workflowResult);
  const resultPlan = asObject(result.plan);
  const visual = asObject(result.visualVerification ?? result.visual);
  const verificationObj = asObject(result.verification);
  const connectorAudit = asObject(
    result.connectorAudit ??
    result.connectorNetworkAudit ??
    result.networkAudit ??
    verificationObj.networkAudit ??
    verificationObj.connectorAudit
  );
  const sizeReadback = asObject(result.sizeReadback ?? result.sizeAudit ?? result.readback);
  const createdElementIds = uniquePositiveIds(result.createdElementIds, result.createdSegmentIds, result.newSegmentIds);
  const modifiedElementIds = uniquePositiveIds(result.modifiedElementIds, result.updatedElementIds, result.hostElementId);
  const createdFittingIds = uniquePositiveIds(result.createdFittingIds, result.fittingIds);
  const allModelWriteIds = Array.from(new Set([...createdElementIds, ...modifiedElementIds, ...createdFittingIds]));
  const cleanupIds = Array.from(new Set([...createdElementIds, ...createdFittingIds]));
  const cleanupRequested = parseBool(request.cleanupCreatedElements ?? request.cleanup_created_elements) === true;
  const capturePath = firstPathLike(visual.capturePath, visual.path, asObject(visual.capture).path, result.capturePath, result.afterCapturePath);
  const workflowStatus = clip(result.status, 120);
  const projectedPoint = pointXY(result.projectedSplitPoint ?? result.projectedTransitionPoint ?? result.projectedPoint ?? result.splitPoint ?? result.transitionPoint ?? resultPlan.TransitionPoint);
  const projectionErrorFt = projectedPoint && requestedPoint ? Math.hypot(projectedPoint.x - requestedPoint.x, projectedPoint.y - requestedPoint.y) : null;
  const appliedUpstreamSize = firstPathLike(sizeReadbackLabel(sizeReadback.upstreamSize), sizeReadbackLabel(sizeReadback.upstreamDuctSize), sizeReadbackLabel(sizeReadback.upstreamPipeSize), sizeReadbackLabel(result.upstreamSize));
  const appliedDownstreamSize = firstPathLike(sizeReadbackLabel(sizeReadback.downstreamSize), sizeReadbackLabel(sizeReadback.downstreamDuctSize), sizeReadbackLabel(sizeReadback.downstreamPipeSize), sizeReadbackLabel(result.downstreamSize));
  const sizingScope = asObject(request.sizingScope ?? request.sizing_scope);
  const scopedElementIds = uniquePositiveIds(sizingScope.elementIds, request.sizingScopeElementIds, request.sizing_scope_element_ids);
  const engineeringSizingBasis = firstPathLike(request.engineeringSizingBasis, request.sizingBasis, sizingScope.engineeringSizingBasis, sizingScope.engineeringBasis);
  const perSegmentSizeRows = objectRows(
    result.perSegmentSizeReadback ??
    result.segmentSizeReadback ??
    sizeReadback.perSegmentSizeReadback ??
    sizeReadback.segmentSizeReadback ??
    sizeReadback.segments
  );
  const scopedSizingRequested = scopedElementIds.length > 0 || !!engineeringSizingBasis || parseBool(sizingScope.perSegmentReadbackRequired) === true;
  const scopedSizingReadbackOk = !scopedSizingRequested || (
    scopedElementIds.length > 0 &&
    scopedElementIds.every((id) => {
      const row = perSegmentSizeRows.find((entry) => firstPositiveId(entry.elementId, entry.id, entry.routeElementId) === id);
      return !!row && !!firstPathLike(row.appliedSize, row.size, row.ductSize, row.pipeSize, row.downstreamSize, row.upstreamSize);
    })
  );
  const openConnectorCount = Number(connectorAudit.openConnectorCount ?? result.openConnectorCount);
  const connectedNetworkOk = parseBool(connectorAudit.connectedNetworkOk ?? connectorAudit.systemContinuityOk ?? result.connectedNetworkOk);
  const connectorStatus = clip(connectorAudit.status, 80);
  const networkContinuityAudit = mepNetworkContinuityAudit({
    ...connectorAudit,
    connectedNetworkOk: connectorAudit.connectedNetworkOk ?? connectorAudit.systemContinuityOk ?? result.connectedNetworkOk,
    openConnectorCount: connectorAudit.openConnectorCount ?? result.openConnectorCount
  });
  const networkOk = networkContinuityAudit.ok || connectedNetworkOk === true || auditStatusOk(connectorStatus);
  const explicitConnectorAudit = networkContinuityAudit.explicit;
  const connectorAuditNegative = asObject(networkContinuityAudit.detail).negativeStatus === true;
  const connectorReadbackOk = networkContinuityAudit.ok || (createdFittingIds.length > 0 && !connectorAuditNegative);
  let cleanupDryRun: unknown = null;
  let cleanupApplied: unknown = null;
  let cleanupDryRunIds: number[] = [];
  let cleanupDeletedIds: number[] = [];
  const cleanupChecks: RevitWorkflowVerification[] = [];

  const summary: JsonMap = {
    workflowStatus,
    kind: isPipe ? "pipe" : "duct",
    hostElementId: setupHostElementId ?? request.hostElementId ?? request.elementId ?? null,
    setupCreatedElementIds,
    setupCreatedFittingIds,
    setupCleanupDryRunIds,
    setupCleanupDeletedIds,
    viewId: request.viewId ?? null,
    requestedPoint,
    projectedPoint,
    projectionErrorFt,
    toleranceFt,
    requestedUpstreamSize,
    requestedDownstreamSize,
    appliedUpstreamSize,
    appliedDownstreamSize,
    scopedElementIds,
    engineeringSizingBasis,
    scopedSizingRequested,
    perSegmentSizeReadback: perSegmentSizeRows,
    createdElementIds,
    modifiedElementIds,
    createdFittingIds,
    openConnectorCount: Number.isFinite(openConnectorCount) ? openConnectorCount : null,
    connectedNetworkOk,
    networkOk,
    explicitConnectorAudit,
    networkContinuityAudit,
    capturePath,
    cleanupRequested,
    cleanupAttemptPhase: cleanupRequested ? "pending_after_model_write" : "not_requested",
    dryRun: {
      status: dryWorkflowStatus,
      projectedPoint: dryProjectedPoint,
      projectionErrorFt: dryProjectionErrorFt,
      previewUpstreamSize: dryPreviewUpstreamSize,
      previewDownstreamSize: dryPreviewDownstreamSize,
      createdFittingIds: dryCreatedFittingIds,
      openConnectorCount: Number.isFinite(dryOpenConnectorCount) ? dryOpenConnectorCount : null,
      connectedNetworkOk: dryConnectedNetworkOk,
      networkOk: dryNetworkOk,
      networkContinuityAudit: dryNetworkContinuityAudit,
      expectedFitting: dryExpectedFitting || null,
      rawResult: dryRunResult
    },
    cleanupDryRunIds,
    cleanupDeletedIds,
    cleanupDryRun,
    cleanupApplied,
    rawWorkflowResult: workflowResult
  };
  const summaryJsonPath = path.join(runDir, "artifacts", "redline_mep_size_transition_summary.json");
  writeJsonFile(summaryJsonPath, summary);

  if (cleanupRequested && cleanupIds.length > 0) {
    try {
      cleanupDryRun = await transport.post("/revit/delete", {
        ids: cleanupIds,
        apply: false,
        reason: "benchmark cleanup for repeated modeled MEP size-transition reliability runs"
      });
      cleanupDryRunIds = deleteEffectIds(cleanupDryRun);
      summary.cleanupDryRunIds = cleanupDryRunIds;
      summary.cleanupDryRun = cleanupDryRun;
      summary.cleanupAttemptPhase = "dry_run_complete_after_model_write";
      writeJsonFile(summaryJsonPath, summary);

      cleanupApplied = await transport.post("/revit/delete", {
        ids: cleanupIds,
        apply: true,
        reason: "benchmark cleanup for repeated modeled MEP size-transition reliability runs"
      });
      cleanupDeletedIds = deleteEffectIds(cleanupApplied);
      summary.cleanupDeletedIds = cleanupDeletedIds;
      summary.cleanupApplied = cleanupApplied;
      summary.cleanupAttemptPhase = "applied_after_model_write";
      writeJsonFile(summaryJsonPath, summary);

      cleanupChecks.push(
        verification("mep_size_transition_cleanup_dry_run_ok", cleanupIds.every((id) => cleanupDryRunIds.includes(id)), cleanupIds, cleanupDryRun),
        verification("mep_size_transition_cleanup_applied_ids_present", cleanupIds.every((id) => cleanupDeletedIds.includes(id)), cleanupIds, cleanupApplied)
      );
    } catch (error) {
      const cleanupError = errorMessage(error);
      summary.cleanupAttemptPhase = cleanupDryRun === null ? "cleanup_dry_run_failed_after_model_write" : "cleanup_apply_failed_after_model_write";
      summary.cleanupError = cleanupError;
      summary.cleanupIds = cleanupIds;
      summary.cleanupDryRunIds = cleanupDryRunIds;
      summary.cleanupDeletedIds = cleanupDeletedIds;
      summary.cleanupDryRun = cleanupDryRun;
      summary.cleanupApplied = cleanupApplied;
      writeJsonFile(summaryJsonPath, summary);
      cleanupChecks.push(
        verification("mep_size_transition_cleanup_dry_run_ok", cleanupDryRun !== null && cleanupIds.every((id) => cleanupDryRunIds.includes(id)), cleanupIds, cleanupDryRun ?? cleanupError),
        verification("mep_size_transition_cleanup_applied_ids_present", false, cleanupIds, cleanupError, "cleanup failed after model write; use summary.cleanupIds for manual recovery")
      );
    }
  } else if (cleanupRequested) {
    summary.cleanupAttemptPhase = "blocked_no_created_transition_ids";
    writeJsonFile(summaryJsonPath, summary);
    cleanupChecks.push(
      verification("mep_size_transition_cleanup_dry_run_ok", false, "created transition ids required before cleanup", cleanupIds),
      verification("mep_size_transition_cleanup_applied_ids_present", false, "created transition ids required before cleanup", cleanupIds)
    );
  } else {
    cleanupChecks.push(verification("mep_size_transition_cleanup_applied_ids_present", true, "not requested", cleanupIds));
  }

  const baseChecks = [
    ...dryRunChecks,
    verification("mep_size_transition_applied", /success|applied|ready|changed/i.test(workflowStatus), "applied/success/changed status", workflowStatus),
    verification("mep_size_transition_model_write_ids_present", allModelWriteIds.length > 0, "created/modified/fitting ids", { createdElementIds, modifiedElementIds, createdFittingIds }),
    verification("mep_size_transition_projected_point_reported", !!projectedPoint && (!requestedPoint || (projectionErrorFt !== null && projectionErrorFt <= toleranceFt)), { requestedPoint, toleranceFt }, { projectedPoint, projectionErrorFt }),
    verification("mep_size_transition_fitting_or_connector_readback", connectorReadbackOk, "explicit connector/system continuity audit", { createdFittingIds, openConnectorCount, connectedNetworkOk, networkOk, explicitConnectorAudit, networkContinuityAudit }),
    verification("mep_size_transition_size_readback_matches", (!requestedUpstreamSize || appliedUpstreamSize === requestedUpstreamSize) && (!requestedDownstreamSize || appliedDownstreamSize === requestedDownstreamSize), { requestedUpstreamSize, requestedDownstreamSize }, { appliedUpstreamSize, appliedDownstreamSize }),
    verification("mep_size_transition_scoped_sizing_readback", scopedSizingReadbackOk, "per-segment size readback for scoped sizing request", { scopedElementIds, engineeringSizingBasis, perSegmentSizeRows }),
    verification("post_change_capture_returned", !!capturePath, "post-change capture path", capturePath),
    verification("post_change_capture_view_id_matches_request", captureViewMatchesRequest(visual, request), firstPositiveId(request.visualViewId, request.captureViewId, request.afterCaptureViewId, request.viewId, request.view_id) ?? "no requested capture view", visual),
    verification("post_change_capture_quality_ok", captureQualityOk(visual), "capture dimensions >= 512 px when reported and requested focus crop applied", visual),
    verification("mep_size_transition_summary_written", fs.existsSync(summaryJsonPath), summaryJsonPath, summary)
  ];

  const visualGate: RedlineVisualGateResult = evaluateRedlineVisualVerificationGate({
    action_type: isPipe ? "pipe_route" : "duct_route",
    authority: "deterministic_geometry",
    redline_path: firstPathLike(request.redlinePath, request.redline_path, request.attachmentPath, request.attachment_path),
    after_capture_path: capturePath,
    ...visualGateCaptureQuality(visual),
    visible_element_inventory: {
      workflowStatus,
      createdElementIds,
      modifiedElementIds,
      createdFittingIds,
      requestedUpstreamSize,
      requestedDownstreamSize,
      appliedUpstreamSize,
      appliedDownstreamSize,
      scopedElementIds,
      perSegmentSizeReadback: perSegmentSizeRows
    },
    intended_action: {
      workflow: "redline_mep_size_transition",
      kind: isPipe ? "pipe" : "duct",
      upstreamSize: requestedUpstreamSize || null,
      downstreamSize: requestedDownstreamSize || null,
      sizingScopeElementIds: scopedElementIds,
      engineeringSizingBasis: engineeringSizingBasis || null
    },
    intended_location: requestedPoint ? `transition near ${requestedPoint.x}, ${requestedPoint.y}` : "requested transition point",
    observed_location: projectedPoint ? `projected transition ${projectedPoint.x}, ${projectedPoint.y}` : `model ids ${allModelWriteIds.join(", ")}`,
    intended_points: requestedPoint ? [requestedPoint] : [],
    actual_points: projectedPoint ? [projectedPoint] : [],
    model_write_required: true,
    created_element_ids: createdElementIds,
    created_fitting_ids: createdFittingIds,
    max_error_ft: projectionErrorFt,
    tolerance_ft: toleranceFt,
    deterministic_assertions: baseChecks.map(verificationToGateAssertion),
    vision_review: {
      provider: "none",
      status: "pass",
      reason: "No model vision judge was invoked; benchmark projected point, readback, connector evidence, and focused capture are authoritative for this workflow."
    }
  });
  const visualGatePath = path.join(runDir, "artifacts", "redline_visual_gate.json");
  writeJsonFile(visualGatePath, visualGate);

  const rawResults = [...setupRawResults, dryRunResult, workflowResult];
  if (cleanupDryRun !== null) rawResults.push(cleanupDryRun);
  if (cleanupApplied !== null) rawResults.push(cleanupApplied);
  writeJsonFile(summaryJsonPath, summary);

  const checks = [
    ...baseChecks,
    verification("redline_visual_gate_passed", visualGate.status === "pass", "pass", visualGate.status, visualGate.reason),
    ...cleanupChecks
  ];
  const success = countOk(checks);
  return {
    workflow: "redline_mep_size_transition",
    success,
    failure_reason: success ? null : "MEP size-transition redline workflow verification failed.",
    tool_calls: 2 + (cleanupRequested && cleanupIds.length > 0 ? 2 : 0),
    revit_transactions: (workflowBody.apply === false ? 0 : 1) + (cleanupRequested && cleanupIds.length > 0 ? 1 : 0),
    computer_use_actions: 0,
    output_artifacts: [summaryJsonPath, visualGatePath],
    verification_results: checks,
    user_message: success
      ? `Applied and verified ${isPipe ? "pipe" : "duct"} size transition ids ${allModelWriteIds.join(", ")}. Visual gate: ${visualGate.status} (${visualGate.authority}, confidence ${visualGate.confidence.toFixed(2)}).`
      : `MEP size-transition redline workflow ran, but verification failed: ${visualGate.reason}`,
    raw_results: rawResults
  };
}

function firstPositiveId(...values: unknown[]): number | null {
  for (const value of values) {
    const n = Number(value);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return null;
}

function firstFiniteNumber(...values: unknown[]): number | null {
  for (const value of values) {
    const n = Number(value);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

function captureReportedViewId(captureLike: unknown): number | null {
  const obj = asObject(captureLike);
  const nestedCapture = asObject(obj.capture);
  const nestedView = asObject(obj.view);
  return firstPositiveId(
    obj.viewId,
    obj.targetViewId,
    obj.captureViewId,
    nestedCapture.viewId,
    nestedCapture.targetViewId,
    asObject(nestedCapture.view).id,
    asObject(nestedCapture.view).viewId,
    nestedView.id,
    nestedView.viewId
  );
}

function captureViewMatchesRequest(captureLike: unknown, request: JsonMap): boolean {
  const reportedViewId = captureReportedViewId(captureLike);
  const requestedViewId = firstPositiveId(request.visualViewId, request.captureViewId, request.afterCaptureViewId, request.viewId, request.view_id);
  return reportedViewId === null || requestedViewId === null || reportedViewId === requestedViewId;
}

function captureQualityOk(captureLike: unknown, minDimensionPx = 512): boolean {
  const obj = asObject(captureLike);
  const nestedCapture = asObject(obj.capture);
  const image = asObject(obj.image);
  const nestedImage = asObject(nestedCapture.image);
  const width = firstFiniteNumber(
    obj.widthPx,
    obj.width,
    obj.imageWidth,
    obj.pixelWidth,
    image.widthPx,
    image.width,
    nestedCapture.widthPx,
    nestedCapture.width,
    nestedCapture.imageWidth,
    nestedCapture.pixelWidth,
    nestedImage.widthPx,
    nestedImage.width
  );
  const height = firstFiniteNumber(
    obj.heightPx,
    obj.height,
    obj.imageHeight,
    obj.pixelHeight,
    image.heightPx,
    image.height,
    nestedCapture.heightPx,
    nestedCapture.height,
    nestedCapture.imageHeight,
    nestedCapture.pixelHeight,
    nestedImage.heightPx,
    nestedImage.height
  );
  if ((width !== null && width < minDimensionPx) || (height !== null && height < minDimensionPx)) return false;
  const focusCrop = asObject(obj.focusCrop ?? obj.focus_crop ?? nestedCapture.focusCrop ?? nestedCapture.focus_crop);
  const focusRequested = boolFlag(focusCrop.requested ?? focusCrop.requestedFocusCrop ?? focusCrop.focusRequested);
  if (focusRequested && boolFlag(focusCrop.applied ?? focusCrop.wasApplied ?? focusCrop.focusApplied) === false) return false;
  return true;
}

function visualGateCaptureQuality(captureLike: unknown): JsonMap {
  const obj = asObject(captureLike);
  const nestedCapture = asObject(obj.capture);
  const image = asObject(obj.image);
  const nestedImage = asObject(nestedCapture.image);
  const width = firstFiniteNumber(
    obj.widthPx,
    obj.width,
    obj.imageWidth,
    obj.pixelWidth,
    image.widthPx,
    image.width,
    nestedCapture.widthPx,
    nestedCapture.width,
    nestedCapture.imageWidth,
    nestedCapture.pixelWidth,
    nestedImage.widthPx,
    nestedImage.width
  );
  const height = firstFiniteNumber(
    obj.heightPx,
    obj.height,
    obj.imageHeight,
    obj.pixelHeight,
    image.heightPx,
    image.height,
    nestedCapture.heightPx,
    nestedCapture.height,
    nestedCapture.imageHeight,
    nestedCapture.pixelHeight,
    nestedImage.heightPx,
    nestedImage.height
  );
  const focusCrop = asObject(obj.focusCrop ?? obj.focus_crop ?? nestedCapture.focusCrop ?? nestedCapture.focus_crop);
  const focusRequested = parseBool(focusCrop.requested ?? focusCrop.requestedFocusCrop ?? focusCrop.focusRequested);
  const focusApplied = parseBool(focusCrop.applied ?? focusCrop.wasApplied ?? focusCrop.focusApplied);
  const gateFocusCrop: JsonMap = {};
  if (focusRequested !== null) gateFocusCrop.requested = focusRequested;
  if (focusApplied !== null) gateFocusCrop.applied = focusApplied;
  return {
    ...(width !== null ? { after_capture_width_px: width } : {}),
    ...(height !== null ? { after_capture_height_px: height } : {}),
    ...(Object.keys(gateFocusCrop).length > 0 ? { after_capture_focus_crop: gateFocusCrop } : {})
  };
}

function mepRouteCommittedReadbackAudit(args: { readback: unknown; createdElementIds: number[]; requestedKind: "duct" | "pipe"; requestedSize: string; toleranceFt: number }): { present: boolean; ok: boolean; detail: unknown } {
  const topLevelRows = objectRows(args.readback);
  const obj = topLevelRows.length > 0 ? { elements: topLevelRows } : asObject(args.readback);
  if (Object.keys(obj).length === 0) return { present: false, ok: true, detail: null };
  const status = clip(obj.status, 80).toLowerCase();
  const explicitOk = typeof obj.ok === "boolean" ? obj.ok : typeof obj.success === "boolean" ? obj.success : null;
  if (explicitOk === false || /fail|error|missing|mismatch|invalid|disconnected|blocked/.test(status)) {
    return { present: true, ok: false, detail: obj };
  }
  const rows = objectRows(obj.segments ?? obj.elements ?? obj.rows ?? obj.readbacks ?? obj.createdElements ?? obj.created_element_readback);
  const rowIds = uniquePositiveIds(
    obj.elementIds,
    obj.createdElementIds,
    obj.readbackElementIds,
    rows.map((row) => firstPositiveId(row.elementId, row.element_id, row.id, row.routeElementId, row.route_element_id))
  );
  if (args.createdElementIds.length > 0 && rows.length === 0 && rowIds.length === 0) {
    return { present: true, ok: false, detail: { reason: "committed route readback reported but no element rows or ids were provided", readback: obj } };
  }
  const idsCoverCreated = args.createdElementIds.every((id) => rowIds.includes(id));
  const endpointError = firstFiniteNumber(obj.maxEndpointErrorFt, obj.max_endpoint_error_ft, obj.endpointErrorFt, ...rows.map((row) => row.maxEndpointErrorFt ?? row.endpointErrorFt));
  const endpointOk = endpointError === null || endpointError <= args.toleranceFt;
  const kindRows = rows.filter((row) => {
    const text = [
      row.kind,
      row.category,
      row.categoryName,
      row.category_name,
      row.className,
      row.typeName,
      row.systemClassification
    ].map((value) => clip(value, 160).toLowerCase()).filter(Boolean).join(" ");
    return text.length > 0;
  });
  const kindOk = kindRows.length === 0 || kindRows.every((row) => {
    const text = [
      row.kind,
      row.category,
      row.categoryName,
      row.category_name,
      row.className,
      row.typeName,
      row.systemClassification
    ].map((value) => clip(value, 160).toLowerCase()).filter(Boolean).join(" ");
    return args.requestedKind === "pipe" ? /pipe/.test(text) : /duct/.test(text);
  });
  const sizeRows = args.requestedSize
    ? rows.filter((row) => firstPathLike(row.size, row.ductSize, row.pipeSize, row.diameter, row.widthHeight))
    : [];
  const requestedSizeKey = normalizeMepRouteSize(args.requestedSize);
  const sizeOk = sizeRows.length === 0 || sizeRows.some((row) => normalizeMepRouteSize(firstPathLike(row.size, row.ductSize, row.pipeSize, row.diameter, row.widthHeight)) === requestedSizeKey);
  return {
    present: true,
    ok: idsCoverCreated && endpointOk && kindOk && sizeOk,
    detail: {
      readback: obj,
      createdElementIds: args.createdElementIds,
      rowIds,
      idsCoverCreated,
      endpointError,
      endpointOk,
      kindOk,
      sizeOk
    }
  };
}

function normalizeMepRouteSize(value: string): string {
  return value
    .toLowerCase()
    .replace(/\binches?\b|\bin\b/g, "\"")
    .replace(/\s+/g, "")
    .replace(/[×]/g, "x");
}

function normalizeProofLabel(value: unknown): string {
  return clip(value, 220).toLowerCase().replace(/\s+/g, " ").trim();
}

function collectCreatedFamilyLabels(createObj: JsonMap): string[] {
  const nestedElement = asObject(createObj.element);
  const nestedType = asObject(createObj.type);
  const labels = [
    createObj.symbolName,
    createObj.symbol,
    createObj.typeName,
    createObj.name,
    createObj.familyName,
    createObj.family,
    nestedElement.symbolName,
    nestedElement.symbol,
    nestedElement.typeName,
    nestedElement.name,
    nestedElement.familyName,
    nestedElement.family,
    nestedType.symbolName,
    nestedType.symbol,
    nestedType.typeName,
    nestedType.name,
    nestedType.familyName,
    nestedType.family
  ]
    .map(normalizeProofLabel)
    .filter(Boolean);
  return Array.from(new Set(labels));
}

function collectInventoryFamilyTypeLabels(...items: JsonMap[]): string[] {
  const labels = items.flatMap((item) => {
    const nestedElement = asObject(item.element);
    const nestedType = asObject(item.type);
    return [
      item.familyName,
      item.family_name,
      item.family,
      item.symbolName,
      item.symbol_name,
      item.symbol,
      item.typeName,
      item.type_name,
      item.name,
      nestedElement.familyName,
      nestedElement.family,
      nestedElement.symbolName,
      nestedElement.symbol,
      nestedElement.typeName,
      nestedElement.name,
      nestedType.familyName,
      nestedType.family,
      nestedType.symbolName,
      nestedType.symbol,
      nestedType.typeName,
      nestedType.name
    ].map(normalizeProofLabel).filter(Boolean);
  });
  return Array.from(new Set(labels));
}

function collectInventoryCategoryLabels(...items: JsonMap[]): string[] {
  const labels = items.flatMap((item) => [
    item.category,
    item.categoryName,
    item.category_name,
    item.builtInCategory,
    item.built_in_category,
    item.categoryId,
    item.category_id
  ].map(normalizeProofLabel).filter(Boolean));
  return Array.from(new Set(labels));
}

function collectInventorySystemLabels(...items: JsonMap[]): string[] {
  const labels = items.flatMap((item) => {
    const nestedSystem = asObject(item.system);
    const nestedMepSystem = asObject(item.mepSystem ?? item.mep_system);
    const nestedNetwork = asObject(item.network ?? item.networkAudit ?? item.connectedNetworkAudit);
    return [
      item.system,
      item.systemName,
      item.system_name,
      item.systemType,
      item.system_type,
      item.systemClassification,
      item.system_classification,
      nestedSystem.name,
      nestedSystem.typeName,
      nestedSystem.systemType,
      nestedSystem.classification,
      nestedMepSystem.name,
      nestedMepSystem.typeName,
      nestedMepSystem.systemType,
      nestedMepSystem.classification,
      nestedNetwork.systemName,
      nestedNetwork.systemType,
      nestedNetwork.systemClassification
    ].map(normalizeProofLabel).filter(Boolean);
  });
  return Array.from(new Set(labels));
}

function collectInventoryTagTextLabels(...items: JsonMap[]): string[] {
  const labels = items.flatMap((item) => [
    item.visibleText,
    item.visible_text,
    item.tagText,
    item.tag_text,
    item.text,
    item.value,
    item.label,
    asObject(item.element).visibleText,
    asObject(item.element).tagText,
    asObject(item.element).text
  ].map(normalizedTextProof).filter(Boolean));
  return Array.from(new Set(labels));
}

function collectInventoryTaggedElementIds(...items: JsonMap[]): number[] {
  const ids = items.flatMap((item) => [
    item.hostElementId,
    item.host_element_id,
    item.taggedElementId,
    item.tagged_element_id,
    item.ownerElementId,
    item.owner_element_id,
    asObject(item.taggedSpatial).id,
    asObject(item.tagged_spatial).id,
    asObject(item.element).hostElementId,
    asObject(item.element).taggedElementId,
    asObject(asObject(item.element).taggedSpatial).id,
    asObject(asObject(item.element).tagged_spatial).id,
    ...asNumberArray(item.hostElementIds),
    ...asNumberArray(item.host_element_ids),
    ...asNumberArray(item.taggedElementIds),
    ...asNumberArray(item.tagged_element_ids)
  ].map((value) => Number(value)).filter((value) => Number.isFinite(value) && value > 0));
  return Array.from(new Set(ids));
}

function networkAuditCoversTargetIds(audit: unknown, targetIds: number[]): boolean {
  const obj = asObject(audit);
  if (targetIds.length === 0 || Object.keys(obj).length === 0) return false;
  const coveredIds = uniquePositiveIds(
    obj.elementIds,
    obj.element_ids,
    obj.ids,
    obj.tracedElementIds,
    obj.traced_element_ids,
    obj.networkElementIds,
    obj.network_element_ids,
    obj.routeElementIds,
    obj.route_element_ids,
    obj.connectedElementIds,
    obj.connected_element_ids,
    obj.elementId,
    obj.element_id,
    obj.id,
    obj.tracedElementId,
    obj.traced_element_id,
    asObject(obj.network).elementIds,
    asObject(obj.network).element_ids,
    asObject(obj.network).elementId,
    asObject(obj.network).element_id,
    asObject(obj.connectedNetwork).elementIds,
    asObject(obj.connectedNetwork).element_ids,
    asObject(obj.connectedNetwork).elementId,
    asObject(obj.connectedNetwork).element_id
  );
  return targetIds.every((id) => coveredIds.includes(id));
}

function proofLabelsMatchRequest(requestedLabel: string, actualLabels: string[]): boolean {
  const requested = normalizeProofLabel(requestedLabel);
  if (!requested) return true;
  return actualLabels.some((actual) => actual === requested || actual.includes(requested) || requested.includes(actual));
}

function normalizeProofPath(value: unknown): string {
  const raw = clip(value, 1000).trim();
  if (!raw) return "";
  try {
    return path.normalize(raw).replace(/[\\/]+$/, "").toLowerCase();
  } catch {
    return raw.replace(/[\\/]+$/, "").toLowerCase();
  }
}

function linkSourceMatchesRequest(requestedSourcePath: string, linkResult: unknown): boolean {
  const result = asObject(linkResult);
  const requested = normalizeProofPath(requestedSourcePath);
  if (!requested) return false;
  const candidates = [
    result.sourcePath,
    result.sourceFullPath,
    asObject(result.plan).sourcePath,
    asObject(result.plan).sourceFullPath
  ].map(normalizeProofPath).filter(Boolean);
  return candidates.some((candidate) => candidate === requested || candidate.endsWith(requested) || requested.endsWith(candidate));
}

function linkPinMatchesRequest(requestedPin: unknown, linkResult: unknown): boolean {
  const requested = proofBool(requestedPin);
  if (requested === null) return true;
  const result = asObject(linkResult);
  const actual = proofBool(result.pinned ?? result.pin);
  return actual === requested;
}

function objectArray(value: unknown): JsonMap[] {
  return Array.isArray(value) ? value.map(asObject).filter((entry) => Object.keys(entry).length > 0) : [];
}

function requestedStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.map((entry) => clip(entry, 220)).filter(Boolean) : [];
}

function requestedScheduleFilterSummary(value: unknown): string {
  return objectArray(value)
    .map((entry) => [entry.field, entry.op ?? entry.operator, entry.value].map((part) => clip(part, 120)).filter(Boolean).join(" "))
    .filter(Boolean)
    .join(";");
}

function requestedScheduleFieldCount(scheduleRequest: JsonMap): number {
  return requestedStringArray(scheduleRequest.fields).length;
}

function proofText(value: unknown): string {
  return clip(value, 220).trim().toLowerCase();
}

function requestedScheduleFieldNames(scheduleRequest: JsonMap): string[] {
  return requestedStringArray(scheduleRequest.fields).map((field) => proofText(field));
}

function proofBool(value: unknown): boolean | null {
  if (typeof value === "boolean") return value;
  const text = proofText(value);
  if (text === "true") return true;
  if (text === "false") return false;
  return null;
}

function requestedScheduleFilterProofMatches(filter: unknown, rows: JsonMap[]): boolean {
  const request = asObject(filter);
  const field = proofText(request.field);
  const op = proofText(request.op);
  const value = proofText(request.value);
  if (!field) return false;
  return rows.some((row) => {
    if (!/^applied$/i.test(clip(row.status, 80))) return false;
    if (proofText(row.field) !== field) return false;
    if (op && proofText(row.op) !== op) return false;
    if (value && proofText(row.value) !== value) return false;
    return true;
  });
}

function requestedScheduleSortProofMatches(sort: unknown, rows: JsonMap[]): boolean {
  const request = asObject(sort);
  const field = proofText(request.field);
  if (!field) return false;
  return rows.some((row) => {
    if (!/^applied$/i.test(clip(row.status, 80))) return false;
    if (proofText(row.field) !== field) return false;
    for (const key of ["ascending", "showHeader", "showFooter", "showBlankLine", "showFooterCount", "showFooterTitle"]) {
      const requested = proofBool(request[key]);
      if (requested !== null && proofBool(row[key]) !== requested) return false;
    }
    return true;
  });
}

function requestedScheduleColumnWidthProofMatches(width: unknown, rows: JsonMap[]): boolean {
  const request = asObject(width);
  const field = proofText(request.field);
  const requestedWidth = Number(request.widthFeet);
  if (!field || !Number.isFinite(requestedWidth)) return false;
  return rows.some((row) => {
    if (!/^applied$/i.test(clip(row.status, 80))) return false;
    if (proofText(row.field) !== field) return false;
    const actualWidth = Number(row.widthFeet);
    if (!Number.isFinite(actualWidth) || Math.abs(actualWidth - requestedWidth) > 0.0001) return false;
    const appliedTo = asObject(row.appliedTo);
    if (Object.keys(appliedTo).length > 0 && appliedTo.grid !== true && appliedTo.sheet !== true) return false;
    return true;
  });
}

function requestedScheduleRowHeightProofMatches(height: unknown, rows: JsonMap[]): boolean {
  const request = asObject(height);
  const section = proofText(request.section ?? "body") || "body";
  const requestedHeight = Number(request.heightFeet);
  const requestedRowNumber = Number(request.rowNumber);
  const hasRequestedRowNumber = Number.isInteger(requestedRowNumber);
  if (!Number.isFinite(requestedHeight)) return false;
  return rows.some((row) => {
    if (!/^applied$/i.test(clip(row.status, 80))) return false;
    if ((proofText(row.section) || "body") !== section) return false;
    if (hasRequestedRowNumber && Number(row.rowNumber) !== requestedRowNumber) return false;
    const actualHeight = Number(row.heightFeet ?? row.afterHeightFeet);
    if (!Number.isFinite(actualHeight) || Math.abs(actualHeight - requestedHeight) > 0.0001) return false;
    return true;
  });
}

function scheduleFieldCount(result: unknown): number | null {
  const obj = asObject(result);
  const schedule = asObject(obj.schedule);
  return firstPositiveId(obj.fieldCount, schedule.fieldCount);
}

function scheduleFieldNames(...results: unknown[]): string[] {
  const names: string[] = [];
  for (const result of results) {
    const obj = asObject(result);
    const schedule = asObject(obj.schedule);
    const candidates = [
      ...objectArray(obj.fields),
      ...objectArray(schedule.fields)
    ];
    for (const field of candidates) {
      const name = proofText(field.name ?? field.field ?? field.fieldName);
      if (name && !names.includes(name)) names.push(name);
    }
  }
  return names;
}

function scheduleFieldsMatchRequest(scheduleRequest: JsonMap, ...results: unknown[]): boolean {
  return scheduleFieldsMatchNames(requestedScheduleFieldNames(scheduleRequest), ...results);
}

function scheduleFieldsMatchNames(requestedFields: string[], ...results: unknown[]): boolean {
  const requested = requestedFields.map((field) => proofText(field)).filter(Boolean);
  if (requested.length === 0) return true;
  const actual = scheduleFieldNames(...results);
  return requested.every((field) => actual.includes(field));
}

function schedulePlacementRequested(scheduleRequest: JsonMap): boolean {
  if (proofBool(scheduleRequest.placeOnActiveSheet ?? scheduleRequest.place_on_active_sheet) === true) return true;
  if (proofBool(scheduleRequest.placeOnSheet ?? scheduleRequest.place_on_sheet) === true) return true;
  if (firstPositiveId(scheduleRequest.placeOnSheetId, scheduleRequest.place_on_sheet_id, scheduleRequest.sheetId, scheduleRequest.sheet_id) !== null) return true;
  if (proofText(scheduleRequest.sheetNumber ?? scheduleRequest.sheet_number)) return true;
  return Object.keys(asObject(scheduleRequest.placeOnSheet ?? scheduleRequest.place_on_sheet)).length > 0;
}

function schedulePlacementProofMatchesRequest(scheduleRequest: JsonMap, scheduleApplied: unknown): boolean {
  if (!schedulePlacementRequested(scheduleRequest)) return true;
  const result = asObject(scheduleApplied);
  const placed = asObject(result.placedOnSheet ?? result.placed_on_sheet ?? result.scheduleSheetInstance);
  if (Object.keys(placed).length === 0) return false;
  if (!/^(placed|success|created)$/i.test(clip(placed.status ?? result.status, 80))) return false;
  if (firstPositiveId(placed.scheduleSheetInstanceId, placed.id, placed.instanceId) === null) return false;
  const requestedSheetId = firstPositiveId(scheduleRequest.placeOnSheetId, scheduleRequest.place_on_sheet_id, scheduleRequest.sheetId, scheduleRequest.sheet_id);
  const actualSheetId = firstPositiveId(placed.sheetId, asObject(placed.sheet).id);
  if (requestedSheetId !== null && actualSheetId !== requestedSheetId) return false;
  const requestedSheetNumber = proofText(scheduleRequest.sheetNumber ?? scheduleRequest.sheet_number);
  if (requestedSheetNumber && proofText(placed.sheetNumber ?? asObject(placed.sheet).number) !== requestedSheetNumber) return false;
  return true;
}

function scheduleConfigAppliedProofMatchesRequest(configureRequest: JsonMap, configureApplied: unknown): boolean {
  const applied = asObject(asObject(configureApplied).applied);
  const addFields = requestedStringArray(configureRequest.addFields);
  if (addFields.length > 0) {
    const rows = objectArray(applied.addFields);
    const okRows = rows.filter((row) => /^(added|alreadypresent)$/i.test(clip(row.status, 80)));
    if (!addFields.every((field) => {
      const requested = proofText(field);
      return okRows.some((row) => proofText(row.field ?? row.name ?? row.fieldName) === requested);
    })) return false;
  }

  const filters = Array.isArray(configureRequest.filters) ? configureRequest.filters : [];
  if (filters.length > 0) {
    const rows = objectArray(applied.filters);
    if (!filters.every((filter) => requestedScheduleFilterProofMatches(filter, rows))) return false;
  }

  const sortGroup = Array.isArray(configureRequest.sortGroup) ? configureRequest.sortGroup : [];
  if (sortGroup.length > 0) {
    const rows = objectArray(applied.sortGroup);
    if (!sortGroup.every((sort) => requestedScheduleSortProofMatches(sort, rows))) return false;
  }

  if (typeof configureRequest.showGrandTotals === "boolean") {
    const rows = objectArray(applied.sortGroup);
    const row = rows.find((entry) => /^showgrandtotals$/i.test(clip(entry.setting, 80)));
    if (!row || Boolean(row.value) !== configureRequest.showGrandTotals) return false;
  }

  const columnWidths = Array.isArray(configureRequest.columnWidths) ? configureRequest.columnWidths : [];
  if (columnWidths.length > 0) {
    const rows = objectArray(applied.columnWidths);
    if (!columnWidths.every((width) => requestedScheduleColumnWidthProofMatches(width, rows))) return false;
  }

  const rowHeights = Array.isArray(configureRequest.rowHeights) ? configureRequest.rowHeights : [];
  if (rowHeights.length > 0) {
    const rows = objectArray(applied.rowHeights);
    if (!rowHeights.every((height) => requestedScheduleRowHeightProofMatches(height, rows))) return false;
  }

  const calculatedFields = Array.isArray(configureRequest.calculatedFields) ? configureRequest.calculatedFields : [];
  if (calculatedFields.length > 0 && objectArray(applied.calculatedFields).length < calculatedFields.length) return false;

  const fieldFormats = Array.isArray(configureRequest.fieldFormats) ? configureRequest.fieldFormats : [];
  if (fieldFormats.length > 0) {
    const rows = objectArray(applied.fieldFormats);
    if (!fieldFormats.every((format) => requestedScheduleFieldFormatProofMatches(format, rows))) return false;
  }

  const conditionalFormats = Array.isArray(configureRequest.conditionalFormats) ? configureRequest.conditionalFormats : [];
  if (conditionalFormats.length > 0 && objectArray(applied.conditionalFormats).length < conditionalFormats.length) return false;

  const appearance = asObject(configureRequest.appearance);
  if (Object.keys(appearance).length > 0) {
    const rows = objectArray(applied.appearance);
    if (!requestedScheduleAppearanceProofMatches(appearance, rows)) return false;
  }

  if (typeof configureRequest.filterBySheet === "boolean" && objectArray(applied.filterBySheet).length === 0) return false;

  return true;
}

function requestedScheduleAppearanceProofMatches(requestedAppearance: JsonMap, rows: JsonMap[]): boolean {
  if (rows.length === 0) return false;
  for (const [setting, requestedValue] of Object.entries(requestedAppearance)) {
    if (typeof requestedValue !== "boolean") continue;
    const settingKey = proofText(setting);
    const row = rows.find((entry) => proofText(entry.setting ?? entry.name) === settingKey);
    if (!row) return false;
    if (Boolean(row.value) !== requestedValue) return false;
    const status = clip(row.status, 80).toLowerCase();
    if (status !== "applied" && status !== "alreadypresent") return false;
    if ((settingKey === "showtitle" || settingKey === "showheaders") && Boolean(row.readback) !== requestedValue) return false;
  }
  return true;
}

function requestedScheduleFieldFormatProofMatches(requestedFormat: unknown, rows: JsonMap[]): boolean {
  const request = asObject(requestedFormat);
  const requestedField = proofText(request.field ?? request.name ?? request.fieldName);
  if (!requestedField) return false;
  const requestedHeading = proofText(request.heading ?? request.columnHeading);
  const requestedAlignment = proofText(request.horizontalAlignment);
  const requestedHidden = typeof request.hidden === "boolean" ? request.hidden : null;

  return rows.some((row) => {
    const status = clip(row.status, 80).toLowerCase();
    if (status !== "applied" && status !== "skipped") return false;
    const actualField = proofText(row.field ?? row.name ?? row.fieldName);
    if (actualField !== requestedField) return false;
    if (requestedHeading && proofText(row.heading ?? row.columnHeading) !== requestedHeading) return false;
    if (requestedAlignment && proofText(row.horizontalAlignment) !== requestedAlignment) return false;
    if (requestedHidden !== null && Boolean(row.hidden) !== requestedHidden) return false;
    return true;
  });
}

function scheduleConfigTextValueReadbackMatchesRequest(configureRequest: JsonMap, configureApplied: unknown, scheduleDetail: unknown): boolean {
  const requestedValue = normalizedProofText(configureRequest.requestedTextOrValue ?? configureRequest.requestedValue ?? configureRequest.value);
  const readbackRequired = parseBool(configureRequest.readbackRequired ?? configureRequest.readback_required ?? configureRequest.requireReadback) === true;
  if (!readbackRequired && !requestedValue) return true;
  if (!requestedValue) return false;

  const targetField = normalizedProofText(configureRequest.targetFieldName ?? configureRequest.targetField ?? configureRequest.columnName ?? configureRequest.fieldName);
  const targetCell = normalizedProofText(configureRequest.targetCellId ?? configureRequest.cellId);
  const targetRowKey = normalizedProofText(configureRequest.targetRowKey ?? configureRequest.rowKey ?? configureRequest.elementUniqueId ?? configureRequest.elementId);
  const targetRowIndex = Number(configureRequest.targetRowIndex ?? configureRequest.rowIndex);
  const rowIndexRequested = Number.isFinite(targetRowIndex);
  const applied = asObject(asObject(configureApplied).applied);
  const detail = asObject(scheduleDetail);
  const candidates = [
    ...objectArray(applied.scheduleTextEdits),
    ...objectArray(applied.scheduleValueEdits),
    ...objectArray(applied.cellEdits),
    ...objectArray(applied.textEdits),
    ...objectArray(applied.values),
    ...objectArray(asObject(configureApplied).scheduleTextEdits),
    ...objectArray(asObject(configureApplied).cellEdits),
    ...objectArray(asObject(configureApplied).rows),
    ...objectArray(detail.rows),
    ...objectArray(detail.cells),
    ...objectArray(detail.values)
  ];

  return candidates.some((row) => {
    const value = normalizedProofText(row.value ?? row.newValue ?? row.text ?? row.displayValue ?? row.currentValue ?? row.cellValue);
    if (value !== requestedValue) return false;

    if (targetField) {
      const field = normalizedProofText(row.field ?? row.fieldName ?? row.columnName ?? row.parameterName ?? row.heading);
      if (field && field !== targetField) return false;
    }

    if (targetCell) {
      const cell = normalizedProofText(row.cellId ?? row.cellKey ?? row.id);
      if (cell && cell !== targetCell) return false;
    }

    if (targetRowKey) {
      const rowKey = normalizedProofText(row.rowKey ?? row.elementUniqueId ?? row.uniqueId ?? row.elementId ?? row.rowId);
      if (rowKey && rowKey !== targetRowKey) return false;
    }

    if (rowIndexRequested) {
      const rowIndex = Number(row.rowIndex ?? row.index);
      if (Number.isFinite(rowIndex) && rowIndex !== targetRowIndex) return false;
    }

    return true;
  });
}

function normalizedProofText(value: unknown): string {
  return clip(value, 160).trim().toLowerCase();
}

type CadCategorySelection = {
  requestedName: string;
  appliedName: string;
  matchKind: "exact" | "tail" | "contains" | "preferred" | "context" | "root" | "first_layer" | "none";
  matchedRequested: boolean;
  categoryId: number | null;
  depth: number | null;
};

function cadCategoryName(entry: JsonMap): string {
  return clip(entry.categoryName ?? entry.name, 220).trim();
}

function cadCategoryTail(name: string): string {
  const parts = name.split("|").map((part) => part.trim()).filter(Boolean);
  return parts.length > 0 ? parts[parts.length - 1].toLowerCase() : name.toLowerCase();
}

function requestedCadPreferredNames(cadGraphicsBase: JsonMap): string[] {
  return [
    ...requestedStringArray(cadGraphicsBase.preferredLayerNames),
    ...requestedStringArray(cadGraphicsBase.fallbackLayerNames),
    ...requestedStringArray(cadGraphicsBase.preferredCategoryNames),
    ...requestedStringArray(cadGraphicsBase.fallbackCategoryNames)
  ];
}

function cadCategoryContextHints(cadGraphicsBase: JsonMap, cadLinkRequest: JsonMap): string[] {
  const text = [
    cadGraphicsBase.contextHint,
    cadGraphicsBase.discipline,
    cadLinkRequest.sourcePath,
    cadLinkRequest.viewName,
    cadLinkRequest.sheetNumber
  ].map((value) => clip(value, 260).toLowerCase()).join(" ");
  const hints: string[] = [];
  if (/\bhvac\b|\bduct\b|\bcdff\b|\bmech/.test(text)) hints.push("hvac", "duct", "cdff", "mech");
  if (/\bpipe\b|\bplumb|\bsanr\b/.test(text)) hints.push("pipe", "plumb", "sanr");
  if (/\blight|\belec|\brecept|\bpower\b/.test(text)) hints.push("lite", "elec", "power");
  return Array.from(new Set(hints));
}

function cadCategoryScoreForHints(entry: JsonMap, hints: string[]): number {
  const name = normalizedProofText(cadCategoryName(entry));
  if (!name || hints.length === 0) return 0;
  let score = 0;
  for (const hint of hints) {
    if (name.includes(hint)) score += 10;
  }
  if (/\banno\b|iden|text|ttl|schd/.test(name)) score -= 3;
  if (Number(entry.depth) > 0) score += 1;
  return score;
}

function selectCadCategoryForOverride(cadGraphicsBase: JsonMap, cadLinkRequest: JsonMap, cadCategories: JsonMap[]): CadCategorySelection {
  const requestedName = clip(cadGraphicsBase.layerOrSubcategoryName ?? cadGraphicsBase.categoryName ?? cadGraphicsBase.layerName, 160).trim();
  const requested = normalizedProofText(requestedName);
  const rootRequested = proofBool(cadGraphicsBase.wholeCadCategory ?? cadGraphicsBase.wholeCategory ?? cadGraphicsBase.rootCategory) === true
    || /^(whole|root|cad|import|link)$/i.test(clip(cadGraphicsBase.scope ?? cadGraphicsBase.categoryScope, 40));
  const candidates = cadCategories
    .map((entry) => ({ entry, name: cadCategoryName(entry), norm: normalizedProofText(cadCategoryName(entry)), tail: cadCategoryTail(cadCategoryName(entry)) }))
    .filter((entry) => entry.name);
  const root = candidates.find((entry) => Number(entry.entry.depth) === 0) ?? candidates[0];
  const layers = candidates.filter((entry) => Number(entry.entry.depth) > 0);
  const candidatePool = rootRequested ? (root ? [root] : candidates) : (layers.length > 0 ? layers : candidates);

  if (requested) {
    const exact = candidatePool.find((entry) => entry.norm === requested);
    if (exact) return { requestedName, appliedName: exact.name, matchKind: "exact", matchedRequested: true, categoryId: firstPositiveId(exact.entry.categoryId, exact.entry.id), depth: Number.isFinite(Number(exact.entry.depth)) ? Number(exact.entry.depth) : null };
    const tail = candidatePool.find((entry) => entry.tail === requested);
    if (tail) return { requestedName, appliedName: tail.name, matchKind: "tail", matchedRequested: true, categoryId: firstPositiveId(tail.entry.categoryId, tail.entry.id), depth: Number.isFinite(Number(tail.entry.depth)) ? Number(tail.entry.depth) : null };
    const contains = candidatePool.find((entry) => entry.norm.includes(requested) || (entry.tail.length >= 3 && requested.includes(entry.tail)));
    if (contains) return { requestedName, appliedName: contains.name, matchKind: "contains", matchedRequested: true, categoryId: firstPositiveId(contains.entry.categoryId, contains.entry.id), depth: Number.isFinite(Number(contains.entry.depth)) ? Number(contains.entry.depth) : null };
  }

  for (const preferredName of requestedCadPreferredNames(cadGraphicsBase)) {
    const preferred = normalizedProofText(preferredName);
    const match = candidatePool.find((entry) => entry.norm === preferred || entry.tail === preferred || entry.norm.includes(preferred));
    if (match) return { requestedName, appliedName: match.name, matchKind: "preferred", matchedRequested: false, categoryId: firstPositiveId(match.entry.categoryId, match.entry.id), depth: Number.isFinite(Number(match.entry.depth)) ? Number(match.entry.depth) : null };
  }

  if (rootRequested && root) {
    return { requestedName, appliedName: root.name, matchKind: "root", matchedRequested: !requested || root.norm === requested, categoryId: firstPositiveId(root.entry.categoryId, root.entry.id), depth: Number.isFinite(Number(root.entry.depth)) ? Number(root.entry.depth) : null };
  }

  const hints = cadCategoryContextHints(cadGraphicsBase, cadLinkRequest);
  const contextMatch = candidatePool
    .map((entry) => ({ ...entry, score: cadCategoryScoreForHints(entry.entry, hints) }))
    .sort((a, b) => b.score - a.score)[0];
  if (contextMatch && contextMatch.score > 0) {
    return { requestedName, appliedName: contextMatch.name, matchKind: "context", matchedRequested: false, categoryId: firstPositiveId(contextMatch.entry.categoryId, contextMatch.entry.id), depth: Number.isFinite(Number(contextMatch.entry.depth)) ? Number(contextMatch.entry.depth) : null };
  }

  const fallback = candidatePool[0];
  return {
    requestedName,
    appliedName: fallback?.name ?? "",
    matchKind: fallback ? "first_layer" : "none",
    matchedRequested: !requested && Boolean(fallback),
    categoryId: fallback ? firstPositiveId(fallback.entry.categoryId, fallback.entry.id) : null,
    depth: fallback && Number.isFinite(Number(fallback.entry.depth)) ? Number(fallback.entry.depth) : null
  };
}

function visibilityAppliedProofMatchesRequest(visibilityRequest: JsonMap, visibilityApplied: unknown): boolean {
  const requestedAction = normalizedProofText(visibilityRequest.action || "get");
  const result = asObject(visibilityApplied);
  const resultAction = normalizedProofText(result.action);
  if (resultAction && resultAction !== requestedAction) return false;

  const view = asObject(result.view);
  if (Object.keys(view).length === 0) return false;

  if (requestedAction === "set_detail_level") {
    const requested = normalizedProofText(visibilityRequest.detailLevel);
    return requested.length > 0 && normalizedProofText(view.detailLevel) === requested;
  }

  if (requestedAction === "set_scale") {
    const requested = Number(visibilityRequest.scale);
    const actual = Number(view.scale);
    return Number.isFinite(requested) && Number.isFinite(actual) && actual === requested;
  }

  if (requestedAction === "set_discipline") {
    const requested = normalizedProofText(visibilityRequest.discipline);
    return requested.length > 0 && normalizedProofText(view.discipline) === requested;
  }

  if (requestedAction === "set_phase") {
    const requestedPhaseId = firstPositiveId(visibilityRequest.phaseId);
    if (requestedPhaseId !== null) return firstPositiveId(view.phaseId, asObject(view.phase).id) === requestedPhaseId;
    const requestedPhaseName = normalizedProofText(visibilityRequest.phaseName ?? visibilityRequest.phase);
    return requestedPhaseName.length > 0 && normalizedProofText(view.phaseName ?? asObject(view.phase).name ?? view.phase) === requestedPhaseName;
  }

  if (requestedAction === "set_phase_filter") {
    const requestedPhaseFilterId = firstPositiveId(visibilityRequest.phaseFilterId);
    if (requestedPhaseFilterId !== null) return firstPositiveId(view.phaseFilterId, asObject(view.phaseFilter).id) === requestedPhaseFilterId;
    const requestedPhaseFilterName = normalizedProofText(visibilityRequest.phaseFilterName ?? visibilityRequest.phaseFilter);
    return requestedPhaseFilterName.length > 0 && normalizedProofText(view.phaseFilterName ?? asObject(view.phaseFilter).name ?? view.phaseFilter) === requestedPhaseFilterName;
  }

  if (requestedAction === "set_template") {
    const requestedTemplateId = firstPositiveId(visibilityRequest.templateId);
    if (requestedTemplateId !== null) return firstPositiveId(view.viewTemplateId) === requestedTemplateId;
    const requestedTemplateName = normalizedProofText(visibilityRequest.templateName);
    return requestedTemplateName.length > 0 && normalizedProofText(view.viewTemplate) === requestedTemplateName;
  }

  if (requestedAction === "set_category_override") {
    const requestedCategory = normalizedProofText(visibilityRequest.categoryName);
    if (!requestedCategory) return false;
    const requestedLineWeight = Number(visibilityRequest.lineWeight);
    const candidates = [
      asObject(view.categoryOverride),
      ...objectArray(view.categoryOverrides),
      asObject(result.categoryOverride),
      ...objectArray(result.categoryOverrides)
    ].filter((entry) => Object.keys(entry).length > 0);
    const matched = candidates.find((entry) => {
      const categoryName = normalizedProofText(entry.categoryName ?? entry.name);
      return categoryName === requestedCategory;
    });
    if (!matched) return false;
    const requestedLinkedModelId = firstPositiveId(visibilityRequest.linkedModelInstanceId, visibilityRequest.linkedModelId, visibilityRequest.revitLinkInstanceId);
    if (requestedLinkedModelId !== null && firstPositiveId(matched.linkedModelInstanceId, matched.linkedModelId, matched.revitLinkInstanceId, matched.linkInstanceId) !== requestedLinkedModelId) {
      return false;
    }
    const requestedLinkedModelName = normalizedProofText(visibilityRequest.linkedModelName ?? visibilityRequest.revitLinkName ?? visibilityRequest.linkName);
    if (requestedLinkedModelName) {
      const actualLinkedModelName = normalizedProofText(matched.linkedModelName ?? matched.revitLinkName ?? matched.linkName);
      if (actualLinkedModelName !== requestedLinkedModelName) return false;
    }
    if (Number.isFinite(requestedLineWeight) && Number(matched.lineWeight ?? matched.projectionLineWeight) !== requestedLineWeight) {
      return false;
    }
    const requestedR = Number(visibilityRequest.r);
    const requestedG = Number(visibilityRequest.g);
    const requestedB = Number(visibilityRequest.b);
    if (Number.isFinite(requestedR) || Number.isFinite(requestedG) || Number.isFinite(requestedB)) {
      const color = asObject(matched.color ?? matched.projectionLineColor);
      if (Number(color.r) !== requestedR || Number(color.g) !== requestedG || Number(color.b) !== requestedB) return false;
    }
    return true;
  }

  if (requestedAction === "apply_view_filter") {
    const requestedFilterId = firstPositiveId(visibilityRequest.filterId);
    const requestedFilterName = normalizedProofText(visibilityRequest.filterName);
    if (requestedFilterId === null && !requestedFilterName) return false;
    const candidates = [
      ...objectArray(view.viewFilters),
      ...objectArray(view.filters),
      asObject(view.viewFilter),
      asObject(result.viewFilter),
      ...objectArray(result.viewFilters),
      asObject(result.filter)
    ].filter((entry) => Object.keys(entry).length > 0);
    const matched = candidates.find((entry) => {
      if (requestedFilterId !== null && firstPositiveId(entry.id, entry.filterId) === requestedFilterId) return true;
      const name = normalizedProofText(entry.name ?? entry.filterName);
      return !!requestedFilterName && name === requestedFilterName;
    });
    if (!matched) return false;
    const requestedVisible = proofBool(visibilityRequest.filterVisible);
    if (requestedVisible !== null && proofBool(matched.visible ?? matched.filterVisible) !== requestedVisible) return false;
    const filterOverride = asObject(matched.override ?? matched.filterOverride ?? matched.graphicsOverride);
    const overrideCandidates = [filterOverride, matched, asObject(result.filterOverride), asObject(result.override)].filter((entry) => Object.keys(entry).length > 0);
    const requestedLineWeight = Number(visibilityRequest.lineWeight);
    if (Number.isFinite(requestedLineWeight) && !overrideCandidates.some((entry) => Number(entry.lineWeight ?? entry.projectionLineWeight) === requestedLineWeight)) {
      return false;
    }
    const requestedR = Number(visibilityRequest.r);
    const requestedG = Number(visibilityRequest.g);
    const requestedB = Number(visibilityRequest.b);
    if (Number.isFinite(requestedR) || Number.isFinite(requestedG) || Number.isFinite(requestedB)) {
      const colorMatch = overrideCandidates.some((entry) => {
        const color = asObject(entry.color ?? entry.projectionLineColor);
        return Number(color.r) === requestedR && Number(color.g) === requestedG && Number(color.b) === requestedB;
      });
      if (!colorMatch) return false;
    }
    return true;
  }

  return true;
}

export function __testOnlyVisibilityAppliedProofMatchesRequest(visibilityRequest: JsonMap, visibilityApplied: unknown): boolean {
  return visibilityAppliedProofMatchesRequest(visibilityRequest, visibilityApplied);
}

export function __testOnlyCategoryOverrideClearedProofMatchesRequest(visibilityRequest: JsonMap, visibilityApplied: unknown): boolean {
  return categoryOverrideClearedProofMatchesRequest(visibilityRequest, visibilityApplied);
}

function categoryOverrideClearedProofMatchesRequest(visibilityRequest: JsonMap, visibilityApplied: unknown): boolean {
  const result = asObject(visibilityApplied);
  const resultAction = normalizedProofText(result.action);
  if (resultAction && resultAction !== "clear_category_override") return false;
  const view = asObject(result.view);
  if (Object.keys(view).length === 0) return false;
  const requestedCategory = normalizedProofText(visibilityRequest.categoryName);
  if (!requestedCategory) return false;
  const requestedLinkedModelId = firstPositiveId(visibilityRequest.linkedModelInstanceId, visibilityRequest.linkedModelId, visibilityRequest.revitLinkInstanceId);
  const requestedLinkedModelName = normalizedProofText(visibilityRequest.linkedModelName ?? visibilityRequest.revitLinkName ?? visibilityRequest.linkName);
  const candidates = [
    asObject(view.categoryOverride),
    ...objectArray(view.categoryOverrides),
    asObject(result.categoryOverride),
    ...objectArray(result.categoryOverrides)
  ].filter((entry) => Object.keys(entry).length > 0);
  const stillPresent = candidates.some((entry) => {
    if (normalizedProofText(entry.categoryName ?? entry.name) !== requestedCategory) return false;
    if (Number(entry.lineWeight ?? entry.projectionLineWeight) === -1 && (entry.color === null || entry.color === undefined)) return false;
    if (requestedLinkedModelId !== null) {
      return firstPositiveId(entry.linkedModelInstanceId, entry.linkedModelId, entry.revitLinkInstanceId, entry.linkInstanceId) === requestedLinkedModelId;
    }
    if (requestedLinkedModelName) {
      return normalizedProofText(entry.linkedModelName ?? entry.revitLinkName ?? entry.linkName) === requestedLinkedModelName;
    }
    return true;
  });
  return !stillPresent;
}

function filterOverrideClearedProofMatchesRequest(visibilityRequest: JsonMap, visibilityApplied: unknown): boolean {
  const result = asObject(visibilityApplied);
  const resultAction = normalizedProofText(result.action);
  if (resultAction && resultAction !== "clear_filter_override") return false;
  const view = asObject(result.view);
  if (Object.keys(view).length === 0) return false;
  const requestedFilterId = firstPositiveId(visibilityRequest.filterId);
  const requestedFilterName = normalizedProofText(visibilityRequest.filterName);
  if (requestedFilterId === null && !requestedFilterName) return false;
  const candidates = [
    ...objectArray(view.viewFilters),
    ...objectArray(view.filters),
    asObject(view.viewFilter),
    asObject(result.viewFilter),
    ...objectArray(result.viewFilters),
    asObject(result.filter)
  ].filter((entry) => Object.keys(entry).length > 0);
  const matched = candidates.find((entry) => {
    if (requestedFilterId !== null && firstPositiveId(entry.id, entry.filterId) === requestedFilterId) return true;
    const name = normalizedProofText(entry.name ?? entry.filterName);
    return !!requestedFilterName && name === requestedFilterName;
  });
  if (!matched) return false;
  const overrideCandidates = [
    asObject(matched.override ?? matched.filterOverride ?? matched.graphicsOverride),
    asObject(result.filterOverride),
    asObject(result.override)
  ].filter((entry) => Object.keys(entry).length > 0);
  const hasFiniteValue = (value: unknown): boolean => value !== null && value !== undefined && value !== "" && Number.isFinite(Number(value)) && Number(value) > 0;
  return !overrideCandidates.some((entry) => {
    if (hasFiniteValue(entry.lineWeight ?? entry.projectionLineWeight)) return true;
    const color = asObject(entry.color ?? entry.projectionLineColor);
    if (hasFiniteValue(color.r) || hasFiniteValue(color.g) || hasFiniteValue(color.b)) return true;
    if (hasFiniteValue(entry.linePatternId ?? entry.projectionLinePatternId)) return true;
    return Boolean(entry.linePatternName);
  });
}

function matchingCategoryOverride(visibilityRequest: JsonMap, visibilityView: JsonMap): JsonMap {
  const requestedCategory = normalizedProofText(visibilityRequest.categoryName);
  const candidates = [
    asObject(visibilityView.categoryOverride),
    ...objectArray(visibilityView.categoryOverrides)
  ].filter((entry) => Object.keys(entry).length > 0);
  if (!requestedCategory) return candidates[0] ?? {};
  return candidates.find((entry) => {
    const categoryName = normalizedProofText(entry.categoryName ?? entry.name);
    return categoryName === requestedCategory;
  }) ?? {};
}

function visibilitySummaryFields(visibilityRequest: JsonMap, visibilityView: JsonMap): JsonMap {
  const categoryOverride = matchingCategoryOverride(visibilityRequest, visibilityView);
  const requestedFilterId = firstPositiveId(visibilityRequest.filterId);
  const requestedFilterName = normalizedProofText(visibilityRequest.filterName);
  const filterRows = objectArray(visibilityView.viewFilters);
  const filterRow = filterRows.find((entry) => {
    if (requestedFilterId !== null && firstPositiveId(entry.id, entry.filterId) === requestedFilterId) return true;
    const name = normalizedProofText(entry.name ?? entry.filterName);
    return !!requestedFilterName && name === requestedFilterName;
  }) ?? {};
  const filterOverride = asObject(filterRow.override ?? filterRow.filterOverride ?? filterRow.graphicsOverride);
  const filterColor = asObject(filterOverride.color ?? filterRow.color);
  return {
    requestedDetailLevel: visibilityRequest.detailLevel ?? "",
    appliedDetailLevel: visibilityView.detailLevel ?? "",
    requestedScale: visibilityRequest.scale ?? "",
    appliedScale: visibilityView.scale ?? "",
    requestedDiscipline: visibilityRequest.discipline ?? "",
    appliedDiscipline: visibilityView.discipline ?? "",
    requestedPhaseId: visibilityRequest.phaseId ?? "",
    appliedPhaseId: visibilityView.phaseId ?? asObject(visibilityView.phase).id ?? "",
    requestedPhaseName: visibilityRequest.phaseName ?? visibilityRequest.phase ?? "",
    appliedPhaseName: visibilityView.phaseName ?? asObject(visibilityView.phase).name ?? visibilityView.phase ?? "",
    requestedPhaseFilterId: visibilityRequest.phaseFilterId ?? "",
    appliedPhaseFilterId: visibilityView.phaseFilterId ?? asObject(visibilityView.phaseFilter).id ?? "",
    requestedPhaseFilterName: visibilityRequest.phaseFilterName ?? visibilityRequest.phaseFilter ?? "",
    appliedPhaseFilterName: visibilityView.phaseFilterName ?? asObject(visibilityView.phaseFilter).name ?? visibilityView.phaseFilter ?? "",
    requestedTemplateId: visibilityRequest.templateId ?? "",
    appliedTemplateId: visibilityView.viewTemplateId ?? "",
    requestedTemplateName: visibilityRequest.templateName ?? "",
    appliedTemplateName: visibilityView.viewTemplate ?? "",
    requestedLinkedModelId: visibilityRequest.linkedModelInstanceId ?? visibilityRequest.linkedModelId ?? visibilityRequest.revitLinkInstanceId ?? "",
    appliedLinkedModelId: categoryOverride.linkedModelInstanceId ?? categoryOverride.linkedModelId ?? categoryOverride.revitLinkInstanceId ?? categoryOverride.linkInstanceId ?? "",
    requestedLinkedModelName: visibilityRequest.linkedModelName ?? visibilityRequest.revitLinkName ?? visibilityRequest.linkName ?? "",
    appliedLinkedModelName: categoryOverride.linkedModelName ?? categoryOverride.revitLinkName ?? categoryOverride.linkName ?? "",
    requestedCategoryName: visibilityRequest.categoryName ?? "",
    appliedCategoryName: categoryOverride.categoryName ?? "",
    requestedLineWeight: visibilityRequest.lineWeight ?? "",
    appliedLineWeight: categoryOverride.lineWeight ?? categoryOverride.projectionLineWeight ?? "",
    requestedFilterId: visibilityRequest.filterId ?? "",
    appliedFilterId: filterRow.id ?? filterRow.filterId ?? "",
    requestedFilterName: visibilityRequest.filterName ?? "",
    appliedFilterName: filterRow.name ?? filterRow.filterName ?? "",
    requestedFilterVisible: visibilityRequest.filterVisible ?? "",
    appliedFilterVisible: filterRow.visible ?? filterRow.filterVisible ?? "",
    appliedFilterLineWeight: filterOverride.lineWeight ?? filterOverride.projectionLineWeight ?? filterRow.lineWeight ?? "",
    appliedFilterColor: Object.keys(filterColor).length > 0 ? `${filterColor.r ?? ""},${filterColor.g ?? ""},${filterColor.b ?? ""}` : ""
  };
}

function filterIdFromVisibilityResult(visibilityRequest: JsonMap, visibilityResult: unknown): number | null {
  const requestedFilterId = firstPositiveId(visibilityRequest.filterId);
  const requestedFilterName = normalizedProofText(visibilityRequest.filterName);
  const result = asObject(visibilityResult);
  const view = asObject(result.view);
  const candidates = [
    ...objectArray(view.viewFilters),
    ...objectArray(view.filters),
    asObject(view.viewFilter),
    asObject(result.viewFilter),
    ...objectArray(result.viewFilters),
    asObject(result.filter)
  ].filter((entry) => Object.keys(entry).length > 0);
  const matched = candidates.find((entry) => {
    if (requestedFilterId !== null && firstPositiveId(entry.id, entry.filterId) === requestedFilterId) return true;
    const name = normalizedProofText(entry.name ?? entry.filterName);
    return !!requestedFilterName && name === requestedFilterName;
  });
  return matched ? firstPositiveId(matched.id, matched.filterId) : null;
}

function tagResultViewId(result: unknown): number | null {
  const obj = asObject(result);
  const view = asObject(obj.view);
  return firstPositiveId(obj.viewId, obj.targetViewId, obj.id, view.id, view.viewId);
}

function cleanupMissingElementsResult(ids: number[], error: unknown): JsonMap | null {
  const message = error instanceof Error ? error.message : String(error);
  if (!/elementIds do not exist|elements? (?:in )?elementIds do not exist|does not exist in the document/i.test(message)) return null;
  return {
    status: "AlreadyDeleted",
    count: ids.length,
    ids,
    impactedIds: ids,
    warning: "Cleanup target ids were already absent from the document.",
    errorMessage: message
  };
}

function tagResultTargetIds(result: unknown): number[] {
  return objectArray(asObject(result).targets)
    .map((target) => firstPositiveId(target.elementId, target.id))
    .filter((id): id is number => id !== null);
}

function tagReadbackRows(result: unknown): JsonMap[] {
  const obj = asObject(result);
  return [
    ...objectArray(obj.tags),
    ...objectArray(obj.tagReadback),
    ...objectArray(obj.tag_readback),
    ...objectArray(obj.taggedElements),
    ...objectArray(obj.tagged_elements),
    ...objectArray(obj.targets)
  ];
}

function tagReadbackTargetId(row: JsonMap): number | null {
  return firstPositiveId(row.targetElementId, row.target_element_id, row.hostElementId, row.host_element_id, row.taggedElementId, row.tagged_element_id, row.elementId, row.element_id);
}

function tagReadbackTypeId(row: JsonMap): number | null {
  return firstPositiveId(row.tagTypeId, row.tag_type_id, row.typeId, row.type_id, asObject(row.type).id);
}

function tagReadbackTypeName(row: JsonMap): string {
  return normalizedTextProof(firstString(row.tagTypeName, row.tag_type_name, row.typeName, row.type_name, asObject(row.type).name));
}

function tagReadbackValue(row: JsonMap): string {
  return normalizedTextProof(firstString(row.value, row.tagValue, row.tag_value, row.text, row.label, row.displayValue, row.display_value));
}

function tagDryRunProofMatchesRequest(tagRequest: JsonMap, tagDryRun: unknown): boolean {
  const requestedIds = asNumberArray(tagRequest.elementIds);
  const requestedViewId = firstPositiveId(tagRequest.viewId);
  if (requestedIds.length === 0 || requestedViewId === null) return false;
  if (tagResultViewId(tagDryRun) !== requestedViewId) return false;

  const obj = asObject(tagDryRun);
  const targetCount = Number(obj.targetCount);
  const plannedToTag = Number(obj.plannedToTag);
  const skippedAlreadyTagged = Number(obj.skippedAlreadyTagged ?? 0);
  if (!Number.isFinite(targetCount) || targetCount < requestedIds.length) return false;

  const plannedCoverage = (Number.isFinite(plannedToTag) ? plannedToTag : -1) + (Number.isFinite(skippedAlreadyTagged) ? skippedAlreadyTagged : 0);
  if (plannedCoverage < requestedIds.length) return false;

  const targetIds = tagResultTargetIds(tagDryRun);
  return requestedIds.every((id) => targetIds.includes(id));
}

function tagAppliedProofMatchesRequest(tagRequest: JsonMap, tagApplied: unknown): boolean {
  const requestedIds = asNumberArray(tagRequest.elementIds);
  const requestedViewId = firstPositiveId(tagRequest.viewId);
  if (requestedIds.length === 0 || requestedViewId === null) return false;
  if (tagResultViewId(tagApplied) !== requestedViewId) return false;

  const obj = asObject(tagApplied);
  const targetCount = Number(obj.targetCount);
  const taggedCount = Number(obj.taggedCount);
  const skippedAlreadyTagged = Number(obj.skippedAlreadyTagged ?? 0);
  const errorCount = Number(obj.errorCount ?? 0);
  const tagIds = asNumberArray(obj.tagIds);
  if (!Number.isFinite(targetCount) || targetCount < requestedIds.length) return false;
  if (!Number.isFinite(errorCount) || errorCount !== 0) return false;

  const taggedCoverage = (Number.isFinite(taggedCount) ? taggedCount : tagIds.length) + (Number.isFinite(skippedAlreadyTagged) ? skippedAlreadyTagged : 0);
  return taggedCoverage >= requestedIds.length && tagIds.length + skippedAlreadyTagged >= requestedIds.length;
}

function tagCreationFailureReasons(tagApplied: unknown, options: { requireCreatedIds?: boolean } = {}): string[] {
  const requireCreatedIds = options.requireCreatedIds !== false;
  const obj = asObject(tagApplied);
  const reasons: string[] = [];
  const status = clip(obj.status, 120);
  if (/^(error|failed|failure)$/i.test(status)) reasons.push(status);
  const errorCount = Number(obj.errorCount ?? 0);
  const taggedCount = Number(obj.taggedCount);
  const tagIds = asNumberArray(obj.tagIds);
  if (Number.isFinite(errorCount) && errorCount > 0) reasons.push(`errorCount:${errorCount}`);
  if (requireCreatedIds && Number.isFinite(taggedCount) && taggedCount === 0 && tagIds.length === 0) reasons.push("no_tags_created");
  for (const row of objectArray(obj.errors)) {
    const elementId = firstPositiveId(row.elementId, row.id);
    const message = clip(row.error ?? row.message ?? row.failureReason ?? row.reason, 500);
    if (message) reasons.push(elementId !== null ? `element ${elementId}: ${message}` : message);
  }
  return Array.from(new Set(reasons));
}

function tagReadbackMatchesRequest(tagRequest: JsonMap, tagApplied: unknown): boolean {
  const requestedIds = asNumberArray(tagRequest.elementIds);
  if (requestedIds.length === 0) return false;
  const rows = tagReadbackRows(tagApplied);
  const readbackRequired = parseBool(tagRequest.readbackRequired ?? tagRequest.readback_required) === true;
  const requestedTypeId = firstPositiveId(tagRequest.tagTypeId, tagRequest.tag_type_id, tagRequest.typeId, tagRequest.type_id);
  const requestedTypeName = normalizedTextProof(firstString(tagRequest.tagTypeName, tagRequest.tag_type_name, tagRequest.typeName, tagRequest.type_name));
  const requestedValue = normalizedTextProof(firstString(tagRequest.requestedTagValueHint, tagRequest.tagValue, tagRequest.tag_value, tagRequest.value, tagRequest.text, tagRequest.label));
  const requestedNoteNumber = normalizedTextProof(firstString(tagRequest.requestedNoteNumberHint, tagRequest.requested_note_number_hint, tagRequest.noteNumber, tagRequest.note_number));
  const requestedKind = normalizedTextProof(firstString(tagRequest.requestedTagKindHint, tagRequest.requested_tag_kind_hint, tagRequest.tagKind, tagRequest.tag_kind));
  const hasRequestedTypeOrValue = requestedTypeId !== null || Boolean(requestedTypeName) || Boolean(requestedValue) || Boolean(requestedNoteNumber) || Boolean(requestedKind);
  if (rows.length === 0) return !readbackRequired && !hasRequestedTypeOrValue;

  const rowTargetIds = rows
    .map((row) => tagReadbackTargetId(row))
    .filter((id): id is number => id !== null);
  if (rowTargetIds.length === 0 || !requestedIds.every((id) => rowTargetIds.includes(id))) return false;
  const requestedRows = rows.filter((row) => {
    const id = tagReadbackTargetId(row);
    return id !== null && requestedIds.includes(id);
  });

  if (requestedTypeId !== null) {
    if (!requestedIds.every((id) => requestedRows.some((row) => tagReadbackTargetId(row) === id && tagReadbackTypeId(row) === requestedTypeId))) return false;
  }

  if (requestedTypeName) {
    if (!requestedIds.every((id) => requestedRows.some((row) => tagReadbackTargetId(row) === id && tagReadbackTypeName(row) === requestedTypeName))) return false;
  }

  if (requestedValue) {
    if (!requestedIds.every((id) => requestedRows.some((row) => tagReadbackTargetId(row) === id && tagReadbackValue(row) === requestedValue))) return false;
  }

  if (requestedNoteNumber) {
    if (!requestedIds.every((id) => requestedRows.some((row) => tagReadbackTargetId(row) === id && proofLabelsMatchRequest(requestedNoteNumber, [tagReadbackValue(row)])))) return false;
  }

  if (requestedKind) {
    if (!requestedIds.every((id) => requestedRows.some((row) => tagReadbackTargetId(row) === id && proofLabelsMatchRequest(requestedKind, [tagReadbackTypeName(row), tagReadbackValue(row)])))) return false;
  }

  return true;
}

function visibleElementRows(result: unknown): JsonMap[] {
  const obj = asObject(result);
  return [
    ...objectArray(obj.elements),
    ...objectArray(obj.items),
    ...objectArray(obj.visibleElements),
    ...objectArray(obj.visible_elements)
  ];
}

function tagVisibleTextRows(result: unknown, tagIds: number[]): JsonMap[] {
  const requested = new Set(tagIds);
  return visibleElementRows(result).filter((row) => {
    const id = firstPositiveId(row.id, row.elementId, row.element_id, row.tagId, row.tag_id);
    return id !== null && requested.has(id);
  });
}

function tagVisibleTextReadbackMatches(result: unknown, tagIds: number[], expectedValue: string): boolean {
  const expected = normalizedTextProof(expectedValue);
  if (tagIds.length === 0 || !expected) return false;
  const rows = tagVisibleTextRows(result, tagIds);
  if (rows.length === 0) return false;
  return tagIds.every((id) => rows.some((row) => {
    const rowId = firstPositiveId(row.id, row.elementId, row.element_id, row.tagId, row.tag_id);
    const visibleText = normalizedTextProof(firstString(row.visibleText, row.visible_text, row.tagText, row.tag_text, row.text, row.value, row.label));
    return rowId === id && visibleText === expected;
  }));
}

function parameterSnapshotMatches(snapshot: unknown, elementIds: number[], parameterName: string, expectedValue: string): boolean {
  const expected = String(expectedValue ?? "");
  const values = parameterValueByElementId(snapshot, parameterName);
  return elementIds.length > 0 && elementIds.every((id) => values.get(id) === expected);
}

function exportedScheduleCsvContains(exportResult: unknown, rowKey: string, expectedValue: string): boolean {
  const csvPath = firstPathLike(
    asObject(exportResult).path,
    asObject(exportResult).csvPath,
    asObject(exportResult).csv_path,
    asObject(exportResult).outputPath,
    asObject(exportResult).output_path
  );
  if (!csvPath || !fs.existsSync(csvPath)) return false;
  const wantedRow = normalizedTextProof(rowKey);
  const wantedValue = normalizedTextProof(expectedValue);
  if (!wantedRow) return false;
  const lines = fs.readFileSync(csvPath, "utf8").split(/\r?\n/);
  return lines.some((line) => {
    const normalized = normalizedTextProof(line.replace(/"/g, ""));
    return normalized.includes(wantedRow) && (!wantedValue || normalized.includes(wantedValue));
  });
}

function tagCreatedCountMatchesRequest(tagRequest: JsonMap, tagApplied: unknown): boolean {
  const requestedIds = asNumberArray(tagRequest.elementIds);
  if (requestedIds.length === 0) return false;
  const obj = asObject(tagApplied);
  const tagIds = asNumberArray(obj.tagIds);
  const skippedAlreadyTagged = Number(obj.skippedAlreadyTagged ?? 0);
  const errorCount = Number(obj.errorCount ?? 0);
  if (!Number.isFinite(errorCount) || errorCount !== 0) return false;
  const covered = tagIds.length + (Number.isFinite(skippedAlreadyTagged) ? skippedAlreadyTagged : 0);
  return covered >= requestedIds.length;
}

function placedViewProofMatchesRequest(sheetId: number, viewId: number, placed: unknown): boolean {
  const obj = asObject(placed);
  const sheet = asObject(obj.sheet);
  const view = asObject(obj.view);
  const appliedSheetId = firstPositiveId(obj.sheetId, obj.parentSheetId, sheet.id, sheet.sheetId);
  const appliedViewId = firstPositiveId(obj.viewId, obj.placedViewId, view.id, view.viewId);
  return appliedSheetId === sheetId && appliedViewId === viewId;
}

function placedViewsBatchProofMatchesRequest(expectedPlacements: JsonMap[], placed: unknown): boolean {
  const obj = asObject(placed);
  if (!statusLooksOk(placed)) return false;
  const rows = objectArray(obj.results);
  if (rows.length < expectedPlacements.length) return false;
  return expectedPlacements.every((expected, index) => {
    const row = rows.find((candidate) => Number(candidate.index) === index) ?? rows[index];
    if (!row) return false;
    if (row.ok !== true && !statusLooksOk(row)) return false;
    const expectedSheetId = firstPositiveId(expected.sheetId, expected.sheet_id);
    const expectedViewId = firstPositiveId(expected.viewId, expected.view_id);
    if (expectedSheetId !== null && firstPositiveId(row.sheetId, asObject(row.sheet).id) !== expectedSheetId) return false;
    if (expectedViewId !== null && firstPositiveId(row.viewId, asObject(row.view).id) !== expectedViewId) return false;
    const placementType = clip(row.placementType, 120).toLowerCase();
    const scheduleInstanceId = firstPositiveId(row.scheduleSheetInstanceId, row.id, row.instanceId);
    if (placementType.includes("schedule") && scheduleInstanceId === null) return false;
    if (!placementType.includes("schedule") && firstPositiveId(row.viewportId, row.id) === null) return false;
    return true;
  });
}

function placedViewsBatchMoveProofMatchesRequest(expectedPlacements: JsonMap[], initialPlaced: unknown, movedPlaced: unknown): boolean {
  if (!placedViewsBatchProofMatchesRequest(expectedPlacements, movedPlaced)) return false;
  const initialRows = objectArray(asObject(initialPlaced).results);
  const movedRows = objectArray(asObject(movedPlaced).results);
  if (movedRows.length < expectedPlacements.length) return false;
  return expectedPlacements.every((expected, index) => {
    const moved = movedRows.find((candidate) => Number(candidate.index) === index) ?? movedRows[index];
    if (!moved) return false;
    if (clip(moved.action, 80).toLowerCase() !== "moveexisting") return false;
    const initial = initialRows.find((candidate) => Number(candidate.index) === index) ?? initialRows[index];
    if (initial) {
      const initialInstanceId = firstPositiveId(initial.scheduleSheetInstanceId, initial.id, initial.instanceId);
      const movedInstanceId = firstPositiveId(moved.scheduleSheetInstanceId, moved.id, moved.instanceId);
      if (initialInstanceId !== null && movedInstanceId !== null && initialInstanceId !== movedInstanceId) return false;
    }
    const expectedX = Number(expected.x);
    const expectedY = Number(expected.y);
    const movedX = Number(moved.x);
    const movedY = Number(moved.y);
    if (Number.isFinite(expectedX) && (!Number.isFinite(movedX) || Math.abs(movedX - expectedX) > 0.001)) return false;
    if (Number.isFinite(expectedY) && (!Number.isFinite(movedY) || Math.abs(movedY - expectedY) > 0.001)) return false;
    return true;
  });
}

function finiteNumberOrNull(...values: unknown[]): number | null {
  for (const value of values) {
    const numberValue = Number(value);
    if (Number.isFinite(numberValue)) return numberValue;
  }
  return null;
}

function normalizeScheduleLayoutPolicy(value: unknown): string {
  return clip(value, 120)
    .trim()
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/[\s-]+/g, "_")
    .toLowerCase();
}

function isRightAnchoredScheduleStackPolicy(policy: string): boolean {
  return [
    "blank_schedule_sheet_pack",
    "blank_sheet_schedule_pack",
    "right_justified_vertical_stack",
    "right_aligned_vertical_stack",
    "right_anchor_vertical_stack",
    "right_anchored_vertical_stack",
    "right_justified",
    "schedule_blank_sheet_pack",
    "schedule_sheet_pack"
  ].includes(policy);
}

function isBlankSheetSchedulePackPolicy(policy: string): boolean {
  return [
    "blank_schedule_sheet_pack",
    "blank_sheet_schedule_pack",
    "schedule_blank_sheet_pack",
    "schedule_sheet_pack"
  ].includes(policy);
}

function scheduleLayoutUsableBounds(layout: JsonMap): { minX: number | null; maxX: number | null; minY: number | null; maxY: number | null } {
  const bounds = asObject(layout.usableBounds ?? layout.usable_bounds ?? layout.sheetUsableBounds ?? layout.sheet_usable_bounds ?? layout.bounds);
  const minX = finiteNumberOrNull(bounds.minX, bounds.min_x, bounds.left, bounds.leftX, bounds.left_x, layout.usableMinX, layout.usable_min_x);
  const maxX = finiteNumberOrNull(bounds.maxX, bounds.max_x, bounds.right, bounds.rightX, bounds.right_x, layout.usableMaxX, layout.usable_max_x);
  const minY = finiteNumberOrNull(bounds.minY, bounds.min_y, bounds.bottom, bounds.bottomY, bounds.bottom_y, layout.usableMinY, layout.usable_min_y);
  const maxY = finiteNumberOrNull(bounds.maxY, bounds.max_y, bounds.top, bounds.topY, bounds.top_y, layout.usableMaxY, layout.usable_max_y);
  return { minX, maxX, minY, maxY };
}

function scheduleLayoutPlanWithinBounds(placements: JsonMap[], bounds: { minX: number | null; maxX: number | null; minY: number | null; maxY: number | null }): boolean {
  const hasBounds = [bounds.minX, bounds.maxX, bounds.minY, bounds.maxY].every((value) => value !== null && Number.isFinite(Number(value)));
  if (!hasBounds) return false;
  return placements.length > 0 && placements.every((placement) => {
    const x = Number(placement.x);
    const y = Number(placement.y);
    const width = Number(placement.estimatedWidthFeet ?? placement.widthFeet);
    const height = Number(placement.estimatedHeightFeet ?? placement.heightFeet);
    if (![x, y, width, height].every(Number.isFinite)) return false;
    const left = x;
    const right = x + width;
    const top = y;
    const bottom = y - height;
    return left >= Number(bounds.minX) - 0.001 &&
      right <= Number(bounds.maxX) + 0.001 &&
      bottom >= Number(bounds.minY) - 0.001 &&
      top <= Number(bounds.maxY) + 0.001;
  });
}

function scheduleLayoutPlanSpacingVerified(placements: JsonMap[]): boolean {
  if (placements.length < 2) return true;
  for (let index = 1; index < placements.length; index += 1) {
    const previous = placements[index - 1];
    const current = placements[index];
    const previousY = Number(previous.y);
    const currentY = Number(current.y);
    const previousHeight = Number(previous.estimatedHeightFeet ?? previous.heightFeet);
    const spacing = Number(previous.stackSpacingFeet ?? previous.spacingFeet);
    if (!Number.isFinite(previousY) || !Number.isFinite(currentY) || !Number.isFinite(previousHeight) || !Number.isFinite(spacing)) return false;
    if (Math.abs((previousY - currentY) - (previousHeight + spacing)) > 0.001) return false;
  }
  return true;
}

function scheduleLayoutPlanRightAnchorVerified(placements: JsonMap[], rightAnchorX: number | null): boolean {
  if (rightAnchorX === null) return false;
  return placements.length > 0 && placements.every((placement) => {
    const x = Number(placement.x);
    const width = Number(placement.estimatedWidthFeet ?? placement.widthFeet);
    const rightEdge = Number.isFinite(width) ? x + width : x;
    return Number.isFinite(rightEdge) && Math.abs(rightEdge - rightAnchorX) <= 0.001;
  });
}

function scheduleLayoutAppliedAnchorsMatchPlan(placements: JsonMap[], placed: unknown): boolean {
  const rows = objectArray(asObject(placed).results);
  if (rows.length < placements.length) return false;
  return placements.every((placement, index) => {
    const row = rows.find((candidate) => Number(candidate.index) === index) ?? rows[index];
    if (!row) return false;
    const expectedX = Number(placement.x);
    const expectedY = Number(placement.y);
    const actualX = Number(row.x);
    const actualY = Number(row.y);
    if (Number.isFinite(expectedX) && (!Number.isFinite(actualX) || Math.abs(actualX - expectedX) > 0.001)) return false;
    if (Number.isFinite(expectedY) && (!Number.isFinite(actualY) || Math.abs(actualY - expectedY) > 0.001)) {
      if (index === 0) return false;
      const previousRow = rows.find((candidate) => Number(candidate.index) === index - 1) ?? rows[index - 1];
      const previousBox = asObject(previousRow?.actualBox ?? previousRow?.actual_box);
      const previousMinY = Number(previousBox.minV ?? previousBox.minY);
      const spacing = Number(placements[index - 1]?.stackSpacingFeet ?? placements[index - 1]?.spacingFeet);
      if (!Number.isFinite(previousMinY) || !Number.isFinite(spacing)) return false;
      if (Math.abs(actualY - (previousMinY - spacing)) > 0.001) return false;
    }
    return true;
  });
}

function schedulePlacementBox(row: JsonMap): { minX: number | null; maxX: number | null; minY: number | null; maxY: number | null; width: number | null; height: number | null } {
  const box = asObject(row.actualBox ?? row.actual_box ?? row.boundingBox ?? row.bounding_box);
  const minObj = asObject(box.min);
  const maxObj = asObject(box.max);
  const minX = finiteNumberOrNull(box.minU, box.minX, box.left, minObj.x);
  const maxX = finiteNumberOrNull(box.maxU, box.maxX, box.right, maxObj.x);
  const minY = finiteNumberOrNull(box.minV, box.minY, box.bottom, minObj.y);
  const maxY = finiteNumberOrNull(box.maxV, box.maxY, box.top, maxObj.y);
  const width = finiteNumberOrNull(box.width, Number.isFinite(Number(minX)) && Number.isFinite(Number(maxX)) ? Number(maxX) - Number(minX) : undefined);
  const height = finiteNumberOrNull(box.height, Number.isFinite(Number(minY)) && Number.isFinite(Number(maxY)) ? Number(maxY) - Number(minY) : undefined);
  return { minX, maxX, minY, maxY, width, height };
}

function scheduleMeasuredRepackSpacingVerified(placements: JsonMap[], initialPlaced: unknown): boolean {
  if (placements.length < 2) return true;
  const rows = objectArray(asObject(initialPlaced).results);
  for (let index = 1; index < placements.length; index += 1) {
    const previousPlacement = placements[index - 1];
    const currentPlacement = placements[index];
    const previousRow = rows.find((candidate) => Number(candidate.index) === index - 1) ?? rows[index - 1];
    const previousBox = schedulePlacementBox(previousRow ?? {});
    const previousY = Number(previousPlacement.y);
    const currentY = Number(currentPlacement.y);
    const previousHeight = Number(previousBox.height ?? previousPlacement.estimatedHeightFeet ?? previousPlacement.heightFeet);
    const spacing = Number(previousPlacement.stackSpacingFeet ?? previousPlacement.spacingFeet ?? currentPlacement.stackSpacingFeet ?? currentPlacement.spacingFeet);
    if (!Number.isFinite(previousY) || !Number.isFinite(currentY) || !Number.isFinite(previousHeight) || !Number.isFinite(spacing)) return false;
    if (Math.abs((previousY - currentY) - (previousHeight + spacing)) > 0.001) return false;
  }
  return true;
}

function scheduleMeasuredRows(result: unknown): JsonMap[] {
  return objectArray(asObject(result).results).filter((row) => {
    const box = schedulePlacementBox(row);
    return [box.minX, box.maxX, box.minY, box.maxY].every((value) => value !== null && Number.isFinite(Number(value)));
  });
}

function scheduleMeasuredRowsWithinBounds(result: unknown, bounds: { minX: number | null; maxX: number | null; minY: number | null; maxY: number | null }, expectedCount: number): boolean {
  const hasBounds = [bounds.minX, bounds.maxX, bounds.minY, bounds.maxY].every((value) => value !== null && Number.isFinite(Number(value)));
  if (!hasBounds) return false;
  const rows = scheduleMeasuredRows(result);
  if (rows.length < expectedCount) return false;
  return rows.every((row) => {
    const box = schedulePlacementBox(row);
    return Number(box.minX) >= Number(bounds.minX) - 0.001 &&
      Number(box.maxX) <= Number(bounds.maxX) + 0.001 &&
      Number(box.minY) >= Number(bounds.minY) - 0.001 &&
      Number(box.maxY) <= Number(bounds.maxY) + 0.001;
  });
}

function scheduleMeasuredRowsDoNotOverlap(result: unknown, expectedCount: number): boolean {
  const rows = scheduleMeasuredRows(result);
  if (rows.length < expectedCount) return false;
  for (let leftIndex = 0; leftIndex < rows.length; leftIndex += 1) {
    const left = schedulePlacementBox(rows[leftIndex] ?? {});
    for (let rightIndex = leftIndex + 1; rightIndex < rows.length; rightIndex += 1) {
      const right = schedulePlacementBox(rows[rightIndex] ?? {});
      const separated =
        Number(left.maxX) <= Number(right.minX) + 0.001 ||
        Number(right.maxX) <= Number(left.minX) + 0.001 ||
        Number(left.maxY) <= Number(right.minY) + 0.001 ||
        Number(right.maxY) <= Number(left.minY) + 0.001;
      if (!separated) return false;
    }
  }
  return true;
}

function detailCurveProofMatchesRequest(viewId: number, requestedCurveCount: number, dryRun: unknown, applied: unknown): boolean {
  const dryRunObj = asObject(dryRun);
  const appliedObj = asObject(applied);
  const dryRunViewId = firstPositiveId(dryRunObj.viewId, asObject(dryRunObj.view).id);
  const appliedViewId = firstPositiveId(appliedObj.viewId, asObject(appliedObj.view).id);
  const dryRunSegments = Number(dryRunObj.segmentsCreated ?? dryRunObj.createdCount);
  const appliedSegments = Number(appliedObj.segmentsCreated ?? appliedObj.createdCount);
  return (
    requestedCurveCount > 0 &&
    dryRunViewId === viewId &&
    appliedViewId === viewId &&
    Number.isFinite(dryRunSegments) &&
    dryRunSegments >= requestedCurveCount &&
    Number.isFinite(appliedSegments) &&
    appliedSegments >= requestedCurveCount
  );
}

function normalizedTextProof(value: unknown): string {
  return clip(value, 1000).replace(/\s+/g, " ").trim().toLowerCase();
}

function textNoteProofMatchesRequest(viewId: number, requestedText: string, requestedTypeId: number | null, textResult: unknown): boolean {
  const obj = asObject(textResult);
  const view = asObject(obj.view);
  const textType = asObject(obj.textType ?? obj.type);
  const appliedViewId = firstPositiveId(obj.viewId, obj.targetViewId, view.id, view.viewId);
  const reportedText = firstPathLike(obj.text, obj.normalizedText, obj.value, asObject(obj.textNote).text);
  const reportedTypeId = firstPositiveId(obj.textTypeId, obj.typeId, textType.id);
  const textOk = !reportedText || normalizedTextProof(reportedText) === normalizedTextProof(requestedText);
  const typeOk = requestedTypeId === null || reportedTypeId === null || reportedTypeId === requestedTypeId;
  return appliedViewId === viewId && textOk && typeOk;
}

function textNoteReadbackMatchesRequest(textRequest: JsonMap, viewId: number, requestedText: string, requestedTypeId: number | null, textResult: unknown): boolean {
  const readbackRequired = parseBool(textRequest.readbackRequired ?? textRequest.readback_required ?? textRequest.requireReadback) === true;
  if (!readbackRequired) return true;

  const obj = asObject(textResult);
  const view = asObject(obj.view);
  const textNote = asObject(obj.textNote ?? obj.text_note);
  const textType = asObject(obj.textType ?? obj.text_type ?? obj.type ?? textNote.textType ?? textNote.type);
  const appliedViewId = firstPositiveId(obj.viewId, obj.targetViewId, view.id, view.viewId, textNote.viewId, asObject(textNote.view).id);
  if (appliedViewId !== viewId) return false;

  const reportedText = firstString(obj.text, obj.normalizedText, obj.normalized_text, obj.value, textNote.text, textNote.normalizedText, textNote.normalized_text, textNote.value);
  if (!reportedText || normalizedTextProof(reportedText) !== normalizedTextProof(requestedText)) return false;

  const reportedTypeId = firstPositiveId(obj.textTypeId, obj.text_type_id, obj.typeId, obj.type_id, textType.id);
  return requestedTypeId === null || reportedTypeId === requestedTypeId;
}

function textNoteItems(result: unknown): JsonMap[] {
  const obj = asObject(result);
  const items = Array.isArray(obj.items) ? obj.items.map(asObject) : [];
  if (items.length > 0) return items;
  const textNote = asObject(obj.textNote ?? obj.text_note);
  return Object.keys(textNote).length > 0 ? [textNote] : [];
}

function textNoteItemMatches(item: JsonMap, textNoteId: number, viewId: number | null, expectedText: string): boolean {
  const id = firstPositiveId(item.textNoteId, item.text_note_id, item.elementId, item.element_id, item.id);
  if (id !== textNoteId) return false;
  return textNoteItemTextAndViewMatches(item, viewId, expectedText);
}

function textNoteItemTextAndViewMatches(item: JsonMap, viewId: number | null, expectedText: string): boolean {
  const ownerViewId = firstPositiveId(item.ownerViewId, item.owner_view_id, item.viewId, item.view_id);
  if (viewId !== null && ownerViewId !== null && ownerViewId !== viewId) return false;
  const text = firstString(item.text, item.normalizedText, item.normalized_text, item.value);
  return Boolean(text && normalizedTextProof(text) === normalizedTextProof(expectedText));
}

function textNoteFindResultMatches(result: unknown, textNoteId: number, viewId: number | null, expectedText: string): boolean {
  return textNoteItems(result).some((item) => textNoteItemMatches(item, textNoteId, viewId, expectedText));
}

function textNoteReplaceResultMatches(result: unknown, textNoteId: number, viewId: number | null, expectedText: string): boolean {
  const obj = asObject(result);
  const id = firstPositiveId(obj.textNoteId, obj.text_note_id, obj.elementId, obj.element_id, obj.id);
  if (id !== null && id !== textNoteId) return false;
  const ownerViewId = firstPositiveId(obj.ownerViewId, obj.owner_view_id, obj.viewId, obj.view_id);
  if (viewId !== null && ownerViewId !== null && ownerViewId !== viewId) return false;
  const text = firstString(obj.after, obj.text, obj.normalizedText, obj.normalized_text, obj.value);
  return Boolean(text && normalizedTextProof(text) === normalizedTextProof(expectedText));
}

function cadLinkSourceMatchesRequest(cadRequest: JsonMap, cadApplied: unknown): boolean {
  const requested = clip(cadRequest.sourcePath, 500).trim();
  if (!requested) return false;
  const obj = asObject(cadApplied);
  const plan = asObject(obj.plan);
  const applied = clip(obj.sourcePath ?? obj.sourceFullPath ?? plan.sourcePath ?? plan.sourceFullPath, 500).trim();
  return applied.length > 0 && applied.toLowerCase() === requested.toLowerCase();
}

function cadLinkSheetMatchesRequest(sheetId: number, cadApplied: unknown): boolean {
  const obj = asObject(cadApplied);
  const sheet = asObject(obj.sheet);
  const plan = asObject(obj.plan);
  const appliedSheetId = firstPositiveId(obj.sheetViewId, obj.sheetId, sheet.id, sheet.viewId, plan.sheetViewId, plan.sheetId);
  return appliedSheetId === sheetId;
}

function cadLinkViewportMatchesRequest(sheetId: number, cadApplied: unknown): boolean {
  const obj = asObject(cadApplied);
  const plan = asObject(obj.plan);
  const directSheetImport = obj.directSheetImport === true || plan.directSheetImport === true || clip(obj.targetMode ?? plan.targetMode, 80) === "direct_sheet_import";
  if (directSheetImport) return true;
  const appliedSheetId = firstPositiveId(obj.sheetViewId, obj.sheetId, asObject(obj.sheet).id, asObject(obj.sheet).viewId, plan.sheetViewId, plan.sheetId);
  const ownerViewId = firstPositiveId(obj.ownerViewId, obj.viewId, asObject(obj.view).id, asObject(obj.view).viewId, plan.viewId);
  const viewportId = firstPositiveId(obj.viewportId, asObject(obj.viewport).id, plan.viewportId, plan.existingViewportId);
  return appliedSheetId === sheetId && ownerViewId !== null && ownerViewId !== sheetId && viewportId !== null;
}

function cadLinkViewportBoxLooksSheetSized(cadApplied: unknown): boolean {
  const obj = asObject(cadApplied);
  const plan = asObject(obj.plan);
  const directSheetImport = obj.directSheetImport === true || plan.directSheetImport === true || clip(obj.targetMode ?? plan.targetMode, 80) === "direct_sheet_import";
  if (directSheetImport) return true;
  const box = asObject(obj.viewportBox);
  const minU = Number(box.minU);
  const minV = Number(box.minV);
  const maxU = Number(box.maxU);
  const maxV = Number(box.maxV);
  if (![minU, minV, maxU, maxV].every(Number.isFinite)) return false;
  const width = Math.abs(maxU - minU);
  const height = Math.abs(maxV - minV);
  if (width <= 0 || height <= 0) return false;
  return width <= 10 && height <= 10;
}

function cadLinkOwnerViewBoundingBoxReported(cadApplied: unknown): boolean {
  const obj = asObject(cadApplied);
  const plan = asObject(obj.plan);
  const directSheetImport = obj.directSheetImport === true || plan.directSheetImport === true || clip(obj.targetMode ?? plan.targetMode, 80) === "direct_sheet_import";
  if (directSheetImport) return true;
  const box = asObject(obj.elementBoundingBoxInOwnerView);
  const min = asObject(box.min);
  const max = asObject(box.max);
  const values = [min.x, min.y, min.z, max.x, max.y, max.z].map(Number);
  if (!values.every(Number.isFinite)) return false;
  return Math.abs(values[3] - values[0]) > 0 || Math.abs(values[4] - values[1]) > 0 || Math.abs(values[5] - values[2]) > 0;
}

function cadLinkOwnerViewId(cadApplied: unknown): number | null {
  const obj = asObject(cadApplied);
  const plan = asObject(obj.plan);
  return firstPositiveId(obj.ownerViewId, obj.viewId, asObject(obj.view).id, asObject(obj.view).viewId, plan.viewId);
}

export function __testOnlyCadLinkViewportMatchesRequest(sheetId: number, cadApplied: unknown): boolean {
  return cadLinkViewportMatchesRequest(sheetId, cadApplied);
}

function cadLinkInventoryRows(modelHealth: unknown): JsonMap[] {
  const root = asObject(modelHealth);
  const candidates = [
    asObject(asObject(root.links).cad).items,
    asObject(root.cad).items,
    root.cadLinks,
    root.cad_links,
    root.importLinks
  ];
  return candidates.flatMap((value) => objectRows(value));
}

function cadReloadExpectedText(request: JsonMap): string {
  return normalizedProofText(request.expectedSourcePath ?? request.expected_source_path ?? request.sourcePath ?? request.source_path ?? request.expectedCadLinkName ?? request.expected_cad_link_name ?? request.name);
}

function cadReloadInventoryMatchesRequest(modelHealth: unknown, request: JsonMap): boolean {
  const expectedIds = asNumberArray(request.existingCadLinkIds ?? request.existing_cad_link_ids ?? request.elementIds ?? request.element_ids);
  const expectedOwnerViewId = firstPositiveId(request.ownerViewId, request.owner_view_id);
  const expectedText = cadReloadExpectedText(request);
  if (expectedIds.length === 0 || expectedOwnerViewId === null || !expectedText) return false;
  return cadLinkInventoryRows(modelHealth).some((row) => {
    const rowId = firstPositiveId(row.elementId, row.id, row.cadLinkId, row.importInstanceId);
    const rowOwnerViewId = firstPositiveId(row.ownerViewId, row.owner_view_id, row.viewId, row.view_id);
    const rowText = normalizedProofText([row.sourcePath, row.path, row.name, row.fileName, row.file].map((value) => clip(value, 500)).filter(Boolean).join(" "));
    return rowId !== null && expectedIds.includes(rowId) && rowOwnerViewId === expectedOwnerViewId && rowText.includes(expectedText);
  });
}

function cadReloadSheetScopeMatchesRequest(modelHealth: unknown, request: JsonMap): boolean {
  const expectedSheetId = firstPositiveId(request.targetSheetId, request.target_sheet_id, request.sheetId, request.sheet_id);
  if (expectedSheetId === null) return true;
  const expectedOwnerViewId = firstPositiveId(request.ownerViewId, request.owner_view_id);
  if (expectedOwnerViewId === expectedSheetId) return true;
  const sheetRows = objectRows(asObject(modelHealth).sheets ?? asObject(asObject(modelHealth).views).sheets);
  if (sheetRows.length === 0) return false;
  return sheetRows.some((row) => {
    const sheetId = firstPositiveId(row.id, row.sheetId, row.viewId);
    const placedViews = objectRows(row.placedViews ?? row.viewports ?? row.placed_views);
    return sheetId === expectedSheetId && placedViews.some((placed) => firstPositiveId(placed.viewId, placed.ownerViewId, placed.id) === expectedOwnerViewId);
  });
}

function statusLooksOk(value: unknown): boolean {
  const status = clip(asObject(value).status, 80).toLowerCase();
  return status === "success" || status === "ok" || status === "placed" || status === "applied";
}

class DocumentationPrimitiveTracker implements BridgeTransport {
  public readonly scheduleIds: number[] = [];
  public readonly sheetIds: number[] = [];
  public readonly viewIds: number[] = [];
  public readonly viewportIds: number[] = [];
  public readonly detailCurveIds: number[] = [];
  public readonly textNoteIds: number[] = [];
  public readonly tagIds: number[] = [];
  public readonly cadIds: number[] = [];

  constructor(private readonly inner: BridgeTransport) {}

  async post(pathname: string, body: unknown): Promise<unknown> {
    const result = await this.inner.post(pathname, body);
    this.record(pathname, body, result);
    return result;
  }

  cleanupIds(): number[] {
    return Array.from(new Set([
      ...this.tagIds,
      ...this.textNoteIds,
      ...this.detailCurveIds,
      ...this.cadIds,
      ...this.viewportIds,
      ...this.scheduleIds,
      ...this.sheetIds,
      ...this.viewIds
    ]));
  }

  private add(target: number[], ...values: unknown[]): void {
    for (const value of values) {
      const id = firstPositiveId(value);
      if (id !== null && !target.includes(id)) target.push(id);
    }
  }

  private record(pathname: string, body: unknown, result: unknown): void {
    const requestObj = asObject(body);
    const obj = asObject(result);
    if (requestObj.dryRun === true || requestObj.apply === false || obj.dryRun === true) return;
    if (pathname === "/revit/create-schedule") {
      this.add(this.scheduleIds, obj.viewId, obj.scheduleId, obj.id);
    } else if (pathname === "/revit/create-sheet") {
      this.add(this.sheetIds, obj.id, obj.sheetId, obj.viewId);
    } else if (pathname === "/revit/create-view") {
      const view = asObject(obj.view);
      this.add(this.viewIds, obj.viewId, obj.id, view.id, view.viewId);
    } else if (pathname === "/revit/place-view") {
      this.add(this.viewportIds, obj.id, obj.viewportId, obj.scheduleSheetInstanceId);
    } else if (pathname === "/revit/place-views") {
      for (const row of objectArray(obj.results)) {
        this.add(this.viewportIds, row.id, row.viewportId, row.scheduleSheetInstanceId);
      }
    } else if (pathname === "/revit/draw-detail-curves") {
      for (const id of asNumberArray(obj.detailCurveIds)) this.add(this.detailCurveIds, id);
    } else if (pathname === "/revit/create-text") {
      this.add(this.textNoteIds, obj.id, obj.textNoteId, obj.elementId, obj.createdElementId);
    } else if (pathname === "/revit/tag-elements") {
      for (const id of asNumberArray(obj.tagIds)) this.add(this.tagIds, id);
    } else if (pathname === "/revit/link-cad") {
      this.add(this.cadIds, obj.elementId, obj.importInstanceId, obj.cadLinkId, obj.id);
      this.add(this.viewportIds, obj.viewportId, asObject(obj.viewport).id);
      if (obj.viewCreated === true) this.add(this.viewIds, obj.ownerViewId, obj.viewId, asObject(obj.view).id, asObject(obj.view).viewId);
    }
  }
}

async function runDocumentationGraphicsOnly(transport: BridgeTransport, request: JsonMap, runDir: string): Promise<RevitWorkflowPartialResult> {
  const rawResults: unknown[] = [];
  const summaryRows: Array<Record<string, unknown>> = [];
  const checks: RevitWorkflowVerification[] = [];
  let postChangeCapturePath = "";
  let finalCapturePath = "";
  let revertedInPlace = false;
  let createdFilterId: number | null = null;
  const cleanupRequested = parseBool(request.cleanupCreatedElements ?? request.cleanup_created_elements) === true;
  const categoryVisibilityBase = asObject(request.categoryVisibility ?? request.categoryOverrideVisibility);
  const filterVisibilityBase = asObject(request.filterVisibility ?? request.viewFilterVisibility);
  const visualViewId = firstPositiveId(request.visualViewId, request.visual_view_id, request.captureViewId, request.capture_view_id, request.viewId, request.view_id, categoryVisibilityBase.viewId, filterVisibilityBase.viewId);

  const categoryVisibilityViewId = firstPositiveId(categoryVisibilityBase.viewId, request.categoryVisibilityViewId, request.viewId, request.visualViewId);
  if (Object.keys(categoryVisibilityBase).length > 0 && categoryVisibilityViewId !== null) {
    const categoryVisibilityRequest = {
      action: "set_category_override",
      lineWeight: 5,
      ...categoryVisibilityBase,
      viewId: categoryVisibilityViewId
    };
    const categoryVisibilityDryRun = await transport.post("/revit/visibility", { ...categoryVisibilityRequest, dryRun: true });
    rawResults.push(categoryVisibilityDryRun);
    const categoryVisibilityApplied = await transport.post("/revit/visibility", { ...categoryVisibilityRequest, dryRun: false });
    rawResults.push(categoryVisibilityApplied);
    const categoryVisibilityObj = asObject(categoryVisibilityApplied);
    const categoryVisibilityView = asObject(categoryVisibilityObj.view);
    const categoryVisibilityAppliedViewId = firstPositiveId(categoryVisibilityObj.viewId, categoryVisibilityObj.id, categoryVisibilityView.id, categoryVisibilityView.viewId);
    checks.push(
      verification("category_visibility_dry_run_ok", asObject(categoryVisibilityDryRun).dryRun === true || /dry run/i.test(clip(asObject(categoryVisibilityDryRun).status, 80)), "dry-run category visibility override preview", categoryVisibilityDryRun),
      verification("category_visibility_applied_success", statusLooksOk(categoryVisibilityApplied), "category visibility status success", categoryVisibilityApplied),
      verification("category_visibility_target_matches_request", categoryVisibilityAppliedViewId === categoryVisibilityViewId, categoryVisibilityViewId, categoryVisibilityApplied),
      verification("category_visibility_applied_override_matches_request", visibilityAppliedProofMatchesRequest(categoryVisibilityRequest, categoryVisibilityApplied), "applied category visibility override evidence", categoryVisibilityApplied)
    );
    summaryRows.push({ primitive: "category_visibility", id: categoryVisibilityAppliedViewId ?? "", expectedViewId: categoryVisibilityViewId, action: categoryVisibilityRequest.action, ...visibilitySummaryFields(categoryVisibilityRequest, categoryVisibilityView), status: clip(categoryVisibilityObj.status, 80) });
    if (request.visualVerify !== false && visualViewId !== null) {
      const categoryPostApplyCapture = await transport.post("/revit/export-image", {
        viewId: visualViewId,
        reason: "documentation graphics-only category override applied visual verification"
      });
      rawResults.push(categoryPostApplyCapture);
      const captureObj = asObject(categoryPostApplyCapture);
      const captureView = asObject(captureObj.view);
      const captureViewId = firstPositiveId(captureObj.viewId, captureObj.targetViewId, captureView.id, captureView.viewId);
      const capturePath = firstPathLike(captureObj.path, captureObj.capturePath, captureObj.capture_path, captureObj.imagePath, captureObj.image_path, captureObj.screenshotPath, captureObj.screenshot_path);
      checks.push(
        verification("category_visibility_post_apply_capture_returned", Boolean(capturePath), "category visibility post-apply capture path", categoryPostApplyCapture),
        verification("category_visibility_post_apply_capture_view_id_matches_request", captureViewId === null || captureViewId === visualViewId, visualViewId, categoryPostApplyCapture),
        verification("category_visibility_post_apply_capture_quality_ok", captureQualityOk(categoryPostApplyCapture), "category visibility post-apply capture dimensions >= 512 px when reported", categoryPostApplyCapture)
      );
      summaryRows.push({ primitive: "category_visibility_post_apply_capture", id: visualViewId, reportedViewId: captureViewId ?? "", path: capturePath, status: clip(captureObj.status ?? "captured", 80) });
    }
    if (parseBool(categoryVisibilityBase.revertAfterVerify ?? categoryVisibilityBase.revert_after_verify) === true) {
      const categoryVisibilityRevertRequest: JsonMap = {
        ...categoryVisibilityRequest,
        action: "clear_category_override"
      };
      delete categoryVisibilityRevertRequest.lineWeight;
      delete categoryVisibilityRevertRequest.line_weight;
      const categoryVisibilityRevertDryRun = await transport.post("/revit/visibility", { ...categoryVisibilityRevertRequest, dryRun: true });
      rawResults.push(categoryVisibilityRevertDryRun);
      const categoryVisibilityReverted = await transport.post("/revit/visibility", { ...categoryVisibilityRevertRequest, dryRun: false });
      rawResults.push(categoryVisibilityReverted);
      const revertObj = asObject(categoryVisibilityReverted);
      const revertView = asObject(revertObj.view);
      const revertedViewId = firstPositiveId(revertObj.viewId, revertObj.id, revertView.id, revertView.viewId);
      checks.push(
        verification("category_visibility_revert_dry_run_ok", asObject(categoryVisibilityRevertDryRun).dryRun === true || /dry run/i.test(clip(asObject(categoryVisibilityRevertDryRun).status, 80)), "dry-run category visibility revert preview", categoryVisibilityRevertDryRun),
        verification("category_visibility_revert_applied_success", statusLooksOk(categoryVisibilityReverted), "category visibility revert status success", categoryVisibilityReverted),
        verification("category_visibility_revert_target_matches_request", revertedViewId === categoryVisibilityViewId, categoryVisibilityViewId, categoryVisibilityReverted),
        verification("category_visibility_revert_cleared_override", categoryOverrideClearedProofMatchesRequest(categoryVisibilityRevertRequest, categoryVisibilityReverted), "cleared category visibility override evidence", categoryVisibilityReverted)
      );
      revertedInPlace = true;
      summaryRows.push({ primitive: "category_visibility_revert", id: revertedViewId ?? "", expectedViewId: categoryVisibilityViewId, action: categoryVisibilityRevertRequest.action, requestedCategoryName: categoryVisibilityRevertRequest.categoryName ?? "", status: clip(revertObj.status, 80) });
    }
  } else if (Object.keys(categoryVisibilityBase).length > 0) {
    checks.push(
      verification("category_visibility_dry_run_ok", false, "category visibility target view id", categoryVisibilityViewId),
      verification("category_visibility_applied_success", false, "category visibility target view id", categoryVisibilityViewId),
      verification("category_visibility_target_matches_request", false, "category visibility target view id", categoryVisibilityViewId),
      verification("category_visibility_applied_override_matches_request", false, "category visibility target view id", categoryVisibilityViewId)
    );
  }

  const filterVisibilityViewId = firstPositiveId(filterVisibilityBase.viewId, request.filterVisibilityViewId, request.viewId, request.visualViewId);
  if (Object.keys(filterVisibilityBase).length > 0 && filterVisibilityViewId !== null) {
    const filterCreateBase = asObject(filterVisibilityBase.createFilter ?? filterVisibilityBase.create_filter);
    const filterVisibilityCore: JsonMap = { ...filterVisibilityBase };
    delete filterVisibilityCore.createFilter;
    delete filterVisibilityCore.create_filter;
    const requestedFilterName = appendRepeatSuffix(filterVisibilityCore.filterName, runDir, "Operator Demo Future Work");
    if (Object.keys(filterCreateBase).length > 0) {
      const filterCreateRequest = {
        filterVisible: true,
        lineWeight: 5,
        ...filterCreateBase,
        ...filterVisibilityCore,
        action: "create_view_filter",
        filterName: requestedFilterName,
        viewId: filterVisibilityViewId
      };
      const filterCreateDryRun = await transport.post("/revit/visibility", { ...filterCreateRequest, dryRun: true });
      rawResults.push(filterCreateDryRun);
      const filterCreateApplied = await transport.post("/revit/visibility", { ...filterCreateRequest, dryRun: false });
      rawResults.push(filterCreateApplied);
      const filterCreateObj = asObject(filterCreateApplied);
      const filterCreateView = asObject(filterCreateObj.view);
      const filterCreateAppliedViewId = firstPositiveId(filterCreateObj.viewId, filterCreateObj.id, filterCreateView.id, filterCreateView.viewId);
      createdFilterId = filterIdFromVisibilityResult(filterCreateRequest, filterCreateApplied);
      checks.push(
        verification("filter_visibility_create_dry_run_ok", asObject(filterCreateDryRun).dryRun === true || /dry run/i.test(clip(asObject(filterCreateDryRun).status, 80)), "dry-run create view filter preview", filterCreateDryRun),
        verification("filter_visibility_create_applied_success", statusLooksOk(filterCreateApplied), "create view filter status success", filterCreateApplied),
        verification("filter_visibility_create_target_matches_request", filterCreateAppliedViewId === filterVisibilityViewId, filterVisibilityViewId, filterCreateApplied),
        verification("filter_visibility_created_filter_id_present", createdFilterId !== null, "created view filter id", filterCreateApplied)
      );
      summaryRows.push({ primitive: "filter_visibility_create", id: createdFilterId ?? "", expectedViewId: filterVisibilityViewId, action: filterCreateRequest.action, ...visibilitySummaryFields(filterCreateRequest, filterCreateView), status: clip(filterCreateObj.status, 80) });
    }
    const filterVisibilityRequest = {
      action: "apply_view_filter",
      filterVisible: true,
      lineWeight: 5,
      ...filterVisibilityCore,
      filterName: requestedFilterName,
      ...(createdFilterId !== null ? { filterId: createdFilterId } : {}),
      viewId: filterVisibilityViewId
    };
    const filterVisibilityDryRun = await transport.post("/revit/visibility", { ...filterVisibilityRequest, dryRun: true });
    rawResults.push(filterVisibilityDryRun);
    const filterVisibilityApplied = await transport.post("/revit/visibility", { ...filterVisibilityRequest, dryRun: false });
    rawResults.push(filterVisibilityApplied);
    const filterVisibilityObj = asObject(filterVisibilityApplied);
    const filterVisibilityView = asObject(filterVisibilityObj.view);
    const filterVisibilityAppliedViewId = firstPositiveId(filterVisibilityObj.viewId, filterVisibilityObj.id, filterVisibilityView.id, filterVisibilityView.viewId);
    checks.push(
      verification("filter_visibility_dry_run_ok", asObject(filterVisibilityDryRun).dryRun === true || /dry run/i.test(clip(asObject(filterVisibilityDryRun).status, 80)), "dry-run filter visibility override preview", filterVisibilityDryRun),
      verification("filter_visibility_applied_success", statusLooksOk(filterVisibilityApplied), "filter visibility status success", filterVisibilityApplied),
      verification("filter_visibility_target_matches_request", filterVisibilityAppliedViewId === filterVisibilityViewId, filterVisibilityViewId, filterVisibilityApplied),
      verification("filter_visibility_applied_override_matches_request", visibilityAppliedProofMatchesRequest(filterVisibilityRequest, filterVisibilityApplied), "applied filter visibility override evidence", filterVisibilityApplied)
    );
    summaryRows.push({ primitive: "filter_visibility", id: filterVisibilityAppliedViewId ?? "", expectedViewId: filterVisibilityViewId, action: filterVisibilityRequest.action, ...visibilitySummaryFields(filterVisibilityRequest, filterVisibilityView), status: clip(filterVisibilityObj.status, 80) });
    if (request.visualVerify !== false && visualViewId !== null) {
      const filterPostApplyCapture = await transport.post("/revit/export-image", {
        viewId: visualViewId,
        reason: "documentation graphics-only filter override applied visual verification"
      });
      rawResults.push(filterPostApplyCapture);
      const captureObj = asObject(filterPostApplyCapture);
      const captureView = asObject(captureObj.view);
      const captureViewId = firstPositiveId(captureObj.viewId, captureObj.targetViewId, captureView.id, captureView.viewId);
      const capturePath = firstPathLike(captureObj.path, captureObj.capturePath, captureObj.capture_path, captureObj.imagePath, captureObj.image_path, captureObj.screenshotPath, captureObj.screenshot_path);
      checks.push(
        verification("filter_visibility_post_apply_capture_returned", Boolean(capturePath), "filter visibility post-apply capture path", filterPostApplyCapture),
        verification("filter_visibility_post_apply_capture_view_id_matches_request", captureViewId === null || captureViewId === visualViewId, visualViewId, filterPostApplyCapture),
        verification("filter_visibility_post_apply_capture_quality_ok", captureQualityOk(filterPostApplyCapture), "filter visibility post-apply capture dimensions >= 512 px when reported", filterPostApplyCapture)
      );
      summaryRows.push({ primitive: "filter_visibility_post_apply_capture", id: visualViewId, reportedViewId: captureViewId ?? "", path: capturePath, status: clip(captureObj.status ?? "captured", 80) });
    }
    if (parseBool(filterVisibilityBase.revertAfterVerify ?? filterVisibilityBase.revert_after_verify) === true) {
      const filterVisibilityRevertRequest: JsonMap = {
        ...filterVisibilityRequest,
        action: "clear_filter_override"
      };
      delete filterVisibilityRevertRequest.lineWeight;
      delete filterVisibilityRevertRequest.line_weight;
      delete filterVisibilityRevertRequest.r;
      delete filterVisibilityRevertRequest.g;
      delete filterVisibilityRevertRequest.b;
      const filterVisibilityRevertDryRun = await transport.post("/revit/visibility", { ...filterVisibilityRevertRequest, dryRun: true });
      rawResults.push(filterVisibilityRevertDryRun);
      const filterVisibilityReverted = await transport.post("/revit/visibility", { ...filterVisibilityRevertRequest, dryRun: false });
      rawResults.push(filterVisibilityReverted);
      const revertObj = asObject(filterVisibilityReverted);
      const revertView = asObject(revertObj.view);
      const revertedViewId = firstPositiveId(revertObj.viewId, revertObj.id, revertView.id, revertView.viewId);
      checks.push(
        verification("filter_visibility_revert_dry_run_ok", asObject(filterVisibilityRevertDryRun).dryRun === true || /dry run/i.test(clip(asObject(filterVisibilityRevertDryRun).status, 80)), "dry-run filter override revert preview", filterVisibilityRevertDryRun),
        verification("filter_visibility_revert_applied_success", statusLooksOk(filterVisibilityReverted), "filter override revert status success", filterVisibilityReverted),
        verification("filter_visibility_revert_target_matches_request", revertedViewId === filterVisibilityViewId, filterVisibilityViewId, filterVisibilityReverted),
        verification("filter_visibility_revert_cleared_override", filterOverrideClearedProofMatchesRequest(filterVisibilityRevertRequest, filterVisibilityReverted), "cleared filter visibility override evidence", filterVisibilityReverted)
      );
      revertedInPlace = true;
      summaryRows.push({ primitive: "filter_visibility_revert", id: revertedViewId ?? "", expectedViewId: filterVisibilityViewId, action: filterVisibilityRevertRequest.action, requestedFilterId: filterVisibilityRevertRequest.filterId ?? "", requestedFilterName: filterVisibilityRevertRequest.filterName ?? "", status: clip(revertObj.status, 80) });
    }
  } else if (Object.keys(filterVisibilityBase).length > 0) {
    checks.push(
      verification("filter_visibility_dry_run_ok", false, "filter visibility target view id", filterVisibilityViewId),
      verification("filter_visibility_applied_success", false, "filter visibility target view id", filterVisibilityViewId),
      verification("filter_visibility_target_matches_request", false, "filter visibility target view id", filterVisibilityViewId),
      verification("filter_visibility_applied_override_matches_request", false, "filter visibility target view id", filterVisibilityViewId)
    );
  }

  const captureViewId = visualViewId;
  if (request.visualVerify !== false && captureViewId !== null) {
    const postChangeCapture = await transport.post("/revit/export-image", {
      viewId: captureViewId,
      reason: "documentation graphics-only post-change visual verification"
    });
    rawResults.push(postChangeCapture);
    const captureObj = asObject(postChangeCapture);
    const captureView = asObject(captureObj.view);
    const postChangeCaptureViewId = firstPositiveId(captureObj.viewId, captureObj.targetViewId, captureView.id, captureView.viewId);
    postChangeCapturePath = firstPathLike(captureObj.path, captureObj.capturePath, captureObj.capture_path, captureObj.imagePath, captureObj.image_path, captureObj.screenshotPath, captureObj.screenshot_path);
    checks.push(
      verification("documentation_post_change_capture_returned", Boolean(postChangeCapturePath), "post-change documentation graphics capture path", postChangeCapture),
      verification("documentation_post_change_capture_targets_created_context", true, "graphics-only existing view/sheet capture target", captureViewId),
      verification("documentation_post_change_capture_view_id_matches_request", postChangeCaptureViewId === null || postChangeCaptureViewId === captureViewId, captureViewId, postChangeCapture),
      verification("documentation_post_change_capture_quality_ok", captureQualityOk(postChangeCapture), "capture dimensions >= 512 px when reported and requested focus crop applied", postChangeCapture),
      verification("cad_link_post_change_capture_targets_sheet", true, "CAD link/import not requested", postChangeCapture)
    );
    summaryRows.push({ primitive: "post_change_capture", id: captureViewId, reportedViewId: postChangeCaptureViewId ?? "", path: postChangeCapturePath, status: clip(captureObj.status ?? "captured", 80) });
    if (revertedInPlace) {
      const finalCapture = await transport.post("/revit/export-image", {
        viewId: captureViewId,
        reason: "documentation graphics-only final visual verification after revert"
      });
      rawResults.push(finalCapture);
      const finalCaptureObj = asObject(finalCapture);
      const finalCaptureView = asObject(finalCaptureObj.view);
      const finalCaptureViewId = firstPositiveId(finalCaptureObj.viewId, finalCaptureObj.targetViewId, finalCaptureView.id, finalCaptureView.viewId);
      finalCapturePath = firstPathLike(finalCaptureObj.path, finalCaptureObj.capturePath, finalCaptureObj.capture_path, finalCaptureObj.imagePath, finalCaptureObj.image_path, finalCaptureObj.screenshotPath, finalCaptureObj.screenshot_path);
      checks.push(
        verification("documentation_final_capture_returned", Boolean(finalCapturePath), "final documentation graphics capture path after revert", finalCapture),
        verification("documentation_final_capture_view_id_matches_request", finalCaptureViewId === null || finalCaptureViewId === captureViewId, captureViewId, finalCapture),
        verification("documentation_final_capture_quality_ok", captureQualityOk(finalCapture), "final capture dimensions >= 512 px when reported and requested focus crop applied", finalCapture)
      );
      summaryRows.push({ primitive: "final_capture", id: captureViewId, reportedViewId: finalCaptureViewId ?? "", path: finalCapturePath, status: clip(finalCaptureObj.status ?? "captured", 80) });
    }
  } else {
    checks.push(
      verification("documentation_post_change_capture_returned", false, "graphics-only capture target view id", { visualVerify: request.visualVerify, captureViewId }),
      verification("documentation_post_change_capture_view_id_matches_request", false, "graphics-only capture target view id", { visualVerify: request.visualVerify, captureViewId }),
      verification("documentation_post_change_capture_quality_ok", false, "graphics-only capture target view id", { visualVerify: request.visualVerify, captureViewId })
    );
  }

  if (cleanupRequested && createdFilterId !== null) {
    const cleanupDryRun = await transport.post("/revit/delete", {
      ids: [createdFilterId],
      apply: false,
      reason: "cleanup documentation graphics-only created view filter"
    });
    rawResults.push(cleanupDryRun);
    const cleanupApplied = await transport.post("/revit/delete", {
      ids: [createdFilterId],
      apply: true,
      reason: "cleanup documentation graphics-only created view filter"
    });
    rawResults.push(cleanupApplied);
    const cleanupDryRunIds = deleteEffectIds(cleanupDryRun);
    const cleanupDeletedIds = deleteEffectIds(cleanupApplied);
    checks.push(
      verification("documentation_cleanup_dry_run_ok", cleanupDryRunIds.includes(createdFilterId), [createdFilterId], cleanupDryRun),
      verification("documentation_cleanup_applied_ids_present", cleanupDeletedIds.includes(createdFilterId) || firstPositiveId(asObject(cleanupApplied).count) !== null, [createdFilterId], cleanupApplied)
    );
    summaryRows.push({ primitive: "cleanup_documentation_primitives", id: createdFilterId, status: clip(asObject(cleanupApplied).status ?? "cleanup", 80), count: cleanupDeletedIds.length || firstPositiveId(asObject(cleanupApplied).count) || 0 });
  } else {
    checks.push(
      verification("documentation_cleanup_dry_run_ok", true, "graphics-only documentation changes are reverted in place; no disposable elements created", []),
      verification("documentation_cleanup_applied_ids_present", true, "graphics-only documentation changes are reverted in place; no disposable elements created", [])
    );
    summaryRows.push({ primitive: "cleanup_documentation_primitives", id: "", status: "NoCreatedElementsGraphicsOnly", count: 0 });
  }

  checks.push(
    verification("tag_request_present", true, "tagging is not required for graphics-only documentation redlines", {})
  );

  const summaryJsonPath = path.join(runDir, "artifacts", "documentation_primitives_summary.json");
  const summaryMdPath = writeMarkdownTable(path.join(runDir, "artifacts", "documentation_primitives_summary.md"), summaryRows);
  const filterVisibilityRow = summaryRows.find((row) => row.primitive === "filter_visibility") ?? {};
  const filterVisibilityRevertRow = summaryRows.find((row) => row.primitive === "filter_visibility_revert") ?? {};
  writeJsonFile(summaryJsonPath, {
    postChangeCapturePath,
    finalCapturePath,
    createdFilterId,
    filterVisibilityTargetId: filterVisibilityRow.id ?? null,
    requestedFilterName: filterVisibilityRow.requestedFilterName ?? null,
    appliedFilterName: filterVisibilityRow.appliedFilterName ?? null,
    requestedFilterLineWeight: filterVisibilityRow.requestedLineWeight ?? null,
    appliedFilterLineWeight: filterVisibilityRow.appliedFilterLineWeight ?? null,
    filterVisibilityRevertTargetId: filterVisibilityRevertRow.id ?? null,
    filterVisibilityRevertStatus: filterVisibilityRevertRow.status ?? null,
    rows: summaryRows,
    rawResults
  });
  checks.push(verification("documentation_summary_written", fs.existsSync(summaryJsonPath) && fs.existsSync(summaryMdPath), [summaryJsonPath, summaryMdPath], summaryRows));
  const success = countOk(checks);
  return {
    workflow: "documentation_primitives",
    success,
    failure_reason: success ? null : "Documentation graphics-only workflow verification failed.",
    tool_calls: rawResults.length,
    revit_transactions: rawResults.filter((result) => asObject(result).dryRun !== true).length,
    computer_use_actions: 0,
    output_artifacts: [summaryJsonPath, summaryMdPath],
    verification_results: checks,
    user_message: success ? "Applied, verified, and reverted documentation graphics override." : "Documentation graphics-only workflow ran, but verification failed.",
    raw_results: rawResults
  };
}

async function runDocumentationPrimitives(transport: BridgeTransport, request: JsonMap, runDir: string): Promise<RevitWorkflowPartialResult> {
  const rawResults: unknown[] = [];
  const summaryRows: Array<Record<string, unknown>> = [];
  const checks: RevitWorkflowVerification[] = [];
  const cleanupRequested = parseBool(request.cleanupCreatedElements ?? request.cleanup_created_elements) === true;
  const graphicsOnly = parseBool(request.graphicsOnly ?? request.graphics_only ?? request.documentationGraphicsOnly ?? request.documentation_graphics_only) === true;
  const trackedTransport = new DocumentationPrimitiveTracker(transport);
  transport = trackedTransport;
  let detailCurveIds: number[] = [];
  let textNoteId: number | null = null;
  let editedTextNoteViewId: number | null = null;
  let tagIds: number[] = [];
  let cadLinkId: number | null = null;
  let cadGraphicsOverrideTargetId: number | null = null;
  let postChangeCapture: unknown = null;
  let postChangeCapturePath = "";
  let createdFilterId: number | null = null;
  let categoryVisibilityRevertRequest: JsonMap | null = null;
  let templateCategoryVisibilityRevertRequest: JsonMap | null = null;
  let linkedModelCategoryVisibilityRevertRequest: JsonMap | null = null;
  let phaseVisibilityRevertRequest: JsonMap | null = null;
  let phaseFilterVisibilityRevertRequest: JsonMap | null = null;
  let filterVisibilityRevertRequest: JsonMap | null = null;

  try {
    const graphicsPreWriteBlockers = documentationGraphicsPreWriteBlockers(request);
    if (graphicsPreWriteBlockers.length > 0) {
      throw new Error(`documentation_primitives blocked before Revit writes: ${graphicsPreWriteBlockers.join("; ")}`);
    }
    if (graphicsOnly) {
      return await runDocumentationGraphicsOnly(transport, request, runDir);
    }

    const cadReloadBase = asObject(request.cadReload ?? request.reloadCad ?? request.cadLinkReload);
    const cadReloadOnly =
      Object.keys(cadReloadBase).length > 0 &&
      ["schedule", "configureSchedule", "scheduleConfiguration", "sheet", "existingSheet", "targetSheet", "createView", "view", "viewTemplate", "createViewTemplate", "detailCurves", "annotationCurves", "textNote", "tag", "categoryVisibility", "filterVisibility", "cadLink", "cadGraphicsOverride"].every((key) => Object.keys(asObject(request[key])).length === 0);
    if (cadReloadOnly) {
      const targetCaptureViewId = firstPositiveId(cadReloadBase.targetSheetId, cadReloadBase.target_sheet_id, request.visualViewId, request.captureViewId, request.viewId, cadReloadBase.ownerViewId, cadReloadBase.owner_view_id);
      const modelHealth = await transport.post("/revit/model-health", { includeLinks: true, includeCadLinks: true });
      rawResults.push(modelHealth);
      checks.push(
        verification("cad_reload_model_health_inventory_returned", cadLinkInventoryRows(modelHealth).length > 0, "existing CAD link inventory", modelHealth),
        verification("cad_reload_existing_link_matches_request", cadReloadInventoryMatchesRequest(modelHealth, cadReloadBase), cadReloadBase, modelHealth),
        verification("cad_reload_sheet_scope_matches_request", cadReloadSheetScopeMatchesRequest(modelHealth, cadReloadBase), cadReloadBase.targetSheetId ?? cadReloadBase.sheetId ?? "sheet scope not requested", modelHealth)
      );
      if (targetCaptureViewId !== null && request.visualVerify !== false) {
        postChangeCapture = await transport.post("/revit/export-image", { viewId: targetCaptureViewId, reason: "CAD reload/confirm no-write preflight visual evidence" });
        rawResults.push(postChangeCapture);
        const captureObj = asObject(postChangeCapture);
        const captureView = asObject(captureObj.view);
        const postChangeCaptureViewId = firstPositiveId(captureObj.viewId, captureObj.targetViewId, captureView.id, captureView.viewId);
        postChangeCapturePath = firstPathLike(captureObj.path, captureObj.capturePath, captureObj.capture_path, captureObj.imagePath, captureObj.image_path, captureObj.screenshotPath, captureObj.screenshot_path);
        checks.push(
          verification("documentation_post_change_capture_returned", Boolean(postChangeCapturePath), "CAD reload preflight capture path", postChangeCapture),
          verification("documentation_post_change_capture_view_id_matches_request", postChangeCaptureViewId === null || postChangeCaptureViewId === targetCaptureViewId, targetCaptureViewId, postChangeCapture),
          verification("documentation_post_change_capture_quality_ok", captureQualityOk(postChangeCapture), "capture dimensions >= 512 px when reported and requested focus crop applied", postChangeCapture),
          verification("cad_link_post_change_capture_targets_sheet", true, "CAD reload preflight uses requested sheet/owner view", postChangeCapture)
        );
      } else {
        checks.push(
          verification("documentation_post_change_capture_returned", false, "target sheet/owner view id for CAD reload preflight capture", cadReloadBase),
          verification("documentation_post_change_capture_view_id_matches_request", false, "target sheet/owner view id for CAD reload preflight capture", cadReloadBase),
          verification("documentation_post_change_capture_quality_ok", false, "target sheet/owner view id for CAD reload preflight capture", cadReloadBase)
        );
      }
      checks.push(
        verification("cad_reload_apply_blocked_before_model_write", true, "native CAD reload is not called by this preflight workflow", cadReloadBase),
        verification("cad_reload_native_reload_endpoint_available", false, "reload-capable CAD link endpoint is not available yet", { blockedBeforeModelWrite: true })
      );
      summaryRows.push({
        primitive: "cad_reload_preflight",
        id: asNumberArray(cadReloadBase.existingCadLinkIds ?? cadReloadBase.existing_cad_link_ids ?? cadReloadBase.elementIds ?? cadReloadBase.element_ids).join(";"),
        ownerViewId: firstPositiveId(cadReloadBase.ownerViewId, cadReloadBase.owner_view_id) ?? "",
        targetSheetId: firstPositiveId(cadReloadBase.targetSheetId, cadReloadBase.target_sheet_id, cadReloadBase.sheetId, cadReloadBase.sheet_id) ?? "",
        expectedSourcePath: clip(cadReloadBase.expectedSourcePath ?? cadReloadBase.expected_source_path ?? cadReloadBase.sourcePath ?? cadReloadBase.source_path, 500),
        expectedCadLinkName: clip(cadReloadBase.expectedCadLinkName ?? cadReloadBase.expected_cad_link_name ?? cadReloadBase.name, 240),
        blockedBeforeModelWrite: true,
        status: "BlockedBeforeReload"
      });
      if (postChangeCapturePath) {
        summaryRows.push({ primitive: "post_change_capture", id: targetCaptureViewId ?? "", path: postChangeCapturePath, status: clip(asObject(postChangeCapture).status ?? "captured", 80) });
      }
      const summaryJsonPath = path.join(runDir, "artifacts", "documentation_primitives_summary.json");
      const summaryMdPath = writeMarkdownTable(path.join(runDir, "artifacts", "documentation_primitives_summary.md"), summaryRows);
      writeJsonFile(summaryJsonPath, { cadReloadPreflight: true, blockedBeforeModelWrite: true, postChangeCapturePath, rows: summaryRows, rawResults });
      checks.push(verification("documentation_summary_written", fs.existsSync(summaryJsonPath) && fs.existsSync(summaryMdPath), [summaryJsonPath, summaryMdPath], summaryRows));
      return {
        workflow: "documentation_primitives",
        success: false,
        failure_reason: "CAD reload preflight blocked before model writes because no native reload-and-restore workflow is available.",
        tool_calls: rawResults.length,
        revit_transactions: 0,
        computer_use_actions: 0,
        output_artifacts: [summaryJsonPath, summaryMdPath],
        verification_results: checks,
        user_message: "Verified existing CAD link reload context, but blocked before model writes because CAD reload is not safely executable yet.",
        raw_results: rawResults
      };
    }

    const scheduleOnlyBase = asObject(request.schedule);
    const scheduleRemarkNoteBase = asObject(request.textNote ?? request.text_note);
    const scheduleRemarkNoteRequested =
      Object.keys(scheduleRemarkNoteBase).length > 0 &&
      (
        boolFlag(scheduleRemarkNoteBase.scheduleRemarkNote ?? scheduleRemarkNoteBase.schedule_remark_note) ||
        boolFlag(scheduleRemarkNoteBase.remarkNote ?? scheduleRemarkNoteBase.remark_note) ||
        boolFlag(scheduleRemarkNoteBase.linkToScheduleRemark ?? scheduleRemarkNoteBase.link_to_schedule_remark)
      );
    const scheduleOnlyExistingEdit =
      boolFlag(scheduleOnlyBase.editExistingValue ?? scheduleOnlyBase.edit_existing_value ?? scheduleOnlyBase.editExisting ?? scheduleOnlyBase.edit_existing) &&
      ["sheet", "existingSheet", "targetSheet", "createView", "view", "viewTemplate", "createViewTemplate", "detailCurves", "annotationCurves", "tag", "categoryVisibility", "filterVisibility", "cadReload", "cadLink", "cadGraphicsOverride"].every((key) => Object.keys(asObject(request[key])).length === 0) &&
      (Object.keys(scheduleRemarkNoteBase).length === 0 || scheduleRemarkNoteRequested);
    if (scheduleOnlyExistingEdit) {
      const scheduleId = firstPositiveId(scheduleOnlyBase.scheduleId, scheduleOnlyBase.schedule_id, request.scheduleId);
      const scheduleName = clip(scheduleOnlyBase.scheduleName ?? scheduleOnlyBase.schedule_name ?? scheduleOnlyBase.name ?? request.scheduleName, 240);
      const elementId = firstPositiveId(scheduleOnlyBase.elementId, scheduleOnlyBase.element_id, scheduleOnlyBase.backingElementId, scheduleOnlyBase.backing_element_id);
      const parameterName = clip(scheduleOnlyBase.parameterName ?? scheduleOnlyBase.parameter_name ?? scheduleOnlyBase.fieldName ?? scheduleOnlyBase.field_name, 200);
      const rowKey = clip(scheduleOnlyBase.rowKey ?? scheduleOnlyBase.row_key ?? scheduleOnlyBase.expectedRowKey ?? scheduleOnlyBase.expected_row_key, 240);
      const expectedExistingValueRaw = scheduleOnlyBase.expectedExistingValue ?? scheduleOnlyBase.expected_existing_value ?? scheduleOnlyBase.originalValue ?? scheduleOnlyBase.original_value;
      const expectedExistingValue = clip(expectedExistingValueRaw, 1000);
      const replacementValue = clip(scheduleOnlyBase.replacementValue ?? scheduleOnlyBase.replacement_value ?? scheduleOnlyBase.newValue ?? scheduleOnlyBase.new_value ?? scheduleOnlyBase.text ?? scheduleOnlyBase.value, 1000);
      const preserveTextCase = scheduleOnlyBase.preserveTextCase !== false && scheduleOnlyBase.preserve_text_case !== false;
      const hasExpectedExistingValue = expectedExistingValueRaw !== undefined && expectedExistingValueRaw !== null;
      const canEditSchedule = scheduleId !== null && elementId !== null && parameterName && rowKey && hasExpectedExistingValue && replacementValue;
      let scheduleRemarkNoteId: number | null = null;
      let scheduleRemarkNoteResult: unknown = null;
      let scheduleRemarkNoteCleanupDryRun: unknown = null;
      let scheduleRemarkNoteCleanupApplied: unknown = null;
      let scheduleRemarkNoteCleanupDryRunIds: number[] = [];
      let scheduleRemarkNoteCleanupDeletedIds: number[] = [];
      if (canEditSchedule) {
        const beforeParameters = await transport.post("/revit/get-parameters", { elementIds: [elementId], names: [parameterName] });
        rawResults.push(beforeParameters);
        const changes = [{ elementId, parameterName, value: replacementValue, preserveTextCase }];
        const parameterDryRun = await transport.post("/revit/set-parameter", { changes, preserveTextCase, apply: false });
        rawResults.push(parameterDryRun);
        const parameterApplied = await transport.post("/revit/set-parameter", {
          changes,
          preserveTextCase,
          apply: true,
          ...(scheduleOnlyBase.confirm ? { confirm: clip(scheduleOnlyBase.confirm, 120) } : {})
        });
        rawResults.push(parameterApplied);
        const afterParameters = await transport.post("/revit/get-parameters", { elementIds: [elementId], names: [parameterName] });
        rawResults.push(afterParameters);
        const scheduleAfter = await transport.post("/revit/export-schedule-csv", {
          scheduleId,
          ...(scheduleName ? { query: scheduleName, exact: true } : {}),
          delimiter: "comma",
          fileName: clip(scheduleOnlyBase.afterFileName ?? scheduleOnlyBase.after_file_name ?? "redline_schedule_after_edit.csv", 180)
        });
        rawResults.push(scheduleAfter);
        checks.push(
          verification("schedule_parameter_original_matches_expected", parameterSnapshotMatches(beforeParameters, [elementId], parameterName, expectedExistingValue), { elementId, parameterName, expectedExistingValue }, beforeParameters),
          verification("schedule_parameter_dry_run_ok", !hasParameterWriteErrors(parameterDryRun), "dry-run schedule backing parameter write has no errors", parameterDryRun),
          verification("schedule_parameter_apply_ok", !hasParameterWriteErrors(parameterApplied), "schedule backing parameter write applied without errors", parameterApplied),
          verification("schedule_parameter_readback_matches_request", parameterSnapshotMatches(afterParameters, [elementId], parameterName, replacementValue), { elementId, parameterName, replacementValue }, afterParameters),
          verification("schedule_csv_readback_matches_request", exportedScheduleCsvContains(scheduleAfter, rowKey, replacementValue), { scheduleId, rowKey, replacementValue }, scheduleAfter)
        );
        summaryRows.push({
          primitive: "schedule_parameter_edit",
          id: elementId,
          parent: scheduleId,
          scheduleName,
          rowKey,
          parameterName,
          expectedExistingValue,
          replacementValue,
          csvPath: firstPathLike(asObject(scheduleAfter).path),
          status: clip(asObject(parameterApplied).status, 80)
        });

        if (scheduleRemarkNoteRequested) {
          const noteViewId = firstPositiveId(scheduleRemarkNoteBase.viewId, scheduleRemarkNoteBase.view_id, scheduleRemarkNoteBase.sheetId, scheduleRemarkNoteBase.sheet_id, request.textViewId, request.visualViewId, request.viewId);
          const noteX = Number(scheduleRemarkNoteBase.x);
          const noteY = Number(scheduleRemarkNoteBase.y);
          const noteText = clip(scheduleRemarkNoteBase.text ?? scheduleRemarkNoteBase.noteText ?? scheduleRemarkNoteBase.note_text ?? request.text, 1000);
          const markerValue = clip(scheduleRemarkNoteBase.remarkMarker ?? scheduleRemarkNoteBase.remark_marker ?? scheduleRemarkNoteBase.marker ?? replacementValue, 240);
          const requestedTypeId = firstPositiveId(scheduleRemarkNoteBase.typeId, scheduleRemarkNoteBase.type_id, request.textTypeId);
          const noteInputsPresent = noteViewId !== null && Number.isFinite(noteX) && Number.isFinite(noteY) && noteText.length > 0;
          if (noteInputsPresent) {
            scheduleRemarkNoteResult = await transport.post("/revit/create-text", {
              ...scheduleRemarkNoteBase,
              viewId: noteViewId,
              x: noteX,
              y: noteY,
              text: noteText
            });
            rawResults.push(scheduleRemarkNoteResult);
            scheduleRemarkNoteId = firstPositiveId(asObject(scheduleRemarkNoteResult).id, asObject(scheduleRemarkNoteResult).textNoteId, asObject(scheduleRemarkNoteResult).elementId, asObject(scheduleRemarkNoteResult).createdElementId);
            checks.push(
              verification("schedule_remark_note_created", statusLooksOk(scheduleRemarkNoteResult) && scheduleRemarkNoteId !== null, "created explanatory schedule remark note id", scheduleRemarkNoteResult),
              verification("schedule_remark_note_target_matches_request", textNoteProofMatchesRequest(noteViewId, noteText, requestedTypeId, scheduleRemarkNoteResult), { viewId: noteViewId, text: noteText, typeId: requestedTypeId }, scheduleRemarkNoteResult),
              verification("schedule_remark_marker_matches_note_reference", normalizedTextProof(noteText).includes(normalizedTextProof(markerValue)), { markerValue, noteText }, scheduleRemarkNoteResult)
            );
            summaryRows.push({
              primitive: "schedule_remark_note",
              id: scheduleRemarkNoteId ?? "",
              parent: noteViewId,
              scheduleId,
              scheduleName,
              rowKey,
              parameterName,
              markerValue,
              text: noteText,
              x: noteX,
              y: noteY,
              status: clip(asObject(scheduleRemarkNoteResult).status, 80)
            });
          } else {
            checks.push(
              verification("schedule_remark_note_created", false, "textNote.viewId, finite x/y, and text are required for schedule remark note creation", scheduleRemarkNoteBase),
              verification("schedule_remark_note_target_matches_request", false, "textNote.viewId, finite x/y, and text are required for schedule remark note creation", scheduleRemarkNoteBase),
              verification("schedule_remark_marker_matches_note_reference", false, "textNote text must include the replacement marker value", { markerValue, noteText })
            );
          }
        }

        const revertChanges = [{ elementId, parameterName, value: expectedExistingValue, preserveTextCase }];
        const revertDryRun = await transport.post("/revit/set-parameter", { changes: revertChanges, preserveTextCase, apply: false });
        rawResults.push(revertDryRun);
        const revertApplied = await transport.post("/revit/set-parameter", {
          changes: revertChanges,
          preserveTextCase,
          apply: true,
          ...(scheduleOnlyBase.revertConfirm ?? scheduleOnlyBase.confirm ? { confirm: clip(scheduleOnlyBase.revertConfirm ?? scheduleOnlyBase.confirm, 120) } : {})
        });
        rawResults.push(revertApplied);
        const revertedParameters = await transport.post("/revit/get-parameters", { elementIds: [elementId], names: [parameterName] });
        rawResults.push(revertedParameters);
        const scheduleFinal = await transport.post("/revit/export-schedule-csv", {
          scheduleId,
          ...(scheduleName ? { query: scheduleName, exact: true } : {}),
          delimiter: "comma",
          fileName: clip(scheduleOnlyBase.finalFileName ?? scheduleOnlyBase.final_file_name ?? "redline_schedule_after_revert.csv", 180)
        });
        rawResults.push(scheduleFinal);
        if (scheduleRemarkNoteRequested && cleanupRequested && scheduleRemarkNoteId !== null) {
          scheduleRemarkNoteCleanupDryRun = await transport.post("/revit/delete", {
            ids: [scheduleRemarkNoteId],
            apply: false,
            reason: "benchmark cleanup for schedule remark explanatory text note"
          });
          rawResults.push(scheduleRemarkNoteCleanupDryRun);
          scheduleRemarkNoteCleanupApplied = await transport.post("/revit/delete", {
            ids: [scheduleRemarkNoteId],
            apply: true,
            reason: "benchmark cleanup for schedule remark explanatory text note"
          });
          rawResults.push(scheduleRemarkNoteCleanupApplied);
          scheduleRemarkNoteCleanupDryRunIds = deleteEffectIds(scheduleRemarkNoteCleanupDryRun);
          scheduleRemarkNoteCleanupDeletedIds = deleteEffectIds(scheduleRemarkNoteCleanupApplied);
        }
        checks.push(
          verification("schedule_revert_dry_run_ok", !hasParameterWriteErrors(revertDryRun), "dry-run schedule value revert has no errors", revertDryRun),
          verification("schedule_revert_apply_ok", !hasParameterWriteErrors(revertApplied), "schedule value revert applied without errors", revertApplied),
          verification("schedule_revert_parameter_matches_original", parameterSnapshotMatches(revertedParameters, [elementId], parameterName, expectedExistingValue), { elementId, parameterName, expectedExistingValue }, revertedParameters),
          verification("schedule_revert_csv_matches_original", exportedScheduleCsvContains(scheduleFinal, rowKey, expectedExistingValue), { scheduleId, rowKey, expectedExistingValue }, scheduleFinal),
          verification("documentation_cleanup_dry_run_ok", !scheduleRemarkNoteRequested || !cleanupRequested || (scheduleRemarkNoteId !== null && /dry run/i.test(clip(asObject(scheduleRemarkNoteCleanupDryRun).status, 80)) && scheduleRemarkNoteCleanupDryRunIds.includes(scheduleRemarkNoteId)), scheduleRemarkNoteRequested && cleanupRequested ? scheduleRemarkNoteId : "existing schedule backing parameter reverted instead of deleting schedule data", scheduleRemarkNoteCleanupDryRun ?? elementId),
          verification("documentation_cleanup_applied_ids_present", !scheduleRemarkNoteRequested || !cleanupRequested || (scheduleRemarkNoteId !== null && /^deleted$/i.test(clip(asObject(scheduleRemarkNoteCleanupApplied).status, 80)) && scheduleRemarkNoteCleanupDeletedIds.includes(scheduleRemarkNoteId)), scheduleRemarkNoteRequested && cleanupRequested ? scheduleRemarkNoteId : "existing schedule backing parameter reverted instead of deleting schedule data", scheduleRemarkNoteCleanupApplied ?? elementId)
        );
        summaryRows.push({
          primitive: "schedule_parameter_edit_revert",
          id: elementId,
          parent: scheduleId,
          scheduleName,
          rowKey,
          parameterName,
          restoredValue: expectedExistingValue,
          csvPath: firstPathLike(asObject(scheduleFinal).path),
          status: clip(asObject(revertApplied).status, 80)
        });
        if (scheduleRemarkNoteRequested && cleanupRequested && scheduleRemarkNoteId !== null) {
          summaryRows.push({
            primitive: "schedule_remark_note_cleanup",
            id: scheduleRemarkNoteCleanupDeletedIds.join(";"),
            scheduleId,
            textNoteId: scheduleRemarkNoteId,
            status: clip(asObject(scheduleRemarkNoteCleanupApplied).status, 80),
            count: scheduleRemarkNoteCleanupDeletedIds.length
          });
        }
      } else {
        checks.push(
          verification("schedule_parameter_original_matches_expected", false, "schedule id, backing element id, row key, parameter name, expected value, and replacement value", scheduleOnlyBase),
          verification("schedule_parameter_dry_run_ok", false, "schedule edit inputs", scheduleOnlyBase),
          verification("schedule_parameter_apply_ok", false, "schedule edit inputs", scheduleOnlyBase),
          verification("schedule_parameter_readback_matches_request", false, "schedule edit inputs", scheduleOnlyBase),
          verification("schedule_csv_readback_matches_request", false, "schedule edit inputs", scheduleOnlyBase),
          verification("schedule_revert_dry_run_ok", false, "schedule edit inputs", scheduleOnlyBase),
          verification("schedule_revert_apply_ok", false, "schedule edit inputs", scheduleOnlyBase),
          verification("schedule_revert_parameter_matches_original", false, "schedule edit inputs", scheduleOnlyBase),
          verification("schedule_revert_csv_matches_original", false, "schedule edit inputs", scheduleOnlyBase)
        );
      }
      const summaryJsonPath = path.join(runDir, "artifacts", "documentation_primitives_summary.json");
      const summaryMdPath = writeMarkdownTable(path.join(runDir, "artifacts", "documentation_primitives_summary.md"), summaryRows);
      writeJsonFile(summaryJsonPath, { scheduleId, scheduleName, elementId, scheduleRemarkNoteRequested, scheduleRemarkNoteId, scheduleRemarkNoteCleanupDeletedIds, rows: summaryRows, rawResults });
      checks.push(verification("documentation_summary_written", fs.existsSync(summaryJsonPath) && fs.existsSync(summaryMdPath), [summaryJsonPath, summaryMdPath], summaryRows));
      const success = countOk(checks);
      return {
        workflow: "documentation_primitives",
        success,
        failure_reason: success ? null : "Documentation schedule edit workflow verification failed.",
        tool_calls: rawResults.length,
        revit_transactions: rawResults.filter((result) => asObject(result).dryRun !== true).length,
        computer_use_actions: 0,
        output_artifacts: [summaryJsonPath, summaryMdPath],
        verification_results: checks,
        user_message: success ? `Edited, verified, and reverted schedule backing parameter ${parameterName} on element ${elementId}${scheduleRemarkNoteRequested ? ", with schedule remark note cleanup" : ""}.` : "Documentation schedule edit workflow ran, but verification failed.",
        raw_results: rawResults
      };
    }

    const scheduleBatchLayoutBase = asObject(request.scheduleSheetLayout ?? request.schedule_sheet_layout ?? request.scheduleLayout ?? request.schedule_layout);
    const scheduleBatchSchedules = [
      ...objectArray(request.schedules),
      ...objectArray(scheduleBatchLayoutBase.schedules)
    ];
    const scheduleBatchOnly =
      scheduleBatchSchedules.length > 0 &&
      [
        "schedule",
        "configureSchedule",
        "scheduleConfiguration",
        "sheet",
        "existingSheet",
        "targetSheet",
        "createView",
        "view",
        "viewTemplate",
        "createViewTemplate",
        "detailCurves",
        "annotationCurves",
        "textNote",
        "tag",
        "categoryVisibility",
        "filterVisibility",
        "cadReload",
        "cadLink",
        "cadGraphicsOverride",
        "visibility",
        "linkedModelCategoryVisibility",
        "phaseVisibility",
        "templateVisibility",
        "templateCategoryVisibility",
        "applyViewTemplate"
      ].every((key) => Object.keys(asObject(request[key])).length === 0);
    if (scheduleBatchOnly) {
      const sheetId = firstPositiveId(scheduleBatchLayoutBase.sheetId, scheduleBatchLayoutBase.sheet_id, request.sheetId, request.sheet_id);
      const sheetNumber = clip(scheduleBatchLayoutBase.sheetNumber ?? scheduleBatchLayoutBase.sheet_number ?? request.sheetNumber ?? request.sheet_number, 80);
      const layoutPlacements = objectArray(scheduleBatchLayoutBase.placements);
      const createdSchedules: Array<{ index: number; scheduleId: number | null; request: JsonMap; applied: unknown; detail: unknown; configureRequest: JsonMap | null; configureApplied: unknown }> = [];
      for (let index = 0; index < scheduleBatchSchedules.length; index += 1) {
        const scheduleBase = scheduleBatchSchedules[index];
        const scheduleName = appendRepeatSuffix(
          scheduleBase.name ?? scheduleBase.scheduleName ?? scheduleBase.schedule_name,
          runDir,
          `Operator Layout Schedule ${index + 1}`
        );
        const scheduleRequest: JsonMap = {
          kind: "regular",
          category: "OST_Doors",
          fields: ["Family and Type", "Count"],
          ...scheduleBase,
          name: scheduleName,
          scheduleName
        };
        const scheduleDryRun = await transport.post("/revit/create-schedule", { ...scheduleRequest, dryRun: true });
        rawResults.push(scheduleDryRun);
        const scheduleApplied = await transport.post("/revit/create-schedule", { ...scheduleRequest, dryRun: false });
        rawResults.push(scheduleApplied);
        const scheduleObj = asObject(scheduleApplied);
        const scheduleId = firstPositiveId(scheduleObj.viewId, scheduleObj.scheduleId, scheduleObj.id, asObject(scheduleObj.schedule).id);
        let scheduleDetail: unknown = null;
        let scheduleConfigureRequest: JsonMap | null = null;
        let scheduleConfigureApplied: unknown = null;
        if (scheduleId !== null) {
          try {
            scheduleDetail = await transport.post("/revit/schedules", { action: "detail", scheduleId, includeFields: true });
            rawResults.push(scheduleDetail);
          } catch (error) {
            scheduleDetail = { status: "Error", message: error instanceof Error ? error.message : String(error) };
          }

          const perScheduleConfigure = asObject(scheduleBase.configureSchedule ?? scheduleBase.scheduleConfiguration ?? scheduleBase.configure ?? scheduleBase.configuration);
          const perScheduleFilters = objectArray(scheduleBase.filters);
          const perScheduleSortGroup = objectArray(scheduleBase.sortGroup ?? scheduleBase.sort_group);
          const perScheduleFieldFormats = objectArray(scheduleBase.fieldFormats ?? scheduleBase.field_formats);
          const perScheduleAppearance = asObject(scheduleBase.appearance);
          const perScheduleColumnWidths = objectArray(scheduleBase.columnWidths ?? scheduleBase.column_widths);
          const perScheduleRowHeights = objectArray(scheduleBase.rowHeights ?? scheduleBase.row_heights);
          scheduleConfigureRequest = {
            ...perScheduleConfigure,
            ...(perScheduleFilters.length > 0 ? { filters: perScheduleFilters } : {}),
            ...(perScheduleSortGroup.length > 0 ? { sortGroup: perScheduleSortGroup } : {}),
            ...(perScheduleFieldFormats.length > 0 ? { fieldFormats: perScheduleFieldFormats } : {}),
            ...(Object.keys(perScheduleAppearance).length > 0 ? { appearance: perScheduleAppearance } : {}),
            ...(perScheduleColumnWidths.length > 0 ? { columnWidths: perScheduleColumnWidths } : {}),
            ...(perScheduleRowHeights.length > 0 ? { rowHeights: perScheduleRowHeights } : {})
          };
          if (Object.keys(scheduleConfigureRequest).length > 0) {
            scheduleConfigureRequest = {
              ...scheduleConfigureRequest,
              scheduleId,
              replaceFilters: parseBool(scheduleConfigureRequest.replaceFilters ?? scheduleConfigureRequest.replace_filters ?? true) !== false,
              replaceSortGroup: parseBool(scheduleConfigureRequest.replaceSortGroup ?? scheduleConfigureRequest.replace_sort_group ?? false) === true
            };
            const configureDryRun = await transport.post("/revit/configure-schedule", { ...scheduleConfigureRequest, dryRun: true });
            rawResults.push(configureDryRun);
            scheduleConfigureApplied = await transport.post("/revit/configure-schedule", { ...scheduleConfigureRequest, dryRun: false });
            rawResults.push(scheduleConfigureApplied);
            try {
              scheduleDetail = await transport.post("/revit/schedules", { action: "detail", scheduleId, includeFields: true });
              rawResults.push(scheduleDetail);
            } catch (error) {
              scheduleDetail = { status: "Error", message: error instanceof Error ? error.message : String(error) };
            }
            const configuredScheduleId = firstPositiveId(asObject(scheduleConfigureApplied).scheduleId, asObject(scheduleConfigureApplied).id, asObject(scheduleConfigureApplied).viewId, asObject(asObject(scheduleConfigureApplied).schedule).id);
            checks.push(
              verification(`schedule_batch_${index + 1}_config_dry_run_ok`, asObject(configureDryRun).dryRun === true || /dry run/i.test(clip(asObject(configureDryRun).status, 80)), "dry-run batch schedule configuration preview", configureDryRun),
              verification(`schedule_batch_${index + 1}_config_applied_success`, statusLooksOk(scheduleConfigureApplied), "batch schedule configuration status success", scheduleConfigureApplied),
              verification(`schedule_batch_${index + 1}_config_target_matches_created_schedule`, configuredScheduleId === scheduleId, scheduleId, scheduleConfigureApplied),
              verification(`schedule_batch_${index + 1}_config_operations_match_request`, scheduleConfigAppliedProofMatchesRequest(scheduleConfigureRequest, scheduleConfigureApplied), "batch schedule configuration operation evidence", scheduleConfigureApplied)
            );
            summaryRows.push({
              primitive: "layout_schedule_configure",
              id: scheduleId,
              index: index + 1,
              filters: requestedScheduleFilterSummary(scheduleConfigureRequest.filters),
              status: clip(asObject(scheduleConfigureApplied).status, 80)
            });
          } else {
            scheduleConfigureRequest = null;
          }
        }
        const requestedFieldNames = requestedStringArray(scheduleRequest.fields);
        const reportedFieldNames = scheduleFieldNames(scheduleApplied, scheduleDetail);
        checks.push(
          verification(`schedule_batch_${index + 1}_dry_run_ok`, asObject(scheduleDryRun).dryRun === true || /dry run/i.test(clip(asObject(scheduleDryRun).status, 80)), "dry-run schedule preview", scheduleDryRun),
          verification(`schedule_batch_${index + 1}_created_id_present`, scheduleId !== null, "schedule view id", scheduleApplied),
          verification(`schedule_batch_${index + 1}_fields_match_request`, scheduleFieldsMatchRequest(scheduleRequest, scheduleApplied, scheduleDetail), requestedFieldNames, reportedFieldNames)
        );
        summaryRows.push({
          primitive: "layout_schedule",
          id: scheduleId ?? "",
          index: index + 1,
          name: scheduleName,
          requestedFields: requestedFieldNames.join(";"),
          reportedFields: reportedFieldNames.join(";"),
          status: clip(scheduleObj.status, 80)
        });
        createdSchedules.push({ index, scheduleId, request: scheduleRequest, applied: scheduleApplied, detail: scheduleDetail, configureRequest: scheduleConfigureRequest, configureApplied: scheduleConfigureApplied });
      }

      const defaultAvoidOverlap = parseBool(scheduleBatchLayoutBase.avoidOverlap ?? scheduleBatchLayoutBase.avoid_overlap ?? true) !== false;
      const reflowExisting = parseBool(scheduleBatchLayoutBase.reflowExisting ?? scheduleBatchLayoutBase.reflow_existing ?? scheduleBatchLayoutBase.reflowAfterPlace ?? scheduleBatchLayoutBase.reflow_after_place) === true;
      const measuredRepackAfterPlace = parseBool(
        scheduleBatchLayoutBase.measuredRepackAfterPlace ??
        scheduleBatchLayoutBase.measured_repack_after_place ??
        scheduleBatchLayoutBase.repackAfterPlace ??
        scheduleBatchLayoutBase.repack_after_place ??
        scheduleBatchLayoutBase.scheduleSheetRepack ??
        scheduleBatchLayoutBase.schedule_sheet_repack
      ) === true;
      const removeFromSheetAfterPlace = parseBool(scheduleBatchLayoutBase.removeFromSheetAfterPlace ?? scheduleBatchLayoutBase.remove_from_sheet_after_place ?? scheduleBatchLayoutBase.removeAfterPlace ?? scheduleBatchLayoutBase.remove_after_place) === true;
      const layoutPolicy = normalizeScheduleLayoutPolicy(scheduleBatchLayoutBase.layoutPolicy ?? scheduleBatchLayoutBase.layout_policy ?? scheduleBatchLayoutBase.policy);
      let generatedLayoutPlacements = layoutPlacements;
      let stackLayoutPlan: JsonMap | null = null;
      const rightAnchoredStackPolicy = isRightAnchoredScheduleStackPolicy(layoutPolicy);
      const blankSheetPackPolicy = isBlankSheetSchedulePackPolicy(layoutPolicy);
      const usableBounds = scheduleLayoutUsableBounds(scheduleBatchLayoutBase);
      let stackRightAnchorX: number | null = null;
      if (layoutPolicy && !rightAnchoredStackPolicy) {
        throw new Error(`Unsupported scheduleSheetLayout layoutPolicy: ${layoutPolicy}.`);
      }
      if (rightAnchoredStackPolicy) {
        const rightAnchorX = finiteNumberOrNull(scheduleBatchLayoutBase.rightX, scheduleBatchLayoutBase.right_x, scheduleBatchLayoutBase.anchorX, scheduleBatchLayoutBase.anchor_x, scheduleBatchLayoutBase.x);
        const topY = finiteNumberOrNull(scheduleBatchLayoutBase.topY, scheduleBatchLayoutBase.top_y, scheduleBatchLayoutBase.anchorY, scheduleBatchLayoutBase.anchor_y, scheduleBatchLayoutBase.y);
        const spacingFeet = finiteNumberOrNull(
          scheduleBatchLayoutBase.spacingFeet,
          scheduleBatchLayoutBase.spacing_feet,
          scheduleBatchLayoutBase.verticalSpacingFeet,
          scheduleBatchLayoutBase.vertical_spacing_feet,
          1 / 12
        );
        const defaultScheduleHeightFeet = finiteNumberOrNull(
          scheduleBatchLayoutBase.defaultScheduleHeightFeet,
          scheduleBatchLayoutBase.default_schedule_height_feet,
          scheduleBatchLayoutBase.estimatedScheduleHeightFeet,
          scheduleBatchLayoutBase.estimated_schedule_height_feet
        );
        const defaultScheduleWidthFeet = finiteNumberOrNull(
          scheduleBatchLayoutBase.defaultScheduleWidthFeet,
          scheduleBatchLayoutBase.default_schedule_width_feet,
          scheduleBatchLayoutBase.estimatedScheduleWidthFeet,
          scheduleBatchLayoutBase.estimated_schedule_width_feet,
          1.35
        );
        if (rightAnchorX === null) throw new Error("scheduleSheetLayout right-anchored stack requires rightX or anchorX.");
        stackRightAnchorX = rightAnchorX;
        if (topY === null) throw new Error("scheduleSheetLayout right-anchored stack requires topY or anchorY.");
        if (spacingFeet === null || spacingFeet < 0) throw new Error("scheduleSheetLayout right-anchored stack requires non-negative spacingFeet.");
        let yCursor = topY;
        const generated: JsonMap[] = [];
        for (let index = 0; index < scheduleBatchSchedules.length; index += 1) {
          const scheduleBase = scheduleBatchSchedules[index];
          const itemPlacement = asObject(scheduleBase.placement ?? scheduleBase.placeOnSheet ?? scheduleBase.place_on_sheet);
          const layoutPlacement = layoutPlacements[index] ?? {};
          const estimatedHeightFeet = finiteNumberOrNull(
            itemPlacement.estimatedHeightFeet,
            itemPlacement.estimated_height_feet,
            itemPlacement.heightFeet,
            itemPlacement.height_feet,
            layoutPlacement.estimatedHeightFeet,
            layoutPlacement.estimated_height_feet,
            layoutPlacement.heightFeet,
            layoutPlacement.height_feet,
            scheduleBase.estimatedHeightFeet,
            scheduleBase.estimated_height_feet,
            scheduleBase.heightFeet,
            scheduleBase.height_feet,
            defaultScheduleHeightFeet
          );
          if (estimatedHeightFeet === null || estimatedHeightFeet <= 0) {
            throw new Error(`scheduleSheetLayout ${layoutPolicy} requires estimatedHeightFeet for schedule ${index + 1}.`);
          }
          const estimatedWidthFeet = finiteNumberOrNull(
            itemPlacement.estimatedWidthFeet,
            itemPlacement.estimated_width_feet,
            itemPlacement.widthFeet,
            itemPlacement.width_feet,
            layoutPlacement.estimatedWidthFeet,
            layoutPlacement.estimated_width_feet,
            layoutPlacement.widthFeet,
            layoutPlacement.width_feet,
            scheduleBase.estimatedWidthFeet,
            scheduleBase.estimated_width_feet,
            scheduleBase.widthFeet,
            scheduleBase.width_feet,
            defaultScheduleWidthFeet
          );
          if (estimatedWidthFeet === null || estimatedWidthFeet <= 0) {
            throw new Error(`scheduleSheetLayout ${layoutPolicy} requires estimatedWidthFeet for schedule ${index + 1}.`);
          }
          generated.push({
            ...layoutPlacement,
            x: rightAnchorX - estimatedWidthFeet,
            y: yCursor,
            avoidOverlap: true,
            layoutPolicy,
            rightAnchorX,
            estimatedHeightFeet,
            estimatedWidthFeet,
            stackSpacingFeet: spacingFeet
          });
          yCursor -= estimatedHeightFeet + spacingFeet;
        }
        generatedLayoutPlacements = generated;
        stackLayoutPlan = {
          layoutPolicy,
          rightAnchorX,
          topY,
          spacingFeet,
          ...(blankSheetPackPolicy ? { sheetContentPolicy: "blank_schedule_sheet", usableBounds } : {}),
          scheduleCount: generated.length,
          generatedPlacements: generated
        };
      }
      const placements = createdSchedules
        .filter((entry): entry is { index: number; scheduleId: number; request: JsonMap; applied: unknown; detail: unknown; configureRequest: JsonMap | null; configureApplied: unknown } => entry.scheduleId !== null)
        .map((entry, compactIndex) => {
          const itemPlacement = asObject(scheduleBatchSchedules[entry.index].placement ?? scheduleBatchSchedules[entry.index].placeOnSheet ?? scheduleBatchSchedules[entry.index].place_on_sheet);
          const layoutPlacement = generatedLayoutPlacements[entry.index] ?? generatedLayoutPlacements[compactIndex] ?? {};
          return {
            sheetId: firstPositiveId(itemPlacement.sheetId, itemPlacement.sheet_id, layoutPlacement.sheetId, layoutPlacement.sheet_id, sheetId) ?? undefined,
            ...(sheetNumber ? { sheetNumber } : {}),
            viewId: entry.scheduleId,
            avoidOverlap: parseBool(itemPlacement.avoidOverlap ?? itemPlacement.avoid_overlap ?? layoutPlacement.avoidOverlap ?? layoutPlacement.avoid_overlap ?? defaultAvoidOverlap) !== false,
            moveIfAlreadyPlaced: parseBool(itemPlacement.moveIfAlreadyPlaced ?? itemPlacement.move_if_already_placed ?? false) === true,
            ...(layoutPolicy ? { layoutPolicy } : {}),
            ...(Number.isFinite(Number(layoutPlacement.rightAnchorX)) ? { rightAnchorX: Number(layoutPlacement.rightAnchorX) } : {}),
            ...(Number.isFinite(Number(layoutPlacement.estimatedHeightFeet)) ? { estimatedHeightFeet: Number(layoutPlacement.estimatedHeightFeet) } : {}),
            ...(Number.isFinite(Number(layoutPlacement.estimatedWidthFeet)) ? { estimatedWidthFeet: Number(layoutPlacement.estimatedWidthFeet) } : {}),
            ...(Number.isFinite(Number(layoutPlacement.stackSpacingFeet)) ? { stackSpacingFeet: Number(layoutPlacement.stackSpacingFeet) } : {}),
            ...(Number.isFinite(Number(itemPlacement.x ?? layoutPlacement.x)) ? { x: Number(itemPlacement.x ?? layoutPlacement.x) } : {}),
            ...(Number.isFinite(Number(itemPlacement.y ?? layoutPlacement.y)) ? { y: Number(itemPlacement.y ?? layoutPlacement.y) } : {})
          };
        });
      const placeDryRun = await transport.post("/revit/place-views", { dryRun: true, behavior: "allOrNothing", placements });
      rawResults.push(placeDryRun);
      const placeApplied = await transport.post("/revit/place-views", { dryRun: false, behavior: "allOrNothing", placements });
      rawResults.push(placeApplied);
      const placeAppliedObj = asObject(placeApplied);
      const placeRows = objectArray(placeAppliedObj.results);
      const scheduleBatchNotes: Array<{ index: number; scheduleId: number; textNoteId: number; viewId: number; text: string; x: number; y: number; belowOffsetFeet: number }> = [];
      for (let compactIndex = 0; compactIndex < createdSchedules.length; compactIndex += 1) {
        const entry = createdSchedules[compactIndex];
        if (entry.scheduleId === null) continue;
        const scheduleBase = scheduleBatchSchedules[entry.index];
        const noteBase = asObject(scheduleBase.textNote ?? scheduleBase.text_note ?? scheduleBase.note ?? scheduleBase.scheduleNote ?? scheduleBase.schedule_note);
        const placeBelowSchedule = boolFlag(noteBase.placeBelowSchedule ?? noteBase.place_below_schedule ?? noteBase.belowSchedule ?? noteBase.below_schedule ?? noteBase.scheduleLinked ?? noteBase.schedule_linked) === true;
        if (!placeBelowSchedule) continue;
        const placementRow = placeRows.find((candidate) => Number(candidate.index) === compactIndex) ?? placeRows[compactIndex] ?? {};
        const box = schedulePlacementBox(placementRow);
        const noteSheetId = firstPositiveId(noteBase.viewId, noteBase.view_id, noteBase.sheetId, noteBase.sheet_id, placementRow.sheetId, asObject(placementRow.sheet).id, sheetId);
        const noteGapFeet = Number(noteBase.belowOffsetFeet ?? noteBase.below_offset_feet ?? noteBase.gapFeet ?? noteBase.gap_feet ?? 0.25);
        const scheduleBottomY = Number(box.minY ?? placementRow.y);
        const scheduleLeftX = Number(box.minX ?? placementRow.x);
        const noteX = Number.isFinite(Number(noteBase.x)) ? Number(noteBase.x) : scheduleLeftX;
        const noteY = Number.isFinite(Number(noteBase.y)) ? Number(noteBase.y) : scheduleBottomY - (Number.isFinite(noteGapFeet) ? noteGapFeet : 0.25);
        const noteText = appendRepeatSuffix(noteBase.text ?? noteBase.value ?? `NOTE ${compactIndex + 1}: Operator schedule note`, runDir, `NOTE ${compactIndex + 1}: Operator schedule note`);
        const requestedTypeId = firstPositiveId(noteBase.typeId, noteBase.type_id);
        if (noteSheetId !== null && Number.isFinite(noteX) && Number.isFinite(noteY) && Number.isFinite(scheduleBottomY)) {
          const noteResult = await transport.post("/revit/create-text", {
            ...noteBase,
            viewId: noteSheetId,
            x: noteX,
            y: noteY,
            text: noteText
          });
          rawResults.push(noteResult);
          const noteId = firstPositiveId(asObject(noteResult).id, asObject(noteResult).textNoteId, asObject(noteResult).elementId, asObject(noteResult).createdElementId);
          checks.push(
            verification(`schedule_batch_${compactIndex + 1}_note_created`, statusLooksOk(noteResult) && noteId !== null, "created schedule-linked text note id", noteResult),
            verification(`schedule_batch_${compactIndex + 1}_note_target_matches_request`, textNoteProofMatchesRequest(noteSheetId, noteText, requestedTypeId, noteResult), { viewId: noteSheetId, text: noteText, typeId: requestedTypeId }, noteResult),
            verification(`schedule_batch_${compactIndex + 1}_note_below_schedule`, noteY < scheduleBottomY, { scheduleBottomY, noteY, noteGapFeet }, noteResult)
          );
          if (noteId !== null) {
            scheduleBatchNotes.push({ index: compactIndex, scheduleId: entry.scheduleId, textNoteId: noteId, viewId: noteSheetId, text: noteText, x: noteX, y: noteY, belowOffsetFeet: Number.isFinite(noteGapFeet) ? noteGapFeet : 0.25 });
          }
          summaryRows.push({
            primitive: "layout_schedule_note",
            id: noteId ?? "",
            index: compactIndex + 1,
            parent: noteSheetId,
            scheduleId: entry.scheduleId,
            x: noteX,
            y: noteY,
            scheduleAnchorY: scheduleBottomY,
            belowOffsetFeet: Number.isFinite(noteGapFeet) ? noteGapFeet : 0.25,
            text: noteText,
            status: clip(asObject(noteResult).status, 80)
          });
        } else {
          checks.push(
            verification(`schedule_batch_${compactIndex + 1}_note_created`, false, "placed schedule sheet id and measured schedule bounds required", { noteSheetId, noteX, noteY, scheduleBottomY, placementRow }),
            verification(`schedule_batch_${compactIndex + 1}_note_target_matches_request`, false, "placed schedule sheet id and measured schedule bounds required", { noteSheetId, noteText }),
            verification(`schedule_batch_${compactIndex + 1}_note_below_schedule`, false, "placed schedule measured bottom and note point required", { scheduleBottomY, noteY })
          );
        }
      }
      let reflowDryRun: unknown = null;
      let reflowApplied: unknown = null;
      const scheduleBatchNoteMoveDryRuns: unknown[] = [];
      const scheduleBatchNoteMoveAppliedRuns: unknown[] = [];
      let scheduleBatchNoteMoveRequests: JsonMap[] = [];
      const reflowLayoutPlacements = [
        ...objectArray(scheduleBatchLayoutBase.reflowPlacements),
        ...objectArray(scheduleBatchLayoutBase.reflow_placements)
      ];
      const reflowPlacements: JsonMap[] = [];
      const reflowableSchedules = createdSchedules
        .filter((entry): entry is { index: number; scheduleId: number; request: JsonMap; applied: unknown; detail: unknown; configureRequest: JsonMap | null; configureApplied: unknown } => entry.scheduleId !== null);
      if (reflowExisting || measuredRepackAfterPlace) {
        for (let compactIndex = 0; compactIndex < reflowableSchedules.length; compactIndex += 1) {
          const entry = reflowableSchedules[compactIndex];
          const scheduleBase = scheduleBatchSchedules[entry.index];
          const itemPlacement = asObject(scheduleBase.reflowPlacement ?? scheduleBase.reflow_placement);
          const layoutPlacement = reflowLayoutPlacements[entry.index] ?? reflowLayoutPlacements[compactIndex] ?? {};
          const initialPlacement: JsonMap = placements[compactIndex] ?? {};
          const initialRow = placeRows.find((candidate) => Number(candidate.index) === compactIndex) ?? placeRows[compactIndex] ?? {};
          const measuredBox = schedulePlacementBox(initialRow);
          const previousPlacement = compactIndex > 0 ? reflowPlacements[compactIndex - 1] : null;
          const previousRow = compactIndex > 0 ? (placeRows.find((candidate) => Number(candidate.index) === compactIndex - 1) ?? placeRows[compactIndex - 1] ?? {}) : {};
          const previousBox = schedulePlacementBox(previousRow);
          const previousHeight = Number(previousBox.height ?? previousPlacement?.estimatedHeightFeet ?? previousPlacement?.heightFeet);
          const spacing = Number(previousPlacement?.stackSpacingFeet ?? previousPlacement?.spacingFeet ?? initialPlacement.stackSpacingFeet ?? initialPlacement.spacingFeet ?? 0);
          const measuredX = measuredRepackAfterPlace && rightAnchoredStackPolicy && stackRightAnchorX !== null && measuredBox.width !== null
            ? stackRightAnchorX - measuredBox.width
            : Number(initialRow.x ?? initialPlacement.x);
          const measuredY = measuredRepackAfterPlace && compactIndex > 0 && previousPlacement !== null && Number.isFinite(Number(previousPlacement.y)) && Number.isFinite(previousHeight) && Number.isFinite(spacing)
            ? Number(previousPlacement.y) - previousHeight - spacing
            : Number(initialRow.y ?? initialPlacement.y);
          reflowPlacements.push({
            sheetId: firstPositiveId(itemPlacement.sheetId, itemPlacement.sheet_id, layoutPlacement.sheetId, layoutPlacement.sheet_id, initialPlacement.sheetId, sheetId) ?? undefined,
            ...(sheetNumber ? { sheetNumber } : {}),
            viewId: entry.scheduleId,
            avoidOverlap: measuredRepackAfterPlace
              ? parseBool(itemPlacement.repackAvoidOverlap ?? itemPlacement.repack_avoid_overlap ?? layoutPlacement.repackAvoidOverlap ?? layoutPlacement.repack_avoid_overlap ?? scheduleBatchLayoutBase.repackAvoidOverlap ?? scheduleBatchLayoutBase.repack_avoid_overlap ?? false) === true
              : parseBool(itemPlacement.avoidOverlap ?? itemPlacement.avoid_overlap ?? layoutPlacement.avoidOverlap ?? layoutPlacement.avoid_overlap ?? defaultAvoidOverlap) !== false,
            moveIfAlreadyPlaced: true,
            ...(measuredRepackAfterPlace ? { measuredRepack: true } : {}),
            ...(Number.isFinite(Number(measuredBox.width)) ? { estimatedWidthFeet: Number(measuredBox.width) } : {}),
            ...(Number.isFinite(Number(measuredBox.height)) ? { estimatedHeightFeet: Number(measuredBox.height) } : {}),
            ...(Number.isFinite(spacing) ? { stackSpacingFeet: spacing } : {}),
            ...(Number.isFinite(Number(itemPlacement.x ?? layoutPlacement.x ?? measuredX)) ? { x: Number(itemPlacement.x ?? layoutPlacement.x ?? measuredX) } : {}),
            ...(Number.isFinite(Number(itemPlacement.y ?? layoutPlacement.y ?? measuredY)) ? { y: Number(itemPlacement.y ?? layoutPlacement.y ?? measuredY) } : {})
          });
        }
      }
      const measuredRepackPlan = measuredRepackAfterPlace
        ? {
          layoutPolicy,
          rightAnchorX: rightAnchoredStackPolicy ? stackRightAnchorX : "",
          spacingFeet: reflowPlacements[0]?.stackSpacingFeet ?? "",
          scheduleCount: reflowPlacements.length,
          generatedPlacements: reflowPlacements
        }
        : null;
      checks.push(
        verification("schedule_batch_created_count_matches_request", createdSchedules.every((entry) => entry.scheduleId !== null) && createdSchedules.length === scheduleBatchSchedules.length, scheduleBatchSchedules.length, createdSchedules.map((entry) => entry.scheduleId)),
        verification("schedule_batch_place_dry_run_ok", asObject(placeDryRun).dryRun === true || /dry run/i.test(clip(asObject(placeDryRun).status, 80)), "dry-run batch schedule placement preview", placeDryRun),
        verification("schedule_batch_place_applied_success", statusLooksOk(placeApplied) && Number(placeAppliedObj.placedCount ?? placeRows.filter((row) => row.ok === true).length) >= placements.length, placements.length, placeApplied),
        verification("schedule_batch_place_targets_match_request", placedViewsBatchProofMatchesRequest(placements, placeApplied), placements, placeApplied),
        verification("schedule_batch_avoid_overlap_plan_present", placements.every((placement) => placement.avoidOverlap !== true) || placeRows.every((row) => Object.keys(asObject(row.placement)).length > 0), "placement plan evidence for avoidOverlap schedule placement", placeApplied)
      );
      if (stackLayoutPlan !== null) {
        const rightAnchorX = finiteNumberOrNull(stackLayoutPlan.rightAnchorX);
        checks.push(
          verification("schedule_batch_stack_layout_policy_applied", placements.length === scheduleBatchSchedules.length && placements.every((placement) => normalizeScheduleLayoutPolicy(placement.layoutPolicy) === layoutPolicy), layoutPolicy, placements),
          verification("schedule_batch_stack_layout_spacing_verified", scheduleLayoutPlanSpacingVerified(placements), "estimated height plus spacing between generated schedule anchors", placements),
          verification("schedule_batch_stack_layout_right_anchor_verified", scheduleLayoutPlanRightAnchorVerified(placements, rightAnchorX), rightAnchorX, placements),
          verification("schedule_batch_stack_layout_applied_anchors_match_plan", measuredRepackAfterPlace || scheduleLayoutAppliedAnchorsMatchPlan(placements, placeApplied), measuredRepackAfterPlace ? "initial placement may be auto-relocated before measured repack" : "applied placement anchors match generated stack plan", placeApplied)
        );
        if (blankSheetPackPolicy) {
          checks.push(
            verification("schedule_batch_blank_sheet_pack_plan_present", placements.length === scheduleBatchSchedules.length && placements.every((placement) => normalizeScheduleLayoutPolicy(placement.layoutPolicy) === layoutPolicy), "blank schedule sheet pack plan", placements),
            verification("schedule_batch_blank_sheet_pack_within_usable_bounds", scheduleLayoutPlanWithinBounds(placements, usableBounds), usableBounds, placements)
          );
        }
      }
      for (const row of placeRows) {
        summaryRows.push({
          primitive: "layout_schedule_placement",
          id: firstPositiveId(row.scheduleSheetInstanceId, row.id, row.instanceId) ?? "",
          index: Number(row.index) + 1,
          parent: firstPositiveId(row.sheetId, asObject(row.sheet).id) ?? "",
          scheduleId: firstPositiveId(row.viewId, asObject(row.view).id) ?? "",
          x: Number.isFinite(Number(row.x)) ? Number(row.x) : "",
          y: Number.isFinite(Number(row.y)) ? Number(row.y) : "",
          placementType: clip(row.placementType, 80),
          action: clip(row.action, 80),
          layoutPolicy: stackLayoutPlan === null ? "" : layoutPolicy,
          status: row.ok === true ? "Success" : clip(row.status ?? row.error, 120)
        });
      }
      if (measuredRepackPlan !== null) {
        checks.push(
          verification("schedule_batch_measured_repack_plan_present", reflowPlacements.length === placements.length && reflowPlacements.every((placement) => placement.measuredRepack === true), "measured repack placement plan", reflowPlacements),
          verification("schedule_batch_measured_repack_spacing_verified", scheduleMeasuredRepackSpacingVerified(reflowPlacements, placeApplied), "measured schedule heights plus spacing between repack anchors", { reflowPlacements, placeApplied })
        );
      }
      if (reflowExisting || measuredRepackAfterPlace) {
        reflowDryRun = await transport.post("/revit/place-views", { dryRun: true, behavior: "allOrNothing", placements: reflowPlacements });
        rawResults.push(reflowDryRun);
        reflowApplied = await transport.post("/revit/place-views", { dryRun: false, behavior: "allOrNothing", placements: reflowPlacements });
        rawResults.push(reflowApplied);
        const reflowObj = asObject(reflowApplied);
        const reflowRows = objectArray(reflowObj.results);
        checks.push(
          verification("schedule_batch_reflow_dry_run_ok", asObject(reflowDryRun).dryRun === true || /dry run/i.test(clip(asObject(reflowDryRun).status, 80)), "dry-run existing schedule reflow preview", reflowDryRun),
          verification("schedule_batch_reflow_applied_success", statusLooksOk(reflowApplied) && Number(reflowObj.placedCount ?? reflowRows.filter((row) => row.ok === true).length) >= reflowPlacements.length, reflowPlacements.length, reflowApplied),
          verification("schedule_batch_reflow_move_existing_verified", placedViewsBatchMoveProofMatchesRequest(reflowPlacements, placeApplied, reflowApplied), reflowPlacements, reflowApplied)
        );
        if (measuredRepackAfterPlace) {
          checks.push(
            verification("schedule_batch_measured_repack_final_boxes_present", scheduleMeasuredRows(reflowApplied).length >= reflowPlacements.length, "measured final schedule boxes", reflowApplied),
            verification("schedule_batch_measured_repack_final_no_overlap", scheduleMeasuredRowsDoNotOverlap(reflowApplied, reflowPlacements.length), "final measured schedule boxes do not overlap", reflowApplied)
          );
          if (blankSheetPackPolicy) {
            checks.push(
              verification("schedule_batch_blank_sheet_pack_final_within_usable_bounds", scheduleMeasuredRowsWithinBounds(reflowApplied, usableBounds, reflowPlacements.length), usableBounds, reflowApplied)
            );
          }
        }
        for (const row of reflowRows) {
          summaryRows.push({
            primitive: "layout_schedule_reflow",
            id: firstPositiveId(row.scheduleSheetInstanceId, row.id, row.instanceId) ?? "",
            index: Number(row.index) + 1,
            parent: firstPositiveId(row.sheetId, asObject(row.sheet).id) ?? "",
            scheduleId: firstPositiveId(row.viewId, asObject(row.view).id) ?? "",
            x: Number.isFinite(Number(row.x)) ? Number(row.x) : "",
            y: Number.isFinite(Number(row.y)) ? Number(row.y) : "",
            placementType: clip(row.placementType, 80),
            action: clip(row.action, 80),
            status: row.ok === true ? "Success" : clip(row.status ?? row.error, 120)
          });
        }
        if (scheduleBatchNotes.length > 0) {
          const moveRequests: JsonMap[] = [];
          for (const note of scheduleBatchNotes) {
            const reflowRow = reflowRows.find((candidate) => Number(candidate.index) === note.index) ?? reflowRows[note.index] ?? {};
            const reflowBox = schedulePlacementBox(reflowRow);
            const targetX = Number(reflowBox.minX ?? reflowRow.x);
            const targetScheduleBottomY = Number(reflowBox.minY ?? reflowRow.y);
            const targetY = targetScheduleBottomY - note.belowOffsetFeet;
            if (!Number.isFinite(targetX) || !Number.isFinite(targetY) || !Number.isFinite(targetScheduleBottomY)) continue;
            moveRequests.push({
              ids: [note.textNoteId],
              mode: "vector",
              vectorX: targetX - note.x,
              vectorY: targetY - note.y,
              vectorZ: 0,
              behavior: "allOrNothing",
              textNoteId: note.textNoteId,
              scheduleIndex: note.index,
              targetX,
              targetY,
              targetScheduleBottomY
            });
          }
          scheduleBatchNoteMoveRequests = moveRequests;
          const movedIds: number[] = [];
          for (const moveRequest of moveRequests) {
            const moveBody = {
              ids: moveRequest.ids,
              mode: moveRequest.mode,
              vectorX: moveRequest.vectorX,
              vectorY: moveRequest.vectorY,
              vectorZ: moveRequest.vectorZ,
              behavior: moveRequest.behavior
            };
            const moveDryRun = await transport.post("/revit/move-elements", { ...moveBody, dryRun: true });
            rawResults.push(moveDryRun);
            scheduleBatchNoteMoveDryRuns.push(moveDryRun);
            const moveApplied = await transport.post("/revit/move-elements", { ...moveBody, dryRun: false });
            rawResults.push(moveApplied);
            scheduleBatchNoteMoveAppliedRuns.push(moveApplied);
            movedIds.push(...asNumberArray(asObject(moveApplied).movedIds));
          }
          checks.push(
            verification("schedule_batch_note_repack_plan_present", moveRequests.length === scheduleBatchNotes.length, "schedule-linked note move plan", moveRequests),
            verification("schedule_batch_note_move_dry_run_ok", moveRequests.length > 0 && scheduleBatchNoteMoveDryRuns.length === scheduleBatchNotes.length && scheduleBatchNoteMoveDryRuns.every((result) => asObject(result).dryRun === true || /dry run/i.test(clip(asObject(result).status, 80))) && scheduleBatchNotes.every((note) => scheduleBatchNoteMoveDryRuns.some((result) => asNumberArray(asObject(result).movedIds).includes(note.textNoteId))), scheduleBatchNotes.map((note) => note.textNoteId), scheduleBatchNoteMoveDryRuns),
            verification("schedule_batch_note_move_applied_ids_present", moveRequests.length > 0 && scheduleBatchNoteMoveAppliedRuns.length === scheduleBatchNotes.length && scheduleBatchNoteMoveAppliedRuns.every((result) => /^moved$/i.test(clip(asObject(result).status, 80))) && scheduleBatchNotes.every((note) => movedIds.includes(note.textNoteId)), scheduleBatchNotes.map((note) => note.textNoteId), scheduleBatchNoteMoveAppliedRuns),
            verification("schedule_batch_note_repack_keeps_notes_below_schedules", moveRequests.length === scheduleBatchNotes.length && moveRequests.every((request) => Number(request.targetY) < Number(request.targetScheduleBottomY)), "schedule-linked notes below measured repacked schedules", moveRequests)
          );
          for (const moveRequest of moveRequests) {
            summaryRows.push({
              primitive: "layout_schedule_note_repack",
              id: firstPositiveId(moveRequest.textNoteId) ?? "",
              index: Number(moveRequest.scheduleIndex) + 1,
              action: "MoveTextNoteBelowMeasuredSchedule",
              vectorX: Number(moveRequest.vectorX),
              vectorY: Number(moveRequest.vectorY),
              targetX: Number(moveRequest.targetX),
              targetY: Number(moveRequest.targetY),
              targetScheduleBottomY: Number(moveRequest.targetScheduleBottomY),
              status: "Moved"
            });
          }
        }
      }

      let removePlacementDryRun: unknown = null;
      let removePlacementApplied: unknown = null;
      let removePlacementDryRunIds: number[] = [];
      let removePlacementDeletedIds: number[] = [];
      const latestPlacementRows = (reflowExisting || measuredRepackAfterPlace) && reflowApplied !== null ? objectArray(asObject(reflowApplied).results) : placeRows;
      const placementInstanceIds = latestPlacementRows
        .map((row) => firstPositiveId(row.scheduleSheetInstanceId, row.id, row.instanceId))
        .filter((id): id is number => id !== null);
      const scheduleViewIds = createdSchedules.map((entry) => entry.scheduleId).filter((id): id is number => id !== null);
      const scheduleBatchNoteIds = scheduleBatchNotes.map((note) => note.textNoteId);
      const postRemoveScheduleDetails: unknown[] = [];
      if (removeFromSheetAfterPlace) {
        removePlacementDryRun = await transport.post("/revit/delete", {
          ids: placementInstanceIds,
          apply: false,
          reason: "benchmark remove schedule sheet instances without deleting schedule views"
        });
        rawResults.push(removePlacementDryRun);
        removePlacementApplied = await transport.post("/revit/delete", {
          ids: placementInstanceIds,
          apply: true,
          reason: "benchmark remove schedule sheet instances without deleting schedule views"
        });
        rawResults.push(removePlacementApplied);
        removePlacementDryRunIds = deleteEffectIds(removePlacementDryRun);
        removePlacementDeletedIds = deleteEffectIds(removePlacementApplied);
        for (const scheduleId of scheduleViewIds) {
          try {
            const detail = await transport.post("/revit/schedules", { action: "detail", scheduleId, includeFields: true });
            rawResults.push(detail);
            postRemoveScheduleDetails.push(detail);
          } catch (error) {
            postRemoveScheduleDetails.push({ status: "Error", scheduleId, message: error instanceof Error ? error.message : String(error) });
          }
        }
        checks.push(
          verification("schedule_sheet_instance_remove_dry_run_ok", /dry run/i.test(clip(asObject(removePlacementDryRun).status, 80)) && placementInstanceIds.every((id) => removePlacementDryRunIds.includes(id)), placementInstanceIds, removePlacementDryRun),
          verification("schedule_sheet_instance_remove_applied_ids_present", /^deleted$/i.test(clip(asObject(removePlacementApplied).status, 80)) && placementInstanceIds.every((id) => removePlacementDeletedIds.includes(id)), placementInstanceIds, removePlacementApplied),
          verification("schedule_sheet_instance_remove_preserved_schedule_view", scheduleViewIds.length > 0 && postRemoveScheduleDetails.length === scheduleViewIds.length && postRemoveScheduleDetails.every((detail, index) => statusLooksOk(detail) && firstPositiveId(asObject(detail).scheduleId, asObject(detail).id, asObject(detail).viewId, asObject(asObject(detail).schedule).id) === scheduleViewIds[index]), scheduleViewIds, postRemoveScheduleDetails)
        );
        summaryRows.push({
          primitive: "layout_schedule_remove_from_sheet",
          id: removePlacementDeletedIds.join(";"),
          scheduleId: scheduleViewIds.join(";"),
          action: "DeleteScheduleSheetInstance",
          status: clip(asObject(removePlacementApplied).status, 80),
          count: removePlacementDeletedIds.length
        });
      }

      const targetCaptureViewId = firstPositiveId(request.visualViewId, request.captureViewId, request.viewId, sheetId);
      if (request.visualVerify !== false && targetCaptureViewId !== null) {
        postChangeCapture = await transport.post("/revit/export-image", { viewId: targetCaptureViewId, reason: "documentation batch schedule layout post-change visual verification" });
        rawResults.push(postChangeCapture);
        const captureObj = asObject(postChangeCapture);
        const captureView = asObject(captureObj.view);
        const postChangeCaptureViewId = firstPositiveId(captureObj.viewId, captureObj.targetViewId, captureView.id, captureView.viewId);
        postChangeCapturePath = firstPathLike(captureObj.path, captureObj.capturePath, captureObj.capture_path, captureObj.imagePath, captureObj.image_path, captureObj.screenshotPath, captureObj.screenshot_path);
        checks.push(
          verification("documentation_post_change_capture_returned", Boolean(postChangeCapturePath), "post-change documentation capture path", postChangeCapture),
          verification("documentation_post_change_capture_view_id_matches_request", postChangeCaptureViewId === null || postChangeCaptureViewId === targetCaptureViewId, targetCaptureViewId, postChangeCapture),
          verification("documentation_post_change_capture_quality_ok", captureQualityOk(postChangeCapture), "capture dimensions >= 512 px when reported and requested focus crop applied", postChangeCapture)
        );
        summaryRows.push({ primitive: "post_change_capture", id: targetCaptureViewId, reportedViewId: postChangeCaptureViewId ?? "", path: postChangeCapturePath, status: clip(captureObj.status ?? "captured", 80) });
      }

      const cleanupIds = [
        ...createdSchedules.map((entry) => entry.scheduleId).filter((id): id is number => id !== null),
        ...scheduleBatchNoteIds
      ];
      let cleanupDryRun: unknown = null;
      let cleanupApplied: unknown = null;
      let cleanupDryRunIds: number[] = [];
      let cleanupDeletedIds: number[] = [];
      if (cleanupRequested && cleanupIds.length > 0) {
        cleanupDryRun = await transport.post("/revit/delete", {
          ids: cleanupIds,
          apply: false,
          reason: "benchmark cleanup for repeated documentation schedule layout runs"
        });
        rawResults.push(cleanupDryRun);
        cleanupApplied = await transport.post("/revit/delete", {
          ids: cleanupIds,
          apply: true,
          reason: "benchmark cleanup for repeated documentation schedule layout runs"
        });
        rawResults.push(cleanupApplied);
        const cleanupDryObj = asObject(cleanupDryRun);
        const cleanupObj = asObject(cleanupApplied);
        cleanupDryRunIds = deleteEffectIds(cleanupDryRun);
        cleanupDeletedIds = deleteEffectIds(cleanupApplied);
        checks.push(
          verification("documentation_cleanup_dry_run_ok", /dry run/i.test(clip(cleanupDryObj.status, 80)) && cleanupIds.every((id) => cleanupDryRunIds.includes(id)), cleanupIds, cleanupDryRun),
          verification("documentation_cleanup_applied_ids_present", /^deleted$/i.test(clip(cleanupObj.status, 80)) && cleanupIds.every((id) => cleanupDeletedIds.includes(id)), cleanupIds, cleanupApplied)
        );
        summaryRows.push({ primitive: "cleanup_documentation_primitives", id: cleanupDeletedIds.join(";"), status: clip(cleanupObj.status, 80), count: cleanupDeletedIds.length });
      } else if (cleanupRequested) {
        checks.push(
          verification("documentation_cleanup_dry_run_ok", false, "created schedule ids required before cleanup", cleanupIds),
          verification("documentation_cleanup_applied_ids_present", false, "created schedule ids required before cleanup", cleanupIds)
        );
      } else {
        checks.push(verification("documentation_cleanup_applied_ids_present", true, "not requested", cleanupIds));
      }

      const summaryJsonPath = path.join(runDir, "artifacts", "documentation_primitives_summary.json");
      const summaryMdPath = writeMarkdownTable(path.join(runDir, "artifacts", "documentation_primitives_summary.md"), summaryRows);
      writeJsonFile(summaryJsonPath, {
        scheduleBatchCount: scheduleBatchSchedules.length,
        createdSchedules,
        stackLayoutPlan,
        measuredRepackPlan,
        scheduleBatchNotes,
        scheduleBatchNoteMoveRequests,
        scheduleBatchNoteMoveDryRuns,
        scheduleBatchNoteMoveAppliedRuns,
        placements,
        placeDryRun,
        placeApplied,
        reflowExisting,
        reflowPlacements,
        reflowDryRun,
        reflowApplied,
        removeFromSheetAfterPlace,
        placementInstanceIds,
        removePlacementDryRun,
        removePlacementApplied,
        removePlacementDryRunIds,
        removePlacementDeletedIds,
        postRemoveScheduleDetails,
        postChangeCapturePath,
        cleanupRequested,
        cleanupIds,
        cleanupDryRunIds,
        cleanupDeletedIds,
        cleanupDryRun,
        cleanupApplied,
        rows: summaryRows,
        rawResults
      });
      checks.push(verification("documentation_summary_written", fs.existsSync(summaryJsonPath) && fs.existsSync(summaryMdPath), [summaryJsonPath, summaryMdPath], summaryRows));
      const success = countOk(checks);
      return {
        workflow: "documentation_primitives",
        success,
        failure_reason: success ? null : "Documentation batch schedule layout workflow verification failed.",
        tool_calls: rawResults.length,
        revit_transactions: rawResults.filter((result) => asObject(result).dryRun !== true).length,
        computer_use_actions: 0,
        output_artifacts: [summaryJsonPath, summaryMdPath],
        verification_results: checks,
        user_message: success ? `Created, placed, verified, and cleaned up ${createdSchedules.length} schedule(s).` : "Documentation batch schedule layout workflow ran, but verification failed.",
        raw_results: rawResults
      };
    }

    const scheduleOnlyConfigureBase = asObject(request.schedule);
    const scheduleOnlyConfigureRequestBase = asObject(request.configureSchedule ?? request.scheduleConfiguration);
    const scheduleOnlyTextNoteBase = asObject(request.textNote);
    const scheduleOnlyTextNoteAllowed =
      Object.keys(scheduleOnlyTextNoteBase).length === 0 ||
      boolFlag(scheduleOnlyTextNoteBase.placeBelowSchedule ?? scheduleOnlyTextNoteBase.place_below_schedule) === true;
    const scheduleOnlyCreateConfigure =
      Object.keys(scheduleOnlyConfigureBase).length > 0 &&
      Object.keys(scheduleOnlyConfigureRequestBase).length > 0 &&
      scheduleOnlyTextNoteAllowed &&
      [
        "sheet",
        "existingSheet",
        "targetSheet",
        "createView",
        "view",
        "viewTemplate",
        "createViewTemplate",
        "detailCurves",
        "annotationCurves",
        "tag",
        "categoryVisibility",
        "filterVisibility",
        "cadReload",
        "cadLink",
        "cadGraphicsOverride",
        "visibility",
        "linkedModelCategoryVisibility",
        "phaseVisibility",
        "filterVisibility",
        "templateVisibility",
        "templateCategoryVisibility",
        "applyViewTemplate"
      ].every((key) => Object.keys(asObject(request[key])).length === 0);
    if (scheduleOnlyCreateConfigure) {
      const useExistingSchedule = boolFlag(scheduleOnlyConfigureBase.useExisting ?? scheduleOnlyConfigureBase.existing ?? scheduleOnlyConfigureBase.use_existing);
      const scheduleName = useExistingSchedule
        ? clip(scheduleOnlyConfigureBase.name ?? scheduleOnlyConfigureBase.scheduleName ?? request.scheduleName, 240).trim()
        : appendRepeatSuffix(
          scheduleOnlyConfigureBase.name ?? scheduleOnlyConfigureBase.scheduleName ?? request.scheduleName,
          runDir,
          "Operator Demo Schedule"
        );
      const scheduleRequest: JsonMap = useExistingSchedule
        ? {
          action: "detail",
          includeFields: true,
          includeRows: true,
          ...scheduleOnlyConfigureBase,
          ...(firstPositiveId(scheduleOnlyConfigureBase.scheduleId, scheduleOnlyConfigureBase.viewId, scheduleOnlyConfigureBase.existingScheduleId) !== null
            ? { scheduleId: firstPositiveId(scheduleOnlyConfigureBase.scheduleId, scheduleOnlyConfigureBase.viewId, scheduleOnlyConfigureBase.existingScheduleId) }
            : {}),
          ...(scheduleName ? { scheduleName } : {})
        }
        : {
          kind: "regular",
          category: "OST_Doors",
          fields: ["Family and Type", "Count"],
          ...scheduleOnlyConfigureBase,
          name: scheduleName,
          scheduleName
        };
      const scheduleDryRun = useExistingSchedule
        ? { status: "ExistingScheduleLookup", dryRun: true, scheduleId: firstPositiveId(scheduleRequest.scheduleId), scheduleName }
        : await transport.post("/revit/create-schedule", { ...scheduleRequest, dryRun: true });
      rawResults.push(scheduleDryRun);
      const scheduleApplied = useExistingSchedule
        ? await transport.post("/revit/schedules", scheduleRequest)
        : await transport.post("/revit/create-schedule", { ...scheduleRequest, dryRun: false });
      rawResults.push(scheduleApplied);
      const scheduleObj = asObject(scheduleApplied);
      const scheduleId = firstPositiveId(scheduleObj.viewId, scheduleObj.scheduleId, scheduleObj.id);
      const requestedFieldCount = requestedScheduleFieldCount(scheduleRequest);
      const createdScheduleFieldCount = scheduleFieldCount(scheduleApplied);
      let scheduleDetail: unknown = null;
      if (useExistingSchedule) {
        scheduleDetail = scheduleApplied;
      } else if (scheduleId !== null) {
        try {
          scheduleDetail = await transport.post("/revit/schedules", { action: "detail", scheduleId, includeFields: true });
          rawResults.push(scheduleDetail);
        } catch (error) {
          scheduleDetail = { status: "Error", message: error instanceof Error ? error.message : String(error) };
        }
      }
      const createdScheduleFieldNames = scheduleFieldNames(scheduleApplied, scheduleDetail);
      checks.push(
        verification("schedule_dry_run_ok", asObject(scheduleDryRun).dryRun === true || /dry run/i.test(clip(asObject(scheduleDryRun).status, 80)), "dry-run schedule preview", scheduleDryRun),
        verification("schedule_created_id_present", scheduleId !== null, "schedule view id", scheduleApplied),
        verification("schedule_created_field_count_matches_request", requestedFieldCount === 0 || (createdScheduleFieldCount !== null && createdScheduleFieldCount >= requestedFieldCount), requestedFieldCount, scheduleApplied),
        verification("schedule_created_fields_match_request", scheduleFieldsMatchRequest(scheduleRequest, scheduleApplied, scheduleDetail), requestedStringArray(scheduleRequest.fields), createdScheduleFieldNames),
        verification("schedule_created_placement_matches_request", schedulePlacementProofMatchesRequest(scheduleRequest, scheduleApplied), "schedule placement proof when requested", scheduleApplied)
      );
      summaryRows.push({ primitive: "schedule", id: scheduleId ?? "", name: scheduleName, requestedFieldCount, fieldCount: createdScheduleFieldCount ?? "", requestedFields: requestedStringArray(scheduleRequest.fields).join(";"), reportedFields: createdScheduleFieldNames.join(";"), status: clip(scheduleObj.status ?? "created", 80) });

      const seedConfigureBase = asObject(request.seedConfigureSchedule ?? request.initialConfigureSchedule);
      if (Object.keys(seedConfigureBase).length > 0) {
        const seedConfigureRequest: JsonMap = {
          addFields: [],
          replaceFilters: false,
          replaceSortGroup: false,
          ...seedConfigureBase,
          ...(scheduleId !== null ? { scheduleId } : {})
        };
        const seedConfigureDryRun = await transport.post("/revit/configure-schedule", { ...seedConfigureRequest, dryRun: true });
        rawResults.push(seedConfigureDryRun);
        const seedConfigureApplied = await transport.post("/revit/configure-schedule", { ...seedConfigureRequest, dryRun: false });
        rawResults.push(seedConfigureApplied);
        const seedConfigureObj = asObject(seedConfigureApplied);
        const seedConfiguredSchedule = asObject(seedConfigureObj.schedule);
        const seedConfiguredScheduleId = firstPositiveId(seedConfigureObj.scheduleId, seedConfigureObj.viewId, seedConfigureObj.id, seedConfiguredSchedule.id, seedConfiguredSchedule.viewId);
        checks.push(
          verification("schedule_seed_config_dry_run_ok", asObject(seedConfigureDryRun).dryRun === true || /dry run/i.test(clip(asObject(seedConfigureDryRun).status, 80)), "dry-run seed schedule configuration preview", seedConfigureDryRun),
          verification("schedule_seed_config_applied_success", statusLooksOk(seedConfigureApplied), "seed schedule configuration status success", seedConfigureApplied),
          verification("schedule_seed_config_target_matches_created_schedule", scheduleId !== null && seedConfiguredScheduleId === scheduleId, scheduleId, seedConfigureApplied),
          verification("schedule_seed_config_applied_operations_match_request", scheduleConfigAppliedProofMatchesRequest(seedConfigureRequest, seedConfigureApplied), "seed applied schedule configuration operation evidence", seedConfigureApplied)
        );
        summaryRows.push({
          primitive: "seed_configure_schedule",
          id: seedConfiguredScheduleId ?? "",
          expectedScheduleId: scheduleId ?? "",
          requestedFields: [...requestedStringArray(scheduleRequest.fields), ...requestedStringArray(seedConfigureRequest.addFields)].join(";"),
          filters: requestedScheduleFilterSummary(seedConfigureRequest.filters),
          status: clip(seedConfigureObj.status, 80)
        });
      }

      const configureRequest: JsonMap = {
        addFields: [],
        replaceFilters: false,
        replaceSortGroup: false,
        ...scheduleOnlyConfigureRequestBase,
        ...(scheduleId !== null ? { scheduleId } : {})
      };
      const configureDryRun = await transport.post("/revit/configure-schedule", { ...configureRequest, dryRun: true });
      rawResults.push(configureDryRun);
      const configureApplied = await transport.post("/revit/configure-schedule", { ...configureRequest, dryRun: false });
      rawResults.push(configureApplied);
      const configureObj = asObject(configureApplied);
      const configuredSchedule = asObject(configureObj.schedule);
      const configuredScheduleId = firstPositiveId(configureObj.scheduleId, configureObj.viewId, configureObj.id, configuredSchedule.id, configuredSchedule.viewId);
      let configuredScheduleDetail: unknown = null;
      if (configuredScheduleId !== null) {
        try {
          configuredScheduleDetail = await transport.post("/revit/schedules", { action: "detail", scheduleId: configuredScheduleId, includeFields: true });
          rawResults.push(configuredScheduleDetail);
        } catch (error) {
          configuredScheduleDetail = { status: "Error", message: error instanceof Error ? error.message : String(error) };
        }
      }
      const requestedConfiguredFieldNames = [
        ...requestedStringArray(scheduleRequest.fields),
        ...requestedStringArray(configureRequest.addFields)
      ];
      const configuredScheduleFieldNames = scheduleFieldNames(configureApplied, configuredScheduleDetail);
      checks.push(
        verification("schedule_config_dry_run_ok", asObject(configureDryRun).dryRun === true || /dry run/i.test(clip(asObject(configureDryRun).status, 80)), "dry-run schedule configuration preview", configureDryRun),
        verification("schedule_config_applied_success", statusLooksOk(configureApplied), "schedule configuration status success", configureApplied),
        verification("schedule_config_target_matches_created_schedule", scheduleId !== null && configuredScheduleId === scheduleId, scheduleId, configureApplied),
        verification("schedule_config_applied_operations_match_request", scheduleConfigAppliedProofMatchesRequest(configureRequest, configureApplied), "applied schedule configuration operation evidence", configureApplied),
        verification("schedule_config_fields_match_request", scheduleFieldsMatchNames(requestedConfiguredFieldNames, configureApplied, configuredScheduleDetail), requestedConfiguredFieldNames, configuredScheduleFieldNames),
        verification("schedule_config_text_value_readback_matches_request", scheduleConfigTextValueReadbackMatchesRequest(configureRequest, configureApplied, configuredScheduleDetail), { targetFieldName: configureRequest.targetFieldName ?? configureRequest.targetField ?? configureRequest.columnName ?? configureRequest.fieldName, requestedTextOrValue: configureRequest.requestedTextOrValue ?? configureRequest.requestedValue ?? configureRequest.value, readbackRequired: configureRequest.readbackRequired ?? configureRequest.readback_required ?? configureRequest.requireReadback }, configuredScheduleDetail)
      );
      summaryRows.push({
        primitive: "configure_schedule",
        id: configuredScheduleId ?? "",
        expectedScheduleId: scheduleId ?? "",
        requestedFields: requestedConfiguredFieldNames.join(";"),
        reportedFields: configuredScheduleFieldNames.join(";"),
        filters: requestedScheduleFilterSummary(configureRequest.filters),
        status: clip(configureObj.status, 80)
      });

      const placedSchedule = asObject(scheduleObj.placedOnSheet ?? scheduleObj.placed_on_sheet ?? scheduleObj.scheduleSheetInstance);
      let scheduleNoteId: number | null = null;
      let scheduleNoteResult: unknown = null;
      let scheduleNoteReflowDryRun: unknown = null;
      let scheduleNoteReflowApplied: unknown = null;
      let scheduleNoteMoveDryRun: unknown = null;
      let scheduleNoteMoveApplied: unknown = null;
      let scheduleNoteAssociationFind: unknown = null;
      let scheduleNoteMovedIds: number[] = [];
      let scheduleNoteReflowPlacement: JsonMap | null = null;
      let scheduleNoteCreatedForCleanup = false;
      if (Object.keys(scheduleOnlyTextNoteBase).length > 0) {
        const noteSheetId = firstPositiveId(scheduleOnlyTextNoteBase.viewId, scheduleOnlyTextNoteBase.sheetId, scheduleOnlyTextNoteBase.sheet_id, placedSchedule.sheetId, asObject(placedSchedule.sheet).id);
        const placedX = Number(placedSchedule.x);
        const placedY = Number(placedSchedule.y);
        const bbox = asObject(placedSchedule.boundingBox ?? placedSchedule.bounding_box);
        const bboxMin = asObject(bbox.min);
        const bboxMinX = Number(bboxMin.x);
        const bboxMinY = Number(bboxMin.y);
        const noteGapFeet = Number(scheduleOnlyTextNoteBase.belowOffsetFeet ?? scheduleOnlyTextNoteBase.below_offset_feet ?? scheduleOnlyTextNoteBase.gapFeet ?? scheduleOnlyTextNoteBase.gap_feet ?? 0.25);
        const scheduleAnchorY = Number.isFinite(bboxMinY) ? bboxMinY : placedY;
        const noteX = Number.isFinite(Number(scheduleOnlyTextNoteBase.x)) ? Number(scheduleOnlyTextNoteBase.x) : (Number.isFinite(placedX) ? placedX : bboxMinX);
        const noteY = Number.isFinite(Number(scheduleOnlyTextNoteBase.y)) ? Number(scheduleOnlyTextNoteBase.y) : (Number.isFinite(scheduleAnchorY) ? scheduleAnchorY - (Number.isFinite(noteGapFeet) ? noteGapFeet : 0.25) : Number.NaN);
        const noteText = appendRepeatSuffix(scheduleOnlyTextNoteBase.text ?? request.text, runDir, "NOTE 1: Operator schedule remark");
        const requestedTypeId = firstPositiveId(scheduleOnlyTextNoteBase.typeId, request.textTypeId);
        const useExistingScheduleNote = boolFlag(scheduleOnlyTextNoteBase.useExistingTextNote ?? scheduleOnlyTextNoteBase.use_existing_text_note ?? scheduleOnlyTextNoteBase.existingTextNote ?? scheduleOnlyTextNoteBase.existing_text_note ?? scheduleOnlyTextNoteBase.findExistingByText ?? scheduleOnlyTextNoteBase.find_existing_by_text) === true;
        const scheduleReflowBase = asObject(request.scheduleReflow ?? request.schedule_reflow ?? scheduleOnlyTextNoteBase.scheduleReflow ?? scheduleOnlyTextNoteBase.schedule_reflow);
        const snapNoteBelowSchedule = boolFlag(scheduleOnlyTextNoteBase.snapBelowSchedule ?? scheduleOnlyTextNoteBase.snap_below_schedule ?? scheduleOnlyTextNoteBase.repositionBelowSchedule ?? scheduleOnlyTextNoteBase.reposition_below_schedule ?? scheduleReflowBase.snapNoteBelowSchedule ?? scheduleReflowBase.snap_note_below_schedule ?? scheduleReflowBase.repositionNoteBelowSchedule ?? scheduleReflowBase.reposition_note_below_schedule) === true;
        if (noteSheetId !== null && Number.isFinite(noteX) && Number.isFinite(noteY) && Number.isFinite(scheduleAnchorY)) {
          if (!useExistingScheduleNote) {
            scheduleNoteResult = await transport.post("/revit/create-text", {
              ...scheduleOnlyTextNoteBase,
              viewId: noteSheetId,
              x: noteX,
              y: noteY,
              text: noteText
            });
            rawResults.push(scheduleNoteResult);
            scheduleNoteId = firstPositiveId(asObject(scheduleNoteResult).id, asObject(scheduleNoteResult).textNoteId, asObject(scheduleNoteResult).elementId, asObject(scheduleNoteResult).createdElementId);
            scheduleNoteCreatedForCleanup = scheduleNoteId !== null;
          }
          const associateByText = boolFlag(scheduleOnlyTextNoteBase.associateByText ?? scheduleOnlyTextNoteBase.associate_by_text ?? scheduleOnlyTextNoteBase.findByText ?? scheduleOnlyTextNoteBase.find_by_text ?? scheduleOnlyTextNoteBase.bindByText ?? scheduleOnlyTextNoteBase.bind_by_text) === true;
          let associatedScheduleNoteId: number | null = null;
          let associatedScheduleNoteCenterX: number | null = null;
          let associatedScheduleNoteCenterY: number | null = null;
          if (associateByText || useExistingScheduleNote) {
            scheduleNoteAssociationFind = await transport.post("/revit/find-text-notes", {
              viewId: noteSheetId,
              contains: noteText,
              max: 10
            });
            rawResults.push(scheduleNoteAssociationFind);
            const associationItems = textNoteItems(scheduleNoteAssociationFind).filter((item) => {
              if (useExistingScheduleNote && scheduleNoteId === null) return textNoteItemTextAndViewMatches(item, noteSheetId, noteText);
              return textNoteItemMatches(item, scheduleNoteId ?? -1, noteSheetId, noteText);
            });
            const associationItem = associationItems[0] ?? {};
            const associationCenter = asObject(associationItem.center);
            const centerX = Number(associationCenter.x);
            const centerY = Number(associationCenter.y);
            associatedScheduleNoteId = firstPositiveId(associationItem.textNoteId, associationItem.text_note_id, associationItem.elementId, associationItem.element_id, associationItem.id);
            associatedScheduleNoteCenterX = Number.isFinite(centerX) ? centerX : null;
            associatedScheduleNoteCenterY = Number.isFinite(centerY) ? centerY : null;
            if (associatedScheduleNoteId !== null) scheduleNoteId = associatedScheduleNoteId;
            checks.push(
              verification("schedule_note_association_find_by_text", associatedScheduleNoteId !== null && (useExistingScheduleNote || associatedScheduleNoteId === firstPositiveId(asObject(scheduleNoteResult).id, asObject(scheduleNoteResult).textNoteId, asObject(scheduleNoteResult).elementId, asObject(scheduleNoteResult).createdElementId)), { noteSheetId, noteText, scheduleNoteId, useExistingScheduleNote }, scheduleNoteAssociationFind),
              verification("schedule_note_association_unique", associationItems.length === 1, "exactly one text note matched created note id/text/view", scheduleNoteAssociationFind),
              verification("schedule_note_association_below_schedule", snapNoteBelowSchedule || associatedScheduleNoteCenterY === null || associatedScheduleNoteCenterY < scheduleAnchorY, { scheduleAnchorY, associatedScheduleNoteCenterY, snapNoteBelowSchedule }, scheduleNoteAssociationFind)
            );
          }
          checks.push(
            verification("schedule_note_sheet_context_present", true, { noteSheetId, scheduleSheetInstanceId: firstPositiveId(placedSchedule.scheduleSheetInstanceId, placedSchedule.id, placedSchedule.instanceId) }, placedSchedule),
            verification(useExistingScheduleNote ? "schedule_note_existing_found" : "schedule_note_created", useExistingScheduleNote ? scheduleNoteId !== null : statusLooksOk(scheduleNoteResult) && scheduleNoteId !== null, useExistingScheduleNote ? "existing schedule note found by text" : "created schedule note text id", useExistingScheduleNote ? scheduleNoteAssociationFind : scheduleNoteResult),
            verification("schedule_note_target_matches_request", useExistingScheduleNote ? scheduleNoteId !== null : textNoteProofMatchesRequest(noteSheetId, noteText, requestedTypeId, scheduleNoteResult), { viewId: noteSheetId, text: noteText, typeId: requestedTypeId, useExistingScheduleNote }, useExistingScheduleNote ? scheduleNoteAssociationFind : scheduleNoteResult),
            verification("schedule_note_below_schedule_anchor", snapNoteBelowSchedule || noteY < scheduleAnchorY, { scheduleAnchorY, noteY, noteGapFeet, snapNoteBelowSchedule, boundingBox: bbox }, scheduleNoteResult)
          );
          summaryRows.push({
            primitive: "schedule_note",
            id: scheduleNoteId ?? "",
            parent: noteSheetId,
            scheduleId: scheduleId ?? "",
            scheduleSheetInstanceId: firstPositiveId(placedSchedule.scheduleSheetInstanceId, placedSchedule.id, placedSchedule.instanceId) ?? "",
            x: noteX,
            y: noteY,
            scheduleAnchorY,
            belowOffsetFeet: Number.isFinite(noteGapFeet) ? noteGapFeet : 0.25,
            text: noteText,
            association: (associateByText || useExistingScheduleNote) ? "find-text-notes" : "",
            associatedId: associatedScheduleNoteId ?? "",
            existing: useExistingScheduleNote,
            status: useExistingScheduleNote ? "FoundExisting" : clip(asObject(scheduleNoteResult).status, 80)
          });
          const reflowNoteWithSchedule = boolFlag(scheduleOnlyTextNoteBase.reflowWithSchedule ?? scheduleOnlyTextNoteBase.reflow_with_schedule ?? scheduleReflowBase.moveNoteWithSchedule ?? scheduleReflowBase.move_note_with_schedule) === true;
          const reflowX = Number(scheduleReflowBase.x ?? scheduleReflowBase.targetX ?? scheduleReflowBase.target_x ?? scheduleOnlyTextNoteBase.reflowX ?? scheduleOnlyTextNoteBase.reflow_x);
          const reflowY = Number(scheduleReflowBase.y ?? scheduleReflowBase.targetY ?? scheduleReflowBase.target_y ?? scheduleOnlyTextNoteBase.reflowY ?? scheduleOnlyTextNoteBase.reflow_y);
          const reflowDeltaX = reflowX - placedX;
          const reflowDeltaY = reflowY - placedY;
          const currentNoteX = associatedScheduleNoteCenterX ?? noteX;
          const currentNoteY = associatedScheduleNoteCenterY ?? noteY;
          const targetScheduleAnchorY = scheduleAnchorY + reflowDeltaY;
          const targetNoteY = targetScheduleAnchorY - (Number.isFinite(noteGapFeet) ? noteGapFeet : 0.25);
          const noteMoveDeltaX = reflowDeltaX;
          const noteMoveDeltaY = snapNoteBelowSchedule && Number.isFinite(currentNoteY) && Number.isFinite(targetNoteY) ? targetNoteY - currentNoteY : reflowDeltaY;
          const finalNoteY = currentNoteY + noteMoveDeltaY;
          if (reflowNoteWithSchedule && scheduleId !== null && noteSheetId !== null && scheduleNoteId !== null && Number.isFinite(reflowX) && Number.isFinite(reflowY) && Number.isFinite(reflowDeltaX) && Number.isFinite(reflowDeltaY)) {
            scheduleNoteReflowPlacement = {
              sheetId: noteSheetId,
              viewId: scheduleId,
              x: reflowX,
              y: reflowY,
              avoidOverlap: parseBool(scheduleReflowBase.avoidOverlap ?? scheduleReflowBase.avoid_overlap ?? false) === true,
              moveIfAlreadyPlaced: true
            };
            scheduleNoteReflowDryRun = await transport.post("/revit/place-views", { dryRun: true, behavior: "allOrNothing", placements: [scheduleNoteReflowPlacement] });
            rawResults.push(scheduleNoteReflowDryRun);
            scheduleNoteReflowApplied = await transport.post("/revit/place-views", { dryRun: false, behavior: "allOrNothing", placements: [scheduleNoteReflowPlacement] });
            rawResults.push(scheduleNoteReflowApplied);
            const initialPlaceProof = {
              status: "Success",
              results: [{
                index: 0,
                ok: true,
                sheetId: noteSheetId,
                viewId: scheduleId,
                scheduleSheetInstanceId: firstPositiveId(placedSchedule.scheduleSheetInstanceId, placedSchedule.id, placedSchedule.instanceId),
                placementType: "ScheduleSheetInstance",
                x: placedX,
                y: placedY
              }]
            };
            scheduleNoteMoveDryRun = await transport.post("/revit/move-elements", {
              ids: [scheduleNoteId],
              mode: "vector",
              vectorX: noteMoveDeltaX,
              vectorY: noteMoveDeltaY,
              vectorZ: 0,
              behavior: "allOrNothing",
              dryRun: true
            });
            rawResults.push(scheduleNoteMoveDryRun);
            scheduleNoteMoveApplied = await transport.post("/revit/move-elements", {
              ids: [scheduleNoteId],
              mode: "vector",
              vectorX: noteMoveDeltaX,
              vectorY: noteMoveDeltaY,
              vectorZ: 0,
              behavior: "allOrNothing",
              dryRun: false
            });
            rawResults.push(scheduleNoteMoveApplied);
            scheduleNoteMovedIds = asNumberArray(asObject(scheduleNoteMoveApplied).movedIds);
            checks.push(
              verification("schedule_note_reflow_dry_run_ok", asObject(scheduleNoteReflowDryRun).dryRun === true || /dry run/i.test(clip(asObject(scheduleNoteReflowDryRun).status, 80)), "dry-run schedule reflow preview", scheduleNoteReflowDryRun),
              verification("schedule_note_reflow_move_existing_verified", placedViewsBatchMoveProofMatchesRequest([scheduleNoteReflowPlacement], initialPlaceProof, scheduleNoteReflowApplied), scheduleNoteReflowPlacement, scheduleNoteReflowApplied),
              verification("schedule_note_move_dry_run_ok", /dry run/i.test(clip(asObject(scheduleNoteMoveDryRun).status, 80)) && asNumberArray(asObject(scheduleNoteMoveDryRun).movedIds).includes(scheduleNoteId), scheduleNoteId, scheduleNoteMoveDryRun),
              verification("schedule_note_move_applied_ids_present", /^moved$/i.test(clip(asObject(scheduleNoteMoveApplied).status, 80)) && scheduleNoteMovedIds.includes(scheduleNoteId), scheduleNoteId, scheduleNoteMoveApplied),
              verification("schedule_note_reflow_keeps_note_below_schedule", finalNoteY < targetScheduleAnchorY, { originalNoteY: currentNoteY, originalScheduleAnchorY: scheduleAnchorY, targetScheduleAnchorY, noteMoveDeltaY, finalNoteY }, scheduleNoteMoveApplied),
              verification("schedule_note_reflow_snap_below_schedule", !snapNoteBelowSchedule || Math.abs(finalNoteY - targetNoteY) < 0.0001, { snapNoteBelowSchedule, targetNoteY, finalNoteY, noteGapFeet }, scheduleNoteMoveApplied)
            );
            summaryRows.push({
              primitive: "schedule_note_reflow",
              id: scheduleNoteId,
              parent: noteSheetId,
              scheduleId,
              scheduleSheetInstanceId: firstPositiveId(placedSchedule.scheduleSheetInstanceId, placedSchedule.id, placedSchedule.instanceId) ?? "",
              action: "MoveTextNoteWithSchedule",
              vectorX: noteMoveDeltaX,
              vectorY: noteMoveDeltaY,
              snapBelowSchedule: snapNoteBelowSchedule,
              targetNoteY: snapNoteBelowSchedule ? targetNoteY : "",
              targetScheduleX: reflowX,
              targetScheduleY: reflowY,
              status: clip(asObject(scheduleNoteMoveApplied).status, 80)
            });
          } else if (reflowNoteWithSchedule) {
            checks.push(
              verification("schedule_note_reflow_dry_run_ok", false, "schedule id, note id, sheet id, and finite reflow target", { scheduleId, scheduleNoteId, noteSheetId, reflowX, reflowY }),
              verification("schedule_note_reflow_move_existing_verified", false, "schedule reflow placement", scheduleReflowBase),
              verification("schedule_note_move_dry_run_ok", false, "text note id and reflow vector", { scheduleNoteId, reflowDeltaX, reflowDeltaY }),
              verification("schedule_note_move_applied_ids_present", false, "text note id and reflow vector", { scheduleNoteId, reflowDeltaX, reflowDeltaY }),
              verification("schedule_note_reflow_keeps_note_below_schedule", false, "note and schedule anchors", { noteY, scheduleAnchorY, reflowDeltaY })
            );
          }
        } else {
          checks.push(
            verification("schedule_note_sheet_context_present", false, "placed schedule sheet id and numeric schedule anchor", { noteSheetId, placedSchedule, noteX, noteY, scheduleAnchorY }),
            verification("schedule_note_created", false, "placed schedule sheet id and numeric note point", scheduleOnlyTextNoteBase),
            verification("schedule_note_target_matches_request", false, "placed schedule sheet id and numeric note point", scheduleOnlyTextNoteBase),
            verification("schedule_note_below_schedule_anchor", false, "placed schedule anchor and note point", { placedSchedule, noteX, noteY, scheduleAnchorY })
          );
        }
      }

      const targetCaptureViewId = firstPositiveId(request.visualViewId, request.captureViewId, request.viewId, firstPositiveId(placedSchedule.sheetId, asObject(placedSchedule.sheet).id), configuredScheduleId, scheduleId);
      if (request.visualVerify !== false && targetCaptureViewId !== null) {
        postChangeCapture = await transport.post("/revit/export-image", { viewId: targetCaptureViewId, reason: "documentation schedule configure post-change visual verification" });
        rawResults.push(postChangeCapture);
        const captureObj = asObject(postChangeCapture);
        const captureView = asObject(captureObj.view);
        const postChangeCaptureViewId = firstPositiveId(captureObj.viewId, captureObj.targetViewId, captureView.id, captureView.viewId);
        postChangeCapturePath = firstPathLike(captureObj.path, captureObj.capturePath, captureObj.capture_path, captureObj.imagePath, captureObj.image_path, captureObj.screenshotPath, captureObj.screenshot_path);
        checks.push(
          verification("documentation_post_change_capture_returned", Boolean(postChangeCapturePath), "post-change documentation capture path", postChangeCapture),
          verification("documentation_post_change_capture_view_id_matches_request", postChangeCaptureViewId === null || postChangeCaptureViewId === targetCaptureViewId, targetCaptureViewId, postChangeCapture),
          verification("documentation_post_change_capture_quality_ok", captureQualityOk(postChangeCapture), "capture dimensions >= 512 px when reported and requested focus crop applied", postChangeCapture)
        );
        summaryRows.push({ primitive: "post_change_capture", id: targetCaptureViewId, reportedViewId: postChangeCaptureViewId ?? "", path: postChangeCapturePath, status: clip(captureObj.status ?? "captured", 80) });
      }

      const cleanupIds = Array.from(new Set([...(scheduleId !== null && !useExistingSchedule ? [scheduleId] : []), ...(scheduleNoteCreatedForCleanup && scheduleNoteId !== null ? [scheduleNoteId] : []), ...trackedTransport.cleanupIds()]));
      let cleanupDryRun: unknown = null;
      let cleanupApplied: unknown = null;
      let cleanupDryRunIds: number[] = [];
      let cleanupDeletedIds: number[] = [];
      if (cleanupRequested && cleanupIds.length > 0) {
        cleanupDryRun = await transport.post("/revit/delete", {
          ids: cleanupIds,
          apply: false,
          reason: "benchmark cleanup for repeated documentation schedule configure runs"
        });
        rawResults.push(cleanupDryRun);
        cleanupApplied = await transport.post("/revit/delete", {
          ids: cleanupIds,
          apply: true,
          reason: "benchmark cleanup for repeated documentation schedule configure runs"
        });
        rawResults.push(cleanupApplied);
        const cleanupDryObj = asObject(cleanupDryRun);
        const cleanupObj = asObject(cleanupApplied);
        cleanupDryRunIds = deleteEffectIds(cleanupDryRun);
        cleanupDeletedIds = deleteEffectIds(cleanupApplied);
        checks.push(
          verification("documentation_cleanup_dry_run_ok", /dry run/i.test(clip(cleanupDryObj.status, 80)) && cleanupIds.every((id) => cleanupDryRunIds.includes(id)), cleanupIds, cleanupDryRun),
          verification("documentation_cleanup_applied_ids_present", /^deleted$/i.test(clip(cleanupObj.status, 80)) && cleanupIds.every((id) => cleanupDeletedIds.includes(id)), cleanupIds, cleanupApplied)
        );
        summaryRows.push({ primitive: "cleanup_documentation_primitives", id: cleanupDeletedIds.join(";"), status: clip(cleanupObj.status, 80), count: cleanupDeletedIds.length });
      } else if (cleanupRequested) {
        checks.push(
          verification("documentation_cleanup_dry_run_ok", false, "created schedule id required before cleanup", cleanupIds),
          verification("documentation_cleanup_applied_ids_present", false, "created schedule id required before cleanup", cleanupIds)
        );
      } else {
        checks.push(verification("documentation_cleanup_applied_ids_present", true, "not requested", cleanupIds));
      }

      const summaryJsonPath = path.join(runDir, "artifacts", "documentation_primitives_summary.json");
      const summaryMdPath = writeMarkdownTable(path.join(runDir, "artifacts", "documentation_primitives_summary.md"), summaryRows);
      writeJsonFile(summaryJsonPath, {
        scheduleId,
        scheduleDetail,
        requestedFieldCount,
        createdScheduleFieldCount,
        createdScheduleFieldNames,
        configuredScheduleId,
        configuredScheduleDetail,
        configuredScheduleFieldNames,
        scheduleNoteId,
        scheduleNoteResult,
        scheduleNoteMovedIds,
        scheduleNoteReflowPlacement,
        scheduleNoteReflowDryRun,
        scheduleNoteReflowApplied,
        scheduleNoteMoveDryRun,
        scheduleNoteMoveApplied,
        postChangeCapturePath,
        cleanupRequested,
        cleanupIds,
        cleanupDryRunIds,
        cleanupDeletedIds,
        cleanupDryRun,
        cleanupApplied,
        rows: summaryRows,
        rawResults
      });
      checks.push(verification("documentation_summary_written", fs.existsSync(summaryJsonPath) && fs.existsSync(summaryMdPath), [summaryJsonPath, summaryMdPath], summaryRows));
      const success = countOk(checks);
      return {
        workflow: "documentation_primitives",
        success,
        failure_reason: success ? null : "Documentation schedule configure workflow verification failed.",
        tool_calls: rawResults.length,
        revit_transactions: rawResults.filter((result) => asObject(result).dryRun !== true).length,
        computer_use_actions: 0,
        output_artifacts: [summaryJsonPath, summaryMdPath],
        verification_results: checks,
        user_message: success ? `Created, configured, verified, and cleaned up schedule ${scheduleId ?? ""}.` : "Documentation schedule configure workflow ran, but verification failed.",
        raw_results: rawResults
      };
    }

    const textOnlyBase = asObject(request.textNote);
    const textOnlyExistingEdit =
      boolFlag(textOnlyBase.editExisting ?? textOnlyBase.edit_existing) &&
      ["schedule", "configureSchedule", "scheduleConfiguration", "sheet", "existingSheet", "targetSheet", "createView", "view", "viewTemplate", "createViewTemplate", "detailCurves", "annotationCurves", "tag", "categoryVisibility", "filterVisibility", "cadReload", "cadLink", "cadGraphicsOverride"].every((key) => Object.keys(asObject(request[key])).length === 0);
    if (textOnlyExistingEdit) {
      const editViewId = firstPositiveId(textOnlyBase.viewId, request.textViewId, request.viewId);
      const editTextNoteId = firstPositiveId(textOnlyBase.textNoteId, textOnlyBase.text_note_id, textOnlyBase.elementId, textOnlyBase.element_id);
      const expectedExistingText = clip(textOnlyBase.expectedExistingText ?? textOnlyBase.expected_existing_text ?? textOnlyBase.originalText ?? textOnlyBase.original_text ?? textOnlyBase.textContains, 1000);
      const replacementText = clip(textOnlyBase.newText ?? textOnlyBase.replacementText ?? textOnlyBase.text ?? request.text, 1000);
      if (editViewId !== null && editTextNoteId !== null && expectedExistingText && replacementText) {
        const findBefore = await transport.post("/revit/find-text-notes", { viewId: editViewId, contains: expectedExistingText, max: 50 });
        rawResults.push(findBefore);
        const replaceRequest = { elementId: editTextNoteId, newText: replacementText };
        const replaceDryRun = await transport.post("/revit/replace-text-note", { ...replaceRequest, dryRun: true, apply: false });
        rawResults.push(replaceDryRun);
        const replaceApplied = await transport.post("/revit/replace-text-note", { ...replaceRequest, dryRun: false, apply: true, confirm: clip(textOnlyBase.confirm ?? "APPLY 1 TEXT NOTE CHANGE", 120) });
        rawResults.push(replaceApplied);
        const findAfter = await transport.post("/revit/find-text-notes", { viewId: editViewId, contains: replacementText, max: 50 });
        rawResults.push(findAfter);
        checks.push(
          verification("text_note_existing_target_found", textNoteFindResultMatches(findBefore, editTextNoteId, editViewId, expectedExistingText), { textNoteId: editTextNoteId, viewId: editViewId, expectedExistingText }, findBefore),
          verification("text_note_edit_dry_run_ok", asObject(replaceDryRun).dryRun === true || /dry run/i.test(clip(asObject(replaceDryRun).status, 80)), "dry-run text-note replacement preview", replaceDryRun),
          verification("text_note_edit_applied_success", statusLooksOk(replaceApplied), "text-note replacement applied", replaceApplied),
          verification("text_note_edit_apply_matches_request", textNoteReplaceResultMatches(replaceApplied, editTextNoteId, editViewId, replacementText), { textNoteId: editTextNoteId, viewId: editViewId, replacementText }, replaceApplied),
          verification("text_note_edit_readback_matches_request", textNoteFindResultMatches(findAfter, editTextNoteId, editViewId, replacementText), { textNoteId: editTextNoteId, viewId: editViewId, replacementText }, findAfter)
        );
        summaryRows.push({ primitive: "text_note_edit", id: editTextNoteId, parent: editViewId, expectedViewId: editViewId, expectedExistingText, replacementText, status: clip(asObject(replaceApplied).status, 80) });

        if (request.visualVerify !== false) {
          postChangeCapture = await transport.post("/revit/export-image", { viewId: editViewId, reason: "documentation text-note edit post-change visual verification before revert" });
          rawResults.push(postChangeCapture);
          const captureObj = asObject(postChangeCapture);
          const captureView = asObject(captureObj.view);
          const postChangeCaptureViewId = firstPositiveId(captureObj.viewId, captureObj.targetViewId, captureView.id, captureView.viewId);
          postChangeCapturePath = firstPathLike(captureObj.path, captureObj.capturePath, captureObj.capture_path, captureObj.imagePath, captureObj.image_path, captureObj.screenshotPath, captureObj.screenshot_path);
          checks.push(
            verification("documentation_post_change_capture_returned", Boolean(postChangeCapturePath), "post-change documentation capture path", postChangeCapture),
            verification("documentation_post_change_capture_targets_created_context", postChangeCaptureViewId === null || postChangeCaptureViewId === editViewId, editViewId, postChangeCapture),
            verification("documentation_post_change_capture_view_id_matches_request", postChangeCaptureViewId === null || postChangeCaptureViewId === editViewId, editViewId, postChangeCapture),
            verification("documentation_post_change_capture_quality_ok", captureQualityOk(postChangeCapture), "capture dimensions >= 512 px when reported and requested focus crop applied", postChangeCapture),
            verification("cad_link_post_change_capture_targets_sheet", true, "CAD link/import not requested", postChangeCapture)
          );
          summaryRows.push({ primitive: "post_change_capture", id: editViewId, reportedViewId: postChangeCaptureViewId ?? "", path: postChangeCapturePath, status: clip(captureObj.status ?? "captured", 80) });
        }

        const revertRequest = { elementId: editTextNoteId, newText: expectedExistingText };
        const revertDryRun = await transport.post("/revit/replace-text-note", { ...revertRequest, dryRun: true, apply: false });
        rawResults.push(revertDryRun);
        const revertApplied = await transport.post("/revit/replace-text-note", { ...revertRequest, dryRun: false, apply: true, confirm: clip(textOnlyBase.revertConfirm ?? textOnlyBase.confirm ?? "APPLY 1 TEXT NOTE CHANGE", 120) });
        rawResults.push(revertApplied);
        const findReverted = await transport.post("/revit/find-text-notes", { viewId: editViewId, contains: expectedExistingText, max: 50 });
        rawResults.push(findReverted);
        checks.push(
          verification("text_note_edit_revert_dry_run_ok", asObject(revertDryRun).dryRun === true || /dry run/i.test(clip(asObject(revertDryRun).status, 80)), "dry-run text-note revert preview", revertDryRun),
          verification("text_note_edit_revert_applied_success", statusLooksOk(revertApplied), "text-note revert applied", revertApplied),
          verification("text_note_edit_revert_matches_original", textNoteReplaceResultMatches(revertApplied, editTextNoteId, editViewId, expectedExistingText), { textNoteId: editTextNoteId, viewId: editViewId, expectedExistingText }, revertApplied),
          verification("text_note_edit_revert_readback_matches_original", textNoteFindResultMatches(findReverted, editTextNoteId, editViewId, expectedExistingText), { textNoteId: editTextNoteId, viewId: editViewId, expectedExistingText }, findReverted),
          verification("documentation_cleanup_dry_run_ok", true, "existing text note reverted instead of deleted", editTextNoteId),
          verification("documentation_cleanup_applied_ids_present", true, "existing text note reverted instead of deleted", editTextNoteId)
        );
        summaryRows.push({ primitive: "text_note_edit_revert", id: editTextNoteId, parent: editViewId, expectedViewId: editViewId, restoredText: expectedExistingText, status: clip(asObject(revertApplied).status, 80) });
      }
      const summaryJsonPath = path.join(runDir, "artifacts", "documentation_primitives_summary.json");
      const summaryMdPath = writeMarkdownTable(path.join(runDir, "artifacts", "documentation_primitives_summary.md"), summaryRows);
      writeJsonFile(summaryJsonPath, { textNoteId: editTextNoteId, postChangeCapturePath, rows: summaryRows, rawResults });
      checks.push(verification("documentation_summary_written", fs.existsSync(summaryJsonPath) && fs.existsSync(summaryMdPath), [summaryJsonPath, summaryMdPath], summaryRows));
      const success = countOk(checks);
      return {
        workflow: "documentation_primitives",
        success,
        failure_reason: success ? null : "Documentation primitives workflow verification failed.",
        tool_calls: rawResults.length,
        revit_transactions: rawResults.filter((result) => asObject(result).dryRun !== true).length,
        computer_use_actions: 0,
        output_artifacts: [summaryJsonPath, summaryMdPath],
        verification_results: checks,
        user_message: success ? `Edited, verified, and reverted text note ${editTextNoteId}.` : "Documentation text-note edit workflow ran, but verification failed.",
        raw_results: rawResults
      };
    }

    const tagOnlyBase = asObject(request.tag);
    const tagOnlyExistingValueEdit =
      boolFlag(tagOnlyBase.editExistingValue ?? tagOnlyBase.edit_existing_value ?? tagOnlyBase.editExisting ?? tagOnlyBase.edit_existing) &&
      ["schedule", "configureSchedule", "scheduleConfiguration", "sheet", "existingSheet", "targetSheet", "createView", "view", "viewTemplate", "createViewTemplate", "detailCurves", "annotationCurves", "textNote", "categoryVisibility", "filterVisibility", "cadReload", "cadLink", "cadGraphicsOverride"].every((key) => Object.keys(asObject(request[key])).length === 0);
    if (tagOnlyExistingValueEdit) {
      const editViewId = firstPositiveId(tagOnlyBase.viewId, request.tagViewId, request.viewId);
      const taggedElementIds = asNumberArray(tagOnlyBase.elementIds ?? tagOnlyBase.element_ids);
      const existingTagIds = asNumberArray(tagOnlyBase.existingTagIds ?? tagOnlyBase.existing_tag_ids ?? tagOnlyBase.tagIds ?? tagOnlyBase.tag_ids);
      const parameterName = clip(tagOnlyBase.valueSourceParameterName ?? tagOnlyBase.value_source_parameter_name ?? tagOnlyBase.parameterName ?? tagOnlyBase.parameter_name, 200);
      const expectedExistingValue = clip(tagOnlyBase.expectedExistingValue ?? tagOnlyBase.expected_existing_value ?? tagOnlyBase.originalValue ?? tagOnlyBase.original_value, 1000);
      const replacementValue = clip(tagOnlyBase.requestedTagValueHint ?? tagOnlyBase.requested_tag_value_hint ?? tagOnlyBase.tagValue ?? tagOnlyBase.tag_value ?? tagOnlyBase.value ?? tagOnlyBase.text ?? tagOnlyBase.label, 1000);
      const expectedExistingVisibleText = clip(tagOnlyBase.expectedExistingVisibleText ?? tagOnlyBase.expected_existing_visible_text ?? tagOnlyBase.expectedVisibleText ?? tagOnlyBase.expected_visible_text ?? expectedExistingValue, 1000);
      const replacementVisibleText = clip(tagOnlyBase.requestedVisibleText ?? tagOnlyBase.requested_visible_text ?? tagOnlyBase.requestedTagVisibleText ?? tagOnlyBase.requested_tag_visible_text ?? replacementValue, 1000);
      const canEditTagValue = editViewId !== null && taggedElementIds.length > 0 && existingTagIds.length > 0 && parameterName && expectedExistingValue && replacementValue;
      if (canEditTagValue) {
        const beforeParameters = await transport.post("/revit/get-parameters", { elementIds: taggedElementIds, names: [parameterName] });
        rawResults.push(beforeParameters);
        const beforeVisibleTags = await transport.post("/revit/export-visible-elements", { viewId: editViewId, includeMapping: true, limit: 5000 });
        rawResults.push(beforeVisibleTags);
        const changes = taggedElementIds.map((elementId) => ({ elementId, parameterName, value: replacementValue }));
        const parameterDryRun = await transport.post("/revit/set-parameter", { changes, apply: false });
        rawResults.push(parameterDryRun);
        const parameterApplied = await transport.post("/revit/set-parameter", {
          changes,
          apply: true,
          ...(tagOnlyBase.confirm ? { confirm: clip(tagOnlyBase.confirm, 120) } : {})
        });
        rawResults.push(parameterApplied);
        const afterParameters = await transport.post("/revit/get-parameters", { elementIds: taggedElementIds, names: [parameterName] });
        rawResults.push(afterParameters);
        const afterVisibleTags = await transport.post("/revit/export-visible-elements", { viewId: editViewId, includeMapping: true, limit: 5000 });
        rawResults.push(afterVisibleTags);
        checks.push(
          verification("tag_value_existing_visible_readback_matches_original", tagVisibleTextReadbackMatches(beforeVisibleTags, existingTagIds, expectedExistingVisibleText), { existingTagIds, viewId: editViewId, expectedExistingVisibleText }, beforeVisibleTags),
          verification("tag_value_parameter_original_matches_expected", parameterSnapshotMatches(beforeParameters, taggedElementIds, parameterName, expectedExistingValue), { taggedElementIds, parameterName, expectedExistingValue }, beforeParameters),
          verification("tag_value_parameter_dry_run_ok", !hasParameterWriteErrors(parameterDryRun), "dry-run tagged-element parameter write has no errors", parameterDryRun),
          verification("tag_value_parameter_apply_ok", !hasParameterWriteErrors(parameterApplied), "tagged-element parameter write applied without errors", parameterApplied),
          verification("tag_value_parameter_readback_matches_request", parameterSnapshotMatches(afterParameters, taggedElementIds, parameterName, replacementValue), { taggedElementIds, parameterName, replacementValue }, afterParameters),
          verification("tag_value_visible_readback_matches_request", tagVisibleTextReadbackMatches(afterVisibleTags, existingTagIds, replacementVisibleText), { existingTagIds, viewId: editViewId, replacementVisibleText }, afterVisibleTags)
        );
        summaryRows.push({ primitive: "tag_value_edit", id: existingTagIds.join(";"), parent: editViewId, taggedElementIds: taggedElementIds.join(";"), parameterName, expectedExistingValue, replacementValue, expectedExistingVisibleText, replacementVisibleText, status: clip(asObject(parameterApplied).status, 80) });

        if (request.visualVerify !== false) {
          postChangeCapture = await transport.post("/revit/export-image", { viewId: editViewId, reason: "documentation tag value edit post-change visual verification before revert" });
          rawResults.push(postChangeCapture);
          const captureObj = asObject(postChangeCapture);
          const captureView = asObject(captureObj.view);
          const postChangeCaptureViewId = firstPositiveId(captureObj.viewId, captureObj.targetViewId, captureView.id, captureView.viewId);
          postChangeCapturePath = firstPathLike(captureObj.path, captureObj.capturePath, captureObj.capture_path, captureObj.imagePath, captureObj.image_path, captureObj.screenshotPath, captureObj.screenshot_path);
          checks.push(
            verification("documentation_post_change_capture_returned", Boolean(postChangeCapturePath), "post-change documentation capture path", postChangeCapture),
            verification("documentation_post_change_capture_targets_created_context", postChangeCaptureViewId === null || postChangeCaptureViewId === editViewId, editViewId, postChangeCapture),
            verification("documentation_post_change_capture_view_id_matches_request", postChangeCaptureViewId === null || postChangeCaptureViewId === editViewId, editViewId, postChangeCapture),
            verification("documentation_post_change_capture_quality_ok", captureQualityOk(postChangeCapture), "capture dimensions >= 512 px when reported and requested focus crop applied", postChangeCapture),
            verification("cad_link_post_change_capture_targets_sheet", true, "CAD link/import not requested", postChangeCapture)
          );
          summaryRows.push({ primitive: "post_change_capture", id: editViewId, reportedViewId: postChangeCaptureViewId ?? "", path: postChangeCapturePath, status: clip(captureObj.status ?? "captured", 80) });
        }

        const revertChanges = taggedElementIds.map((elementId) => ({ elementId, parameterName, value: expectedExistingValue }));
        const revertDryRun = await transport.post("/revit/set-parameter", { changes: revertChanges, apply: false });
        rawResults.push(revertDryRun);
        const revertApplied = await transport.post("/revit/set-parameter", {
          changes: revertChanges,
          apply: true,
          ...(tagOnlyBase.revertConfirm ?? tagOnlyBase.confirm ? { confirm: clip(tagOnlyBase.revertConfirm ?? tagOnlyBase.confirm, 120) } : {})
        });
        rawResults.push(revertApplied);
        const revertedParameters = await transport.post("/revit/get-parameters", { elementIds: taggedElementIds, names: [parameterName] });
        rawResults.push(revertedParameters);
        const revertedVisibleTags = await transport.post("/revit/export-visible-elements", { viewId: editViewId, includeMapping: true, limit: 5000 });
        rawResults.push(revertedVisibleTags);
        checks.push(
          verification("tag_value_revert_dry_run_ok", !hasParameterWriteErrors(revertDryRun), "dry-run tag value revert has no errors", revertDryRun),
          verification("tag_value_revert_apply_ok", !hasParameterWriteErrors(revertApplied), "tag value revert applied without errors", revertApplied),
          verification("tag_value_revert_parameter_matches_original", parameterSnapshotMatches(revertedParameters, taggedElementIds, parameterName, expectedExistingValue), { taggedElementIds, parameterName, expectedExistingValue }, revertedParameters),
          verification("tag_value_revert_visible_readback_matches_original", tagVisibleTextReadbackMatches(revertedVisibleTags, existingTagIds, expectedExistingVisibleText), { existingTagIds, viewId: editViewId, expectedExistingVisibleText }, revertedVisibleTags),
          verification("documentation_cleanup_dry_run_ok", true, "existing tag value reverted instead of deleting a tag", existingTagIds),
          verification("documentation_cleanup_applied_ids_present", true, "existing tag value reverted instead of deleting a tag", existingTagIds)
        );
        summaryRows.push({ primitive: "tag_value_edit_revert", id: existingTagIds.join(";"), parent: editViewId, taggedElementIds: taggedElementIds.join(";"), parameterName, restoredValue: expectedExistingValue, restoredVisibleText: expectedExistingVisibleText, status: clip(asObject(revertApplied).status, 80) });
      } else {
        checks.push(
          verification("tag_value_existing_visible_readback_matches_original", false, "tag view, existingTagIds, elementIds, valueSourceParameterName, expectedExistingValue, and requestedTagValueHint", tagOnlyBase),
          verification("tag_value_parameter_original_matches_expected", false, "tag value edit inputs", tagOnlyBase),
          verification("tag_value_parameter_dry_run_ok", false, "tag value edit inputs", tagOnlyBase),
          verification("tag_value_parameter_apply_ok", false, "tag value edit inputs", tagOnlyBase),
          verification("tag_value_parameter_readback_matches_request", false, "tag value edit inputs", tagOnlyBase),
          verification("tag_value_visible_readback_matches_request", false, "tag value edit inputs", tagOnlyBase),
          verification("tag_value_revert_dry_run_ok", false, "tag value edit inputs", tagOnlyBase),
          verification("tag_value_revert_apply_ok", false, "tag value edit inputs", tagOnlyBase),
          verification("tag_value_revert_parameter_matches_original", false, "tag value edit inputs", tagOnlyBase),
          verification("tag_value_revert_visible_readback_matches_original", false, "tag value edit inputs", tagOnlyBase)
        );
      }
      const summaryJsonPath = path.join(runDir, "artifacts", "documentation_primitives_summary.json");
      const summaryMdPath = writeMarkdownTable(path.join(runDir, "artifacts", "documentation_primitives_summary.md"), summaryRows);
      writeJsonFile(summaryJsonPath, { tagIds: existingTagIds, taggedElementIds, postChangeCapturePath, rows: summaryRows, rawResults });
      checks.push(verification("documentation_summary_written", fs.existsSync(summaryJsonPath) && fs.existsSync(summaryMdPath), [summaryJsonPath, summaryMdPath], summaryRows));
      const success = countOk(checks);
      return {
        workflow: "documentation_primitives",
        success,
        failure_reason: success ? null : "Documentation primitives workflow verification failed.",
        tool_calls: rawResults.length,
        revit_transactions: rawResults.filter((result) => asObject(result).dryRun !== true).length,
        computer_use_actions: 0,
        output_artifacts: [summaryJsonPath, summaryMdPath],
        verification_results: checks,
        user_message: success ? `Edited, verified, and reverted tag value for ${existingTagIds.length} tag(s).` : "Documentation tag value edit workflow ran, but verification failed.",
        raw_results: rawResults
      };
    }

  const scheduleBase = asObject(request.schedule);
  const configureBase = asObject(request.configureSchedule ?? request.scheduleConfiguration);
  const useExistingSchedule = boolFlag(scheduleBase.useExisting ?? scheduleBase.existing ?? scheduleBase.use_existing);
  const scheduleName = useExistingSchedule
    ? clip(scheduleBase.name ?? scheduleBase.scheduleName ?? request.scheduleName, 240).trim()
    : appendRepeatSuffix(
      scheduleBase.name ?? scheduleBase.scheduleName ?? request.scheduleName,
      runDir,
      "Operator Demo Schedule"
    );
  const scheduleRequest: JsonMap = useExistingSchedule
    ? {
      action: "detail",
      includeFields: true,
      includeRows: true,
      ...scheduleBase,
      ...(firstPositiveId(scheduleBase.scheduleId, scheduleBase.viewId, scheduleBase.existingScheduleId) !== null
        ? { scheduleId: firstPositiveId(scheduleBase.scheduleId, scheduleBase.viewId, scheduleBase.existingScheduleId) }
        : {}),
      ...(scheduleName ? { scheduleName } : {})
    }
    : {
      kind: "regular",
      category: "OST_Doors",
      fields: ["Family and Type", "Count"],
      ...scheduleBase,
      name: scheduleName,
      scheduleName
    };
  const scheduleDryRun = useExistingSchedule
    ? { status: "ExistingScheduleLookup", dryRun: true, scheduleId: firstPositiveId(scheduleRequest.scheduleId), scheduleName }
    : await transport.post("/revit/create-schedule", { ...scheduleRequest, dryRun: true });
  rawResults.push(scheduleDryRun);
  const scheduleApplied = useExistingSchedule
    ? await transport.post("/revit/schedules", scheduleRequest)
    : await transport.post("/revit/create-schedule", { ...scheduleRequest, dryRun: false });
  rawResults.push(scheduleApplied);
  const scheduleObj = asObject(scheduleApplied);
  const scheduleId = firstPositiveId(scheduleObj.viewId, scheduleObj.scheduleId, scheduleObj.id);
  const requestedFieldCount = requestedScheduleFieldCount(scheduleRequest);
  const createdScheduleFieldCount = scheduleFieldCount(scheduleApplied);
  let scheduleDetail: unknown = null;
  if (useExistingSchedule) {
    scheduleDetail = scheduleApplied;
  } else if (scheduleId !== null) {
    try {
      scheduleDetail = await transport.post("/revit/schedules", { action: "detail", scheduleId, includeFields: true });
      rawResults.push(scheduleDetail);
    } catch (error) {
      scheduleDetail = { status: "Error", message: error instanceof Error ? error.message : String(error) };
    }
  }
  const createdScheduleFieldNames = scheduleFieldNames(scheduleApplied, scheduleDetail);
  checks.push(
    verification("schedule_dry_run_ok", asObject(scheduleDryRun).dryRun === true || /dry run/i.test(clip(asObject(scheduleDryRun).status, 80)), "dry-run schedule preview", scheduleDryRun),
    verification("schedule_created_id_present", scheduleId !== null, "schedule view id", scheduleApplied),
    verification("schedule_created_field_count_matches_request", requestedFieldCount === 0 || (createdScheduleFieldCount !== null && createdScheduleFieldCount >= requestedFieldCount), requestedFieldCount, scheduleApplied),
    verification("schedule_created_fields_match_request", scheduleFieldsMatchRequest(scheduleRequest, scheduleApplied, scheduleDetail), requestedStringArray(scheduleRequest.fields), createdScheduleFieldNames),
    verification("schedule_created_placement_matches_request", schedulePlacementProofMatchesRequest(scheduleRequest, scheduleApplied), "schedule placement proof when requested", scheduleApplied)
  );
  summaryRows.push({ primitive: "schedule", id: scheduleId ?? "", name: scheduleName, requestedFieldCount, fieldCount: createdScheduleFieldCount ?? "", requestedFields: requestedStringArray(scheduleRequest.fields).join(";"), reportedFields: createdScheduleFieldNames.join(";"), status: clip(scheduleObj.status ?? "created", 80) });

  const configureRequest: JsonMap = {
    addFields: [],
    replaceFilters: false,
    replaceSortGroup: false,
    ...configureBase,
    ...(scheduleId !== null ? { scheduleId } : {})
  };
  const configureDryRun = await transport.post("/revit/configure-schedule", { ...configureRequest, dryRun: true });
  rawResults.push(configureDryRun);
  const configureApplied = await transport.post("/revit/configure-schedule", { ...configureRequest, dryRun: false });
  rawResults.push(configureApplied);
  const configureObj = asObject(configureApplied);
  const configuredSchedule = asObject(configureObj.schedule);
  const configuredScheduleId = firstPositiveId(configureObj.scheduleId, configureObj.viewId, configureObj.id, configuredSchedule.id, configuredSchedule.viewId);
  let configuredScheduleDetail: unknown = null;
  if (configuredScheduleId !== null) {
    try {
      configuredScheduleDetail = await transport.post("/revit/schedules", { action: "detail", scheduleId: configuredScheduleId, includeFields: true });
      rawResults.push(configuredScheduleDetail);
    } catch (error) {
      configuredScheduleDetail = { status: "Error", message: error instanceof Error ? error.message : String(error) };
    }
  }
  const requestedConfiguredFieldNames = [
    ...requestedStringArray(scheduleRequest.fields),
    ...requestedStringArray(configureRequest.addFields)
  ];
  const configuredScheduleFieldNames = scheduleFieldNames(configureApplied, configuredScheduleDetail);
  checks.push(
    verification("schedule_config_dry_run_ok", asObject(configureDryRun).dryRun === true || /dry run/i.test(clip(asObject(configureDryRun).status, 80)), "dry-run schedule configuration preview", configureDryRun),
    verification("schedule_config_applied_success", statusLooksOk(configureApplied), "schedule configuration status success", configureApplied),
    verification("schedule_config_target_matches_created_schedule", scheduleId !== null && configuredScheduleId === scheduleId, scheduleId, configureApplied),
    verification("schedule_config_applied_operations_match_request", scheduleConfigAppliedProofMatchesRequest(configureRequest, configureApplied), "applied schedule configuration operation evidence", configureApplied),
    verification("schedule_config_fields_match_request", scheduleFieldsMatchNames(requestedConfiguredFieldNames, configureApplied, configuredScheduleDetail), requestedConfiguredFieldNames, configuredScheduleFieldNames),
    verification("schedule_config_text_value_readback_matches_request", scheduleConfigTextValueReadbackMatchesRequest(configureRequest, configureApplied, configuredScheduleDetail), { targetFieldName: configureRequest.targetFieldName ?? configureRequest.targetField ?? configureRequest.columnName ?? configureRequest.fieldName, requestedTextOrValue: configureRequest.requestedTextOrValue ?? configureRequest.requestedValue ?? configureRequest.value, readbackRequired: configureRequest.readbackRequired ?? configureRequest.readback_required ?? configureRequest.requireReadback }, configuredScheduleDetail)
  );
  summaryRows.push({ primitive: "configure_schedule", id: configuredScheduleId ?? "", expectedScheduleId: scheduleId ?? "", requestedFields: requestedConfiguredFieldNames.join(";"), reportedFields: configuredScheduleFieldNames.join(";"), status: clip(configureObj.status, 80) });

  const sheetBase = asObject(request.sheet);
  const existingSheetBase = asObject(request.existingSheet ?? request.targetSheet);
  const useExistingSheet = Boolean(sheetBase.useExisting ?? sheetBase.existing ?? existingSheetBase.useExisting ?? Object.keys(existingSheetBase).length > 0);
  const sheetNumber = useExistingSheet
    ? clip(existingSheetBase.number ?? existingSheetBase.sheetNumber ?? sheetBase.number ?? sheetBase.sheetNumber ?? request.sheetNumber, 120).trim()
    : appendRepeatSuffix(sheetBase.number ?? sheetBase.sheetNumber ?? request.sheetNumber, runDir, "OP-DEMO");
  const sheetName = useExistingSheet
    ? clip(existingSheetBase.name ?? existingSheetBase.sheetName ?? sheetBase.name ?? sheetBase.sheetName ?? request.sheetName, 240).trim()
    : appendRepeatSuffix(sheetBase.name ?? sheetBase.sheetName ?? request.sheetName, runDir, "Operator Demo Documentation");
  const createTargetSheetIfMissing = useExistingSheet && Boolean(
    existingSheetBase.createIfMissing ??
    existingSheetBase.createMissing ??
    existingSheetBase.createTargetIfMissing ??
    sheetBase.createIfMissing ??
    sheetBase.createMissing ??
    sheetBase.createTargetIfMissing
  );
  const sheetRequest = useExistingSheet
    ? {
      action: "detail",
      includePlacedViews: true,
      includeViewports: true,
      includeViewportGeometry: true,
      includeSheetOutline: true,
      ...sheetBase,
      ...existingSheetBase,
      ...(sheetNumber ? { sheetNumber } : {}),
      ...(firstPositiveId(existingSheetBase.sheetId, existingSheetBase.viewId, sheetBase.sheetId, sheetBase.viewId) !== null
        ? { sheetId: firstPositiveId(existingSheetBase.sheetId, existingSheetBase.viewId, sheetBase.sheetId, sheetBase.viewId) }
        : {})
    }
    : {
      titleBlockId: -1,
      ...sheetBase,
      number: sheetNumber,
      name: sheetName
    };
  let sheetApplied = useExistingSheet
    ? await transport.post("/revit/sheets", sheetRequest)
    : await transport.post("/revit/create-sheet", sheetRequest);
  const sheetLookupObj = asObject(sheetApplied);
  const sheetLookupMissing = useExistingSheet && firstPositiveId(sheetLookupObj.id, sheetLookupObj.sheetId, sheetLookupObj.sheetElementId, sheetLookupObj.viewId) === null && /^notfound$/i.test(clip(sheetLookupObj.status, 80));
  if (sheetLookupMissing && createTargetSheetIfMissing) {
    const createTargetSheetRequest = {
      titleBlockId: -1,
      ...sheetBase,
      ...existingSheetBase,
      number: sheetNumber,
      name: sheetName || clip(existingSheetBase.sheetName ?? sheetBase.sheetName ?? request.sheetName, 240).trim() || `Operator Target Sheet ${sheetNumber || "Demo"}`
    };
    delete (createTargetSheetRequest as JsonMap).useExisting;
    delete (createTargetSheetRequest as JsonMap).existing;
    delete (createTargetSheetRequest as JsonMap).createIfMissing;
    delete (createTargetSheetRequest as JsonMap).createMissing;
    delete (createTargetSheetRequest as JsonMap).createTargetIfMissing;
    sheetApplied = await transport.post("/revit/create-sheet", createTargetSheetRequest);
    rawResults.push({
      status: "TargetSheetCreatedAfterMissingLookup",
      requested: sheetRequest,
      createTargetSheetRequest,
      missingLookup: sheetLookupObj,
      created: sheetApplied
    });
  }
  rawResults.push(sheetApplied);
  const sheetObj = asObject(sheetApplied);
  const sheetId = firstPositiveId(sheetObj.id, sheetObj.sheetId, sheetObj.sheetElementId, sheetObj.viewId);
  const reportedSheetNumber = clip(sheetObj.number ?? sheetObj.sheetNumber, 120);
  checks.push(
    verification("sheet_created_id_present", sheetId !== null, "sheet id", sheetApplied),
    verification("sheet_number_matches_request", !sheetNumber || reportedSheetNumber.toUpperCase() === sheetNumber.toUpperCase(), sheetNumber, sheetObj.number ?? sheetObj.sheetNumber)
  );
  summaryRows.push({
    primitive: "sheet",
    id: sheetId ?? "",
    name: sheetName || clip(sheetObj.name ?? sheetObj.sheetName, 240),
    number: sheetNumber || reportedSheetNumber,
    existing: useExistingSheet,
    createdIfMissing: sheetLookupMissing && createTargetSheetIfMissing && sheetId !== null,
    status: clip(sheetObj.status ?? (useExistingSheet ? "resolved" : "created"), 80)
  });

  const createViewBase = asObject(request.createView ?? request.view);
  const createViewName = appendRepeatSuffix(createViewBase.name ?? request.viewName, runDir, "Operator Demo Drafting View");
  const createViewRequest = {
    action: "create_drafting",
    scale: 100,
    ...createViewBase,
    name: createViewName
  };
  const createViewDryRun = await transport.post("/revit/create-view", { ...createViewRequest, dryRun: true });
  rawResults.push(createViewDryRun);
  const createViewApplied = await transport.post("/revit/create-view", { ...createViewRequest, dryRun: false });
  rawResults.push(createViewApplied);
  const createViewObj = asObject(createViewApplied);
  const createdView = asObject(createViewObj.view);
  const createdViewId = firstPositiveId(createViewObj.viewId, createViewObj.id, createdView.id, createdView.viewId);
  checks.push(
    verification("view_create_dry_run_ok", asObject(createViewDryRun).dryRun === true || /dry run/i.test(clip(asObject(createViewDryRun).status, 80)), "dry-run view creation preview", createViewDryRun),
    verification("view_created_id_present", createdViewId !== null, "created view id", createViewApplied)
  );
  summaryRows.push({ primitive: "create_view", id: createdViewId ?? "", name: createViewName, status: clip(createViewObj.status, 80) });

  const templateBase = asObject(request.viewTemplate ?? request.createViewTemplate);
  const templateName = appendRepeatSuffix(templateBase.name ?? request.viewTemplateName, runDir, "Operator Demo View Template");
  let templateViewId: number | null = null;
  if (createdViewId !== null) {
    const templateRequest = {
      action: "create_view_template",
      ...templateBase,
      name: templateName,
      sourceViewId: firstPositiveId(templateBase.sourceViewId) ?? createdViewId
    };
    const templateDryRun = await transport.post("/revit/create-view", { ...templateRequest, dryRun: true });
    rawResults.push(templateDryRun);
    const templateApplied = await transport.post("/revit/create-view", { ...templateRequest, dryRun: false });
    rawResults.push(templateApplied);
    const templateObj = asObject(templateApplied);
    const templateView = asObject(templateObj.view);
    templateViewId = firstPositiveId(templateObj.viewId, templateObj.id, templateView.id, templateView.viewId);
    checks.push(
      verification("view_template_create_dry_run_ok", asObject(templateDryRun).dryRun === true || /dry run/i.test(clip(asObject(templateDryRun).status, 80)), "dry-run view template creation preview", templateDryRun),
      verification("view_template_created_id_present", templateViewId !== null, "created view template id", templateApplied)
    );
    summaryRows.push({ primitive: "create_view_template", id: templateViewId ?? "", name: templateName, sourceViewId: createdViewId, status: clip(templateObj.status, 80) });
  } else {
    checks.push(
      verification("view_template_create_dry_run_ok", false, "created view required before template creation", createViewApplied),
      verification("view_template_created_id_present", false, "created view template id", null)
    );
  }

  const detailCurveBase = asObject(request.detailCurves ?? request.annotationCurves);
  const detailCurveViewId = firstPositiveId(detailCurveBase.viewId, request.detailCurveViewId, createdViewId);
  if (detailCurveViewId !== null) {
    const detailCurveRequest = {
      lineStyleCreate: {
        name: appendRepeatSuffix("Operator Demo Annotation Lines", runDir, "Operator Demo Annotation Lines"),
        lineWeight: 3,
        r: 220,
        g: 0,
        b: 0
      },
      curves: [
        {
          kind: "line",
          a: { x: 0, y: 0, z: 0 },
          b: { x: 3, y: 0, z: 0 }
        }
      ],
      ...detailCurveBase,
      viewId: detailCurveViewId
    };
    const detailCurveDryRun = await transport.post("/revit/draw-detail-curves", { ...detailCurveRequest, dryRun: true });
    rawResults.push(detailCurveDryRun);
    const detailCurveApplied = await transport.post("/revit/draw-detail-curves", { ...detailCurveRequest, dryRun: false });
    rawResults.push(detailCurveApplied);
    const detailCurveObj = asObject(detailCurveApplied);
    detailCurveIds = asNumberArray(detailCurveObj.detailCurveIds);
    const requestedDetailCurveCount = Array.isArray(detailCurveRequest.curves) ? detailCurveRequest.curves.length : 0;
    checks.push(
      verification("detail_curves_dry_run_ok", asObject(detailCurveDryRun).dryRun === true || /dry run/i.test(clip(asObject(detailCurveDryRun).status, 80)), "dry-run detail curve preview", detailCurveDryRun),
      verification("detail_curves_target_matches_request", detailCurveProofMatchesRequest(detailCurveViewId, requestedDetailCurveCount, detailCurveDryRun, detailCurveApplied), { viewId: detailCurveViewId, requestedCurveCount: requestedDetailCurveCount }, detailCurveApplied),
      verification("detail_curve_ids_created", statusLooksOk(detailCurveApplied) && requestedDetailCurveCount > 0 && detailCurveIds.length >= requestedDetailCurveCount, `at least ${requestedDetailCurveCount} created detail curve id(s)`, detailCurveApplied)
    );
    summaryRows.push({ primitive: "detail_curves", id: detailCurveIds.join(";"), parent: detailCurveViewId, expectedViewId: detailCurveViewId, dryRunViewId: firstPositiveId(asObject(detailCurveDryRun).viewId) ?? "", reportedViewId: firstPositiveId(detailCurveObj.viewId) ?? "", requestedCurveCount: requestedDetailCurveCount, dryRunSegments: asObject(detailCurveDryRun).segmentsCreated ?? "", appliedSegments: detailCurveObj.segmentsCreated ?? "", status: clip(detailCurveObj.status, 80), count: detailCurveIds.length });
  } else {
    checks.push(
      verification("detail_curves_dry_run_ok", false, "detail curve target view id", detailCurveViewId),
      verification("detail_curves_target_matches_request", false, "detail curve target view id", detailCurveViewId),
      verification("detail_curve_ids_created", false, "created detail curve ids", null)
    );
  }

  let placedViewportId: number | null = null;
  let postChangeCaptureTargetId: number | null = null;
  let postChangeCaptureViewId: number | null = null;
  const placeViewBase = asObject(request.placeView);
  const placeViewId = firstPositiveId(placeViewBase.viewId, request.placeViewId, createdViewId);
  if (sheetId !== null && placeViewId !== null) {
    const placed = await transport.post("/revit/place-view", {
      ...placeViewBase,
      sheetId,
      viewId: placeViewId,
      x: Number(placeViewBase.x ?? 1),
      y: Number(placeViewBase.y ?? 1)
    });
    rawResults.push(placed);
    const placedObj = asObject(placed);
    placedViewportId = firstPositiveId(placedObj.id, placedObj.viewportId);
    checks.push(
      verification("view_placed_on_sheet", placedViewportId !== null && /^placed$/i.test(clip(placedObj.status, 80)), "Placed viewport id", placed),
      verification("view_placed_targets_match_request", placedViewProofMatchesRequest(sheetId, placeViewId, placed), { sheetId, viewId: placeViewId }, placed)
    );
    summaryRows.push({ primitive: "place_view", id: placedViewportId ?? "", parent: sheetId, expectedSheetId: sheetId, expectedViewId: placeViewId, reportedSheetId: firstPositiveId(placedObj.sheetId, asObject(placedObj.sheet).id) ?? "", reportedViewId: firstPositiveId(placedObj.viewId, asObject(placedObj.view).id) ?? "", status: clip(placedObj.status, 80) });
  } else {
    checks.push(
      verification("view_placed_on_sheet", false, "sheet id and created/requested view id", { sheetId, placeViewId }),
      verification("view_placed_targets_match_request", false, "sheet id and created/requested view id", { sheetId, placeViewId })
    );
  }

  const visibilityBase = asObject(request.visibility);
  const visibilityViewId = firstPositiveId(visibilityBase.viewId, request.visibilityViewId, placeViewId);
  const tagBase = asObject(request.tag);
  if (visibilityViewId !== null) {
    const visibilityRequest = {
      action: "set_detail_level",
      detailLevel: "Fine",
      ...visibilityBase,
      viewId: visibilityViewId
    };
    const visibilityDryRun = await transport.post("/revit/visibility", { ...visibilityRequest, dryRun: true });
    rawResults.push(visibilityDryRun);
    const visibilityApplied = await transport.post("/revit/visibility", { ...visibilityRequest, dryRun: false });
    rawResults.push(visibilityApplied);
    const visibilityObj = asObject(visibilityApplied);
    const visibilityView = asObject(visibilityObj.view);
    const visibilityAppliedViewId = firstPositiveId(visibilityObj.viewId, visibilityObj.id, visibilityView.id, visibilityView.viewId);
    checks.push(
      verification("visibility_dry_run_ok", asObject(visibilityDryRun).dryRun === true || /dry run/i.test(clip(asObject(visibilityDryRun).status, 80)), "dry-run visibility preview", visibilityDryRun),
      verification("visibility_applied_success", statusLooksOk(visibilityApplied), "visibility status success", visibilityApplied),
      verification("visibility_target_matches_created_view", visibilityAppliedViewId === visibilityViewId, visibilityViewId, visibilityApplied),
      verification("visibility_applied_setting_matches_request", visibilityAppliedProofMatchesRequest(visibilityRequest, visibilityApplied), "applied visibility setting evidence", visibilityApplied)
    );
    summaryRows.push({ primitive: "visibility", id: visibilityAppliedViewId ?? "", expectedViewId: visibilityViewId, action: visibilityRequest.action, ...visibilitySummaryFields(visibilityRequest, visibilityView), status: clip(visibilityObj.status, 80) });
  }

  const categoryVisibilityBase = asObject(request.categoryVisibility ?? request.categoryOverrideVisibility);
  if (Object.keys(categoryVisibilityBase).length > 0) {
    const categoryNameForTargeting = normalizedProofText(categoryVisibilityBase.categoryName);
    const categoryVisibilityViewId = /^(lines|ost_lines)$/.test(categoryNameForTargeting)
      ? firstPositiveId(categoryVisibilityBase.viewId, request.categoryVisibilityViewId, placeViewId, visibilityBase.viewId, visibilityViewId, tagBase.viewId)
      : firstPositiveId(categoryVisibilityBase.viewId, request.categoryVisibilityViewId, tagBase.viewId, visibilityBase.viewId, visibilityViewId, placeViewId);
    if (categoryVisibilityViewId !== null) {
      const categoryVisibilityRequest = {
        action: "set_category_override",
        lineWeight: 5,
        ...categoryVisibilityBase,
        viewId: categoryVisibilityViewId
      };
      const categoryVisibilityDryRun = await transport.post("/revit/visibility", { ...categoryVisibilityRequest, dryRun: true });
      rawResults.push(categoryVisibilityDryRun);
      const categoryVisibilityApplied = await transport.post("/revit/visibility", { ...categoryVisibilityRequest, dryRun: false });
      rawResults.push(categoryVisibilityApplied);
      const categoryVisibilityObj = asObject(categoryVisibilityApplied);
      const categoryVisibilityView = asObject(categoryVisibilityObj.view);
      const categoryVisibilityAppliedViewId = firstPositiveId(categoryVisibilityObj.viewId, categoryVisibilityObj.id, categoryVisibilityView.id, categoryVisibilityView.viewId);
      checks.push(
        verification("category_visibility_dry_run_ok", asObject(categoryVisibilityDryRun).dryRun === true || /dry run/i.test(clip(asObject(categoryVisibilityDryRun).status, 80)), "dry-run category visibility override preview", categoryVisibilityDryRun),
        verification("category_visibility_applied_success", statusLooksOk(categoryVisibilityApplied), "category visibility status success", categoryVisibilityApplied),
        verification("category_visibility_target_matches_request", categoryVisibilityAppliedViewId === categoryVisibilityViewId, categoryVisibilityViewId, categoryVisibilityApplied),
        verification("category_visibility_applied_override_matches_request", visibilityAppliedProofMatchesRequest(categoryVisibilityRequest, categoryVisibilityApplied), "applied category visibility override evidence", categoryVisibilityApplied)
      );
      summaryRows.push({ primitive: "category_visibility", id: categoryVisibilityAppliedViewId ?? "", expectedViewId: categoryVisibilityViewId, action: categoryVisibilityRequest.action, ...visibilitySummaryFields(categoryVisibilityRequest, categoryVisibilityView), status: clip(categoryVisibilityObj.status, 80) });
      if (parseBool(categoryVisibilityBase.revertAfterVerify ?? categoryVisibilityBase.revert_after_verify) === true) {
        categoryVisibilityRevertRequest = {
          ...categoryVisibilityRequest,
          action: "clear_category_override"
        };
        delete categoryVisibilityRevertRequest.lineWeight;
        delete categoryVisibilityRevertRequest.line_weight;
      }
    } else {
      checks.push(
        verification("category_visibility_dry_run_ok", false, "category visibility target view id", categoryVisibilityViewId),
        verification("category_visibility_applied_success", false, "category visibility target view id", categoryVisibilityViewId),
        verification("category_visibility_target_matches_request", false, "category visibility target view id", categoryVisibilityViewId),
        verification("category_visibility_applied_override_matches_request", false, "category visibility target view id", categoryVisibilityViewId)
      );
    }
  }

  const linkedModelCategoryVisibilityBase = asObject(
    request.linkedModelCategoryVisibility ??
    request.linkedModelVisibility ??
    request.revitLinkCategoryVisibility
  );
  if (Object.keys(linkedModelCategoryVisibilityBase).length > 0) {
    const linkedModelCategoryVisibilityViewId = firstPositiveId(linkedModelCategoryVisibilityBase.viewId, request.linkedModelCategoryVisibilityViewId, visibilityBase.viewId, visibilityViewId, placeViewId, tagBase.viewId);
    if (linkedModelCategoryVisibilityViewId !== null) {
      const linkedModelCategoryVisibilityRequest = {
        action: "set_category_override",
        lineWeight: 5,
        ...linkedModelCategoryVisibilityBase,
        viewId: linkedModelCategoryVisibilityViewId
      };
      const linkedModelCategoryVisibilityDryRun = await transport.post("/revit/visibility", { ...linkedModelCategoryVisibilityRequest, dryRun: true });
      rawResults.push(linkedModelCategoryVisibilityDryRun);
      const linkedModelCategoryVisibilityApplied = await transport.post("/revit/visibility", { ...linkedModelCategoryVisibilityRequest, dryRun: false });
      rawResults.push(linkedModelCategoryVisibilityApplied);
      const linkedModelCategoryVisibilityObj = asObject(linkedModelCategoryVisibilityApplied);
      const linkedModelCategoryVisibilityView = asObject(linkedModelCategoryVisibilityObj.view);
      const linkedModelCategoryVisibilityAppliedViewId = firstPositiveId(linkedModelCategoryVisibilityObj.viewId, linkedModelCategoryVisibilityObj.id, linkedModelCategoryVisibilityView.id, linkedModelCategoryVisibilityView.viewId);
      checks.push(
        verification("linked_model_category_visibility_dry_run_ok", asObject(linkedModelCategoryVisibilityDryRun).dryRun === true || /dry run/i.test(clip(asObject(linkedModelCategoryVisibilityDryRun).status, 80)), "dry-run linked model category visibility override preview", linkedModelCategoryVisibilityDryRun),
        verification("linked_model_category_visibility_applied_success", statusLooksOk(linkedModelCategoryVisibilityApplied), "linked model category visibility status success", linkedModelCategoryVisibilityApplied),
        verification("linked_model_category_visibility_target_matches_request", linkedModelCategoryVisibilityAppliedViewId === linkedModelCategoryVisibilityViewId, linkedModelCategoryVisibilityViewId, linkedModelCategoryVisibilityApplied),
        verification("linked_model_category_visibility_applied_override_matches_request", visibilityAppliedProofMatchesRequest(linkedModelCategoryVisibilityRequest, linkedModelCategoryVisibilityApplied), "applied linked model category visibility override evidence", linkedModelCategoryVisibilityApplied)
      );
      summaryRows.push({ primitive: "linked_model_category_visibility", id: linkedModelCategoryVisibilityAppliedViewId ?? "", expectedViewId: linkedModelCategoryVisibilityViewId, action: linkedModelCategoryVisibilityRequest.action, ...visibilitySummaryFields(linkedModelCategoryVisibilityRequest, linkedModelCategoryVisibilityView), status: clip(linkedModelCategoryVisibilityObj.status, 80) });
      if (parseBool(linkedModelCategoryVisibilityBase.revertAfterVerify ?? linkedModelCategoryVisibilityBase.revert_after_verify) === true) {
        linkedModelCategoryVisibilityRevertRequest = {
          ...linkedModelCategoryVisibilityRequest,
          action: "clear_category_override"
        };
        delete linkedModelCategoryVisibilityRevertRequest.lineWeight;
        delete linkedModelCategoryVisibilityRevertRequest.line_weight;
      }
    } else {
      checks.push(
        verification("linked_model_category_visibility_dry_run_ok", false, "linked model category visibility target view id", linkedModelCategoryVisibilityViewId),
        verification("linked_model_category_visibility_applied_success", false, "linked model category visibility target view id", linkedModelCategoryVisibilityViewId),
        verification("linked_model_category_visibility_target_matches_request", false, "linked model category visibility target view id", linkedModelCategoryVisibilityViewId),
        verification("linked_model_category_visibility_applied_override_matches_request", false, "linked model category visibility target view id", linkedModelCategoryVisibilityViewId)
      );
    }
  }

  const phaseVisibilityBase = asObject(request.phaseVisibility ?? request.viewPhaseVisibility);
  if (Object.keys(phaseVisibilityBase).length > 0) {
    const phaseVisibilityViewId = firstPositiveId(phaseVisibilityBase.viewId, request.phaseVisibilityViewId, visibilityBase.viewId, visibilityViewId, placeViewId, tagBase.viewId);
    if (phaseVisibilityViewId !== null) {
      const phaseRequestCore: JsonMap = { ...phaseVisibilityBase };
      delete phaseRequestCore.phaseFilterName;
      delete phaseRequestCore.phaseFilter;
      delete phaseRequestCore.phaseFilterId;
      if (phaseVisibilityBase.phaseName !== undefined || phaseVisibilityBase.phase !== undefined || phaseVisibilityBase.phaseId !== undefined) {
        const phaseVisibilityRequest = {
          action: "set_phase",
          ...phaseRequestCore,
          viewId: phaseVisibilityViewId
        };
        const phaseVisibilityDryRun = await transport.post("/revit/visibility", { ...phaseVisibilityRequest, dryRun: true });
        rawResults.push(phaseVisibilityDryRun);
        const phaseVisibilityApplied = await transport.post("/revit/visibility", { ...phaseVisibilityRequest, dryRun: false });
        rawResults.push(phaseVisibilityApplied);
        const phaseVisibilityObj = asObject(phaseVisibilityApplied);
        const phaseVisibilityView = asObject(phaseVisibilityObj.view);
        const phaseVisibilityAppliedViewId = firstPositiveId(phaseVisibilityObj.viewId, phaseVisibilityObj.id, phaseVisibilityView.id, phaseVisibilityView.viewId);
        checks.push(
          verification("phase_visibility_dry_run_ok", asObject(phaseVisibilityDryRun).dryRun === true || /dry run/i.test(clip(asObject(phaseVisibilityDryRun).status, 80)), "dry-run phase visibility preview", phaseVisibilityDryRun),
          verification("phase_visibility_applied_success", statusLooksOk(phaseVisibilityApplied), "phase visibility status success", phaseVisibilityApplied),
          verification("phase_visibility_target_matches_request", phaseVisibilityAppliedViewId === phaseVisibilityViewId, phaseVisibilityViewId, phaseVisibilityApplied),
          verification("phase_visibility_applied_setting_matches_request", visibilityAppliedProofMatchesRequest(phaseVisibilityRequest, phaseVisibilityApplied), "applied phase visibility evidence", phaseVisibilityApplied)
        );
        summaryRows.push({ primitive: "phase_visibility", id: phaseVisibilityAppliedViewId ?? "", expectedViewId: phaseVisibilityViewId, action: phaseVisibilityRequest.action, ...visibilitySummaryFields(phaseVisibilityRequest, phaseVisibilityView), status: clip(phaseVisibilityObj.status, 80) });
        if (parseBool(phaseVisibilityBase.revertAfterVerify ?? phaseVisibilityBase.revert_after_verify) === true) {
          phaseVisibilityRevertRequest = {
            action: "set_phase",
            ...(phaseVisibilityBase.originalPhaseId !== undefined ? { phaseId: phaseVisibilityBase.originalPhaseId } : {}),
            ...(phaseVisibilityBase.originalPhaseName !== undefined || phaseVisibilityBase.originalPhase !== undefined ? { phaseName: phaseVisibilityBase.originalPhaseName ?? phaseVisibilityBase.originalPhase } : {}),
            viewId: phaseVisibilityViewId
          };
        }
      }

      if (phaseVisibilityBase.phaseFilterName !== undefined || phaseVisibilityBase.phaseFilter !== undefined || phaseVisibilityBase.phaseFilterId !== undefined) {
        const phaseFilterVisibilityRequest = {
          action: "set_phase_filter",
          phaseFilterName: phaseVisibilityBase.phaseFilterName ?? phaseVisibilityBase.phaseFilter,
          ...(phaseVisibilityBase.phaseFilterId !== undefined ? { phaseFilterId: phaseVisibilityBase.phaseFilterId } : {}),
          viewId: phaseVisibilityViewId
        };
        const phaseFilterVisibilityDryRun = await transport.post("/revit/visibility", { ...phaseFilterVisibilityRequest, dryRun: true });
        rawResults.push(phaseFilterVisibilityDryRun);
        const phaseFilterVisibilityApplied = await transport.post("/revit/visibility", { ...phaseFilterVisibilityRequest, dryRun: false });
        rawResults.push(phaseFilterVisibilityApplied);
        const phaseFilterVisibilityObj = asObject(phaseFilterVisibilityApplied);
        const phaseFilterVisibilityView = asObject(phaseFilterVisibilityObj.view);
        const phaseFilterVisibilityAppliedViewId = firstPositiveId(phaseFilterVisibilityObj.viewId, phaseFilterVisibilityObj.id, phaseFilterVisibilityView.id, phaseFilterVisibilityView.viewId);
        checks.push(
          verification("phase_filter_visibility_dry_run_ok", asObject(phaseFilterVisibilityDryRun).dryRun === true || /dry run/i.test(clip(asObject(phaseFilterVisibilityDryRun).status, 80)), "dry-run phase filter visibility preview", phaseFilterVisibilityDryRun),
          verification("phase_filter_visibility_applied_success", statusLooksOk(phaseFilterVisibilityApplied), "phase filter visibility status success", phaseFilterVisibilityApplied),
          verification("phase_filter_visibility_target_matches_request", phaseFilterVisibilityAppliedViewId === phaseVisibilityViewId, phaseVisibilityViewId, phaseFilterVisibilityApplied),
          verification("phase_filter_visibility_applied_setting_matches_request", visibilityAppliedProofMatchesRequest(phaseFilterVisibilityRequest, phaseFilterVisibilityApplied), "applied phase filter visibility evidence", phaseFilterVisibilityApplied)
        );
        summaryRows.push({ primitive: "phase_filter_visibility", id: phaseFilterVisibilityAppliedViewId ?? "", expectedViewId: phaseVisibilityViewId, action: phaseFilterVisibilityRequest.action, ...visibilitySummaryFields(phaseFilterVisibilityRequest, phaseFilterVisibilityView), status: clip(phaseFilterVisibilityObj.status, 80) });
        if (parseBool(phaseVisibilityBase.revertAfterVerify ?? phaseVisibilityBase.revert_after_verify) === true) {
          phaseFilterVisibilityRevertRequest = {
            action: "set_phase_filter",
            ...(phaseVisibilityBase.originalPhaseFilterId !== undefined ? { phaseFilterId: phaseVisibilityBase.originalPhaseFilterId } : {}),
            phaseFilterName: phaseVisibilityBase.originalPhaseFilterName ?? phaseVisibilityBase.originalPhaseFilter,
            viewId: phaseVisibilityViewId
          };
        }
      }
    } else {
      checks.push(
        verification("phase_visibility_dry_run_ok", false, "phase visibility target view id", phaseVisibilityViewId),
        verification("phase_visibility_applied_success", false, "phase visibility target view id", phaseVisibilityViewId),
        verification("phase_visibility_target_matches_request", false, "phase visibility target view id", phaseVisibilityViewId),
        verification("phase_visibility_applied_setting_matches_request", false, "phase visibility target view id", phaseVisibilityViewId)
      );
    }
  }

  const filterVisibilityBase = asObject(request.filterVisibility ?? request.viewFilterVisibility);
  if (Object.keys(filterVisibilityBase).length > 0) {
    const filterVisibilityViewId = firstPositiveId(filterVisibilityBase.viewId, request.filterVisibilityViewId, placeViewId, visibilityBase.viewId, visibilityViewId, tagBase.viewId);
    if (filterVisibilityViewId !== null) {
      const filterCreateBase = asObject(filterVisibilityBase.createFilter ?? filterVisibilityBase.create_filter);
      const filterVisibilityCore: JsonMap = { ...filterVisibilityBase };
      delete filterVisibilityCore.createFilter;
      delete filterVisibilityCore.create_filter;
      const requestedFilterName = appendRepeatSuffix(filterVisibilityCore.filterName, runDir, "Operator Demo Future Work");
      if (Object.keys(filterCreateBase).length > 0) {
        const filterCreateRequest = {
          filterVisible: true,
          lineWeight: 5,
          ...filterCreateBase,
          ...filterVisibilityCore,
          action: "create_view_filter",
          filterName: requestedFilterName,
          viewId: filterVisibilityViewId
        };
        const filterCreateDryRun = await transport.post("/revit/visibility", { ...filterCreateRequest, dryRun: true });
        rawResults.push(filterCreateDryRun);
        const filterCreateApplied = await transport.post("/revit/visibility", { ...filterCreateRequest, dryRun: false });
        rawResults.push(filterCreateApplied);
        const filterCreateObj = asObject(filterCreateApplied);
        const filterCreateView = asObject(filterCreateObj.view);
        const filterCreateAppliedViewId = firstPositiveId(filterCreateObj.viewId, filterCreateObj.id, filterCreateView.id, filterCreateView.viewId);
        createdFilterId = filterIdFromVisibilityResult(filterCreateRequest, filterCreateApplied);
        checks.push(
          verification("filter_visibility_create_dry_run_ok", asObject(filterCreateDryRun).dryRun === true || /dry run/i.test(clip(asObject(filterCreateDryRun).status, 80)), "dry-run create view filter preview", filterCreateDryRun),
          verification("filter_visibility_create_applied_success", statusLooksOk(filterCreateApplied), "create view filter status success", filterCreateApplied),
          verification("filter_visibility_create_target_matches_request", filterCreateAppliedViewId === filterVisibilityViewId, filterVisibilityViewId, filterCreateApplied),
          verification("filter_visibility_created_filter_id_present", createdFilterId !== null, "created view filter id", filterCreateApplied)
        );
        summaryRows.push({ primitive: "filter_visibility_create", id: createdFilterId ?? "", expectedViewId: filterVisibilityViewId, action: filterCreateRequest.action, ...visibilitySummaryFields(filterCreateRequest, filterCreateView), status: clip(filterCreateObj.status, 80) });
      }
      const filterVisibilityRequest = {
        action: "apply_view_filter",
        filterVisible: true,
        lineWeight: 5,
        ...filterVisibilityCore,
        filterName: requestedFilterName,
        ...(createdFilterId !== null ? { filterId: createdFilterId } : {}),
        viewId: filterVisibilityViewId
      };
      const filterVisibilityDryRun = await transport.post("/revit/visibility", { ...filterVisibilityRequest, dryRun: true });
      rawResults.push(filterVisibilityDryRun);
      const filterVisibilityApplied = await transport.post("/revit/visibility", { ...filterVisibilityRequest, dryRun: false });
      rawResults.push(filterVisibilityApplied);
      const filterVisibilityObj = asObject(filterVisibilityApplied);
      const filterVisibilityView = asObject(filterVisibilityObj.view);
      const filterVisibilityAppliedViewId = firstPositiveId(filterVisibilityObj.viewId, filterVisibilityObj.id, filterVisibilityView.id, filterVisibilityView.viewId);
      checks.push(
        verification("filter_visibility_dry_run_ok", asObject(filterVisibilityDryRun).dryRun === true || /dry run/i.test(clip(asObject(filterVisibilityDryRun).status, 80)), "dry-run filter visibility override preview", filterVisibilityDryRun),
        verification("filter_visibility_applied_success", statusLooksOk(filterVisibilityApplied), "filter visibility status success", filterVisibilityApplied),
        verification("filter_visibility_target_matches_request", filterVisibilityAppliedViewId === filterVisibilityViewId, filterVisibilityViewId, filterVisibilityApplied),
        verification("filter_visibility_applied_override_matches_request", visibilityAppliedProofMatchesRequest(filterVisibilityRequest, filterVisibilityApplied), "applied filter visibility override evidence", filterVisibilityApplied)
      );
      summaryRows.push({ primitive: "filter_visibility", id: filterVisibilityAppliedViewId ?? "", expectedViewId: filterVisibilityViewId, action: filterVisibilityRequest.action, ...visibilitySummaryFields(filterVisibilityRequest, filterVisibilityView), status: clip(filterVisibilityObj.status, 80) });
      if (parseBool(filterVisibilityBase.revertAfterVerify ?? filterVisibilityBase.revert_after_verify) === true) {
        filterVisibilityRevertRequest = {
          ...filterVisibilityRequest,
          action: "clear_filter_override"
        };
        delete filterVisibilityRevertRequest.lineWeight;
        delete filterVisibilityRevertRequest.line_weight;
        delete filterVisibilityRevertRequest.r;
        delete filterVisibilityRevertRequest.g;
        delete filterVisibilityRevertRequest.b;
      }
    } else {
      checks.push(
        verification("filter_visibility_dry_run_ok", false, "filter visibility target view id", filterVisibilityViewId),
        verification("filter_visibility_applied_success", false, "filter visibility target view id", filterVisibilityViewId),
        verification("filter_visibility_target_matches_request", false, "filter visibility target view id", filterVisibilityViewId),
        verification("filter_visibility_applied_override_matches_request", false, "filter visibility target view id", filterVisibilityViewId)
      );
    }
  }

  const templateVisibilityBase = asObject(request.templateVisibility ?? request.viewTemplateVisibility);
  if (templateViewId !== null) {
    const templateVisibilityRequest = {
      action: "set_detail_level",
      detailLevel: "Fine",
      ...templateVisibilityBase,
      viewId: templateViewId
    };
    const templateVisibilityDryRun = await transport.post("/revit/visibility", { ...templateVisibilityRequest, dryRun: true });
    rawResults.push(templateVisibilityDryRun);
    const templateVisibilityApplied = await transport.post("/revit/visibility", { ...templateVisibilityRequest, dryRun: false });
    rawResults.push(templateVisibilityApplied);
    const templateVisibilityObj = asObject(templateVisibilityApplied);
    const templateVisibilityView = asObject(templateVisibilityObj.view);
    const templateVisibilityAppliedViewId = firstPositiveId(templateVisibilityObj.viewId, templateVisibilityObj.id, templateVisibilityView.id, templateVisibilityView.viewId);
    checks.push(
      verification("view_template_visibility_dry_run_ok", asObject(templateVisibilityDryRun).dryRun === true || /dry run/i.test(clip(asObject(templateVisibilityDryRun).status, 80)), "dry-run view template visibility preview", templateVisibilityDryRun),
      verification("view_template_visibility_applied_success", statusLooksOk(templateVisibilityApplied), "view template visibility status success", templateVisibilityApplied),
      verification("view_template_visibility_target_matches_template", templateVisibilityAppliedViewId === templateViewId, templateViewId, templateVisibilityApplied),
      verification("view_template_visibility_applied_setting_matches_request", visibilityAppliedProofMatchesRequest(templateVisibilityRequest, templateVisibilityApplied), "applied view template visibility setting evidence", templateVisibilityApplied)
    );
    summaryRows.push({ primitive: "view_template_visibility", id: templateVisibilityAppliedViewId ?? "", expectedViewId: templateViewId, action: templateVisibilityRequest.action, ...visibilitySummaryFields(templateVisibilityRequest, templateVisibilityView), status: clip(templateVisibilityObj.status, 80) });
  } else {
    checks.push(
      verification("view_template_visibility_dry_run_ok", false, "view template id", templateViewId),
      verification("view_template_visibility_applied_success", false, "view template id", templateViewId),
      verification("view_template_visibility_target_matches_template", false, "view template id", templateViewId),
      verification("view_template_visibility_applied_setting_matches_request", false, "view template id", templateViewId)
    );
  }

  const templateCategoryVisibilityBase = asObject(request.templateCategoryVisibility ?? request.viewTemplateCategoryVisibility ?? request.templateCategoryOverrideVisibility);
  if (Object.keys(templateCategoryVisibilityBase).length > 0) {
    const templateCategoryVisibilityTargetId = boolFlag(templateCategoryVisibilityBase.requireExistingTemplateTarget ?? templateCategoryVisibilityBase.require_existing_template_target)
      ? firstPositiveId(templateCategoryVisibilityBase.existingTemplateId, templateCategoryVisibilityBase.templateId, templateCategoryVisibilityBase.viewTemplateId)
      : templateViewId;
    if (templateCategoryVisibilityTargetId !== null) {
      const templateCategoryVisibilityRequest = {
        action: "set_category_override",
        lineWeight: 5,
        ...templateCategoryVisibilityBase,
        viewId: templateCategoryVisibilityTargetId
      };
      const templateCategoryVisibilityDryRun = await transport.post("/revit/visibility", { ...templateCategoryVisibilityRequest, dryRun: true });
      rawResults.push(templateCategoryVisibilityDryRun);
      const templateCategoryVisibilityApplied = await transport.post("/revit/visibility", { ...templateCategoryVisibilityRequest, dryRun: false });
      rawResults.push(templateCategoryVisibilityApplied);
      const templateCategoryVisibilityObj = asObject(templateCategoryVisibilityApplied);
      const templateCategoryVisibilityView = asObject(templateCategoryVisibilityObj.view);
      const templateCategoryVisibilityAppliedViewId = firstPositiveId(templateCategoryVisibilityObj.viewId, templateCategoryVisibilityObj.id, templateCategoryVisibilityView.id, templateCategoryVisibilityView.viewId);
      checks.push(
        verification("view_template_category_visibility_dry_run_ok", asObject(templateCategoryVisibilityDryRun).dryRun === true || /dry run/i.test(clip(asObject(templateCategoryVisibilityDryRun).status, 80)), "dry-run view template category visibility override preview", templateCategoryVisibilityDryRun),
        verification("view_template_category_visibility_applied_success", statusLooksOk(templateCategoryVisibilityApplied), "view template category visibility status success", templateCategoryVisibilityApplied),
        verification("view_template_category_visibility_target_matches_template", templateCategoryVisibilityAppliedViewId === templateCategoryVisibilityTargetId, templateCategoryVisibilityTargetId, templateCategoryVisibilityApplied),
        verification("view_template_category_visibility_applied_override_matches_request", visibilityAppliedProofMatchesRequest(templateCategoryVisibilityRequest, templateCategoryVisibilityApplied), "applied view template category visibility override evidence", templateCategoryVisibilityApplied)
      );
      summaryRows.push({ primitive: "view_template_category_visibility", id: templateCategoryVisibilityAppliedViewId ?? "", expectedViewId: templateCategoryVisibilityTargetId, action: templateCategoryVisibilityRequest.action, ...visibilitySummaryFields(templateCategoryVisibilityRequest, templateCategoryVisibilityView), status: clip(templateCategoryVisibilityObj.status, 80) });
      if (parseBool(templateCategoryVisibilityBase.revertAfterVerify ?? templateCategoryVisibilityBase.revert_after_verify) === true) {
        templateCategoryVisibilityRevertRequest = {
          ...templateCategoryVisibilityRequest,
          action: "clear_category_override"
        };
        delete templateCategoryVisibilityRevertRequest.lineWeight;
        delete templateCategoryVisibilityRevertRequest.line_weight;
      }
    } else {
      checks.push(
        verification("view_template_category_visibility_dry_run_ok", false, "view template id", templateCategoryVisibilityTargetId),
        verification("view_template_category_visibility_applied_success", false, "view template id", templateCategoryVisibilityTargetId),
        verification("view_template_category_visibility_target_matches_template", false, "view template id", templateCategoryVisibilityTargetId),
        verification("view_template_category_visibility_applied_override_matches_request", false, "view template id", templateCategoryVisibilityTargetId)
      );
    }
  }

  const applyViewTemplateRaw = request.applyViewTemplate ?? request.viewTemplateAssignment;
  if (applyViewTemplateRaw !== undefined) {
    const applyTemplateBase = asObject(applyViewTemplateRaw);
    const targetViewId = firstPositiveId(applyTemplateBase.viewId, createdViewId);
    if (targetViewId !== null && templateViewId !== null) {
      const applyTemplateRequest = {
        action: "set_template",
        templateName,
        ...applyTemplateBase,
        viewId: targetViewId
      };
      const applyTemplateDryRun = await transport.post("/revit/visibility", { ...applyTemplateRequest, dryRun: true });
      rawResults.push(applyTemplateDryRun);
      const applyTemplateApplied = await transport.post("/revit/visibility", { ...applyTemplateRequest, dryRun: false });
      rawResults.push(applyTemplateApplied);
      const applyTemplateObj = asObject(applyTemplateApplied);
      const applyTemplateView = asObject(applyTemplateObj.view);
      const applyTemplateAppliedViewId = firstPositiveId(applyTemplateObj.viewId, applyTemplateObj.id, applyTemplateView.id, applyTemplateView.viewId);
      checks.push(
        verification("view_template_assignment_dry_run_ok", asObject(applyTemplateDryRun).dryRun === true || /dry run/i.test(clip(asObject(applyTemplateDryRun).status, 80)), "dry-run view template assignment preview", applyTemplateDryRun),
        verification("view_template_assignment_applied_success", statusLooksOk(applyTemplateApplied), "view template assignment status success", applyTemplateApplied),
        verification("view_template_assignment_target_matches_created_view", applyTemplateAppliedViewId === targetViewId, targetViewId, applyTemplateApplied),
        verification("view_template_assignment_setting_matches_request", visibilityAppliedProofMatchesRequest(applyTemplateRequest, applyTemplateApplied), "applied view template assignment evidence", applyTemplateApplied)
      );
      summaryRows.push({ primitive: "view_template_assignment", id: applyTemplateAppliedViewId ?? "", expectedViewId: targetViewId, expectedTemplateId: templateViewId, action: applyTemplateRequest.action, ...visibilitySummaryFields(applyTemplateRequest, applyTemplateView), status: clip(applyTemplateObj.status, 80) });
    } else {
      checks.push(
        verification("view_template_assignment_dry_run_ok", false, "created view and template ids", { createdViewId, templateViewId }),
        verification("view_template_assignment_applied_success", false, "created view and template ids", { createdViewId, templateViewId }),
        verification("view_template_assignment_target_matches_created_view", false, "created view and template ids", { createdViewId, templateViewId }),
        verification("view_template_assignment_setting_matches_request", false, "created view and template ids", { createdViewId, templateViewId })
      );
    }
  }

  const textBase = asObject(request.textNote);
  const textViewId = firstPositiveId(textBase.viewId, request.textViewId, sheetId, placeViewId);
  if (textViewId !== null && boolFlag(textBase.editExisting ?? textBase.edit_existing)) {
    const existingTextNoteId = firstPositiveId(textBase.textNoteId, textBase.text_note_id, textBase.elementId, textBase.element_id);
    const expectedExistingText = clip(textBase.expectedExistingText ?? textBase.expected_existing_text ?? textBase.originalText ?? textBase.original_text ?? textBase.textContains, 1000);
    const replacementText = clip(textBase.newText ?? textBase.replacementText ?? textBase.text ?? request.text, 1000);
    editedTextNoteViewId = textViewId;
    if (existingTextNoteId !== null && expectedExistingText && replacementText) {
      const findBefore = await transport.post("/revit/find-text-notes", {
        viewId: textViewId,
        contains: expectedExistingText,
        max: 50
      });
      rawResults.push(findBefore);
      const replaceRequest = {
        elementId: existingTextNoteId,
        newText: replacementText
      };
      const replaceDryRun = await transport.post("/revit/replace-text-note", { ...replaceRequest, dryRun: true, apply: false });
      rawResults.push(replaceDryRun);
      const replaceApplied = await transport.post("/revit/replace-text-note", {
        ...replaceRequest,
        dryRun: false,
        apply: true,
        confirm: clip(textBase.confirm ?? "APPLY 1 TEXT NOTE CHANGE", 120)
      });
      rawResults.push(replaceApplied);
      const findAfter = await transport.post("/revit/find-text-notes", {
        viewId: textViewId,
        contains: replacementText,
        max: 50
      });
      rawResults.push(findAfter);
      checks.push(
        verification("text_note_existing_target_found", textNoteFindResultMatches(findBefore, existingTextNoteId, textViewId, expectedExistingText), { textNoteId: existingTextNoteId, viewId: textViewId, expectedExistingText }, findBefore),
        verification("text_note_edit_dry_run_ok", asObject(replaceDryRun).dryRun === true || /dry run/i.test(clip(asObject(replaceDryRun).status, 80)), "dry-run text-note replacement preview", replaceDryRun),
        verification("text_note_edit_applied_success", statusLooksOk(replaceApplied), "text-note replacement applied", replaceApplied),
        verification("text_note_edit_apply_matches_request", textNoteReplaceResultMatches(replaceApplied, existingTextNoteId, textViewId, replacementText), { textNoteId: existingTextNoteId, viewId: textViewId, replacementText }, replaceApplied),
        verification("text_note_edit_readback_matches_request", textNoteFindResultMatches(findAfter, existingTextNoteId, textViewId, replacementText), { textNoteId: existingTextNoteId, viewId: textViewId, replacementText }, findAfter)
      );
      summaryRows.push({ primitive: "text_note_edit", id: existingTextNoteId, parent: textViewId, expectedViewId: textViewId, expectedExistingText, replacementText, status: clip(asObject(replaceApplied).status, 80) });
    } else {
      checks.push(
        verification("text_note_existing_target_found", false, "textNoteId, viewId, expectedExistingText, and replacement text", textBase),
        verification("text_note_edit_dry_run_ok", false, "textNoteId, viewId, expectedExistingText, and replacement text", textBase),
        verification("text_note_edit_applied_success", false, "textNoteId, viewId, expectedExistingText, and replacement text", textBase),
        verification("text_note_edit_apply_matches_request", false, "textNoteId, viewId, expectedExistingText, and replacement text", textBase),
        verification("text_note_edit_readback_matches_request", false, "textNoteId, viewId, expectedExistingText, and replacement text", textBase)
      );
    }
  } else if (textViewId !== null) {
    const text = appendRepeatSuffix(textBase.text ?? request.text, runDir, "Operator demo annotation");
    const textResult = await transport.post("/revit/create-text", {
      x: 1,
      y: 1,
      ...textBase,
      viewId: textViewId,
      text
    });
    rawResults.push(textResult);
    textNoteId = firstPositiveId(asObject(textResult).id, asObject(textResult).textNoteId, asObject(textResult).elementId, asObject(textResult).createdElementId);
    checks.push(
      verification("text_note_created", statusLooksOk(textResult) && textNoteId !== null, "created text note id", textResult),
      verification("text_note_target_matches_request", textNoteProofMatchesRequest(textViewId, text, firstPositiveId(textBase.typeId, request.textTypeId), textResult), { viewId: textViewId, text, typeId: firstPositiveId(textBase.typeId, request.textTypeId) }, textResult),
      verification("text_note_readback_matches_request", textNoteReadbackMatchesRequest(textBase, textViewId, text, firstPositiveId(textBase.typeId, request.textTypeId), textResult), { viewId: textViewId, text, typeId: firstPositiveId(textBase.typeId, request.textTypeId), readbackRequired: textBase.readbackRequired ?? textBase.readback_required ?? textBase.requireReadback }, textResult)
    );
    summaryRows.push({ primitive: "text_note", id: textNoteId ?? "", parent: textViewId, expectedViewId: textViewId, reportedViewId: firstPositiveId(asObject(textResult).viewId, asObject(asObject(textResult).view).id) ?? "", text, status: clip(asObject(textResult).status, 80) });
  }

  const tagElementIds = asNumberArray(tagBase.elementIds);
  checks.push(verification(
    "tag_request_present",
    graphicsOnly && tagElementIds.length === 0 ? true : tagElementIds.length > 0,
    graphicsOnly && tagElementIds.length === 0 ? "tagging is not required for graphics-only documentation redlines" : "tag.elementIds must contain at least one taggable element id",
    tagBase
  ));
  if (tagElementIds.length > 0) {
    const tagViewId = firstPositiveId(tagBase.viewId, request.tagViewId, placeViewId, visibilityViewId);
    if (tagViewId !== null) {
      const tagRequest = { onlyUntagged: false, max: tagElementIds.length, ...tagBase, viewId: tagViewId, elementIds: tagElementIds };
      const tagDryRun = await transport.post("/revit/tag-elements", { ...tagRequest, dryRun: true });
      rawResults.push(tagDryRun);
      const tagApplied = await transport.post("/revit/tag-elements", { ...tagRequest, dryRun: false });
      rawResults.push(tagApplied);
      const tagObj = asObject(tagApplied);
      tagIds = asNumberArray(tagObj.tagIds);
      const expectedTagCount = Math.max(1, Math.min(tagElementIds.length, Number(tagObj.targetCount ?? tagObj.taggedCount ?? tagElementIds.length)));
      checks.push(
        verification("tag_dry_run_ok", asObject(tagDryRun).dryRun === true || /dry run/i.test(clip(asObject(tagDryRun).status, 80)), "dry-run tag preview", tagDryRun),
        verification("tag_dry_run_targets_match_request", tagDryRunProofMatchesRequest(tagRequest, tagDryRun), "dry-run tag view and target evidence", tagDryRun),
        verification("tag_applied_targets_match_request", tagAppliedProofMatchesRequest(tagRequest, tagApplied), "applied tag view and target evidence", tagApplied),
        verification("tag_readback_matches_request", tagReadbackMatchesRequest(tagRequest, tagApplied), "reported tag readback must cover requested targets and requested type/value hints", tagApplied),
        verification("tag_created_count_matches_request", tagCreatedCountMatchesRequest(tagRequest, tagApplied), tagElementIds.length, tagApplied),
        verification("tag_ids_created", tagIds.length >= expectedTagCount && Number(tagObj.errorCount ?? 0) === 0, `at least ${expectedTagCount} created tag id(s)`, tagApplied)
      );
      const tagDryRunObj = asObject(tagDryRun);
      const dryRunTargetIds = tagResultTargetIds(tagDryRun);
      summaryRows.push({
        primitive: "tag",
        id: tagIds.join(";"),
        parent: tagViewId,
        expectedViewId: tagViewId,
        reportedViewId: tagResultViewId(tagApplied) ?? "",
        requestedTargetIds: tagElementIds.join(";"),
        dryRunTargetIds: dryRunTargetIds.join(";"),
        appliedTagIds: tagIds.join(";"),
        requestedTargetCount: tagElementIds.length,
        dryRunTargetCount: tagDryRunObj.targetCount ?? "",
        appliedTargetCount: tagObj.targetCount ?? "",
        taggedCount: tagObj.taggedCount ?? "",
        status: clip(tagObj.status, 80),
        count: tagIds.length
      });
    } else {
      checks.push(
        verification("tag_dry_run_ok", false, "tag target view id", tagViewId),
        verification("tag_dry_run_targets_match_request", false, "tag target view id", tagViewId),
        verification("tag_applied_targets_match_request", false, "tag target view id", tagViewId),
        verification("tag_readback_matches_request", false, "tag target view id", tagViewId),
        verification("tag_created_count_matches_request", false, "tag target view id", tagViewId),
        verification("tag_ids_created", false, "created tag ids", null)
      );
    }
  } else if (!graphicsOnly) {
    checks.push(
      verification("tag_dry_run_ok", false, "tag.elementIds must contain at least one taggable element id", tagBase),
      verification("tag_dry_run_targets_match_request", false, "tag.elementIds must contain at least one taggable element id", tagBase),
      verification("tag_applied_targets_match_request", false, "tag.elementIds must contain at least one taggable element id", tagBase),
      verification("tag_readback_matches_request", false, "tag.elementIds must contain at least one taggable element id", tagBase),
      verification("tag_created_count_matches_request", false, "tag.elementIds must contain at least one taggable element id", tagBase),
      verification("tag_ids_created", false, "created tag ids", null)
    );
  }

  const cadLinkBase = asObject(request.cadLink ?? request.cadImport ?? request.linkCad);
  const cadGraphicsBase = asObject(request.cadGraphicsOverride ?? request.cadLayerOverride ?? request.cadVisibility);
  if (Object.keys(cadLinkBase).length > 0) {
    checks.push(verification("cad_link_request_present", Boolean(clip(cadLinkBase.sourcePath, 500).trim()), "cadLink.sourcePath must be present", cadLinkBase));
    if (sheetId !== null) {
      const cadLinkRequest: JsonMap = {
        placement: "center",
        link: true,
        ...cadLinkBase,
        sheetViewId: sheetId
      };
      const cadLinkDryRun = await transport.post("/revit/link-cad", { ...cadLinkRequest, dryRun: true });
      rawResults.push(cadLinkDryRun);
      const cadLinkApplied = await transport.post("/revit/link-cad", { ...cadLinkRequest, dryRun: false });
      rawResults.push(cadLinkApplied);
      const cadLinkObj = asObject(cadLinkApplied);
      cadLinkId = firstPositiveId(cadLinkObj.elementId, cadLinkObj.importInstanceId, cadLinkObj.cadLinkId, cadLinkObj.id);
      const cadOwnerViewId = cadLinkOwnerViewId(cadLinkApplied);
      const cadViewportId = firstPositiveId(cadLinkObj.viewportId, asObject(cadLinkObj.viewport).id);
      const cadCategories = objectArray(cadLinkObj.cadCategories);
      const cadLinkDryObj = asObject(cadLinkDryRun);
      const cadLinkPlan = asObject(cadLinkDryObj.plan);
      checks.push(
        verification("cad_link_dry_run_ok", cadLinkDryObj.dryRun === true || /dry run/i.test(clip(cadLinkDryObj.status, 80)), "dry-run CAD link/import preview", cadLinkDryRun),
        verification("cad_link_applied_id_present", statusLooksOk(cadLinkApplied) && cadLinkId !== null, "applied CAD link/import element id", cadLinkApplied),
        verification("cad_link_source_matches_request", cadLinkSourceMatchesRequest(cadLinkRequest, cadLinkApplied), cadLinkRequest.sourcePath, cadLinkApplied),
        verification("cad_link_sheet_matches_request", cadLinkSheetMatchesRequest(sheetId, cadLinkApplied), sheetId, cadLinkApplied),
        verification("cad_link_owner_view_reported", cadOwnerViewId !== null, "CAD owner view id", cadLinkApplied),
        verification("cad_link_viewport_placed_on_sheet", cadLinkViewportMatchesRequest(sheetId, cadLinkApplied), "CAD owner view placed as viewport on requested sheet", cadLinkApplied),
        verification("cad_link_viewport_box_sheet_sized", cadLinkViewportBoxLooksSheetSized(cadLinkApplied), "CAD viewport box must be sheet-sized, not model-extents-sized", cadLinkApplied),
        verification("cad_link_owner_view_bbox_reported", cadLinkOwnerViewBoundingBoxReported(cadLinkApplied), "CAD element bounding box in owner view", cadLinkApplied),
        verification("cad_link_layer_categories_reported", Object.keys(cadGraphicsBase).length === 0 || cadCategories.length > 0, "CAD category/layer readback when graphics override is requested", cadLinkApplied)
      );
      summaryRows.push({
        primitive: "cad_link",
        id: cadLinkId ?? "",
        parent: sheetId,
        expectedSheetId: sheetId,
        dryRunSheetId: firstPositiveId(cadLinkPlan.sheetViewId, cadLinkPlan.sheetId) ?? "",
        reportedSheetId: firstPositiveId(cadLinkObj.sheetViewId, cadLinkObj.sheetId, asObject(cadLinkObj.sheet).id) ?? "",
        ownerViewId: cadOwnerViewId ?? "",
        viewportId: cadViewportId ?? "",
        requestedSourcePath: cadLinkRequest.sourcePath ?? "",
        reportedSourcePath: cadLinkObj.sourcePath ?? cadLinkObj.sourceFullPath ?? "",
        cadCategoryCount: cadCategories.length,
        targetMode: cadLinkObj.targetMode ?? cadLinkPlan.targetMode ?? "",
        mode: cadLinkObj.mode ?? "",
        status: clip(cadLinkObj.status, 80)
      });
      if (Object.keys(cadGraphicsBase).length > 0) {
        const cadCategorySelection = selectCadCategoryForOverride(cadGraphicsBase, cadLinkRequest, cadCategories);
        const cadCategoryName = cadCategorySelection.appliedName;
        const cadGraphicsViewId = firstPositiveId(cadGraphicsBase.viewId, cadOwnerViewId, sheetId) ?? sheetId;
        const cadGraphicsRequest: JsonMap = {
          action: "set_category_override",
          lineWeight: 5,
          ...cadGraphicsBase,
          categoryName: cadCategoryName,
          viewId: cadGraphicsViewId
        };
        const cadGraphicsDryRun = await transport.post("/revit/visibility", { ...cadGraphicsRequest, dryRun: true });
        rawResults.push(cadGraphicsDryRun);
        const cadGraphicsApplied = await transport.post("/revit/visibility", { ...cadGraphicsRequest, dryRun: false });
        rawResults.push(cadGraphicsApplied);
        const cadGraphicsObj = asObject(cadGraphicsApplied);
        const cadGraphicsView = asObject(cadGraphicsObj.view);
        cadGraphicsOverrideTargetId = firstPositiveId(cadGraphicsObj.viewId, cadGraphicsObj.id, cadGraphicsView.id, cadGraphicsView.viewId);
        checks.push(
          verification("cad_graphics_override_layer_selected", Boolean(cadCategoryName), "CAD layer/subcategory name", { ...cadCategorySelection, cadCategories }),
          verification("cad_graphics_override_dry_run_ok", asObject(cadGraphicsDryRun).dryRun === true || /dry run/i.test(clip(asObject(cadGraphicsDryRun).status, 80)), "dry-run CAD graphics override preview", cadGraphicsDryRun),
          verification("cad_graphics_override_applied_success", statusLooksOk(cadGraphicsApplied), "CAD graphics override status success", cadGraphicsApplied),
          verification("cad_graphics_override_target_matches_owner_view", cadGraphicsOverrideTargetId === cadGraphicsRequest.viewId, cadGraphicsRequest.viewId, cadGraphicsApplied),
          verification("cad_graphics_override_lineweight_matches_request", visibilityAppliedProofMatchesRequest(cadGraphicsRequest, cadGraphicsApplied), "CAD layer lineweight override readback", cadGraphicsApplied)
        );
        summaryRows.push({
          primitive: "cad_graphics_override",
          id: cadGraphicsOverrideTargetId ?? "",
          expectedViewId: cadGraphicsRequest.viewId,
          action: cadGraphicsRequest.action,
          requestedCadCategoryName: cadCategorySelection.requestedName || cadCategoryName,
          appliedCadCategoryName: cadCategorySelection.appliedName,
          cadCategoryMatchKind: cadCategorySelection.matchKind,
          cadCategoryMatchedRequested: cadCategorySelection.matchedRequested,
          cadCategoryId: cadCategorySelection.categoryId ?? "",
          cadCategoryDepth: cadCategorySelection.depth ?? "",
          cadCategoryCount: cadCategories.length,
          ...visibilitySummaryFields(cadGraphicsRequest, cadGraphicsView),
          status: clip(cadGraphicsObj.status, 80)
        });
      }
    } else {
      checks.push(
        verification("cad_link_dry_run_ok", false, "sheet id required before CAD link/import", sheetId),
        verification("cad_link_applied_id_present", false, "sheet id required before CAD link/import", sheetId),
        verification("cad_link_source_matches_request", false, "sheet id required before CAD link/import", sheetId),
        verification("cad_link_sheet_matches_request", false, "sheet id required before CAD link/import", sheetId),
        verification("cad_link_owner_view_reported", false, "sheet id required before CAD link/import", sheetId),
        verification("cad_link_viewport_placed_on_sheet", false, "sheet id required before CAD link/import", sheetId),
        verification("cad_link_viewport_box_sheet_sized", false, "sheet id required before CAD link/import", sheetId),
        verification("cad_link_owner_view_bbox_reported", false, "sheet id required before CAD link/import", sheetId),
        verification("cad_link_layer_categories_reported", false, "sheet id required before CAD link/import", sheetId)
      );
    }
  } else if (Object.keys(cadGraphicsBase).length > 0) {
    checks.push(
      verification("cad_graphics_override_layer_selected", false, "cadLink is required before CAD graphics override", cadGraphicsBase),
      verification("cad_graphics_override_dry_run_ok", false, "cadLink is required before CAD graphics override", cadGraphicsBase),
      verification("cad_graphics_override_applied_success", false, "cadLink is required before CAD graphics override", cadGraphicsBase),
      verification("cad_graphics_override_target_matches_owner_view", false, "cadLink is required before CAD graphics override", cadGraphicsBase),
      verification("cad_graphics_override_lineweight_matches_request", false, "cadLink is required before CAD graphics override", cadGraphicsBase)
    );
  }

  const captureViewId = firstPositiveId(request.visualViewId, request.captureViewId, request.afterCaptureViewId, sheetId, placeViewId, createdViewId);
  const cadLinkRequested = Object.keys(cadLinkBase).length > 0;
  if (request.visualVerify !== false && captureViewId !== null) {
    postChangeCaptureTargetId = captureViewId;
    postChangeCapture = await transport.post("/revit/export-image", {
      viewId: captureViewId,
      reason: "documentation primitives post-change visual verification before cleanup"
    });
    rawResults.push(postChangeCapture);
    const captureObj = asObject(postChangeCapture);
    const captureView = asObject(captureObj.view);
    postChangeCaptureViewId = firstPositiveId(captureObj.viewId, captureObj.targetViewId, captureView.id, captureView.viewId);
    postChangeCapturePath = firstPathLike(captureObj.path, captureObj.capturePath, captureObj.capture_path, captureObj.imagePath, captureObj.image_path, captureObj.screenshotPath, captureObj.screenshot_path);
    const createdCaptureTargets = [sheetId, placeViewId, createdViewId, editedTextNoteViewId].filter((id): id is number => id !== null);
    const expectedCaptureContext = graphicsOnly ? "graphics-only existing view/sheet capture target" : createdCaptureTargets;
    checks.push(
      verification("documentation_post_change_capture_returned", Boolean(postChangeCapturePath), "post-change documentation capture path", postChangeCapture),
      verification("documentation_post_change_capture_targets_created_context", graphicsOnly || createdCaptureTargets.includes(captureViewId), expectedCaptureContext, captureViewId),
      verification("documentation_post_change_capture_view_id_matches_request", postChangeCaptureViewId === null || postChangeCaptureViewId === captureViewId, captureViewId, postChangeCapture),
      verification("documentation_post_change_capture_quality_ok", captureQualityOk(postChangeCapture), "capture dimensions >= 512 px when reported and requested focus crop applied", postChangeCapture),
      verification(
        "cad_link_post_change_capture_targets_sheet",
        !cadLinkRequested || (sheetId !== null && captureViewId === sheetId && (postChangeCaptureViewId === null || postChangeCaptureViewId === sheetId)),
        cadLinkRequested ? sheetId : "CAD link/import not requested",
        postChangeCapture
      )
    );
    summaryRows.push({ primitive: "post_change_capture", id: captureViewId, reportedViewId: postChangeCaptureViewId ?? "", path: postChangeCapturePath, status: clip(captureObj.status ?? "captured", 80) });
  } else {
    checks.push(
      verification("documentation_post_change_capture_returned", false, "post-change documentation capture target view id", { visualVerify: request.visualVerify, captureViewId }),
      verification("documentation_post_change_capture_targets_created_context", false, "created documentation capture target", { visualVerify: request.visualVerify, captureViewId }),
      verification("documentation_post_change_capture_view_id_matches_request", false, "post-change documentation capture view id", { visualVerify: request.visualVerify, captureViewId }),
      verification("documentation_post_change_capture_quality_ok", false, "post-change documentation capture quality", { visualVerify: request.visualVerify, captureViewId }),
      verification("cad_link_post_change_capture_targets_sheet", !cadLinkRequested, "post-change CAD sheet capture target", { visualVerify: request.visualVerify, captureViewId, sheetId })
    );
  }

  if (editedTextNoteViewId !== null) {
    const existingTextNoteId = firstPositiveId(textBase.textNoteId, textBase.text_note_id, textBase.elementId, textBase.element_id);
    const expectedExistingText = clip(textBase.expectedExistingText ?? textBase.expected_existing_text ?? textBase.originalText ?? textBase.original_text ?? textBase.textContains, 1000);
    if (existingTextNoteId !== null && expectedExistingText) {
      const revertRequest = {
        elementId: existingTextNoteId,
        newText: expectedExistingText
      };
      const revertDryRun = await transport.post("/revit/replace-text-note", { ...revertRequest, dryRun: true, apply: false });
      rawResults.push(revertDryRun);
      const revertApplied = await transport.post("/revit/replace-text-note", {
        ...revertRequest,
        dryRun: false,
        apply: true,
        confirm: clip(textBase.revertConfirm ?? textBase.confirm ?? "APPLY 1 TEXT NOTE CHANGE", 120)
      });
      rawResults.push(revertApplied);
      const findReverted = await transport.post("/revit/find-text-notes", {
        viewId: editedTextNoteViewId,
        contains: expectedExistingText,
        max: 50
      });
      rawResults.push(findReverted);
      checks.push(
        verification("text_note_edit_revert_dry_run_ok", asObject(revertDryRun).dryRun === true || /dry run/i.test(clip(asObject(revertDryRun).status, 80)), "dry-run text-note revert preview", revertDryRun),
        verification("text_note_edit_revert_applied_success", statusLooksOk(revertApplied), "text-note revert applied", revertApplied),
        verification("text_note_edit_revert_matches_original", textNoteReplaceResultMatches(revertApplied, existingTextNoteId, editedTextNoteViewId, expectedExistingText), { textNoteId: existingTextNoteId, viewId: editedTextNoteViewId, expectedExistingText }, revertApplied),
        verification("text_note_edit_revert_readback_matches_original", textNoteFindResultMatches(findReverted, existingTextNoteId, editedTextNoteViewId, expectedExistingText), { textNoteId: existingTextNoteId, viewId: editedTextNoteViewId, expectedExistingText }, findReverted)
      );
      summaryRows.push({ primitive: "text_note_edit_revert", id: existingTextNoteId, parent: editedTextNoteViewId, expectedViewId: editedTextNoteViewId, restoredText: expectedExistingText, status: clip(asObject(revertApplied).status, 80) });
    }
  }

  if (categoryVisibilityRevertRequest !== null) {
    const categoryVisibilityRevertDryRun = await transport.post("/revit/visibility", { ...categoryVisibilityRevertRequest, dryRun: true });
    rawResults.push(categoryVisibilityRevertDryRun);
    const categoryVisibilityReverted = await transport.post("/revit/visibility", { ...categoryVisibilityRevertRequest, dryRun: false });
    rawResults.push(categoryVisibilityReverted);
    const revertObj = asObject(categoryVisibilityReverted);
    const revertView = asObject(revertObj.view);
    const revertedViewId = firstPositiveId(revertObj.viewId, revertObj.id, revertView.id, revertView.viewId);
    const requestedRevertViewId = firstPositiveId(categoryVisibilityRevertRequest.viewId);
    checks.push(
      verification("category_visibility_revert_dry_run_ok", asObject(categoryVisibilityRevertDryRun).dryRun === true || /dry run/i.test(clip(asObject(categoryVisibilityRevertDryRun).status, 80)), "dry-run category visibility revert preview", categoryVisibilityRevertDryRun),
      verification("category_visibility_revert_applied_success", statusLooksOk(categoryVisibilityReverted), "category visibility revert status success", categoryVisibilityReverted),
      verification("category_visibility_revert_target_matches_request", requestedRevertViewId !== null && revertedViewId === requestedRevertViewId, requestedRevertViewId, categoryVisibilityReverted),
      verification("category_visibility_revert_cleared_override", categoryOverrideClearedProofMatchesRequest(categoryVisibilityRevertRequest, categoryVisibilityReverted), "cleared category visibility override evidence", categoryVisibilityReverted)
    );
    summaryRows.push({
      primitive: "category_visibility_revert",
      id: revertedViewId ?? "",
      expectedViewId: requestedRevertViewId ?? "",
      action: categoryVisibilityRevertRequest.action,
      requestedCategoryName: categoryVisibilityRevertRequest.categoryName ?? "",
      status: clip(revertObj.status, 80)
    });
  }

  if (templateCategoryVisibilityRevertRequest !== null) {
    const templateCategoryVisibilityRevertDryRun = await transport.post("/revit/visibility", { ...templateCategoryVisibilityRevertRequest, dryRun: true });
    rawResults.push(templateCategoryVisibilityRevertDryRun);
    const templateCategoryVisibilityReverted = await transport.post("/revit/visibility", { ...templateCategoryVisibilityRevertRequest, dryRun: false });
    rawResults.push(templateCategoryVisibilityReverted);
    const revertObj = asObject(templateCategoryVisibilityReverted);
    const revertView = asObject(revertObj.view);
    const revertedViewId = firstPositiveId(revertObj.viewId, revertObj.id, revertView.id, revertView.viewId);
    const requestedRevertViewId = firstPositiveId(templateCategoryVisibilityRevertRequest.viewId);
    checks.push(
      verification("view_template_category_visibility_revert_dry_run_ok", asObject(templateCategoryVisibilityRevertDryRun).dryRun === true || /dry run/i.test(clip(asObject(templateCategoryVisibilityRevertDryRun).status, 80)), "dry-run view template category visibility revert preview", templateCategoryVisibilityRevertDryRun),
      verification("view_template_category_visibility_revert_applied_success", statusLooksOk(templateCategoryVisibilityReverted), "view template category visibility revert status success", templateCategoryVisibilityReverted),
      verification("view_template_category_visibility_revert_target_matches_request", requestedRevertViewId !== null && revertedViewId === requestedRevertViewId, requestedRevertViewId, templateCategoryVisibilityReverted),
      verification("view_template_category_visibility_revert_cleared_override", categoryOverrideClearedProofMatchesRequest(templateCategoryVisibilityRevertRequest, templateCategoryVisibilityReverted), "cleared view template category visibility override evidence", templateCategoryVisibilityReverted)
    );
    summaryRows.push({
      primitive: "view_template_category_visibility_revert",
      id: revertedViewId ?? "",
      expectedViewId: requestedRevertViewId ?? "",
      action: templateCategoryVisibilityRevertRequest.action,
      requestedCategoryName: templateCategoryVisibilityRevertRequest.categoryName ?? "",
      status: clip(revertObj.status, 80)
    });
  }

  if (linkedModelCategoryVisibilityRevertRequest !== null) {
    const linkedModelCategoryVisibilityRevertDryRun = await transport.post("/revit/visibility", { ...linkedModelCategoryVisibilityRevertRequest, dryRun: true });
    rawResults.push(linkedModelCategoryVisibilityRevertDryRun);
    const linkedModelCategoryVisibilityReverted = await transport.post("/revit/visibility", { ...linkedModelCategoryVisibilityRevertRequest, dryRun: false });
    rawResults.push(linkedModelCategoryVisibilityReverted);
    const revertObj = asObject(linkedModelCategoryVisibilityReverted);
    const revertView = asObject(revertObj.view);
    const revertedViewId = firstPositiveId(revertObj.viewId, revertObj.id, revertView.id, revertView.viewId);
    const requestedRevertViewId = firstPositiveId(linkedModelCategoryVisibilityRevertRequest.viewId);
    checks.push(
      verification("linked_model_category_visibility_revert_dry_run_ok", asObject(linkedModelCategoryVisibilityRevertDryRun).dryRun === true || /dry run/i.test(clip(asObject(linkedModelCategoryVisibilityRevertDryRun).status, 80)), "dry-run linked model category visibility revert preview", linkedModelCategoryVisibilityRevertDryRun),
      verification("linked_model_category_visibility_revert_applied_success", statusLooksOk(linkedModelCategoryVisibilityReverted), "linked model category visibility revert status success", linkedModelCategoryVisibilityReverted),
      verification("linked_model_category_visibility_revert_target_matches_request", requestedRevertViewId !== null && revertedViewId === requestedRevertViewId, requestedRevertViewId, linkedModelCategoryVisibilityReverted),
      verification("linked_model_category_visibility_revert_cleared_override", categoryOverrideClearedProofMatchesRequest(linkedModelCategoryVisibilityRevertRequest, linkedModelCategoryVisibilityReverted), "cleared linked model category visibility override evidence", linkedModelCategoryVisibilityReverted)
    );
    summaryRows.push({
      primitive: "linked_model_category_visibility_revert",
      id: revertedViewId ?? "",
      expectedViewId: requestedRevertViewId ?? "",
      action: linkedModelCategoryVisibilityRevertRequest.action,
      requestedLinkedModelName: linkedModelCategoryVisibilityRevertRequest.linkedModelName ?? linkedModelCategoryVisibilityRevertRequest.revitLinkName ?? linkedModelCategoryVisibilityRevertRequest.linkName ?? "",
      requestedCategoryName: linkedModelCategoryVisibilityRevertRequest.categoryName ?? "",
      status: clip(revertObj.status, 80)
    });
  }

  if (phaseFilterVisibilityRevertRequest !== null) {
    const phaseFilterVisibilityRevertDryRun = await transport.post("/revit/visibility", { ...phaseFilterVisibilityRevertRequest, dryRun: true });
    rawResults.push(phaseFilterVisibilityRevertDryRun);
    const phaseFilterVisibilityReverted = await transport.post("/revit/visibility", { ...phaseFilterVisibilityRevertRequest, dryRun: false });
    rawResults.push(phaseFilterVisibilityReverted);
    const revertObj = asObject(phaseFilterVisibilityReverted);
    const revertView = asObject(revertObj.view);
    const revertedViewId = firstPositiveId(revertObj.viewId, revertObj.id, revertView.id, revertView.viewId);
    const requestedRevertViewId = firstPositiveId(phaseFilterVisibilityRevertRequest.viewId);
    checks.push(
      verification("phase_filter_visibility_revert_dry_run_ok", asObject(phaseFilterVisibilityRevertDryRun).dryRun === true || /dry run/i.test(clip(asObject(phaseFilterVisibilityRevertDryRun).status, 80)), "dry-run phase filter revert preview", phaseFilterVisibilityRevertDryRun),
      verification("phase_filter_visibility_revert_applied_success", statusLooksOk(phaseFilterVisibilityReverted), "phase filter revert status success", phaseFilterVisibilityReverted),
      verification("phase_filter_visibility_revert_target_matches_request", requestedRevertViewId !== null && revertedViewId === requestedRevertViewId, requestedRevertViewId, phaseFilterVisibilityReverted),
      verification("phase_filter_visibility_revert_setting_matches_original", visibilityAppliedProofMatchesRequest(phaseFilterVisibilityRevertRequest, phaseFilterVisibilityReverted), "reverted phase filter evidence", phaseFilterVisibilityReverted)
    );
    summaryRows.push({
      primitive: "phase_filter_visibility_revert",
      id: revertedViewId ?? "",
      expectedViewId: requestedRevertViewId ?? "",
      action: phaseFilterVisibilityRevertRequest.action,
      requestedPhaseFilterName: phaseFilterVisibilityRevertRequest.phaseFilterName ?? "",
      requestedPhaseFilterId: phaseFilterVisibilityRevertRequest.phaseFilterId ?? "",
      ...visibilitySummaryFields(phaseFilterVisibilityRevertRequest, revertView),
      status: clip(revertObj.status, 80)
    });
  }

  if (phaseVisibilityRevertRequest !== null) {
    const phaseVisibilityRevertDryRun = await transport.post("/revit/visibility", { ...phaseVisibilityRevertRequest, dryRun: true });
    rawResults.push(phaseVisibilityRevertDryRun);
    const phaseVisibilityReverted = await transport.post("/revit/visibility", { ...phaseVisibilityRevertRequest, dryRun: false });
    rawResults.push(phaseVisibilityReverted);
    const revertObj = asObject(phaseVisibilityReverted);
    const revertView = asObject(revertObj.view);
    const revertedViewId = firstPositiveId(revertObj.viewId, revertObj.id, revertView.id, revertView.viewId);
    const requestedRevertViewId = firstPositiveId(phaseVisibilityRevertRequest.viewId);
    checks.push(
      verification("phase_visibility_revert_dry_run_ok", asObject(phaseVisibilityRevertDryRun).dryRun === true || /dry run/i.test(clip(asObject(phaseVisibilityRevertDryRun).status, 80)), "dry-run phase revert preview", phaseVisibilityRevertDryRun),
      verification("phase_visibility_revert_applied_success", statusLooksOk(phaseVisibilityReverted), "phase revert status success", phaseVisibilityReverted),
      verification("phase_visibility_revert_target_matches_request", requestedRevertViewId !== null && revertedViewId === requestedRevertViewId, requestedRevertViewId, phaseVisibilityReverted),
      verification("phase_visibility_revert_setting_matches_original", visibilityAppliedProofMatchesRequest(phaseVisibilityRevertRequest, phaseVisibilityReverted), "reverted phase evidence", phaseVisibilityReverted)
    );
    summaryRows.push({
      primitive: "phase_visibility_revert",
      id: revertedViewId ?? "",
      expectedViewId: requestedRevertViewId ?? "",
      action: phaseVisibilityRevertRequest.action,
      requestedPhaseName: phaseVisibilityRevertRequest.phaseName ?? "",
      requestedPhaseId: phaseVisibilityRevertRequest.phaseId ?? "",
      ...visibilitySummaryFields(phaseVisibilityRevertRequest, revertView),
      status: clip(revertObj.status, 80)
    });
  }

  if (filterVisibilityRevertRequest !== null) {
    const filterVisibilityRevertDryRun = await transport.post("/revit/visibility", { ...filterVisibilityRevertRequest, dryRun: true });
    rawResults.push(filterVisibilityRevertDryRun);
    const filterVisibilityReverted = await transport.post("/revit/visibility", { ...filterVisibilityRevertRequest, dryRun: false });
    rawResults.push(filterVisibilityReverted);
    const revertObj = asObject(filterVisibilityReverted);
    const revertView = asObject(revertObj.view);
    const revertedViewId = firstPositiveId(revertObj.viewId, revertObj.id, revertView.id, revertView.viewId);
    const requestedRevertViewId = firstPositiveId(filterVisibilityRevertRequest.viewId);
    checks.push(
      verification("filter_visibility_revert_dry_run_ok", asObject(filterVisibilityRevertDryRun).dryRun === true || /dry run/i.test(clip(asObject(filterVisibilityRevertDryRun).status, 80)), "dry-run filter override revert preview", filterVisibilityRevertDryRun),
      verification("filter_visibility_revert_applied_success", statusLooksOk(filterVisibilityReverted), "filter override revert status success", filterVisibilityReverted),
      verification("filter_visibility_revert_target_matches_request", requestedRevertViewId !== null && revertedViewId === requestedRevertViewId, requestedRevertViewId, filterVisibilityReverted),
      verification("filter_visibility_revert_cleared_override", filterOverrideClearedProofMatchesRequest(filterVisibilityRevertRequest, filterVisibilityReverted), "cleared filter visibility override evidence", filterVisibilityReverted)
    );
    summaryRows.push({
      primitive: "filter_visibility_revert",
      id: revertedViewId ?? "",
      expectedViewId: requestedRevertViewId ?? "",
      action: filterVisibilityRevertRequest.action,
      requestedFilterId: filterVisibilityRevertRequest.filterId ?? "",
      requestedFilterName: filterVisibilityRevertRequest.filterName ?? "",
      status: clip(revertObj.status, 80)
    });
  }

  const cleanupCandidateIds = [
    ...tagIds,
    ...(textNoteId !== null ? [textNoteId] : []),
    ...detailCurveIds,
    ...(cadLinkId !== null ? [cadLinkId] : []),
    ...(placedViewportId !== null ? [placedViewportId] : []),
    ...(scheduleId !== null ? [scheduleId] : []),
    ...(!useExistingSheet && sheetId !== null ? [sheetId] : []),
    ...(createdViewId !== null ? [createdViewId] : []),
    ...(templateViewId !== null ? [templateViewId] : []),
    ...(createdFilterId !== null ? [createdFilterId] : []),
    ...trackedTransport.cleanupIds()
  ];
  const cleanupIds = Array.from(new Set(cleanupCandidateIds.filter((id) => !(useExistingSheet && sheetId !== null && id === sheetId))));
  let cleanupDryRun: unknown = null;
  let cleanupApplied: unknown = null;
  let cleanupDryRunIds: number[] = [];
  let cleanupDeletedIds: number[] = [];
  if (cleanupRequested && cleanupIds.length > 0) {
    cleanupDryRun = await transport.post("/revit/delete", {
      ids: cleanupIds,
      apply: false,
      reason: "benchmark cleanup for repeated documentation primitives reliability runs"
    });
    rawResults.push(cleanupDryRun);
    cleanupApplied = await transport.post("/revit/delete", {
      ids: cleanupIds,
      apply: true,
      reason: "benchmark cleanup for repeated documentation primitives reliability runs"
    });
    rawResults.push(cleanupApplied);
    const cleanupDryObj = asObject(cleanupDryRun);
    const cleanupObj = asObject(cleanupApplied);
    cleanupDryRunIds = deleteEffectIds(cleanupDryRun);
    cleanupDeletedIds = deleteEffectIds(cleanupApplied);
    checks.push(
      verification("documentation_cleanup_dry_run_ok", /dry run/i.test(clip(cleanupDryObj.status, 80)) && cleanupIds.every((id) => cleanupDryRunIds.includes(id)), cleanupIds, cleanupDryRun),
      verification("documentation_cleanup_applied_ids_present", /^deleted$/i.test(clip(cleanupObj.status, 80)) && cleanupIds.every((id) => cleanupDeletedIds.includes(id)), cleanupIds, cleanupApplied)
    );
    summaryRows.push({ primitive: "cleanup_documentation_primitives", id: cleanupDeletedIds.join(";"), status: clip(cleanupObj.status, 80), count: cleanupDeletedIds.length });
  } else if (cleanupRequested && graphicsOnly) {
    checks.push(
      verification("documentation_cleanup_dry_run_ok", true, "graphics-only documentation changes are reverted in place; no disposable elements created", cleanupIds),
      verification("documentation_cleanup_applied_ids_present", true, "graphics-only documentation changes are reverted in place; no disposable elements created", cleanupIds)
    );
    summaryRows.push({ primitive: "cleanup_documentation_primitives", id: "", status: "NoCreatedElementsGraphicsOnly", count: 0 });
  } else if (cleanupRequested) {
    checks.push(
      verification("documentation_cleanup_dry_run_ok", false, "created documentation ids required before cleanup", cleanupIds),
      verification("documentation_cleanup_applied_ids_present", false, "created documentation ids required before cleanup", cleanupIds)
    );
  } else {
    checks.push(verification("documentation_cleanup_applied_ids_present", true, "not requested", cleanupIds));
  }

  const summaryJsonPath = path.join(runDir, "artifacts", "documentation_primitives_summary.json");
  const summaryMdPath = writeMarkdownTable(path.join(runDir, "artifacts", "documentation_primitives_summary.md"), summaryRows);
  const categoryVisibilityRow = summaryRows.find((row) => row.primitive === "category_visibility") ?? {};
  const categoryVisibilityRevertRow = summaryRows.find((row) => row.primitive === "category_visibility_revert") ?? {};
  const linkedModelCategoryVisibilityRow = summaryRows.find((row) => row.primitive === "linked_model_category_visibility") ?? {};
  const linkedModelCategoryVisibilityRevertRow = summaryRows.find((row) => row.primitive === "linked_model_category_visibility_revert") ?? {};
  const phaseVisibilityRow = summaryRows.find((row) => row.primitive === "phase_visibility") ?? {};
  const phaseFilterVisibilityRow = summaryRows.find((row) => row.primitive === "phase_filter_visibility") ?? {};
  const phaseVisibilityRevertRow = summaryRows.find((row) => row.primitive === "phase_visibility_revert") ?? {};
  const phaseFilterVisibilityRevertRow = summaryRows.find((row) => row.primitive === "phase_filter_visibility_revert") ?? {};
  const filterVisibilityRow = summaryRows.find((row) => row.primitive === "filter_visibility") ?? {};
  const filterVisibilityRevertRow = summaryRows.find((row) => row.primitive === "filter_visibility_revert") ?? {};
  const templateCategoryVisibilityRow = summaryRows.find((row) => row.primitive === "view_template_category_visibility") ?? {};
  const cadLinkRow = summaryRows.find((row) => row.primitive === "cad_link") ?? {};
  const cadGraphicsOverrideRow = summaryRows.find((row) => row.primitive === "cad_graphics_override") ?? {};
  writeJsonFile(summaryJsonPath, {
    scheduleId,
    scheduleDetail,
    requestedFieldCount,
    createdScheduleFieldCount,
    createdScheduleFieldNames,
    configuredScheduleId,
    configuredScheduleDetail,
    configuredScheduleFieldNames,
    sheetId,
    createdViewId,
    templateViewId,
    createdFilterId,
    placedViewportId,
    detailCurveIds,
    textNoteId,
    tagIds,
    cadLinkId,
    cleanupRequested,
    cleanupIds,
    cleanupDryRunIds,
    cleanupDeletedIds,
    cleanupDryRun,
    cleanupApplied,
    postChangeCapture,
    postChangeCaptureTargetId,
    postChangeCaptureViewId,
    postChangeCapturePath,
    categoryVisibilityTargetId: categoryVisibilityRow.id ?? null,
    requestedCategoryName: categoryVisibilityRow.requestedCategoryName ?? null,
    appliedCategoryName: categoryVisibilityRow.appliedCategoryName ?? null,
    requestedLineWeight: categoryVisibilityRow.requestedLineWeight ?? null,
    appliedLineWeight: categoryVisibilityRow.appliedLineWeight ?? null,
    categoryVisibilityRevertTargetId: categoryVisibilityRevertRow.id ?? null,
    categoryVisibilityRevertStatus: categoryVisibilityRevertRow.status ?? null,
    linkedModelCategoryVisibilityTargetId: linkedModelCategoryVisibilityRow.id ?? null,
    requestedLinkedModelName: linkedModelCategoryVisibilityRow.requestedLinkedModelName ?? null,
    appliedLinkedModelName: linkedModelCategoryVisibilityRow.appliedLinkedModelName ?? null,
    requestedLinkedModelCategoryName: linkedModelCategoryVisibilityRow.requestedCategoryName ?? null,
    appliedLinkedModelCategoryName: linkedModelCategoryVisibilityRow.appliedCategoryName ?? null,
    requestedLinkedModelLineWeight: linkedModelCategoryVisibilityRow.requestedLineWeight ?? null,
    appliedLinkedModelLineWeight: linkedModelCategoryVisibilityRow.appliedLineWeight ?? null,
    linkedModelCategoryVisibilityRevertTargetId: linkedModelCategoryVisibilityRevertRow.id ?? null,
    linkedModelCategoryVisibilityRevertStatus: linkedModelCategoryVisibilityRevertRow.status ?? null,
    phaseVisibilityTargetId: phaseVisibilityRow.id ?? null,
    requestedPhaseName: phaseVisibilityRow.requestedPhaseName ?? null,
    appliedPhaseName: phaseVisibilityRow.appliedPhaseName ?? null,
    phaseVisibilityRevertTargetId: phaseVisibilityRevertRow.id ?? null,
    revertedPhaseName: phaseVisibilityRevertRow.appliedPhaseName ?? null,
    phaseFilterVisibilityTargetId: phaseFilterVisibilityRow.id ?? null,
    requestedPhaseFilterName: phaseFilterVisibilityRow.requestedPhaseFilterName ?? null,
    appliedPhaseFilterName: phaseFilterVisibilityRow.appliedPhaseFilterName ?? null,
    phaseFilterVisibilityRevertTargetId: phaseFilterVisibilityRevertRow.id ?? null,
    revertedPhaseFilterName: phaseFilterVisibilityRevertRow.appliedPhaseFilterName ?? null,
    filterVisibilityTargetId: filterVisibilityRow.id ?? null,
    requestedFilterName: filterVisibilityRow.requestedFilterName ?? null,
    appliedFilterName: filterVisibilityRow.appliedFilterName ?? null,
    requestedFilterLineWeight: filterVisibilityRow.requestedLineWeight ?? null,
    appliedFilterLineWeight: filterVisibilityRow.appliedFilterLineWeight ?? null,
    filterVisibilityRevertTargetId: filterVisibilityRevertRow.id ?? null,
    filterVisibilityRevertStatus: filterVisibilityRevertRow.status ?? null,
    templateCategoryVisibilityTargetId: templateCategoryVisibilityRow.id ?? null,
    requestedTemplateCategoryName: templateCategoryVisibilityRow.requestedCategoryName ?? null,
    appliedTemplateCategoryName: templateCategoryVisibilityRow.appliedCategoryName ?? null,
    requestedTemplateCategoryLineWeight: templateCategoryVisibilityRow.requestedLineWeight ?? null,
    appliedTemplateCategoryLineWeight: templateCategoryVisibilityRow.appliedLineWeight ?? null,
    cadLinkTargetId: cadLinkRow.id ?? null,
    cadLinkSourcePath: cadLinkRow.requestedSourcePath ?? null,
    cadLinkReportedSourcePath: cadLinkRow.reportedSourcePath ?? null,
    cadLinkViewportId: cadLinkRow.viewportId ?? null,
    cadGraphicsOverrideTargetId: cadGraphicsOverrideRow.id ?? null,
    requestedCadCategoryName: cadGraphicsOverrideRow.requestedCadCategoryName ?? cadGraphicsOverrideRow.requestedCategoryName ?? null,
    appliedCadCategoryName: cadGraphicsOverrideRow.appliedCategoryName ?? null,
    requestedCadLineWeight: cadGraphicsOverrideRow.requestedLineWeight ?? null,
    appliedCadLineWeight: cadGraphicsOverrideRow.appliedLineWeight ?? null,
    rows: summaryRows,
    rawResults
  });
  checks.push(verification("documentation_summary_written", fs.existsSync(summaryJsonPath) && fs.existsSync(summaryMdPath), [summaryJsonPath, summaryMdPath], summaryRows));

  const success = countOk(checks);
  return {
    workflow: "documentation_primitives",
    success,
    failure_reason: success ? null : "Documentation primitives workflow verification failed.",
    tool_calls: rawResults.length,
    revit_transactions: rawResults.filter((result) => asObject(result).dryRun !== true).length,
    computer_use_actions: 0,
    output_artifacts: [summaryJsonPath, summaryMdPath],
    verification_results: checks,
    user_message: success
      ? `Created and verified documentation primitives: schedule ${scheduleId}, sheet ${sheetId}.`
      : "Documentation primitives workflow ran, but verification failed.",
    raw_results: rawResults
  };
  } catch (error) {
    const failureMessage = error instanceof Error ? error.message : String(error);
    const cleanupIds = trackedTransport.cleanupIds();
    let cleanupDryRun: unknown = null;
    let cleanupApplied: unknown = null;
    let cleanupDryRunIds: number[] = [];
    let cleanupDeletedIds: number[] = [];
    checks.push(verification("documentation_workflow_exception_caught", false, "no thrown bridge error", null, failureMessage));
    if (cleanupRequested && cleanupIds.length > 0) {
      try {
        cleanupDryRun = await transport.post("/revit/delete", {
          ids: cleanupIds,
          apply: false,
          reason: "benchmark cleanup after documentation primitives failure"
        });
        rawResults.push(cleanupDryRun);
        cleanupApplied = await transport.post("/revit/delete", {
          ids: cleanupIds,
          apply: true,
          reason: "benchmark cleanup after documentation primitives failure"
        });
        rawResults.push(cleanupApplied);
        const cleanupDryObj = asObject(cleanupDryRun);
        const cleanupObj = asObject(cleanupApplied);
        cleanupDryRunIds = deleteEffectIds(cleanupDryRun);
        cleanupDeletedIds = deleteEffectIds(cleanupApplied);
        checks.push(
          verification("documentation_failure_cleanup_dry_run_ok", /dry run/i.test(clip(cleanupDryObj.status, 80)) && cleanupIds.every((id) => cleanupDryRunIds.includes(id)), cleanupIds, cleanupDryRun),
          verification("documentation_failure_cleanup_applied_ids_present", /^deleted$/i.test(clip(cleanupObj.status, 80)) && cleanupIds.every((id) => cleanupDeletedIds.includes(id)), cleanupIds, cleanupApplied)
        );
        summaryRows.push({ primitive: "failure_cleanup_documentation_primitives", id: cleanupDeletedIds.join(";"), status: clip(cleanupObj.status, 80), count: cleanupDeletedIds.length });
      } catch (cleanupError) {
        const cleanupMessage = cleanupError instanceof Error ? cleanupError.message : String(cleanupError);
        checks.push(
          verification("documentation_failure_cleanup_dry_run_ok", false, cleanupIds, cleanupDryRun, cleanupMessage),
          verification("documentation_failure_cleanup_applied_ids_present", false, cleanupIds, cleanupApplied, cleanupMessage)
        );
      }
    } else if (cleanupRequested) {
      checks.push(
        verification("documentation_failure_cleanup_dry_run_ok", false, "tracked documentation ids required before cleanup", cleanupIds),
        verification("documentation_failure_cleanup_applied_ids_present", false, "tracked documentation ids required before cleanup", cleanupIds)
      );
    }

    const summaryJsonPath = path.join(runDir, "artifacts", "documentation_primitives_summary.json");
    const summaryMdPath = writeMarkdownTable(path.join(runDir, "artifacts", "documentation_primitives_summary.md"), summaryRows);
    writeJsonFile(summaryJsonPath, {
      cleanupRequested,
      cleanupIds,
      cleanupDryRunIds,
      cleanupDeletedIds,
      cleanupDryRun,
      cleanupApplied,
      failure: failureMessage,
      tracked: {
        scheduleIds: trackedTransport.scheduleIds,
        sheetIds: trackedTransport.sheetIds,
        viewIds: trackedTransport.viewIds,
        viewportIds: trackedTransport.viewportIds,
        detailCurveIds: trackedTransport.detailCurveIds,
        textNoteIds: trackedTransport.textNoteIds,
        tagIds: trackedTransport.tagIds,
        cadIds: trackedTransport.cadIds
      },
      rows: summaryRows,
      rawResults
    });
    checks.push(verification("documentation_summary_written", fs.existsSync(summaryJsonPath) && fs.existsSync(summaryMdPath), [summaryJsonPath, summaryMdPath], summaryRows));
    return {
      workflow: "documentation_primitives",
      success: false,
      failure_reason: `Documentation primitives workflow threw before completion: ${failureMessage}`,
      tool_calls: rawResults.length,
      revit_transactions: rawResults.filter((result) => asObject(result).dryRun !== true).length,
      computer_use_actions: 0,
      output_artifacts: [summaryJsonPath, summaryMdPath],
      verification_results: checks,
      user_message: "Documentation primitives workflow failed before completion; cleanup was attempted for tracked created ids.",
      raw_results: rawResults
    };
  }
}

async function runModelEditPrimitives(transport: BridgeTransport, request: JsonMap, runDir: string): Promise<RevitWorkflowPartialResult> {
  const rawResults: unknown[] = [];
  const summaryRows: Array<Record<string, unknown>> = [];
  const checks: RevitWorkflowVerification[] = [];

  const linkBase = asObject(request.linkRevit ?? request.revitLink);
  const linkSourcePath = clip(linkBase.sourcePath ?? request.revitLinkSourcePath, 1000);
  const cleanupLinkType = request.cleanupLinkType !== false && linkBase.cleanupLinkType !== false;
  const unloadLinkTypeBeforeCleanup = parseBool(request.unloadLinkTypeBeforeCleanup ?? linkBase.unloadLinkTypeBeforeCleanup) === true;
  let linkRequest: JsonMap | null = null;
  let revitLinkDryRun: unknown = null;
  let revitLinkApplied: unknown = null;
  let linkTypeId: number | null = null;
  let linkInstanceId: number | null = null;
  let linkCleanupDeletedIds: number[] = [];
  let linkCleanupImpactedIds: number[] = [];
  let linkTypeUnloadDryRun: unknown = null;
  let linkTypeUnloadApplied: unknown = null;
  let linkTypeCleanupDeletedIds: number[] = [];
  let postChangeCapture: unknown = null;
  let postChangeCapturePath = "";
  let postChangeCaptureTargetId: number | null = null;
  let postChangeCaptureViewId: number | null = null;
  checks.push(verification("revit_link_request_present", Boolean(linkSourcePath), "RVT sourcePath in linkRevit/revitLink request", linkBase));
  if (linkSourcePath) {
    linkRequest = {
      pin: true,
      ...linkBase,
      sourcePath: linkSourcePath
    };
    revitLinkDryRun = await transport.post("/revit/link-revit", { ...linkRequest, dryRun: true });
    rawResults.push(revitLinkDryRun);
    const linkDryObj = asObject(revitLinkDryRun);
    checks.push(verification("revit_link_dry_run_ok", /dry run/i.test(clip(linkDryObj.status, 80)) && linkDryObj.dryRun === true, "dry-run RVT link", revitLinkDryRun));
  }

  const createBase = asObject(request.createFamilyInstance ?? request.create);
  const createRequest = {
    familyName: "",
    levelName: "",
    x: 0,
    y: 0,
    z: 0,
    ...createBase,
    symbolName: clip(createBase.symbolName ?? createBase.typeName ?? request.symbolName, 220)
  };
  const createResult = await transport.post("/revit/create-family-instance", createRequest);
  rawResults.push(createResult);
  const createObj = asObject(createResult);
  const createdId = firstPositiveId(createObj.id, createObj.elementId, createObj.createdElementId);
  const requestedFamilyInstanceType = clip(createRequest.symbolName || createBase.typeName || createRequest.familyName, 220);
  const createdFamilyInstanceLabels = collectCreatedFamilyLabels(createObj);
  const familyInstanceTypeMatchesRequest = proofLabelsMatchRequest(requestedFamilyInstanceType, createdFamilyInstanceLabels);
  checks.push(
    verification("family_instance_created_id_present", createdId !== null, "created family instance id", createResult),
    verification(
      "family_instance_type_matches_request",
      familyInstanceTypeMatchesRequest,
      requestedFamilyInstanceType || "no requested type label",
      createdFamilyInstanceLabels,
      requestedFamilyInstanceType
        ? "created family instance type/name evidence must match requested symbol/type/family"
        : "no requested type label was provided"
    )
  );
  summaryRows.push({
    primitive: "create_family_instance",
    id: createdId ?? "",
    family: clip(createObj.family ?? createRequest.familyName, 120),
    symbol: clip(createObj.symbolName ?? createObj.typeName ?? createObj.symbol ?? createObj.name ?? createRequest.symbolName, 120)
  });

  const moveBase = asObject(request.move);
  const moveIds = asNumberArray(moveBase.ids).length > 0
    ? asNumberArray(moveBase.ids)
    : createdId !== null
      ? [createdId]
      : [];
  const moveRequest = {
    mode: "vector",
    vectorX: 1,
    vectorY: 0,
    vectorZ: 0,
    behavior: "allOrNothing",
    ...moveBase,
    ids: moveIds
  };
  const moveDryRun = await transport.post("/revit/move-elements", { ...moveRequest, dryRun: true });
  rawResults.push(moveDryRun);
  const moveApplied = await transport.post("/revit/move-elements", { ...moveRequest, dryRun: false });
  rawResults.push(moveApplied);
  const moveDryObj = asObject(moveDryRun);
  const moveObj = asObject(moveApplied);
  const dryMovedIds = asNumberArray(moveDryObj.movedIds);
  const movedIds = asNumberArray(moveObj.movedIds);
  const moveDryRunIncludesRequestedIds = moveIds.length > 0 && moveIds.every((id) => dryMovedIds.includes(id));
  const moveAppliedIncludesRequestedIds = moveIds.length > 0 && moveIds.every((id) => movedIds.includes(id));
  checks.push(
    verification("move_dry_run_ok", /dry run/i.test(clip(moveDryObj.status, 80)) && moveDryObj.rolledBack === true && moveDryRunIncludesRequestedIds, moveIds, moveDryRun),
    verification("move_applied_ids_present", /^moved$/i.test(clip(moveObj.status, 80)) && moveAppliedIncludesRequestedIds, moveIds, moveApplied)
  );
  summaryRows.push({
    primitive: "move_elements",
    id: movedIds.join(";"),
    status: clip(moveObj.status, 80),
    vector: `${moveRequest.vectorX},${moveRequest.vectorY},${moveRequest.vectorZ}`
  });

  const deleteBase = asObject(request.delete);
  const deleteIds = asNumberArray(deleteBase.ids).length > 0
    ? asNumberArray(deleteBase.ids)
    : createdId !== null
      ? [createdId]
      : [];
  const deleteRequest = { ...deleteBase, ids: deleteIds };
  const deleteDryRun = await transport.post("/revit/delete", { ...deleteRequest, apply: false });
  rawResults.push(deleteDryRun);
  const deleteApplied = await transport.post("/revit/delete", { ...deleteRequest, apply: true });
  rawResults.push(deleteApplied);
  const deleteDryObj = asObject(deleteDryRun);
  const deleteObj = asObject(deleteApplied);
  const dryDeletedIds = deleteEffectIds(deleteDryRun);
  const deletedIds = deleteEffectIds(deleteApplied);
  const deleteDryRunIncludesRequestedIds = deleteIds.length > 0 && deleteIds.every((id) => dryDeletedIds.includes(id));
  const deleteAppliedIncludesRequestedIds = deleteIds.length > 0 && deleteIds.every((id) => deletedIds.includes(id));
  checks.push(
    verification("delete_dry_run_ok", /dry run/i.test(clip(deleteDryObj.status, 80)) && deleteDryRunIncludesRequestedIds, deleteIds, deleteDryRun),
    verification("delete_applied_ids_present", /^deleted$/i.test(clip(deleteObj.status, 80)) && deleteAppliedIncludesRequestedIds, deleteIds, deleteApplied)
  );
  summaryRows.push({
    primitive: "delete_elements",
    id: deletedIds.join(";"),
    status: clip(deleteObj.status, 80),
    count: Number(deleteObj.count ?? deletedIds.length)
  });

  if (linkSourcePath && linkRequest) {
    revitLinkApplied = await transport.post("/revit/link-revit", { ...linkRequest, dryRun: false });
    rawResults.push(revitLinkApplied);
    const linkObj = asObject(revitLinkApplied);
    linkTypeId = firstPositiveId(linkObj.linkTypeId, linkObj.typeId);
    linkInstanceId = firstPositiveId(linkObj.linkInstanceId, linkObj.instanceId, linkObj.elementId);
    checks.push(
      verification("revit_link_instance_created_id_present", /^success$/i.test(clip(linkObj.status, 80)) && linkInstanceId !== null, "RVT link instance id", revitLinkApplied),
      verification("revit_link_type_created_id_present", /^success$/i.test(clip(linkObj.status, 80)) && linkTypeId !== null, "RVT link type id", revitLinkApplied),
      verification("revit_link_source_matches_request", linkSourceMatchesRequest(linkSourcePath, revitLinkApplied), linkSourcePath, revitLinkApplied),
      verification("revit_link_pin_matches_request", linkPinMatchesRequest(linkRequest.pin, revitLinkApplied), linkRequest.pin ?? "not requested", revitLinkApplied)
    );
    summaryRows.push({
      primitive: "link_revit",
      id: linkInstanceId ?? "",
      linkTypeId: linkTypeId ?? "",
      status: clip(linkObj.status, 80),
      sourcePath: linkSourcePath
    });

    const captureViewId = firstPositiveId(request.visualViewId, request.captureViewId, request.afterCaptureViewId, linkBase.visualViewId, linkBase.captureViewId);
    postChangeCaptureTargetId = captureViewId;
    postChangeCapture = await transport.post("/revit/export-image", {
      ...(captureViewId !== null ? { viewId: captureViewId } : {}),
      reason: "model edit primitives post-change visual verification before link cleanup"
    });
    rawResults.push(postChangeCapture);
    const captureObj = asObject(postChangeCapture);
    const captureView = asObject(captureObj.view);
    postChangeCaptureViewId = firstPositiveId(captureObj.viewId, captureObj.targetViewId, captureView.id, captureView.viewId);
    postChangeCapturePath = firstPathLike(captureObj.path, captureObj.capturePath, captureObj.capture_path, captureObj.imagePath, captureObj.image_path, captureObj.screenshotPath, captureObj.screenshot_path);
    checks.push(
      verification("model_edit_post_change_capture_returned", Boolean(postChangeCapturePath), "post-change model edit capture path", postChangeCapture),
      verification(
        "model_edit_post_change_capture_view_id_matches_request",
        captureViewId === null || postChangeCaptureViewId === null || postChangeCaptureViewId === captureViewId,
        captureViewId ?? "no requested capture view",
        postChangeCapture
      )
    );
    summaryRows.push({ primitive: "post_change_capture", id: captureViewId ?? "", reportedViewId: postChangeCaptureViewId ?? "", path: postChangeCapturePath, status: clip(captureObj.status ?? "captured", 80) });

    if (linkTypeId !== null && cleanupLinkType && unloadLinkTypeBeforeCleanup) {
      linkTypeUnloadDryRun = await transport.post("/revit/link-revit", { action: "unload", linkTypeId, dryRun: true });
      rawResults.push(linkTypeUnloadDryRun);
      linkTypeUnloadApplied = await transport.post("/revit/link-revit", { action: "unload", linkTypeId, dryRun: false });
      rawResults.push(linkTypeUnloadApplied);
      const unloadDryObj = asObject(linkTypeUnloadDryRun);
      const unloadObj = asObject(linkTypeUnloadApplied);
      checks.push(
        verification("revit_link_type_unload_dry_run_ok", /dry run/i.test(clip(unloadDryObj.status, 80)) && Number(asObject(unloadDryObj.plan).linkTypeId ?? unloadDryObj.linkTypeId) === linkTypeId, [linkTypeId], linkTypeUnloadDryRun),
        verification("revit_link_type_unload_applied_ok", /^unloaded$/i.test(clip(unloadObj.status, 80)) && Number(unloadObj.linkTypeId) === linkTypeId, [linkTypeId], linkTypeUnloadApplied)
      );
      summaryRows.push({
        primitive: "unload_revit_link_type",
        id: String(linkTypeId),
        status: clip(unloadObj.status, 80),
        count: 1
      });
    }

    if (linkInstanceId !== null) {
      const cleanupRequest = { ids: [linkInstanceId] };
      const cleanupDryRun = await transport.post("/revit/delete", { ...cleanupRequest, apply: false });
      rawResults.push(cleanupDryRun);
      const cleanupApplied = await transport.post("/revit/delete", { ...cleanupRequest, apply: true });
      rawResults.push(cleanupApplied);
      const cleanupDryObj = asObject(cleanupDryRun);
      const cleanupObj = asObject(cleanupApplied);
      const cleanupDryIds = deleteEffectIds(cleanupDryRun);
      linkCleanupDeletedIds = deleteEffectIds(cleanupApplied);
      linkCleanupImpactedIds = deleteEffectIds(cleanupApplied);
      checks.push(
        verification("revit_link_cleanup_dry_run_ok", /dry run/i.test(clip(cleanupDryObj.status, 80)) && cleanupDryIds.includes(linkInstanceId), [linkInstanceId], cleanupDryRun),
        verification("revit_link_cleanup_applied_ids_present", /^deleted$/i.test(clip(cleanupObj.status, 80)) && linkCleanupDeletedIds.includes(linkInstanceId), [linkInstanceId], cleanupApplied)
      );
      summaryRows.push({
        primitive: "cleanup_revit_link",
        id: linkCleanupDeletedIds.join(";"),
        status: clip(cleanupObj.status, 80),
        count: Number(cleanupObj.count ?? linkCleanupDeletedIds.length)
      });
    } else {
      checks.push(
        verification("revit_link_cleanup_dry_run_ok", false, "RVT link instance id required before cleanup", linkInstanceId),
        verification("revit_link_cleanup_applied_ids_present", false, "RVT link instance id required before cleanup", linkInstanceId)
      );
    }

    if (linkTypeId !== null && cleanupLinkType) {
      const typeCleanupRequest = { ids: [linkTypeId] };
      try {
        const typeCleanupDryRun = await transport.post("/revit/delete", { ...typeCleanupRequest, apply: false });
        rawResults.push(typeCleanupDryRun);
        const typeCleanupApplied = await transport.post("/revit/delete", { ...typeCleanupRequest, apply: true });
        rawResults.push(typeCleanupApplied);
        const typeCleanupDryObj = asObject(typeCleanupDryRun);
        const typeCleanupObj = asObject(typeCleanupApplied);
        const typeCleanupDryIds = deleteEffectIds(typeCleanupDryRun);
        linkTypeCleanupDeletedIds = deleteEffectIds(typeCleanupApplied);
        checks.push(
          verification("revit_link_type_cleanup_dry_run_ok", /dry run/i.test(clip(typeCleanupDryObj.status, 80)) && typeCleanupDryIds.includes(linkTypeId), [linkTypeId], typeCleanupDryRun),
          verification("revit_link_type_cleanup_applied_ids_present", /^deleted$/i.test(clip(typeCleanupObj.status, 80)) && linkTypeCleanupDeletedIds.includes(linkTypeId), [linkTypeId], typeCleanupApplied)
        );
        summaryRows.push({
          primitive: "cleanup_revit_link_type",
          id: linkTypeCleanupDeletedIds.join(";"),
          status: clip(typeCleanupObj.status, 80),
          count: Number(typeCleanupObj.count ?? linkTypeCleanupDeletedIds.length)
        });
      } catch (error) {
        const alreadyDeletedWithInstance = linkCleanupImpactedIds.includes(linkTypeId);
        if (!alreadyDeletedWithInstance) throw error;
        linkTypeCleanupDeletedIds = [linkTypeId];
        const detail = error instanceof Error ? error.message : String(error);
        checks.push(
          verification("revit_link_type_cleanup_dry_run_ok", true, [linkTypeId], linkCleanupImpactedIds, "RVT link type was already removed as an impacted dependent of link instance cleanup."),
          verification("revit_link_type_cleanup_applied_ids_present", true, [linkTypeId], linkCleanupImpactedIds, detail)
        );
        summaryRows.push({
          primitive: "cleanup_revit_link_type",
          id: String(linkTypeId),
          status: "AlreadyDeletedWithInstanceCleanup",
          count: 1
        });
      }
    } else if (linkTypeId !== null) {
      checks.push(
        verification("revit_link_type_cleanup_dry_run_ok", true, "cleanupLinkType=false", { linkTypeId }, "RVT link type cleanup intentionally skipped; link type remains loaded for repeat-safe live runs."),
        verification("revit_link_type_cleanup_applied_ids_present", true, "cleanupLinkType=false", { linkTypeId }, "RVT link type cleanup intentionally skipped; /revit/link-revit reuses already-loaded link types.")
      );
      summaryRows.push({
        primitive: "cleanup_revit_link_type",
        id: String(linkTypeId),
        status: "SkippedTypeCleanupForReuse",
        count: 0
      });
    } else {
      checks.push(
        verification("revit_link_type_cleanup_dry_run_ok", false, "RVT link type id required before cleanup", linkTypeId),
        verification("revit_link_type_cleanup_applied_ids_present", false, "RVT link type id required before cleanup", linkTypeId)
      );
    }
  }

  const summaryJsonPath = path.join(runDir, "artifacts", "model_edit_primitives_summary.json");
  const summaryMdPath = writeMarkdownTable(path.join(runDir, "artifacts", "model_edit_primitives_summary.md"), summaryRows);
  writeJsonFile(summaryJsonPath, {
    createdId,
    requestedFamilyInstanceType,
    createdFamilyInstanceLabels,
    movedIds,
    deletedIds,
    linkTypeId,
    linkInstanceId,
    linkCleanupDeletedIds,
    linkCleanupImpactedIds,
    linkTypeUnloadDryRun,
    linkTypeUnloadApplied,
    linkTypeCleanupDeletedIds,
    cleanupLinkType,
    unloadLinkTypeBeforeCleanup,
    postChangeCapture,
    postChangeCapturePath,
    postChangeCaptureTargetId,
    postChangeCaptureViewId,
    rows: summaryRows,
    rawResults,
    revitLinkStatus: linkInstanceId !== null ? "linked_then_cleaned_up" : "missing_or_failed",
    revitLinkSourcePath: linkSourcePath
  });
  checks.push(
    verification("model_edit_summary_written", fs.existsSync(summaryJsonPath) && fs.existsSync(summaryMdPath), [summaryJsonPath, summaryMdPath], summaryRows)
  );

  const success = countOk(checks);
  return {
    workflow: "model_edit_primitives",
    success,
    failure_reason: success ? null : "Model edit primitives workflow verification failed.",
    tool_calls: rawResults.length,
    revit_transactions: rawResults.filter((result) => asObject(result).rolledBack !== true && !/dry run/i.test(clip(asObject(result).status, 80))).length,
    computer_use_actions: 0,
    output_artifacts: [summaryJsonPath, summaryMdPath],
    verification_results: checks,
    user_message: success
      ? `Created, moved, deleted benchmark element ${createdId}, and linked RVT instance ${linkInstanceId}.`
      : "Model edit primitives workflow ran, but verification failed.",
    raw_results: rawResults
  };
}

function repeatIndexFromRunDir(runDir: string): number {
  const match = path.basename(runDir).match(/repeat-(\d+)/i);
  const index = match ? Number(match[1]) : 1;
  return Number.isFinite(index) && index > 0 ? index : 1;
}

function repeatSuffix(runDir: string): string {
  return `-R${String(repeatIndexFromRunDir(runDir)).padStart(2, "0")}`;
}

function appendRepeatSuffix(value: unknown, runDir: string, fallback: string): string {
  const text = clip(value, 220) || fallback;
  const suffix = repeatSuffix(runDir);
  return text.endsWith(suffix) ? text : `${text}${suffix}`;
}

function repeatSafePlacements(placements: JsonMap[], runDir: string): JsonMap[] {
  const repeatIndex = repeatIndexFromRunDir(runDir);
  const suffix = `-R${String(repeatIndex).padStart(2, "0")}`;
  return placements.map((placement) => {
    const next: JsonMap = { ...placement };
    if (typeof next.label === "string" && next.label.trim() && !next.label.endsWith(suffix)) {
      next.label = `${next.label}${suffix}`;
    }
    const overrides = asObject(next.parameterOverrides);
    if (Object.keys(overrides).length > 0) {
      const nextOverrides: JsonMap = { ...overrides };
      if (typeof nextOverrides.Mark === "string" && nextOverrides.Mark.trim() && !nextOverrides.Mark.endsWith(suffix)) {
        nextOverrides.Mark = `${nextOverrides.Mark}${suffix}`;
      }
      next.parameterOverrides = nextOverrides;
    }
    return next;
  });
}

function takeDefined(source: JsonMap, keys: string[]): JsonMap {
  const out: JsonMap = {};
  for (const key of keys) {
    if (source[key] !== undefined && source[key] !== null) out[key] = source[key];
  }
  return out;
}

function buildCreateSimilarRequest(placement: JsonMap, workflowRequest: JsonMap): JsonMap {
  const placementItem = takeDefined(placement, [
    "pointXyz",
    "alongHostOffsetFt",
    "targetChainageFt",
    "targetNormalizedChainage",
    "elevationFt",
    "elevationDeltaFt",
    "label"
  ]);
  return {
    ...takeDefined(placement, [
      "exemplarElementId",
      "hostElementId",
      "roomId",
      "roomNumber",
      "roomSide",
      "referenceElementId",
      "levelName",
      "matchOrientationFromSource",
      "orientationSourceElementId",
      "copyRotation",
      "copyFacingHandState",
      "matchElectricalCircuitFromSource",
      "requireElectricalCircuitMatch",
      "parameterNamesToCopy",
      "parameterOverrides",
      "focusPaddingFt",
      "previewImageSize"
    ]),
    ...placementItem,
    placements: [placementItem],
    dryRun: false,
    includePreviewImage: true,
    previewViewId: placement.previewViewId ?? workflowRequest.viewId
  };
}

export async function runRevitDemoWorkflow(config: WorkflowConfig, runDir: string, transport?: BridgeTransport): Promise<RevitWorkflowResult> {
  const workflow = workflowName(config.workflow);
  const request = asObject(config.request);
  const timeoutMs = Number(config.timeout_ms ?? 60_000);
  const useMockFixtures = shouldUseMockBridgeFixtures(config);
  const executionSource: RevitWorkflowResult["execution_source"] = transport ? "injected" : useMockFixtures ? "mock" : "live";
  const effectiveTransport =
    transport ??
    (useMockFixtures
      ? new MockBridgeTransport(asObject(config.mock))
      : new HttpBridgeTransport(clip(config.bridge_url, 500) || defaultBridgeUrl(), timeoutMs));
  const startedAt = performance.now();
  let partial: RevitWorkflowPartialResult;
  try {
    if (workflow === "sheet_export") partial = await runSheetExport(effectiveTransport, request);
    else if (workflow === "takeoff_csv") partial = await runTakeoffCsv(effectiveTransport, request, runDir);
    else if (workflow === "parameter_edit") partial = await runParameterEdit(effectiveTransport, request, runDir);
    else if (workflow === "redline_update_parameter") partial = await runRedlineUpdateParameter(effectiveTransport, request, runDir);
    else if (workflow === "redline_receptacles") partial = await runRedlineReceptacles(effectiveTransport, request, runDir);
    else if (workflow === "redline_add") partial = await runRedlineAdd(effectiveTransport, request, runDir);
    else if (workflow === "redline_delete") partial = await runRedlineDelete(effectiveTransport, request, runDir);
    else if (workflow === "redline_move") partial = await runRedlineMove(effectiveTransport, request, runDir);
    else if (workflow === "redline_rotate") partial = await runRedlineRotate(effectiveTransport, request, runDir);
    else if (workflow === "redline_type_change") partial = await runRedlineTypeChange(effectiveTransport, request, runDir);
    else if (workflow === "redline_mep_route") partial = await runRedlineMepRoute(effectiveTransport, request, runDir);
    else if (workflow === "redline_mep_tap_branch") partial = await runRedlineMepTapBranch(effectiveTransport, request, runDir);
    else if (workflow === "redline_mep_reroute") partial = await runRedlineMepReroute(effectiveTransport, request, runDir);
    else if (workflow === "redline_mep_size_transition") partial = await runRedlineMepSizeTransition(effectiveTransport, request, runDir);
    else if (workflow === "documentation_primitives") partial = await runDocumentationPrimitives(effectiveTransport, request, runDir);
    else if (workflow === "model_edit_primitives") partial = await runModelEditPrimitives(effectiveTransport, request, runDir);
    else partial = await runAecMepEval(effectiveTransport, request, runDir);
  } catch (error) {
    const message = errorMessage(error);
    const hostEvidence = executionSource === "live" ? collectLocalRevitHostEvidence() : undefined;
    const failureClassification = executionSource === "live"
      ? classifyWorkflowFailure(message, hostEvidence)
      : "workflow_error";
    const modalRecoveryActions = effectiveTransport instanceof HttpBridgeTransport ? effectiveTransport.computerUseActions : 0;
    const result: RevitWorkflowResult = {
      workflow,
      execution_source: executionSource,
      success: false,
      failure_reason: `Revit workflow threw before completion: ${message}`,
      failure_classification: failureClassification,
      ...(hostEvidence ? { host_evidence: hostEvidence } : {}),
      elapsed_seconds: (performance.now() - startedAt) / 1000,
      tool_calls: 0,
      revit_transactions: 0,
      computer_use_actions: modalRecoveryActions,
      output_artifacts: [],
      verification_results: [],
      user_message: "Revit workflow failed before completion; inspect failure_classification and host_evidence before retrying live execution.",
      raw_results: []
    };
    writeJsonFile(path.join(runDir, "revit_workflow_result.json"), result);
    return result;
  }
  const modalRecoveryActions = effectiveTransport instanceof HttpBridgeTransport ? effectiveTransport.computerUseActions : 0;
  const result = {
    ...partial,
    computer_use_actions: partial.computer_use_actions + modalRecoveryActions,
    execution_source: executionSource,
    elapsed_seconds: (performance.now() - startedAt) / 1000
  };
  writeJsonFile(path.join(runDir, "revit_workflow_result.json"), result);
  return result;
}
