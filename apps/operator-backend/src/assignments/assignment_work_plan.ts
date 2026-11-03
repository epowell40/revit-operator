import { projectAdvisoryFollowupsV2 } from "./advisory_followups_projection.js";
import { projectExecutionContinuation } from './execution_continuation.js';
import { readImageInputDelivery } from '../desktop_image_delivery.js';
import { projectWorkPlanScopeChecksV1, selectWorkPlanScopeReadIdsV1 } from './work_plan_scope_check.js';
import { validWorkPlanScopeV1, type WorkPlanScopeV1 } from '../domain/assignment-kernel/work_plan_scope.js';
import { compactWorkReviewV2 } from './work_review_handoff.js';
import type { WorkPlanLocationHintV2 } from '../domain/assignment-kernel/work_plan_location.js';
import type { AdvisoryFollowupDispositionV2 } from "../domain/assignment-kernel/advisory_followups.js";
import { advisoryVerificationV2, validAdvisoryProposalV1, type AdvisoryCompletionProposalV1 } from "../domain/assignment-kernel/execution_policy.js";
import { assignmentWorkAllowanceV2, assignmentWorkBudgetStatusV2 } from "./assignment_work_allowance_v2.js";
import { retainWorkPlanInspectionV2 } from "./work_plan_inspection.js";
import { WORK_PLAN_INSPECTION_PATHS, WORK_PLAN_INSPECTION_GUIDANCE } from "./native_inspection_coverage.js";
import { randomUUID } from "node:crypto";
import { boundedWorkPlanPage, projectWorkPlan } from "./work_plan_projection.js";
import { assignmentKernelV2ForBinding } from "./assignment_kernel_v2_factory.js";
import { appendCurrentAssignmentKernelEventV2 } from "./assignment_kernel_v2_store.js";
import { deriveAndSettleAssignmentKernelV2, type AssignmentKernelBindingInputV2 } from "./assignment_kernel_v2_lifecycle.js";
import { evaluatePendingAssignmentCriteriaV2, DEFAULT_ASSIGNMENT_PROGRESS_BUDGET_V2 } from "./assignment_kernel_v2_progress.js";
import { workPlanPendingV2, type WorkPlanDeclarationV2 } from "../domain/assignment-kernel/work_plan.js";
import { appliedOperationHasVerifiedPostconditionV2 } from "../domain/assignment-kernel/outcome.js";
import { verifiedSavedPartialV2 } from "../domain/assignment-kernel/verified_saved_partial.js";
import type { AssignmentSnapshotV2 } from '../domain/assignment-kernel/snapshot.js';

/** Optional optimistic concurrency fence for a host command prepared from an
 * earlier publication. No new completion semantics or evidence admission. */
export function assertWorkPlanCommandVersion(snapshot: AssignmentSnapshotV2, action: string, expected?: number) {
  if (expected === undefined) return;
  if (action !== 'complete' || !Number.isSafeInteger(expected) || expected < 1) throw Error('work_plan_expected_version_invalid');
  if (snapshot.assignment_version !== expected) throw Error('work_plan_version_changed');
  if (!snapshot.quiescent || snapshot.provider_usage_hold || snapshot.in_flight_provider_call_ids.length
      || snapshot.unresolved_unknown_operation_ids.length || snapshot.in_flight_operation_ids.length)
    throw Error('work_plan_versioned_command_not_quiescent');
}

export function manageAssignmentWorkPlan(input: { binding: AssignmentKernelBindingInputV2; action: string;
  expected_assignment_version?: number;
  scope_check?: WorkPlanScopeV1;
  reason?: string;
  location_hint?: WorkPlanLocationHintV2;
  followup?: AdvisoryFollowupDispositionV2; followup_start?: number;
  completion_proposal?: AdvisoryCompletionProposalV1; declaration?: WorkPlanDeclarationV2; item_id?: string; operation_ids?: readonly string[]; start?: number; operation_start?: number; assumption_start?: number }) {
  const resolved = assignmentKernelV2ForBinding(input.binding);
  if (!resolved || resolved.snapshot.terminal) throw new Error("work_plan_binding_stale_or_terminal");
  if (resolved.snapshot.execution_control?.state === "paused" && input.action !== "status" && input.action !== "update_followup") throw new Error("assignment_execution_paused");
  let snapshot = resolved.snapshot;
  assertWorkPlanCommandVersion(snapshot, input.action, input.expected_assignment_version);
  if(input.action!=='check_scope'&&input.scope_check!==undefined)throw Error('work_plan_scope_arguments_invalid');
  if(input.action!=='locate' && input.location_hint!==undefined) throw new Error('work_plan_location_arguments_invalid');
  if (snapshot.completion_proposal && input.action !== "status" && input.action !== "update_followup") throw new Error("assignment_completion_proposal_pending");
  if (input.action !== "update_followup" && input.followup) throw new Error("advisory_followup_arguments_invalid");
  if (input.followup_start !== undefined && (!Number.isSafeInteger(input.followup_start) || input.followup_start < 0)) throw new Error("advisory_followup_page_invalid");
  for (const offset of [input.start, input.operation_start, input.assumption_start])
    if (offset !== undefined && (!Number.isSafeInteger(offset) || offset < 0 || offset > 100_000)) throw new Error("work_plan_page_invalid");
  if (input.action !== "defer" && input.action !== "resume_item" && input.reason !== undefined) throw new Error("work_plan_deferral_arguments_invalid: reason is only for defer/resume_item; complete uses an existing item_id and retained operation_ids. Omit operation_ids only for an unverified advisory claim, not strict completion.");
  if(input.action==='complete'&&!advisoryVerificationV2(snapshot)&&!input.operation_ids?.length)
    throw new Error('work_plan_completion_references_required: strict completion requires distinct independently verified native operations; already-correct advisory claims cannot certify strict work.');
  if(input.action==='check_scope') {
    if(!input.item_id)throw Error('work_plan_scope_item_required: use an existing checklist itemId from status');
    if(!validWorkPlanScopeV1(input.scope_check)||(input.operation_ids!==undefined&&!input.operation_ids.length)
      ||input.declaration||input.completion_proposal||input.followup||input.reason||input.location_hint)throw Error('work_plan_scope_arguments_invalid');
    const selected=input.operation_ids===undefined;
    const operationIds=input.operation_ids??selectWorkPlanScopeReadIdsV1(snapshot,input.scope_check);
    // Retain a valid request even when evidence cannot establish its result.
    // The projection returns available:false and the reason without completing
    // a checklist item. This lets the actor and user inspect/recover the attempt.
    snapshot=appendCurrentAssignmentKernelEventV2({goal_id:input.binding.assignment_id,binding:snapshot.current_binding,
      event_id:`work-plan-scope:${randomUUID()}`,actor:'operator-work-plan',body:{event_type:'work_plan_scope_requested',
        item_id:input.item_id,scope:input.scope_check,operation_ids:operationIds,
        ...(selected?{read_selection:'current_native_reads_v1' as const}:{})}}).snapshot;
  } else if(input.action==='locate') {
    if(!input.item_id || !input.location_hint || input.reason || input.operation_ids || input.declaration || input.completion_proposal || input.followup)
      throw new Error('work_plan_location_arguments_invalid');
    if(input.location_hint.drafting?.stage==='checked'){
      const d=input.location_hint.drafting;
      for(const hash of [d.source_image_sha256,d.model_image_sha256]){
        if(!hash)throw Error('drafting_check_images_required');
        const delivery=readImageInputDelivery(snapshot.current_binding,hash);
        if(hash===d.model_image_sha256){
          const lastEdit=Math.max(0,...Object.values(snapshot.operations).filter(o=>o.requested_effect==='apply'&&o.persistent_effect!=='none')
            .map(o=>Date.parse(o.result?.completed_at??o.opened_at)));
          if(!Number.isFinite(Date.parse(delivery.started_at))||Date.parse(delivery.started_at)<=lastEdit)
            throw Error('drafting_model_image_predates_edit: refresh the corresponding model region before recording the backcheck; keep drafted work.');
        }
      }
    }
    snapshot=appendCurrentAssignmentKernelEventV2({goal_id:input.binding.assignment_id,binding:snapshot.current_binding,
      event_id:`work-plan-location:${randomUUID()}`,actor:'operator-work-plan',body:{event_type:'work_plan_location_recorded',item_id:input.item_id,location_hint:input.location_hint}}).snapshot;
  } else if (input.action === "defer" || input.action === "resume_item") {
    if (!input.item_id || !input.reason || input.operation_ids || input.declaration || input.completion_proposal || input.followup) throw new Error("work_plan_deferral_arguments_invalid");
    snapshot=appendCurrentAssignmentKernelEventV2({goal_id:input.binding.assignment_id,binding:snapshot.current_binding,
      event_id:`work-plan-deferral:${randomUUID()}`,actor:"operator-work-plan",body:{event_type:"work_plan_item_deferred",item_id:input.item_id,action:input.action,reason:input.reason}}).snapshot;
  } else if (input.action === "update_followup") {
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
    if (snapshot.spec.execution_policy?.ready_work_handoff === 'continue_ready_work_v1') {
      const ready = projectWorkPlan(snapshot.work_plan, undefined, 0, snapshot)?.ready_items;
      const budget = assignmentWorkBudgetStatusV2(snapshot, DEFAULT_ASSIGNMENT_PROGRESS_BUDGET_V2, new Date().toISOString());
      // This only rejects an early handoff. It does not execute another turn,
      // change a lease/budget, resolve a question, or certify checklist claims.
      // The existing owner may continue only while all normal controls admit it.
      const untrackedRemainingWork = !snapshot.work_plan?.items.length && input.completion_proposal.remaining_work.length > 0;
      if ((ready?.total || untrackedRemainingWork) && !budget.checkpoint_recommended && snapshot.outcome === 'active'
          && !snapshot.provider_usage_hold && !snapshot.progress_blocker
          && !snapshot.unresolved_unknown_operation_ids.length
          && !snapshot.pending_input_variable_ids.length && !snapshot.pending_review_ids.length) {
        throw new Error('ready_work_remaining: The final handoff was not accepted. '
          + (untrackedRemainingWork
            ? 'Unfinished work is reported without retained next-work scope. Record one useful next work item from the current reference/model discrepancy, or its specific supported blocker; an exhaustive inventory is not required.'
            : 'Ready checklist items remain: ' + ready!.items.join(', ') + (ready!.total > ready!.items.length ? ' (more in status)' : ''))
          + '. Continue a useful bounded batch, verify it, and recheck current host budget. Defer an actual missing-input, tool or user-required review blocker with a specific reason; do not defer merely unattempted work. '
          + 'If you need a context checkpoint, retain checklist updates and finish this provider turn with a brief progress handoff without propose_completion; the existing host loop may continue the same active task. Never repeat uncertain or completed edits.');
      }
    }
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
    if (input.action === "complete" && (!workPlanPendingV2(snapshot) || verifiedSavedPartialV2(snapshot))) {
      snapshot = evaluatePendingAssignmentCriteriaV2({ binding: snapshot.current_binding });
    }
    if (!snapshot.terminal) snapshot = deriveAndSettleAssignmentKernelV2(input.binding, "Declared multi-part task scope updated.");
  } else if (input.action !== "status") throw new Error("work_plan_action_invalid");
  return { ok: true, outcome: snapshot.outcome, work_plan_required: !advisoryVerificationV2(snapshot) && snapshot.spec.work_plan_required === true,
    execution_continuation: projectExecutionContinuation(snapshot),
    verification_policy: advisoryVerificationV2(snapshot) ? "advisory" : "strict",
    ...(advisoryVerificationV2(snapshot) ? { completion_proposal: snapshot.completion_proposal ?? null, advisory_followups: projectAdvisoryFollowupsV2(snapshot, input.followup_start), checklist_claims: snapshot.work_plan_claims ?? [],
      notice: "Record complete for each declared item before propose_completion. In advisory mode, omit operation_ids for already-correct work; reference retained apply IDs for edits and saved artifacts to associate their checks. These are unverified item claims; native scope checks and source/layout review remain separate. Then propose_completion with claimed_completed, remaining_work and uncertainties. This never certifies completion." } : {}),
    work_allowance: { ...assignmentWorkAllowanceV2(snapshot), used_provider_calls: Object.keys(snapshot.provider_calls).length },
    budget_status: assignmentWorkBudgetStatusV2(snapshot, DEFAULT_ASSIGNMENT_PROGRESS_BUDGET_V2, new Date().toISOString()),
    work_plan: projectWorkPlan(snapshot.work_plan, input.start, input.assumption_start, snapshot),
    review_handoff: compactWorkReviewV2(snapshot),
    scope_checks: projectWorkPlanScopeChecksV1(snapshot),
    interpretation_notice: "Scope descriptions and source basis are assistant interpretations. Item completion binds distinct independently verified operations; it is not independent certification of drawing coverage.",
    edit_completion_guidance: "For an edit item, cite only existing applied edit operation IDs from available_verified_operations. Their accepted native verification reads are already associated; do not include read IDs in the edit's operation_ids. Before a scoped handoff, record finished verified edit items; keep unfinished required preservation and visual checks in their dependent inspection items. Do not drop those checks or repeat edits to correct bookkeeping. Inspection items use fresh native read IDs and their own coverage rules.",
    planning_guidance: "Declare actual changes as edit items. Group the requirements fulfilled by one edit together; a single edit cannot be credited to several distinct edit items. Checking alignment, source appearance or content that is already correct belongs in an inspection item with the applicable edit dependencies, rather than an invented additional edit. Preserve existing scope and report unresolved work; do not manufacture model changes for the checklist.",
    inspection_guidance: WORK_PLAN_INSPECTION_GUIDANCE,
    available_inspection_operations: boundedWorkPlanPage(Object.values(snapshot.operations).filter(op => op.requested_effect === "read" && op.result?.authority === "native-host" && op.result.status === "succeeded"
      && WORK_PLAN_INSPECTION_PATHS.includes(op.request_identity?.path as any))
      .reverse().map(op => ({ operation_id: op.operation_id, path: op.request_identity?.path, opened_at: op.opened_at })), input.operation_start ?? 0, 1500),
    available_verified_operations: boundedWorkPlanPage(Object.values(snapshot.operations).filter(op => op.requested_effect === "apply"
      && op.persistent_effect === "applied" && appliedOperationHasVerifiedPostconditionV2(snapshot, op.operation_id))
      .reverse().map(op => ({ operation_id: op.operation_id, path: op.request_identity?.path, opened_at: op.opened_at,
        completed_item_id: snapshot.work_plan?.items.find(item => item.operation_ids.includes(op.operation_id))?.item_id ?? null })), input.operation_start ?? 0, 1500) };
}
