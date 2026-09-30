import { createHash } from "node:crypto";
import { CodexTurnFailedError } from "../codex/turn_error.js";
import type { CodexWorkerIdentityV1 } from "../brains/codex_worker_identity.js";
import { canonicalJsonV2, sameAssignmentBindingV2, type AssignmentBindingV2, type AssignmentSnapshotV2 } from "../domain/assignment-kernel/index.js";
import { assignmentKernelV2ForBinding } from "./assignment_kernel_v2_factory.js";
import { appendCurrentAssignmentKernelEventV2 } from "./assignment_kernel_v2_store.js";
import { DEFAULT_ASSIGNMENT_PROGRESS_BUDGET_V2 } from "./assignment_kernel_v2_progress.js";
import { defaultAssignmentWorkBudgetV2 } from "./assignment_work_allowance_v2.js";

/** Called only at the bound provider waiter. Text and constructed errors are not
 * authority; the issuing transport must still recognize its exact receipt. */
export function recordCodexProviderUsageHoldV2(input: Readonly<{
  binding: AssignmentBindingV2;
  attempt_id: string;
  thread_id: string;
  turn_id: string;
  error: unknown;
  is_current_failure: (error: unknown) => boolean;
  worker_identity?: CodexWorkerIdentityV1;
  occurred_at?: string;
}>) {
  const error = input.error;
  if (!(error instanceof CodexTurnFailedError) || error.codexErrorInfo !== "usageLimitExceeded"
      || error.threadId !== input.thread_id || error.turnId !== input.turn_id
      || !input.is_current_failure(error)) return null;
  const resolved = assignmentKernelV2ForBinding(input.binding);
  if (!resolved || !sameAssignmentBindingV2(resolved.snapshot.current_binding, input.binding)) {
    throw new Error("assignment_usage_hold_binding_stale");
  }
  const snapshot = resolved.snapshot;
  if (snapshot.terminal) return null;
  const id = createHash("sha256").update(canonicalJsonV2({ binding: snapshot.current_binding,
    attempt_id: input.attempt_id, thread_id: input.thread_id, turn_id: input.turn_id })).digest("hex");
  const holdId = `provider-usage:${id}`;
  if (snapshot.provider_usage_hold) {
    if (snapshot.provider_usage_hold.hold_id !== holdId) throw new Error("assignment_usage_hold_already_active");
    return snapshot;
  }
  const occurredAt = input.occurred_at ?? new Date().toISOString();
  const recorded = appendCurrentAssignmentKernelEventV2({
    goal_id: input.binding.assignment_id, binding: input.binding,
    event_id: `usage-hold:${id}`, actor: "assignment-execution-controller", occurred_at: occurredAt,
    body: { event_type: "provider_usage_hold_recorded", hold: {
      schema: "revit-operator.provider-usage-hold/v1", hold_id: holdId,
      binding: structuredClone(snapshot.current_binding), attempt_id: input.attempt_id,
      provider_thread_id: input.thread_id, provider_turn_id: input.turn_id,
      code: "usageLimitExceeded", recorded_at: occurredAt,
      resume_budget: defaultAssignmentWorkBudgetV2(snapshot, DEFAULT_ASSIGNMENT_PROGRESS_BUDGET_V2),
      ...(input.worker_identity ? { worker_identity: input.worker_identity } : {})
    } }
  }).snapshot;
  // Journal event retries remain idempotent, but a released event is not a new hold.
  if (recorded.provider_usage_hold?.hold_id !== holdId) throw new Error("assignment_usage_hold_identity_retired");
  return recorded;
}

export function providerUsageHoldMessageV2(snapshot: AssignmentSnapshotV2): string {
  const hold = snapshot.provider_usage_hold;
  if (!hold) return "";
  const billing = hold.worker_identity?.configured_billing_mode;
  const worker = billing === "chatgpt" ? "This worker is configured to use ChatGPT sign-in."
    : billing === "api_key" ? "This worker is configured to use API-key billing."
    : "This worker's billing mode is unconfirmed.";
  const state = !snapshot.quiescent ? "Already-started work is still settling."
    : ["blocked", "failed"].includes(snapshot.outcome) || snapshot.progress_blocker
      || snapshot.provider_budget_exhausted || snapshot.execution_failure_ids.length
      ? "A separate task issue must be resolved before this work can continue."
    : snapshot.pending_input_variable_ids.length || snapshot.pending_review_ids.length
      ? "Saved questions or review also need your attention before Resume."
    : snapshot.execution_control?.state === "paused" ? "Your task also remains paused."
    : "Resume when usage is available.";
  return `Provider usage limit reached. ${worker} ${state} Task state is retained; Revit changes may be unsaved.`;
}
