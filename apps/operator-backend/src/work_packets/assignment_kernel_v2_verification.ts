import {
  appliedOperationHasVerifiedPostconditionV2,
  verificationOperationHasVerifiedPostconditionV2,
  type AssignmentSnapshotV2,
  type OperationV2
} from "../domain/assignment-kernel/index.js";
import type { VerifiedWorkAction, VerifiedWorkTrust } from "./contract.js";
import { checkedEditIsCurrentV2, checkedReadIsCurrentV2 } from "../verification/current_postcondition_v2.js";

export function packetOperationVerificationV2(snapshot: AssignmentSnapshotV2, operation: OperationV2): VerifiedWorkAction["verification"] {
  if (operation.requested_effect === "apply" && operation.persistent_effect === "applied") {
    if (checkedEditIsCurrentV2(snapshot, operation.operation_id)) {
      return { state: "passed", reason: "A current linked native readback proves this applied change's postcondition." };
    }
    const pending = operation.verification_operation_ids.some(id => {
      const linked = snapshot.operations[id];
      return linked?.verification_of_operation_id === operation.operation_id && linked.settlement_state !== "settled";
    });
    return pending
      ? { state: "pending", reason: "Verification of this applied change has not settled." }
      : { state: "inconclusive", reason: appliedOperationHasVerifiedPostconditionV2(snapshot, operation.operation_id)
        ? "An earlier check is retained, but it does not prove the current state. A fresh target-bound check is needed."
        : "This change was applied, but no successful linked readback proves its postcondition." };
  }
  if (operation.purpose === "verification") {
    return checkedReadIsCurrentV2(snapshot, operation.operation_id)
      ? { state: "passed", reason: "This current native readback proves the linked applied change's postcondition." }
      : operation.settlement_state !== "settled"
        ? { state: "pending", reason: "This verification operation has not settled." }
        : { state: "inconclusive", reason: verificationOperationHasVerifiedPostconditionV2(snapshot, operation.operation_id)
          ? "This earlier readback is retained, but it no longer proves the current state."
          : "This operation did not establish the linked applied change's postcondition." };
  }
  return { state: "not_requested", reason: null };
}

export function packetOverallTrustV2(snapshot: AssignmentSnapshotV2): VerifiedWorkTrust {
  const complete = snapshot.terminal && snapshot.quiescent
    && ["complete", "verified_noop"].includes(snapshot.outcome)
    && snapshot.unresolved_unknown_operation_ids.length === 0;
  const criteriaSupported = snapshot.spec.criteria.length > 0 && snapshot.spec.criteria.every(spec =>
    ["pass", "not_applicable"].includes(snapshot.criteria[spec.criterion_id]?.status ?? ""));
  const appliedChangesVerified = Object.values(snapshot.operations).every(operation =>
    operation.persistent_effect !== "applied"
      || checkedEditIsCurrentV2(snapshot, operation.operation_id));
  return complete && criteriaSupported && appliedChangesVerified ? "independently_verified" : "uncertain_or_missing";
}
