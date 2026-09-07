import { sameAssignmentBindingV2 } from "./domain/assignment-kernel/identity.js";
import type { OperationV2 } from "./domain/assignment-kernel/operation.js";

/** Only consume a retained canonical operation, never model prose or a nested raw payload. */
export function canonicalNativeRollbackForTeammate(operation: OperationV2 | undefined, sessionId: string, path: string): boolean {
  const result = operation?.result;
  return !!operation && !!result
    && operation.schema === "revit-operator.operation/v2"
    && operation.binding.session_id === sessionId
    && operation.requested_effect === "apply"
    && operation.admission_state === "admitted"
    && operation.dispatch_state === "dispatched"
    && operation.settlement_state === "settled"
    && operation.persistent_effect === "none"
    && operation.request_identity?.path === path
    && result.schema === "revit-operator.operation-result/v2"
    && result.operation_id === operation.operation_id
    && sameAssignmentBindingV2(result.binding, operation.binding)
    && typeof operation.request_identity.request_signature === "string" && operation.request_identity.request_signature.length > 0
    && result.request_identity?.request_signature === operation.request_identity.request_signature
    && result.request_identity?.path === path
    && result.status === "failed_after_dispatch"
    && result.dispatch_state === "dispatched"
    && result.persistent_effect === "none"
    && result.native_transaction_state === "rolled_back"
    && result.authority === "native-host"
    && typeof result.receipt_id === "string" && result.receipt_id.length > 0
    && result.native_correlation_id === result.receipt_id;
}
