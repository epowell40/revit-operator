import type { AssignmentSnapshotV2 } from "../snapshot.js";
import type { OperationV2 } from "../operation.js";
import { sameAssignmentBindingV2 } from "../identity.js";

/** A generic MCP call may wrap the native mutation as a child operation.
 * Credit only the attested native rollback and its exact same-binding root. */
export function readyNativeRollbackPreviewV2(snapshot: AssignmentSnapshotV2): OperationV2 | undefined {
  if (snapshot.spec.requested_effect !== "apply"
      || snapshot.work_plan?.items.filter(item => item.kind !== "inspection").length !== 1) return undefined;
  return Object.values(snapshot.operations)
    .filter(op => {
      if (op.requested_effect !== "preview" || op.settlement_state !== "settled"
          || snapshot.input_invalidated_operation_ids?.includes(op.operation_id)
          || !sameAssignmentBindingV2(op.binding, snapshot.current_binding)
          || op.result?.authority !== "native-host" || op.result.status !== "succeeded"
          || op.result.native_transaction_state !== "rolled_back"
          || !sameAssignmentBindingV2(op.result.binding, snapshot.current_binding)) return false;
      if (op.operation_role !== "root") {
        const parentId = op.parent_operation_id;
        const parent = parentId ? snapshot.operations[parentId] : undefined;
        if (op.operation_role !== "child" || !parent || op.root_operation_id !== parentId
            || parent.operation_role !== "root" || parent.capability_id !== "revit_call_tool"
            || parent.requested_effect !== "preview" || parent.settlement_state !== "settled"
            || parent.request_identity?.path !== op.request_identity?.path
            || !sameAssignmentBindingV2(parent.binding, snapshot.current_binding)
            || snapshot.input_invalidated_operation_ids?.includes(parent.operation_id)) return false;
      }
      return op.observation_ids.some(id => {
        const observation = snapshot.observations[id];
        return Boolean(observation && observation.authority === "native-host"
          && observation.operation_id === op.operation_id
          && sameAssignmentBindingV2(observation.binding, snapshot.current_binding)
          && observation.facts.some(fact => fact.fact_id === "control.field.status" && fact.value === "DryRunReady"));
      });
    })
    .sort((a, b) => Date.parse(b.opened_at) - Date.parse(a.opened_at))[0];
}
