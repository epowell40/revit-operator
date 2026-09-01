import type { ModelCallReceipt } from "../contracts.js";
import {
  advanceAssignmentKernelProgressV2,
  recordAssignmentProgressEpochV2
} from "../assignments/assignment_kernel_v2_progress.js";
import { settleAssignmentKernelProviderBudgetAtQuiescenceV2 } from "../assignments/assignment_kernel_v2_provider_budget.js";
import { getAssignmentKernelSnapshotV2 } from "../assignments/assignment_kernel_v2_store.js";
import { renderTerminalResultV2 } from "../assignments/assignment_kernel_v2_terminal_result.js";
import { deriveProgressGapsV2, type AssignmentBindingV2, type AssignmentSnapshotV2 } from "../domain/assignment-kernel/index.js";

function progressMessage(decision: ReturnType<typeof advanceAssignmentKernelProgressV2>["decision"]): string {
  if (decision.decision === "request_user_input") return "The canonical Assignment is waiting for the required authenticated user input before any more provider work is allowed.";
  if (decision.decision === "request_user_review") return "The canonical Assignment is waiting for bounded user review before any more provider work is allowed.";
  if (decision.decision === "await_operation") return "The canonical Assignment still has an operation in flight; no duplicate provider work was started.";
  if (decision.decision === "await_provider") return "The canonical Assignment still has provider work in flight; no duplicate provider work was started.";
  if (decision.decision === "terminal") return `The canonical Assignment is ${decision.outcome}.`;
  if (decision.decision === "blocked") return `The canonical Assignment stopped truthfully: ${decision.reason}.`;
  return `The deterministic Assignment controller did not admit another reasoning turn: ${decision.reason}.`;
}

function progressPrompt(decision: ReturnType<typeof advanceAssignmentKernelProgressV2>["decision"]): string {
  if (decision.decision === "admit_reasoning_turn") {
    return [
      "DETERMINISTIC ASSIGNMENT PROGRESS DECISION:",
      `Decision: ${decision.decision}`,
      `Unresolved gaps: ${decision.gap_ids.join(", ")}`,
      `Criteria: ${decision.criterion_ids.join(", ")}`,
      `Expected authoritative information: ${decision.expected_information.join(", ")}`,
      "Propose only operations that advance these criteria or resolve these exact gaps. Stop when the canonical controller reports a terminal, clarification, review, or blocker outcome."
    ].join("\n");
  }
  if (decision.decision === "reconcile_operation") {
    return [
      "DETERMINISTIC ASSIGNMENT RECONCILIATION DECISION:",
      `Unknown operation: ${decision.operation_id}`,
      `Required gaps: ${decision.gap_ids.join(", ")}`,
      "Inspect the exact target without replaying the mutation."
    ].join("\n");
  }
  return "";
}

export function prepareCodexAssignmentProgressV2(binding: AssignmentBindingV2): Readonly<{
  snapshot: AssignmentSnapshotV2;
  prompt: string;
  message: string;
}> {
  const progression = advanceAssignmentKernelProgressV2({ binding });
  return {
    snapshot: progression.snapshot,
    prompt: progressPrompt(progression.decision),
    message: progression.snapshot.terminal
      ? renderTerminalResultV2(progression.snapshot)
      : progressMessage(progression.decision)
  };
}

export function checkpointCodexAssignmentProgressV2(input: Readonly<{
  binding: AssignmentBindingV2;
  turn_start: AssignmentSnapshotV2;
  receipts: readonly ModelCallReceipt[];
}>): AssignmentSnapshotV2 | null {
  const current = getAssignmentKernelSnapshotV2(input.binding.assignment_id);
  if (!current || current.terminal || current.assignment_version <= input.turn_start.assignment_version) return current;
  const latestEpoch = current.progress_epochs.at(-1);
  const checkpointed = latestEpoch && latestEpoch.after_assignment_version > input.turn_start.assignment_version
    ? current
    : recordAssignmentProgressEpochV2({
        before: input.turn_start,
        after: current,
        stated_gap_ids: deriveProgressGapsV2(input.turn_start).map(gap => gap.gap_id),
        admitted_reasoning_call_ids: input.receipts.map(receipt => receipt.call_id)
      });
  return advanceAssignmentKernelProgressV2({ binding: checkpointed.current_binding }).snapshot;
}

export function settleCodexAssignmentProgressV2(binding: AssignmentBindingV2): AssignmentSnapshotV2 | null {
  settleAssignmentKernelProviderBudgetAtQuiescenceV2(binding);
  return advanceAssignmentKernelProgressV2({ binding }).snapshot;
}

export function finalCodexAssignmentMessageV2(snapshot: AssignmentSnapshotV2 | null, fallback: string): string {
  return snapshot?.terminal ? renderTerminalResultV2(snapshot) : fallback;
}

export function codexAssignmentControllerStopMessage(snapshot: AssignmentSnapshotV2 | null, reason: string): string {
  return finalCodexAssignmentMessageV2(
    snapshot,
    `The canonical Assignment controller stopped this reasoning turn: ${reason}.`
  );
}

export function currentCodexAssignmentSnapshotV2(binding: AssignmentBindingV2): AssignmentSnapshotV2 | null {
  return getAssignmentKernelSnapshotV2(binding.assignment_id);
}
