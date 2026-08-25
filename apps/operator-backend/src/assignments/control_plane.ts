import { createHash } from "node:crypto";

export const ASSIGNMENT_CONTROL_PLANE_SCHEMA = "revit-operator.assignment-control-plane/v1" as const;
export const ASSIGNMENT_ATTEMPT_EVENT_SCHEMA = "revit-operator.assignment-attempt-event/v1" as const;
export const ASSIGNMENT_ATTEMPT_SCHEMA = "revit-operator.assignment-attempt/v1" as const;
export const ASSIGNMENT_PROJECTION_V2_SCHEMA = "revit-operator.assignment-control-plane-projection/v1" as const;

export type AssignmentRequestedEffect = "read" | "preview" | "apply";
export type AssignmentEffectState = "none" | "unknown" | "applied";
export type AssignmentAttemptPurpose =
  | "action"
  | "discovery"
  | "evidence_read"
  | "interaction"
  | "navigation"
  | "completion_claim"
  | "verification"
  | "reconciliation"
  | "rollback";
export type AssignmentTerminalState = "open" | "verified" | "complete" | "blocked" | "failed" | "canceled";
export type AssignmentOutcomeState =
  | "active"
  | "awaiting_user_input"
  | "awaiting_user_review"
  | "complete"
  | "complete_with_issues"
  | "verified_noop"
  | "blocked"
  | "failed";
export type AssignmentCriterionState = "pass" | "partial" | "needs_input" | "needs_review" | "failed" | "not_applicable" | "uncertain";
export type AssignmentVerificationState = "not_requested" | "pending" | "passed" | "failed" | "inconclusive";
export type AssignmentProgressDecision = "continue" | "diagnose" | "switch_tool_family" | "terminate";
export type AssignmentAttemptLeaseState =
  | "admitted"
  | "dispatching"
  | "dispatched"
  | "retaining_evidence"
  | "settled"
  | "failed_before_dispatch"
  | "timed_out_read"
  | "effect_unknown"
  | "canceled_before_dispatch"
  | "canceled_after_dispatch"
  | "quarantined_late";

export type AssignmentEffectAuthority =
  | "control_plane"
  | "admission_policy"
  | "schema_validator"
  | "write_grant"
  | "transport_pre_dispatch"
  | "dispatch_transport"
  | "native_host"
  | "native_transaction"
  | "native_receipt"
  | "native_rollback"
  | "target_readback"
  | "independent_verifier"
  | "worker"
  | "caller_report"
  | "assistant_prose";

export type AssignmentRetryDelta =
  | "corrected_schema"
  | "corrected_confirmation"
  | "new_target_evidence"
  | "changed_plan"
  | "recovered_authorization"
  | "resolved_host_state"
  | "reconciliation_none";

export type AssignmentAttemptRecord = {
  schema: typeof ASSIGNMENT_ATTEMPT_SCHEMA;
  assignment_id: string;
  attempt_id: string;
  run_id: string;
  generation: number;
  purpose: AssignmentAttemptPurpose;
  requested_effect: AssignmentRequestedEffect;
  action_path: string;
  tool_identity: string;
  action_signature: string;
  target_fingerprint: string;
  target_identities: string[];
  expected_postconditions: string[];
  admission: { state: "pending" | "admitted" | "rejected"; reason: string | null; authority: string | null };
  dispatch: { state: "not_dispatched" | "dispatched" | "acknowledged" | "failed"; reason: string | null; dispatch_id: string | null };
  effect: { state: AssignmentEffectState; reason: string; authority: AssignmentEffectAuthority; authority_id: string | null };
  affected_target_identities: string[];
  receipt_refs: string[];
  evidence_refs: string[];
  verification: { state: AssignmentVerificationState; reason: string | null; evidence_refs: string[] };
  retry_of_attempt_id: string | null;
  retry_delta: AssignmentRetryDelta | null;
  reconciliation_of_attempt_id: string | null;
  created_at: string;
  updated_at: string;
  terminal_state: "active" | "settled" | "reconciled" | "superseded";
  lease: {
    state: AssignmentAttemptLeaseState;
    provider_turn_id: string | null;
    provider_call_id: string | null;
    app_server_request_id: string | null;
    mcp_tool_call_id: string | null;
    native_correlation_id: string | null;
    tool_namespace: string | null;
    typed_alias: string | null;
    canonical_method: "GET" | "POST";
    opened_at: string;
    dispatch_at: string | null;
    deadline_at: string;
    evidence_retention_started_at: string | null;
    evidence_retention_settled_at: string | null;
    provider_receipt_at: string | null;
    result_received_at: string | null;
    receipt_lateness_ms: number | null;
    evidence_retention_duration_ms: number | null;
    settled_at: string | null;
  };
};

export type AssignmentClarificationRecord = {
  schema: "revit-operator.assignment-clarification/v1";
  clarification_id: string;
  assignment_id: string;
  run_id: string;
  generation: number;
  missing_fields: string[];
  question: string;
  reason: string;
  completed_work: string[];
  affected_subtasks: string[];
  options: Array<{ id: string; label: string }>;
  recommended_default: string | null;
  primary_artifact_refs: string[];
  created_at: string;
  status: "pending" | "resolved" | "superseded";
  resolved_at: string | null;
  response_digest: string | null;
  supplied_values: Record<string, unknown>;
  criterion_states: AssignmentCriterionRecord[];
};

export type AssignmentCriterionRecord = {
  criterion_id: string;
  criterion: string;
  state: AssignmentCriterionState;
  reason: string;
  evidence_refs: string[];
  work_unit_ids: string[];
  updated_at: string;
  updated_by: string;
};

export type AssignmentProgressInput = {
  unresolved_acceptance_criteria: string[];
  grounded_targets: string[];
  action_signature: string | null;
  observation_refs: string[];
  verified_facts: string[];
  plan_signature: string | null;
  model_state_signature: string | null;
  tool_family: string | null;
  legitimate_alternative_tool_family: string | null;
  progress_markers: Array<
    | "newly_grounded_target"
    | "new_verified_fact"
    | "materially_changed_plan"
    | "admitted_or_executed_action"
    | "model_state_change"
    | "terminal_reason"
  >;
};

export type AssignmentAttemptEvent = {
  schema: typeof ASSIGNMENT_ATTEMPT_EVENT_SCHEMA;
  event_id: string;
  assignment_id: string;
  run_id: string;
  generation: number;
  attempt_id: string | null;
  kind:
    | "run_started"
    | "run_superseded"
    | "attempt_opened"
    | "admission_recorded"
    | "dispatch_recorded"
    | "lease_recorded"
    | "effect_recorded"
    | "verification_recorded"
    | "reconciliation_started"
    | "reconciliation_resolved"
    | "attempt_terminal"
    | "provider_call_recorded"
    | "late_receipt_recorded"
    | "progress_recorded"
    | "read_completion_claimed"
    | "read_completion_validated"
    | "clarification_requested"
    | "clarification_resolved"
    | "review_requested"
    | "review_resolved"
    | "criterion_recorded"
    | "primary_artifact_recorded"
    | "noop_completion_claimed"
    | "noop_completion_validated"
    | "assignment_terminal";
  occurred_at: string;
  actor: string;
  data: Record<string, unknown>;
};

export type AssignmentControlPlaneLog = {
  schema: typeof ASSIGNMENT_CONTROL_PLANE_SCHEMA;
  events: AssignmentAttemptEvent[];
  quarantined_events: Array<{ event: AssignmentAttemptEvent; reason: string; quarantined_at: string }>;
};

export type AssignmentControlPlaneProjection = {
  schema: typeof ASSIGNMENT_PROJECTION_V2_SCHEMA;
  assignment_id: string;
  run_id: string | null;
  generation: number;
  requested_effect: AssignmentRequestedEffect | null;
  phase: "idle" | "planning" | "executing" | "verifying" | "reconciling" | "settled";
  terminal_state: AssignmentTerminalState;
  terminal_reason: string | null;
  attempts: AssignmentAttemptRecord[];
  apply_opportunity_consumed: boolean;
  unresolved_unknown_attempt_ids: string[];
  active_verification_attempt_id: string | null;
  in_flight_attempt_ids: string[];
  in_flight_count: number;
  next_in_flight_deadline: string | null;
  quiescent: boolean;
  settlement_barrier_reason: string | null;
  provider_call_ids: string[];
  provider_call_count: number;
  late_receipt_count: number;
  outcome_state: AssignmentOutcomeState;
  clarifications: AssignmentClarificationRecord[];
  pending_clarification_id: string | null;
  pending_review_id: string | null;
  criteria: AssignmentCriterionRecord[];
  primary_artifact_refs: string[];
  noop_completion: {
    claim_id: string | null;
    status: "none" | "pending" | "accepted" | "rejected";
    reason: string | null;
    target_fingerprint: string | null;
    desired_value_digest: string | null;
    supporting_attempt_ids: string[];
    supporting_evidence_refs: string[];
  };
  read_completion: {
    claim_id: string | null;
    status: "none" | "pending" | "accepted" | "rejected";
    reason: string | null;
    result_digest: string | null;
    supporting_attempt_ids: string[];
    supporting_receipt_refs: string[];
    supporting_evidence_refs: string[];
  };
  progress: {
    fingerprint: string | null;
    repeated_no_progress_count: number;
    diagnosis_used: boolean;
    tool_family_switch_used: boolean;
    decision: AssignmentProgressDecision;
    reason: string | null;
  };
  last_event_at: string | null;
};

export type AssignmentReduceResult = {
  projection: AssignmentControlPlaneProjection;
  accepted_event_ids: string[];
  rejected: Array<{ event: AssignmentAttemptEvent; reason: string }>;
};

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function string(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? [...new Set(value.map(string).filter(Boolean))] : [];
}

function requestedEffect(value: unknown): AssignmentRequestedEffect | null {
  return value === "read" || value === "preview" || value === "apply" ? value : null;
}

function purpose(value: unknown): AssignmentAttemptPurpose {
  return value === "discovery" || value === "evidence_read" || value === "navigation"
    || value === "interaction" || value === "completion_claim" || value === "verification" || value === "reconciliation"
    || value === "rollback" ? value : "action";
}

function authority(value: unknown): AssignmentEffectAuthority | null {
  const allowed: AssignmentEffectAuthority[] = [
    "control_plane", "admission_policy", "schema_validator", "write_grant", "transport_pre_dispatch",
    "dispatch_transport", "native_host", "native_transaction", "native_receipt", "native_rollback",
    "target_readback", "independent_verifier", "worker", "caller_report", "assistant_prose"
  ];
  return allowed.includes(value as AssignmentEffectAuthority) ? value as AssignmentEffectAuthority : null;
}

function effectAuthorityRank(value: AssignmentEffectAuthority): number {
  if (value === "independent_verifier") return 6;
  if (value === "target_readback") return 5;
  if (["native_host", "native_transaction", "native_receipt", "native_rollback"].includes(value)) return 4;
  if (value === "dispatch_transport" || value === "worker") return 3;
  if (["admission_policy", "schema_validator", "write_grant", "transport_pre_dispatch"].includes(value)) return 2;
  if (value === "caller_report") return 1;
  return 0;
}

function retryDelta(value: unknown): AssignmentRetryDelta | null {
  const allowed: AssignmentRetryDelta[] = [
    "corrected_schema", "corrected_confirmation", "new_target_evidence", "changed_plan",
    "recovered_authorization", "resolved_host_state", "reconciliation_none"
  ];
  return allowed.includes(value as AssignmentRetryDelta) ? value as AssignmentRetryDelta : null;
}

function initialProjection(assignmentId: string): AssignmentControlPlaneProjection {
  return {
    schema: ASSIGNMENT_PROJECTION_V2_SCHEMA,
    assignment_id: assignmentId,
    run_id: null,
    generation: 0,
    requested_effect: null,
    phase: "idle",
    terminal_state: "open",
    terminal_reason: null,
    attempts: [],
    apply_opportunity_consumed: false,
    unresolved_unknown_attempt_ids: [],
    active_verification_attempt_id: null,
    in_flight_attempt_ids: [],
    in_flight_count: 0,
    next_in_flight_deadline: null,
    quiescent: true,
    settlement_barrier_reason: null,
    provider_call_ids: [],
    provider_call_count: 0,
    late_receipt_count: 0,
    outcome_state: "active",
    clarifications: [],
    pending_clarification_id: null,
    pending_review_id: null,
    criteria: [],
    primary_artifact_refs: [],
    noop_completion: {
      claim_id: null,
      status: "none",
      reason: null,
      target_fingerprint: null,
      desired_value_digest: null,
      supporting_attempt_ids: [],
      supporting_evidence_refs: []
    },
    read_completion: {
      claim_id: null,
      status: "none",
      reason: null,
      result_digest: null,
      supporting_attempt_ids: [],
      supporting_receipt_refs: [],
      supporting_evidence_refs: []
    },
    progress: {
      fingerprint: null,
      repeated_no_progress_count: 0,
      diagnosis_used: false,
      tool_family_switch_used: false,
      decision: "continue",
      reason: null
    },
    last_event_at: null
  };
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, nested]) => [key, canonical(nested)]));
}

export function assignmentActionSignature(input: {
  requested_effect: AssignmentRequestedEffect;
  action_path: string;
  tool_identity: string;
  request: unknown;
}): string {
  return `sha256:${createHash("sha256").update(JSON.stringify(canonical(input)), "utf8").digest("hex")}`;
}

export function assignmentProgressFingerprint(generation: number, input: AssignmentProgressInput): string {
  const bounded = {
    generation,
    unresolved_acceptance_criteria: [...new Set(input.unresolved_acceptance_criteria)].sort(),
    grounded_targets: [...new Set(input.grounded_targets)].sort(),
    action_signature: input.action_signature,
    observation_refs: [...new Set(input.observation_refs)].sort(),
    verified_facts: [...new Set(input.verified_facts)].sort(),
    plan_signature: input.plan_signature,
    model_state_signature: input.model_state_signature
  };
  return `sha256:${createHash("sha256").update(JSON.stringify(canonical(bounded)), "utf8").digest("hex")}`;
}

function refreshDerived(projection: AssignmentControlPlaneProjection): void {
  projection.apply_opportunity_consumed = projection.attempts.some(attempt =>
    attempt.requested_effect === "apply" && (attempt.effect.state === "unknown" || attempt.effect.state === "applied"));
  projection.unresolved_unknown_attempt_ids = projection.attempts
    .filter(attempt => (attempt.requested_effect === "preview" || attempt.requested_effect === "apply")
      && attempt.effect.state === "unknown")
    .map(attempt => attempt.attempt_id);
  const inFlight = projection.attempts.filter(attempt =>
    attempt.generation === projection.generation && attempt.terminal_state === "active");
  projection.in_flight_attempt_ids = inFlight.map(attempt => attempt.attempt_id);
  projection.in_flight_count = inFlight.length;
  projection.quiescent = inFlight.length === 0;
  projection.next_in_flight_deadline = inFlight.map(attempt => attempt.lease.deadline_at).filter(Boolean).sort()[0] ?? null;
  projection.settlement_barrier_reason = inFlight.length ? "assignment_settlement_deferred_in_flight" : null;
}

function effectAuthorityError(state: AssignmentEffectState, source: AssignmentEffectAuthority, data: Record<string, unknown>): string | null {
  if (source === "assistant_prose") return "Assistant prose is not an effect authority.";
  if (state === "applied" && source !== "caller_report" && !["native_transaction", "native_receipt", "target_readback"].includes(source)) {
    return `${source} cannot prove an applied persistent effect.`;
  }
  if (state === "none" && source === "target_readback" && string(data.reason) === "verified_noop"
    && strings(data.evidence_refs).length < 2) {
    return "A verified no-op requires two fresh target-bound observations.";
  }
  return null;
}

function applyEffect(attempt: AssignmentAttemptRecord, data: Record<string, unknown>): string | null {
  const state = data.effect_state;
  if (state !== "none" && state !== "unknown" && state !== "applied") return "effect_state must be none, unknown, or applied.";
  const source = authority(data.effect_authority);
  if (!source) return "A recognized effect_authority is required.";
  const authorityError = effectAuthorityError(state, source, data);
  if (authorityError) return authorityError;
  const effectiveState = state === "applied" && source === "caller_report" ? "unknown" : state;
  const currentRank = effectAuthorityRank(attempt.effect.authority);
  const incomingRank = effectAuthorityRank(source);
  if (attempt.requested_effect !== "apply" && effectiveState === "applied") {
    return `A ${attempt.requested_effect} attempt cannot establish a persistent applied effect.`;
  }
  if (incomingRank < currentRank) {
    return `A lower-authority ${source} effect cannot alter ${attempt.effect.authority} effect truth.`;
  }
  if (attempt.effect.state === "applied" && effectiveState !== "applied") return "An applied effect cannot be downgraded.";
  if (attempt.effect.state === "unknown" && effectiveState !== "unknown" && incomingRank < 4) {
    return `Only authoritative native settlement or target-bound verification may resolve an unknown effect.`;
  }
  if (attempt.effect.state !== effectiveState && (currentRank >= 4 || incomingRank === currentRank)) {
    return `Conflicting ${source} effect truth cannot replace ${attempt.effect.authority} ${attempt.effect.state}.`;
  }
  attempt.affected_target_identities = [...new Set([
    ...attempt.affected_target_identities,
    ...strings(data.affected_target_identities)
  ])];
  attempt.receipt_refs = [...new Set([...attempt.receipt_refs, ...strings(data.receipt_refs)])];
  attempt.evidence_refs = [...new Set([...attempt.evidence_refs, ...strings(data.evidence_refs)])];
  attempt.effect = {
    state: effectiveState,
    reason: string(data.reason) || (effectiveState === "unknown" ? "effect_not_authoritatively_settled" : `effect_${effectiveState}`),
    authority: effectiveState === "unknown" && source === "caller_report" ? "caller_report" : source,
    authority_id: string(data.authority_id) || null
  };
  return null;
}

function attemptFor(projection: AssignmentControlPlaneProjection, event: AssignmentAttemptEvent): AssignmentAttemptRecord | null {
  return event.attempt_id ? projection.attempts.find(candidate => candidate.attempt_id === event.attempt_id) ?? null : null;
}

function applyProgress(projection: AssignmentControlPlaneProjection, data: Record<string, unknown>): string | null {
  const input = record(data.progress) as Partial<AssignmentProgressInput>;
  const normalized: AssignmentProgressInput = {
    unresolved_acceptance_criteria: strings(input.unresolved_acceptance_criteria),
    grounded_targets: strings(input.grounded_targets),
    action_signature: string(input.action_signature) || null,
    observation_refs: strings(input.observation_refs),
    verified_facts: strings(input.verified_facts),
    plan_signature: string(input.plan_signature) || null,
    model_state_signature: string(input.model_state_signature) || null,
    tool_family: string(input.tool_family) || null,
    legitimate_alternative_tool_family: string(input.legitimate_alternative_tool_family) || null,
    progress_markers: Array.isArray(input.progress_markers) ? input.progress_markers as AssignmentProgressInput["progress_markers"] : []
  };
  const fingerprint = assignmentProgressFingerprint(projection.generation, normalized);
  if (!projection.quiescent) {
    projection.progress.decision = "continue";
    projection.progress.reason = "progress_in_flight";
    return null;
  }
  const madeProgress = normalized.progress_markers.length > 0;
  const repeated = !madeProgress && projection.progress.fingerprint === fingerprint;
  projection.progress.fingerprint = fingerprint;
  projection.progress.repeated_no_progress_count = repeated ? projection.progress.repeated_no_progress_count + 1 : 0;
  if (madeProgress) {
    projection.progress.decision = "continue";
    projection.progress.reason = null;
    return null;
  }
  if (projection.progress.repeated_no_progress_count <= 1 && !projection.progress.diagnosis_used) {
    projection.progress.diagnosis_used = true;
    projection.progress.decision = "diagnose";
    projection.progress.reason = "one_bounded_diagnosis_allowed";
  } else if (normalized.legitimate_alternative_tool_family && !projection.progress.tool_family_switch_used) {
    projection.progress.tool_family_switch_used = true;
    projection.progress.decision = "switch_tool_family";
    projection.progress.reason = `switch_to:${normalized.legitimate_alternative_tool_family}`;
  } else {
    projection.progress.decision = "terminate";
    projection.progress.reason = "repeated_identical_no_progress";
  }
  return null;
}

function rejectReason(projection: AssignmentControlPlaneProjection, event: AssignmentAttemptEvent): string | null {
  if (event.schema !== ASSIGNMENT_ATTEMPT_EVENT_SCHEMA) return "Unsupported event schema.";
  if (event.assignment_id !== projection.assignment_id) return "Event belongs to a different Assignment.";
  if (projection.terminal_state !== "open") return `Assignment is terminal (${projection.terminal_state}).`;
  if (event.kind === "run_started") {
    if (event.generation !== projection.generation + 1) return "Run generation must increase exactly once.";
    if (!event.run_id) return "run_id is required.";
    return null;
  }
  if (!projection.run_id) return "No active Assignment run exists.";
  if (event.run_id !== projection.run_id || event.generation !== projection.generation) return "Event belongs to a stale or superseded run generation.";
  return null;
}

function applyAcceptedEvent(projection: AssignmentControlPlaneProjection, event: AssignmentAttemptEvent): string | null {
  const data = record(event.data);
  if (event.kind === "run_started") {
    projection.attempts.filter(attempt => attempt.terminal_state === "active")
      .forEach(attempt => { attempt.terminal_state = "superseded"; });
    projection.run_id = event.run_id;
    projection.generation = event.generation;
    projection.requested_effect = requestedEffect(data.requested_effect) ?? projection.requested_effect;
    projection.phase = "planning";
    projection.progress = { fingerprint: null, repeated_no_progress_count: 0, diagnosis_used: false, tool_family_switch_used: false, decision: "continue", reason: null };
    projection.outcome_state = "active";
    return null;
  }
  if (event.kind === "run_superseded") {
    projection.attempts.filter(attempt => attempt.terminal_state === "active").forEach(attempt => { attempt.terminal_state = "superseded"; });
    projection.phase = "settled";
    return null;
  }
  if (event.kind === "attempt_opened") {
    if (projection.pending_clarification_id) return "Assignment is awaiting user input; no new tool attempt may open.";
    if (projection.pending_review_id) return "Assignment is awaiting user review; no new tool attempt may open.";
    if (!event.attempt_id || projection.attempts.some(attempt => attempt.attempt_id === event.attempt_id)) return "attempt_id must be new and non-empty.";
    const effect = requestedEffect(data.requested_effect);
    if (!effect) return "requested_effect must be read, preview, or apply.";
    const attemptPurpose = purpose(data.purpose);
    if (projection.unresolved_unknown_attempt_ids.length && attemptPurpose !== "reconciliation") return "An unknown effect must be reconciled before another action.";
    if (projection.attempts.some(attempt => attempt.effect.state === "applied") && !["verification", "reconciliation", "rollback"].includes(attemptPurpose)) {
      return "Open discovery or planning cannot resume after a proven apply.";
    }
    const signature = string(data.action_signature);
    const targetFingerprint = string(data.target_fingerprint);
    const retryOf = string(data.retry_of_attempt_id) || null;
    const delta = retryDelta(data.retry_delta);
    if (effect === "apply") {
      const priorSame = [...projection.attempts].reverse().find(attempt =>
        attempt.requested_effect === "apply" && attempt.action_signature === signature && attempt.target_fingerprint === targetFingerprint);
      if (priorSame) {
        if (priorSame.effect.state !== "none") return "The same apply action and target cannot be replayed unless the prior effect is authoritatively none.";
        if (retryOf !== priorSame.attempt_id || !delta) return "A repeated apply requires its prior attempt and a material retry delta.";
      }
    }
    const parsedDeadline = Date.parse(string(data.deadline_at));
    const fallbackDeadline = Date.parse(event.occurred_at) + 240_000;
    const deadlineAt = new Date(Number.isFinite(parsedDeadline) ? parsedDeadline : fallbackDeadline).toISOString();
    projection.attempts.push({
      schema: ASSIGNMENT_ATTEMPT_SCHEMA,
      assignment_id: projection.assignment_id,
      attempt_id: event.attempt_id,
      run_id: event.run_id,
      generation: event.generation,
      purpose: attemptPurpose,
      requested_effect: effect,
      action_path: string(data.action_path),
      tool_identity: string(data.tool_identity),
      action_signature: signature,
      target_fingerprint: targetFingerprint,
      target_identities: strings(data.target_identities),
      expected_postconditions: strings(data.expected_postconditions),
      admission: { state: "pending", reason: null, authority: null },
      dispatch: { state: "not_dispatched", reason: null, dispatch_id: null },
      effect: { state: "none", reason: "attempt_not_dispatched", authority: "control_plane", authority_id: null },
      affected_target_identities: [],
      receipt_refs: [],
      evidence_refs: [],
      verification: { state: attemptPurpose === "verification" ? "pending" : "not_requested", reason: null, evidence_refs: [] },
      retry_of_attempt_id: retryOf,
      retry_delta: delta,
      reconciliation_of_attempt_id: string(data.reconciliation_of_attempt_id) || null,
      created_at: event.occurred_at,
      updated_at: event.occurred_at,
      terminal_state: "active"
      ,lease: {
        state: "admitted",
        provider_turn_id: string(data.provider_turn_id) || null,
        provider_call_id: string(data.provider_call_id) || null,
        app_server_request_id: string(data.app_server_request_id) || null,
        mcp_tool_call_id: string(data.mcp_tool_call_id) || null,
        native_correlation_id: string(data.native_correlation_id) || null,
        tool_namespace: string(data.tool_namespace) || null,
        typed_alias: string(data.typed_alias) || null,
        canonical_method: string(data.canonical_method).toUpperCase() === "GET" ? "GET" : "POST",
        opened_at: event.occurred_at,
        dispatch_at: null,
        deadline_at: deadlineAt,
        evidence_retention_started_at: null,
        evidence_retention_settled_at: null,
        provider_receipt_at: null,
        result_received_at: null,
        receipt_lateness_ms: null,
        evidence_retention_duration_ms: null,
        settled_at: null
      }
    });
    projection.phase = attemptPurpose === "verification" ? "verifying" : attemptPurpose === "reconciliation" ? "reconciling" : "executing";
    if (attemptPurpose === "verification") projection.active_verification_attempt_id = event.attempt_id;
    return null;
  }
  if (event.kind === "progress_recorded") return applyProgress(projection, data);
  if (event.kind === "provider_call_recorded") {
    if (projection.pending_clarification_id) return "Assignment is awaiting user input; no new provider call may begin.";
    if (projection.pending_review_id) return "Assignment is awaiting user review; no new provider call may begin.";
    const callId = string(data.call_id);
    if (!callId) return "provider_call_recorded requires call_id.";
    if (!projection.provider_call_ids.includes(callId)) projection.provider_call_ids.push(callId);
    projection.provider_call_count = projection.provider_call_ids.length;
    for (const active of projection.attempts.filter(candidate => candidate.generation === projection.generation && candidate.terminal_state === "active")) {
      active.lease.provider_receipt_at = active.lease.provider_receipt_at ?? event.occurred_at;
    }
    return null;
  }
  if (event.kind === "late_receipt_recorded") {
    projection.late_receipt_count += 1;
    return null;
  }
  if (event.kind === "clarification_requested") {
    const clarificationId = string(data.clarification_id);
    const missingFields = strings(data.missing_fields);
    const question = string(data.question);
    if (!clarificationId || !question || missingFields.length < 1) {
      return "clarification_requested requires clarification_id, missing_fields, and question.";
    }
    if (projection.pending_clarification_id) return "An unresolved clarification already exists.";
    if (projection.pending_review_id) return "A clarification cannot be requested while user review is pending.";
    if (projection.unresolved_unknown_attempt_ids.length) return "A clarification cannot pause an unresolved unknown effect.";
    const activeAttempts = projection.attempts.filter(candidate => candidate.generation === projection.generation && candidate.terminal_state === "active");
    if (activeAttempts.some(candidate => candidate.purpose !== "interaction") || activeAttempts.length > 1) {
      return "A clarification cannot be requested while executable work remains in flight.";
    }
    const options = Array.isArray(data.options) ? data.options.flatMap(value => {
      const option = record(value);
      const id = string(option.id);
      const label = string(option.label);
      return id && label ? [{ id, label }] : [];
    }).slice(0, 12) : [];
    const criterionStates = Array.isArray(data.criterion_states) ? data.criterion_states.flatMap(value => {
      const criterion = record(value);
      const criterionId = string(criterion.criterion_id);
      const statement = string(criterion.criterion);
      const state = string(criterion.state) as AssignmentCriterionState;
      const allowed: AssignmentCriterionState[] = ["pass", "partial", "needs_input", "needs_review", "failed", "not_applicable", "uncertain"];
      return criterionId && statement && allowed.includes(state) ? [{
        criterion_id: criterionId,
        criterion: statement,
        state,
        reason: string(criterion.reason),
        evidence_refs: strings(criterion.evidence_refs),
        work_unit_ids: strings(criterion.work_unit_ids),
        updated_at: event.occurred_at,
        updated_by: event.actor
      }] : [];
    }) : [];
    projection.clarifications.push({
      schema: "revit-operator.assignment-clarification/v1",
      clarification_id: clarificationId,
      assignment_id: projection.assignment_id,
      run_id: projection.run_id ?? "",
      generation: projection.generation,
      missing_fields: missingFields,
      question,
      reason: string(data.reason) || "required_input_missing",
      completed_work: strings(data.completed_work),
      affected_subtasks: strings(data.affected_subtasks),
      options,
      recommended_default: string(data.recommended_default) || null,
      primary_artifact_refs: strings(data.primary_artifact_refs),
      created_at: event.occurred_at,
      status: "pending",
      resolved_at: null,
      response_digest: null,
      supplied_values: {},
      criterion_states: criterionStates
    });
    for (const criterion of criterionStates) {
      const index = projection.criteria.findIndex(item => item.criterion_id === criterion.criterion_id);
      if (index >= 0) projection.criteria[index] = criterion;
      else projection.criteria.push(criterion);
    }
    projection.pending_clarification_id = clarificationId;
    projection.primary_artifact_refs = [...new Set([...projection.primary_artifact_refs, ...strings(data.primary_artifact_refs)])];
    projection.outcome_state = "awaiting_user_input";
    return null;
  }
  if (event.kind === "clarification_resolved") {
    const clarificationId = string(data.clarification_id);
    const clarification = projection.clarifications.find(item => item.clarification_id === clarificationId);
    if (!clarification || clarification.status !== "pending" || projection.pending_clarification_id !== clarificationId) {
      return "clarification_resolved must reference the current pending clarification.";
    }
    const responseDigest = string(data.response_digest);
    if (!responseDigest) return "clarification_resolved requires response_digest.";
    clarification.status = "resolved";
    clarification.resolved_at = event.occurred_at;
    clarification.response_digest = responseDigest;
    clarification.supplied_values = record(data.supplied_values);
    projection.pending_clarification_id = null;
    projection.outcome_state = "active";
    return null;
  }
  if (event.kind === "review_requested") {
    const reviewId = string(data.review_id);
    if (!reviewId) return "review_requested requires review_id.";
    if (projection.pending_clarification_id || projection.pending_review_id) return "Only one user interaction may be pending.";
    if (!projection.quiescent || projection.unresolved_unknown_attempt_ids.length) return "User review requires quiescent, settled work.";
    projection.pending_review_id = reviewId;
    projection.outcome_state = "awaiting_user_review";
    return null;
  }
  if (event.kind === "review_resolved") {
    const reviewId = string(data.review_id);
    if (!reviewId || reviewId !== projection.pending_review_id) return "review_resolved must reference the pending review.";
    projection.pending_review_id = null;
    projection.outcome_state = "active";
    return null;
  }
  if (event.kind === "criterion_recorded") {
    const criterionId = string(data.criterion_id);
    const criterion = string(data.criterion);
    const state = string(data.state) as AssignmentCriterionState;
    const allowed: AssignmentCriterionState[] = ["pass", "partial", "needs_input", "needs_review", "failed", "not_applicable", "uncertain"];
    if (!criterionId || !criterion || !allowed.includes(state)) return "criterion_recorded requires a criterion_id, criterion, and recognized state.";
    const next: AssignmentCriterionRecord = {
      criterion_id: criterionId,
      criterion,
      state,
      reason: string(data.reason),
      evidence_refs: strings(data.evidence_refs),
      work_unit_ids: strings(data.work_unit_ids),
      updated_at: event.occurred_at,
      updated_by: event.actor
    };
    const index = projection.criteria.findIndex(item => item.criterion_id === criterionId);
    if (index >= 0) projection.criteria[index] = next;
    else projection.criteria.push(next);
    return null;
  }
  if (event.kind === "primary_artifact_recorded") {
    const refs = strings(data.primary_artifact_refs);
    if (!refs.length) return "primary_artifact_recorded requires at least one artifact reference.";
    projection.primary_artifact_refs = [...new Set([...projection.primary_artifact_refs, ...refs])];
    return null;
  }
  if (event.kind === "noop_completion_claimed") {
    const claimId = string(data.claim_id);
    if (!claimId) return "noop_completion_claimed requires claim_id.";
    if (projection.noop_completion.status === "accepted") return "An accepted no-op completion claim is immutable.";
    projection.noop_completion = {
      claim_id: claimId,
      status: "pending",
      reason: null,
      target_fingerprint: string(data.target_fingerprint) || null,
      desired_value_digest: string(data.desired_value_digest) || null,
      supporting_attempt_ids: strings(data.supporting_attempt_ids),
      supporting_evidence_refs: strings(data.supporting_evidence_refs)
    };
    return null;
  }
  if (event.kind === "noop_completion_validated") {
    const claimId = string(data.claim_id);
    if (!claimId || claimId !== projection.noop_completion.claim_id) return "noop_completion_validated must reference the latest no-op claim.";
    if (data.accepted === true && event.actor !== "canonical_noop_completion_validator") {
      return "Only the canonical no-op validator may accept a claim.";
    }
    projection.noop_completion = {
      ...projection.noop_completion,
      status: data.accepted === true ? "accepted" : "rejected",
      reason: string(data.reason) || null
    };
    return null;
  }
  if (event.kind === "read_completion_claimed") {
    const claimId = string(data.claim_id);
    if (!claimId) return "read_completion_claimed requires claim_id.";
    projection.read_completion = {
      claim_id: claimId,
      status: "pending",
      reason: null,
      result_digest: string(data.result_digest) || null,
      supporting_attempt_ids: strings(data.supporting_attempt_ids),
      supporting_receipt_refs: strings(data.supporting_receipt_refs),
      supporting_evidence_refs: strings(data.supporting_evidence_refs)
    };
    return null;
  }
  if (event.kind === "read_completion_validated") {
    const claimId = string(data.claim_id);
    if (!claimId || claimId !== projection.read_completion.claim_id) {
      return "read_completion_validated must reference the latest completion claim.";
    }
    const accepted = data.accepted === true;
    if (accepted) {
      if (event.actor !== "canonical_read_completion_validator") return "Only the canonical read-completion validator may accept a claim.";
      if (!projection.quiescent) return "A read-completion claim cannot be accepted before Assignment quiescence.";
      const support = strings(data.supporting_attempt_ids);
      if (support.length < 1) return "Accepted read completion requires supporting attempts.";
      for (const attemptId of support) {
        const supporting = projection.attempts.find(candidate => candidate.attempt_id === attemptId);
        if (!supporting || supporting.generation !== projection.generation || supporting.purpose !== "action"
            || supporting.requested_effect !== "read" || supporting.admission.state !== "admitted"
            || supporting.dispatch.state !== "acknowledged" || supporting.terminal_state !== "settled"
            || supporting.effect.state !== "none" || supporting.receipt_refs.length < 1
            || supporting.evidence_refs.length < 1
            || !["native_host", "native_receipt", "target_readback", "independent_verifier"].includes(supporting.effect.authority)) {
          return "Accepted read completion references an ineligible supporting attempt.";
        }
      }
    }
    projection.read_completion = {
      ...projection.read_completion,
      status: accepted ? "accepted" : "rejected",
      reason: string(data.reason) || null,
      result_digest: string(data.result_digest) || projection.read_completion.result_digest,
      supporting_attempt_ids: strings(data.supporting_attempt_ids).length
        ? strings(data.supporting_attempt_ids) : projection.read_completion.supporting_attempt_ids,
      supporting_receipt_refs: strings(data.supporting_receipt_refs).length
        ? strings(data.supporting_receipt_refs) : projection.read_completion.supporting_receipt_refs,
      supporting_evidence_refs: strings(data.supporting_evidence_refs).length
        ? strings(data.supporting_evidence_refs) : projection.read_completion.supporting_evidence_refs
    };
    return null;
  }
  if (event.kind === "assignment_terminal") {
    if (!projection.quiescent) return `assignment_settlement_deferred_in_flight:${projection.in_flight_attempt_ids.join(",")}:${projection.next_in_flight_deadline ?? "unknown_deadline"}`;
    if (projection.pending_clarification_id) return "assignment_settlement_deferred_awaiting_user_input";
    if (projection.pending_review_id) return "assignment_settlement_deferred_awaiting_user_review";
    const state = data.terminal_state;
    if (!["verified", "complete", "blocked", "failed", "canceled"].includes(String(state))) return "A recognized terminal_state is required.";
    if (state === "complete" && string(data.reason) === "authoritative_read_completed"
        && projection.read_completion.status !== "accepted") {
      return "Authoritative read completion requires an accepted canonical completion claim.";
    }
    if (state === "complete" && string(data.reason) === "verified_noop_two_fresh_target_observations"
        && projection.noop_completion.status !== "accepted") {
      return "Verified no-op completion requires an accepted desired-state equivalence claim.";
    }
    projection.terminal_state = state as AssignmentTerminalState;
    projection.terminal_reason = string(data.reason) || null;
    projection.phase = "settled";
    projection.outcome_state = state === "complete" && string(data.reason) === "verified_noop_two_fresh_target_observations"
      ? "verified_noop"
      : state === "verified" || state === "complete" ? "complete"
        : state === "blocked" ? "blocked" : "failed";
    return null;
  }
  const attempt = attemptFor(projection, event);
  if (!attempt) return "Event references an unknown attempt.";
  attempt.updated_at = event.occurred_at;
  if (event.kind === "admission_recorded") {
    const state = data.admission_state;
    if (state !== "admitted" && state !== "rejected") return "admission_state must be admitted or rejected.";
    if (attempt.terminal_state !== "active") return "A terminal attempt cannot accept a later admission callback.";
    if (attempt.admission.state !== "pending") {
      return attempt.admission.state === state
        ? null
        : `Admission cannot change from ${attempt.admission.state} to ${state}.`;
    }
    if (state === "rejected") {
      const error = applyEffect(attempt, {
        ...data,
        effect_state: "none",
        effect_authority: authority(data.effect_authority) ?? "admission_policy",
        reason: string(data.reason) || "admission_rejected"
      });
      if (error) return error;
      attempt.admission = { state, reason: string(data.reason) || null, authority: string(data.authority) || null };
      attempt.terminal_state = "settled";
      attempt.lease.state = "failed_before_dispatch";
      attempt.lease.settled_at = event.occurred_at;
    } else {
      attempt.admission = { state, reason: string(data.reason) || null, authority: string(data.authority) || null };
    }
    return null;
  }
  if (event.kind === "dispatch_recorded") {
    const state = data.dispatch_state;
    if (!["dispatched", "acknowledged", "failed", "not_dispatched"].includes(String(state))) return "A recognized dispatch_state is required.";
    if (attempt.terminal_state !== "active") return "A terminal attempt cannot accept a later dispatch callback.";
    if (attempt.dispatch.state === "acknowledged" && state !== "acknowledged") {
      return `Acknowledged dispatch cannot change to ${state}.`;
    }
    if (attempt.dispatch.state === "dispatched" && state === "not_dispatched") {
      return "A dispatched attempt cannot later be classified not_dispatched.";
    }
    const dispatchMayHaveOccurred = attempt.dispatch.state === "dispatched"
      || attempt.dispatch.state === "acknowledged"
      || data.dispatch_may_have_occurred === true;
    let effectError: string | null = null;
    if (attempt.requested_effect === "apply" && (state === "dispatched" || state === "acknowledged")) {
      effectError = applyEffect(attempt, {
        effect_state: "unknown", effect_authority: "dispatch_transport",
        reason: "dispatch_occurred_effect_unsettled", authority_id: string(data.dispatch_id) || null
      });
    } else if (state === "failed" && attempt.requested_effect === "apply" && dispatchMayHaveOccurred) {
      effectError = applyEffect(attempt, {
        effect_state: "unknown", effect_authority: "dispatch_transport",
        reason: string(data.reason) || "dispatch_may_have_occurred", authority_id: string(data.dispatch_id) || null
      });
    } else if (state === "failed" || state === "not_dispatched") {
      effectError = applyEffect(attempt, {
        effect_state: "none",
        effect_authority: dispatchMayHaveOccurred ? "dispatch_transport" : "transport_pre_dispatch",
        reason: string(data.reason) || (dispatchMayHaveOccurred ? "dispatch_failed_after_handoff" : "dispatch_did_not_occur"),
        authority_id: string(data.dispatch_id) || null
      });
    }
    if (effectError) return effectError;
    attempt.dispatch = { state: state as AssignmentAttemptRecord["dispatch"]["state"], reason: string(data.reason) || null, dispatch_id: string(data.dispatch_id) || null };
    if (state === "dispatched" || state === "acknowledged") {
      attempt.lease.state = "dispatched";
      attempt.lease.dispatch_at = attempt.lease.dispatch_at ?? event.occurred_at;
    }
    if (state === "failed" || state === "not_dispatched") {
      attempt.terminal_state = "settled";
      attempt.lease.state = "failed_before_dispatch";
      attempt.lease.settled_at = event.occurred_at;
    }
    return null;
  }
  if (event.kind === "lease_recorded") {
    const state = data.lease_state;
    const allowed: AssignmentAttemptLeaseState[] = [
      "admitted", "dispatching", "dispatched", "retaining_evidence", "settled",
      "failed_before_dispatch", "timed_out_read", "effect_unknown",
      "canceled_before_dispatch", "canceled_after_dispatch", "quarantined_late"
    ];
    if (!allowed.includes(state as AssignmentAttemptLeaseState)) return "A recognized lease_state is required.";
    attempt.lease.state = state as AssignmentAttemptLeaseState;
    attempt.lease.provider_turn_id = string(data.provider_turn_id) || attempt.lease.provider_turn_id;
    attempt.lease.provider_call_id = string(data.provider_call_id) || attempt.lease.provider_call_id;
    attempt.lease.app_server_request_id = string(data.app_server_request_id) || attempt.lease.app_server_request_id;
    attempt.lease.mcp_tool_call_id = string(data.mcp_tool_call_id) || attempt.lease.mcp_tool_call_id;
    attempt.lease.native_correlation_id = string(data.native_correlation_id) || attempt.lease.native_correlation_id;
    if (string(data.canonical_method).toUpperCase() === "GET" || string(data.canonical_method).toUpperCase() === "POST") {
      attempt.lease.canonical_method = string(data.canonical_method).toUpperCase() as "GET" | "POST";
    }
    if (state === "dispatching" || state === "dispatched") attempt.lease.dispatch_at = attempt.lease.dispatch_at ?? event.occurred_at;
    if (state === "retaining_evidence") attempt.lease.evidence_retention_started_at = event.occurred_at;
    if (state === "retaining_evidence") {
      attempt.lease.result_received_at = attempt.lease.result_received_at ?? event.occurred_at;
      const providerAt = Date.parse(attempt.lease.provider_receipt_at ?? "");
      const resultAt = Date.parse(attempt.lease.result_received_at);
      attempt.lease.receipt_lateness_ms = Number.isFinite(providerAt) && Number.isFinite(resultAt) ? Math.max(0, resultAt - providerAt) : null;
    }
    if (data.evidence_retention_settled === true) {
      attempt.lease.evidence_retention_settled_at = event.occurred_at;
      const start = Date.parse(attempt.lease.evidence_retention_started_at ?? "");
      const end = Date.parse(event.occurred_at);
      attempt.lease.evidence_retention_duration_ms = Number.isFinite(start) && Number.isFinite(end) ? Math.max(0, end - start) : null;
    }
    if (["settled", "failed_before_dispatch", "timed_out_read", "effect_unknown", "canceled_before_dispatch", "quarantined_late"].includes(String(state))) {
      attempt.terminal_state = "settled";
      attempt.lease.settled_at = event.occurred_at;
    }
    return null;
  }
  if (event.kind === "effect_recorded") {
    const error = applyEffect(attempt, data);
    if (error) return error;
    if (attempt.effect.state === "applied") {
      projection.phase = "verifying";
    } else if (attempt.effect.state === "unknown") {
      attempt.lease.state = "effect_unknown";
    }
    if (attempt.effect.state !== "unknown" && data.settlement_pending_evidence !== true) {
      attempt.terminal_state = "settled";
      attempt.lease.state = "settled";
      attempt.lease.settled_at = event.occurred_at;
    }
    return null;
  }
  if (event.kind === "verification_recorded") {
    if (attempt.purpose !== "verification") return "Verification evidence must reference a verification attempt.";
    const applied = projection.attempts.find(candidate => candidate.attempt_id === attempt.reconciliation_of_attempt_id || candidate.attempt_id === string(data.applied_attempt_id));
    if (!applied || applied.effect.state !== "applied") return "Verification must be bound to an applied attempt.";
    if (attempt.target_fingerprint !== applied.target_fingerprint) return "Verification target does not match the applied attempt.";
    const state = data.verification_state;
    if (!["passed", "failed", "inconclusive"].includes(String(state))) return "A recognized verification_state is required.";
    const otherActive = projection.attempts.some(candidate => candidate.attempt_id !== attempt.attempt_id
      && candidate.generation === projection.generation && candidate.terminal_state === "active");
    if (otherActive) return "Verification cannot terminally settle while other current-generation work is in flight.";
    attempt.verification = { state: state as AssignmentVerificationState, reason: string(data.reason) || null, evidence_refs: strings(data.evidence_refs) };
    attempt.terminal_state = "settled";
    attempt.lease.state = "settled";
    attempt.lease.settled_at = event.occurred_at;
    if (state === "passed") {
      projection.terminal_state = "verified";
      projection.terminal_reason = "exact_postconditions_verified";
      projection.phase = "settled";
    } else if (state === "failed") {
      projection.terminal_state = "failed";
      projection.terminal_reason = "verification_failed_after_apply";
      projection.phase = "settled";
    }
    return null;
  }
  if (event.kind === "reconciliation_started") {
    const original = projection.attempts.find(candidate => candidate.attempt_id === attempt.reconciliation_of_attempt_id);
    if (attempt.purpose !== "reconciliation" || !original || original.effect.state !== "unknown") return "Reconciliation must reference an unresolved unknown attempt.";
    if (attempt.target_fingerprint !== original.target_fingerprint) return "Reconciliation must inspect the exact original target.";
    projection.phase = "reconciling";
    return null;
  }
  if (event.kind === "reconciliation_resolved") {
    const original = projection.attempts.find(candidate => candidate.attempt_id === attempt.reconciliation_of_attempt_id);
    if (attempt.purpose !== "reconciliation" || !original || original.effect.state !== "unknown") return "Reconciliation must resolve an unknown original attempt.";
    const resolved = data.effect_state;
    if (resolved !== "none" && resolved !== "unknown" && resolved !== "applied") return "Reconciliation result must be none, unknown, or applied.";
    const resolution = { ...data, effect_authority: "target_readback", reason: string(data.reason) || `reconciled_${resolved}` };
    const error = applyEffect(original, resolution);
    if (error) return error;
    attempt.effect = { state: "none", reason: "reconciliation_is_read_only", authority: "target_readback", authority_id: string(data.authority_id) || null };
    attempt.evidence_refs = [...new Set([...attempt.evidence_refs, ...strings(data.evidence_refs)])];
    attempt.terminal_state = "reconciled";
    attempt.lease.state = "settled";
    attempt.lease.settled_at = event.occurred_at;
    original.terminal_state = "reconciled";
    original.lease.state = "settled";
    original.lease.settled_at = event.occurred_at;
    projection.phase = resolved === "applied" ? "verifying" : resolved === "unknown" ? "reconciling" : "planning";
    return null;
  }
  if (event.kind === "attempt_terminal") {
    if (attempt.effect.state === "unknown") return "An unknown-effect attempt requires reconciliation before terminal settlement.";
    attempt.terminal_state = "settled";
    attempt.lease.state = data.lease_state === "timed_out_read" ? "timed_out_read"
      : data.lease_state === "canceled_before_dispatch" ? "canceled_before_dispatch"
        : data.lease_state === "quarantined_late" ? "quarantined_late" : "settled";
    attempt.lease.settled_at = event.occurred_at;
    return null;
  }
  return "Unsupported event kind.";
}

export function reduceAssignmentControlPlane(assignmentId: string, events: readonly AssignmentAttemptEvent[]): AssignmentReduceResult {
  let projection = initialProjection(assignmentId);
  const acceptedEventIds: string[] = [];
  const rejected: AssignmentReduceResult["rejected"] = [];
  const seen = new Set<string>();
  for (const event of events) {
    if (seen.has(event.event_id)) continue;
    seen.add(event.event_id);
    const fenced = rejectReason(projection, event);
    if (fenced) {
      rejected.push({ event, reason: fenced });
      continue;
    }
    const candidate = JSON.parse(JSON.stringify(projection)) as AssignmentControlPlaneProjection;
    const semantic = applyAcceptedEvent(candidate, event);
    if (semantic) {
      rejected.push({ event, reason: semantic });
      continue;
    }
    projection = candidate;
    acceptedEventIds.push(event.event_id);
    projection.last_event_at = event.occurred_at;
    refreshDerived(projection);
  }
  return { projection, accepted_event_ids: acceptedEventIds, rejected };
}

export function emptyAssignmentControlPlane(): AssignmentControlPlaneLog {
  return { schema: ASSIGNMENT_CONTROL_PLANE_SCHEMA, events: [], quarantined_events: [] };
}

export function normalizeAssignmentControlPlane(value: unknown): AssignmentControlPlaneLog {
  const source = record(value);
  if (source.schema !== ASSIGNMENT_CONTROL_PLANE_SCHEMA) return emptyAssignmentControlPlane();
  const events = Array.isArray(source.events)
    ? source.events.filter(event => record(event).schema === ASSIGNMENT_ATTEMPT_EVENT_SCHEMA) as AssignmentAttemptEvent[]
    : [];
  const quarantined = Array.isArray(source.quarantined_events)
    ? source.quarantined_events.filter(entry => record(entry).event && string(record(entry).reason)) as AssignmentControlPlaneLog["quarantined_events"]
    : [];
  return { schema: ASSIGNMENT_CONTROL_PLANE_SCHEMA, events, quarantined_events: quarantined };
}
