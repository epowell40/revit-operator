import { assignmentKernelV2ForBinding } from "./assignment_kernel_v2_factory.js";
import { settleAssignmentKernelExecutionFailureV2 } from "./assignment_kernel_v2_execution_failure.js";

/** Authenticated session boundary only: records execution loss, never model success
 * or desktop readiness. Native in-flight/unknown effects retain their own fences. */
export function recordSidecarExecutionFailureV2(sessionId: string, input: unknown) {
  const row = input && typeof input === "object" && !Array.isArray(input)
    ? input as Record<string, unknown> : {};
  if (typeof row.assignment_id !== "string" || typeof row.assignment_run_id !== "string"
    || !Number.isSafeInteger(row.assignment_generation)
    || typeof row.failure_id !== "string" || !/^[A-Za-z0-9:._-]{1,240}$/.test(row.failure_id)
    || (row.failure_kind !== "canceled" && row.failure_kind !== "runtime")) {
    throw new Error("sidecar_execution_failure_request_invalid");
  }
  const resolved = assignmentKernelV2ForBinding({session_id:sessionId,
    assignment_id:row.assignment_id, run_id:row.assignment_run_id,
    generation:row.assignment_generation as number});
  if (!resolved || resolved.goal.related_session_id !== sessionId
    || resolved.goal.work_budget?.mode !== "sidecar_computer"
    || resolved.goal.work_budget?.source !== "operator_desktop") {
    throw new Error("sidecar_execution_failure_binding_mismatch");
  }
  return settleAssignmentKernelExecutionFailureV2({binding:resolved.binding,
    failure_id:row.failure_id, error_class:row.failure_kind, phase:"provider_turn"});
}
