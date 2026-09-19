import { pendingDuctVerificationRequestV2 } from "../verification/combined_duct_verification_v2.js";
import { verificationCapabilityGuidanceV2 } from "../verification/verification_capability_admission_v2.js";
import { appliedOperationHasVerifiedPostconditionV2 } from "../domain/assignment-kernel/index.js";
import { sameAssignmentBindingV2, type AssignmentSnapshotV2 } from "../domain/assignment-kernel/index.js";
import { resultObservationEligibilityV2 } from "../domain/assignment-kernel/result_delivery.js";

/** Bounded identity mapping; native payloads remain behind focused retrieval. */
export function codexAssignmentEvidenceContextV2(snapshot: AssignmentSnapshotV2, operationId?: string): string {
  const observations = Object.values(snapshot.observations)
    .filter(observation => {
      const operation = snapshot.operations[observation.operation_id];
      return sameAssignmentBindingV2(snapshot.current_binding, observation.binding)
        && (!operationId || observation.operation_id === operationId || operation?.root_operation_id === operationId);
    })
    .sort((a, b) => b.observed_at.localeCompare(a.observed_at) || a.observation_id.localeCompare(b.observation_id));
  if (!observations.length) return "";
  return JSON.stringify({
    schema: "revit-operator.model-observation-index/v2",
    observations: observations.slice(0, 32).map(observation => ({
      observation_id: observation.observation_id,
      operation_id: observation.operation_id,
      evidence_id: observation.raw_payload_ref.replace(/^evidence:/, ""),
      evidence_class: observation.evidence_class,
      result_item_eligibility: resultObservationEligibilityV2(snapshot, observation.observation_id),
      eligible_criterion_ids: observation.eligible_criterion_ids,
      capability_id: snapshot.operations[observation.operation_id]?.capability_id
    })),
    pending_verification: Object.values(snapshot.operations)
      .filter(op => op.requested_effect === "apply" && op.persistent_effect === "applied" && op.settlement_state === "settled"
        && sameAssignmentBindingV2(op.binding, snapshot.current_binding) && !appliedOperationHasVerifiedPostconditionV2(snapshot, op.operation_id))
      .slice(0, 8).map(op => ({ operation_id: op.operation_id, affected_targets: op.result?.affected_target_identities ?? [],
        next_inspection: pendingDuctVerificationRequestV2(op),
        guidance: verificationCapabilityGuidanceV2({ capability_id: op.capability_id, path: op.request_identity?.path, target_id: op.target.target_id }) })),
    omitted: Math.max(0, observations.length - 32),
    usage: "Criteria use eligible_criterion_ids. resultItems require eligibility=result; diagnostic permits execution_status/diagnostics/logs only. Retrieve missing fields by evidence_id. Never substitute operation IDs."
  });
}
