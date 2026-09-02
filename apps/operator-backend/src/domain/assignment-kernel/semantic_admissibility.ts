import { sameAssignmentBindingV2 } from "./identity.js";
import type { AssignmentCriterionSpecV2, RequestedEffectV2 } from "./assignment_spec.js";
import type { CriterionEvaluationV2 } from "./criteria.js";
import type { ObservationV2, SemanticFactV2 } from "./observation.js";
import type { OperationPurposeV2, OperationV2 } from "./operation.js";
import type { AssignmentSnapshotV2 } from "./snapshot.js";
import { isAssignmentKernelControlCapabilityV2 } from "@revitoperator/assignment-kernel-v2-contracts";

export const CRITERION_EVIDENCE_POLICY_V2_SCHEMA = "revit-operator.criterion-evidence-policy/v2" as const;
export const SEMANTIC_EVIDENCE_CONTRACT_V2 = "revit-operator.semantic-evidence-contract/v2" as const;

export type OperationFulfillmentRoleV2 =
  | "supporting_control"
  | "prerequisite"
  | "delegated_task_execution"
  | "verification"
  | "reconciliation"
  | "telemetry";

export type ObservationEvidenceClassV2 =
  | "control"
  | "prerequisite"
  | "task_result"
  | "verification"
  | "reconciliation"
  | "telemetry";

export type SemanticFactClassV2 = "control" | "domain" | "verification" | "reconciliation" | "telemetry";

export interface CriterionEvidencePolicyV2 {
  schema: typeof CRITERION_EVIDENCE_POLICY_V2_SCHEMA;
  allowed_evidence_classes: readonly ObservationEvidenceClassV2[];
  allowed_fulfillment_roles: readonly OperationFulfillmentRoleV2[];
  allowed_fact_classes: readonly SemanticFactClassV2[];
  allowed_capability_ids: readonly string[];
  allowed_result_schema_ids: readonly string[];
  required_fact_ids: readonly string[];
  require_native_dispatch: boolean;
  require_current_generation: boolean;
}

export function operationFulfillmentRoleForAdmissionV2(input: Readonly<{
  purpose: OperationPurposeV2;
  capability_id: string;
  prerequisite?: boolean;
}>): OperationFulfillmentRoleV2 {
  if (input.prerequisite) return "prerequisite";
  if (input.purpose === "verification") return "verification";
  if (input.purpose === "reconciliation") return "reconciliation";
  if (input.purpose === "evidence_read") return "supporting_control";
  if (isAssignmentKernelControlCapabilityV2(input.capability_id) || input.purpose === "discovery") return "supporting_control";
  return "delegated_task_execution";
}

export function fulfillmentRoleCanCarryTaskCriteriaV2(role: OperationFulfillmentRoleV2): boolean {
  return role === "delegated_task_execution" || role === "verification";
}

/**
 * One effect-causality predicate shared by admission and evaluation. Ordinary
 * task fulfillment requires the operation to perform the Assignment's exact
 * requested effect. The only narrower-effect exception is a criterion whose
 * immutable spec explicitly defines desired-state equivalence and whose
 * evaluator selects that basis.
 */
export function operationEffectAdmissibleForCriterionV2(input: Readonly<{
  assignment_requested_effect: RequestedEffectV2;
  operation_requested_effect: RequestedEffectV2;
  criterion: AssignmentCriterionSpecV2;
  basis?: CriterionEvaluationV2["basis"];
}>): boolean {
  if (input.operation_requested_effect === input.assignment_requested_effect) return true;
  return input.basis === "desired_state_equivalence"
    && input.assignment_requested_effect === "apply"
    && input.operation_requested_effect === "read"
    && (input.criterion.desired_state_comparisons?.length ?? 0) > 0;
}

export function evidenceClassForFulfillmentRoleV2(role: OperationFulfillmentRoleV2): ObservationEvidenceClassV2 {
  switch (role) {
    case "supporting_control": return "control";
    case "prerequisite": return "prerequisite";
    case "delegated_task_execution": return "task_result";
    case "verification": return "verification";
    case "reconciliation": return "reconciliation";
    case "telemetry": return "telemetry";
  }
}

export function normalizeSemanticFactsForEvidenceV2(
  evidenceClass: ObservationEvidenceClassV2,
  facts: readonly SemanticFactV2[]
): readonly SemanticFactV2[] {
  return facts.map((fact) => {
    const originalId = fact.fact_id;
    if (originalId === "result.available") {
      return { ...structuredClone(fact), fact_id: "control.result_available", fact_class: "control" as const };
    }
    const factClass = fact.fact_class ?? "control";
    const allowed = evidenceClass === "task_result" ? ["control", "domain"]
      : evidenceClass === "verification" ? ["control", "verification"]
        : evidenceClass === "reconciliation" ? ["control", "reconciliation"]
          : evidenceClass === "telemetry" ? ["control", "telemetry"]
            : ["control"];
    if (!allowed.includes(factClass)) {
      throw new Error(`semantic_fact_class_incompatible:${evidenceClass}:${factClass}:${originalId}`);
    }
    return { ...structuredClone(fact), fact_class: factClass };
  });
}

export type ObservationAdmissibilityV2 = Readonly<{
  admissible: boolean;
  reason: string;
  operation: OperationV2 | null;
  supporting_facts: readonly SemanticFactV2[];
}>;

function denied(reason: string, operation: OperationV2 | null = null): ObservationAdmissibilityV2 {
  return { admissible: false, reason, operation, supporting_facts: [] };
}

/**
 * The single V2 semantic-admission predicate. Progress discovery, evaluation,
 * and reducer validation must all use this function so no API can bypass the
 * operation-to-evidence causal contract.
 */
export function observationAdmissibilityForCriterionV2(input: Readonly<{
  snapshot: AssignmentSnapshotV2;
  criterion: AssignmentCriterionSpecV2;
  observation: ObservationV2;
  evaluated_at?: string;
  basis?: CriterionEvaluationV2["basis"];
}>): ObservationAdmissibilityV2 {
  const policy = input.criterion.evidence_policy;
  if (!policy || input.snapshot.spec.semantic_evidence_contract !== SEMANTIC_EVIDENCE_CONTRACT_V2) {
    return denied("criterion_evidence_policy_missing");
  }
  if (!sameAssignmentBindingV2(input.snapshot.current_binding, input.observation.binding)) return denied("observation_binding_not_current");
  const operation = input.snapshot.operations[input.observation.operation_id] ?? null;
  if (!operation) return denied("observation_operation_missing");
  if (operation.settlement_state !== "settled" || operation.result?.status !== "succeeded") return denied("operation_not_successfully_settled", operation);
  if (!operation.fulfillment_role || !operation.eligible_criterion_ids) return denied("operation_fulfillment_contract_missing", operation);
  if (!operation.eligible_criterion_ids.includes(input.criterion.criterion_id)) return denied("operation_not_eligible_for_criterion", operation);
  if (operation.fulfillment_role === "delegated_task_execution") {
    const effectAdmissible = operationEffectAdmissibleForCriterionV2({
      assignment_requested_effect: input.snapshot.spec.requested_effect,
      operation_requested_effect: operation.requested_effect,
      criterion: input.criterion,
      basis: input.basis
    });
    if (!effectAdmissible) {
      return denied("task_operation_effect_mismatch", operation);
    }
    const desiredStateRead = operation.requested_effect !== input.snapshot.spec.requested_effect;
    if (desiredStateRead && (operation.persistent_effect !== "none"
        || operation.result.native_transaction_state !== "not_applicable")) {
      return denied("desired_state_read_effect_invalid", operation);
    }
    if (!desiredStateRead && input.snapshot.spec.requested_effect === "apply"
        && (operation.persistent_effect !== "applied"
          || operation.result.native_transaction_state !== "committed")) {
      return denied("apply_task_effect_not_committed", operation);
    }
    if (!desiredStateRead && input.snapshot.spec.requested_effect === "preview"
        && (operation.persistent_effect !== "none"
          || operation.result.native_transaction_state !== "rolled_back")) {
      return denied("preview_task_effect_not_rolled_back", operation);
    }
  }
  if (!input.observation.fulfillment_role || input.observation.fulfillment_role !== operation.fulfillment_role) return denied("observation_fulfillment_role_mismatch", operation);
  if (input.observation.capability_id !== operation.capability_id) return denied("observation_capability_mismatch", operation);
  if (!input.observation.eligible_criterion_ids?.includes(input.criterion.criterion_id)) return denied("observation_not_eligible_for_criterion", operation);
  if (!policy.allowed_fulfillment_roles.includes(operation.fulfillment_role)) return denied("fulfillment_role_not_allowed", operation);
  if (!input.observation.evidence_class || !policy.allowed_evidence_classes.includes(input.observation.evidence_class)) return denied("evidence_class_not_allowed", operation);
  if (policy.allowed_capability_ids.length > 0 && !policy.allowed_capability_ids.includes(operation.capability_id)) return denied("capability_not_allowed", operation);
  if (policy.allowed_result_schema_ids.length > 0 && !policy.allowed_result_schema_ids.includes(input.observation.result_schema_id)) return denied("result_schema_not_allowed", operation);
  if (policy.require_native_dispatch && operation.result.dispatch_state !== "dispatched") return denied("required_task_execution_not_dispatched", operation);
  if (policy.require_current_generation && input.observation.binding.generation !== input.snapshot.current_binding.generation) return denied("observation_generation_not_current", operation);
  if (input.observation.freshness_deadline && input.evaluated_at
      && Date.parse(input.evaluated_at) > Date.parse(input.observation.freshness_deadline)) return denied("observation_not_fresh", operation);
  const supportingFacts = input.observation.facts.filter((fact) => policy.required_fact_ids.includes(fact.fact_id));
  if (supportingFacts.some((fact) => !fact.fact_class || !policy.allowed_fact_classes.includes(fact.fact_class))) return denied("semantic_fact_class_not_allowed", operation);
  return { admissible: true, reason: "admitted", operation, supporting_facts: supportingFacts };
}
