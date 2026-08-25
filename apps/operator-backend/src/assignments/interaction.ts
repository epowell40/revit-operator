import { createHash } from "node:crypto";

import { getGoal } from "../goals/service.js";
import { getRequestPrincipal } from "../request_context.js";
import {
  ASSIGNMENT_ATTEMPT_EVENT_SCHEMA,
  normalizeAssignmentControlPlane,
  reduceAssignmentControlPlane,
  type AssignmentAttemptEvent,
  type AssignmentClarificationRecord,
  type AssignmentControlPlaneProjection,
  type AssignmentCriterionState
} from "./control_plane.js";
import { appendAssignmentEvent } from "./control_plane_store.js";

export const ASSIGNMENT_CLARIFICATION_SCHEMA = "revit-operator.assignment-clarification/v1" as const;
export const ASSIGNMENT_CLARIFICATION_RESPONSE_SCHEMA = "revit-operator.assignment-clarification-response/v1" as const;

type JsonMap = Record<string, unknown>;
type CriterionInput = {
  criterion: string;
  state: "partial" | "needs_input" | "needs_review" | "uncertain";
  reason?: string;
  evidence_refs?: string[];
  work_unit_ids?: string[];
};

export type AssignmentClarificationRequestInput = {
  schema: typeof ASSIGNMENT_CLARIFICATION_SCHEMA;
  clarification_id?: string;
  assignment_id: string;
  run_id: string;
  generation: number;
  session_id: string;
  missing_fields: string[];
  question: string;
  reason: string;
  completed_work?: string[];
  affected_subtasks?: string[];
  options?: Array<{ id: string; label: string }>;
  recommended_default?: string | null;
  primary_artifact_refs?: string[];
  criterion_states?: CriterionInput[];
};

export type AssignmentClarificationResponseInput = {
  schema: typeof ASSIGNMENT_CLARIFICATION_RESPONSE_SCHEMA;
  clarification_id: string;
  assignment_id: string;
  run_id: string;
  generation: number;
  session_id: string;
  response: string;
  supplied_values: Record<string, unknown>;
};

function text(value: unknown, max = 2_000): string {
  const normalized = typeof value === "string" ? value.trim() : "";
  return normalized.length <= max ? normalized : "";
}

function stringList(value: unknown, maxItems = 80, maxLength = 500): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map(item => text(item, maxLength)).filter(Boolean))].slice(0, maxItems);
}

function object(value: unknown): JsonMap {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonMap : {};
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value as JsonMap)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, nested]) => [key, canonical(nested)]));
}

function digest(value: unknown): string {
  return `sha256:${createHash("sha256").update(JSON.stringify(canonical(value)), "utf8").digest("hex")}`;
}

const SECRET_PATTERNS = [
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
  /\bBearer\s+[A-Za-z0-9._~+\/-]{24,}={0,2}\b/i,
  /\b(?:api[_-]?key|client[_-]?secret|access[_-]?token)\s*[:=]\s*["']?[A-Za-z0-9._~+\/-]{24,}/i
] as const;

function assertSecretFree(value: unknown): void {
  const serialized = JSON.stringify(value);
  if (Buffer.byteLength(serialized, "utf8") > 64_000) throw new Error("assignment_interaction_payload_too_large");
  if (SECRET_PATTERNS.some(pattern => pattern.test(serialized))) throw new Error("assignment_interaction_secret_like_content");
  const pending: unknown[] = [value];
  while (pending.length) {
    const item = pending.pop();
    if (Array.isArray(item)) {
      pending.push(...item);
      continue;
    }
    for (const [key, nested] of Object.entries(object(item))) {
      if (/(authorization|cookie|password|passwd|secret|token|api[_-]?key|private[_-]?key|credential)/i.test(key)) {
        throw new Error("assignment_interaction_sensitive_field_forbidden");
      }
      if (nested && typeof nested === "object") pending.push(nested);
    }
  }
}

function safeField(value: unknown): string {
  const field = text(value, 160);
  if (!/^[A-Za-z][A-Za-z0-9_.-]{0,159}$/.test(field)
      || field.split(".").some(part => part === "__proto__" || part === "prototype" || part === "constructor")) {
    throw new Error("assignment_clarification_missing_field_invalid");
  }
  return field;
}

function safeScalar(value: unknown, field: string): string | number | boolean | null {
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() && value.length <= 5_000 && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)) return value;
  throw new Error(`assignment_clarification_value_invalid:${field}`);
}

function principalOwnsGoal(createdBy: string | null | undefined): boolean {
  if (!createdBy) return true;
  const principal = getRequestPrincipal();
  return Boolean(principal && (principal.user_id === createdBy || principal.sub === createdBy));
}

function current(input: { assignment_id: string; run_id: string; generation: number; session_id: string }): {
  goal: NonNullable<ReturnType<typeof getGoal>>;
  projection: AssignmentControlPlaneProjection;
} {
  const goal = getGoal(text(input.assignment_id, 240));
  if (!goal) throw new Error("assignment_interaction_not_found");
  if (!principalOwnsGoal(goal.created_by)) throw new Error("assignment_interaction_foreign_principal");
  if (goal.related_session_id !== text(input.session_id, 180)) throw new Error("assignment_interaction_foreign_session");
  const projection = reduceAssignmentControlPlane(goal.id, normalizeAssignmentControlPlane(goal.assignment_control_plane).events).projection;
  if (projection.run_id !== text(input.run_id, 240) || projection.generation !== input.generation) {
    throw new Error("assignment_interaction_stale_generation");
  }
  if (projection.terminal_state !== "open") throw new Error(`assignment_interaction_terminal:${projection.terminal_state}`);
  return { goal, projection };
}

function event(
  projection: AssignmentControlPlaneProjection,
  kind: AssignmentAttemptEvent["kind"],
  actor: string,
  data: JsonMap,
  stable: unknown
): AssignmentAttemptEvent {
  return {
    schema: ASSIGNMENT_ATTEMPT_EVENT_SCHEMA,
    event_id: digest({ assignment_id: projection.assignment_id, run_id: projection.run_id, generation: projection.generation, kind, stable }),
    assignment_id: projection.assignment_id,
    run_id: projection.run_id ?? "",
    generation: projection.generation,
    attempt_id: null,
    kind,
    occurred_at: new Date().toISOString(),
    actor: text(actor, 160) || "assignment_interaction",
    data
  };
}

function criterionId(assignmentId: string, criterion: string): string {
  return `criterion:${digest({ assignment_id: assignmentId, criterion: criterion.toLowerCase() }).slice(7, 39)}`;
}

function normalizeCriteria(
  assignmentId: string,
  goalCriteria: string[],
  inputs: CriterionInput[] | undefined
): Array<{ criterion_id: string; criterion: string; state: AssignmentCriterionState; reason: string; evidence_refs: string[]; work_unit_ids: string[] }> {
  return (inputs ?? []).map(input => {
    const supplied = text(input.criterion, 1_200);
    const exact = goalCriteria.find(item => item.toLowerCase() === supplied.toLowerCase());
    if (!exact) throw new Error("assignment_clarification_unknown_criterion");
    if (!["partial", "needs_input", "needs_review", "uncertain"].includes(input.state)) {
      throw new Error("assignment_clarification_criterion_state_invalid");
    }
    return {
      criterion_id: criterionId(assignmentId, exact),
      criterion: exact,
      state: input.state,
      reason: text(input.reason, 1_000),
      evidence_refs: stringList(input.evidence_refs, 80, 500),
      work_unit_ids: stringList(input.work_unit_ids, 80, 160)
    };
  });
}

export function requestAssignmentClarification(
  input: AssignmentClarificationRequestInput,
  actor = "operator_request_clarification"
): { clarification: AssignmentClarificationRecord; projection: AssignmentControlPlaneProjection } {
  if (input.schema !== ASSIGNMENT_CLARIFICATION_SCHEMA) throw new Error("assignment_clarification_schema_invalid");
  assertSecretFree(input);
  const { goal, projection } = current(input);
  const missingFields = stringList(input.missing_fields, 32, 160).map(safeField);
  const question = text(input.question, 1_200);
  if (!missingFields.length) throw new Error("assignment_clarification_missing_fields_required");
  if (!question) throw new Error("assignment_clarification_question_required");
  if (projection.pending_clarification_id) {
    const existing = projection.clarifications.find(item => item.clarification_id === projection.pending_clarification_id);
    if (existing && existing.question === question && JSON.stringify(existing.missing_fields) === JSON.stringify(missingFields)) {
      return { clarification: existing, projection };
    }
    throw new Error("assignment_clarification_already_pending");
  }
  const options = (input.options ?? []).slice(0, 12).map(option => ({ id: safeField(option.id), label: text(option.label, 500) }));
  if (options.some(option => !option.label) || new Set(options.map(option => option.id)).size !== options.length) {
    throw new Error("assignment_clarification_options_invalid");
  }
  const recommendedDefault = text(input.recommended_default, 160) || null;
  if (recommendedDefault && !options.some(option => option.id === recommendedDefault)) {
    throw new Error("assignment_clarification_recommended_default_invalid");
  }
  const criterionStates = normalizeCriteria(goal.id, goal.acceptance_criteria, input.criterion_states);
  const clarificationId = text(input.clarification_id, 240) || `clar_${digest({
    assignment_id: goal.id, run_id: projection.run_id, generation: projection.generation, missing_fields: missingFields, question
  }).slice(7, 39)}`;
  if (!/^[A-Za-z0-9._:-]{1,240}$/.test(clarificationId)) throw new Error("assignment_clarification_id_invalid");
  if (projection.clarifications.some(item => item.clarification_id === clarificationId)) throw new Error("assignment_clarification_id_conflict");
  const appended = appendAssignmentEvent(goal.id, event(projection, "clarification_requested", actor, {
    clarification_id: clarificationId,
    missing_fields: missingFields,
    question,
    reason: text(input.reason, 1_000) || "required_input_missing",
    completed_work: stringList(input.completed_work, 80, 1_000),
    affected_subtasks: stringList(input.affected_subtasks, 80, 240),
    options,
    recommended_default: recommendedDefault,
    primary_artifact_refs: stringList(input.primary_artifact_refs, 80, 500),
    criterion_states: criterionStates
  }, { clarification_id: clarificationId, missing_fields: missingFields, question }));
  if (!appended.accepted) throw new Error(appended.quarantined_reason || "assignment_clarification_rejected");
  const clarification = appended.projection.clarifications.find(item => item.clarification_id === clarificationId);
  if (!clarification) throw new Error("assignment_clarification_projection_missing");
  return { clarification, projection: appended.projection };
}

function normalizedSuppliedValues(clarification: AssignmentClarificationRecord, value: unknown): JsonMap {
  const supplied = object(value);
  const keys = Object.keys(supplied);
  if (keys.length !== clarification.missing_fields.length || keys.some(key => !clarification.missing_fields.includes(key))) {
    throw new Error("assignment_clarification_response_fields_mismatch");
  }
  return Object.fromEntries(clarification.missing_fields.map(field => [field, safeScalar(supplied[field], field)]));
}

export function resolveAssignmentClarification(
  input: AssignmentClarificationResponseInput,
  actor = "authenticated_user"
): { clarification: AssignmentClarificationRecord; projection: AssignmentControlPlaneProjection; idempotent: boolean } {
  if (input.schema !== ASSIGNMENT_CLARIFICATION_RESPONSE_SCHEMA) throw new Error("assignment_clarification_response_schema_invalid");
  assertSecretFree(input);
  const { goal, projection } = current(input);
  const clarificationId = text(input.clarification_id, 240);
  const clarification = projection.clarifications.find(item => item.clarification_id === clarificationId);
  if (!clarification) throw new Error("assignment_clarification_not_found");
  const response = text(input.response, 5_000);
  if (!response) throw new Error("assignment_clarification_response_required");
  const suppliedValues = normalizedSuppliedValues(clarification, input.supplied_values);
  const responseDigest = digest({ response, supplied_values: suppliedValues });
  if (clarification.status === "resolved") {
    if (clarification.response_digest === responseDigest) return { clarification, projection, idempotent: true };
    throw new Error("assignment_clarification_conflicting_duplicate_response");
  }
  if (clarification.status !== "pending" || projection.pending_clarification_id !== clarificationId) {
    throw new Error("assignment_clarification_not_pending");
  }
  const resolved = appendAssignmentEvent(goal.id, event(projection, "clarification_resolved", actor, {
    clarification_id: clarificationId,
    response_digest: responseDigest,
    supplied_values: suppliedValues
  }, { clarification_id: clarificationId, response_digest: responseDigest }));
  if (!resolved.accepted) throw new Error(resolved.quarantined_reason || "assignment_clarification_response_rejected");
  const final = resolved.projection.clarifications.find(item => item.clarification_id === clarificationId);
  if (!final) throw new Error("assignment_clarification_resume_projection_missing");
  return { clarification: final, projection: resolved.projection, idempotent: false };
}
