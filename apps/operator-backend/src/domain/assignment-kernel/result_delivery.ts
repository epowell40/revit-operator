import type { AssignmentSnapshotV2 } from "./snapshot.js";
import { sameAssignmentBindingV2 } from "./identity.js";

export interface AssignmentResultItemV2 {
  label: string;
  observation_id: string;
  /** Exact JSON object keys/array indexes used only to present retained data. */
  path: readonly (string | number)[];
  value: unknown;
  evidence_ref: string;
  payload_hash: string;
}

export interface AssignmentResultDeliveryV2 {
  items: readonly AssignmentResultItemV2[];
}

/** Presentation never manufactures semantic facts or changes criterion truth. */
export function validateResultDeliveryV2(snapshot: AssignmentSnapshotV2, delivery: AssignmentResultDeliveryV2): void {
  if (!snapshot.spec.result_delivery_required || snapshot.spec.requested_effect !== "read") {
    throw new Error("assignment_result_delivery_not_required");
  }
  if (!Array.isArray(delivery.items) || delivery.items.length < 1 || delivery.items.length > 32
      || JSON.stringify(delivery).length > 32_000) throw new Error("assignment_result_delivery_invalid");
  for (const item of delivery.items) {
    const observation = snapshot.observations[item.observation_id];
    const operation = observation ? snapshot.operations[observation.operation_id] : undefined;
    if (!item.label?.trim() || item.label.length > 160 || item.value === undefined
        || !Array.isArray(item.path) || item.path.length < 1 || item.path.length > 24) {
      throw new Error("assignment_result_item_invalid");
    }
    if (!observation || !sameAssignmentBindingV2(snapshot.current_binding, observation.binding)
        || observation.evidence_class !== "task_result"
        || !["native-host", "dynamic-runtime"].includes(observation.authority)
        || operation?.result?.status !== "succeeded" || operation.requested_effect !== "read"
        || operation.settlement_state !== "settled"
        || item.evidence_ref !== observation.raw_payload_ref || item.payload_hash !== observation.raw_payload_hash) {
      throw new Error("assignment_result_observation_ineligible");
    }
  }
}

export function renderResultDeliveryV2(delivery: AssignmentResultDeliveryV2): string {
  return delivery.items.map(item => `- ${item.label}: ${typeof item.value === "string" ? item.value : JSON.stringify(item.value)}`).join("\n");
}
