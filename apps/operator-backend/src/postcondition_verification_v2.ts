/**
 * Deterministic semantic comparison shared by the live teammate controller and
 * Assignment Kernel V2 settlement/recovery. The comparison intentionally uses
 * only the admitted apply input and authoritative verification payload so the
 * same result can be derived after process loss.
 */

import { normalizeTextNoteTextV1 } from "@revitoperator/text-note-round-trip-v1";

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

function normalizedKey(value: string): string {
  return value.replace(/[^a-z0-9]/gi, "").toLowerCase();
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
  const visit = (node: unknown, key = "", parent = "", depth = 0): void => {
    if (depth > 6 || values.size >= 32) return;
    if (Array.isArray(node)) {
      for (const item of node) visit(item, key, parent, depth + 1);
      return;
    }
    if (node && typeof node === "object") {
      for (const [childKey, child] of Object.entries(node as Record<string, unknown>)) {
        visit(child, childKey, key, depth + 1);
      }
      return;
    }
    if (node === null || node === undefined) return;
    const normalizedChildKey = normalizedKey(key);
    const normalizedParent = normalizedKey(parent);
    const valueIsPredicate = /(?:filter|condition|rule|criterion|criteria)/.test(normalizedParent);
    const identityRename = includeIdentityRenames && ["newname", "newnumber"].includes(normalizedChildKey);
    const assignedValue = ["value", "newvalue", "replaceto", "targetvalue", "newtext", "replacementtext", "replacewith"].includes(normalizedChildKey);
    if (normalizedParent === "parameters" || (!valueIsPredicate && (identityRename || assignedValue))) {
      values.add(useRevitTextSemantics && typeof node === "string" && REVIT_TEXT_ASSIGNMENT_KEYS.has(normalizedChildKey)
        ? revitTextToken(node)
        : JSON.stringify(node));
    }
  };
  visit(semanticApplyInput(value));
  return [...values].sort();
}

export function observedPostconditionValuesV2(value: unknown): ReadonlySet<string> {
  const values = new Set<string>();
  const excludedContainers = new Set([
    "arguments", "body", "canonicalattemptsettlement", "control", "input", "meta", "metadata",
    "operationresultv2", "payloadprovenance", "provenance", "request", "requestbody", "requestinput"
  ]);
  const controlLeaves = new Set([
    "action", "complete", "dryrun", "error", "failure", "message", "ok", "status", "success", "verified"
  ]);
  const visit = (node: unknown, key = "", parent = "", depth = 0): void => {
    if (depth > 8 || values.size >= 512 || node === null || node === undefined) return;
    if (Array.isArray(node)) {
      for (const item of node) visit(item, key, parent, depth + 1);
      return;
    }
    if (node && typeof node === "object") {
      for (const [childKey, item] of Object.entries(node as Record<string, unknown>)) {
        const normalizedChild = normalizedKey(childKey);
        if (excludedContainers.has(normalizedChild)) continue;
        visit(item, childKey, key, depth + 1);
      }
      return;
    }
    if (typeof node === "string" && /^[\[{]/.test(node.trim())) {
      try {
        visit(JSON.parse(node), key, parent, depth + 1);
        return;
      } catch {
        // The string itself remains valid observable evidence.
      }
    }
    const normalizedChildKey = normalizedKey(key);
    // Native adapters do not share one field vocabulary: a parameter can be
    // returned as `value`, `values`, or its actual parameter name, while sheet
    // and TextNote reads use names such as `afterName` and `text`. Treat those
    // result fields as observable but exclude lifecycle/control leaves and all
    // request/input/provenance containers above.
    if (normalizedChildKey && !controlLeaves.has(normalizedChildKey)) {
      values.add(JSON.stringify(node));
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
