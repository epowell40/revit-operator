import { assignmentWorkAllowanceV2, defaultAssignmentWorkBudgetV2 } from "../domain/assignment-kernel/effective_work_budget.js";
export { assignmentWorkAllowanceV2, defaultAssignmentWorkBudgetV2 } from "../domain/assignment-kernel/effective_work_budget.js";
import type { AssignmentSnapshotV2, AssignmentProgressBudgetV2 } from "../domain/assignment-kernel/index.js";
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


export function absoluteAssignmentWorkCallLimitV2(snapshot: AssignmentSnapshotV2): number {
  const allowance = assignmentWorkAllowanceV2(snapshot);
  return allowance.broad ? allowance.provider_calls : 64;
}
