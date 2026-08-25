import { randomUUID } from "node:crypto";
import {
  ASSIGNMENT_ATTEMPT_EVENT_SCHEMA,
  normalizeAssignmentControlPlane,
  reduceAssignmentControlPlane,
  type AssignmentAttemptEvent,
  type AssignmentControlPlaneProjection
} from "./control_plane.js";
import { getGoal, mutateGoalRecord, type GoalRecord } from "../goals/service.js";
import { persistVerifiedWorkPacket } from "../work_packets/store.js";
import { notifyAssignmentSettlement } from "./settlement_signal.js";
import { persistWorkReturn } from "../work_returns/store.js";

export type AssignmentEventAppendResult = {
  goal: GoalRecord;
  projection: AssignmentControlPlaneProjection;
  accepted: boolean;
  quarantined_reason: string | null;
};

function bounded(value: unknown, max: number): string {
  const text = typeof value === "string" ? value.trim() : "";
  return text.length <= max ? text : text.slice(0, max);
}

/**
 * Atomically appends one canonical event to the existing Goal record. A stale,
 * terminal, or semantically invalid callback is retained in quarantine while
 * leaving the authoritative event stream and verdict unchanged.
 */
export function appendAssignmentEvent(goalId: string, event: AssignmentAttemptEvent): AssignmentEventAppendResult {
  let accepted = false;
  let quarantinedReason: string | null = null;
  const goal = mutateGoalRecord(goalId, current => {
    const controlPlane = normalizeAssignmentControlPlane(current.assignment_control_plane);
    const duplicate = [...controlPlane.events, ...controlPlane.quarantined_events.map(entry => entry.event)]
      .some(candidate => candidate.event_id === event.event_id);
    if (!duplicate) {
      const goalTerminal = current.status === "complete" || current.status === "canceled" || current.status === "failed";
      const candidate = goalTerminal
        ? { rejected: [{ event, reason: `Goal is terminal (${current.status}).` }] }
        : reduceAssignmentControlPlane(current.id, [...controlPlane.events, event]);
      const rejection = candidate.rejected.find(entry => entry.event.event_id === event.event_id);
      if (rejection) {
        quarantinedReason = rejection.reason;
        controlPlane.quarantined_events.push({ event, reason: rejection.reason, quarantined_at: new Date().toISOString() });
      } else {
        accepted = true;
        controlPlane.events.push(event);
      }
    } else {
      accepted = controlPlane.events.some(candidate => candidate.event_id === event.event_id);
      quarantinedReason = accepted ? null : "Duplicate quarantined event.";
    }
    const acceptedProjection = reduceAssignmentControlPlane(current.id, controlPlane.events).projection;
    if (accepted && acceptedProjection.terminal_state !== "open") {
      const status = acceptedProjection.terminal_state === "verified" || acceptedProjection.terminal_state === "complete"
        ? "complete"
        : acceptedProjection.terminal_state === "canceled" ? "canceled"
          : acceptedProjection.terminal_state === "failed" ? "failed" : "blocked";
      return {
        ...current,
        status,
        current_phase: "settled",
        current_step: null,
        finished_at: event.occurred_at,
        progress_summary: acceptedProjection.terminal_reason ?? `Assignment ${status}.`,
        ...(status === "blocked" ? { blocker: acceptedProjection.terminal_reason ?? current.blocker ?? "Blocked." } : {}),
        ...(status === "failed" ? { error: acceptedProjection.terminal_reason ?? current.error ?? "Assignment failed." } : {}),
        assignment_control_plane: controlPlane
      };
    }
    if (accepted && acceptedProjection.outcome_state === "awaiting_user_input") {
      const pending = acceptedProjection.clarifications.find(item => item.clarification_id === acceptedProjection.pending_clarification_id);
      return {
        ...current,
        status: "paused",
        current_phase: "awaiting_user_input",
        current_step: pending?.question ?? "Awaiting required user input.",
        progress_summary: pending?.completed_work.length
          ? `Awaiting user input after retaining ${pending.completed_work.length} completed work item(s).`
          : "Awaiting required user input; the Assignment remains resumable.",
        blocker: null,
        finished_at: null,
        assignment_control_plane: controlPlane
      };
    }
    if (accepted && event.kind === "clarification_resolved") {
      return {
        ...current,
        status: "active",
        current_phase: "planning",
        current_step: "Resume from the resolved clarification.",
        progress_summary: "Authenticated user input was bound to the existing Assignment; completed work remains retained.",
        blocker: null,
        finished_at: null,
        assignment_control_plane: controlPlane
      };
    }
    return { ...current, assignment_control_plane: controlPlane };
  });
  const controlPlane = normalizeAssignmentControlPlane(goal.assignment_control_plane);
  const projection = reduceAssignmentControlPlane(goal.id, controlPlane.events).projection;
  notifyAssignmentSettlement(projection);
  if (projection.terminal_state !== "open") persistVerifiedWorkPacket(goal);
  if (accepted && (event.kind === "clarification_requested" || event.kind === "clarification_resolved" || event.kind === "assignment_terminal")) {
    try { persistWorkReturn(goal); } catch { /* Audit-artifact failure must not rewrite canonical model truth. */ }
  }
  return {
    goal,
    projection,
    accepted,
    quarantined_reason: quarantinedReason
  };
}

export function beginAssignmentRun(goalId: string, runId: string, actor: string): AssignmentEventAppendResult {
  const goal = getGoal(goalId);
  if (!goal) throw new Error("Goal not found.");
  const projection = reduceAssignmentControlPlane(goal.id, normalizeAssignmentControlPlane(goal.assignment_control_plane).events).projection;
  return appendAssignmentEvent(goal.id, {
    schema: ASSIGNMENT_ATTEMPT_EVENT_SCHEMA,
    event_id: randomUUID(),
    assignment_id: goal.id,
    run_id: bounded(runId, 200) || randomUUID(),
    generation: projection.generation + 1,
    attempt_id: null,
    kind: "run_started",
    occurred_at: new Date().toISOString(),
    actor: bounded(actor, 160) || "operator-backend",
    data: {
      previous_run_id: projection.run_id,
      requested_effect: ["read", "preview", "apply"].includes(String(goal.work_budget?.requested_effect || ""))
        ? goal.work_budget?.requested_effect
        : projection.requested_effect
    }
  });
}
