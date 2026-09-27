import type { AssignmentSpecV2 } from "./assignment_spec.js";
import type { AssignmentSnapshotV2 } from "./snapshot.js";

/** Host-owned, creation-time experiment choice. There is no policy-change event. */
export interface LocalAdvisoryExecutionPolicyV1 {
  mode: "local_advisory_v1";
  selected_by: "trusted_local_host";
  session_id: string;
  document_fingerprint: string;
  max_turns: number;
  max_provider_calls: number;
  max_operations: number;
  max_total_tokens: number;
  max_wall_clock_ms: number;
}

export interface AdvisoryCompletionProposalV1 {
  claimed_completed: readonly string[];
  remaining_work: readonly string[];
  uncertainties: readonly string[];
}

export function advisoryVerificationV2(snapshot: Pick<AssignmentSnapshotV2, "spec">): boolean {
  return snapshot.spec.execution_policy?.mode === "local_advisory_v1";
}

export function validLocalAdvisoryPolicyV1(spec: AssignmentSpecV2): boolean {
  const policy = spec.execution_policy;
  if (!policy) return true;
  const bounded = (value: number, max: number) => Number.isSafeInteger(value) && value > 0 && value <= max;
  return policy.mode === "local_advisory_v1" && policy.selected_by === "trusted_local_host"
    && policy.session_id === spec.binding.session_id && Boolean(policy.document_fingerprint)
    && policy.document_fingerprint === spec.binding.document_fingerprint
    && bounded(policy.max_turns, 16) && bounded(policy.max_provider_calls, 256)
    && bounded(policy.max_operations, 1024) && bounded(policy.max_total_tokens, 32_000_000)
    && bounded(policy.max_wall_clock_ms, 120 * 60_000);
}

export function validAdvisoryProposalV1(proposal: AdvisoryCompletionProposalV1): boolean {
  const fields = [proposal?.claimed_completed, proposal?.remaining_work, proposal?.uncertainties];
  return fields.every(items => Array.isArray(items) && items.length <= 24
    && items.every(item => typeof item === "string" && item.trim().length > 0 && item.length <= 1000))
    && fields.some(items => items.length > 0);
}
