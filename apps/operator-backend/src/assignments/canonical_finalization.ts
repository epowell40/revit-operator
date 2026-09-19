import type { ChatRequest, ChatResponse } from "../contracts.js";
import { assignmentKernelV2ForBinding } from "./assignment_kernel_v2_factory.js";
import { deriveTerminalResultV2 } from "./assignment_kernel_v2_terminal_result.js";
import { canonicalAssignmentOutcomeForBinding } from "./outcome_handoff.js";
import { finalCodexAssignmentMessageV2 } from "../brains/codex_assignment_progress.js";

/** Presentation only: an exact persisted V2 terminal already owns execution and
 * verification. Legacy action-list guards cannot reconstruct that history from
 * an empty outer tool_results array. Never accept a provider-supplied snapshot
 * as authority, and never dispatch its leftover legacy actions. */
export function finalizeCanonicalAssignment(req: ChatRequest, decision: ChatResponse): ChatResponse | null {
  if (!req.assignment_id || !req.assignment_run_id || !Number.isSafeInteger(req.assignment_generation)
      || Number(req.assignment_generation) < 1) return null;
  const snapshot = assignmentKernelV2ForBinding({ session_id: req.session_id,
    assignment_id: req.assignment_id, run_id: req.assignment_run_id,
    generation: Number(req.assignment_generation) })?.snapshot;
  if (!snapshot?.terminal) return null;
  const outcome = canonicalAssignmentOutcomeForBinding({ session_id: req.session_id,
    assignment_id: req.assignment_id, assignment_run_id: req.assignment_run_id,
    assignment_generation: Number(req.assignment_generation) });
  return { ...decision, actions: [], assistant_message: finalCodexAssignmentMessageV2(snapshot, ""),
    assignment_snapshot_v2: snapshot, terminal_result_v2: deriveTerminalResultV2(snapshot),
    canonical_assignment_outcome: outcome ?? undefined };
}
