import type {
  AssignmentBindingV2,
  ObservationIdV2,
  OperationIdV2,
  SemanticFactIdV2
} from "./identity.js";

export const OBSERVATION_V2_SCHEMA = "revit-operator.observation/v2" as const;

export type SemanticFactScalarV2 = string | number | boolean | null;

export interface SemanticFactV2 {
  fact_id: SemanticFactIdV2;
  value: SemanticFactScalarV2 | readonly SemanticFactScalarV2[];
  dimensions?: Readonly<Record<string, SemanticFactScalarV2>>;
  unit?: string;
  target_id?: string;
}

export interface ObservationV2 {
  schema: typeof OBSERVATION_V2_SCHEMA;
  observation_id: ObservationIdV2;
  operation_id: OperationIdV2;
  binding: AssignmentBindingV2;
  authority: string;
  result_schema_id: string;
  raw_payload_ref: string;
  raw_payload_hash: string;
  facts: readonly SemanticFactV2[];
  target_scope: Readonly<Record<string, string | number | boolean | null>>;
  observed_at: string;
  freshness_deadline?: string;
  before_observation_id?: ObservationIdV2;
  after_observation_id?: ObservationIdV2;
  verification_relevance: readonly string[];
}
