import { randomUUID } from "node:crypto";
import {
  ASSIGNMENT_ATTEMPT_EVENT_SCHEMA,
  normalizeAssignmentControlPlane,
  reduceAssignmentControlPlane,
  type AssignmentAttemptEvent,
  type AssignmentControlPlaneProjection
} from "./control_plane.js";
import { getGoal, mutateGoalRecord, type GoalRecord } from "../goals/service.js";

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
    return { ...current, assignment_control_plane: controlPlane };
  });
  const controlPlane = normalizeAssignmentControlPlane(goal.assignment_control_plane);
  return {
    goal,
    projection: reduceAssignmentControlPlane(goal.id, controlPlane.events).projection,
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
    data: { previous_run_id: projection.run_id }
  });
}
