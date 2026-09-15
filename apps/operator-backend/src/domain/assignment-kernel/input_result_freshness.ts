import { workUnitInputVariableIdsV2 } from "./input_registry.js";
import type { AssignmentSnapshotV2 } from "./snapshot.js";
import type { OperationV2 } from "./operation.js";

/** Retain completed work as evidence, but require dependent deliverables to be
 * refreshed after an authenticated answer. Independent work remains eligible. */
export function invalidateDependentInputResultsV2(snapshot: AssignmentSnapshotV2, variableId: string): AssignmentSnapshotV2 {
  const units = snapshot.spec.work_units.filter(unit => workUnitInputVariableIdsV2(snapshot, unit.work_unit_id).includes(variableId));
  if (!units.length) return snapshot;
  const unitIds = new Set(units.map(unit => unit.work_unit_id));
  const criterionIds = new Set(units.flatMap(unit => unit.criterion_ids));
  const stale = new Set(snapshot.input_invalidated_operation_ids ?? []);
  for (const operation of Object.values(snapshot.operations)) if (unitIds.has(operation.work_unit_id)) stale.add(operation.operation_id);
  const criteria = { ...snapshot.criteria }, versions = { ...snapshot.criterion_evaluation_versions };
  const states = { ...snapshot.work_unit_states };
  for (const id of criterionIds) { delete criteria[id]; delete versions[id]; }
  for (const id of unitIds) states[id] = "pending";
  const { result_delivery: _previousDelivery, ...retained } = snapshot;
  return { ...retained, criteria, criterion_evaluation_versions: versions, work_unit_states: states,
    input_invalidated_operation_ids: [...stale].sort() };
}

export function operationUsesCurrentInputsV2(snapshot: AssignmentSnapshotV2, operation: OperationV2): boolean {
  const stale = snapshot.input_invalidated_operation_ids ?? [];
  return !stale.includes(operation.operation_id)
    && (!operation.verification_of_operation_id || !stale.includes(operation.verification_of_operation_id));
}
