import { createHash, randomUUID } from "node:crypto";
import type { ActionCall, ToolResult } from "../contracts.js";
import type { AutoGoalToolObservation } from "../goals/auto_goal_runtime.js";
import { conditionalActionPathEffect, pathLooksWrite } from "../action_path_mutability.js";
import { classifyOutcomeEnvelope } from "../outcome_envelope.js";
import { getActiveGoalForSession } from "../goals/service.js";
import {
  ASSIGNMENT_ATTEMPT_EVENT_SCHEMA,
  assignmentActionSignature,
  normalizeAssignmentControlPlane,
  reduceAssignmentControlPlane,
  type AssignmentAttemptEvent,
  type AssignmentControlPlaneProjection,
  type AssignmentRequestedEffect,
  type AssignmentRetryDelta
} from "./control_plane.js";
import { appendAssignmentEvent, beginAssignmentRun } from "./control_plane_store.js";
import { nativeSettlementMatchesAttempt, parseNativeAttemptSettlement } from "./native_attempt_settlement.js";

export type JournalContext = {
  assignmentId: string;
  runId: string;
  generation: number;
  projection: AssignmentControlPlaneProjection;
};

const TARGET_CONTROL_KEYS = new Set([
  "apply", "confirm", "confirmation", "dryRun", "dry_run", "preview", "requestEffect", "request_effect",
  "timeout", "timeoutMs", "limit", "offset", "continuationToken", "page", "pageSize"
]);

function object(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
  if (typeof value !== "string" || !value.trim().startsWith("{")) return {};
  try {
    const parsed: unknown = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b))
      .map(([key, child]) => `${JSON.stringify(key)}:${canonical(child)}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function hash(value: unknown): string {
  return `sha256:${createHash("sha256").update(canonical(value), "utf8").digest("hex")}`;
}

function actionEffect(action: Pick<ActionCall, "method" | "path" | "body">): AssignmentRequestedEffect {
  if ((action as ActionCall).request_effect === "read" || (action as ActionCall).request_effect === "preview" || (action as ActionCall).request_effect === "apply") {
    return (action as ActionCall).request_effect!;
  }
  const conditional = conditionalActionPathEffect(action.path, action.body);
  if (conditional) return conditional;
  return pathLooksWrite(action.path, action.body, action.method) ? "apply" : "read";
}

function targetFingerprint(action: Pick<ActionCall, "path" | "body">, documentFingerprint: unknown): string {
  const body = object(action.body);
  const target = Object.fromEntries(Object.entries(body).filter(([key]) => !TARGET_CONTROL_KEYS.has(key)));
  const identities = targetIdentities(body);
  return identities.length > 0
    ? hash({ document_fingerprint: documentFingerprint ?? null, identities: [...identities].sort() })
    : hash({ document_fingerprint: documentFingerprint ?? null, path: action.path.toLowerCase(), target });
}

function targetIdentities(value: unknown, out: string[] = [], depth = 0): string[] {
  if (depth > 6 || out.length >= 100 || value === null || value === undefined) return out;
  if (Array.isArray(value)) {
    for (const child of value) targetIdentities(child, out, depth + 1);
  } else if (typeof value === "object") {
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      if (/^(?:ids?|elementids?|element_ids?)$/i.test(key)
        || /(?:^|_)(?:element|target|view|sheet|schedule|family|type|room|document)(?:_?ids?|_?names?|_?numbers?)$/i.test(key)) {
        const values = Array.isArray(child) ? child : [child];
        for (const candidate of values) {
          if ((typeof candidate === "string" || typeof candidate === "number") && `${candidate}`.trim()) {
            const identity = `${key}:${`${candidate}`.trim()}`;
            if (!out.includes(identity)) out.push(identity);
          }
        }
      }
      targetIdentities(child, out, depth + 1);
    }
  }
  return out;
}

export function currentAssignmentJournalContext(sessionId: string): JournalContext | null {
  const goal = getActiveGoalForSession(sessionId);
  if (!goal) return null;
  const projection = reduceAssignmentControlPlane(
    goal.id,
    normalizeAssignmentControlPlane(goal.assignment_control_plane).events
  ).projection;
  return projection.run_id ? {
    assignmentId: goal.id,
    runId: projection.run_id,
    generation: projection.generation,
    projection
  } : null;
}

export function ensureAssignmentRunForTurn(
  sessionId: string,
  runId: string,
  actor: string,
  startNewGeneration: boolean
): JournalContext | null {
  const existing = currentAssignmentJournalContext(sessionId);
  if (existing && !startNewGeneration) return existing;
  const goal = getActiveGoalForSession(sessionId);
  if (!goal) return null;
  const desiredRun = runId.trim() || randomUUID();
  if (existing?.runId === desiredRun) return existing;
  const begun = beginAssignmentRun(goal.id, desiredRun, actor);
  return begun.accepted ? {
    assignmentId: goal.id,
    runId: begun.projection.run_id!,
    generation: begun.projection.generation,
    projection: begun.projection
  } : currentAssignmentJournalContext(sessionId);
}

function currentContext(sessionId: string): JournalContext | null {
  return currentAssignmentJournalContext(sessionId);
}

function canonicalEvent(
  context: JournalContext,
  kind: AssignmentAttemptEvent["kind"],
  attemptId: string | null,
  actor: string,
  data: Record<string, unknown>,
  stableIdentity: unknown
): AssignmentAttemptEvent {
  return {
    schema: ASSIGNMENT_ATTEMPT_EVENT_SCHEMA,
    event_id: hash({ assignment_id: context.assignmentId, run_id: context.runId, generation: context.generation, kind, attempt_id: attemptId, stableIdentity }),
    assignment_id: context.assignmentId,
    run_id: context.runId,
    generation: context.generation,
    attempt_id: attemptId,
    kind,
    occurred_at: new Date().toISOString(),
    actor: actor.trim().slice(0, 160) || "operator-backend",
    data
  };
}

function retryRelation(context: JournalContext, action: ActionCall, signature: string, target: string): {
  retry_of_attempt_id?: string;
  retry_delta?: AssignmentRetryDelta;
} {
  const prior = [...context.projection.attempts].reverse().find(attempt =>
    attempt.requested_effect === "apply" && attempt.action_path === action.path && attempt.target_fingerprint === target);
  if (!prior || prior.effect.state !== "none") return {};
  let retryDelta: AssignmentRetryDelta = prior.action_signature === signature ? "resolved_host_state" : "changed_plan";
  if (/confirm/i.test(prior.effect.reason)) retryDelta = "corrected_confirmation";
  else if (/schema|argument|contract/i.test(prior.effect.reason)) retryDelta = "corrected_schema";
  else if (/grant|authoriz/i.test(prior.effect.reason)) retryDelta = "recovered_authorization";
  return { retry_of_attempt_id: prior.attempt_id, retry_delta: retryDelta };
}

export function journalAssignmentActions(
  sessionId: string,
  actions: readonly ActionCall[],
  actor: string,
  options: { lease?: Record<string, unknown>; tool_identity?: string } = {}
): AssignmentControlPlaneProjection | null {
  let context = currentContext(sessionId);
  if (!context) return null;
  const goal = getActiveGoalForSession(sessionId);
  const documentFingerprint = goal?.work_budget?.document_fingerprint ?? null;
  for (const action of actions) {
    const effect = actionEffect(action);
    const toolIdentity = options.tool_identity?.trim() || "outer_action";
    const signature = action.action_signature?.trim() || assignmentActionSignature({
      requested_effect: effect, action_path: action.path, tool_identity: toolIdentity, request: action.body ?? null
    });
    const target = action.target_fingerprint?.trim() || targetFingerprint(action, documentFingerprint);
    action.request_effect = effect;
    action.assignment_id = context.assignmentId;
    action.attempt_id = action.action_id;
    action.assignment_run_id = context.runId;
    action.assignment_generation = context.generation;
    action.action_signature = signature;
    action.target_fingerprint = target;
    const retry = effect === "apply" ? retryRelation(context, action, signature, target) : {};
    const unknown = context.projection.attempts.find(attempt =>
      context!.projection.unresolved_unknown_attempt_ids.includes(attempt.attempt_id) && attempt.target_fingerprint === target);
    const applied = [...context.projection.attempts].reverse().find(attempt =>
      attempt.effect.state === "applied" && attempt.target_fingerprint === target);
    const purpose = effect === "read" && unknown ? "reconciliation" : effect === "read" && applied ? "verification" : "action";
    const relation = unknown?.attempt_id ?? applied?.attempt_id ?? null;
    const opened = appendAssignmentEvent(context.assignmentId, canonicalEvent(context, "attempt_opened", action.action_id, actor, {
      purpose,
      requested_effect: effect,
      action_path: action.path,
      tool_identity: toolIdentity,
      action_signature: signature,
      target_fingerprint: target,
      target_identities: targetIdentities(action.body),
      expected_postconditions: [],
      reconciliation_of_attempt_id: relation,
      canonical_method: action.method,
      ...options.lease,
      ...retry
    }, { action, purpose, relation, retry }));
    context = { ...context, projection: opened.projection };
    if (!opened.accepted) continue;
    const admitted = appendAssignmentEvent(context.assignmentId, canonicalEvent(context, "admission_recorded", action.action_id, actor, {
      admission_state: "admitted", authority: "operator_backend_action_policy"
    }, { action_id: action.action_id, admitted: true }));
    context = { ...context, projection: admitted.projection };
    if (opened.accepted && options.lease) {
      const leased = appendAssignmentEvent(context.assignmentId, canonicalEvent(context, "lease_recorded", action.action_id, actor, {
        lease_state: "admitted",
        ...options.lease
      }, { action_id: action.action_id, lease: options.lease }));
      context = { ...context, projection: leased.projection };
    }
    if (purpose === "reconciliation") {
      const started = appendAssignmentEvent(context.assignmentId, canonicalEvent(context, "reconciliation_started", action.action_id, actor, {}, {
        action_id: action.action_id, relation
      }));
      context = { ...context, projection: started.projection };
    }
  }
  return context.projection;
}

function receiptRef(result: ToolResult): string {
  return `outer-tool-result:${hash(result)}`;
}

function preDispatchAuthority(result: ToolResult): "schema_validator" | "write_grant" | "admission_policy" | "transport_pre_dispatch" {
  const text = `${result.failure_code ?? ""} ${result.failure_kind ?? ""} ${result.error ?? ""}`.toLowerCase();
  if (/schema|argument|contract|-32602/.test(text)) return "schema_validator";
  if (/write.?grant/.test(text)) return "write_grant";
  if (/confirm|approval|admission|policy|authoriz/.test(text)) return "admission_policy";
  return "transport_pre_dispatch";
}

function resultBindingMatches(context: JournalContext, result: ToolResult): boolean {
  return (!result.assignment_id || result.assignment_id === context.assignmentId)
    && (!result.assignment_run_id || result.assignment_run_id === context.runId)
    && (result.assignment_generation === undefined || result.assignment_generation === context.generation);
}

export function assignmentRunForBinding(
  sessionId: string,
  assignmentId: string,
  runId: string,
  generation: number
): JournalContext | null {
  const context = currentContext(sessionId);
  if (!context || context.assignmentId !== assignmentId || context.runId !== runId
      || context.generation !== generation || context.projection.terminal_state !== "open") return null;
  return context;
}

function settlementBindingMatches(context: JournalContext, settlement: NonNullable<ReturnType<typeof parseNativeAttemptSettlement>>): boolean {
  return (!settlement.assignment_id || settlement.assignment_id === context.assignmentId)
    && (!settlement.run_id || settlement.run_id === context.runId)
    && (settlement.generation === null || settlement.generation === context.generation);
}

function recoveredAction(
  context: JournalContext,
  result: ToolResult,
  nativeSettlement: ReturnType<typeof parseNativeAttemptSettlement>
): ActionCall {
  if (nativeSettlement && settlementBindingMatches(context, nativeSettlement)) {
    return {
      action_id: nativeSettlement.attempt_id || result.action_id,
      method: nativeSettlement.method === "GET" ? "GET" : result.method,
      path: nativeSettlement.path || result.path,
      request_effect: nativeSettlement.requested_effect,
      assignment_id: nativeSettlement.assignment_id || context.assignmentId,
      assignment_run_id: nativeSettlement.run_id || context.runId,
      assignment_generation: nativeSettlement.generation ?? context.generation,
      ...(nativeSettlement.action_signature ? { action_signature: nativeSettlement.action_signature } : {}),
      ...(nativeSettlement.target_fingerprint ? { target_fingerprint: nativeSettlement.target_fingerprint } : {})
    };
  }
  return {
    action_id: result.action_id,
    method: result.method,
    path: result.path,
    ...(result.request_effect ? { request_effect: result.request_effect } : {}),
    ...(result.assignment_id ? { assignment_id: result.assignment_id } : {}),
    ...(result.assignment_run_id ? { assignment_run_id: result.assignment_run_id } : {}),
    ...(result.assignment_generation !== undefined ? { assignment_generation: result.assignment_generation } : {}),
    ...(result.action_signature ? { action_signature: result.action_signature } : {}),
    ...(result.target_fingerprint ? { target_fingerprint: result.target_fingerprint } : {})
  };
}

function quarantineResult(context: JournalContext, result: ToolResult, actor: string, reason: string): void {
  appendAssignmentEvent(context.assignmentId, canonicalEvent(context, "dispatch_recorded", `quarantine:${result.action_id}:${reason}`, `${actor}:quarantine`, {
    dispatch_state: "failed",
    dispatch_id: result.action_id,
    dispatch_may_have_occurred: result.request_dispatched === true,
    reason
  }, { result, quarantine_reason: reason }));
}

export function journalAssignmentToolResults(
  sessionId: string,
  results: readonly ToolResult[],
  actor: string,
  options: { trustNativeSettlement?: boolean; deferTerminal?: boolean; transportBoundAttemptId?: string } = {}
): AssignmentControlPlaneProjection | null {
  let context = currentContext(sessionId);
  if (!context) return null;
  for (const result of results) {
    const nativeSettlement = parseNativeAttemptSettlement(result.result_json);
    if (!resultBindingMatches(context, result)) {
      quarantineResult(context, result, actor, "tool_result_assignment_binding_mismatch");
      context = currentContext(sessionId) ?? context;
      continue;
    }
    if (nativeSettlement && !settlementBindingMatches(context, nativeSettlement)) {
      quarantineResult(context, result, actor, "native_settlement_assignment_binding_mismatch");
      context = currentContext(sessionId) ?? context;
      continue;
    }
    let attempt = context.projection.attempts.find(candidate => candidate.attempt_id === result.action_id);
    const canonicalAttemptId = attempt?.attempt_id || nativeSettlement?.attempt_id || result.action_id;
    if (!attempt) attempt = context.projection.attempts.find(candidate => candidate.attempt_id === canonicalAttemptId);
    if (!attempt) {
      journalAssignmentActions(sessionId, [recoveredAction(context, result, nativeSettlement)], `${actor}:recovered_action`);
      context = currentContext(sessionId) ?? context;
      attempt = context.projection.attempts.find(candidate => candidate.attempt_id === canonicalAttemptId);
    }
    if (!attempt) continue;
    const nativeAttemptConflict = Boolean(nativeSettlement?.attempt_id && nativeSettlement.attempt_id !== attempt.attempt_id);
    const hostLocalAttemptTransportBound = nativeAttemptConflict && options.transportBoundAttemptId === attempt.attempt_id;
    if (nativeAttemptConflict) {
      quarantineResult(context, result, actor, "native_settlement_attempt_binding_conflict");
      context = currentContext(sessionId) ?? context;
    }
    if (nativeSettlement && nativeSettlement.requested_effect !== attempt.requested_effect) {
      quarantineResult(context, result, actor, "native_settlement_requested_effect_conflict");
      context = currentContext(sessionId) ?? context;
      continue;
    }
    if (result.request_effect && result.request_effect !== attempt.requested_effect) {
      // Preserve the lower-authority contradiction without allowing it to
      // rewrite the original planned action or a bound native settlement.
      quarantineResult(context, result, actor, "tool_result_requested_effect_conflict_ignored");
      context = currentContext(sessionId) ?? context;
    }
    const attemptContext: JournalContext = {
      ...context,
      runId: attempt.run_id,
      generation: attempt.generation
    };
    const envelope = classifyOutcomeEnvelope({
      request_dispatched: result.request_dispatched,
      outcome_unknown: result.outcome_unknown,
      reconciliation_required: result.reconciliation_required,
      result: result.result_json
    });
    const trustedNativeSettlement = options.trustNativeSettlement !== false && nativeSettlement && nativeSettlementMatchesAttempt({
      settlement: nativeSettlement,
      assignment_id: context.assignmentId,
      // Only the app-server's captured request/result promise may bind an older
      // host-local native attempt identity to the already-open canonical
      // attempt. Ordinary result journaling cannot opt into cross-attempt trust.
      attempt_id: hostLocalAttemptTransportBound ? nativeSettlement.attempt_id! : attempt.attempt_id,
      run_id: attempt.run_id,
      generation: attempt.generation,
      requested_effect: attempt.requested_effect,
      method: result.method,
      path: attempt.action_path,
      action_signature: attempt.action_signature,
      target_fingerprint: attempt.target_fingerprint
    }) ? nativeSettlement : null;
    const didNotDispatch = trustedNativeSettlement
      ? !trustedNativeSettlement.request_dispatched
      : result.request_dispatched === false || envelope.request_dispatched_false;
    const mayHaveDispatched = trustedNativeSettlement
      ? trustedNativeSettlement.request_dispatched
      : result.request_dispatched === true || envelope.request_dispatched_true || result.status === "done";
    const dispatch = appendAssignmentEvent(context.assignmentId, canonicalEvent(attemptContext, "dispatch_recorded", attempt.attempt_id, actor, {
      dispatch_state: didNotDispatch ? "not_dispatched" : mayHaveDispatched ? "acknowledged" : "failed",
      dispatch_id: result.action_id,
      dispatch_may_have_occurred: !didNotDispatch && (mayHaveDispatched || result.outcome_unknown === true),
      reason: result.error ?? result.failure_code ?? (result.status === "done" ? "tool_result_returned" : "tool_result_failed")
    }, { result, canonical_attempt_id: attempt.attempt_id }));
    context = { ...context, projection: dispatch.projection };
    if (trustedNativeSettlement) {
      const nativeEffect = appendAssignmentEvent(context.assignmentId, canonicalEvent(attemptContext, "effect_recorded", attempt.attempt_id, actor, {
        effect_state: trustedNativeSettlement.effect_state,
        effect_authority: trustedNativeSettlement.effect_authority,
        reason: trustedNativeSettlement.effect_reason,
        authority_id: trustedNativeSettlement.attempt_id ?? result.action_id,
        affected_target_identities: trustedNativeSettlement.affected_target_identities,
        receipt_refs: [...trustedNativeSettlement.receipt_refs, receiptRef(result)],
        evidence_refs: trustedNativeSettlement.evidence_refs,
        settlement_pending_evidence: options.deferTerminal === true
      }, { result, native_settlement: trustedNativeSettlement }));
      context = { ...context, projection: nativeEffect.projection };
      if (!options.deferTerminal && trustedNativeSettlement.effect_state !== "unknown") {
        const terminal = appendAssignmentEvent(context.assignmentId, canonicalEvent(attemptContext, "attempt_terminal", attempt.attempt_id, actor, {
          lease_state: "settled", reason: "native_result_settled"
        }, { result, terminal: true }));
        context = { ...context, projection: terminal.projection };
      }
      continue;
    }
    if (didNotDispatch) {
      const rejected = appendAssignmentEvent(context.assignmentId, canonicalEvent(attemptContext, "effect_recorded", attempt.attempt_id, actor, {
        effect_state: "none", effect_authority: preDispatchAuthority(result),
        reason: result.failure_code ?? result.failure_kind ?? result.error ?? "rejected_before_dispatch",
        receipt_refs: [receiptRef(result)],
        settlement_pending_evidence: options.deferTerminal === true
      }, { result, effect: "none" }));
      context = { ...context, projection: rejected.projection };
      if (!options.deferTerminal) {
        const terminal = appendAssignmentEvent(context.assignmentId, canonicalEvent(attemptContext, "attempt_terminal", attempt.attempt_id, actor, {
          lease_state: "settled", reason: "pre_dispatch_failure_settled"
        }, { result, terminal: true }));
        context = { ...context, projection: terminal.projection };
      }
      continue;
    }
    const uncertain = result.outcome_unknown === true || result.reconciliation_required === true
      || envelope.outcome_unknown || envelope.reconciliation_required;
    const requestedEffect = attempt.requested_effect;
    const effectState = uncertain || (requestedEffect !== "read" && mayHaveDispatched)
      ? "unknown"
      : "none";
    const effect = appendAssignmentEvent(context.assignmentId, canonicalEvent(attemptContext, "effect_recorded", attempt.attempt_id, actor, {
      effect_state: effectState,
      effect_authority: effectState === "unknown" ? "caller_report" : "admission_policy",
      reason: effectState === "unknown"
        ? result.status === "done" ? "caller_report_requires_independent_settlement" : "dispatch_outcome_unresolved"
        : "read_contract_has_no_persistent_effect",
      receipt_refs: [receiptRef(result)],
      settlement_pending_evidence: options.deferTerminal === true
    }, { result, effect: effectState }));
    context = { ...context, projection: effect.projection };
    if (!options.deferTerminal && effectState !== "unknown") {
      const terminal = appendAssignmentEvent(context.assignmentId, canonicalEvent(attemptContext, "attempt_terminal", attempt.attempt_id, actor, {
        lease_state: "settled", reason: "tool_result_settled"
      }, { result, terminal: true }));
      context = { ...context, projection: terminal.projection };
    }
  }
  return context.projection;
}

function observationAction(
  observation: AutoGoalToolObservation,
  actionId: string,
  requestedEffect?: AssignmentRequestedEffect
): ActionCall | null {
  const server = `${observation.server ?? ""}`.trim().toLowerCase();
  const tool = observation.tool.trim().toLowerCase();
  if (server !== "revit_operator" && !server.startsWith("mcp__revit_operator")
    && !tool.startsWith("revit_") && tool !== "run_dynamic_revit_program") return null;
  const args = object(observation.arguments);
  if (tool === "revit_call_tool") {
    const path = `${args.path ?? ""}`.trim();
    if (!path.startsWith("/revit/")) return null;
    const method = `${args.method ?? "POST"}`.trim().toUpperCase() === "GET" ? "GET" : "POST";
    return { action_id: actionId, method, path, ...(args.body === undefined ? {} : { body: args.body }), ...(requestedEffect ? { request_effect: requestedEffect } : {}) };
  }
  if (tool === "run_dynamic_revit_program") {
    return { action_id: actionId, method: "POST", path: "/revit/dynamic-program", body: args, ...(requestedEffect ? { request_effect: requestedEffect } : {}) };
  }
  if (!/^revit_[a-z0-9_]+$/.test(tool)) return null;
  return {
    action_id: actionId,
    method: "POST",
    path: `/revit/${tool.slice("revit_".length).replaceAll("_", "-")}`,
    body: args,
    ...(requestedEffect ? { request_effect: requestedEffect } : {})
  };
}

/** Journals an in-process Codex/MCP completion through the same outer contract. */
export function journalAssignmentToolObservation(
  sessionId: string,
  observation: AutoGoalToolObservation,
  actor: string,
  actionId: string,
  requestedEffect?: AssignmentRequestedEffect
): AssignmentControlPlaneProjection | null {
  const context = currentContext(sessionId);
  const alreadyOpened = context?.projection.attempts.find(attempt =>
    attempt.attempt_id === actionId
    || attempt.lease.mcp_tool_call_id === actionId
    || attempt.lease.app_server_request_id === actionId);
  const nativeAttemptId = parseNativeAttemptSettlement(observation.result ?? observation.output)?.attempt_id;
  const canonicalActionId = alreadyOpened?.attempt_id || nativeAttemptId || actionId;
  const action = observationAction(observation, canonicalActionId, requestedEffect);
  if (!action) return currentContext(sessionId)?.projection ?? null;
  if (!alreadyOpened) journalAssignmentActions(sessionId, [action], actor);
  const envelope = classifyOutcomeEnvelope(observation.result ?? observation.output);
  return journalAssignmentToolResults(sessionId, [{
    action_id: action.action_id,
    method: action.method,
    path: action.path,
    request_effect: actionEffect(action),
    status: observation.success === true ? "done" : "failed",
    request_dispatched: envelope.request_dispatched_false ? false : envelope.request_dispatched_true ? true : undefined,
    outcome_unknown: envelope.outcome_unknown,
    reconciliation_required: envelope.reconciliation_required,
    result_json: observation.result ?? observation.output,
    error: observation.error ?? undefined,
    duration_ms: observation.duration_ms ?? undefined
  }], actor);
}
