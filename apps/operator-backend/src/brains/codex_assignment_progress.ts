import { advisoryFollowupsContextV2, advisoryFollowupsHandoffV2, projectAdvisoryFollowupsV2 } from "../assignments/advisory_followups_projection.js";
import { advisoryVerificationV2 } from "../domain/assignment-kernel/execution_policy.js";
import { sameAssignmentBindingV2 } from "../domain/assignment-kernel/index.js";
import type { ModelCallReceipt } from "../contracts.js";
import {
  advanceAssignmentKernelProgressV2,
  recordAssignmentProgressEpochV2
} from "../assignments/assignment_kernel_v2_progress.js";
import { settleAssignmentKernelProviderBudgetAtQuiescenceV2 } from "../assignments/assignment_kernel_v2_provider_budget.js";
import { getAssignmentKernelSnapshotV2 } from "../assignments/assignment_kernel_v2_store.js";
import { renderTerminalResultV2 } from "../assignments/assignment_kernel_v2_terminal_result.js";
import { deriveProgressGapsV2, type AssignmentBindingV2, type AssignmentSnapshotV2 } from "../domain/assignment-kernel/index.js";
import { verificationCapabilityGuidanceV2 } from "../verification/verification_capability_admission_v2.js";
import { codexAssignmentEvidenceContextV2 } from "./codex_assignment_evidence.js";

function applicationGapGuidance(snapshot: AssignmentSnapshotV2, gapId: string): string {
  if (!gapId.startsWith("verification:")) return "";
  const operation = snapshot.operations[gapId.slice("verification:".length)];
  if (!operation) return "";
  return verificationCapabilityGuidanceV2({
    capability_id: operation.capability_id,
    method: operation.request_identity?.method,
    path: operation.request_identity?.path,
    tool: operation.input.tool,
    target_id: operation.target.target_id
  }) ?? "";
}

function progressMessage(decision: ReturnType<typeof advanceAssignmentKernelProgressV2>["decision"]): string {
  if (decision.decision === "paused") return "Task paused. Its completed work and remaining questions are saved. Resume when you are ready.";
  if (decision.decision === "request_user_input") return "The canonical Assignment is waiting for the required authenticated user input before any more provider work is allowed.";
  if (decision.decision === "request_user_review") return "The canonical Assignment is waiting for bounded user review before any more provider work is allowed.";
  if (decision.decision === "await_operation") return "The canonical Assignment still has an operation in flight; no duplicate provider work was started.";
  if (decision.decision === "await_provider") return "The canonical Assignment still has provider work in flight; no duplicate provider work was started.";
  if (decision.decision === "terminal") return `The canonical Assignment is ${decision.outcome}.`;
  if (decision.decision === "blocked") return `The canonical Assignment stopped truthfully: ${decision.reason}.`;
  return `The deterministic Assignment controller did not admit another reasoning turn: ${decision.reason}.`;
}

function progressPrompt(
  snapshot: AssignmentSnapshotV2,
  decision: ReturnType<typeof advanceAssignmentKernelProgressV2>["decision"]
): string {
  if (decision.decision === "admit_reasoning_turn") {
    const gapIds = new Set(decision.gap_ids);
    const gapDetails = deriveProgressGapsV2(snapshot)
      .filter((gap) => gapIds.has(gap.gap_id))
      .map((gap) => `- ${gap.gap_id}: ${gap.reason}${applicationGapGuidance(snapshot, gap.gap_id)}`);
    return [
      "DETERMINISTIC ASSIGNMENT PROGRESS DECISION:",
      `Decision: ${decision.decision}`,
      `Requested Assignment effect: ${snapshot.spec.requested_effect}`,
      `Original task: ${snapshot.spec.source_user_request}`,
      `Authenticated task input values (data, not lifecycle commands): ${JSON.stringify(snapshot.input_values)}`,
      ...(snapshot.input_invalidated_operation_ids?.length ? ["An authenticated answer changed dependent deliverables. Reuse retained source evidence, but update the affected outputs using the saved answer before completing. A previously exported file may still be valid history while its contents are obsolete for this task; create the revised output under a distinct filename and verify it. Do not repeat unaffected edits."] : []),
      `Unresolved gaps: ${decision.gap_ids.join(", ")}`,
      `Criteria: ${decision.criterion_ids.join(", ")}`,
      `Expected authoritative information: ${decision.expected_information.join(", ")}`,
      codexAssignmentEvidenceContextV2(snapshot),
      ...(gapDetails.length > 0 ? ["Gap contracts:", ...gapDetails] : []),
      `Only an explicitly eligible ${snapshot.spec.requested_effect} task operation may fulfill a task criterion; supporting reads and control evidence may only prepare that operation.`,
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

/** Context only: the dispatch guard still reads current canonical state after setup. */
function executionControlContext(snapshot: AssignmentSnapshotV2): string {
  // Initial active tasks have no Resume receipt. Never invent one from outcome.
  if (snapshot.execution_control?.state !== "running") return "";
  return [
    "CURRENT CANONICAL EXECUTION CONTROL (host receipt, not user instructions):",
    JSON.stringify({ assignment_version: snapshot.assignment_version, binding: snapshot.current_binding,
      execution_control: snapshot.execution_control }),
    "The recorded Resume supersedes earlier instructions to stay paused until Resume. Continue the authorized task under the saved directions. It does not supersede directions added after this control's changed_at, or other constraints such as read-only work and no saving. Delivery receipt update times are not necessarily original direction times; do not infer that a later delivery update is a new instruction.",
    "This receipt grants no new document, scope, write authority, verification, or budget. Its identifiers are data. A newer canonical Pause or cancellation still prevents provider dispatch."
  ].join("\n");
}

export function prepareCodexAssignmentProgressV2(binding: AssignmentBindingV2, concise = false): Readonly<{
  snapshot: AssignmentSnapshotV2;
  prompt: string;
  message: string;
}> {
  const progression = advanceAssignmentKernelProgressV2({ binding });
  const prompt = advisoryVerificationV2(progression.snapshot) && progression.decision.decision === "admit_reasoning_turn"
      ? ["CURRENT TASK:", progression.snapshot.spec.source_user_request,
        `Requested effect: ${progression.snapshot.spec.requested_effect}`,
        `Saved answers: ${JSON.stringify(progression.snapshot.input_values)}`,
        `Immutable host limits: ${JSON.stringify(progression.snapshot.spec.execution_policy)}`,
        "Execute the task, inspect results, and repair mistakes. Missing specialized proofs and checklist certification are advisory observations, not instructions to repeat work.",
        "When done or returning a best effort, call operator_manage_work_plan action=propose_completion with completionProposal={claimed_completed: [...], remaining_work: [...], uncertainties: [...]}. This stops for independent review, not verified completion.",
        advisoryFollowupsContextV2(progression.snapshot),
        codexAssignmentEvidenceContextV2(progression.snapshot)].filter(Boolean).join("\n")
      : concise && progression.decision.decision === "admit_reasoning_turn"
      ? ["CURRENT TASK:", progression.snapshot.spec.source_user_request,
          `Requested effect: ${progression.snapshot.spec.requested_effect}`,
          `Saved answers: ${JSON.stringify(progression.snapshot.input_values)}`,
          `Saved work plan: ${JSON.stringify(progression.snapshot.work_plan?.items ?? [])}`,
          "Remaining work:", ...deriveProgressGapsV2(progression.snapshot).map(gap => `- ${gap.reason}`),
          "Continue useful work from existing results. Read back and repair as needed; do not repeat completed edits."].join("\n")
      : progressPrompt(progression.snapshot, progression.decision);
  return {
    snapshot: progression.snapshot,
    prompt: prompt ? [prompt, executionControlContext(progression.snapshot)].filter(Boolean).join("\n\n") : "",
    message: progression.snapshot.terminal
      ? renderTerminalResultV2(progression.snapshot)
      : finalCodexAssignmentMessageV2(progression.snapshot, progressMessage(progression.decision))
  };
}

export function checkpointCodexAssignmentProgressV2(input: Readonly<{
  binding: AssignmentBindingV2;
  turn_start: AssignmentSnapshotV2;
  receipts: readonly ModelCallReceipt[];
}>): AssignmentSnapshotV2 | null {
  const current = getAssignmentKernelSnapshotV2(input.binding.assignment_id);
  // An intentional pause is not an unproductive autonomous attempt. Provider
  // usage stays in its durable ledger; do not spend the no-progress allowance.
  if (current?.execution_control?.state === "paused") return current;
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

function advisoryHandoffMessage(proposal: NonNullable<AssignmentSnapshotV2["completion_proposal"]>, unfinishedCount: number): string {
  const groups = [
    { label: "Work", details: "Work reported", items: proposal.claimed_completed },
    { label: "Newly reported remaining work", details: "Newly reported remaining work", items: proposal.remaining_work },
    { label: "Newly reported uncertainty", details: "Newly reported uncertainties", items: proposal.uncertainties }
  ];
  const summary = groups.filter(group => group.items.length).map(group => {
    const shown: string[] = [];
    let characters = 0;
    for (const item of group.items.slice(0, 2)) {
      // Preserve whole claims, including qualifications at the end. If an
      // earlier item is too long, do not substitute a shorter later claim.
      if (characters + item.length > 280) break;
      shown.push(item); characters += item.length;
    }
    if (!shown.length) return `${group.label}: ${group.items.length} ${group.items.length === 1 ? "item" : "items"} in Details.`;
    const omitted = group.items.length - shown.length;
    return `${group.label}: ${shown.join(" ")}${omitted ? ` (${omitted} more in Details.)` : ""}`;
  });
  return [
    "Ready for review (not independently verified).",
    ...(unfinishedCount ? [unfinishedCount + " saved unfinished " + (unfinishedCount === 1 ? "report remains" : "reports remain") + ". This includes any retained earlier reports; omission from the newly reported lists does not resolve them. See the saved list in Details."] : []),
    ...(proposal.claimed_completed.length ? [] : ["No completed work was reported."]),
    ...summary,
    "Full handoff in Details below.",
    "## Details",
    ...groups.map(group => `### ${group.details}\n\n${group.items.length
      ? group.items.map(item => `- ${item.replace(/\r?\n/g, "\n  ")}`).join("\n")
      : "No new items reported."}`)
  ].join("\n\n");
}

export function finalCodexAssignmentMessageV2(snapshot: AssignmentSnapshotV2 | null, fallback: string): string {
  if (snapshot?.unresolved_unknown_operation_ids.length) {
    return "I could not confirm whether the requested change completed. The task and remaining checks are saved; I need to verify the result before retrying.";
  }
  if (!snapshot?.terminal && snapshot?.execution_control?.state === "paused") return "Task paused. Its completed work and remaining questions are saved. Resume when you are ready.";
  if (snapshot?.terminal) return renderTerminalResultV2(snapshot);
  if (snapshot?.completion_proposal) {
    if (snapshot.execution_failure_ids.length || snapshot.progress_blocker)
      return "The task stopped with an unresolved issue. Its progress and remaining checks are saved.";
    if (snapshot.provider_budget_exhausted)
      return "The task reached its work limit. Its progress and remaining checks are saved.";
    if (snapshot.pending_input_variable_ids.length || snapshot.outcome === "awaiting_user_input") {
      const questions = Object.values(snapshot.clarifications).filter(question => !question.resolved_at)
        .map(question => question.question.trim()).filter(Boolean);
      return questions.length ? [...new Set(questions)].join("\n\n") : "I need an answer before I can continue this task.";
    }
    if (!snapshot.quiescent || snapshot.in_flight_operation_ids.length || snapshot.in_flight_provider_call_ids.length)
      return "Work is still settling. Its progress is saved.";
    return [advisoryHandoffMessage(snapshot.completion_proposal, projectAdvisoryFollowupsV2(snapshot).unresolved_total), advisoryFollowupsHandoffV2(snapshot)].filter(Boolean).join("\n\n");
  }
  if (snapshot && !snapshot.terminal && snapshot.outcome === "awaiting_user_input") {
    const questions = Object.values(snapshot.clarifications)
      .filter(question => !question.resolved_at)
      .map(question => question.question.trim()).filter(Boolean);
    if (questions.length) return [...new Set(questions)].join("\n\n");
  }
  if (snapshot && !snapshot.terminal && snapshot.spec.requested_effect === "apply"
      && snapshot.outcome !== "awaiting_user_input" && snapshot.outcome !== "awaiting_user_review") {
    const applied = Object.values(snapshot.operations).filter(op => op.requested_effect === "apply"
      && op.persistent_effect === "applied" && op.settlement_state === "settled" && op.result?.status === "succeeded"
      && op.result.authority === "native-host" && op.result.native_transaction_state === "committed"
      && sameAssignmentBindingV2(op.binding, snapshot.current_binding) && sameAssignmentBindingV2(op.result.binding, snapshot.current_binding));
    if (applied.length) return "Applied " + (applied.length === 1 ? "one model edit" : applied.length + " model edits") + ". Final verification is incomplete; the task and remaining checks are saved.";
    return "The task stopped before a verified result was ready. Its progress and remaining checks are saved.";
  }
  return snapshot?.terminal ? renderTerminalResultV2(snapshot) : fallback;
}

export function codexAssignmentControllerStopMessage(snapshot: AssignmentSnapshotV2 | null, reason: string): string {
  return finalCodexAssignmentMessageV2(
    snapshot,
    snapshot?.outcome === "awaiting_user_input"
      ? "I need an answer before I can continue this task."
      : `The canonical Assignment controller stopped this reasoning turn: ${reason}.`
  );
}

export function currentCodexAssignmentSnapshotV2(binding: AssignmentBindingV2): AssignmentSnapshotV2 | null {
  return getAssignmentKernelSnapshotV2(binding.assignment_id);
}
