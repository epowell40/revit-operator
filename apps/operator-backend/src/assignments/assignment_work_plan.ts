import { projectAdvisoryFollowupsV2 } from "./advisory_followups_projection.js";
import type { AdvisoryFollowupDispositionV2 } from "../domain/assignment-kernel/advisory_followups.js";
import { advisoryVerificationV2, validAdvisoryProposalV1, type AdvisoryCompletionProposalV1 } from "../domain/assignment-kernel/execution_policy.js";
import { assignmentWorkAllowanceV2 } from "./assignment_work_allowance_v2.js";
import { retainWorkPlanInspectionV2 } from "./work_plan_inspection.js";
import { randomUUID } from "node:crypto";
import { boundedWorkPlanPage, projectWorkPlan } from "./work_plan_projection.js";
import { assignmentKernelV2ForBinding } from "./assignment_kernel_v2_factory.js";
import { appendCurrentAssignmentKernelEventV2 } from "./assignment_kernel_v2_store.js";
import { deriveAndSettleAssignmentKernelV2, type AssignmentKernelBindingInputV2 } from "./assignment_kernel_v2_lifecycle.js";
import { evaluatePendingAssignmentCriteriaV2 } from "./assignment_kernel_v2_progress.js";
import { workPlanPendingV2, type WorkPlanDeclarationV2 } from "../domain/assignment-kernel/work_plan.js";
import { appliedOperationHasVerifiedPostconditionV2 } from "../domain/assignment-kernel/outcome.js";

export function manageAssignmentWorkPlan(input: { binding: AssignmentKernelBindingInputV2; action: string;
  followup?: AdvisoryFollowupDispositionV2; followup_start?: number;
  completion_proposal?: AdvisoryCompletionProposalV1; declaration?: WorkPlanDeclarationV2; item_id?: string; operation_ids?: readonly string[]; start?: number; operation_start?: number; assumption_start?: number }) {
  const resolved = assignmentKernelV2ForBinding(input.binding);
  if (!resolved || resolved.snapshot.terminal) throw new Error("work_plan_binding_stale_or_terminal");
  if (resolved.snapshot.execution_control?.state === "paused" && input.action !== "status" && input.action !== "update_followup") throw new Error("assignment_execution_paused");
  let snapshot = resolved.snapshot;
  if (snapshot.completion_proposal && input.action !== "status" && input.action !== "update_followup") throw new Error("assignment_completion_proposal_pending");
  if (input.action !== "update_followup" && input.followup) throw new Error("advisory_followup_arguments_invalid");
  if (input.followup_start !== undefined && (!Number.isSafeInteger(input.followup_start) || input.followup_start < 0)) throw new Error("advisory_followup_page_invalid");
  for (const offset of [input.start, input.operation_start, input.assumption_start])
    if (offset !== undefined && (!Number.isSafeInteger(offset) || offset < 0 || offset > 100_000)) throw new Error("work_plan_page_invalid");
  if (input.action === "update_followup") {
    if (!input.followup || input.completion_proposal || input.declaration || input.item_id || input.operation_ids)
      throw new Error("advisory_followup_arguments_invalid");
    // The locked reducer validates new commands; the store recognizes exact retries first.
    snapshot = appendCurrentAssignmentKernelEventV2({ goal_id: input.binding.assignment_id,
      binding: snapshot.current_binding, event_id: "advisory-followup:" + input.followup.command_id, actor: "operator-work-plan",
      body: { event_type: "advisory_followup_disposition_recorded", disposition: input.followup } }).snapshot;
  } else if (input.action === "propose_completion") {
    if (!advisoryVerificationV2(snapshot)) throw new Error("advisory_proposal_not_enabled");
    if (!input.completion_proposal || !validAdvisoryProposalV1(input.completion_proposal)
      || input.declaration || input.item_id || input.operation_ids) throw new Error("advisory_proposal_invalid");
    const proposalIdentity = randomUUID();
    snapshot = appendCurrentAssignmentKernelEventV2({ goal_id: input.binding.assignment_id,
      binding: snapshot.current_binding, event_id: `completion-proposal:${proposalIdentity}`, actor: "operator-work-plan",
      body: { event_type: "review_requested", review_id: `advisory-review:${snapshot.current_binding.assignment_id}:${proposalIdentity}`,
        work_unit_ids: [], reason: "Agent-proposed unverified checkpoint; independent review is required.", completion_proposal: input.completion_proposal } }).snapshot;
    snapshot = deriveAndSettleAssignmentKernelV2(input.binding, "Unverified completion proposal retained for independent review.");
  } else if (input.action === "declare" || input.action === "complete") {
    snapshot = appendCurrentAssignmentKernelEventV2({ goal_id: input.binding.assignment_id,
      binding: snapshot.current_binding, event_id: `work-plan:${randomUUID()}`, actor: "operator-work-plan",
      body: input.action === "declare" ? { event_type: "work_plan_declared", declaration: input.declaration! }
        : advisoryVerificationV2(snapshot) ? { event_type: "work_plan_item_claimed", item_id: input.item_id!, operation_ids: input.operation_ids ?? [] }
        : { event_type: "work_plan_item_completed", item_id: input.item_id!, operation_ids: input.operation_ids!,
          ...(snapshot.work_plan?.items.find(item => item.item_id === input.item_id)?.kind === "inspection"
            ? { inspection: retainWorkPlanInspectionV2(snapshot, input.operation_ids!) } : {}) } }).snapshot;
    if (input.action === "complete" && !workPlanPendingV2(snapshot)) {
      snapshot = evaluatePendingAssignmentCriteriaV2({ binding: snapshot.current_binding });
    }
    if (!snapshot.terminal) snapshot = deriveAndSettleAssignmentKernelV2(input.binding, "Declared multi-part task scope updated.");
  } else if (input.action !== "status") throw new Error("work_plan_action_invalid");
  return { ok: true, outcome: snapshot.outcome, work_plan_required: !advisoryVerificationV2(snapshot) && snapshot.spec.work_plan_required === true,
    ...(advisoryVerificationV2(snapshot) ? { verification_policy: "advisory", completion_proposal: snapshot.completion_proposal ?? null, advisory_followups: projectAdvisoryFollowupsV2(snapshot, input.followup_start), checklist_claims: snapshot.work_plan_claims ?? [],
      notice: "Inspection remains useful. Specialized proof is advisory; submit propose_completion with claimed_completed, remaining_work and uncertainties for independent review. This never certifies completion." } : {}),
    work_allowance: { ...assignmentWorkAllowanceV2(snapshot), used_provider_calls: Object.keys(snapshot.provider_calls).length },
    work_plan: projectWorkPlan(snapshot.work_plan, input.start, input.assumption_start, snapshot),
    interpretation_notice: "Scope descriptions and source basis are assistant interpretations. Item completion binds distinct independently verified operations; it is not independent certification of drawing coverage.",
    available_inspection_operations: boundedWorkPlanPage(Object.values(snapshot.operations).filter(op => op.requested_effect === "read" && op.result?.authority === "native-host" && op.result.status === "succeeded"
      && ["/revit/get-connectors", "/revit/view-owned-detailing"].includes(op.request_identity?.path ?? ""))
      .reverse().map(op => ({ operation_id: op.operation_id, path: op.request_identity?.path, opened_at: op.opened_at })), input.operation_start ?? 0, 1500),
    available_verified_operations: boundedWorkPlanPage(Object.values(snapshot.operations).filter(op => op.requested_effect === "apply"
      && op.persistent_effect === "applied" && appliedOperationHasVerifiedPostconditionV2(snapshot, op.operation_id))
      .reverse().map(op => ({ operation_id: op.operation_id, path: op.request_identity?.path, opened_at: op.opened_at,
        completed_item_id: snapshot.work_plan?.items.find(item => item.operation_ids.includes(op.operation_id))?.item_id ?? null })), input.operation_start ?? 0, 1500) };
}
