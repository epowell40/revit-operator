import { randomUUID } from "node:crypto";
import { boundedWorkPlanPage, projectWorkPlan } from "./work_plan_projection.js";
import { assignmentKernelV2ForBinding } from "./assignment_kernel_v2_factory.js";
import { appendCurrentAssignmentKernelEventV2 } from "./assignment_kernel_v2_store.js";
import { deriveAndSettleAssignmentKernelV2, type AssignmentKernelBindingInputV2 } from "./assignment_kernel_v2_lifecycle.js";
import type { WorkPlanDeclarationV2 } from "../domain/assignment-kernel/work_plan.js";
import { appliedOperationHasVerifiedPostconditionV2 } from "../domain/assignment-kernel/outcome.js";

export function manageAssignmentWorkPlan(input: { binding: AssignmentKernelBindingInputV2; action: string;
  declaration?: WorkPlanDeclarationV2; item_id?: string; operation_ids?: readonly string[]; start?: number; operation_start?: number; assumption_start?: number }) {
  const resolved = assignmentKernelV2ForBinding(input.binding);
  if (!resolved || resolved.snapshot.terminal) throw new Error("work_plan_binding_stale_or_terminal");
  if (resolved.snapshot.execution_control?.state === "paused" && input.action !== "status") throw new Error("assignment_execution_paused");
  let snapshot = resolved.snapshot;
  for (const offset of [input.start, input.operation_start, input.assumption_start])
    if (offset !== undefined && (!Number.isSafeInteger(offset) || offset < 0 || offset > 100_000)) throw new Error("work_plan_page_invalid");
  if (input.action === "declare" || input.action === "complete") {
    appendCurrentAssignmentKernelEventV2({ goal_id: input.binding.assignment_id,
      binding: snapshot.current_binding, event_id: `work-plan:${randomUUID()}`, actor: "operator-work-plan",
      body: input.action === "declare" ? { event_type: "work_plan_declared", declaration: input.declaration! }
        : { event_type: "work_plan_item_completed", item_id: input.item_id!, operation_ids: input.operation_ids! } });
    snapshot = deriveAndSettleAssignmentKernelV2(input.binding, "Declared multi-part task scope updated.");
  } else if (input.action !== "status") throw new Error("work_plan_action_invalid");
  return { ok: true, outcome: snapshot.outcome, work_plan_required: snapshot.spec.work_plan_required === true,
    work_plan: projectWorkPlan(snapshot.work_plan, input.start, input.assumption_start),
    interpretation_notice: "Scope descriptions and source basis are assistant interpretations. Item completion binds distinct independently verified operations; it is not independent certification of drawing coverage.",
    available_verified_operations: boundedWorkPlanPage(Object.values(snapshot.operations).filter(op => op.requested_effect === "apply"
      && op.persistent_effect === "applied" && appliedOperationHasVerifiedPostconditionV2(snapshot, op.operation_id))
      .reverse().map(op => ({ operation_id: op.operation_id, path: op.request_identity?.path, opened_at: op.opened_at,
        completed_item_id: snapshot.work_plan?.items.find(item => item.operation_ids.includes(op.operation_id))?.item_id ?? null })), input.operation_start ?? 0, 1500) };
}
