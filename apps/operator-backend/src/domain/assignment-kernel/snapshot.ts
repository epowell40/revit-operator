import type { AssignmentSpecV2, AssignmentWorkUnitStateV2 } from "./assignment_spec.js";
import type { AssignmentOutcomeV2, CriterionEvaluationV2 } from "./criteria.js";
import type { AssignmentBindingV2, CriterionIdV2, InputVariableIdV2, ObservationIdV2, OperationIdV2, WorkUnitIdV2 } from "./identity.js";
import type { ObservationV2 } from "./observation.js";
import type { OperationV2 } from "./operation.js";
import type { ProgressEpochV2 } from "./progress/contracts.js";
import type { ProviderCallV2 } from "./progress/provider_call.js";

export const ASSIGNMENT_SNAPSHOT_V2_SCHEMA = "revit-operator.assignment-snapshot/v2" as const;

export interface AssignmentSnapshotV2 {
  schema: typeof ASSIGNMENT_SNAPSHOT_V2_SCHEMA;
  assignment_version: number;
  spec: AssignmentSpecV2;
  current_binding: AssignmentBindingV2;
  input_values: Readonly<Record<InputVariableIdV2, unknown>>;
  pending_input_variable_ids: readonly InputVariableIdV2[];
  clarifications: Readonly<Record<string, Readonly<{
    clarification_id: string;
    variable_id: InputVariableIdV2;
    question: string;
    requested_at: string;
    resolved_at?: string;
  }>>>;
  work_unit_states: Readonly<Record<WorkUnitIdV2, AssignmentWorkUnitStateV2>>;
  pending_review_ids: readonly string[];
  provider_call_ids: readonly string[];
  provider_calls: Readonly<Record<string, ProviderCallV2>>;
  in_flight_provider_call_ids: readonly string[];
  provider_budget_exhausted: boolean;
  progress_epochs: readonly ProgressEpochV2[];
  progress_blocker?: Readonly<{ code: string; gap_ids: readonly string[]; recorded_at: string }>;
  operations: Readonly<Record<OperationIdV2, OperationV2>>;
  operation_children: Readonly<Record<OperationIdV2, readonly OperationIdV2[]>>;
  blocking_child_operation_ids: readonly OperationIdV2[];
  observations: Readonly<Record<ObservationIdV2, ObservationV2>>;
  observation_versions: Readonly<Record<ObservationIdV2, number>>;
  criteria: Readonly<Record<CriterionIdV2, CriterionEvaluationV2>>;
  criterion_evaluation_versions: Readonly<Record<CriterionIdV2, number>>;
  outcome: AssignmentOutcomeV2;
  terminal: boolean;
  terminal_reason?: string;
  in_flight_operation_ids: readonly OperationIdV2[];
  unresolved_unknown_operation_ids: readonly OperationIdV2[];
  quiescent: boolean;
  finished_at?: string;
}
