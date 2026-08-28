import type { CanonicalAssignmentOutcomeV1, ChatRequest } from "../contracts.js";
import { getGoal, type GoalRecord } from "../goals/service.js";
import { getRequestPrincipal } from "../request_context.js";
import { AssignmentJournalV2, type AssignmentSnapshotV2 } from "../domain/assignment-kernel/index.js";
import { normalizeAssignmentControlPlane, reduceAssignmentControlPlane } from "./control_plane.js";
import { normalizeAssignmentKernelJournalV2 } from "./assignment_kernel_v2_store.js";

export const CANONICAL_ASSIGNMENT_OUTCOME_SCHEMA = "revit-operator.canonical-assignment-outcome/v1" as const;

type Binding = Required<Pick<ChatRequest,
  "session_id" | "assignment_id" | "assignment_run_id" | "assignment_generation"
>>;

function bounded(value: unknown, max: number): string {
  const text = typeof value === "string" ? value.trim() : "";
  return text.length <= max ? text : text.slice(0, max);
}

function principalMayRead(createdBy: string | null | undefined): boolean {
  if (!createdBy) return true;
  const principal = getRequestPrincipal();
  return Boolean(principal && (principal.user_id === createdBy || principal.sub === createdBy));
}

function terminalStateV2(snapshot: AssignmentSnapshotV2): CanonicalAssignmentOutcomeV1["terminal_state"] {
  if (!snapshot.terminal) return "open";
  if (snapshot.outcome === "verified_noop") return "verified";
  if (snapshot.outcome === "complete" || snapshot.outcome === "complete_with_issues") return "complete";
  if (snapshot.outcome === "blocked") return "blocked";
  return "failed";
}

function ordinal(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function exactV2Outcome(
  goal: GoalRecord,
  snapshot: AssignmentSnapshotV2,
  sessionId: string,
  runId: string,
  generation: number
): CanonicalAssignmentOutcomeV1 | null {
  if (snapshot.current_binding.assignment_id !== goal.id
      || snapshot.current_binding.session_id !== sessionId
      || snapshot.current_binding.run_id !== runId
      || snapshot.current_binding.generation !== generation
      || (goal.created_by && snapshot.current_binding.principal_id !== goal.created_by)) return null;
  const clarification = Object.values(snapshot.clarifications)
    .filter(item => !item.resolved_at && snapshot.pending_input_variable_ids.includes(item.variable_id))
    .sort((left, right) => ordinal(left.requested_at, right.requested_at)
      || ordinal(left.clarification_id, right.clarification_id))[0] ?? null;
  const journal = normalizeAssignmentKernelJournalV2(goal.assignment_kernel_v2);
  return {
    schema: CANONICAL_ASSIGNMENT_OUTCOME_SCHEMA,
    assignment_id: goal.id,
    run_id: runId,
    generation,
    session_id: sessionId,
    requested_effect: snapshot.spec.requested_effect,
    outcome_state: snapshot.outcome,
    terminal_state: terminalStateV2(snapshot),
    terminal_reason: bounded(snapshot.terminal_reason, 1_000) || null,
    quiescent: snapshot.quiescent,
    pending_clarification: clarification ? {
      clarification_id: bounded(clarification.clarification_id, 240),
      question: bounded(clarification.question, 1_200),
      missing_fields: [bounded(clarification.variable_id, 160)].filter(Boolean)
    } : null,
    pending_review_id: bounded(snapshot.pending_review_ids[0], 240) || null,
    last_event_at: journal.events.at(-1)?.occurred_at ?? null,
    authority: "canonical_assignment_control_plane"
  };
}

/**
 * Projects the exact bound Assignment after a controller has committed its
 * turn outcome. V2 Assignments are read from their exact kernel snapshot; the
 * legacy control-plane projection is retained only for historical V1 runs.
 * Any stale, foreign-session, or foreign-principal binding is omitted rather
 * than guessed from the active session.
 */
export function canonicalAssignmentOutcomeForBinding(
  binding: Binding
): CanonicalAssignmentOutcomeV1 | null {
  const assignmentId = bounded(binding.assignment_id, 240);
  const runId = bounded(binding.assignment_run_id, 240);
  const sessionId = bounded(binding.session_id, 180);
  const generation = Number(binding.assignment_generation);
  if (!assignmentId || !runId || !sessionId || !Number.isSafeInteger(generation) || generation < 1) return null;
  const goal = getGoal(assignmentId);
  if (!goal || goal.related_session_id !== sessionId || !principalMayRead(goal.created_by)) return null;
  const kernelJournal = normalizeAssignmentKernelJournalV2(goal.assignment_kernel_v2);
  const kernelSnapshot = kernelJournal.events.length > 0 ? new AssignmentJournalV2(kernelJournal.events).snapshot() : null;
  if (kernelSnapshot) return exactV2Outcome(goal, kernelSnapshot, sessionId, runId, generation);
  const projection = reduceAssignmentControlPlane(
    goal.id,
    normalizeAssignmentControlPlane(goal.assignment_control_plane).events
  ).projection;
  if (projection.run_id !== runId || projection.generation !== generation) return null;
  const clarification = projection.pending_clarification_id
    ? projection.clarifications.find(item => item.clarification_id === projection.pending_clarification_id && item.status === "pending")
    : null;
  return {
    schema: CANONICAL_ASSIGNMENT_OUTCOME_SCHEMA,
    assignment_id: goal.id,
    run_id: projection.run_id,
    generation: projection.generation,
    session_id: sessionId,
    requested_effect: projection.requested_effect,
    outcome_state: projection.outcome_state,
    terminal_state: projection.terminal_state,
    terminal_reason: bounded(projection.terminal_reason, 1_000) || null,
    quiescent: projection.quiescent,
    pending_clarification: clarification ? {
      clarification_id: bounded(clarification.clarification_id, 240),
      question: bounded(clarification.question, 1_200),
      missing_fields: clarification.missing_fields.map(field => bounded(field, 160)).filter(Boolean).slice(0, 32)
    } : null,
    pending_review_id: bounded(projection.pending_review_id, 240) || null,
    last_event_at: projection.last_event_at,
    authority: "canonical_assignment_control_plane"
  };
}
