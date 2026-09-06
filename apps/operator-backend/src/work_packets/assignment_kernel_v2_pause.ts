import { ASSIGNMENT_SNAPSHOT_V2_SCHEMA, isTerminalProviderCallStateV2 } from "@revitoperator/assignment-kernel-v2-contracts";

type JsonRecord = Record<string, unknown>;
export type AssignmentUserPauseV2 = "awaiting_user_input" | "awaiting_user_review";

function record(value: unknown): JsonRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as JsonRecord : {};
}
function ids(value: unknown): string[] | null {
  return Array.isArray(value) && value.every(id => typeof id === "string" && id.trim().length > 0)
    && new Set(value).size === value.length ? value : null;
}
function empty(value: unknown): boolean { return Array.isArray(value) && value.length === 0; }
function object(value: unknown): boolean { return value !== null && typeof value === "object" && !Array.isArray(value); }

/** A paused handoff is a recorded need for the user, never a completed task. */
export function assignmentUserPauseV2(value: unknown): AssignmentUserPauseV2 | null {
  const snapshot = record(value);
  if (snapshot.schema !== ASSIGNMENT_SNAPSHOT_V2_SCHEMA || snapshot.terminal !== false || snapshot.quiescent !== true
      || !empty(snapshot.in_flight_operation_ids) || !empty(snapshot.in_flight_provider_call_ids)
      || !empty(snapshot.unresolved_unknown_operation_ids) || !object(snapshot.provider_calls) || !object(snapshot.operations)
      || record(snapshot.spec).schema !== "revit-operator.assignment-spec/v2") return null;
  const callIds = ids(snapshot.provider_call_ids);
  const calls = record(snapshot.provider_calls);
  if (!callIds || Object.keys(calls).length !== callIds.length || callIds.some(id => {
    const call = record(calls[id]);
    return call.call_id !== id || !isTerminalProviderCallStateV2(call.state);
  })) return null;
  if (Object.values(record(snapshot.operations)).some(value => {
    const operation = record(value);
    return operation.settlement_state !== "settled" || operation.persistent_effect === "unknown";
  })) return null;
  const pending = ids(snapshot.pending_input_variable_ids);
  const reviews = ids(snapshot.pending_review_ids);
  if (!pending || !reviews) return null;
  if (snapshot.outcome === "awaiting_user_review") {
    return pending.length === 0 && reviews.length > 0 ? "awaiting_user_review" : null;
  }
  if (snapshot.outcome !== "awaiting_user_input" || pending.length === 0) return null;
  const variables = record(snapshot.spec).input_variables;
  const clarifications = Object.values(record(snapshot.clarifications)).map(record);
  if (!Array.isArray(variables) || pending.some(id =>
    !variables.some(value => record(value).variable_id === id)
    || !clarifications.some(clarification => clarification.variable_id === id
      && typeof clarification.clarification_id === "string" && clarification.clarification_id.trim().length > 0
      && typeof clarification.question === "string" && clarification.question.trim().length > 0
      && clarification.resolved_at === undefined
      && typeof clarification.requested_at === "string" && Number.isFinite(Date.parse(clarification.requested_at))))) return null;
  return "awaiting_user_input";
}

/** Explicitly empty canonical ledgers prove no invocation; absent telemetry does not. */
export function assignmentPauseWithoutProviderCallV2(value: unknown): boolean {
  return assignmentUserPauseV2(value) !== null && empty(record(value).provider_call_ids)
    && Object.keys(record(record(value).provider_calls)).length === 0;
}
