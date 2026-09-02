import type { ModelCallReceipt } from "../contracts.js";
import {
  canonicalJsonV2,
  deriveProgressGapsV2,
  sameAssignmentBindingV2,
  type AssignmentBindingV2,
  type AssignmentSnapshotV2,
  type ProgressDecisionV2,
  type ProviderCallV2,
  type ProviderUsageV2
} from "../domain/assignment-kernel/index.js";
import { ASSIGNMENT_ABSOLUTE_MODEL_CALL_LIMIT } from "./model_call_budget.js";
import { deriveAndSettleAssignmentKernelV2 } from "./assignment_kernel_v2_lifecycle.js";
import {
  advanceAssignmentKernelProgressV2,
  evaluatePendingAssignmentCriteriaV2,
  recordCompletedAssignmentProviderReceiptV2
} from "./assignment_kernel_v2_progress.js";
import { appendCurrentAssignmentKernelEventV2, getAssignmentKernelSnapshotV2 } from "./assignment_kernel_v2_store.js";

/**
 * Provider receipts are durable resource accounting, not semantic progress.
 * The hard cap interrupts inference, but terminal settlement is deferred to a
 * known quiescent boundary so a response-selected tool cannot lose its result.
 */
export function assignmentKernelV2ModelReceiptObserver(
  binding: AssignmentBindingV2,
  onLimit: () => void
): (receipt: ModelCallReceipt) => void {
  return createAssignmentKernelV2ModelReceiptRecorder({ binding, onStop: onLimit }).observe;
}

type ProviderAdmissionBasisV2 = Readonly<{
  gap_ids: readonly string[];
  criterion_ids: readonly string[];
  expected_information: readonly string[];
}>;

function providerAdmissionBasis(snapshot: AssignmentSnapshotV2): ProviderAdmissionBasisV2 | null {
  const gaps = deriveProgressGapsV2(snapshot);
  const gapIds = gaps.map((gap) => gap.gap_id);
  const criterionIds = [...new Set(gaps.flatMap((gap) => gap.criterion_ids))].sort();
  const expectedInformation = [...new Set(gaps.flatMap((gap) => gap.required_fact_ids))].sort();
  if (gapIds.length === 0 || criterionIds.length === 0) return null;
  return {
    gap_ids: gapIds,
    criterion_ids: criterionIds,
    expected_information: expectedInformation.length > 0 ? expectedInformation : gapIds
  };
}

function stopsProviderTurn(decision: ProgressDecisionV2): boolean {
  return ["terminal", "blocked", "request_user_input", "request_user_review"].includes(decision.decision);
}

function providerUsage(receipt: ModelCallReceipt): ProviderUsageV2 {
  return {
    input_tokens: receipt.tokens.input_tokens,
    output_tokens: receipt.tokens.output_tokens,
    reasoning_tokens: receipt.tokens.reasoning_output_tokens,
    total_tokens: receipt.tokens.total_tokens,
    estimated_cost_usd: null
  };
}

function providerReceiptAgrees(call: ProviderCallV2, receipt: ModelCallReceipt): boolean {
  return call.call_id === receipt.call_id
    && call.provider === receipt.provider
    && call.model === receipt.model
    && call.reasoning_effort === receipt.reasoning_effort
    && call.admitted_at === receipt.started_at_utc
    && call.success === receipt.success
    && (!receipt.turn_id || call.controller_turn_id === receipt.turn_id)
    && canonicalJsonV2(call.usage ?? null) === canonicalJsonV2(providerUsage(receipt));
}

export type AssignmentKernelV2ModelReceiptRecorder = Readonly<{
  observe: (receipt: ModelCallReceipt) => void;
  reconcile: (receipts: readonly ModelCallReceipt[]) => AssignmentSnapshotV2;
}>;

/**
 * Records raw upstream response receipts as canonical provider truth. The
 * admission basis is captured before the provider turn starts and refreshed
 * while unresolved gaps remain, so the response that closes the final gap is
 * still attributable after its Observation has made completion derivable.
 * End-of-turn reconciliation is a second idempotent sink for notifications
 * that were delayed or whose observer callback failed.
 */
export function createAssignmentKernelV2ModelReceiptRecorder(input: Readonly<{
  binding: AssignmentBindingV2;
  admission_snapshot?: AssignmentSnapshotV2 | null;
  onStop: () => void;
}>): AssignmentKernelV2ModelReceiptRecorder {
  let notified = false;
  if (input.admission_snapshot
    && !sameAssignmentBindingV2(input.admission_snapshot.current_binding, input.binding)) {
    throw new Error("assignment_kernel_v2_provider_receipt_admission_binding_mismatch");
  }
  const initialSnapshot = input.admission_snapshot
    ?? getAssignmentKernelSnapshotV2(input.binding.assignment_id);
  let lastAdmissionBasis = initialSnapshot ? providerAdmissionBasis(initialSnapshot) : null;

  const notifyStop = () => {
    if (notified) return;
    notified = true;
    input.onStop();
  };

  const retain = (receipt: ModelCallReceipt, strict: boolean): AssignmentSnapshotV2 => {
    const before = getAssignmentKernelSnapshotV2(input.binding.assignment_id);
    if (!before) throw new Error("assignment_kernel_v2_provider_receipt_assignment_missing");
    const retainedCall = before.provider_calls[receipt.call_id];
    if (retainedCall) {
      if (!providerReceiptAgrees(retainedCall, receipt)) {
        throw new Error(`assignment_kernel_v2_provider_receipt_conflict:${receipt.call_id}`);
      }
      return before;
    }
    if (before.terminal) {
      if (strict) throw new Error(`assignment_kernel_v2_provider_receipt_after_terminal:${receipt.call_id}`);
      notifyStop();
      return before;
    }
    const currentAdmissionBasis = providerAdmissionBasis(before);
    if (currentAdmissionBasis) lastAdmissionBasis = currentAdmissionBasis;
    const admissionBasis = currentAdmissionBasis ?? lastAdmissionBasis;
    if (!admissionBasis) {
      notifyStop();
      if (strict) throw new Error(`assignment_kernel_v2_provider_receipt_admission_missing:${receipt.call_id}`);
      return before;
    }
    const call = recordCompletedAssignmentProviderReceiptV2({
      binding: input.binding,
      call_id: receipt.call_id,
      ...(receipt.turn_id ? { controller_turn_id: receipt.turn_id } : {}),
      provider: receipt.provider,
      model: receipt.model,
      reasoning_effort: receipt.reasoning_effort,
      gap_ids: admissionBasis.gap_ids,
      criterion_ids: admissionBasis.criterion_ids,
      expected_information: admissionBasis.expected_information,
      admitted_at: receipt.started_at_utc,
      usage: providerUsage(receipt),
      success: receipt.success,
      ...(receipt.success ? {} : { error_class: "provider" as const })
    });
    let current = call;
    const absoluteLimitReached = call.provider_call_ids.length >= ASSIGNMENT_ABSOLUTE_MODEL_CALL_LIMIT;
    if (call.in_flight_operation_ids.length === 0) {
      if (absoluteLimitReached) {
        current = settleAssignmentKernelProviderBudgetAtQuiescenceV2(call.current_binding) ?? call;
      } else {
        const advanced = advanceAssignmentKernelProgressV2({ binding: call.current_binding });
        current = advanced.snapshot;
        if (stopsProviderTurn(advanced.decision)) notifyStop();
      }
    }
    if (absoluteLimitReached) notifyStop();
    return current;
  };

  return {
    observe(receipt) {
      retain(receipt, false);
    },
    reconcile(receipts) {
      for (const receipt of receipts) retain(receipt, true);
      const snapshot = getAssignmentKernelSnapshotV2(input.binding.assignment_id);
      if (!snapshot) throw new Error("assignment_kernel_v2_provider_receipt_assignment_missing");
      const missing = receipts.map((receipt) => receipt.call_id)
        .filter((callId) => !snapshot.provider_calls[callId]);
      if (missing.length > 0) {
        throw new Error(`assignment_kernel_v2_provider_receipt_reconciliation_incomplete:${missing.join(",")}`);
      }
      return snapshot;
    }
  };
}

export function settleAssignmentKernelProviderBudgetAtQuiescenceV2(binding: AssignmentBindingV2): AssignmentSnapshotV2 | null {
  let snapshot = getAssignmentKernelSnapshotV2(binding.assignment_id);
  if (!snapshot || snapshot.terminal || !snapshot.quiescent) return snapshot;
  if (!snapshot.provider_budget_exhausted
    && snapshot.provider_call_ids.length < ASSIGNMENT_ABSOLUTE_MODEL_CALL_LIMIT) return snapshot;
  if (!snapshot.provider_budget_exhausted) {
    snapshot = evaluatePendingAssignmentCriteriaV2({ binding: snapshot.current_binding });
    if (snapshot.terminal) return snapshot;
    if (["complete", "complete_with_issues", "verified_noop", "blocked", "failed"].includes(snapshot.outcome)) {
      return deriveAndSettleAssignmentKernelV2(binding, "terminal_outcome_derived_at_provider_boundary");
    }
    if (["awaiting_user_input", "awaiting_user_review"].includes(snapshot.outcome)) return snapshot;
    snapshot = appendCurrentAssignmentKernelEventV2({
      goal_id: binding.assignment_id,
      binding,
      event_id: `provider-budget-exhausted:${binding.run_id}:${binding.generation}`,
      actor: "provider-receipt-observer",
      body: { event_type: "provider_budget_exhausted", limit: ASSIGNMENT_ABSOLUTE_MODEL_CALL_LIMIT }
    }).snapshot;
  }
  return deriveAndSettleAssignmentKernelV2({
    session_id: binding.session_id,
    assignment_id: binding.assignment_id,
    run_id: binding.run_id,
    generation: binding.generation
  }, "absolute_model_call_limit_reached");
}
