import { assignmentKernelV2ForBinding } from "./assignment_kernel_v2_factory.js";
import { appendCurrentAssignmentKernelEventV2 } from "./assignment_kernel_v2_store.js";
import type { AssignmentKernelBindingInputV2 } from "./assignment_kernel_v2_lifecycle.js";
import { assignmentProgressBudgetBlockerV2 } from "../domain/assignment-kernel/progress/controller.js";
import { defaultAssignmentWorkBudgetV2 } from "./assignment_work_allowance_v2.js";
import { DEFAULT_ASSIGNMENT_PROGRESS_BUDGET_V2 } from "./assignment_kernel_v2_progress.js";
import { assignmentKernelTerminalSettlementDeferredV2 } from "./assignment_kernel_v2_terminal_barrier.js";

/** Execution permission is durable and separate from evidence-derived outcome.
 * Resume retains the same run/generation, observations, operations, and budgets.
 * A command identity and prior-control fence make retries harmless and prevent
 * a delayed Resume from undoing a newer Pause.
 */
export function controlAssignmentExecutionV2(input: {
  binding: AssignmentKernelBindingInputV2;
  command_id: string;
  expected_command_id: string | null;
  action: "pause" | "resume";
  expected_hold_id?: string | null;
  expected_assignment_version?: number;
}) {
  const resolved = assignmentKernelV2ForBinding(input.binding);
  if (!resolved) throw new Error("assignment_kernel_v2_binding_stale_or_mismatched");
  if (typeof input.command_id !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/.test(input.command_id)) throw new Error("assignment_control_identity_invalid");
  if (input.action !== "pause" && input.action !== "resume") throw new Error("assignment_control_action_invalid");
  if (input.expected_command_id !== null && typeof input.expected_command_id !== "string") throw new Error("assignment_control_fence_required");
  if (input.action === "resume" && resolved.snapshot.provider_usage_hold
      && resolved.snapshot.execution_control?.command_id !== input.command_id) {
    if (assignmentKernelTerminalSettlementDeferredV2(resolved.binding)) throw new Error("provider_usage_resume_receipts_pending");
    const exhausted = assignmentProgressBudgetBlockerV2(resolved.snapshot,
      defaultAssignmentWorkBudgetV2(resolved.snapshot, DEFAULT_ASSIGNMENT_PROGRESS_BUDGET_V2), new Date().toISOString());
    if (exhausted) throw new Error("provider_usage_resume_current_budget_exhausted");
  }
  return appendCurrentAssignmentKernelEventV2({
    goal_id: resolved.goal.id,
    binding: resolved.binding,
    event_id: `execution-control:${input.command_id}`,
    actor: "authenticated-user",
    body: { event_type: "execution_control_requested", command_id: input.command_id,
      action: input.action, expected_command_id: input.expected_command_id,
      ...(input.expected_hold_id !== undefined ? { expected_hold_id: input.expected_hold_id } : {}),
      ...(input.expected_assignment_version !== undefined ? { expected_assignment_version: input.expected_assignment_version } : {}) }
  }).snapshot;
}
