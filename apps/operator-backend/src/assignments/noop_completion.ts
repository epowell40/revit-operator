import { createHash } from "node:crypto";

import { readAuthoritativeEvidence, readEvidenceRef } from "../evidence/evidence_store.js";
import { getGoal } from "../goals/service.js";
import {
  ASSIGNMENT_ATTEMPT_EVENT_SCHEMA,
  normalizeAssignmentControlPlane,
  reduceAssignmentControlPlane,
  type AssignmentAttemptEvent,
  type AssignmentAttemptRecord,
  type AssignmentControlPlaneProjection
} from "./control_plane.js";
import { appendAssignmentEvent } from "./control_plane_store.js";

export const NOOP_COMPLETION_CLAIM_SCHEMA = "revit-operator.assignment-noop-completion-claim/v1" as const;
type JsonMap = Record<string, unknown>;
type Scalar = string | number | boolean | null;

export type NoopAssertionInput = {
  assertion_id: string;
  attempt_id: string;
  evidence_id: string;
  operation: "field_equals" | "array_count";
  path: string;
  expected?: Scalar;
  expected_count?: number;
};

export type NoopCompletionClaimInput = {
  schema: typeof NOOP_COMPLETION_CLAIM_SCHEMA;
  assignment_id: string;
  run_id: string;
  generation: number;
  session_id: string;
  target_identity: string;
  target_fingerprint: string;
  desired_postcondition: { field_path: string; expected_value: Scalar };
  desired_source:
    | { kind: "user_request"; exact_text: string }
    | { kind: "clarification"; clarification_id: string; field: string };
  assertions: NoopAssertionInput[];
  criteria: Array<{ criterion: string; assertion_ids: string[] }>;
};

function record(value: unknown): JsonMap { return value && typeof value === "object" && !Array.isArray(value) ? value as JsonMap : {}; }
function text(value: unknown, max: number): string { const result = typeof value === "string" ? value.trim() : ""; return result && result.length <= max ? result : ""; }
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value as JsonMap).sort(([a], [b]) => a.localeCompare(b)).map(([key, child]) => [key, canonical(child)]));
}
function digest(value: unknown): string { return `sha256:${createHash("sha256").update(JSON.stringify(canonical(value)), "utf8").digest("hex")}`; }
function equivalent(left: unknown, right: unknown): boolean { return JSON.stringify(canonical(left)) === JSON.stringify(canonical(right)); }

function safePath(value: unknown): string {
  const normalized = text(value, 500).replace(/^\$\.?/, "").replace(/\[(\d+)\]/g, ".$1").replace(/^\./, "");
  if (!normalized || normalized.includes("..") || /[\\\[\]\x00-\x1f\x7f]/.test(normalized)
      || normalized.split(".").some(segment => !segment || segment === "__proto__" || segment === "prototype" || segment === "constructor")) {
    throw new Error("noop_completion_field_path_invalid");
  }
  return normalized;
}

function selected(root: unknown, path: string): unknown {
  let value = root;
  for (const segment of path.split(".")) {
    if (Array.isArray(value) && /^\d+$/.test(segment)) value = value[Number(segment)];
    else if (value && typeof value === "object" && Object.prototype.hasOwnProperty.call(value, segment)) value = (value as JsonMap)[segment];
    else return undefined;
  }
  return value;
}

function claimEvent(projection: AssignmentControlPlaneProjection, kind: "noop_completion_claimed" | "noop_completion_validated", data: JsonMap, actor: string): AssignmentAttemptEvent {
  return {
    schema: ASSIGNMENT_ATTEMPT_EVENT_SCHEMA,
    event_id: digest({ kind, assignment_id: projection.assignment_id, run_id: projection.run_id, generation: projection.generation, data }),
    assignment_id: projection.assignment_id,
    run_id: projection.run_id ?? "",
    generation: projection.generation,
    attempt_id: null,
    kind,
    occurred_at: new Date().toISOString(),
    actor,
    data
  };
}

function eligibleRead(attempt: AssignmentAttemptRecord | undefined, input: NoopCompletionClaimInput): boolean {
  return Boolean(attempt && attempt.generation === input.generation && attempt.purpose === "action"
    && attempt.requested_effect === "read" && attempt.admission.state === "admitted"
    && attempt.dispatch.state === "acknowledged" && attempt.terminal_state === "settled"
    && attempt.effect.state === "none"
    && ["native_host", "native_receipt", "target_readback", "independent_verifier"].includes(attempt.effect.authority)
    && attempt.target_fingerprint === input.target_fingerprint
    && attempt.target_identities.includes(input.target_identity)
    && attempt.receipt_refs.length > 0);
}

function desiredValue(goal: NonNullable<ReturnType<typeof getGoal>>, projection: AssignmentControlPlaneProjection, input: NoopCompletionClaimInput): Scalar {
  const desiredSource = input.desired_source;
  if (desiredSource.kind === "clarification") {
    const clarification = projection.clarifications.find(item => item.clarification_id === desiredSource.clarification_id && item.status === "resolved");
    if (!clarification || !Object.prototype.hasOwnProperty.call(clarification.supplied_values, desiredSource.field)) {
      throw new Error("desired_postcondition_missing");
    }
    const value = clarification.supplied_values[desiredSource.field];
    if (!equivalent(value, input.desired_postcondition.expected_value)) throw new Error("noop_completion_desired_source_mismatch");
    return input.desired_postcondition.expected_value;
  }
  const exact = text(desiredSource.exact_text, 5_000);
  const request = text(goal.work_budget?.source_user_request ?? goal.objective, 10_000);
  if (!exact || !request.includes(exact) || !equivalent(exact, input.desired_postcondition.expected_value)) {
    throw new Error("noop_completion_desired_source_mismatch");
  }
  return input.desired_postcondition.expected_value;
}

export function submitNoopCompletionClaim(input: NoopCompletionClaimInput): {
  accepted: boolean;
  reason: string;
  projection: AssignmentControlPlaneProjection;
} {
  if (input?.schema !== NOOP_COMPLETION_CLAIM_SCHEMA) throw new Error("noop_completion_schema_invalid");
  const goal = getGoal(text(input.assignment_id, 240));
  if (!goal) throw new Error("noop_completion_assignment_not_found");
  let projection = reduceAssignmentControlPlane(goal.id, normalizeAssignmentControlPlane(goal.assignment_control_plane).events).projection;
  if (projection.run_id !== text(input.run_id, 240) || projection.generation !== input.generation || goal.related_session_id !== text(input.session_id, 180)) {
    throw new Error("noop_completion_binding_mismatch");
  }
  if (projection.terminal_state !== "open") {
    if (projection.noop_completion.status === "accepted") return { accepted: true, reason: projection.noop_completion.reason ?? "noop_equivalence_proven", projection };
    throw new Error("noop_completion_assignment_terminal");
  }
  const targetIdentity = text(input.target_identity, 500);
  const targetFingerprint = text(input.target_fingerprint, 500);
  const fieldPath = safePath(input.desired_postcondition?.field_path);
  const desired = desiredValue(goal, projection, input);
  const assertions = input.assertions ?? [];
  if (!targetIdentity || !targetFingerprint || assertions.length < 2 || assertions.length > 64) throw new Error("noop_completion_assertions_invalid");
  const assertionIds = new Set(assertions.map(assertion => text(assertion.assertion_id, 160)));
  const goalCriteria = goal.acceptance_criteria.map(criterion => criterion.toLowerCase()).sort();
  const claimCriteria = (input.criteria ?? []).map(criterion => text(criterion.criterion, 1_200).toLowerCase()).sort();
  if (goalCriteria.length !== claimCriteria.length || goalCriteria.some((criterion, index) => criterion !== claimCriteria[index])
      || input.criteria.some(criterion => !criterion.assertion_ids.length || criterion.assertion_ids.some(id => !assertionIds.has(id)))) {
    throw new Error("noop_completion_criteria_incomplete");
  }
  const claimId = `noop:${digest({ input, desired }).slice(7, 47)}`;
  const opened = appendAssignmentEvent(goal.id, claimEvent(projection, "noop_completion_claimed", {
    claim_id: claimId,
    target_fingerprint: targetFingerprint,
    desired_value_digest: digest({ field_path: fieldPath, expected_value: desired }),
    supporting_attempt_ids: [...new Set(assertions.map(assertion => assertion.attempt_id))],
    supporting_evidence_refs: [...new Set(assertions.map(assertion => assertion.evidence_id))]
  }, "operator_submit_noop_completion"));
  if (!opened.accepted) throw new Error(opened.quarantined_reason ?? "noop_completion_claim_rejected");
  projection = opened.projection;
  let reason = "noop_equivalence_proven";
  try {
    if (projection.requested_effect !== "apply") throw new Error("noop_completion_not_apply_assignment");
    if (!projection.quiescent) throw new Error("noop_completion_not_quiescent");
    if (projection.pending_clarification_id) throw new Error("required_input_missing");
    if (projection.unresolved_unknown_attempt_ids.length) throw new Error("noop_completion_unknown_effect");
    if (projection.attempts.some(attempt => attempt.requested_effect === "apply")) throw new Error("noop_completion_unexpected_apply");
    const exactObservations = assertions.filter(assertion => assertion.operation === "field_equals"
      && safePath(assertion.path) === fieldPath && equivalent(assertion.expected, desired));
    if (new Set(exactObservations.map(assertion => assertion.attempt_id)).size < 2
        || new Set(exactObservations.map(assertion => assertion.evidence_id)).size < 2) {
      throw new Error("noop_completion_two_fresh_observations_required");
    }
    const distinctReceipts = new Set<string>();
    for (const assertion of assertions) {
      const attempt = projection.attempts.find(candidate => candidate.attempt_id === assertion.attempt_id);
      if (!eligibleRead(attempt, input) || !attempt!.evidence_refs.includes(assertion.evidence_id)) throw new Error("noop_completion_ineligible_observation");
      attempt!.receipt_refs.forEach(ref => distinctReceipts.add(ref));
      const ref = readEvidenceRef(assertion.evidence_id);
      if (!["authoritative_native", "authoritative_readback"].includes(ref.trust_level)) throw new Error("noop_completion_evidence_not_authoritative");
      const bytes = readAuthoritativeEvidence(ref, {
        session_id: input.session_id, assignment_id: input.assignment_id, run_id: input.run_id,
        attempt_id: assertion.attempt_id, generation: input.generation
      });
      const value = selected(JSON.parse(bytes.toString("utf8")), safePath(assertion.path));
      const passed = assertion.operation === "field_equals"
        ? assertion.expected !== undefined && equivalent(value, assertion.expected)
        : Array.isArray(value) && Number.isSafeInteger(assertion.expected_count) && value.length === assertion.expected_count;
      if (!passed) throw new Error("noop_equivalence_not_proven");
    }
    if (distinctReceipts.size < 2) throw new Error("noop_completion_two_fresh_observations_required");
  } catch (error) {
    reason = error instanceof Error ? error.message : "noop_equivalence_not_proven";
  }
  const accepted = reason === "noop_equivalence_proven";
  const validated = appendAssignmentEvent(goal.id, claimEvent(projection, "noop_completion_validated", {
    claim_id: claimId,
    accepted,
    reason
  }, "canonical_noop_completion_validator"));
  if (!validated.accepted) throw new Error(validated.quarantined_reason ?? "noop_completion_validation_rejected");
  return { accepted, reason, projection: validated.projection };
}
