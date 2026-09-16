import type { AssignmentInputVariableV2 } from "./assignment_spec.js";
import type { AssignmentSnapshotV2 } from "./snapshot.js";
import { kernelAssertV2 } from "./errors.js";
import { canonicalJsonV2 } from "./canonical.js";

/** A discovered required input extends the journal, never the original request or authority. */
export interface DiscoveredAssignmentInputV2 {
  variable: AssignmentInputVariableV2;
  dependent_work_unit_ids: readonly string[];
}

export function assignmentInputVariablesV2(snapshot: AssignmentSnapshotV2): readonly AssignmentInputVariableV2[] {
  return [...snapshot.spec.input_variables, ...Object.values(snapshot.discovered_inputs ?? {}).map(item => item.variable)];
}

export function workUnitInputVariableIdsV2(snapshot: AssignmentSnapshotV2, workUnitId: string): readonly string[] {
  const original = snapshot.spec.work_units.find(unit => unit.work_unit_id === workUnitId)?.input_variable_ids ?? [];
  return [...new Set([...original, ...Object.values(snapshot.discovered_inputs ?? {})
    .filter(item => item.dependent_work_unit_ids.includes(workUnitId)).map(item => item.variable.variable_id)])];
}

export function discoveredInputDependenciesV2(snapshot: AssignmentSnapshotV2): readonly string[] {
  return snapshot.spec.work_units.filter(unit => unit.independently_useful || unit.requested_effect !== "read")
    .map(unit => unit.work_unit_id).sort();
}

export function validDiscoveredInputIdV2(value: unknown): value is string {
  if (typeof value !== "string" || !/^[a-z][a-z0-9_]{0,159}$/.test(value)) return false;
  return !["assignmentid", "runid", "generation", "sessionid", "principalid", "documentfingerprint", "constructor", "prototype", "proto"]
    .includes(value.replace(/_/g, ""));
}

export function appendDiscoveredInputV2(snapshot: AssignmentSnapshotV2, declaration: DiscoveredAssignmentInputV2): AssignmentSnapshotV2 {
  const variable = declaration?.variable;
  kernelAssertV2(variable && validDiscoveredInputIdV2(variable.variable_id), "input_declaration_id_invalid", "Discovered input needs a bounded, non-reserved stable identifier.");
  kernelAssertV2(variable.required === true && variable.sensitive === false && variable.value_state === "needs_input"
    && canonicalJsonV2(Object.keys(variable).sort()) === canonicalJsonV2(["required", "sensitive", "value_state", "variable_id"]),
  "input_declaration_value_forbidden", "A discovered question cannot supply its own answer or change task authority.");
  const normalize = (value: string) => value.normalize("NFKC").replace(/[\s_-]+/g, "").toLowerCase();
  kernelAssertV2(!assignmentInputVariablesV2(snapshot).some(candidate => normalize(candidate.variable_id) === normalize(variable.variable_id)),
    "input_declaration_conflict", "A discovered input cannot replace or alias an existing variable.");
  kernelAssertV2(Object.keys(snapshot.discovered_inputs ?? {}).length < 64, "input_declaration_limit", "This assignment has reached its discovered-question limit.");
  const dependencies = discoveredInputDependenciesV2(snapshot);
  kernelAssertV2(dependencies.length > 0 && canonicalJsonV2(declaration.dependent_work_unit_ids) === canonicalJsonV2(dependencies),
    "input_declaration_dependencies_invalid", "The host binds discovered inputs to the existing task work units.");
  return { ...snapshot, discovered_inputs: { ...snapshot.discovered_inputs, [variable.variable_id]: structuredClone(declaration) } };
}
