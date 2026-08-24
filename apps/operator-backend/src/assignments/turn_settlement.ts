import { createHash } from "node:crypto";
import type { ChatResponse } from "../contracts.js";
import { getActiveGoalForSession } from "../goals/service.js";
import {
  ASSIGNMENT_ATTEMPT_EVENT_SCHEMA,
  assignmentActionSignature,
  normalizeAssignmentControlPlane,
  reduceAssignmentControlPlane,
  type AssignmentAttemptEvent,
  type AssignmentAttemptRecord,
  type AssignmentControlPlaneProjection,
  type AssignmentProgressInput,
  type AssignmentRequestedEffect
} from "./control_plane.js";
import { appendAssignmentEvent } from "./control_plane_store.js";
import { validateLatestReadCompletionClaim } from "./read_completion.js";

type TeammateReceipt = NonNullable<ChatResponse["teammate_loop_receipt"]>;

export type AssignmentTurnSettlement = {
  projection: AssignmentControlPlaneProjection | null;
  completed: boolean;
  verified_noop: boolean;
  successful_tools: number;
  reason: string;
};

export type AssignmentReportedTerminalSettlement = {
  projection: AssignmentControlPlaneProjection | null;
  accepted: boolean;
  reason: string;
};

function hash(value: unknown): string {
  return `sha256:${createHash("sha256").update(JSON.stringify(value), "utf8").digest("hex")}`;
}

function eventFor(
  projection: AssignmentControlPlaneProjection,
  kind: AssignmentAttemptEvent["kind"],
  attemptId: string | null,
  actor: string,
  data: Record<string, unknown>,
  stable: unknown
): AssignmentAttemptEvent {
  return {
    schema: ASSIGNMENT_ATTEMPT_EVENT_SCHEMA,
    event_id: hash({ assignment_id: projection.assignment_id, run_id: projection.run_id, generation: projection.generation, kind, attempt_id: attemptId, stable }),
    assignment_id: projection.assignment_id,
    run_id: projection.run_id ?? "",
    generation: projection.generation,
    attempt_id: attemptId,
    kind,
    occurred_at: new Date().toISOString(),
    actor,
    data
  };
}

function current(sessionId: string): { projection: AssignmentControlPlaneProjection; events: AssignmentAttemptEvent[] } | null {
  const goal = getActiveGoalForSession(sessionId);
  if (!goal) return null;
  const events = normalizeAssignmentControlPlane(goal.assignment_control_plane).events;
  return { projection: reduceAssignmentControlPlane(goal.id, events).projection, events };
}

function append(
  projection: AssignmentControlPlaneProjection,
  kind: AssignmentAttemptEvent["kind"],
  attemptId: string | null,
  data: Record<string, unknown>,
  stable: unknown
): AssignmentControlPlaneProjection {
  return appendAssignmentEvent(
    projection.assignment_id,
    eventFor(projection, kind, attemptId, "assignment_turn_settlement", data, stable)
  ).projection;
}

function latestApply(projection: AssignmentControlPlaneProjection, preferredId?: string | null): AssignmentAttemptRecord | null {
  return (preferredId ? projection.attempts.find(attempt => attempt.attempt_id === preferredId) : null)
    ?? [...projection.attempts].reverse().find(attempt => attempt.requested_effect === "apply")
    ?? null;
}

function exactVerificationAttempt(
  projection: AssignmentControlPlaneProjection,
  applied: AssignmentAttemptRecord,
  preferredId?: string | null
): AssignmentAttemptRecord | null {
  const preferred = preferredId ? projection.attempts.find(attempt => attempt.attempt_id === preferredId) : null;
  if (preferred?.requested_effect === "read" && preferred.target_fingerprint === applied.target_fingerprint) return preferred;
  return [...projection.attempts].reverse().find(attempt =>
    attempt.requested_effect === "read" && attempt.target_fingerprint === applied.target_fingerprint
    && (attempt.purpose === "verification" || attempt.purpose === "reconciliation")) ?? null;
}

function createVerification(
  projection: AssignmentControlPlaneProjection,
  applied: AssignmentAttemptRecord,
  evidenceRef: string,
  preferredId?: string | null
): AssignmentControlPlaneProjection {
  let verification = exactVerificationAttempt(projection, applied, preferredId);
  if (!verification || verification.purpose !== "verification") {
    const attemptId = `verification:${hash({ applied: applied.attempt_id, evidenceRef }).slice(7, 31)}`;
    projection = append(projection, "attempt_opened", attemptId, {
      purpose: "verification",
      requested_effect: "read",
      action_path: verification?.action_path || applied.action_path,
      tool_identity: "canonical_bounded_verifier",
      action_signature: assignmentActionSignature({
        requested_effect: "read", action_path: verification?.action_path || applied.action_path,
        tool_identity: "canonical_bounded_verifier", request: { applied_attempt_id: applied.attempt_id, evidence_ref: evidenceRef }
      }),
      target_fingerprint: applied.target_fingerprint,
      target_identities: applied.affected_target_identities.length ? applied.affected_target_identities : applied.target_identities,
      expected_postconditions: applied.expected_postconditions,
      reconciliation_of_attempt_id: applied.attempt_id
    }, { applied: applied.attempt_id, evidenceRef });
    projection = append(projection, "admission_recorded", attemptId, {
      admission_state: "admitted", authority: "canonical_bounded_verifier"
    }, { attemptId, admitted: true });
    projection = append(projection, "dispatch_recorded", attemptId, {
      dispatch_state: "acknowledged", dispatch_id: preferredId ?? attemptId,
      reason: "target_bound_verification_evidence_received"
    }, { attemptId, dispatch: "acknowledged" });
    verification = projection.attempts.find(attempt => attempt.attempt_id === attemptId) ?? null;
  }
  if (!verification) return projection;
  return append(projection, "verification_recorded", verification.attempt_id, {
    verification_state: "passed",
    applied_attempt_id: applied.attempt_id,
    reason: "exact_target_postconditions_verified",
    evidence_refs: [evidenceRef]
  }, { verification: verification.attempt_id, applied: applied.attempt_id, evidenceRef });
}

function settleTeammateReceipt(
  projection: AssignmentControlPlaneProjection,
  receipt?: TeammateReceipt | null
): AssignmentControlPlaneProjection {
  if (!receipt?.verified || (receipt.apply_attempts ?? 0) < 1 || !receipt.verification_evidence_sha256) return projection;
  const applied = latestApply(projection, receipt.apply_action_id);
  if (!applied) return projection;
  const evidenceRef = `teammate-verification:${receipt.verification_evidence_sha256}`;
  const mode = receipt.verification_mode;
  if (applied.effect.state === "unknown" && mode === "target_bound_readback") {
    const reconciliation = exactVerificationAttempt(projection, applied, receipt.verification_action_id);
    if (reconciliation?.purpose === "reconciliation") {
      projection = append(projection, "reconciliation_resolved", reconciliation.attempt_id, {
        effect_state: "applied", reason: "target_bound_readback_found_applied_result",
        affected_target_identities: reconciliation.target_identities,
        evidence_refs: [evidenceRef], authority_id: receipt.verification_action_id
      }, { original: applied.attempt_id, evidenceRef, resolution: "applied" });
    } else {
      projection = append(projection, "effect_recorded", applied.attempt_id, {
        effect_state: "applied", effect_authority: "target_readback",
        reason: "target_bound_readback_found_applied_result", evidence_refs: [evidenceRef],
        authority_id: receipt.verification_action_id,
        affected_target_identities: applied.target_identities
      }, { applied: applied.attempt_id, evidenceRef, authority: "target_readback" });
    }
  } else if (applied.effect.state === "unknown" && mode === "trusted_dynamic_program_receipt") {
    projection = append(projection, "effect_recorded", applied.attempt_id, {
      effect_state: "applied", effect_authority: "native_receipt",
      reason: "trusted_dynamic_runtime_receipt", evidence_refs: [evidenceRef],
      authority_id: receipt.verification_action_id, affected_target_identities: applied.target_identities
    }, { applied: applied.attempt_id, evidenceRef, authority: "native_receipt" });
  }
  const authoritative = projection.attempts.find(attempt => attempt.attempt_id === applied.attempt_id);
  // An explicit caller-shaped apply receipt cannot promote unknown truth. It
  // reaches here only if the native envelope already established `applied`.
  if (authoritative?.effect.state !== "applied") return projection;
  return createVerification(projection, authoritative, evidenceRef, receipt.verification_action_id);
}

function terminalEvent(projection: AssignmentControlPlaneProjection, state: "complete" | "blocked", reason: string) {
  return append(projection, "assignment_terminal", null, {
    terminal_state: state, reason
  }, { state, reason });
}

function readCompletion(projection: AssignmentControlPlaneProjection): AssignmentAttemptRecord[] {
  return projection.attempts.filter(attempt => attempt.requested_effect === "read"
    && attempt.dispatch.state === "acknowledged" && attempt.receipt_refs.length > 0 && attempt.effect.state === "none"
    && ["native_host", "native_receipt", "target_readback", "independent_verifier"].includes(attempt.effect.authority));
}

function settleVerifiedNoop(projection: AssignmentControlPlaneProjection): { projection: AssignmentControlPlaneProjection; verified: boolean } {
  const reads = readCompletion(projection);
  for (const latest of [...reads].reverse()) {
    const sameTarget = reads.filter(attempt => attempt.target_fingerprint === latest.target_fingerprint);
    const refs = [...new Set(sameTarget.flatMap(attempt => attempt.receipt_refs))];
    if (sameTarget.length < 2 || refs.length < 2) continue;
    projection = append(projection, "effect_recorded", latest.attempt_id, {
      effect_state: "none", effect_authority: "target_readback", reason: "verified_noop",
      evidence_refs: refs.slice(-2), affected_target_identities: latest.target_identities
    }, { attempt: latest.attempt_id, refs: refs.slice(-2), verified_noop: true });
    projection = terminalEvent(projection, "complete", "verified_noop_two_fresh_target_observations");
    return { projection, verified: projection.terminal_state === "complete" };
  }
  return { projection, verified: false };
}

export function settleAssignmentTurn(
  sessionId: string,
  requestedEffect: AssignmentRequestedEffect,
  teammateReceipt?: TeammateReceipt | null
): AssignmentTurnSettlement {
  const state = current(sessionId);
  if (!state) return { projection: null, completed: false, verified_noop: false, successful_tools: 0, reason: "no_active_assignment" };
  if (!state.projection.run_id) {
    return { projection: null, completed: false, verified_noop: false, successful_tools: 0, reason: "canonical_run_not_started" };
  }
  let projection = settleTeammateReceipt(state.projection, teammateReceipt);
  let verifiedNoop = false;
  if (projection.terminal_state === "open" && requestedEffect === "apply"
      && !projection.attempts.some(attempt => attempt.requested_effect === "apply")) {
    const noop = settleVerifiedNoop(projection);
    projection = noop.projection;
    verifiedNoop = noop.verified;
  }
  if (projection.terminal_state === "open" && requestedEffect === "preview") {
    const rollback = [...projection.attempts].reverse().find(attempt => attempt.requested_effect === "preview"
      && attempt.effect.state === "none" && attempt.effect.authority === "native_rollback" && attempt.receipt_refs.length > 0);
    if (rollback) projection = terminalEvent(projection, "complete", "native_rollback_preview_verified");
  }
  let readCompletionReason: string | null = null;
  if (projection.terminal_state === "open" && requestedEffect === "read") {
    const validation = validateLatestReadCompletionClaim(sessionId);
    projection = validation.projection;
    readCompletionReason = validation.reason;
    if (validation.accepted && projection.terminal_state === "open") {
      projection = terminalEvent(projection, "complete", "authoritative_read_completed");
    }
  }
  const completed = projection.terminal_state === "complete" || projection.terminal_state === "verified";
  const successfulTools = projection.attempts.filter(attempt => attempt.dispatch.state === "acknowledged"
    && attempt.receipt_refs.length > 0).length;
  return {
    projection, completed, verified_noop: verifiedNoop, successful_tools: successfulTools,
    reason: projection.terminal_reason ?? readCompletionReason
      ?? (projection.unresolved_unknown_attempt_ids.length ? "effect_reconciliation_required" : "canonical_completion_not_established")
  };
}

/**
 * Accepts an outer-controller blocked verdict only when it names the active
 * run generation and canonical truth proves that neither an unresolved nor an
 * applied mutation exists. The caller controls execution, never effect truth.
 */
export function settleAssignmentReportedBlocked(
  sessionId: string,
  runId: string | null | undefined,
  generation: number | null | undefined,
  reason: string
): AssignmentReportedTerminalSettlement {
  const state = current(sessionId);
  if (!state || !state.projection.run_id) {
    return { projection: null, accepted: false, reason: "canonical_run_not_started" };
  }
  let projection = state.projection;
  if (projection.terminal_state !== "open") {
    return { projection, accepted: false, reason: `assignment_terminal:${projection.terminal_state}` };
  }
  if (runId !== projection.run_id || generation !== projection.generation) {
    return { projection, accepted: false, reason: "stale_or_unbound_outer_report" };
  }
  if (projection.unresolved_unknown_attempt_ids.length > 0) {
    return { projection, accepted: false, reason: "effect_reconciliation_required" };
  }
  if (projection.attempts.some(attempt => attempt.effect.state === "applied")) {
    return { projection, accepted: false, reason: "post_apply_verification_required" };
  }
  projection = terminalEvent(projection, "blocked", reason.trim().slice(0, 1000) || "outer_execution_stopped_without_effect");
  return { projection, accepted: projection.terminal_state === "blocked", reason: projection.terminal_reason ?? "outer_execution_stopped_without_effect" };
}

export function settleAssignmentProviderFailure(
  sessionId: string,
  assignmentId: string,
  runId: string,
  generation: number,
  reason: string
): AssignmentReportedTerminalSettlement {
  const state = current(sessionId);
  if (!state || state.projection.assignment_id !== assignmentId || state.projection.run_id !== runId
      || state.projection.generation !== generation) {
    return { projection: state?.projection ?? null, accepted: false, reason: "stale_or_unbound_provider_failure" };
  }
  if (state.projection.terminal_state !== "open") {
    return { projection: state.projection, accepted: false, reason: `assignment_terminal:${state.projection.terminal_state}` };
  }
  const unresolved = state.projection.unresolved_unknown_attempt_ids.length > 0;
  const applied = state.projection.attempts.some(attempt => attempt.effect.state === "applied");
  const terminalReason = unresolved
    ? `provider_failure_with_unknown_effect:${reason}`
    : applied ? `provider_failure_after_apply_verification_incomplete:${reason}`
      : `provider_failure_no_continuation:${reason}`;
  const projection = append(state.projection, "assignment_terminal", null, {
    terminal_state: "failed", reason: terminalReason.slice(0, 1000)
  }, { assignmentId, runId, generation, terminalReason });
  return { projection, accepted: projection.terminal_state === "failed", reason: projection.terminal_reason ?? terminalReason };
}

function progressSnapshot(input: AssignmentProgressInput): Record<string, unknown> {
  return {
    grounded_targets: input.grounded_targets,
    verified_facts: input.verified_facts,
    action_signature: input.action_signature,
    plan_signature: input.plan_signature,
    model_state_signature: input.model_state_signature,
    tool_family: input.tool_family
  };
}

export function recordAssignmentTurnProgress(sessionId: string, turnId: string): AssignmentControlPlaneProjection | null {
  const state = current(sessionId);
  if (!state || state.projection.terminal_state !== "open") return state?.projection ?? null;
  let projection = state.projection;
  const goal = getActiveGoalForSession(sessionId);
  const previous = [...state.events].reverse().find(event =>
    event.kind === "progress_recorded" && event.data?.snapshot && typeof event.data.snapshot === "object");
  const prior = previous?.data?.snapshot && typeof previous.data.snapshot === "object"
    ? previous.data.snapshot as Record<string, unknown> : {};
  const attempts = projection.attempts.filter(attempt => attempt.generation === projection.generation);
  const latest = attempts.at(-1);
  const groundedTargets = [...new Set(attempts.flatMap(attempt => attempt.target_identities.length
    ? attempt.target_identities : attempt.target_fingerprint ? [attempt.target_fingerprint] : []))].sort();
  const verifiedFacts = attempts.flatMap(attempt => [
    ...(attempt.effect.state === "applied" ? [`applied:${attempt.target_fingerprint}`] : []),
    ...(attempt.verification.state === "passed" ? [`verified:${attempt.target_fingerprint}`] : [])
  ]).sort();
  const priorTargets = Array.isArray(prior.grounded_targets) ? prior.grounded_targets as string[] : [];
  const priorFacts = Array.isArray(prior.verified_facts) ? prior.verified_facts as string[] : [];
  const markers: AssignmentProgressInput["progress_markers"] = [];
  if (groundedTargets.some(target => !priorTargets.includes(target))) markers.push("newly_grounded_target");
  if (verifiedFacts.some(fact => !priorFacts.includes(fact))) markers.push("new_verified_fact");
  if (latest?.action_signature && prior.action_signature !== latest.action_signature) markers.push("materially_changed_plan");
  if (latest && previous && latest.created_at > previous.occurred_at
      && prior.action_signature !== latest.action_signature) markers.push("admitted_or_executed_action");
  const progress: AssignmentProgressInput = {
    unresolved_acceptance_criteria: projection.terminal_state === "open" ? goal?.acceptance_criteria ?? [] : [],
    grounded_targets: groundedTargets,
    action_signature: latest?.action_signature ?? null,
    observation_refs: latest ? [`${latest.effect.state}:${latest.effect.reason}:${latest.target_fingerprint}`] : [],
    verified_facts: verifiedFacts,
    plan_signature: latest?.action_signature ?? null,
    model_state_signature: verifiedFacts.length ? hash(verifiedFacts) : null,
    tool_family: latest?.tool_identity ?? null,
    legitimate_alternative_tool_family: latest?.tool_identity === "outer_action" ? "dynamic_revit_program" : null,
    progress_markers: [...new Set(markers)]
  };
  projection = append(projection, "progress_recorded", null, {
    turn_id: turnId, progress, snapshot: progressSnapshot(progress)
  }, { turnId, progress });
  if (projection.progress.decision === "terminate") {
    projection = terminalEvent(projection, "blocked", projection.progress.reason ?? "repeated_identical_no_progress");
  }
  return projection;
}
