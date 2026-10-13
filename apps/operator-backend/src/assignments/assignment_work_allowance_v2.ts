import { advisoryVerificationV2 } from "../domain/assignment-kernel/execution_policy.js";
import { verifiedNativeWorkTargetIdentitiesV2 } from "../domain/assignment-kernel/verified_work_targets.js";
import type { AssignmentSnapshotV2, AssignmentProgressBudgetV2 } from "../domain/assignment-kernel/index.js";
import { sameAssignmentBindingV2 } from "../domain/assignment-kernel/identity.js";
import { appliedOperationHasVerifiedPostconditionV2 } from "../domain/assignment-kernel/outcome.js";
import { readyNativeRollbackPreviewV2 } from "../domain/assignment-kernel/progress/ready_native_preview.js";
import { assignmentActiveExecutionTimeMsV2 } from "../domain/assignment-kernel/progress/execution_time.js";
import { ordinaryInputTokens, standardProviderTextTokenCostUsd, validTokenCount, PROVIDER_TOKEN_PRICING_SNAPSHOT } from "../provider_token_cost.js";

/** Resource telemetry, not permission to extend a lease or certify a result.
 * Cached tokens remain in the host's total-token ledger. */
export function assignmentWorkBudgetStatusV2(snapshot: AssignmentSnapshotV2, ordinary: AssignmentProgressBudgetV2, now: string) {
  const budget = defaultAssignmentWorkBudgetV2(snapshot, ordinary);
  const calls = Object.values(snapshot.provider_calls);
  const tokens = calls.reduce((sum, call) => sum + (call.usage?.total_tokens ?? 0), 0);
  const cached = calls.reduce((sum, call) => sum + (call.usage?.cached_input_tokens ?? 0), 0);
  // A missing category is unknown, not free. Cached input is a subset of input;
  // reporting it twice as additional tokens would overstate both usage and cost.
  const completeSum = (values: (number | null | undefined)[]) => values.every(validTokenCount)
    ? values.reduce<number>((sum, value) => sum + value!, 0) : null;
  const input = completeSum(calls.map(call => call.usage?.input_tokens));
  const output = completeSum(calls.map(call => call.usage?.output_tokens));
  const cachedInput = completeSum(calls.map(call => call.usage?.cached_input_tokens));
  const cacheWriteInput = completeSum(calls.map(call => call.usage?.cache_write_input_tokens));
  const uncachedInput = completeSum(calls.map(call => ordinaryInputTokens(call.usage ?? {})));
  const prices = calls.map(call => standardProviderTextTokenCostUsd(call.model, call.usage ?? {}));
  const priced = prices.filter((value): value is number => value !== null);
  const costComplete = calls.length > 0 && priced.length === calls.length;
  const meter = (used: number, limit: number) => ({ used: Number.isFinite(used) ? used : null, limit,
    remaining: Number.isFinite(used) ? Math.max(0, limit - used) : null });
  const resources = {
    provider_calls: meter(calls.length, budget.max_provider_calls),
    total_tokens: meter(tokens, budget.max_total_tokens),
    operations: meter(Object.keys(snapshot.operations).length, budget.max_operations),
    active_execution_ms: meter(assignmentActiveExecutionTimeMsV2(snapshot, now), budget.max_wall_clock_ms)
  };
  const near = Object.entries(resources).filter(([, value]) => value.used === null || value.used >= value.limit * 0.75).map(([key]) => key);
  const allowance=assignmentWorkAllowanceV2(snapshot);
  return { resources, cached_input_tokens: cached,
    allocation: { source_work_allowance: snapshot.spec.execution_policy?.source_work_allowance ?? null,
      verified_distinct_changes: allowance.verified_changes,
      progress_extension_enabled: Boolean(snapshot.spec.execution_policy?.progress_allowance),
      basis: "Creation-time source workload plus distinct committed native edits with recognized readback; no agent completion claims." },
    token_breakdown: { input_tokens: input, cached_input_tokens: cachedInput, cache_write_input_tokens: cacheWriteInput,
      uncached_input_tokens: uncachedInput, output_tokens: output,
      input_includes_cached: true, input_includes_cache_write: true, cost_estimate_available: costComplete },
    cost_estimate: { basis: "standard_text_token_list_price_equivalent", currency: "USD",
      status: costComplete ? "complete" : priced.length ? "partial" : "unavailable",
      total_usd: costComplete ? priced.reduce((sum, price) => sum + price, 0) : null,
      known_subtotal_usd: priced.length ? priced.reduce((sum, price) => sum + price, 0) : null,
      priced_calls: priced.length, unpriced_calls: calls.length - priced.length,
      pricing_snapshot: PROVIDER_TOKEN_PRICING_SNAPSHOT,
      limitations: "Not an invoice or service-tier confirmation. Excludes tax and tool fees. Missing usage or model rates remain unknown. This projection does not change the frozen budget." },
    missing_usage_calls: calls.filter(call => !call.usage).length,
    checkpoint_recommended: near.length > 0, approaching_limits: near,
    guidance: near.length ? "Finish verification of the current bounded batch and retain completed operation IDs, remaining items and questions before starting another batch. Cached tokens count toward this limit. This is not permission to retry uncertain edits or increase the budget."
      : "Complete and verify useful batches; retain their operation IDs and remaining work as you go." };
}

/** A retained plan permits one bounded planning window. Only independently
 * verified, distinct native changes earn more work. Usage is never reset. */
export function assignmentWorkAllowanceV2(snapshot: AssignmentSnapshotV2): { broad: boolean; verified_changes: number; provider_calls: number } {
  const policy = advisoryVerificationV2(snapshot) ? snapshot.spec.execution_policy : undefined;
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
    if (!signature || signatures.has(signature) || !affected?.length || affected.some(id => targets.has(id))
        || !Number.isFinite(Date.parse(op.opened_at)) || Date.parse(op.opened_at) < declared || !Number.isFinite(declared)
        || !sameAssignmentBindingV2(op.binding, snapshot.current_binding)
        || !result || !sameAssignmentBindingV2(result.binding, snapshot.current_binding)
        || result.authority !== "native-host" || result.status !== "succeeded" || result.native_transaction_state !== "committed"
        || !appliedOperationHasVerifiedPostconditionV2(snapshot, op.operation_id)) continue;
    signatures.add(signature); affected.forEach(id => targets.add(id)); verified++;
  }
  return { broad: true, verified_changes: verified, provider_calls: policy
    ? Math.min(policy.progress_allowance!.max_provider_calls, policy.max_provider_calls + verified * 8)
    : Math.min(256, 64 + verified * 8) };
}

export function defaultAssignmentWorkBudgetV2(snapshot: AssignmentSnapshotV2, ordinary: AssignmentProgressBudgetV2): AssignmentProgressBudgetV2 {
  const policy = snapshot.spec.execution_policy;
  const allowance = assignmentWorkAllowanceV2(snapshot);
  if (advisoryVerificationV2(snapshot) && policy) {
    const credit = Math.min(24, allowance.verified_changes), ceiling = policy.progress_allowance;
    return { ...ordinary, max_provider_calls: allowance.provider_calls, max_reasoning_turns: allowance.provider_calls,
      max_operations: ceiling ? Math.min(ceiling.max_operations, policy.max_operations + credit * 32) : policy.max_operations,
      max_total_tokens: ceiling ? Math.min(ceiling.max_total_tokens, policy.max_total_tokens + credit * 1_000_000) : policy.max_total_tokens,
      // A progress credit does not extend this run's timer or erase elapsed time.
      max_wall_clock_ms: policy.max_wall_clock_ms };
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

export function absoluteAssignmentWorkCallLimitV2(snapshot: AssignmentSnapshotV2): number {
  const allowance = assignmentWorkAllowanceV2(snapshot);
  return allowance.broad ? allowance.provider_calls : 64;
}
