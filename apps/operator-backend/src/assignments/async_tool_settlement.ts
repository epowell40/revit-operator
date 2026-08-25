import { createHash } from "node:crypto";
import type { ActionCall, ToolResult } from "../contracts.js";
import type { CodexServerRequest } from "../codex/app_server.js";
import type { EvidenceRefV1 } from "../evidence/evidence_ref.js";
import type { EvidenceTrustLevel } from "../evidence/evidence_ref.js";
import { storeEvidence } from "../evidence/evidence_store.js";
import type { TeammateMcpGate, TeammateMcpEffect } from "../teammate_loop_runtime.js";
import { loadTrustedToolExposurePolicy } from "../capabilities/trusted_tool_exposure_policy.js";
import {
  ASSIGNMENT_ATTEMPT_EVENT_SCHEMA,
  normalizeAssignmentControlPlane,
  reduceAssignmentControlPlane,
  type AssignmentAttemptEvent,
  type AssignmentControlPlaneProjection,
  type AssignmentRequestedEffect
} from "./control_plane.js";
import { appendAssignmentEvent } from "./control_plane_store.js";
import { getGoal } from "../goals/service.js";
import { findRevitToolJobsForAttemptSettlement, readRevitToolJobTerminalOutcome } from "../courier/revit_tool_jobs.js";
import { settleAssignmentExpiredWork } from "./settlement_barrier.js";
import {
  assignmentJournalContextForBinding,
  currentAssignmentJournalContext,
  journalAssignmentActions,
  journalAssignmentToolResults,
  type JournalContext
} from "./turn_journal.js";
import { classifyMcpResultDisposition } from "./mcp_result_disposition.js";

type JsonMap = Record<string, unknown>;

export type AssignmentToolLease = {
  session_id: string;
  assignment_id: string;
  run_id: string;
  generation: number;
  attempt_id: string;
  requested_effect: AssignmentRequestedEffect;
  semantic_effect: TeammateMcpEffect;
  method: "GET" | "POST";
  path: string;
  tool: string;
  arguments: unknown;
  opened_at: string;
  deadline_at: string;
  provider_turn_id: string | null;
  provider_call_id: string | null;
  app_server_request_id: string;
  mcp_tool_call_id: string | null;
};

function object(value: unknown): JsonMap {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonMap : {};
}

function bounded(value: unknown, max = 300): string {
  const text = typeof value === "string" || typeof value === "number" ? `${value}`.trim() : "";
  return text.slice(0, max);
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value as JsonMap)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, child]) => `${JSON.stringify(key)}:${canonical(child)}`).join(",")}}`;
  return JSON.stringify(value) ?? "null";
}

function digest(value: unknown): string {
  return createHash("sha256").update(canonical(value), "utf8").digest("hex");
}

function operationTimeoutMs(): number {
  const parsed = Number.parseInt(process.env.OPERATOR_MCP_TOOL_TIMEOUT_MS ?? "", 10);
  if (!Number.isFinite(parsed)) return 240_000;
  return Math.max(1_000, Math.min(30 * 60_000, parsed));
}

function requestedEffect(effect: TeammateMcpEffect): AssignmentRequestedEffect {
  if (effect === "preview" || effect === "apply") return effect;
  if (["read", "evidence_read", "interaction", "navigation", "discovery", "completion_claim"].includes(effect)) return "read";
  throw new Error("assignment_tool_effect_unclassified");
}

function attemptPurpose(effect: TeammateMcpEffect) {
  if (effect === "discovery" || effect === "evidence_read" || effect === "interaction" || effect === "navigation" || effect === "completion_claim") return effect;
  return "action" as const;
}

function trustedTypedRoute(tool: string): { method: "GET" | "POST"; path: string } | null {
  if (!/^revit_[a-z0-9_]+$/.test(tool)) return null;
  try {
    const matches = loadTrustedToolExposurePolicy().policy.records
      .filter(record => record.typed_mcp_aliases.includes(tool))
      .map(record => ({ method: record.method, path: record.path }));
    const unique = [...new Map(matches.map(match => [`${match.method} ${match.path}`, match])).values()];
    return unique.length === 1 ? unique[0] as { method: "GET" | "POST"; path: string } : null;
  } catch {
    return null;
  }
}

function observedPath(gate: TeammateMcpGate): string {
  const value = gate.call?.path ?? "";
  const separator = value.indexOf("|");
  return separator >= 0 ? value.slice(separator + 1) : value;
}

function actionFor(tool: string, argsValue: unknown, gate: TeammateMcpGate, attemptId: string): ActionCall {
  const args = object(argsValue);
  if (tool === "revit_call_tool") {
    return {
      action_id: attemptId,
      method: bounded(args.method, 8).toUpperCase() === "GET" ? "GET" : "POST",
      path: bounded(args.path, 500),
      body: args.body,
      request_effect: requestedEffect(gate.call!.effect)
    };
  }
  const route = trustedTypedRoute(tool);
  const path = route?.path ?? observedPath(gate);
  return {
    action_id: attemptId,
    method: route?.method ?? "POST",
    path: path.startsWith("/revit/") ? path : `/mcp/${tool}`,
    body: argsValue,
    request_effect: requestedEffect(gate.call!.effect)
  };
}

function event(
  lease: AssignmentToolLease,
  kind: AssignmentAttemptEvent["kind"],
  data: JsonMap,
  identity: unknown
): AssignmentAttemptEvent {
  return {
    schema: ASSIGNMENT_ATTEMPT_EVENT_SCHEMA,
    event_id: `sha256:${digest({ assignment_id: lease.assignment_id, run_id: lease.run_id, generation: lease.generation, attempt_id: lease.attempt_id, kind, identity })}`,
    assignment_id: lease.assignment_id,
    run_id: lease.run_id,
    generation: lease.generation,
    attempt_id: lease.attempt_id,
    kind,
    occurred_at: new Date().toISOString(),
    actor: "codex_app_server",
    data
  };
}

function appendLease(lease: AssignmentToolLease, state: string, extra: JsonMap = {}): AssignmentControlPlaneProjection {
  return appendAssignmentEvent(lease.assignment_id, event(lease, "lease_recorded", {
    lease_state: state,
    provider_turn_id: lease.provider_turn_id,
    provider_call_id: lease.provider_call_id,
    app_server_request_id: lease.app_server_request_id,
    mcp_tool_call_id: lease.mcp_tool_call_id,
    ...extra
  }, { state, ...extra })).projection;
}

function currentBoundContext(sessionId: string): JournalContext {
  const context = currentAssignmentJournalContext(sessionId);
  if (!context || context.projection.terminal_state !== "open") throw new Error("assignment_tool_call_binding_required");
  return context;
}

function capturedLeaseContext(lease: AssignmentToolLease): JournalContext | null {
  return assignmentJournalContextForBinding(lease.session_id, {
    assignmentId: lease.assignment_id,
    runId: lease.run_id,
    generation: lease.generation
  });
}

function capturedLeaseBinding(lease: AssignmentToolLease) {
  return {
    assignmentId: lease.assignment_id,
    runId: lease.run_id,
    generation: lease.generation
  };
}

export function openAssignmentToolLease(input: {
  session_id: string;
  request: CodexServerRequest;
  gate: TeammateMcpGate;
}): AssignmentToolLease {
  if (!input.gate.allowed || !input.gate.call) throw new Error("assignment_tool_call_not_admitted");
  const context = currentBoundContext(input.session_id);
  const params = input.request.params ?? {};
  const tool = bounded(params.tool, 240);
  const providerTurnId = bounded(params.turnId, 300) || null;
  const providerCallId = bounded(params.providerCallId ?? params.callId, 300) || null;
  const appRequestId = bounded(input.request.id, 300) || `request:${digest(input.request).slice(0, 24)}`;
  const mcpCallId = bounded(params.callId, 300) || null;
  const attemptId = `attempt:mcp:${digest({
    assignment_id: context.assignmentId,
    run_id: context.runId,
    generation: context.generation,
    provider_turn_id: providerTurnId,
    app_server_request_id: appRequestId,
    mcp_tool_call_id: mcpCallId,
    tool,
    arguments: params.arguments ?? null
  }).slice(0, 40)}`;
  const openedAt = new Date().toISOString();
  const deadlineAt = new Date(Date.parse(openedAt) + operationTimeoutMs()).toISOString();
  const action = actionFor(tool, params.arguments, input.gate, attemptId);
  const lease: AssignmentToolLease = {
    session_id: input.session_id,
    assignment_id: context.assignmentId,
    run_id: context.runId,
    generation: context.generation,
    attempt_id: attemptId,
    requested_effect: action.request_effect!,
    semantic_effect: input.gate.call.effect,
    method: action.method,
    path: action.path,
    tool,
    arguments: params.arguments ?? {},
    opened_at: openedAt,
    deadline_at: deadlineAt,
    provider_turn_id: providerTurnId,
    provider_call_id: providerCallId,
    app_server_request_id: appRequestId,
    mcp_tool_call_id: mcpCallId
  };
  const projection = journalAssignmentActions(input.session_id, [action], "codex_app_server", {
    tool_identity: tool,
    purpose: attemptPurpose(input.gate.call.effect),
    lease: {
      provider_turn_id: providerTurnId,
      provider_call_id: providerCallId,
      app_server_request_id: appRequestId,
      mcp_tool_call_id: mcpCallId,
      tool_namespace: bounded(params.namespace, 240) || null,
      typed_alias: tool,
      canonical_method: action.method,
      deadline_at: deadlineAt
    }
  });
  const attempt = projection?.attempts.find(candidate => candidate.attempt_id === attemptId);
  if (!attempt || attempt.terminal_state !== "active") throw new Error("assignment_tool_attempt_open_failed");
  appendAssignmentEvent(lease.assignment_id, event(lease, "progress_recorded", {
    progress: {
      unresolved_acceptance_criteria: [],
      grounded_targets: attempt.target_identities,
      action_signature: attempt.action_signature,
      observation_refs: [],
      verified_facts: [],
      plan_signature: null,
      model_state_signature: null,
      tool_family: tool,
      legitimate_alternative_tool_family: null,
      progress_markers: ["admitted_or_executed_action"]
    }
  }, { progress: "admitted_or_executed_action" }));
  return lease;
}

export function markAssignmentToolDispatching(lease: AssignmentToolLease): void {
  appendLease(lease, "dispatching");
}

export function markAssignmentMcpRuntimeAccepted(lease: AssignmentToolLease): void {
  // The MCP client accepting a request proves controller handoff, not native
  // Revit dispatch. Keep the lease active while awaiting the result; the
  // result/native receipt records authoritative dispatch. If the promise is
  // lost, the timeout path remains conservative for preview/apply.
  appendLease(lease, "dispatching", { mcp_runtime_handoff: "accepted", native_dispatch_unsettled: true });
}

function toolResult(lease: AssignmentToolLease, rawResult: unknown, success: boolean, error?: unknown, requestDispatched = true,
  failure?: { failure_code: string | null; failure_kind: string | null; reason: string | null }): ToolResult {
  return {
    action_id: lease.attempt_id,
    method: lease.method,
    path: lease.path,
    request_effect: lease.requested_effect,
    assignment_id: lease.assignment_id,
    assignment_run_id: lease.run_id,
    assignment_generation: lease.generation,
    status: success ? "done" : "failed",
    request_dispatched: requestDispatched,
    result_json: rawResult,
    ...(success ? {} : {
      error: failure?.reason ?? (error instanceof Error ? error.message : `${error ?? "tool_call_failed"}`),
      ...(failure?.failure_code ? { failure_code: failure.failure_code } : {}),
      ...(failure?.failure_kind ? { failure_kind: failure.failure_kind } : {})
    })
  };
}

function resultCorrelation(value: unknown, depth = 0): string | null {
  if (depth > 8 || value === null || value === undefined) return null;
  if (Array.isArray(value)) {
    for (const child of value) {
      const found = resultCorrelation(child, depth + 1);
      if (found) return found;
    }
    return null;
  }
  if (typeof value !== "object") return null;
  const row = value as JsonMap;
  for (const key of ["correlation_id", "job_id", "dispatch_id"] as const) {
    const candidate = bounded(row[key], 240);
    if (candidate) return candidate;
  }
  for (const child of Object.values(row)) {
    const found = resultCorrelation(child, depth + 1);
    if (found) return found;
  }
  return null;
}

export function recordAssignmentToolNativeResult(lease: AssignmentToolLease, rawResult: unknown): AssignmentControlPlaneProjection {
  const goal = getGoal(lease.assignment_id);
  const durable = goal ? reduceAssignmentControlPlane(goal.id, normalizeAssignmentControlPlane(goal.assignment_control_plane).events).projection : null;
  if (!durable || durable.terminal_state !== "open") throw new Error("assignment_tool_result_arrived_post_terminal");
  const disposition = classifyMcpResultDisposition(rawResult);
  const projection = journalAssignmentToolResults(
    lease.session_id,
    [toolResult(
      lease,
      rawResult,
      !disposition.is_error,
      disposition.reason,
      !disposition.proven_before_native_dispatch,
      disposition
    )],
    "codex_app_server:tool_result",
    {
      deferTerminal: true,
      transportBoundAttemptId: lease.attempt_id,
      binding: capturedLeaseBinding(lease)
    }
  );
  const attempt = projection?.attempts.find(candidate => candidate.attempt_id === lease.attempt_id);
  if (!attempt) throw new Error("assignment_tool_result_binding_failed");
  const receiptCorrelation = attempt.receipt_refs.map(ref => /^courier:(.+)$/.exec(ref)?.[1] ?? "").find(Boolean) ?? null;
  return appendLease(lease, "retaining_evidence", {
    native_correlation_id: receiptCorrelation ?? resultCorrelation(rawResult)
  });
}

export function quarantineLateAssignmentToolResult(lease: AssignmentToolLease, rawResult: unknown): EvidenceRefV1 {
  const receivedAt = new Date().toISOString();
  const raw = storeEvidence({
    scope: assignmentEvidenceScope(lease),
    source: `late_assignment_tool_receipt:${lease.tool}`,
    media_type: "application/json",
    trust_level: "host_observed",
    bounded_summary: `Post-terminal tool receipt for ${lease.attempt_id}; retained without reopening the Assignment.`,
    verification_relevance: "supporting",
    raw: rawResult
  });
  const incident = storeEvidence({
    scope: assignmentEvidenceScope(lease),
    source: "assignment_late_receipt_incident",
    media_type: "application/json",
    trust_level: "trusted_projection",
    bounded_summary: `Late receipt incident linked to ${raw.ref.evidence_id}.`,
    verification_relevance: "supporting",
    relationships: [{ evidence_id: raw.ref.evidence_id, relation: "derived_from" }],
    raw: {
      schema: "revit-operator.assignment-late-receipt-incident/v1",
      assignment_id: lease.assignment_id,
      run_id: lease.run_id,
      generation: lease.generation,
      attempt_id: lease.attempt_id,
      received_at: receivedAt,
      deadline_at: lease.deadline_at,
      receipt_evidence_id: raw.ref.evidence_id,
      terminal_assignment_not_reopened: true
    }
  });
  appendAssignmentEvent(lease.assignment_id, event(lease, "late_receipt_recorded", {
    lease_state: "quarantined_late",
    receipt_evidence_id: raw.ref.evidence_id,
    incident_evidence_id: incident.ref.evidence_id,
    received_at: receivedAt,
    deadline_at: lease.deadline_at
  }, { late_receipt: raw.ref.content_hash }));
  return incident.ref;
}

export function settleAssignmentToolEvidence(lease: AssignmentToolLease, evidence: readonly EvidenceRefV1[]): AssignmentControlPlaneProjection {
  const context = capturedLeaseContext(lease);
  const attempt = context?.projection.attempts.find(candidate => candidate.attempt_id === lease.attempt_id);
  if (!attempt) throw new Error("assignment_tool_attempt_missing_during_evidence_settlement");
  const evidenceRefs = evidence.map(item => item.evidence_id);
  const effect = appendAssignmentEvent(lease.assignment_id, event(lease, "effect_recorded", {
    effect_state: attempt.effect.state,
    effect_authority: attempt.effect.authority,
    authority_id: attempt.effect.authority_id,
    reason: attempt.effect.reason,
    affected_target_identities: attempt.affected_target_identities,
    receipt_refs: attempt.receipt_refs,
    evidence_refs: evidenceRefs
  }, { evidence_refs: evidenceRefs }));
  if (!effect.accepted) throw new Error(effect.quarantined_reason ?? "assignment_tool_evidence_binding_failed");
  appendLease(lease, attempt.effect.state === "unknown" ? "effect_unknown" : "retaining_evidence", {
    evidence_retention_settled: true,
    evidence_refs: evidenceRefs
  });
  if (attempt.effect.state === "unknown") return capturedLeaseContext(lease)!.projection;
  return appendAssignmentEvent(lease.assignment_id, event(lease, "attempt_terminal", {
    lease_state: "settled",
    reason: "result_receipt_and_evidence_retained",
    evidence_refs: evidenceRefs
  }, { terminal: "result_receipt_and_evidence_retained", evidence_refs: evidenceRefs })).projection;
}

export function failAssignmentToolBeforeDispatch(lease: AssignmentToolLease, error: unknown): AssignmentControlPlaneProjection {
  const reason = error instanceof Error ? error.message : `${error ?? "mcp_dispatch_failed"}`;
  journalAssignmentToolResults(lease.session_id, [{
    ...toolResult(lease, { ok: false, error: reason }, false, error),
    request_dispatched: false
  }], "codex_app_server:pre_dispatch_failure", {
    deferTerminal: true,
    binding: capturedLeaseBinding(lease)
  });
  return appendLease(lease, "failed_before_dispatch", { reason });
}

export function failAssignmentToolAfterDispatch(lease: AssignmentToolLease, error: unknown): AssignmentControlPlaneProjection {
  const reason = error instanceof Error ? error.message : `${error ?? "mcp_tool_failed"}`;
  const projection = journalAssignmentToolResults(
    lease.session_id,
    [toolResult(lease, { ok: false, error: reason }, false, error)],
    "codex_app_server:post_dispatch_failure",
    { deferTerminal: true, binding: capturedLeaseBinding(lease) }
  );
  const attempt = projection?.attempts.find(candidate => candidate.attempt_id === lease.attempt_id);
  if (attempt?.effect.state === "unknown") return appendLease(lease, "effect_unknown", { reason });
  return appendAssignmentEvent(lease.assignment_id, event(lease, "attempt_terminal", {
    lease_state: "settled", reason
  }, { terminal: "post_dispatch_failure", reason })).projection;
}

export function failAssignmentEvidenceRetention(lease: AssignmentToolLease, error: unknown): AssignmentControlPlaneProjection {
  const reason = error instanceof Error ? error.message : `${error ?? "evidence_retention_failed"}`;
  const context = capturedLeaseContext(lease);
  const attempt = context?.projection.attempts.find(candidate => candidate.attempt_id === lease.attempt_id);
  if (!attempt) throw new Error("assignment_tool_attempt_missing_after_evidence_failure");
  if (attempt.effect.state === "unknown") return appendLease(lease, "effect_unknown", { reason, evidence_retention_failed: true });
  return appendAssignmentEvent(lease.assignment_id, event(lease, "attempt_terminal", {
    lease_state: lease.requested_effect === "read" ? "timed_out_read" : "settled",
    reason: `evidence_retention_failed:${reason}`
  }, { terminal: "evidence_retention_failed", reason })).projection;
}

export function assignmentEvidenceScope(lease: AssignmentToolLease) {
  return {
    session_id: lease.session_id,
    assignment_id: lease.assignment_id,
    run_id: lease.run_id,
    attempt_id: lease.attempt_id,
    generation: lease.generation
  };
}

export function assignmentToolEvidenceTrust(lease: AssignmentToolLease): EvidenceTrustLevel {
  const attempt = capturedLeaseContext(lease)?.projection.attempts
    .find(candidate => candidate.attempt_id === lease.attempt_id);
  if (attempt?.effect.authority === "target_readback") return "authoritative_readback";
  if (attempt && ["native_host", "native_transaction", "native_receipt", "native_rollback"].includes(attempt.effect.authority)) {
    return "authoritative_native";
  }
  return "host_observed";
}

/** Reconstructs and settles durable courier work after a backend restart without replay. */
export function recoverAssignmentToolLeasesAfterRestart(assignmentId: string, now = new Date()): AssignmentControlPlaneProjection {
  const goal = getGoal(assignmentId);
  if (!goal) throw new Error("Assignment not found.");
  const sessionId = `${goal.related_session_id ?? ""}`.trim();
  if (!sessionId) throw new Error("Assignment restart recovery requires its durable session binding.");
  let current = reduceAssignmentControlPlane(goal.id, normalizeAssignmentControlPlane(goal.assignment_control_plane).events).projection;
  if (current.terminal_state !== "open") return current;
  for (const attempt of current.attempts.filter(candidate => candidate.generation === current.generation && candidate.terminal_state === "active")) {
    if (!attempt.action_path.startsWith("/revit/")) continue;
    const jobs = attempt.lease.native_correlation_id
      ? []
      : findRevitToolJobsForAttemptSettlement({
          session_id: sessionId,
          method: attempt.lease.canonical_method,
          path: attempt.action_path,
          opened_at: attempt.lease.opened_at,
          deadline_at: attempt.lease.deadline_at
        });
    const correlation = attempt.lease.native_correlation_id ?? (jobs.length === 1 ? jobs[0]!.correlation_id : null);
    if (!correlation) continue;
    const lease: AssignmentToolLease = {
      session_id: sessionId,
      assignment_id: current.assignment_id,
      run_id: attempt.run_id,
      generation: attempt.generation,
      attempt_id: attempt.attempt_id,
      requested_effect: attempt.requested_effect,
      semantic_effect: attempt.requested_effect,
      method: attempt.lease.canonical_method,
      path: attempt.action_path,
      tool: attempt.lease.typed_alias ?? attempt.tool_identity,
      arguments: null,
      opened_at: attempt.lease.opened_at,
      deadline_at: attempt.lease.deadline_at,
      provider_turn_id: attempt.lease.provider_turn_id,
      provider_call_id: attempt.lease.provider_call_id,
      app_server_request_id: attempt.lease.app_server_request_id ?? attempt.attempt_id,
      mcp_tool_call_id: attempt.lease.mcp_tool_call_id
    };
    appendLease(lease, attempt.lease.state, { native_correlation_id: correlation, restart_recovered: true });
    const outcome = readRevitToolJobTerminalOutcome(correlation);
    if (!outcome) continue;
    if (outcome.status === "failed") {
      current = failAssignmentToolAfterDispatch(lease, outcome.error ?? "recovered_courier_failure");
      continue;
    }
    try {
      recordAssignmentToolNativeResult(lease, outcome.result);
      const stored = storeEvidence({
        scope: assignmentEvidenceScope(lease),
        source: `restart_recovered_courier:${lease.tool}`,
        media_type: "application/json",
        trust_level: assignmentToolEvidenceTrust(lease),
        bounded_summary: `Durable courier result recovered after restart for ${lease.attempt_id}.`,
        verification_relevance: "required",
        raw: outcome.result
      });
      current = settleAssignmentToolEvidence(lease, [stored.ref]);
    } catch (error) {
      current = failAssignmentEvidenceRetention(lease, error);
    }
  }
  return current.quiescent ? current : settleAssignmentExpiredWork(assignmentId, now);
}
