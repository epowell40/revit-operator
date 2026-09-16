import { assignmentKernelV2ForBinding } from "./assignment_kernel_v2_factory.js";
import { appendCurrentAssignmentKernelEventV2 } from "./assignment_kernel_v2_store.js";
import type { AssignmentKernelBindingInputV2 } from "./assignment_kernel_v2_lifecycle.js";

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
}) {
  const resolved = assignmentKernelV2ForBinding(input.binding);
  if (!resolved) throw new Error("assignment_kernel_v2_binding_stale_or_mismatched");
  if (typeof input.command_id !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/.test(input.command_id)) throw new Error("assignment_control_identity_invalid");
  if (input.action !== "pause" && input.action !== "resume") throw new Error("assignment_control_action_invalid");
  if (input.expected_command_id !== null && typeof input.expected_command_id !== "string") throw new Error("assignment_control_fence_required");
  return appendCurrentAssignmentKernelEventV2({
    goal_id: resolved.goal.id,
    binding: resolved.binding,
    event_id: `execution-control:${input.command_id}`,
    actor: "authenticated-user",
    body: { event_type: "execution_control_requested", command_id: input.command_id,
      action: input.action, expected_command_id: input.expected_command_id }
  }).snapshot;
}
