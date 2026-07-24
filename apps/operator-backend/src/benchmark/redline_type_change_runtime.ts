import fs from "node:fs";
import path from "node:path";
import { writeJsonFile } from "./files.js";

type JsonMap = Record<string, unknown>;

export type TypeChangeVerification = {
  name: string;
  ok: boolean;
  expected?: unknown;
  actual?: unknown;
  detail?: string;
};

export type TypeChangeWorkflowResult = {
  workflow: "redline_type_change";
  success: boolean;
  failure_reason: string | null;
  tool_calls: number;
  revit_transactions: number;
  computer_use_actions: number;
  output_artifacts: string[];
  verification_results: TypeChangeVerification[];
  user_message: string;
  raw_results: unknown[];
};

type VerificationFactory = (
  name: string,
  ok: boolean,
  expected?: unknown,
  actual?: unknown,
  detail?: string
) => TypeChangeVerification;

type MarkdownWriter = (filePath: string, rows: Array<Record<string, unknown>>) => string;

function clip(value: unknown, max = 500): string {
  const text = typeof value === "string" ? value.trim() : "";
  return text.length <= max ? text : text.slice(0, max).trim();
}
function asObject(value: unknown): JsonMap {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonMap : {};
}

function asNumberArray(value: unknown): number[] {
  return Array.isArray(value)
    ? value.map(Number).filter((entry) => Number.isFinite(entry) && entry > 0)
    : [];
}

function uniquePositiveIds(...values: unknown[]): number[] {
  return Array.from(new Set(values.flatMap(asNumberArray)));
}

function firstPositiveId(...values: unknown[]): number | null {
  for (const value of values) {
    const number = Number(value);
    if (Number.isFinite(number) && number > 0) return number;
  }
  return null;
}

function firstString(...values: unknown[]): string {
  for (const value of values) {
    const text = clip(value, 300);
    if (text) return text;
  }
  return "";
}

function normalizedTextProof(value: unknown): string {
  return clip(value, 1000).replace(/\s+/g, " ").trim().toLowerCase();
}

function normalizeProofLabel(value: unknown): string {
  return clip(value, 220).toLowerCase().replace(/\s+/g, " ").trim();
}

function proofLabelsMatchRequest(requestedLabel: string, actualLabels: string[]): boolean {
  const requested = normalizeProofLabel(requestedLabel);
  return !requested || actualLabels.some((actual) => actual === requested || actual.includes(requested) || requested.includes(actual));
}

export function typeChangeRows(result: unknown): JsonMap[] {
  const rows = asObject(result).changes;
  return Array.isArray(rows) ? rows.map(asObject).filter((row) => Object.keys(row).length > 0) : [];
}

export function typeChangeEffectIds(result: unknown): number[] {
  const object = asObject(result);
  const rowIds = typeChangeRows(result).filter((row) => row.ok !== false).map((row) => row.elementId);
  return uniquePositiveIds(object.changedElementIds, rowIds);
}

export function normalizedTypeName(value: unknown): string {
  return normalizedTextProof(firstString(value));
}

function typeChangeRowMatchesRequestedType(
  row: JsonMap,
  expectedTypeId: number | null,
  expectedTypeName: string,
  phase: "apply" | "readback"
): boolean {
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
  const object = asObject(result);
  if (expectedTypeId !== null) return firstPositiveId(object.newTypeId, object.currentTypeId, object.typeId) === expectedTypeId;
  return Boolean(expectedTypeName) && normalizedTypeName(object.newTypeName ?? object.currentTypeName ?? object.typeName) === expectedTypeName;
}

export function typeChangeAppliedMatchesRequest(
  result: unknown,
  elementIds: number[],
  expectedTypeId: number | null,
  expectedTypeName: string
): boolean {
  const rows = typeChangeRows(result);
  if (rows.length > 0) {
    return elementIds.length > 0 && elementIds.every((id) => {
      const row = rows.find((entry) => Number(entry.elementId) === id);
      return Boolean(row) && typeChangeRowMatchesRequestedType(row ?? {}, expectedTypeId, expectedTypeName, "apply");
    });
  }
  return elementIds.length > 0
    && elementIds.every((id) => typeChangeEffectIds(result).includes(id))
    && typeChangeGlobalTypeMatches(result, expectedTypeId, expectedTypeName);
}

export function typeChangeReadbackMatchesRequest(
  result: unknown,
  elementIds: number[],
  expectedTypeId: number | null,
  expectedTypeName: string
): boolean {
  const rows = typeChangeRows(result);
  return elementIds.length > 0 && elementIds.every((id) => {
    const row = rows.find((entry) => Number(entry.elementId) === id);
    return Boolean(row) && typeChangeRowMatchesRequestedType(row ?? {}, expectedTypeId, expectedTypeName, "readback");
  });
}

export function typeChangeSourceGroundingMatches(
  result: unknown,
  elementIds: number[],
  expectedTypeId: number | null,
  expectedTypeName: string
): boolean {
  const rows = typeChangeRows(result);
  return elementIds.length > 0 && elementIds.every((id) => {
    const row = rows.find((entry) => Number(entry.elementId) === id);
    if (!row || row.ok === false) return false;
    const oldTypeId = firstPositiveId(row.oldTypeId, row.currentTypeId, row.typeId);
    const oldTypeName = normalizedTypeName(row.oldTypeName ?? row.currentTypeName ?? row.typeName);
    if (expectedTypeId !== null) return oldTypeId === expectedTypeId;
    return expectedTypeName ? oldTypeName === expectedTypeName : oldTypeId !== null || Boolean(oldTypeName);
  });
}

export function typeChangeSourceFamilyGroundingMatches(
  result: unknown,
  elementIds: number[],
  expectedFamilyName: string,
  expectedTypeName: string,
  expectedCategory: string
): boolean {
  if (!expectedFamilyName && !expectedTypeName && !expectedCategory) return true;
  const rows = typeChangeRows(result);
  return elementIds.length > 0 && elementIds.every((id) => {
    const row = rows.find((entry) => Number(entry.elementId) === id);
    if (!row || row.ok === false) return false;
    const familyLabels = [row.oldFamilyName, row.familyName, row.currentFamilyName, row.oldTypeName, row.typeName, row.currentTypeName]
      .map((value) => clip(value, 240)).filter(Boolean);
    const typeLabels = [row.oldTypeName, row.typeName, row.currentTypeName]
      .map((value) => clip(value, 240)).filter(Boolean);
    const categoryLabels = [row.category, row.categoryName, row.builtInCategory, row.built_in_category, row.oldCategory, row.currentCategory]
      .map((value) => clip(value, 240)).filter(Boolean);
    return proofLabelsMatchRequest(expectedFamilyName, familyLabels)
      && proofLabelsMatchRequest(expectedTypeName, typeLabels)
      && proofLabelsMatchRequest(expectedCategory, categoryLabels);
  });
}

export function buildBlockedTypeChangeResult(args: {
  runDir: string;
  elementIds: number[];
  category: string;
  targetTypeId: number | null;
  targetTypeName: string;
  expectedNewTypeId: number | null;
  expectedNewTypeName: string;
  expectedOriginalTypeId: number | null;
  expectedOriginalTypeName: string;
  expectedSourceFamilyName: string;
  expectedSourceTypeName: string;
  expectedSourceCategory: string;
  sourceFamilyGroundingOk: boolean;
  dryRunIds: number[];
  dryRunPreflightReviewed: boolean;
  targetTypeCompatibilityReviewed: boolean;
  dryRun: unknown;
  preApplyChecks: TypeChangeVerification[];
  rawResults: unknown[];
  verification: VerificationFactory;
  writeMarkdownTable: MarkdownWriter;
}): TypeChangeWorkflowResult {
  const summaryJsonPath = path.join(args.runDir, "artifacts", "redline_type_change_summary.json");
  writeJsonFile(summaryJsonPath, {
    elementIds: args.elementIds,
    category: args.category,
    targetTypeId: args.targetTypeId,
    targetTypeName: args.targetTypeName,
    expectedNewTypeId: args.expectedNewTypeId,
    expectedNewTypeName: args.expectedNewTypeName,
    expectedOriginalTypeId: args.expectedOriginalTypeId,
    expectedOriginalTypeName: args.expectedOriginalTypeName,
    expectedSourceFamilyName: args.expectedSourceFamilyName,
    expectedSourceTypeName: args.expectedSourceTypeName,
    expectedSourceCategory: args.expectedSourceCategory,
    sourceFamilyGroundingOk: args.sourceFamilyGroundingOk,
    dryRunIds: args.dryRunIds,
    dryRunPreflightReviewed: args.dryRunPreflightReviewed,
    targetTypeCompatibilityReviewed: args.targetTypeCompatibilityReviewed,
    blockedBeforeModelWrite: true,
    rawDryRun: args.dryRun
  });
  const summaryMarkdownPath = args.writeMarkdownTable(
    path.join(args.runDir, "artifacts", "redline_type_change_summary.md"),
    args.elementIds.map((elementId) => ({
      elementId,
      requestedTypeId: args.expectedNewTypeId ?? args.targetTypeId ?? "",
      requestedTypeName: args.targetTypeName,
      blockedBeforeModelWrite: true
    }))
  );
  const checks = [
    ...args.preApplyChecks,
    args.verification("type_change_apply_ids_present", false, "blocked before model write", []),
    args.verification("type_change_readback_matches_target", false, "blocked before model write", null),
    args.verification("type_change_post_change_capture_returned", false, "blocked before model write", null),
    args.verification("type_change_post_change_capture_view_id_matches_request", false, "blocked before model write", null),
    args.verification("type_change_revert_dry_run_ok", false, "blocked before model write", []),
    args.verification("type_change_revert_apply_ids_present", false, "blocked before model write", []),
    args.verification("type_change_revert_readback_matches_original", false, "blocked before model write", null),
    args.verification("type_change_summary_written", fs.existsSync(summaryJsonPath) && fs.existsSync(summaryMarkdownPath), "summary artifacts", [summaryJsonPath, summaryMarkdownPath])
  ];
  return {
    workflow: "redline_type_change",
    success: false,
    failure_reason: "Type-change redline blocked before model write because dry-run/source-type evidence was incomplete.",
    tool_calls: 1,
    revit_transactions: 0,
    computer_use_actions: 0,
    output_artifacts: [summaryJsonPath, summaryMarkdownPath],
    verification_results: checks,
    user_message: "Type-change redline blocked before model write because dry-run compatibility/source-type proof was incomplete.",
    raw_results: args.rawResults
  };
}

export function buildRejectedTypeChangeResult(args: {
  runDir: string;
  elementIds: number[];
  targetTypeId: number | null;
  targetTypeName: string;
  expectedNewTypeId: number | null;
  expectedOldTypes: Array<{ elementId: number; typeId: number }>;
  appliedIds: number[];
  appliedTypeMatchesRequest: boolean;
  applied: unknown;
  preApplyChecks: TypeChangeVerification[];
  rawResults: unknown[];
  verification: VerificationFactory;
  writeMarkdownTable: MarkdownWriter;
}): TypeChangeWorkflowResult {
  const summaryJsonPath = path.join(args.runDir, "artifacts", "redline_type_change_summary.json");
  writeJsonFile(summaryJsonPath, {
    elementIds: args.elementIds,
    targetTypeId: args.targetTypeId,
    targetTypeName: args.targetTypeName,
    expectedOldTypes: args.expectedOldTypes,
    appliedIds: args.appliedIds,
    appliedTypeMatchesRequest: args.appliedTypeMatchesRequest,
    applyAccepted: false,
    blockedBeforeReadbackOrRevert: true,
    rawApplied: args.applied
  });
  const summaryMarkdownPath = args.writeMarkdownTable(
    path.join(args.runDir, "artifacts", "redline_type_change_summary.md"),
    args.elementIds.map((elementId) => ({
      elementId,
      requestedTypeId: args.expectedNewTypeId ?? args.targetTypeId ?? "",
      requestedTypeName: args.targetTypeName,
      applied: false,
      blockedBeforeReadbackOrRevert: true
    }))
  );
  const checks = [
    ...args.preApplyChecks,
    args.verification("type_change_apply_ids_present", false, args.elementIds, args.appliedIds),
    args.verification("type_change_apply_committed", false, "ok=true, committed=true, and rolledBack=false", args.applied),
    args.verification("type_change_readback_matches_target", false, "blocked after failed apply", null),
    args.verification("type_change_revert_readback_matches_original", false, "revert intentionally not attempted after failed apply", null),
    args.verification("type_change_summary_written", fs.existsSync(summaryJsonPath) && fs.existsSync(summaryMarkdownPath), "summary artifacts", [summaryJsonPath, summaryMarkdownPath])
  ];
  return {
    workflow: "redline_type_change",
    success: false,
    failure_reason: "Type-change apply failed or rolled back; readback and revert were not attempted to avoid overwriting a concurrent model change.",
    tool_calls: args.rawResults.length,
    revit_transactions: 1,
    computer_use_actions: 0,
    output_artifacts: [summaryJsonPath, summaryMarkdownPath],
    verification_results: checks,
    user_message: "Type change was not applied. I stopped before readback or revert so I would not overwrite another change.",
    raw_results: args.rawResults
  };
}
