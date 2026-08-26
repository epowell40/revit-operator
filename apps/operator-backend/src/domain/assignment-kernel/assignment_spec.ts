import type {
  AssignmentBindingV2,
  CriterionIdV2,
  InputVariableIdV2,
  WorkUnitIdV2
} from "./identity.js";

export const ASSIGNMENT_SPEC_V2_SCHEMA = "revit-operator.assignment-spec/v2" as const;

export type RequestedEffectV2 = "read" | "preview" | "apply";
export type ExecutionClassV2 = "analysis" | "independent" | "coupled_atomic";

export interface AssignmentInputVariableV2 {
  variable_id: InputVariableIdV2;
  value_state: "known" | "needs_input" | "needs_review";
  value?: unknown;
  required: boolean;
  sensitive: boolean;
}

export interface AssignmentCriterionSpecV2 {
  criterion_id: CriterionIdV2;
  requirement: string;
  required: boolean;
  semantic_fact_requirements: readonly string[];
}

export interface AssignmentWorkUnitSpecV2 {
  work_unit_id: WorkUnitIdV2;
  requested_effect: RequestedEffectV2;
  execution_class: ExecutionClassV2;
  dependency_ids: readonly WorkUnitIdV2[];
  criterion_ids: readonly CriterionIdV2[];
  input_variable_ids: readonly InputVariableIdV2[];
  independently_useful: boolean;
  safe_to_retain: boolean;
  rollback_scope: "none" | "operation" | "work_unit" | "assignment";
}

export interface AssignmentSpecV2 {
  schema: typeof ASSIGNMENT_SPEC_V2_SCHEMA;
  binding: AssignmentBindingV2;
  source_user_request: string;
  requested_effect: RequestedEffectV2;
  criteria: readonly AssignmentCriterionSpecV2[];
  input_variables: readonly AssignmentInputVariableV2[];
  work_units: readonly AssignmentWorkUnitSpecV2[];
  authorization_policy_id: string;
  deviation_policy_id?: string;
  target_binding?: Readonly<Record<string, unknown>>;
  created_at: string;
}
