import {
  AssignmentKernelErrorV2,
  type AssignmentSpecV2,
  type InputVariableIdV2
} from "../domain/assignment-kernel/index.js";

const TRUSTED_BINDING_FIELDS = new Set([
  "assignmentid", "runid", "generation", "sessionid", "principalid", "documentfingerprint"
]);

function normalizedExternalName(value: string): string {
  return value.normalize("NFKC").replace(/[\s_-]+/g, "").toLowerCase();
}

export interface AssignmentInputAliasRegistryV2 {
  readonly [variableId: InputVariableIdV2]: readonly string[];
}

export function normalizeAssignmentInputsV2(input: Readonly<{
  spec: AssignmentSpecV2;
  external_values: Readonly<Record<string, unknown>>;
  aliases?: AssignmentInputAliasRegistryV2;
}>): Readonly<Record<InputVariableIdV2, unknown>> {
  const lookup = new Map<string, InputVariableIdV2>();
  for (const variable of input.spec.input_variables) {
    for (const name of [variable.variable_id, ...(input.aliases?.[variable.variable_id] ?? [])]) {
      const normalized = normalizedExternalName(name);
      const prior = lookup.get(normalized);
      if (prior && prior !== variable.variable_id) throw new AssignmentKernelErrorV2("input_alias_ambiguous", "External input alias maps to more than one stable variable.");
      lookup.set(normalized, variable.variable_id);
    }
  }

  const output: Record<InputVariableIdV2, unknown> = {};
  for (const [externalName, value] of Object.entries(input.external_values)) {
    const normalized = normalizedExternalName(externalName);
    if (TRUSTED_BINDING_FIELDS.has(normalized)) throw new AssignmentKernelErrorV2("trusted_binding_input_forbidden", "Lifecycle binding is injected by the trusted host, never accepted as task input.");
    const variableId = lookup.get(normalized);
    if (!variableId) throw new AssignmentKernelErrorV2("input_variable_unknown", `External input ${externalName} does not map to AssignmentSpecV2.`);
    if (Object.prototype.hasOwnProperty.call(output, variableId) && canonicalInputValue(output[variableId]) !== canonicalInputValue(value)) {
      throw new AssignmentKernelErrorV2("input_variable_conflict", "Two external fields supplied conflicting values for one stable variable.");
    }
    output[variableId] = structuredClone(value);
  }
  return output;
}

function canonicalInputValue(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalInputValue).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalInputValue(entry)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}
