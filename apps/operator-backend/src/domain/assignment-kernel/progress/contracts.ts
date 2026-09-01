import type { AssignmentOutcomeV2, CriterionStatusV2 } from "../criteria.js";
import type {
  AssignmentBindingV2,
  CriterionIdV2,
  ObservationIdV2,
  OperationIdV2,
  WorkUnitIdV2
} from "../identity.js";

export const PROGRESS_DECISION_V2_SCHEMA = "revit-operator.assignment-progress-decision/v2" as const;
export const PROGRESS_EPOCH_V2_SCHEMA = "revit-operator.assignment-progress-epoch/v2" as const;
export const PROGRESS_GAP_V2_SCHEMA = "revit-operator.assignment-progress-gap/v2" as const;

export type ProgressGapKindV2 =
  | "criterion_fact_missing"
  | "criterion_uncertain"
  | "operation_input_schema_invalid"
  | "input_missing"
  | "review_required"
  | "operation_unsettled"
  | "effect_unknown"
  | "evidence_stale"
  | "evidence_conflicting"
  | "resource_exhausted";

export interface ProgressGapV2 {
  schema: typeof PROGRESS_GAP_V2_SCHEMA;
  gap_id: string;
  kind: ProgressGapKindV2;
  criterion_ids: readonly CriterionIdV2[];
  work_unit_ids: readonly WorkUnitIdV2[];
  required_fact_ids: readonly string[];
  current_observation_ids: readonly ObservationIdV2[];
  reason: string;
}

export interface AssignmentProgressBudgetV2 {
  max_reasoning_turns: number;
  max_provider_calls: number;
  max_operations: number;
  max_equivalent_operations: number;
  max_no_progress_epochs: number;
  max_reconciliation_attempts: number;
  max_wall_clock_ms: number;
  max_total_tokens: number;
}

interface ProgressDecisionBaseV2 {
  schema: typeof PROGRESS_DECISION_V2_SCHEMA;
  assignment_version: number;
  binding: AssignmentBindingV2;
  decision_id: string;
  decided_at: string;
  reason: string;
}

export type ProgressDecisionV2 = ProgressDecisionBaseV2 & (
  | { decision: "evaluate_criteria"; criterion_ids: readonly CriterionIdV2[]; observation_ids: readonly ObservationIdV2[] }
  | { decision: "request_user_input"; gap_ids: readonly string[]; criterion_ids: readonly CriterionIdV2[] }
  | { decision: "request_user_review"; gap_ids: readonly string[]; work_unit_ids: readonly WorkUnitIdV2[] }
  | { decision: "admit_reasoning_turn"; gap_ids: readonly string[]; criterion_ids: readonly CriterionIdV2[]; expected_information: readonly string[] }
  | { decision: "admit_operation"; operation_id: OperationIdV2; gap_ids: readonly string[]; criterion_ids: readonly CriterionIdV2[] }
  | { decision: "await_provider"; provider_call_ids: readonly string[] }
  | { decision: "await_operation"; operation_ids: readonly OperationIdV2[] }
  | { decision: "reconcile_operation"; operation_id: OperationIdV2; gap_ids: readonly string[] }
  | { decision: "terminal"; outcome: Exclude<AssignmentOutcomeV2, "active" | "awaiting_user_input" | "awaiting_user_review"> }
  | { decision: "blocked"; outcome: "blocked" | "failed"; gap_ids: readonly string[] }
);

export interface CriterionDeltaV2 {
  criterion_id: CriterionIdV2;
  before_status: CriterionStatusV2 | "unevaluated";
  after_status: CriterionStatusV2 | "unevaluated";
}

export interface ProgressEpochV2 {
  schema: typeof PROGRESS_EPOCH_V2_SCHEMA;
  epoch_id: string;
  binding: AssignmentBindingV2;
  before_assignment_version: number;
  after_assignment_version: number;
  unresolved_gap_ids: readonly string[];
  admitted_reasoning_call_ids: readonly string[];
  admitted_operation_ids: readonly OperationIdV2[];
  new_observation_ids: readonly ObservationIdV2[];
  new_fact_identities: readonly string[];
  criterion_deltas: readonly CriterionDeltaV2[];
  progress_fingerprint: string;
  genuine_progress: boolean;
  progress_reasons: readonly (
    | "criterion_advanced"
    | "gap_narrowed"
    | "correction_gap_identified"
    | "authoritative_observation_added"
    | "input_requested"
    | "input_resolved"
    | "review_requested"
    | "review_resolved"
    | "uncertainty_reconciled"
    | "execution_strategy_selected"
    | "work_unit_changed"
    | "terminal_derived"
  )[];
  recorded_at: string;
}
