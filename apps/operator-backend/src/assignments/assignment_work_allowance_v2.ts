import { advisoryVerificationV2 } from "../domain/assignment-kernel/execution_policy.js";
import { verifiedNativeWorkTargetIdentitiesV2 } from "../domain/assignment-kernel/verified_work_targets.js";
import type { AssignmentSnapshotV2, AssignmentProgressBudgetV2 } from "../domain/assignment-kernel/index.js";
import { sameAssignmentBindingV2 } from "../domain/assignment-kernel/identity.js";
import { appliedOperationHasVerifiedPostconditionV2 } from "../domain/assignment-kernel/outcome.js";
import { readyNativeRollbackPreviewV2 } from "../domain/assignment-kernel/progress/ready_native_preview.js";

/** A retained plan permits one bounded planning window. Only independently
 * verified, distinct native changes earn more work. Usage is never reset. */
export function assignmentWorkAllowanceV2(snapshot: AssignmentSnapshotV2): { broad: boolean; verified_changes: number; provider_calls: number } {
  if (advisoryVerificationV2(snapshot)) return { broad: true, verified_changes: 0, provider_calls: snapshot.spec.execution_policy!.max_provider_calls };
  const plan = snapshot.work_plan;
  // The initial scope classifier can miss multi-edit work. Once the agent has
  // retained two distinct edit items, use that auditable plan for the bounded
  // planning window; inspection alone cannot turn a short edit into broad work.
  const broad = snapshot.spec.requested_effect === "apply" && Boolean(plan
    && plan.items.filter(item => item.kind !== "inspection").length >= 2);
  if (!broad) {
    // A successful native dry run has already resolved the model/tool uncertainty
    // for one edit. Reserve a small, one-time window to apply and verify it;
    // failed previews, text claims, and repeated previews earn no extra calls.
    const readyNativePreview = readyNativeRollbackPreviewV2(snapshot);
    return { broad: false, verified_changes: 0, provider_calls: readyNativePreview ? 48 : 32 };
  }
  const declared = Math.min(...plan!.items.map(item => Date.parse(item.declared_at)));
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
    if (!signature || signatures.has(signature) || !affected?.length || affected.some(id => targets.has(id))
        || !Number.isFinite(Date.parse(op.opened_at)) || Date.parse(op.opened_at) < declared || !Number.isFinite(declared)
        || !sameAssignmentBindingV2(op.binding, snapshot.current_binding)
        || !result || !sameAssignmentBindingV2(result.binding, snapshot.current_binding)
        || result.authority !== "native-host" || result.status !== "succeeded" || result.native_transaction_state !== "committed"
        || !appliedOperationHasVerifiedPostconditionV2(snapshot, op.operation_id)) continue;
    signatures.add(signature); affected.forEach(id => targets.add(id)); verified++;
  }
  return { broad: true, verified_changes: verified, provider_calls: Math.min(256, 64 + verified * 8) };
}

export function defaultAssignmentWorkBudgetV2(snapshot: AssignmentSnapshotV2, ordinary: AssignmentProgressBudgetV2): AssignmentProgressBudgetV2 {
  const policy = snapshot.spec.execution_policy;
  if (advisoryVerificationV2(snapshot) && policy) return { ...ordinary, max_provider_calls: policy.max_provider_calls, max_reasoning_turns: policy.max_provider_calls,
    max_operations: policy.max_operations, max_total_tokens: policy.max_total_tokens, max_wall_clock_ms: policy.max_wall_clock_ms };
  const allowance = assignmentWorkAllowanceV2(snapshot);
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

export function absoluteAssignmentWorkCallLimitV2(snapshot: AssignmentSnapshotV2): number {
  const allowance = assignmentWorkAllowanceV2(snapshot);
  return allowance.broad ? allowance.provider_calls : 64;
}
