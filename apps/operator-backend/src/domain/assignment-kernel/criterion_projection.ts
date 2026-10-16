import type {CriterionEvaluationV2} from './criteria.js';
import type {AssignmentSnapshotV2} from './snapshot.js';
import {ASSIGNMENT_VERIFICATION_WORK_UNIT_ID_V2} from './assignment_spec.js';
import {appliedOperationHasVerifiedPostconditionV2} from './outcome.js';

export function mergeEvaluation(previous: CriterionEvaluationV2 | undefined, next: CriterionEvaluationV2): CriterionEvaluationV2 {
  if (!previous || previous.status === next.status || ["needs_input", "needs_review", "partial", "uncertain"].includes(previous.status)) return next;
  if (previous.status === "pass" && next.status === "pass") return next;
  return {
    ...next,
    status: "uncertain",
    basis: "policy",
    supporting_operation_ids: [...new Set([...previous.supporting_operation_ids, ...next.supporting_operation_ids])].sort(),
    supporting_facts: [...previous.supporting_facts, ...next.supporting_facts],
    reason: `Conflicting authoritative criterion evaluations: ${previous.status} versus ${next.status}.`
  };
}

export function projectWorkUnitCriteria(snapshot: AssignmentSnapshotV2): AssignmentSnapshotV2 {
  const states = { ...snapshot.work_unit_states };
  const appliedOperations = Object.values(snapshot.operations)
    .filter((operation) => operation.requested_effect === "apply" && operation.persistent_effect === "applied");
  const verificationUnitIds = new Set([
    ASSIGNMENT_VERIFICATION_WORK_UNIT_ID_V2,
    ...Object.values(snapshot.operations)
      .filter((operation) => operation.purpose === "verification")
      .map((operation) => operation.work_unit_id)
  ]);
  for (const unit of snapshot.spec.work_units) {
    if (unit.criterion_ids.length === 0) continue;
    const evaluations = unit.criterion_ids.map(id => snapshot.criteria[id]).filter(Boolean);
    if (evaluations.length !== unit.criterion_ids.length) continue;
    if (evaluations.every(row => row!.status === "pass" || row!.status === "not_applicable")) {
      if (snapshot.spec.requested_effect === "apply" && verificationUnitIds.has(unit.work_unit_id)) {
        const verifiedNoop = appliedOperations.length === 0
          && evaluations.some((evaluation) => evaluation!.basis === "desired_state_equivalence");
        const everyApplyVerified = appliedOperations.length > 0
          && appliedOperations.every((operation) =>
            appliedOperationHasVerifiedPostconditionV2(snapshot, operation.operation_id));
        if (!verifiedNoop && !everyApplyVerified) continue;
      }
      states[unit.work_unit_id] = "complete";
    } else if (unit.safe_to_retain && evaluations.some(row => row!.status === "pass" || row!.status === "partial")) {
      states[unit.work_unit_id] = "retained";
    }
  }
  return { ...snapshot, work_unit_states: states };
}
