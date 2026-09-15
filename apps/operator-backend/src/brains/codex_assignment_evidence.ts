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
    omitted: Math.max(0, observations.length - 32),
    usage: "Criteria use eligible_criterion_ids. resultItems require eligibility=result; diagnostic permits execution_status/diagnostics/logs only. Retrieve missing fields by evidence_id. Never substitute operation IDs."
  });
}
