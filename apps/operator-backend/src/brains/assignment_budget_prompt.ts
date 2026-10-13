import type { assignmentWorkBudgetStatusV2 } from "../assignments/assignment_work_allowance_v2.js";

/** Provider-only projection. Full source allocation, pricing and cost records
 * remain in the host ledger/UI; repeated tool context needs current work limits. */
export function assignmentBudgetForPrompt(status: ReturnType<typeof assignmentWorkBudgetStatusV2>) {
  const { pricing_snapshot: _pricing, limitations: _limitations, ...cost } = status.cost_estimate;
  return {
    resources: status.resources,
    allocation: {
      verified_distinct_changes: status.allocation.verified_distinct_changes,
      progress_extension_enabled: status.allocation.progress_extension_enabled
    },
    token_breakdown: status.token_breakdown,
    cost_estimate: cost,
    missing_usage_calls: status.missing_usage_calls,
    checkpoint_recommended: status.checkpoint_recommended,
    approaching_limits: status.approaching_limits,
    guidance: status.guidance
  };
}
