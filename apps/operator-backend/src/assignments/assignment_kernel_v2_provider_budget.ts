import { createHash } from "node:crypto";
import type { ModelCallReceipt } from "../contracts.js";
import type { AssignmentBindingV2, AssignmentSnapshotV2 } from "../domain/assignment-kernel/index.js";
import { ASSIGNMENT_ABSOLUTE_MODEL_CALL_LIMIT } from "./model_call_budget.js";
import { deriveAndSettleAssignmentKernelV2 } from "./assignment_kernel_v2_lifecycle.js";
import { appendCurrentAssignmentKernelEventV2, getAssignmentKernelSnapshotV2 } from "./assignment_kernel_v2_store.js";

function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value), "utf8").digest("hex");
}

/**
 * Provider receipts are durable resource accounting, not semantic progress.
 * The hard cap interrupts inference, but terminal settlement is deferred to a
 * known quiescent boundary so a response-selected tool cannot lose its result.
 */
export function assignmentKernelV2ModelReceiptObserver(
  binding: AssignmentBindingV2,
  onLimit: () => void
): (receipt: ModelCallReceipt) => void {
  let notified = false;
  return receipt => {
    const snapshot = getAssignmentKernelSnapshotV2(binding.assignment_id);
    if (!snapshot || snapshot.terminal) return;
    const call = appendCurrentAssignmentKernelEventV2({
      goal_id: binding.assignment_id,
      binding,
      event_id: `provider-call:${digest({ binding, call_id: receipt.call_id })}`,
      actor: "provider-receipt-observer",
      body: {
        event_type: "provider_call_recorded",
        call_id: receipt.call_id,
        provider: receipt.provider,
        model: receipt.model,
        reasoning_effort: receipt.reasoning_effort,
        success: receipt.success
      }
    }).snapshot;
    if (call.provider_call_ids.length < ASSIGNMENT_ABSOLUTE_MODEL_CALL_LIMIT || call.provider_budget_exhausted) return;
    appendCurrentAssignmentKernelEventV2({
      goal_id: binding.assignment_id,
      binding,
      event_id: `provider-budget-exhausted:${binding.run_id}:${binding.generation}`,
      actor: "provider-receipt-observer",
      body: { event_type: "provider_budget_exhausted", limit: ASSIGNMENT_ABSOLUTE_MODEL_CALL_LIMIT }
    });
    if (!notified) {
      notified = true;
      onLimit();
    }
  };
}

export function settleAssignmentKernelProviderBudgetAtQuiescenceV2(binding: AssignmentBindingV2): AssignmentSnapshotV2 | null {
  const snapshot = getAssignmentKernelSnapshotV2(binding.assignment_id);
  if (!snapshot || snapshot.terminal || !snapshot.provider_budget_exhausted || !snapshot.quiescent) return snapshot;
  return deriveAndSettleAssignmentKernelV2({
    session_id: binding.session_id,
    assignment_id: binding.assignment_id,
    run_id: binding.run_id,
    generation: binding.generation
  }, "absolute_model_call_limit_reached");
}
