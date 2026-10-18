import { operationNeedsReadbackV2 } from '../verification/regular_schedule_recheck_v2.js';
import type {AssignmentSnapshotV2,OperationPurposeV2,RequestedEffectV2} from '../domain/assignment-kernel/index.js';

export function operationEffect(effect: string): RequestedEffectV2 {
  if (effect === "preview" || effect === "apply") return effect;
  return "read";
}

export function operationPurpose(effect: string, snapshot: AssignmentSnapshotV2): OperationPurposeV2 {
  if (snapshot.unresolved_unknown_operation_ids.length > 0 && effect === "read") {
    return "reconciliation";
  }
  if (effect === "evidence_read") return "evidence_read";
  if (effect === "discovery" || effect === "navigation") return "discovery";
  if (effect === "read" && snapshot.spec.requested_effect === "apply"
      && Object.values(snapshot.operations).some(operation => operation.requested_effect === "apply"
        && operation.persistent_effect === "applied"
        && operationNeedsReadbackV2(snapshot,operation))) {
    return "verification";
  }
  if (effect === "read" && snapshot.spec.requested_effect !== "read") return "discovery";
  return "work";
}

export function admittedWorkUnit(snapshot: AssignmentSnapshotV2, suggestedEffect: RequestedEffectV2, purpose: OperationPurposeV2): AssignmentSnapshotV2["spec"]["work_units"][number] {
  const preferred = purpose === "evidence_read" ? "work-evidence"
    : purpose === "verification" ? "work-verification"
      : purpose === "discovery" && snapshot.spec.requested_effect !== "read" ? "work-discovery"
        : suggestedEffect === "preview" && snapshot.spec.requested_effect === "apply" ? "work-preview"
          : "work-primary";
  const unit = snapshot.spec.work_units.find(candidate => candidate.work_unit_id === preferred && candidate.requested_effect === suggestedEffect)
    ?? snapshot.spec.work_units.find(candidate => candidate.requested_effect === suggestedEffect);
  if (!unit) throw new Error("assignment_kernel_v2_work_unit_not_admitted");
  return unit;
}
