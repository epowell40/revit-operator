import type { RequestedEffectV2 } from "./assignment_spec.js";
import type {
  AssignmentBindingV2,
  CriterionIdV2,
  ObservationIdV2,
  OperationIdV2,
  WorkUnitIdV2
} from "./identity.js";
import type { PayloadProvenanceV2 } from "./payload_provenance.js";

export const OPERATION_V2_SCHEMA = "revit-operator.operation/v2" as const;
export const OPERATION_RESULT_V2_SCHEMA = "revit-operator.operation-result/v2" as const;
export const OBSERVATION_COMMIT_INPUT_V2_SCHEMA = "revit-operator.observation-commit-input/v2" as const;

export type OperationAdmissionStateV2 = "proposed" | "admitted" | "rejected";
export type OperationDispatchStateV2 = "not_dispatched" | "dispatching" | "dispatched";
export type PersistentEffectV2 = "none" | "unknown" | "applied";
export type OperationPurposeV2 = "work" | "discovery" | "verification" | "evidence_read" | "reconciliation";
export type OperationSettlementStateV2 = "open" | "awaiting_result" | "retaining_observation" | "observation_commit_failed" | "settled";
export type OperationRoleV2 = "root" | "prerequisite" | "child";

export interface OperationRequestIdentityV2 {
  capability_id: string;
  method?: "GET" | "POST";
  path?: string;
  request_signature: string;
}

export interface CanonicalTargetV2 {
  target_id?: string;
  target_kind?: string;
  document_fingerprint?: string;
  semantic_scope?: Readonly<Record<string, string | number | boolean | null>>;
}

export interface OperationV2 {
  schema: typeof OPERATION_V2_SCHEMA;
  operation_id: OperationIdV2;
  binding: AssignmentBindingV2;
  work_unit_id: WorkUnitIdV2;
  capability_id: string;
  requested_effect: RequestedEffectV2;
  purpose: OperationPurposeV2;
  operation_role?: OperationRoleV2;
  parent_operation_id?: OperationIdV2;
  root_operation_id?: OperationIdV2;
  blocks_parent_settlement?: boolean;
  request_identity?: OperationRequestIdentityV2;
  advances_criterion_ids: readonly CriterionIdV2[];
  resolves_gap_ids: readonly string[];
  target: CanonicalTargetV2;
  input: Readonly<Record<string, unknown>>;
  admission_state: OperationAdmissionStateV2;
  dispatch_state: OperationDispatchStateV2;
  persistent_effect: PersistentEffectV2;
  settlement_state: OperationSettlementStateV2;
  result?: OperationResultV2;
  observation_commit?: ObservationCommitInputV2;
  observation_commit_attempts?: number;
  observation_ids: readonly ObservationIdV2[];
  verification_operation_ids: readonly OperationIdV2[];
  verification_of_operation_id?: OperationIdV2;
  retry_of_operation_id?: OperationIdV2;
  retry_basis?: "corrected_input" | "corrected_admission" | "new_target" | "reconciled_none" | "changed_plan" | "authorization_restored" | "host_recovered";
  reconciliation_of_operation_id?: OperationIdV2;
  opened_at: string;
  dispatched_at?: string;
  dispatch_authority?: "mcp" | "backend" | "native" | "dynamic_runtime" | "courier";
  deadline_at: string;
  settled_at?: string;
  observation_retention_error?: string;
}

export interface ObservationCommitInputV2 {
  schema: typeof OBSERVATION_COMMIT_INPUT_V2_SCHEMA;
  result_id: string;
  raw_payload: unknown;
  semantic_facts: readonly import("./observation.js").SemanticFactV2[];
  target_scope?: Readonly<Record<string, string | number | boolean | null>>;
  verification_relevance?: readonly string[];
}

export type NativeTransactionStateV2 = "not_applicable" | "committed" | "rolled_back" | "unknown";
export type OperationResultStatusV2 = "succeeded" | "completed_without_native_dispatch"
  | "failed_before_dispatch" | "failed_after_dispatch" | "timed_out" | "canceled";

export interface OperationResultV2 {
  schema: typeof OPERATION_RESULT_V2_SCHEMA;
  result_id: string;
  operation_id: OperationIdV2;
  binding: AssignmentBindingV2;
  status: OperationResultStatusV2;
  dispatch_state: OperationDispatchStateV2;
  persistent_effect: PersistentEffectV2;
  native_transaction_state: NativeTransactionStateV2;
  authority: string;
  result_schema_id: string;
  observation_required: boolean;
  raw_payload_hash?: string;
  payload_provenance?: PayloadProvenanceV2;
  receipt_id?: string;
  native_correlation_id?: string;
  completed_at: string;
  error_code?: string;
  diagnostics?: readonly string[];
  request_identity?: OperationRequestIdentityV2;
}
