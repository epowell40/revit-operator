import type { AssignmentInputVariableV2, AssignmentSpecV2 } from "./assignment_spec.js";
import type { AssignmentOutcomeV2, CriterionEvaluationV2 } from "./criteria.js";
import type { AssignmentSnapshotV2 } from "./snapshot.js";

function requiredInputsKnown(spec: AssignmentSpecV2, snapshot: AssignmentSnapshotV2): boolean {
  return spec.input_variables.every((input: AssignmentInputVariableV2) => !input.required
    || input.value_state === "known"
    || Object.prototype.hasOwnProperty.call(snapshot.input_values, input.variable_id));
}

function requiredEvaluations(snapshot: AssignmentSnapshotV2): CriterionEvaluationV2[] {
  return snapshot.spec.criteria
    .filter((criterion) => criterion.required)
    .map((criterion) => snapshot.criteria[criterion.criterion_id])
    .filter((evaluation): evaluation is CriterionEvaluationV2 => Boolean(evaluation));
}

export function deriveAssignmentOutcomeV2(snapshot: AssignmentSnapshotV2): AssignmentOutcomeV2 {
  if (snapshot.pending_input_variable_ids.length > 0 || !requiredInputsKnown(snapshot.spec, snapshot)) {
    return "awaiting_user_input";
  }
  if (snapshot.pending_review_ids.length > 0) return "awaiting_user_review";
  if (!snapshot.quiescent || snapshot.unresolved_unknown_operation_ids.length > 0) return "active";
  if (snapshot.provider_budget_exhausted) return "failed";

  const requiredSpecs = snapshot.spec.criteria.filter((criterion) => criterion.required);
  const evaluations = requiredEvaluations(snapshot);
  if (requiredSpecs.length === 0 || evaluations.length !== requiredSpecs.length) return "active";
  if (evaluations.some((evaluation) => evaluation.status === "needs_input")) return "awaiting_user_input";
  if (evaluations.some((evaluation) => evaluation.status === "needs_review")) return "awaiting_user_review";
  if (evaluations.some((evaluation) => evaluation.status === "uncertain")) return "active";

  const usefulPass = evaluations.some((evaluation) => evaluation.status === "pass");
  if (evaluations.some((evaluation) => evaluation.status === "failed")) {
    const hasBlockedWork = Object.values(snapshot.work_unit_states).some((state) => state === "blocked");
    return usefulPass ? "complete_with_issues" : hasBlockedWork ? "blocked" : "failed";
  }
  if (evaluations.some((evaluation) => evaluation.status === "partial")) {
    const workFinished = Object.values(snapshot.work_unit_states).every((state) => ["complete", "blocked", "failed", "retained"].includes(state));
    return workFinished ? "complete_with_issues" : "active";
  }
  if (!evaluations.every((evaluation) => evaluation.status === "pass" || evaluation.status === "not_applicable")) return "active";

  if (snapshot.spec.requested_effect !== "apply") return "complete";
  const appliedOperations = Object.values(snapshot.operations)
    .filter((operation) => operation.requested_effect === "apply" && operation.persistent_effect === "applied");
  const appliedAndVerified = appliedOperations.some((operation) => operation.verification_operation_ids.some((verificationId) => {
    const verification = snapshot.operations[verificationId];
    return verification?.verification_of_operation_id === operation.operation_id
      && verification.requested_effect === "read"
      && verification.purpose === "verification"
      && verification.persistent_effect === "none"
      && verification.settlement_state === "settled"
      && verification.result?.status === "succeeded"
      && verification.observation_ids.length > 0;
  }));
  if (appliedAndVerified) {
    return "complete";
  }
  if (appliedOperations.length > 0) return "active";
  const equivalenceProven = evaluations.some((evaluation) => evaluation.basis === "desired_state_equivalence");
  return equivalenceProven ? "verified_noop" : "active";
}
