/**
 * Versioned application contract for post-apply verification capabilities.
 *
 * The Assignment Kernel owns the generic rule that postconditions require
 * target-bound authoritative evidence. This adapter owns Revit-specific
 * knowledge about which reviewed capability result shapes can expose each
 * desired-state semantic output.
 */

import { isExcludedEvidenceContainerV2 } from "./verification_payload_boundary_v2.js";

export const VERIFICATION_CAPABILITY_ADMISSION_V2_SCHEMA =
  "revit-operator.verification-capability-admission/v2" as const;

export type VerificationCapabilityAdmissionV2 = Readonly<{
  schema: typeof VERIFICATION_CAPABILITY_ADMISSION_V2_SCHEMA;
  admissible: boolean;
  reason: string;
  required_semantic_outputs: readonly string[];
  provided_semantic_outputs: readonly string[];
  admissible_readback_paths: readonly string[];
}>;

export const OPERATION_TARGET_SELECTOR_V2_SCHEMA =
  "revit-operator.operation-target-selector/v2" as const;

export type OperationTargetSelectorV2 = Readonly<{
  schema: typeof OPERATION_TARGET_SELECTOR_V2_SCHEMA;
  source: "reviewed_capability_contract" | "legacy_generic_fallback";
  principal_target_tokens: readonly string[];
  contextual_scope_tokens: readonly string[];
}>;

type OperationContract = Readonly<{
  capability_id?: unknown;
  method?: unknown;
  path?: unknown;
  tool?: unknown;
  target_id?: unknown;
}>;

const TEXT_NOTE_MUTATION_PATHS = new Set([
  "/revit/replace-text-note",
  "/revit/set-text-note-text",
  "revit_replace_text_note"
]);

const PARAMETER_MUTATION_PATHS = new Set([
  "/revit/set-parameter",
  "/revit/set-parameters",
  "/revit/set-type-parameters",
  "/revit/update-panel-parameter",
  "/revit/update-parameter-by-query",
  "revit_set_parameters",
  "revit_set_type_parameters"
]);

type RevitRouteContractV2 = Readonly<{
  semantic_outputs: readonly string[];
  principal_target_fields?: readonly string[];
  contextual_scope_fields?: readonly string[];
  preferred_target_field?: string;
}>;

/**
 * One reviewed contract owns both what a route can prove and which identifiers
 * name the affected subject. Scope/filter identifiers deliberately stay
 * separate: a view containing an element is not the element changed by an
 * apply, and therefore cannot bind its postcondition readback.
 */
const REVIT_ROUTE_CONTRACTS = new Map<string, RevitRouteContractV2>([
  ["/revit/find-text-notes", {
    semantic_outputs: ["text_note.value"],
    principal_target_fields: ["elementId", "elementIds", "requestedElementIds"],
    contextual_scope_fields: ["viewId", "ownerViewId"],
    preferred_target_field: "elementId"
  }],
  ["revit_find_text_notes", {
    semantic_outputs: ["text_note.value"],
    principal_target_fields: ["elementId", "elementIds", "requestedElementIds"],
    contextual_scope_fields: ["viewId", "ownerViewId"],
    preferred_target_field: "elementId"
  }],
  ["/revit/find-family-text-notes", {
    semantic_outputs: ["text_note.value"],
    principal_target_fields: ["elementId", "elementIds", "requestedElementIds"],
    contextual_scope_fields: ["familyDocumentId", "ownerViewId"],
    preferred_target_field: "elementId"
  }],
  ["/revit/get-element-summary", {
    semantic_outputs: ["element.identity", "element.classification", "element.location"],
    principal_target_fields: ["elementId", "elementIds", "requestedElementIds"],
    contextual_scope_fields: ["viewId"]
  }],
  ["revit_get_element_summary", {
    semantic_outputs: ["element.identity", "element.classification", "element.location"],
    principal_target_fields: ["elementId", "elementIds", "requestedElementIds"],
    contextual_scope_fields: ["viewId"]
  }],
  ["/revit/get-parameters", {
    semantic_outputs: ["element.parameter_values"],
    principal_target_fields: ["id", "elementId", "elementIds", "requestedElementIds"]
  }],
  ["revit_get_parameters", {
    semantic_outputs: ["element.parameter_values"],
    principal_target_fields: ["id", "elementId", "elementIds", "requestedElementIds"]
  }],
  ["/revit/verify-parameter-on-sheet", {
    semantic_outputs: ["element.parameter_values", "sheet.identity"],
    principal_target_fields: ["sheetViewId", "sheetId", "elementId"]
  }],
  ["/revit/set-parameter", {
    semantic_outputs: [],
    principal_target_fields: ["elementId", "elementIds", "affectedElementIds", "updatedElementIds"]
  }],
  ["/revit/set-parameters", {
    semantic_outputs: [],
    principal_target_fields: ["elementId", "elementIds", "affectedElementIds", "updatedElementIds"]
  }],
  ["revit_set_parameters", {
    semantic_outputs: [],
    principal_target_fields: ["elementId", "elementIds", "affectedElementIds", "updatedElementIds"]
  }],
  ["/revit/set-type-parameters", {
    semantic_outputs: [],
    principal_target_fields: ["typeId", "typeIds", "affectedElementIds", "updatedElementIds"]
  }],
  ["revit_set_type_parameters", {
    semantic_outputs: [],
    principal_target_fields: ["typeId", "typeIds", "affectedElementIds", "updatedElementIds"]
  }],
  ["/revit/update-panel-parameter", {
    semantic_outputs: [],
    principal_target_fields: ["panelId", "elementId", "affectedElementIds", "updatedElementIds"]
  }],
  ["/revit/update-parameter-by-query", {
    semantic_outputs: [],
    principal_target_fields: ["elementId", "elementIds", "affectedElementIds", "updatedElementIds"]
  }],
  ["/revit/replace-text-note", {
    semantic_outputs: [],
    principal_target_fields: ["elementId", "elementIds", "affectedElementIds", "updatedElementIds"],
    contextual_scope_fields: ["viewId", "ownerViewId"]
  }],
  ["revit_replace_text_note", {
    semantic_outputs: [],
    principal_target_fields: ["elementId", "elementIds", "affectedElementIds", "updatedElementIds"],
    contextual_scope_fields: ["viewId", "ownerViewId"]
  }],
  ["/revit/set-text-note-text", {
    semantic_outputs: [],
    principal_target_fields: ["elementId", "elementIds", "affectedElementIds", "updatedElementIds"],
    contextual_scope_fields: ["viewId", "ownerViewId"]
  }]
]);

function normalizedText(value: unknown): string {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

function pathOf(value: OperationContract): string {
  // Typed MCP operations carry the alias in capability_id and do not persist a
  // duplicate path/tool field. Treat that alias as the reviewed contract key
  // so typed and generic compositions make the same admission decision.
  return normalizedText(value.path ?? value.tool ?? value.capability_id);
}

function normalizedField(value: string): string {
  return value.replace(/[^a-z0-9]/gi, "").toLowerCase();
}

function tokensFromReviewedFields(value: unknown, fields: readonly string[]): readonly string[] {
  const admitted = new Map(fields.map((field) => [normalizedField(field), normalizedField(field)]));
  const tokens = new Set<string>();
  const visit = (node: unknown, key = "", depth = 0): void => {
    if (depth > 10 || tokens.size >= 128 || node === null || node === undefined) return;
    if (typeof node === "string" && /^[\[{]/.test(node.trim())) {
      try { visit(JSON.parse(node), key, depth + 1); return; } catch {}
    }
    if (Array.isArray(node)) {
      for (const item of node) visit(item, key, depth + 1);
      return;
    }
    if (typeof node === "object") {
      for (const [childKey, child] of Object.entries(node as Record<string, unknown>)) {
        if (isExcludedEvidenceContainerV2(childKey)) continue;
        visit(child, childKey, depth + 1);
      }
      return;
    }
    const field = admitted.get(normalizedField(key));
    if (!field) return;
    const scalar = String(node).trim().toLowerCase();
    if (!scalar || scalar.length > 260 || /[\u0000-\u001f\u007f]/.test(scalar)) return;
    tokens.add(`${field}:${scalar}`);
    if (/^-?\d+$/.test(scalar)) tokens.add(`id:${scalar}`);
  };
  visit(value);
  return [...tokens].sort();
}

/**
 * Extract the principal affected identity using the same reviewed capability
 * contract that admits the verification result. Unknown routes retain the
 * bounded legacy fallback; known routes fail closed instead of treating a
 * scope/filter ID as the affected subject.
 */
export function operationTargetSelectorV2(input: Readonly<{
  operation: OperationContract;
  value: unknown;
  fallback_target_tokens?: readonly string[];
}>): OperationTargetSelectorV2 {
  const contract = REVIT_ROUTE_CONTRACTS.get(pathOf(input.operation));
  if (!contract) {
    return {
      schema: OPERATION_TARGET_SELECTOR_V2_SCHEMA,
      source: "legacy_generic_fallback",
      principal_target_tokens: [...new Set(input.fallback_target_tokens ?? [])].sort(),
      contextual_scope_tokens: []
    };
  }
  return {
    schema: OPERATION_TARGET_SELECTOR_V2_SCHEMA,
    source: "reviewed_capability_contract",
    principal_target_tokens: tokensFromReviewedFields(input.value, contract.principal_target_fields ?? []),
    contextual_scope_tokens: tokensFromReviewedFields(input.value, contract.contextual_scope_fields ?? [])
  };
}

function requiredSemanticOutputs(apply: OperationContract): readonly string[] {
  const path = pathOf(apply);
  if (TEXT_NOTE_MUTATION_PATHS.has(path)) return ["text_note.value"];
  if (PARAMETER_MUTATION_PATHS.has(path)) return ["element.parameter_values"];
  return [];
}

function providedSemanticOutputs(verification: OperationContract): readonly string[] {
  const contract = REVIT_ROUTE_CONTRACTS.get(pathOf(verification));
  if (!contract) return [];
  if (normalizedText(verification.capability_id) !== "revit_call_tool"
      && pathOf(verification).startsWith("/revit/")) return [];
  return contract.semantic_outputs;
}

function routesProviding(required: readonly string[]): readonly string[] {
  if (required.length === 0) return [];
  return [...REVIT_ROUTE_CONTRACTS.entries()]
    .filter(([, contract]) => required.every((semanticOutput) => contract.semantic_outputs.includes(semanticOutput)))
    .map(([path]) => path)
    .sort();
}

export function verificationCapabilityAdmissionV2(input: Readonly<{
  apply: OperationContract;
  verification: OperationContract;
}>): VerificationCapabilityAdmissionV2 {
  const required = requiredSemanticOutputs(input.apply);
  const provided = providedSemanticOutputs(input.verification);
  const admissibleReadbackPaths = routesProviding(required);
  if (required.length === 0) {
    return {
      schema: VERIFICATION_CAPABILITY_ADMISSION_V2_SCHEMA,
      admissible: true,
      reason: "no_reviewed_semantic_output_constraint",
      required_semantic_outputs: [],
      provided_semantic_outputs: provided,
      admissible_readback_paths: []
    };
  }
  const missing = required.filter((semanticOutput) => !provided.includes(semanticOutput));
  return {
    schema: VERIFICATION_CAPABILITY_ADMISSION_V2_SCHEMA,
    admissible: missing.length === 0,
    reason: missing.includes("text_note.value") ? "text_note_value_unavailable" : "required_semantic_output_unavailable",
    required_semantic_outputs: required,
    provided_semantic_outputs: provided,
    admissible_readback_paths: admissibleReadbackPaths
  };
}

export function verificationCapabilityAdmissionForPathsV2(
  applyPath: string,
  verificationPath: string
): VerificationCapabilityAdmissionV2 {
  const contract = (path: string): OperationContract => path.startsWith("/")
    ? { capability_id: "revit_call_tool", path }
    : { capability_id: path, tool: path };
  return verificationCapabilityAdmissionV2({ apply: contract(applyPath), verification: contract(verificationPath) });
}

export function verificationCapabilityGuidanceV2(apply: OperationContract): string | null {
  const required = requiredSemanticOutputs(apply);
  if (required.length === 0) return null;
  const paths = routesProviding(required);
  const target = normalizedText(apply.target_id);
  const numericTarget = target.match(/^id:(\d+)$/)?.[1];
  const selectors = paths.flatMap((path) => {
    const contract = REVIT_ROUTE_CONTRACTS.get(path);
    return contract?.preferred_target_field ? [`${path}.${contract.preferred_target_field}`] : [];
  });
  const exactSelector = numericTarget && selectors.length > 0
    ? ` Bind the exact affected subject with ${selectors.join(" or ")}=${numericTarget}; contextual scope fields such as viewId do not establish affected-target identity.`
    : "";
  return ` Required semantic outputs: ${required.join(", ")}. Reviewed readback routes: ${paths.join(", ")}.${exactSelector}`;
}
