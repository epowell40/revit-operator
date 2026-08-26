import type { CriterionIdV2, ObservationIdV2, OperationIdV2, SemanticFactIdV2 } from "./identity.js";

export type CriterionStatusV2 = "pass" | "partial" | "needs_input" | "needs_review" | "failed" | "not_applicable" | "uncertain";
export type AssignmentOutcomeV2 = "active" | "awaiting_user_input" | "awaiting_user_review" | "complete" | "complete_with_issues" | "verified_noop" | "blocked" | "failed";

export interface CriterionFactRefV2 {
  observation_id: ObservationIdV2;
  fact_id: SemanticFactIdV2;
}

export interface CriterionEvaluationV2 {
  criterion_id: CriterionIdV2;
  status: CriterionStatusV2;
  basis: "observation" | "execution" | "desired_state_equivalence" | "user_input" | "policy";
  supporting_operation_ids: readonly OperationIdV2[];
  supporting_facts: readonly CriterionFactRefV2[];
  evaluator_authority: string;
  reason: string;
  evaluated_at: string;
}
