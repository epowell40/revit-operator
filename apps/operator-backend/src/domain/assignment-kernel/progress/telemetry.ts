import type { AssignmentSnapshotV2 } from "../snapshot.js";

export const ASSIGNMENT_EFFICIENCY_TRACE_V2_SCHEMA = "revit-operator.assignment-efficiency-trace/v2" as const;

export interface AssignmentEfficiencyTraceV2 {
  schema: typeof ASSIGNMENT_EFFICIENCY_TRACE_V2_SCHEMA;
  assignment_id: string;
  assignment_version: number;
  provider_calls: number;
  reasoning_turns: number;
  input_tokens: number | null;
  output_tokens: number | null;
  reasoning_tokens: number | null;
  total_tokens: number | null;
  operations: number;
  observations: number;
  criteria_evaluated: number;
  criteria_closed: number;
  progress_epochs: number;
  no_progress_epochs: number;
  wall_time_ms: number | null;
  time_to_first_authoritative_fact_ms: number | null;
  time_to_terminal_ms: number | null;
  provider_call_explanations: readonly Readonly<{
    call_id: string;
    state: string;
    why: string;
    gap_ids: readonly string[];
    criterion_ids: readonly string[];
    expected_information: readonly string[];
    operation_ids: readonly string[];
    observation_ids: readonly string[];
    total_tokens: number | null;
  }>[];
}

function finiteDuration(start: string, end: string | undefined): number | null {
  if (!end) return null;
  const duration = Date.parse(end) - Date.parse(start);
  return Number.isFinite(duration) && duration >= 0 ? duration : null;
}

function sumOrNull(values: readonly (number | null | undefined)[]): number | null {
  const known = values.filter((value): value is number => typeof value === "number" && Number.isFinite(value));
  return known.length > 0 ? known.reduce((sum, value) => sum + value, 0) : null;
}

export function buildAssignmentEfficiencyTraceV2(snapshot: AssignmentSnapshotV2, observedAt?: string): AssignmentEfficiencyTraceV2 {
  const calls = Object.values(snapshot.provider_calls).sort((left, right) => left.admitted_at.localeCompare(right.admitted_at) || left.call_id.localeCompare(right.call_id));
  const observations = Object.values(snapshot.observations).sort((left, right) => left.observed_at.localeCompare(right.observed_at));
  const end = snapshot.finished_at ?? observedAt;
  return {
    schema: ASSIGNMENT_EFFICIENCY_TRACE_V2_SCHEMA,
    assignment_id: snapshot.current_binding.assignment_id,
    assignment_version: snapshot.assignment_version,
    provider_calls: calls.length,
    reasoning_turns: calls.filter((call) => call.state !== "admitted").length,
    input_tokens: sumOrNull(calls.map((call) => call.usage?.input_tokens)),
    output_tokens: sumOrNull(calls.map((call) => call.usage?.output_tokens)),
    reasoning_tokens: sumOrNull(calls.map((call) => call.usage?.reasoning_tokens)),
    total_tokens: sumOrNull(calls.map((call) => call.usage?.total_tokens)),
    operations: Object.keys(snapshot.operations).length,
    observations: observations.length,
    criteria_evaluated: Object.keys(snapshot.criteria).length,
    criteria_closed: Object.values(snapshot.criteria).filter((criterion) => criterion.status === "pass" || criterion.status === "not_applicable").length,
    progress_epochs: snapshot.progress_epochs.length,
    no_progress_epochs: snapshot.progress_epochs.filter((epoch) => !epoch.genuine_progress).length,
    wall_time_ms: finiteDuration(snapshot.spec.created_at, end),
    time_to_first_authoritative_fact_ms: finiteDuration(snapshot.spec.created_at, observations[0]?.observed_at),
    time_to_terminal_ms: finiteDuration(snapshot.spec.created_at, snapshot.finished_at),
    provider_call_explanations: calls.map((call) => {
      const operationIds = [...new Set(snapshot.progress_epochs
        .filter((epoch) => epoch.admitted_reasoning_call_ids.includes(call.call_id))
        .flatMap((epoch) => epoch.admitted_operation_ids))].sort();
      const observationIds = [...new Set(operationIds.flatMap((operationId) => snapshot.operations[operationId]?.observation_ids ?? []))].sort();
      return {
        call_id: call.call_id,
        state: call.state,
        why: `Resolve ${call.gap_ids.join(", ")} by obtaining ${call.expected_information.join(", ")}.`,
        gap_ids: call.gap_ids,
        criterion_ids: call.criterion_ids,
        expected_information: call.expected_information,
        operation_ids: operationIds,
        observation_ids: observationIds,
        total_tokens: call.usage?.total_tokens ?? null
      };
    })
  };
}
