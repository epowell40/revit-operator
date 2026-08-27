import type { AssignmentEventV2 } from "../events.js";
import type { CriterionIdV2, ObservationIdV2, OperationIdV2 } from "../identity.js";
import type { SemanticFactV2 } from "../observation.js";

export const PROGRESS_REPLAY_V2_SCHEMA = "revit-operator.assignment-progress-replay/v2" as const;

export interface ProviderReceiptForReplayV2 {
  call_id: string;
  total_tokens?: number | null;
}

export interface ProviderCallReplayV2 {
  call_index: number;
  call_id: string;
  provider_event_version: number;
  occurred_at: string;
  total_tokens: number | null;
  justification: {
    recorded_gap_ids: readonly string[];
    recorded_criterion_ids: readonly CriterionIdV2[];
    status: "recorded" | "absent_from_historical_journal";
  };
  expected_information: readonly string[];
  actual_information: {
    operation_ids: readonly OperationIdV2[];
    observation_ids: readonly ObservationIdV2[];
    semantic_fact_ids: readonly string[];
    semantic_facts: readonly (SemanticFactV2 & { observation_id: ObservationIdV2 })[];
    retention_error_codes: readonly string[];
  };
  operations: readonly {
    operation_id: OperationIdV2;
    capability_id: string;
    purpose: string;
    operation_requested_effect: string;
    input: Readonly<Record<string, unknown>>;
    result_status: string | null;
  }[];
  observations: readonly {
    observation_id: ObservationIdV2;
    operation_id: OperationIdV2;
    semantic_fact_ids: readonly string[];
  }[];
  affected_criterion_ids: readonly CriterionIdV2[];
  criterion_evaluation_events: readonly CriterionIdV2[];
  missing_evaluation_reason: "none" | "no_affected_criterion" | "evaluation_not_recorded_before_next_provider_call";
  next_provider_call_admission: {
    recorded_reason: string | null;
    justified_by_historical_journal: boolean;
  } | null;
}

export interface AssignmentProgressReplayV2 {
  schema: typeof PROGRESS_REPLAY_V2_SCHEMA;
  assignment_id: string;
  source_event_count: number;
  source_evidence?: Readonly<{
    event_journal_sha256: string;
    provider_receipts_sha256: string;
  }>;
  provider_calls: readonly ProviderCallReplayV2[];
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)].sort();
}

export function replayProviderProgressV2(input: Readonly<{
  events: readonly AssignmentEventV2[];
  provider_receipts?: readonly ProviderReceiptForReplayV2[];
  source_evidence?: AssignmentProgressReplayV2["source_evidence"];
}>): AssignmentProgressReplayV2 {
  const events = [...input.events].sort((left, right) => left.assignment_version - right.assignment_version);
  const providers = events.filter((event): event is Extract<AssignmentEventV2, { event_type: "provider_call_recorded" }> => event.event_type === "provider_call_recorded");
  const receipts = new Map((input.provider_receipts ?? []).map((receipt) => [receipt.call_id, receipt]));
  const assignmentId = events[0]?.assignment_id ?? "";
  const providerCalls = providers.map((provider, index): ProviderCallReplayV2 => {
    const nextVersion = providers[index + 1]?.assignment_version ?? Number.POSITIVE_INFINITY;
    const window = events.filter((event) => event.assignment_version > provider.assignment_version && event.assignment_version < nextVersion);
    const operationEvents = window.filter((event): event is Extract<AssignmentEventV2, { event_type: "operation_admitted" }> => event.event_type === "operation_admitted");
    const operationIds = new Set(operationEvents.map((event) => event.operation.operation_id));
    const observations = window
      .filter((event): event is Extract<AssignmentEventV2, { event_type: "observation_retained" }> => event.event_type === "observation_retained")
      .filter((event) => operationIds.has(event.observation.operation_id));
    const failures = window
      .filter((event): event is Extract<AssignmentEventV2, { event_type: "observation_retention_failed" }> => event.event_type === "observation_retention_failed")
      .filter((event) => operationIds.has(event.operation_id));
    const results = new Map(window
      .filter((event): event is Extract<AssignmentEventV2, { event_type: "operation_result_recorded" }> => event.event_type === "operation_result_recorded")
      .map((event) => [event.result.operation_id, event.result]));
    const factIds = unique(observations.flatMap((event) => event.observation.facts.map((fact) => fact.fact_id)));
    const workUnitIds = new Set(operationEvents.map((event) => event.operation.work_unit_id));
    const creation = events.find((event): event is Extract<AssignmentEventV2, { event_type: "assignment_created" }> => event.event_type === "assignment_created");
    const affectedCriterionIds = unique((creation?.spec.work_units ?? [])
      .filter((unit) => workUnitIds.has(unit.work_unit_id))
      .flatMap((unit) => unit.criterion_ids)
      .filter((criterionId) => {
        const criterion = creation?.spec.criteria.find((candidate) => candidate.criterion_id === criterionId);
        return Boolean(criterion?.semantic_fact_requirements.some((factId) => factIds.includes(factId)));
      }));
    const evaluations = window
      .filter((event): event is Extract<AssignmentEventV2, { event_type: "criterion_evaluated" }> => event.event_type === "criterion_evaluated")
      .map((event) => event.evaluation.criterion_id);
    const expectedInformation = unique((creation?.spec.criteria ?? [])
      .filter((criterion) => (creation?.spec.work_units ?? []).some((unit) => workUnitIds.has(unit.work_unit_id) && unit.criterion_ids.includes(criterion.criterion_id)))
      .flatMap((criterion) => criterion.semantic_fact_requirements));
    const receipt = receipts.get(provider.call_id);
    return {
      call_index: index + 1,
      call_id: provider.call_id,
      provider_event_version: provider.assignment_version,
      occurred_at: provider.occurred_at,
      total_tokens: receipt?.total_tokens ?? null,
      justification: {
        recorded_gap_ids: [],
        recorded_criterion_ids: [],
        status: "absent_from_historical_journal"
      },
      expected_information: expectedInformation,
      actual_information: {
        operation_ids: operationEvents.map((event) => event.operation.operation_id),
        observation_ids: observations.map((event) => event.observation.observation_id),
        semantic_fact_ids: factIds,
        semantic_facts: observations.flatMap((event) => event.observation.facts.map((fact) => ({
          ...structuredClone(fact),
          observation_id: event.observation.observation_id
        }))),
        retention_error_codes: failures.map((event) => event.error_code)
      },
      operations: operationEvents.map((event) => ({
        operation_id: event.operation.operation_id,
        capability_id: event.operation.capability_id,
        purpose: event.operation.purpose,
        operation_requested_effect: event.operation.requested_effect,
        input: structuredClone(event.operation.input),
        result_status: results.get(event.operation.operation_id)?.status ?? null
      })),
      observations: observations.map((event) => ({
        observation_id: event.observation.observation_id,
        operation_id: event.observation.operation_id,
        semantic_fact_ids: unique(event.observation.facts.map((fact) => fact.fact_id))
      })),
      affected_criterion_ids: affectedCriterionIds,
      criterion_evaluation_events: unique(evaluations),
      missing_evaluation_reason: affectedCriterionIds.length === 0
        ? "no_affected_criterion"
        : evaluations.length === 0
          ? "evaluation_not_recorded_before_next_provider_call"
          : "none",
      next_provider_call_admission: index + 1 < providers.length ? {
        recorded_reason: null,
        justified_by_historical_journal: false
      } : null
    };
  });
  return {
    schema: PROGRESS_REPLAY_V2_SCHEMA,
    assignment_id: assignmentId,
    source_event_count: events.length,
    source_evidence: input.source_evidence,
    provider_calls: providerCalls
  };
}
