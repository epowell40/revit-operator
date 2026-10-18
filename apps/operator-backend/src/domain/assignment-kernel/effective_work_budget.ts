import { advisoryVerificationV2 } from "./execution_policy.js";
import { verifiedNativeWorkTargetIdentitiesV2 } from "./verified_work_targets.js";
import type { AssignmentSnapshotV2 } from "./snapshot.js";
import type { AssignmentProgressBudgetV2 } from "./progress/contracts.js";
import { sameAssignmentBindingV2 } from "./identity.js";
import { appliedOperationHasVerifiedPostconditionV2 } from "./outcome.js";
import { readyNativeRollbackPreviewV2 } from "./progress/ready_native_preview.js";
import {nativeInventoryPlanningV1} from './native_inventory_workload.js';
import { applyUserFollowupAllocationV1, allocateUserFollowupV1, userFollowupLimitV1 } from './user_followup_allocation.js';

// One pure derivation for execution, telemetry and checkpoint admission.
// Frozen policy and usage remain immutable. Checked progress and authenticated
// new work are distinct, journal-derived allocations within the same ceilings.
/** A retained plan permits one bounded planning window. Only independently
 * verified, distinct native changes earn progress credit. Usage is never reset. */
function earnedAssignmentWorkAllowanceV2(snapshot: AssignmentSnapshotV2): { broad: boolean; verified_changes: number; verified_targets?: number; source_planning_units?:number;source_planning_items?:number; provider_calls: number } {
  const policy = advisoryVerificationV2(snapshot) ? snapshot.spec.execution_policy : undefined;
  const targetCredits = policy?.progress_allowance?.credit_unit === 'distinct_verified_targets_v1';
  if (policy && (!policy.progress_allowance || snapshot.spec.requested_effect !== "apply"))
    return { broad: true, verified_changes: 0, provider_calls: policy.max_provider_calls };
  const plan = snapshot.work_plan;
  // The initial scope classifier can miss multi-edit work. Once the agent has
  // retained two distinct edit items, use that auditable plan for the bounded
  // planning window; inspection alone cannot turn a short edit into broad work.
  const broad = snapshot.spec.requested_effect === "apply" && Boolean(policy?.progress_allowance || (plan
    && plan.items.filter(item => item.kind !== "inspection").length >= 2));
  if (!broad) {
    // A successful native dry run has already resolved the model/tool uncertainty
    // for one edit. Reserve a small, one-time window to apply and verify it;
    // failed previews, text claims, and repeated previews earn no extra calls.
    const readyNativePreview = readyNativeRollbackPreviewV2(snapshot);
    return { broad: false, verified_changes: 0, provider_calls: readyNativePreview ? 48 : 32 };
  }
  const declared = policy ? Date.parse(snapshot.spec.created_at)
    : Math.min(...plan!.items.map(item => Date.parse(item.declared_at)));
  const signatures = new Set<string>(), targets = new Set<string>();
  let verified = 0;
  const operations = Object.values(snapshot.operations).sort((a,b) => Date.parse(a.opened_at)-Date.parse(b.opened_at));
  for (const op of operations) {
    const result = op.result, signature = op.request_identity?.request_signature;
    const affected = verifiedNativeWorkTargetIdentitiesV2(snapshot,op.operation_id);
    // Steering can invalidate an edit as evidence for the current desired
    // outcome, but it cannot erase the native transaction and independent
    // physical verification already performed. Count that bounded work once;
    // completion still uses the stricter current-input freshness rule.
    if (!signature || signatures.has(signature) || !affected?.length || (!targetCredits && affected.some(id => targets.has(id)))
        || !Number.isFinite(Date.parse(op.opened_at)) || Date.parse(op.opened_at) < declared || !Number.isFinite(declared)
        || !sameAssignmentBindingV2(op.binding, snapshot.current_binding)
        || !result || !sameAssignmentBindingV2(result.binding, snapshot.current_binding)
        || result.authority !== "native-host" || result.status !== "succeeded" || result.native_transaction_state !== "committed"
        || !appliedOperationHasVerifiedPostconditionV2(snapshot, op.operation_id)) continue;
    signatures.add(signature);
    // A fully verified mixed batch earns only its new principal targets. Repeated
    // values/targets, containing sheets and incidental native changes add none.
    if (!affected.some(id => !targets.has(id))) continue;
    affected.forEach(id => targets.add(id)); verified++;
  }
  const units = targetCredits ? Math.min(24, targets.size) : verified;
  const planning=nativeInventoryPlanningV1(snapshot);
  return { broad: true, verified_changes: verified, ...(targetCredits ? {verified_targets: targets.size} : {}),
    ...(planning?{source_planning_units:planning.units,source_planning_items:planning.items}:{}),provider_calls: policy
    ? Math.min(policy.progress_allowance!.max_provider_calls, policy.max_provider_calls*(planning?.units??1) + units * 8)
    : Math.min(256, 64 + verified * 8) };
}

export function assignmentWorkAllowanceV2(snapshot: AssignmentSnapshotV2) {
  const earned = earnedAssignmentWorkAllowanceV2(snapshot);
  return {...earned,provider_calls:userFollowupLimitV1(snapshot,'max_provider_calls',earned.provider_calls)};
}

export function allocateAuthenticatedFollowupV1(snapshot: AssignmentSnapshotV2, commandId: string, now: string) {
  const policy = snapshot.spec.execution_policy!;
  const ordinary = {...policy,max_reasoning_turns:policy.max_provider_calls,max_equivalent_operations:0,max_no_progress_epochs:0,max_reconciliation_attempts:0};
  const earned = defaultAssignmentWorkBudgetV2({...snapshot,user_followup_allocation:undefined},ordinary);
  return allocateUserFollowupV1(snapshot,commandId,now,earned,defaultAssignmentWorkBudgetV2(snapshot,ordinary));
}

export function defaultAssignmentWorkBudgetV2(snapshot: AssignmentSnapshotV2, ordinary: AssignmentProgressBudgetV2): AssignmentProgressBudgetV2 {
  const policy = snapshot.spec.execution_policy;
  const allowance = earnedAssignmentWorkAllowanceV2(snapshot);
  if (advisoryVerificationV2(snapshot) && policy) {
    const credit = Math.min(24, allowance.verified_targets ?? allowance.verified_changes), ceiling = policy.progress_allowance;
    const sourceUnits=allowance.source_planning_units??1;
    return applyUserFollowupAllocationV1(snapshot, { ...ordinary, max_provider_calls: allowance.provider_calls, max_reasoning_turns: allowance.provider_calls,
      max_operations: ceiling ? Math.min(ceiling.max_operations, policy.max_operations*sourceUnits + credit * 32) : policy.max_operations,
      max_total_tokens: ceiling ? Math.min(ceiling.max_total_tokens, policy.max_total_tokens*sourceUnits + credit * 1_000_000) : policy.max_total_tokens,
      // Only new policies explicitly freeze a time ceiling. Old clocks and all
      // cumulative receipts stay unchanged, including across restart/Resume.
      max_wall_clock_ms: ceiling?.max_wall_clock_ms === undefined ? policy.max_wall_clock_ms
        : Math.min(ceiling.max_wall_clock_ms,policy.max_wall_clock_ms*sourceUnits + credit*5*60_000) });
  }
  if (!allowance.broad) return allowance.provider_calls > ordinary.max_provider_calls
    ? { ...ordinary, max_provider_calls: allowance.provider_calls,
      max_reasoning_turns: Math.max(ordinary.max_reasoning_turns, allowance.provider_calls),
      // A continued drawing conversation carries a large cached prompt. The
      // same 48-call ceiling still bounds work, while this leaves room to
      // apply and verify after a native ready preview instead of stopping on
      // cached-token accounting first.
      max_total_tokens: Math.max(ordinary.max_total_tokens, 6_000_000) }
    : ordinary;
  const credit = Math.min(24, allowance.verified_changes);
  return { ...ordinary, max_provider_calls: allowance.provider_calls, max_reasoning_turns: allowance.provider_calls,
    max_operations: Math.min(1024, 256 + credit * 32), max_total_tokens: Math.min(32_000_000, 8_000_000 + credit * 1_000_000),
    max_wall_clock_ms: Math.min(120, 30 + credit * 5) * 60_000 };
}
