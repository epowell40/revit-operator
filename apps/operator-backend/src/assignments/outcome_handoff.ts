import type { CanonicalAssignmentOutcomeV1, ChatRequest } from "../contracts.js";
import { getGoal } from "../goals/service.js";
import { getRequestPrincipal } from "../request_context.js";
import { normalizeAssignmentControlPlane, reduceAssignmentControlPlane } from "./control_plane.js";

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

/**
 * Projects the exact bound Assignment after a controller has committed its
 * turn outcome. Any stale, foreign-session, or foreign-principal binding is
 * omitted rather than guessed from the active session.
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
