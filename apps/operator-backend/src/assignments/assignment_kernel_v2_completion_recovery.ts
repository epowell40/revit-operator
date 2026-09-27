import { completionOutboxKeyV2, readCompletionOutboxV2 } from "@revitoperator/assignment-kernel-v2-contracts/completion-outbox";
import { assignmentKernelV2ForBinding } from "./assignment_kernel_v2_factory.js";
import { commitAssignmentKernelObservationV2, leaseFromOperation, settleAssignmentKernelOperationV2 } from "./assignment_kernel_v2_execution.js";
import type { AssignmentKernelBindingInputV2 } from "./assignment_kernel_v2_lifecycle.js";
import { getWorkspaceRoot } from "../workspace.js";
import { completionRecoveryOrderV2 } from "./assignment_kernel_v2_recovery_order.js";
import { recoverLateNativeCompletionV1, type NativeCompletionLookupV1 } from "./assignment_kernel_v2_native_completion.js";

/** Recover only already-retained completions. Safe while a late original
 * response is arriving: settlement uses the original result/event identities.
 * This command cannot dispatch tools, resume a provider, resolve unknown effects
 * without authority, change task binding, or grant permission for more work.
 */
export function recoverRetainedAssignmentCompletionsV2(binding: AssignmentKernelBindingInputV2) {
  const resolved = assignmentKernelV2ForBinding(binding);
  if (!resolved) throw new Error("assignment_kernel_v2_binding_stale_or_mismatched");
  let snapshot = resolved.snapshot;
  const recovered: string[] = [];
  if (!snapshot.terminal && snapshot.in_flight_operation_ids.length > 0) {
    const workspace = getWorkspaceRoot();
    const key = completionOutboxKeyV2(workspace);
    for (const id of completionRecoveryOrderV2(snapshot)) {
      const operation = snapshot.operations[id]!;
      if (Object.values(snapshot.operations).some(child => child.parent_operation_id === id
        && child.blocks_parent_settlement !== false && child.settlement_state !== "settled")) continue;
      const lease = leaseFromOperation(operation);
      if (operation.settlement_state === "retaining_observation" && operation.observation_commit) {
        snapshot = commitAssignmentKernelObservationV2(lease).snapshot;
        recovered.push(id);
        continue;
      }
      if (operation.result) continue;
      const envelope = readCompletionOutboxV2(workspace, key, lease);
      if (!envelope) continue;
      snapshot = settleAssignmentKernelOperationV2(lease, envelope).snapshot;
      recovered.push(id);
    }
  }
  return { snapshot, recovered_operation_ids: recovered,
    unresolved_operation_ids: [...new Set([...snapshot.in_flight_operation_ids, ...snapshot.unresolved_unknown_operation_ids])] };
}

/** Authenticated command path; old retained-result recovery remains synchronous
 * for existing callers. No dispatch, provider start or permission grant occurs. */
export async function recoverAssignmentCompletionsV2(binding: AssignmentKernelBindingInputV2, lookup?: NativeCompletionLookupV1) {
  const recovered = recoverRetainedAssignmentCompletionsV2(binding);
  let snapshot = recovered.snapshot;
  if (!snapshot.terminal && snapshot.unresolved_unknown_operation_ids.length > 0) {
    const workspace = getWorkspaceRoot(), key = completionOutboxKeyV2(workspace);
    for (const id of snapshot.unresolved_unknown_operation_ids) {
      const next = await recoverLateNativeCompletionV1(workspace, key, snapshot, snapshot.operations[id]!, lookup);
      if (next) { snapshot = next; recovered.recovered_operation_ids.push(id); }
    }
  }
  return { snapshot, recovered_operation_ids: recovered.recovered_operation_ids,
    unresolved_operation_ids: [...new Set([...snapshot.in_flight_operation_ids, ...snapshot.unresolved_unknown_operation_ids])] };
}
