import { createHash } from "node:crypto";

import { readAuthoritativeEvidence, readEvidenceRef } from "../evidence/evidence_store.js";
import {
  appendGoalProgress,
  appendTrustedServerGoalValidation,
  getActiveGoalForSession,
  getGoal,
  requestGoalCompletionAudit,
  updateGoal,
  type GoalRecord
} from "../goals/service.js";
import {
  ASSIGNMENT_ATTEMPT_EVENT_SCHEMA,
  normalizeAssignmentControlPlane,
  reduceAssignmentControlPlane,
  type AssignmentAttemptEvent,
  type AssignmentAttemptRecord,
  type AssignmentControlPlaneProjection
} from "./control_plane.js";
import { appendAssignmentEvent } from "./control_plane_store.js";

export const READ_COMPLETION_CLAIM_SCHEMA = "revit-operator.assignment-read-completion-claim/v1" as const;

type JsonScalar = string | number | boolean | null;

export type ReadCompletionAssertionV1 = {
  assertion_id: string;
  attempt_id: string;
  evidence_id: string;
  operation: "field_equals" | "array_count" | "group_count";
  path: string;
  expected?: unknown;
  expected_count?: number;
  group_by?: string[];
  expected_total?: number;
  expected_groups?: Array<{ values: JsonScalar[]; count: number }>;
};

export type ReadCompletionClaimV1 = {
  schema: typeof READ_COMPLETION_CLAIM_SCHEMA;
  claim_id: string;
  assignment_id: string;
  run_id: string;
  generation: number;
  session_id: string;
  principal_id: string | null;
  document_fingerprint: string | null;
  requested_effect: "read";
  claim_type: "read_complete";
  criteria: Array<{ criterion: string; assertion_ids: string[] }>;
  result: {
    kind: "inventory" | "lookup" | "artifact" | "target_result" | "structured_read";
    assertions: ReadCompletionAssertionV1[];
  };
  supporting_attempt_ids: string[];
  supporting_receipt_refs: string[];
  supporting_evidence_refs: string[];
  result_digest: string;
  claimant_controller: string;
  created_at_utc: string;
};

export type ReadCompletionClaimInput = {
  schema?: unknown;
  assignment_id?: unknown;
  run_id?: unknown;
  generation?: unknown;
  session_id?: unknown;
  criteria?: unknown;
  result?: unknown;
};

export type ReadCompletionValidation = {
  accepted: boolean;
  reason: string;
  claim: ReadCompletionClaimV1 | null;
  projection: AssignmentControlPlaneProjection;
};

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function text(value: unknown, max: number): string {
  const normalized = typeof value === "string" ? value.trim() : "";
  if (!normalized || normalized.length > max) return "";
  return normalized;
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, nested]) => [key, canonical(nested)]));
}

function jsonClone(value: unknown, maxBytes = 64_000): unknown {
  const serialized = JSON.stringify(value);
  if (serialized === undefined || Buffer.byteLength(serialized, "utf8") > maxBytes) {
    throw new Error("read_completion_result_too_large");
  }
  return JSON.parse(serialized) as unknown;
}

function digest(value: unknown): string {
  return `sha256:${createHash("sha256").update(JSON.stringify(canonical(value)), "utf8").digest("hex")}`;
}

function safePath(value: unknown, label: string): string {
  const path = text(value, 500);
  if (!path || path.includes("..") || /[\\\u0000]/.test(path)
      || path.split(".").some(segment => !segment || segment === "__proto__" || segment === "prototype" || segment === "constructor")) {
    throw new Error(`${label}_invalid`);
  }
  return path.replace(/^\$\.?/, "");
}

function positiveInteger(value: unknown, label: string, max = Number.MAX_SAFE_INTEGER): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0 || Number(value) > max) throw new Error(`${label}_invalid`);
  return Number(value);
}

function scalar(value: unknown, label: string): JsonScalar {
  if (value === null || typeof value === "boolean" || typeof value === "string") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  throw new Error(`${label}_must_be_scalar`);
}

function normalizeAssertion(value: unknown, index: number): ReadCompletionAssertionV1 {
  const row = record(value);
  const assertionId = text(row.assertion_id ?? row.assertionId, 160);
  const attemptId = text(row.attempt_id ?? row.attemptId, 300);
  const evidenceId = text(row.evidence_id ?? row.evidenceId, 80);
  const operation = text(row.operation, 40);
  if (!assertionId || !attemptId || !/^ev1_[A-Za-z0-9_-]{32}$/.test(evidenceId)) {
    throw new Error(`read_completion_assertion_${index}_identity_invalid`);
  }
  if (operation !== "field_equals" && operation !== "array_count" && operation !== "group_count") {
    throw new Error(`read_completion_assertion_${index}_operation_invalid`);
  }
  const path = safePath(row.path, `read_completion_assertion_${index}_path`);
  if (operation === "field_equals") {
    if (!Object.prototype.hasOwnProperty.call(row, "expected")) throw new Error(`read_completion_assertion_${index}_expected_missing`);
    return { assertion_id: assertionId, attempt_id: attemptId, evidence_id: evidenceId, operation, path, expected: jsonClone(row.expected) };
  }
  if (operation === "array_count") {
    return {
      assertion_id: assertionId, attempt_id: attemptId, evidence_id: evidenceId, operation, path,
      expected_count: positiveInteger(row.expected_count ?? row.expectedCount, `read_completion_assertion_${index}_expected_count`, 2_000_000)
    };
  }
  const rawGroupBy = row.group_by ?? row.groupBy;
  const groupBy = Array.isArray(rawGroupBy)
    ? rawGroupBy.map((item, groupIndex) => safePath(item, `read_completion_assertion_${index}_group_by_${groupIndex}`))
    : [];
  if (groupBy.length < 1 || groupBy.length > 8) throw new Error(`read_completion_assertion_${index}_group_by_invalid`);
  const rawGroups = row.expected_groups ?? row.expectedGroups;
  const groups = Array.isArray(rawGroups) ? rawGroups : [];
  if (groups.length < 1 || groups.length > 2_000) throw new Error(`read_completion_assertion_${index}_expected_groups_invalid`);
  const expectedGroups = groups.map((entry, groupIndex) => {
    const group = record(entry);
    const values = Array.isArray(group.values) ? group.values.map((item, valueIndex) => scalar(item, `read_completion_assertion_${index}_group_${groupIndex}_value_${valueIndex}`)) : [];
    if (values.length !== groupBy.length) throw new Error(`read_completion_assertion_${index}_group_${groupIndex}_arity_invalid`);
    return {
      values,
      count: positiveInteger(group.count, `read_completion_assertion_${index}_group_${groupIndex}_count`, 2_000_000)
    };
  });
  return {
    assertion_id: assertionId, attempt_id: attemptId, evidence_id: evidenceId, operation, path,
    group_by: groupBy,
    expected_total: positiveInteger(row.expected_total ?? row.expectedTotal, `read_completion_assertion_${index}_expected_total`, 2_000_000),
    expected_groups: expectedGroups
  };
}

function projection(goal: GoalRecord): AssignmentControlPlaneProjection {
  return reduceAssignmentControlPlane(goal.id, normalizeAssignmentControlPlane(goal.assignment_control_plane).events).projection;
}

function normalizeClaim(input: ReadCompletionClaimInput, goal: GoalRecord, controller: string): ReadCompletionClaimV1 {
  const current = projection(goal);
  if ((input.schema ?? READ_COMPLETION_CLAIM_SCHEMA) !== READ_COMPLETION_CLAIM_SCHEMA) throw new Error("read_completion_claim_schema_invalid");
  const assignmentId = text(input.assignment_id, 240);
  const runId = text(input.run_id, 240);
  const sessionId = text(input.session_id, 180);
  const generation = positiveInteger(input.generation, "read_completion_generation", 1_000_000);
  if (assignmentId !== goal.id || runId !== current.run_id || generation !== current.generation || sessionId !== goal.related_session_id) {
    throw new Error("read_completion_claim_binding_mismatch");
  }
  const resultRow = record(input.result);
  const kind = text(resultRow.kind, 80) as ReadCompletionClaimV1["result"]["kind"];
  if (!["inventory", "lookup", "artifact", "target_result", "structured_read"].includes(kind)) throw new Error("read_completion_result_kind_invalid");
  const assertions = Array.isArray(resultRow.assertions) ? resultRow.assertions.map(normalizeAssertion) : [];
  if (assertions.length < 1 || assertions.length > 64 || new Set(assertions.map(item => item.assertion_id)).size !== assertions.length) {
    throw new Error("read_completion_assertions_invalid");
  }
  const assertionIds = new Set(assertions.map(item => item.assertion_id));
  const criteria = Array.isArray(input.criteria) ? input.criteria.map((value, index) => {
    const row = record(value);
    const criterion = text(row.criterion, 1_200);
    const rawAssertionIds = row.assertion_ids ?? row.assertionIds;
    const ids = Array.isArray(rawAssertionIds)
      ? [...new Set(rawAssertionIds.map(item => text(item, 160)).filter(Boolean))]
      : [];
    if (!criterion || ids.length < 1 || ids.some(id => !assertionIds.has(id))) throw new Error(`read_completion_criterion_${index}_invalid`);
    return { criterion, assertion_ids: ids };
  }) : [];
  if (criteria.length !== goal.acceptance_criteria.length || new Set(criteria.map(item => item.criterion.toLowerCase())).size !== criteria.length) {
    throw new Error("read_completion_criteria_incomplete");
  }
  const goalCriteria = [...goal.acceptance_criteria].map(item => item.toLowerCase()).sort();
  if (criteria.map(item => item.criterion.toLowerCase()).sort().some((item, index) => item !== goalCriteria[index])) {
    throw new Error("read_completion_criteria_incomplete");
  }
  const supportingAttemptIds = [...new Set(assertions.map(item => item.attempt_id))];
  const supportingEvidenceRefs = [...new Set(assertions.map(item => item.evidence_id))];
  const supportingReceiptRefs = [...new Set(current.attempts
    .filter(attempt => supportingAttemptIds.includes(attempt.attempt_id))
    .flatMap(attempt => attempt.receipt_refs))];
  const normalizedResult = { kind, assertions };
  const resultDigest = digest(normalizedResult);
  const claimIdentity = {
    assignment_id: assignmentId, run_id: runId, generation, session_id: sessionId,
    criteria, result: normalizedResult, claimant_controller: controller
  };
  return {
    schema: READ_COMPLETION_CLAIM_SCHEMA,
    claim_id: `read-claim:${digest(claimIdentity).slice(7, 47)}`,
    assignment_id: assignmentId,
    run_id: runId,
    generation,
    session_id: sessionId,
    principal_id: goal.created_by ?? null,
    document_fingerprint: text(goal.work_budget?.document_fingerprint, 256) || null,
    requested_effect: "read",
    claim_type: "read_complete",
    criteria,
    result: normalizedResult,
    supporting_attempt_ids: supportingAttemptIds,
    supporting_receipt_refs: supportingReceiptRefs,
    supporting_evidence_refs: supportingEvidenceRefs,
    result_digest: resultDigest,
    claimant_controller: controller,
    created_at_utc: new Date().toISOString()
  };
}

function claimEvent(claim: ReadCompletionClaimV1): AssignmentAttemptEvent {
  return {
    schema: ASSIGNMENT_ATTEMPT_EVENT_SCHEMA,
    event_id: digest({ kind: "read_completion_claimed", claim_id: claim.claim_id }),
    assignment_id: claim.assignment_id,
    run_id: claim.run_id,
    generation: claim.generation,
    attempt_id: null,
    kind: "read_completion_claimed",
    occurred_at: claim.created_at_utc,
    actor: claim.claimant_controller,
    data: {
      claim_id: claim.claim_id,
      result_digest: claim.result_digest,
      supporting_attempt_ids: claim.supporting_attempt_ids,
      supporting_receipt_refs: claim.supporting_receipt_refs,
      supporting_evidence_refs: claim.supporting_evidence_refs,
      claim
    }
  };
}

export function submitReadCompletionClaim(input: ReadCompletionClaimInput, claimantController = "codex_app_server"): {
  claim: ReadCompletionClaimV1;
  projection: AssignmentControlPlaneProjection;
  accepted: boolean;
} {
  const assignmentId = text(input.assignment_id, 240);
  const goal = getGoal(assignmentId);
  if (!goal) throw new Error("read_completion_assignment_not_found");
  const current = projection(goal);
  const claim = normalizeClaim(input, goal, text(claimantController, 160) || "operator-backend");
  if (current.terminal_state !== "open") {
    if (current.read_completion.claim_id === claim.claim_id && current.read_completion.status === "accepted") {
      return { claim, projection: current, accepted: true };
    }
    throw new Error("read_completion_assignment_terminal");
  }
  const appended = appendAssignmentEvent(goal.id, claimEvent(claim));
  if (!appended.accepted) throw new Error(appended.quarantined_reason ?? "read_completion_claim_rejected");
  return { claim, projection: appended.projection, accepted: true };
}

function latestClaim(goal: GoalRecord): ReadCompletionClaimV1 | null {
  const events = normalizeAssignmentControlPlane(goal.assignment_control_plane).events;
  const row = [...events].reverse().find(event => event.kind === "read_completion_claimed")?.data?.claim;
  const claim = record(row);
  return claim.schema === READ_COMPLETION_CLAIM_SCHEMA ? claim as unknown as ReadCompletionClaimV1 : null;
}

function decodeEnvelope(value: unknown): unknown {
  let current = value;
  for (let depth = 0; depth < 8; depth += 1) {
    if (typeof current === "string") {
      const source = current.trim();
      if (!source || (!source.startsWith("{") && !source.startsWith("["))) break;
      try { current = JSON.parse(source); continue; } catch { break; }
    }
    const row = record(current);
    const content = Array.isArray(row.content) ? row.content : [];
    if (content.length === 1) {
      const item = record(content[0]);
      const nested = typeof item.text === "string" ? item.text.trim() : "";
      if (nested.startsWith("{") || nested.startsWith("[")) {
        try { current = JSON.parse(nested); continue; } catch {}
      }
    }
    break;
  }
  return current;
}

function selected(root: unknown, path: string): unknown {
  let value = decodeEnvelope(root);
  for (const segment of path.split(".")) {
    value = decodeEnvelope(value);
    if (Array.isArray(value) && /^\d+$/.test(segment)) value = value[Number(segment)];
    else if (value && typeof value === "object" && Object.prototype.hasOwnProperty.call(value, segment)) {
      value = (value as Record<string, unknown>)[segment];
    } else return undefined;
  }
  return decodeEnvelope(value);
}

function equivalent(left: unknown, right: unknown): boolean {
  return JSON.stringify(canonical(left)) === JSON.stringify(canonical(right));
}

function groupRows(rows: unknown[], fields: string[]): Array<{ values: JsonScalar[]; count: number }> | null {
  const counts = new Map<string, { values: JsonScalar[]; count: number }>();
  for (const row of rows) {
    const values: JsonScalar[] = [];
    for (const field of fields) {
      const value = selected(row, field);
      try { values.push(scalar(value, "group_value")); } catch { return null; }
    }
    const key = JSON.stringify(values);
    const existing = counts.get(key);
    if (existing) existing.count += 1;
    else counts.set(key, { values, count: 1 });
  }
  return [...counts.values()].sort((left, right) => JSON.stringify(left.values).localeCompare(JSON.stringify(right.values)));
}

function assertionResult(assertion: ReadCompletionAssertionV1, root: unknown): { ok: boolean; observed: unknown } {
  const value = selected(root, assertion.path);
  if (assertion.operation === "field_equals") return { ok: value !== undefined && equivalent(value, assertion.expected), observed: value };
  if (!Array.isArray(value)) return { ok: false, observed: value };
  if (assertion.operation === "array_count") return { ok: value.length === assertion.expected_count, observed: value.length };
  const groups = groupRows(value, assertion.group_by ?? []);
  const expected = [...(assertion.expected_groups ?? [])]
    .sort((left, right) => JSON.stringify(left.values).localeCompare(JSON.stringify(right.values)));
  return {
    ok: value.length === assertion.expected_total && groups !== null && equivalent(groups, expected),
    observed: { total: value.length, groups }
  };
}

const READ_AUTHORITIES = new Set(["native_host", "native_receipt", "target_readback", "independent_verifier"]);

function attemptReason(attempt: AssignmentAttemptRecord | undefined): string | null {
  if (!attempt || attempt.generation < 1) return "read_completion_supporting_attempt_missing";
  if (attempt.requested_effect !== "read") return "read_completion_supporting_attempt_not_read";
  if (attempt.purpose !== "action") return "read_completion_discovery_only";
  if (attempt.admission.state !== "admitted") return "read_completion_supporting_attempt_not_admitted";
  if (attempt.dispatch.state !== "acknowledged") return "read_completion_supporting_attempt_not_dispatched";
  if (attempt.terminal_state !== "settled") return "read_completion_supporting_attempt_unsettled";
  if (attempt.effect.state !== "none") return "read_completion_unexpected_effect";
  if (!READ_AUTHORITIES.has(attempt.effect.authority)) return "read_completion_result_authority_unaccepted";
  if (attempt.receipt_refs.length < 1) return "read_completion_missing_receipt";
  return null;
}

function taskShapeReason(goal: GoalRecord, claim: ReadCompletionClaimV1): string | null {
  const request = `${goal.work_budget?.source_user_request ?? goal.objective}`.toLowerCase();
  const assertions = claim.result.assertions;
  const requiresCount = /\b(?:count|how many|total)\b/.test(request);
  const requiresGrouping = /\b(?:break\s*down|breakdown|group(?:ed|ing)?|by\s+(?:family|type|category|level|system|circuit|room|space|host))\b/.test(request);
  if (requiresCount && !assertions.some(assertion => assertion.operation === "array_count"
      || assertion.operation === "group_count"
      || (assertion.operation === "field_equals" && /(?:^|\.)(?:count|total|total_count|totalcount)$/i.test(assertion.path)))) {
    return "read_completion_criteria_incomplete";
  }
  if (requiresGrouping && !assertions.some(assertion => assertion.operation === "group_count")) {
    return "read_completion_criteria_incomplete";
  }
  const requestedDimensions = ["family", "type", "category", "level", "system", "circuit", "room", "space", "host"]
    .filter(dimension => new RegExp(`\\b(?:by|per|group(?:ed)? by|break\\s*down by)?\\s*${dimension}\\b`, "i").test(request));
  if (requiresGrouping && requestedDimensions.length > 0) {
    const groupingFields = assertions.filter(assertion => assertion.operation === "group_count")
      .flatMap(assertion => assertion.group_by ?? []).map(field => field.split(".").at(-1)!.toLowerCase());
    if (requestedDimensions.some(dimension => !groupingFields.some(field => field === dimension || field.endsWith(`_${dimension}`)))) {
      return "read_completion_criteria_incomplete";
    }
  }
  return null;
}

function assertionContradiction(claim: ReadCompletionClaimV1): boolean {
  const expectedByKey = new Map<string, string>();
  for (const assertion of claim.result.assertions) {
    const key = `${assertion.operation}:${assertion.path}`;
    const expected = digest(assertion.operation === "field_equals" ? assertion.expected
      : assertion.operation === "array_count" ? assertion.expected_count
        : { total: assertion.expected_total, group_by: assertion.group_by, groups: assertion.expected_groups });
    const prior = expectedByKey.get(key);
    if (prior && prior !== expected) return true;
    expectedByKey.set(key, expected);
  }
  return false;
}

function validationEvent(
  claim: ReadCompletionClaimV1,
  accepted: boolean,
  reason: string,
  projectionValue: AssignmentControlPlaneProjection
): AssignmentAttemptEvent {
  return {
    schema: ASSIGNMENT_ATTEMPT_EVENT_SCHEMA,
    event_id: digest({ kind: "read_completion_validated", claim_id: claim.claim_id, accepted, reason }),
    assignment_id: claim.assignment_id,
    run_id: claim.run_id,
    generation: claim.generation,
    attempt_id: null,
    kind: "read_completion_validated",
    occurred_at: new Date().toISOString(),
    actor: "canonical_read_completion_validator",
    data: {
      claim_id: claim.claim_id,
      accepted,
      reason,
      result_digest: claim.result_digest,
      supporting_attempt_ids: claim.supporting_attempt_ids,
      supporting_receipt_refs: claim.supporting_receipt_refs,
      supporting_evidence_refs: claim.supporting_evidence_refs,
      quiescent: projectionValue.quiescent
    }
  };
}

function reject(goal: GoalRecord, claim: ReadCompletionClaimV1, reason: string): ReadCompletionValidation {
  const current = projection(goal);
  const appended = appendAssignmentEvent(goal.id, validationEvent(claim, false, reason, current));
  return { accepted: false, reason, claim, projection: appended.projection };
}

function existingValidationRef(goal: GoalRecord, claimId: string, criterion: string): string | null {
  const match = goal.validation_log.find(entry => {
    const evidence = record(entry.evidence);
    const validator = record(evidence.validator);
    return evidence.kind === "validator" && evidence.criterion === criterion
      && validator.identity === `canonical-read-completion:${claimId}`;
  });
  return match ? `validation:${match.id}` : null;
}

function materializeGoalAudit(goal: GoalRecord, claim: ReadCompletionClaimV1): GoalRecord {
  const evidenceRefs = [...claim.supporting_evidence_refs];
  const primaryItems = goal.work_items.filter(item => ["auto.revit-work", "sidecar.requested-work"].includes(item.id));
  const unsupportedOpenItems = goal.work_items.filter(item => !["complete", "skipped"].includes(item.status)
    && !primaryItems.some(primary => primary.id === item.id));
  if (unsupportedOpenItems.length > 0) throw new Error("read_completion_criteria_incomplete");
  const previousObservations = record(goal.work_budget?.criterion_observations);
  goal = updateGoal(goal.id, {
    work_budget: {
      ...(goal.work_budget ?? {}),
      canonical_read_completion: {
        claim_id: claim.claim_id,
        result_digest: claim.result_digest,
        supporting_attempt_ids: claim.supporting_attempt_ids,
        supporting_receipt_refs: claim.supporting_receipt_refs,
        supporting_evidence_refs: claim.supporting_evidence_refs
      },
      criterion_observations: {
        ...previousObservations,
        ...Object.fromEntries(claim.criteria.map(item => [item.criterion, {
          observed_value: {
            structured_result_digest: claim.result_digest,
            assertion_ids: item.assertion_ids,
            evidence_refs: claim.supporting_evidence_refs
          },
          expected_value: item.criterion,
          reason: `Deterministic read-completion assertions ${item.assertion_ids.join(", ")} passed against bound authoritative evidence.`
        }]))
      }
    }
  });
  if (primaryItems.length > 0) {
    goal = appendGoalProgress(claim.session_id, {
      summary: `Canonical read completion claim ${claim.claim_id} passed deterministic evidence validation.`,
      work_items: primaryItems.map(item => ({
        ...item,
        status: "complete",
        blocker: null,
        evidence_refs: [...new Set([...item.evidence_refs, ...evidenceRefs])],
        result_summary: `Structured read result ${claim.result_digest} is supported by ${claim.supporting_evidence_refs.length} EvidenceRef(s).`
      }))
    });
  }
  const criterionRefs: Array<{ criterion: string; evidence_ref: string }> = [];
  for (const criterion of goal.acceptance_criteria) {
    let ref = existingValidationRef(goal, claim.claim_id, criterion);
    if (!ref) {
      goal = appendTrustedServerGoalValidation(goal.id, {
        criterion,
        validator_id: `canonical-read-completion:${claim.claim_id}`,
        method: `Deterministically validated ${claim.result.kind} result ${claim.result_digest} against bound attempts ${claim.supporting_attempt_ids.join(", ")} and EvidenceRefs ${claim.supporting_evidence_refs.join(", ")}.`,
        status: "pass"
      });
      ref = `validation:${goal.validation_log.at(-1)!.id}`;
    }
    criterionRefs.push({ criterion, evidence_ref: ref });
  }
  goal = requestGoalCompletionAudit(goal.id, {
    criteria_results: criterionRefs.map(item => ({ criterion: item.criterion, status: "pass", evidence_refs: [item.evidence_ref] })),
    evidence_summary: `Canonical read completion ${claim.claim_id}; result ${claim.result_digest}; EvidenceRefs ${claim.supporting_evidence_refs.join(", ")}.`,
    recommendation: "The evidence-backed read-completion claim passed canonical validation."
  });
  if (!goal.completion_audit?.complete) throw new Error("read_completion_criteria_incomplete");
  return goal;
}

export function validateLatestReadCompletionClaim(sessionId: string): ReadCompletionValidation {
  const goal = getActiveGoalForSession(text(sessionId, 180));
  if (!goal) throw new Error("read_completion_no_active_assignment");
  let current = projection(goal);
  const claim = latestClaim(goal);
  if (!claim) return { accepted: false, reason: "read_completion_claim_missing", claim: null, projection: current };
  if (claim.assignment_id !== goal.id || claim.run_id !== current.run_id || claim.generation !== current.generation
      || claim.session_id !== goal.related_session_id) return reject(goal, claim, "read_completion_claim_binding_mismatch");
  if (`${goal.work_budget?.requested_effect ?? ""}` !== "read") return reject(goal, claim, "read_completion_unexpected_apply");
  if (current.terminal_state !== "open") return { accepted: current.read_completion.status === "accepted", reason: `assignment_terminal:${current.terminal_state}`, claim, projection: current };
  if (!current.quiescent || current.in_flight_count !== 0) {
    return { accepted: false, reason: "read_completion_not_quiescent", claim, projection: current };
  }
  if (current.unresolved_unknown_attempt_ids.length > 0) return reject(goal, claim, "read_completion_unknown_effect");
  if (current.attempts.some(attempt => attempt.requested_effect === "apply")) return reject(goal, claim, "read_completion_unexpected_apply");
  if (assertionContradiction(claim)) return reject(goal, claim, "read_completion_conflicting_evidence");
  const taskShape = taskShapeReason(goal, claim);
  if (taskShape) return reject(goal, claim, taskShape);
  const log = normalizeAssignmentControlPlane(goal.assignment_control_plane);
  const conflicts = log.quarantined_events.filter(entry => claim.supporting_attempt_ids.includes(entry.event.attempt_id ?? "")
    && /native_settlement_(?:assignment|attempt|requested_effect).*conflict|stale.*evidence|cross.*run/i.test(entry.reason));
  if (conflicts.length > 0) return reject(goal, claim, "read_completion_conflicting_evidence");

  const assertions = new Map(claim.result.assertions.map(assertion => [assertion.assertion_id, assertion]));
  if (claim.criteria.length !== goal.acceptance_criteria.length
      || claim.criteria.some(item => !goal.acceptance_criteria.some(criterion => criterion.toLowerCase() === item.criterion.toLowerCase())
        || item.assertion_ids.length < 1 || item.assertion_ids.some(id => !assertions.has(id)))) {
    return reject(goal, claim, "read_completion_criteria_incomplete");
  }
  for (const assertion of claim.result.assertions) {
    const attempt = current.attempts.find(candidate => candidate.attempt_id === assertion.attempt_id);
    const invalidAttempt = attemptReason(attempt);
    if (invalidAttempt) return reject(goal, claim, invalidAttempt);
    if (!attempt || attempt.run_id !== current.run_id || attempt.generation !== current.generation) {
      return reject(goal, claim, "read_completion_cross_run_evidence");
    }
    if (!attempt.evidence_refs.includes(assertion.evidence_id)) return reject(goal, claim, "read_completion_missing_evidence");
    let ref;
    let bytes;
    try {
      ref = readEvidenceRef(assertion.evidence_id);
      if (ref.assignment_id !== goal.id || ref.run_id !== current.run_id || ref.generation !== current.generation
          || ref.session_id !== claim.session_id || ref.attempt_id !== assertion.attempt_id) {
        return reject(goal, claim, "read_completion_cross_run_evidence");
      }
      if (ref.trust_level !== "authoritative_native" && ref.trust_level !== "authoritative_readback") {
        return reject(goal, claim, "read_completion_result_authority_unaccepted");
      }
      bytes = readAuthoritativeEvidence(ref, {
        session_id: claim.session_id,
        assignment_id: goal.id,
        run_id: current.run_id,
        attempt_id: assertion.attempt_id,
        generation: current.generation
      });
    } catch {
      return reject(goal, claim, "read_completion_missing_evidence");
    }
    let raw: unknown = bytes.toString("utf8");
    try { raw = JSON.parse(raw as string); } catch {}
    if (!assertionResult(assertion, raw).ok) return reject(goal, claim, "read_completion_result_not_supported");
  }

  let audited: GoalRecord;
  try { audited = materializeGoalAudit(goal, claim); }
  catch (error) { return reject(getGoal(goal.id) ?? goal, claim, error instanceof Error ? error.message : "read_completion_criteria_incomplete"); }
  current = projection(audited);
  const appended = appendAssignmentEvent(goal.id, validationEvent(claim, true, "authoritative_read_completed", current));
  return {
    accepted: appended.accepted && appended.projection.read_completion.status === "accepted",
    reason: appended.accepted ? "authoritative_read_completed" : appended.quarantined_reason ?? "read_completion_validation_rejected",
    claim,
    projection: appended.projection
  };
}
