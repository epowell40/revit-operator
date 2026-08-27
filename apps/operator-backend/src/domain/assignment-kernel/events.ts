import type { AssignmentSpecV2, AssignmentWorkUnitStateV2 } from "./assignment_spec.js";
import type { AssignmentBindingV2, CriterionIdV2, InputVariableIdV2, ObservationIdV2, OperationIdV2, WorkUnitIdV2 } from "./identity.js";
import type { CriterionEvaluationV2, AssignmentOutcomeV2 } from "./criteria.js";
import type { ObservationV2 } from "./observation.js";
import type { ObservationCommitInputV2, OperationResultV2, OperationV2 } from "./operation.js";
import type { ProgressEpochV2 } from "./progress/contracts.js";
import type { ProviderCallStateV2, ProviderCallV2, ProviderUsageV2 } from "./progress/provider_call.js";

export const ASSIGNMENT_EVENT_V2_SCHEMA = "revit-operator.assignment-event/v2" as const;

export interface AssignmentEventEnvelopeV2 {
  schema: typeof ASSIGNMENT_EVENT_V2_SCHEMA;
  event_id: string;
  assignment_id: string;
  assignment_version: number;
  binding: AssignmentBindingV2;
  occurred_at: string;
  actor: string;
}

export type AssignmentEventV2 = AssignmentEventEnvelopeV2 & (
  | { event_type: "assignment_created"; spec: AssignmentSpecV2 }
  | { event_type: "run_started" }
  | { event_type: "run_superseded"; superseded_by_generation: number }
  | { event_type: "work_unit_state_changed"; work_unit_id: WorkUnitIdV2; state: AssignmentWorkUnitStateV2; reason: string }
  | { event_type: "input_requested"; variable_id: InputVariableIdV2; clarification_id: string; question: string }
  | { event_type: "input_supplied"; variable_id: InputVariableIdV2; clarification_id: string; value: unknown }
  | { event_type: "provider_call_recorded"; call_id: string; provider: string; model: string; reasoning_effort: string | null; success: boolean }
  | {
      event_type: "provider_call_state_recorded";
      call_id: string;
      state: ProviderCallStateV2;
      provider?: string;
      model?: string;
      reasoning_effort?: string | null;
      gap_ids?: readonly string[];
      criterion_ids?: readonly CriterionIdV2[];
      expected_information?: readonly string[];
      usage?: ProviderUsageV2;
      success?: boolean;
      error_class?: "provider" | "transport" | "canceled" | "resource_exhausted";
    }
  | { event_type: "provider_call_receipt_recorded"; call: ProviderCallV2 }
  | { event_type: "provider_budget_exhausted"; limit: number }
  | { event_type: "progress_epoch_recorded"; epoch: ProgressEpochV2 }
  | { event_type: "progress_blocked"; code: string; gap_ids: readonly string[] }
  | { event_type: "operation_admitted"; operation: OperationV2 }
  | { event_type: "operation_dispatch_started"; operation_id: OperationIdV2 }
  | { event_type: "operation_dispatch_recorded"; operation_id: OperationIdV2; authority: "mcp" | "backend" | "dynamic_runtime" | "courier"; correlation_id?: string }
  | { event_type: "native_dispatch_recorded"; operation_id: OperationIdV2; native_correlation_id?: string }
  | { event_type: "operation_result_recorded"; result: OperationResultV2; observation_commit?: ObservationCommitInputV2 }
  | { event_type: "observation_retained"; observation: ObservationV2 }
  | { event_type: "observation_commit_retry_recorded"; operation_id: OperationIdV2; result_id: string; attempt: number; error_code: string }
  | { event_type: "observation_commit_failed"; operation_id: OperationIdV2; result_id: string; attempt: number; error_code: string }
  | { event_type: "observation_retention_failed"; operation_id: OperationIdV2; error_code: string }
  | { event_type: "criterion_evaluated"; evaluation: CriterionEvaluationV2 }
  | { event_type: "review_requested"; review_id: string; work_unit_ids: readonly WorkUnitIdV2[]; reason: string }
  | { event_type: "review_resolved"; review_id: string; decision: string }
  | { event_type: "reconciliation_recorded"; operation_id: OperationIdV2; resolved_effect: "none" | "applied"; observation_ids: readonly ObservationIdV2[] }
  | { event_type: "outcome_derived"; outcome: AssignmentOutcomeV2; reason: string }
  | { event_type: "assignment_terminal"; outcome: Exclude<AssignmentOutcomeV2, "active" | "awaiting_user_input" | "awaiting_user_review">; reason: string }
);

export function assignmentEventTypeV2(event: AssignmentEventV2): AssignmentEventV2["event_type"] {
  return event.event_type;
}
