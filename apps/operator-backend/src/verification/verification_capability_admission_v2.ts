/**
 * Versioned application contract for post-apply verification capabilities.
 *
 * The Assignment Kernel owns the generic rule that postconditions require
 * target-bound authoritative evidence. This adapter owns Revit-specific
 * knowledge about which reviewed capability result shapes can expose each
 * desired-state semantic output.
 */

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

type OperationContract = Readonly<{
  capability_id?: unknown;
  method?: unknown;
  path?: unknown;
  tool?: unknown;
}>;

const TEXT_NOTE_MUTATION_PATHS = new Set([
  "/revit/replace-text-note",
  "/revit/set-text-note-text"
]);

/** Reviewed semantic outputs of the authoritative native response shapes. */
const REVIT_ROUTE_SEMANTIC_OUTPUTS = new Map<string, readonly string[]>([
  ["/revit/find-text-notes", ["text_note.value"]],
  ["/revit/find-family-text-notes", ["text_note.value"]],
  ["/revit/get-element-summary", ["element.identity", "element.classification", "element.location"]]
]);

function normalizedText(value: unknown): string {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

function pathOf(value: OperationContract): string {
  return normalizedText(value.path ?? value.tool);
}

function requiredSemanticOutputs(apply: OperationContract): readonly string[] {
  return TEXT_NOTE_MUTATION_PATHS.has(pathOf(apply)) ? ["text_note.value"] : [];
}

function providedSemanticOutputs(verification: OperationContract): readonly string[] {
  if (normalizedText(verification.capability_id) !== "revit_call_tool") return [];
  return REVIT_ROUTE_SEMANTIC_OUTPUTS.get(pathOf(verification)) ?? [];
}

function routesProviding(required: readonly string[]): readonly string[] {
  if (required.length === 0) return [];
  return [...REVIT_ROUTE_SEMANTIC_OUTPUTS.entries()]
    .filter(([, outputs]) => required.every((semanticOutput) => outputs.includes(semanticOutput)))
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
  // Named non-generic capabilities retain their own typed adapter contract.
  // Generic Revit routing must use the reviewed native response registry above.
  if (normalizedText(input.verification.capability_id) !== "revit_call_tool") {
    return {
      schema: VERIFICATION_CAPABILITY_ADMISSION_V2_SCHEMA,
      admissible: true,
      reason: "typed_capability_contract",
      required_semantic_outputs: required,
      provided_semantic_outputs: [],
      admissible_readback_paths: admissibleReadbackPaths
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

export function verificationCapabilityGuidanceV2(apply: OperationContract): string | null {
  const required = requiredSemanticOutputs(apply);
  if (required.length === 0) return null;
  const paths = routesProviding(required);
  return ` Required semantic outputs: ${required.join(", ")}. Reviewed readback routes: ${paths.join(", ")}.`;
}
