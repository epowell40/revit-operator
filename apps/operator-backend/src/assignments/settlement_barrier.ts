import { createHash } from "node:crypto";
import {
  ASSIGNMENT_ATTEMPT_EVENT_SCHEMA,
  normalizeAssignmentControlPlane,
  reduceAssignmentControlPlane,
  type AssignmentAttemptEvent,
  type AssignmentAttemptRecord,
  type AssignmentControlPlaneProjection,
  type AssignmentTerminalState
} from "./control_plane.js";
import { appendAssignmentEvent } from "./control_plane_store.js";
import { observeAssignmentSettlement } from "./settlement_signal.js";
import { getGoal } from "../goals/service.js";

function projection(assignmentId: string): AssignmentControlPlaneProjection {
  const goal = getGoal(assignmentId);
  if (!goal) throw new Error("Assignment not found.");
  return reduceAssignmentControlPlane(
    goal.id,
    normalizeAssignmentControlPlane(goal.assignment_control_plane).events
  ).projection;
}

function event(
  current: AssignmentControlPlaneProjection,
  attemptId: string | null,
  kind: AssignmentAttemptEvent["kind"],
  data: Record<string, unknown>,
  at: string
): AssignmentAttemptEvent {
  const identity = JSON.stringify({ assignment_id: current.assignment_id, run_id: current.run_id, generation: current.generation, attempt_id: attemptId, kind, data, at });
  return {
    schema: ASSIGNMENT_ATTEMPT_EVENT_SCHEMA,
    event_id: `sha256:${createHash("sha256").update(identity).digest("hex")}`,
    assignment_id: current.assignment_id,
    run_id: current.run_id!,
    generation: current.generation,
    attempt_id: attemptId,
    kind,
    occurred_at: at,
    actor: "assignment_settlement_barrier",
    data
  };
}

function append(current: AssignmentControlPlaneProjection, attemptId: string | null, kind: AssignmentAttemptEvent["kind"], data: Record<string, unknown>, at: string): AssignmentControlPlaneProjection {
  return appendAssignmentEvent(current.assignment_id, event(current, attemptId, kind, data, at)).projection;
}

function expired(attempt: AssignmentAttemptRecord, nowMs: number): boolean {
  const deadline = Date.parse(attempt.lease.deadline_at);
  return Number.isFinite(deadline) && deadline <= nowMs;
}

export function settleAssignmentExpiredWork(assignmentId: string, now = new Date()): AssignmentControlPlaneProjection {
  let current = projection(assignmentId);
  if (current.terminal_state !== "open") return current;
  const nowMs = now.getTime();
  const at = now.toISOString();
  for (const pending of current.attempts.filter(attempt =>
    attempt.generation === current.generation && attempt.terminal_state === "active" && expired(attempt, nowMs))) {
    const attempt = current.attempts.find(candidate => candidate.attempt_id === pending.attempt_id) ?? pending;
    const mayHaveDispatched = attempt.dispatch.state === "dispatched" || attempt.dispatch.state === "acknowledged"
      || attempt.lease.state === "dispatching" || attempt.lease.state === "dispatched" || attempt.lease.state === "retaining_evidence";
    if (attempt.requested_effect === "apply" && mayHaveDispatched) {
      current = append(current, attempt.attempt_id, "effect_recorded", {
        effect_state: "unknown",
        effect_authority: "dispatch_transport",
        authority_id: attempt.dispatch.dispatch_id,
        reason: "operation_deadline_elapsed_after_possible_dispatch",
        receipt_refs: attempt.receipt_refs,
        evidence_refs: attempt.evidence_refs,
        settlement_pending_evidence: true
      }, at);
      current = append(current, attempt.attempt_id, "lease_recorded", {
        lease_state: "effect_unknown",
        reason: "reconciliation_required_after_operation_deadline"
      }, at);
      continue;
    }
    current = append(current, attempt.attempt_id, "effect_recorded", {
      effect_state: "none",
      effect_authority: mayHaveDispatched ? "worker" : "transport_pre_dispatch",
      authority_id: attempt.dispatch.dispatch_id,
      reason: attempt.requested_effect === "read"
        ? "read_result_deadline_elapsed_without_task_evidence"
        : "preview_deadline_elapsed_without_authoritative_completion",
      receipt_refs: attempt.receipt_refs,
      evidence_refs: attempt.evidence_refs,
      settlement_pending_evidence: true
    }, at);
    current = append(current, attempt.attempt_id, "attempt_terminal", {
      lease_state: attempt.requested_effect === "read" ? "timed_out_read" : "settled",
      reason: "operation_deadline_elapsed"
    }, at);
  }
  return current;
}

export function cancelAssignmentInFlight(assignmentId: string, now = new Date()): {
  projection: AssignmentControlPlaneProjection;
  deferred: boolean;
  pending_attempt_ids: string[];
} {
  let current = projection(assignmentId);
  const at = now.toISOString();
  for (const pending of current.attempts.filter(attempt => attempt.generation === current.generation && attempt.terminal_state === "active")) {
    const mayHaveDispatched = pending.dispatch.state === "dispatched" || pending.dispatch.state === "acknowledged"
      || ["dispatching", "dispatched", "retaining_evidence"].includes(pending.lease.state);
    if (!mayHaveDispatched) {
      current = append(current, pending.attempt_id, "effect_recorded", {
        effect_state: "none", effect_authority: "transport_pre_dispatch", reason: "canceled_before_dispatch",
        settlement_pending_evidence: true
      }, at);
      current = append(current, pending.attempt_id, "lease_recorded", { lease_state: "canceled_before_dispatch" }, at);
    } else if (pending.requested_effect === "apply") {
      current = append(current, pending.attempt_id, "effect_recorded", {
        effect_state: "unknown", effect_authority: "dispatch_transport", reason: "canceled_after_possible_apply_dispatch",
        authority_id: pending.dispatch.dispatch_id, settlement_pending_evidence: true
      }, at);
      current = append(current, pending.attempt_id, "lease_recorded", { lease_state: "canceled_after_dispatch" }, at);
    }
  }
  const stillPending = current.in_flight_attempt_ids;
  return { projection: current, deferred: stillPending.length > 0, pending_attempt_ids: stillPending };
}

export function requestAssignmentTerminal(
  assignmentId: string,
  terminalState: Exclude<AssignmentTerminalState, "open">,
  reason: string,
  now = new Date()
): { projection: AssignmentControlPlaneProjection; accepted: boolean; reason: string | null } {
  const current = projection(assignmentId);
  const result = appendAssignmentEvent(assignmentId, event(current, null, "assignment_terminal", {
    terminal_state: terminalState,
    reason
  }, now.toISOString()));
  return { projection: result.projection, accepted: result.accepted, reason: result.quarantined_reason };
}

export async function awaitAssignmentQuiescence(assignmentId: string): Promise<AssignmentControlPlaneProjection> {
  let current = projection(assignmentId);
  if (current.quiescent || current.terminal_state !== "open") return current;
  return await new Promise<AssignmentControlPlaneProjection>((resolve, reject) => {
    let timer: NodeJS.Timeout | null = null;
    const stop = observeAssignmentSettlement(assignmentId, next => {
      current = next;
      if (next.quiescent || next.terminal_state !== "open") finish(next);
      else schedule(next);
    });
    const finish = (value: AssignmentControlPlaneProjection) => {
      if (timer) clearTimeout(timer);
      stop();
      resolve(value);
    };
    const schedule = (value: AssignmentControlPlaneProjection) => {
      if (timer) clearTimeout(timer);
      const deadline = Date.parse(value.next_in_flight_deadline ?? "");
      if (!Number.isFinite(deadline)) {
        stop();
        reject(new Error("assignment_in_flight_deadline_missing"));
        return;
      }
      const waitMs = Math.max(0, deadline - Date.now());
      timer = setTimeout(() => {
        try {
          const settled = settleAssignmentExpiredWork(assignmentId, new Date(deadline));
          if (settled.quiescent || settled.terminal_state !== "open") finish(settled);
          else schedule(settled);
        } catch (error) {
          stop();
          reject(error);
        }
      }, waitMs);
    };
    schedule(current);
  });
}
