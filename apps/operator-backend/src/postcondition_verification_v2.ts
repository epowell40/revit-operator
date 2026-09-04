/**
 * Deterministic semantic comparison shared by the live teammate controller and
 * Assignment Kernel V2 settlement/recovery. The comparison intentionally uses
 * only the admitted apply input and authoritative verification payload so the
 * same result can be derived after process loss.
 */

import { normalizeTextNoteTextV1 } from "@revitoperator/text-note-round-trip-v1";
import {
  isExcludedEvidenceContainerV2,
  normalizedEvidenceKeyV2
} from "./verification/verification_payload_boundary_v2.js";

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function structuredValue(value: unknown): unknown {
  if (typeof value !== "string") return value;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > 1_000_000 || !/^[\[{]/.test(trimmed)) return value;
  try {
    return JSON.parse(trimmed);
  } catch {
    return value;
  }
}

function semanticApplyInput(value: unknown): unknown {
  const input = objectValue(value);
  return Object.prototype.hasOwnProperty.call(input, "body")
    ? structuredValue(input.body)
    : Object.prototype.hasOwnProperty.call(input, "arguments")
      ? structuredValue(input.arguments)
    : structuredValue(value);
}

export type PostconditionOperationContractV2 = {
  capability_id?: unknown;
  path?: unknown;
  tool?: unknown;
};

const REVIT_TEXT_ASSIGNMENT_KEYS = new Set([
  "newtext", "replacementtext", "replaceto", "replacewith"
]);

const REVIT_TEXT_OBSERVATION_KEYS = new Set([
  "after", "currenttext", "text", "texts"
]);

function canonicalPostconditionField(value: string): string {
  const normalized = normalizedEvidenceKeyV2(value);
  switch (normalized) {
    case "hasstripedrows": return "stripedrows";
    case "showgrandtotal": return "showgrandtotals";
    case "newname":
    case "aftername":
    case "currentname": return "name";
    case "newnumber":
    case "afternumber":
    case "currentnumber": return "number";
    case "newvalue":
    case "aftervalue":
    case "currentvalue":
    case "targetvalue":
    case "values": return "value";
    case "newtext":
    case "replacementtext":
    case "currenttext":
    case "texts": return "text";
    case "replaceto":
    case "replacewith": return "after";
    default: return normalized;
  }
}

function propertyValueToken(field: string, value: unknown): string {
  return `property:${canonicalPostconditionField(field)}:${JSON.stringify(value)}`;
}

function targetPropertyValueToken(target: string, field: string, value: unknown): string {
  return `target_property:${JSON.stringify(target)}:${canonicalPostconditionField(field)}:${JSON.stringify(value)}`;
}

function schedulePropertyValueToken(field: string, value: unknown): string {
  return `schedule_property:${canonicalPostconditionField(field)}:${JSON.stringify(value)}`;
}

function scheduleFieldToken(value: unknown): string | null {
  const name = typeof value === "string" ? value.trim().toLowerCase() : "";
  return name ? `schedule_field:${JSON.stringify(name)}` : null;
}

function operationContractPath(value: unknown, contract: PostconditionOperationContractV2): string {
  const input = objectValue(value);
  return `${contract.path ?? input.path ?? contract.tool ?? input.tool ?? ""}`.trim().toLowerCase();
}

function scheduleFilterToken(value: unknown): string | null {
  const row = objectValue(value);
  const field = typeof row.field === "string" ? row.field.trim().toLowerCase() : "";
  const op = typeof row.op === "string" ? row.op.trim().toLowerCase().replace(/[\s-]+/g, "_") : "";
  if (!field || !op) return null;
  const filterValue = Object.prototype.hasOwnProperty.call(row, "value") ? row.value : null;
  return `schedule_filter:${JSON.stringify({ field, op, value: filterValue })}`;
}

function scheduleFilterSetToken(values: readonly string[]): string {
  return `schedule_filter_set:${JSON.stringify([...new Set(values)].sort())}`;
}

function scalarParameterRepresentations(value: unknown): readonly unknown[] {
  if (value === null || value === undefined) return [];
  if (typeof value !== "object" || Array.isArray(value)) return [value];
  const row = value as Record<string, unknown>;
  return [row.value, row.valueString, row.displayValue]
    .filter((candidate) => candidate !== null && candidate !== undefined
      && (typeof candidate !== "object" || candidate instanceof Date));
}

function parameterTargetIdentities(value: unknown): readonly string[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return [];
  const row = value as Record<string, unknown>;
  const candidates = [row.elementId, row.element_id, row.typeId, row.type_id];
  for (const key of ["elementIds", "element_ids", "ids", "typeIds", "type_ids"] as const) {
    const candidate = row[key];
    if (Array.isArray(candidate)) candidates.push(...candidate);
    else if (candidate !== undefined && candidate !== null) candidates.push(candidate);
  }
  if (candidates.every((candidate) => candidate === undefined || candidate === null)) candidates.push(row.id);
  return [...new Set(candidates
    .filter((candidate) => typeof candidate === "string" || typeof candidate === "number" || typeof candidate === "bigint")
    .map((candidate) => String(candidate).trim().toLowerCase())
    .filter(Boolean))].sort();
}

function parameterMapTokens(
  value: unknown,
  targets: readonly string[] = [],
  includeGeneric = targets.length === 0
): readonly string[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return [];
  const tokens = new Set<string>();
  for (const [name, parameterValue] of Object.entries(value as Record<string, unknown>)) {
    for (const candidate of scalarParameterRepresentations(parameterValue)) {
      if (includeGeneric) tokens.add(propertyValueToken(name, candidate));
      for (const target of targets) tokens.add(targetPropertyValueToken(target, name, candidate));
    }
  }
  return [...tokens].sort();
}

function namedParameterTokens(
  value: unknown,
  allowDetailName = false,
  targets: readonly string[] = [],
  includeGeneric = targets.length === 0
): readonly string[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return [];
  const row = value as Record<string, unknown>;
  const parameterName = row.parameterName ?? row.parameter_name ?? row.fieldName ?? row.field_name
    ?? (allowDetailName ? row.name : undefined);
  const name = typeof parameterName === "string" ? parameterName.trim() : "";
  if (!name) return [];
  const parameterValue = Object.prototype.hasOwnProperty.call(row, "value") ? row.value
    : Object.prototype.hasOwnProperty.call(row, "newValue") ? row.newValue
      : Object.prototype.hasOwnProperty.call(row, "new_value") ? row.new_value
        : Object.prototype.hasOwnProperty.call(row, "targetValue") ? row.targetValue
          : Object.prototype.hasOwnProperty.call(row, "target_value") ? row.target_value
            : undefined;
  const tokens = new Set<string>();
  for (const candidate of scalarParameterRepresentations(parameterValue)) {
    if (includeGeneric) tokens.add(propertyValueToken(name, candidate));
    for (const target of targets) tokens.add(targetPropertyValueToken(target, name, candidate));
  }
  return [...tokens].sort();
}

function observedScheduleContractTokens(value: unknown): readonly string[] {
  const tokens = new Set<string>();
  const appearanceProperties = new Set(["showtitle", "showheaders", "stripedrows", "hasstripedrows", "freezeheaders"]);
  const settingProperties = new Set(["showgrandtotal", "showgrandtotals", "filterbysheet", "isfilteredbysheet"]);
  const visit = (node: unknown, depth = 0): void => {
    if (node === null || node === undefined || depth > 8) return;
    if (typeof node === "string" && /^[\[{]/.test(node.trim())) {
      try { visit(JSON.parse(node), depth + 1); } catch {}
      return;
    }
    if (Array.isArray(node)) {
      for (const item of node) visit(item, depth + 1);
      return;
    }
    if (typeof node !== "object") return;
    const row = node as Record<string, unknown>;
    const entries = Object.entries(row);
    const filterEntry = entries.find(([key]) => normalizedEvidenceKeyV2(key) === "filterdefinitions");
    if (filterEntry && Array.isArray(filterEntry[1])) {
      const filterTokens = filterEntry[1]
        .map(scheduleFilterToken)
        .filter((token): token is string => token !== null);
      for (const token of filterTokens) tokens.add(token);
      const complete = entries.find(([key]) => normalizedEvidenceKeyV2(key) === "filterdefinitionscomplete")?.[1] === true;
      if (complete && filterTokens.length === filterEntry[1].length) tokens.add(scheduleFilterSetToken(filterTokens));
    }
    for (const [key, child] of entries) {
      const normalized = normalizedEvidenceKeyV2(key);
      if (isExcludedEvidenceContainerV2(key)) continue;
      if ((normalized === "appearance" || normalized === "settings" || normalized === "schedulesettings")
          && child && typeof child === "object" && !Array.isArray(child)) {
        const allowed = normalized === "appearance" ? appearanceProperties : settingProperties;
        for (const [property, propertyValue] of Object.entries(child as Record<string, unknown>)) {
          if (propertyValue !== null && propertyValue !== undefined && allowed.has(normalizedEvidenceKeyV2(property))) {
            tokens.add(schedulePropertyValueToken(property, propertyValue));
          }
        }
      }
      // A read-only native API program may return the actual ViewSchedule
      // object projection rather than the reviewed /revit/schedules wrapper.
      // Admit only named schedule properties from that explicit projection;
      // arbitrary table rows and same-named request fields remain ineligible.
      if (normalized === "schedule" && child && typeof child === "object" && !Array.isArray(child)) {
        for (const [property, propertyValue] of Object.entries(child as Record<string, unknown>)) {
          if (propertyValue !== null && propertyValue !== undefined
              && (appearanceProperties.has(normalizedEvidenceKeyV2(property)) || settingProperties.has(normalizedEvidenceKeyV2(property)))) {
            tokens.add(schedulePropertyValueToken(property, propertyValue));
          }
        }
      }
      if (normalized === "fields" && Array.isArray(child)) {
        for (const candidate of child) {
          const token = scheduleFieldToken(objectValue(candidate).name);
          if (token) tokens.add(token);
        }
      }
      visit(child, depth + 1);
    }
  };
  visit(value);
  return [...tokens].sort();
}

function textNoteOperation(value: unknown, contract: PostconditionOperationContractV2): boolean {
  const input = objectValue(value);
  const path = `${contract.path ?? input.path ?? ""}`.trim().toLowerCase();
  const tool = `${contract.tool ?? contract.capability_id ?? input.tool ?? input.capability_id ?? ""}`.trim().toLowerCase();
  return path === "/revit/replace-text-note"
    || path === "/revit/set-text-note-text"
    || tool === "revit_replace_text_note"
    || tool === "revit_replace_textnote"
    || tool === "revit_set_text_note_text";
}

/**
 * Revit stores TextNote paragraph separators as CR and commonly returns one
 * terminal paragraph marker even when the caller supplied LF without a final
 * newline. Those are representation details, not different TextNote content.
 * Keep every other character exact: case, spaces, punctuation, and interior
 * blank paragraphs remain part of the postcondition.
 */
function revitTextToken(value: string): string {
  return `revit_text:${JSON.stringify(normalizeTextNoteTextV1(value))}`;
}

function observedRevitTextTokens(value: string): readonly string[] {
  const normalized = normalizeTextNoteTextV1(value);
  // Revit may add exactly one terminal paragraph marker to TextNote.Text.
  // Emit the literal value and the value with one marker removed; never trim
  // multiple markers or any other content.
  return normalized.endsWith("\n")
    ? [revitTextToken(normalized), revitTextToken(normalized.slice(0, -1))]
    : [revitTextToken(normalized)];
}

export function expectedPostconditionValuesV2(
  value: unknown,
  includeIdentityRenames = true,
  contract: PostconditionOperationContractV2 = {}
): readonly string[] {
  const values = new Set<string>();
  const useRevitTextSemantics = textNoteOperation(value, contract);
  const operationPath = operationContractPath(value, contract);
  const semanticInput = semanticApplyInput(value);
  const visit = (node: unknown, key = "", parent = "", depth = 0): void => {
    if (depth > 6 || values.size >= 32) return;
    if (Array.isArray(node)) {
      for (const item of node) visit(item, key, parent, depth + 1);
      return;
    }
    if (node && typeof node === "object") {
      const row = node as Record<string, unknown>;
      const targets = parameterTargetIdentities(row);
      if (row.parameters && typeof row.parameters === "object" && !Array.isArray(row.parameters)) {
        for (const token of parameterMapTokens(row.parameters, targets)) values.add(token);
      }
      const namedParameter = namedParameterTokens(row, false, targets);
      if (namedParameter.length > 0) {
        for (const token of namedParameter) values.add(token);
        return;
      }
      for (const [childKey, child] of Object.entries(row)) {
        if (normalizedEvidenceKeyV2(childKey) === "parameters") continue;
        visit(child, childKey, key, depth + 1);
      }
      return;
    }
    if (node === null || node === undefined) return;
    const normalizedChildKey = normalizedEvidenceKeyV2(key);
    const normalizedParent = normalizedEvidenceKeyV2(parent);
    const valueIsPredicate = /(?:filter|condition|rule|criterion|criteria)/.test(normalizedParent);
    const identityRename = includeIdentityRenames && ["newname", "newnumber"].includes(normalizedChildKey);
    const assignedValue = ["value", "newvalue", "replaceto", "targetvalue", "newtext", "replacementtext", "replacewith"].includes(normalizedChildKey);
    if (normalizedParent === "parameters" || (!valueIsPredicate && (identityRename || assignedValue))) {
      const expectedField = operationPath === "/revit/renumber-sheets" && normalizedChildKey === "newname"
        ? "sheetName"
        : operationPath === "/revit/renumber-sheets" && normalizedChildKey === "newnumber"
          ? "sheetNumber"
          : key;
      values.add(useRevitTextSemantics && typeof node === "string" && REVIT_TEXT_ASSIGNMENT_KEYS.has(normalizedChildKey)
        ? revitTextToken(node)
        : propertyValueToken(expectedField, node));
    }
    if (operationPath === "/revit/configure-schedule" && normalizedParent === "appearance") {
      values.add(schedulePropertyValueToken(key, node));
    }
  };
  visit(semanticInput);
  if (operationPath === "/revit/configure-schedule") {
    const scheduleInput = objectValue(semanticInput);
    const filters = scheduleInput.filters;
    const filterTokens: string[] = [];
    for (const candidate of Array.isArray(filters) ? filters : []) {
      const token = scheduleFilterToken(candidate);
      if (token) {
        values.add(token);
        filterTokens.push(token);
      }
    }
    if (Array.isArray(filters) && scheduleInput.replaceFilters !== false) {
      values.add(scheduleFilterSetToken(filterTokens));
    }
    for (const field of Array.isArray(scheduleInput.addFields) ? scheduleInput.addFields : []) {
      const token = scheduleFieldToken(field);
      if (token) values.add(token);
    }
    for (const property of ["showGrandTotals", "filterBySheet"] as const) {
      const propertyValue = scheduleInput[property];
      if (propertyValue !== null && propertyValue !== undefined) {
        values.add(schedulePropertyValueToken(property, propertyValue));
      }
    }
  }
  if (operationPath === "/revit/native-api-mutation-ops") {
    const operations = objectValue(semanticInput).operations;
    for (const candidate of Array.isArray(operations) ? operations : []) {
      const operation = objectValue(candidate);
      const memberId = `${operation.memberId ?? operation.member_id ?? ""}`;
      const args = Array.isArray(operation.args) ? operation.args : [];
      // Parameter.Set has one semantic assignment argument. Local program
      // handles and transaction-scope IDs are not desired-state values.
      if (/Autodesk\.Revit\.DB\.Parameter\.Set\s*\(/i.test(memberId) && args.length === 1) {
        values.add(propertyValueToken("value", args[0]));
      }
    }
  }
  return [...values].sort();
}

export function observedPostconditionValuesV2(value: unknown): ReadonlySet<string> {
  const values = new Set<string>();
  for (const token of observedScheduleContractTokens(value)) values.add(token);
  const controlLeaves = new Set([
    "action", "complete", "dryrun", "error", "failure", "message", "ok", "status", "success", "verified"
  ]);
  const visit = (node: unknown, key = "", parent = "", inheritedTargets: readonly string[] = [], depth = 0): void => {
    if (depth > 8 || values.size >= 512 || node === null || node === undefined) return;
    if (Array.isArray(node)) {
      for (const item of node) visit(item, key, parent, inheritedTargets, depth + 1);
      return;
    }
    if (node && typeof node === "object") {
      const normalizedContainer = normalizedEvidenceKeyV2(key);
      const row = node as Record<string, unknown>;
      const directTargets = parameterTargetIdentities(row);
      const targets = directTargets.length > 0 ? directTargets : inheritedTargets;
      if (row.parameters && typeof row.parameters === "object" && !Array.isArray(row.parameters)) {
        for (const token of parameterMapTokens(row.parameters, targets, true)) values.add(token);
      }
      const namedParameter = namedParameterTokens(row, normalizedContainer === "parameterdetails", targets, true);
      if (namedParameter.length > 0) {
        for (const token of namedParameter) values.add(token);
        return;
      }
      for (const [childKey, item] of Object.entries(row)) {
        if (isExcludedEvidenceContainerV2(childKey)) continue;
        if (normalizedEvidenceKeyV2(childKey) === "parameters") continue;
        visit(item, childKey, key, targets, depth + 1);
      }
      return;
    }
    if (typeof node === "string" && /^[\[{]/.test(node.trim())) {
      try {
        visit(JSON.parse(node), key, parent, inheritedTargets, depth + 1);
        return;
      } catch {
        // The string itself remains valid observable evidence.
      }
    }
    const normalizedChildKey = normalizedEvidenceKeyV2(key);
    // Native adapters do not share one field vocabulary: a parameter can be
    // returned as `value`, `values`, or its actual parameter name, while sheet
    // and TextNote reads use names such as `afterName` and `text`. Treat those
    // result fields as observable but exclude lifecycle/control leaves and all
    // request/input/provenance containers above.
    if (normalizedChildKey && !controlLeaves.has(normalizedChildKey)) {
      values.add(propertyValueToken(key, node));
      if (typeof node === "string" && REVIT_TEXT_OBSERVATION_KEYS.has(normalizedChildKey)) {
        for (const token of observedRevitTextTokens(node)) values.add(token);
      }
    }
  };
  visit(value);
  return values;
}

export function postconditionSatisfiedByPayloadV2(
  applyInput: unknown,
  verificationPayload: unknown,
  contract: PostconditionOperationContractV2 = {}
): boolean {
  const expected = expectedPostconditionValuesV2(applyInput, true, contract);
  if (expected.length > 0) {
    const observed = observedPostconditionValuesV2(verificationPayload);
    return expected.every(value => observed.has(value));
  }
  // An untyped success/complete/exists flag cannot prove an arbitrary mutation.
  // Operations without assigned values require a capability-specific trusted
  // assertion from the controller until their postcondition has a typed adapter.
  return false;
}
