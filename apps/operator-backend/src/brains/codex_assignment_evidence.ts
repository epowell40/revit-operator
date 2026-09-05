import type { AssignmentSnapshotV2 } from "../domain/assignment-kernel/index.js";

/** Bounded identity mapping; native payloads remain behind focused retrieval. */
export function codexAssignmentEvidenceContextV2(snapshot: AssignmentSnapshotV2, operationId?: string): string {
  const observations = Object.values(snapshot.observations)
    .filter(observation => {
      const operation = snapshot.operations[observation.operation_id];
      return observation.binding.generation === snapshot.current_binding.generation
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
      eligible_criterion_ids: observation.eligible_criterion_ids,
      capability_id: snapshot.operations[observation.operation_id]?.capability_id
    })),
    omitted: Math.max(0, observations.length - 32),
    usage: "Use observation_id for criterion claims and resultItems. Use evidence_id for focused payload retrieval. Operation IDs and native correlation IDs are not Observation IDs."
  });
}
