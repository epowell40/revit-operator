import { verifiedNativeWorkTargetIdentitiesV2 } from "../domain/assignment-kernel/verified_work_targets.js";
import type { AssignmentSnapshotV2, AssignmentProgressBudgetV2 } from "../domain/assignment-kernel/index.js";
import { sameAssignmentBindingV2 } from "../domain/assignment-kernel/identity.js";
import { appliedOperationHasVerifiedPostconditionV2 } from "../domain/assignment-kernel/outcome.js";

/** A retained plan permits one bounded planning window. Only independently
 * verified, distinct native changes earn more work. Usage is never reset. */
export function assignmentWorkAllowanceV2(snapshot: AssignmentSnapshotV2): { broad: boolean; verified_changes: number; provider_calls: number } {
  const plan = snapshot.work_plan;
  const broad = snapshot.spec.requested_effect === "apply" && snapshot.spec.work_plan_required === true && Boolean(plan && plan.items.length >= 2);
  if (!broad) return { broad: false, verified_changes: 0, provider_calls: 32 };
  const declared = Math.min(...plan!.items.map(item => Date.parse(item.declared_at)));
  const signatures = new Set<string>(), targets = new Set<string>();
  let verified = 0;
  const operations = Object.values(snapshot.operations).sort((a,b) => Date.parse(a.opened_at)-Date.parse(b.opened_at));
  for (const op of operations) {
    const result = op.result, signature = op.request_identity?.request_signature;
    const affected = verifiedNativeWorkTargetIdentitiesV2(snapshot,op.operation_id);
    if (!signature || signatures.has(signature) || !affected?.length || affected.some(id => targets.has(id))
        || !Number.isFinite(Date.parse(op.opened_at)) || Date.parse(op.opened_at) < declared || !Number.isFinite(declared)
        || snapshot.input_invalidated_operation_ids?.includes(op.operation_id)
        || !sameAssignmentBindingV2(op.binding, snapshot.current_binding)
        || !result || !sameAssignmentBindingV2(result.binding, snapshot.current_binding)
        || result.authority !== "native-host" || result.status !== "succeeded" || result.native_transaction_state !== "committed"
        || !appliedOperationHasVerifiedPostconditionV2(snapshot, op.operation_id)) continue;
    signatures.add(signature); affected.forEach(id => targets.add(id)); verified++;
  }
  return { broad: true, verified_changes: verified, provider_calls: Math.min(256, 64 + verified * 8) };
}

export function defaultAssignmentWorkBudgetV2(snapshot: AssignmentSnapshotV2, ordinary: AssignmentProgressBudgetV2): AssignmentProgressBudgetV2 {
  const allowance = assignmentWorkAllowanceV2(snapshot);
  if (!allowance.broad) return ordinary;
  const credit = Math.min(24, allowance.verified_changes);
  return { ...ordinary, max_provider_calls: allowance.provider_calls, max_reasoning_turns: allowance.provider_calls,
    max_operations: Math.min(1024, 256 + credit * 32), max_total_tokens: Math.min(32_000_000, 8_000_000 + credit * 1_000_000),
    max_wall_clock_ms: Math.min(120, 30 + credit * 5) * 60_000 };
}

export function absoluteAssignmentWorkCallLimitV2(snapshot: AssignmentSnapshotV2): number {
  const allowance = assignmentWorkAllowanceV2(snapshot);
  return allowance.broad ? allowance.provider_calls : 64;
}
