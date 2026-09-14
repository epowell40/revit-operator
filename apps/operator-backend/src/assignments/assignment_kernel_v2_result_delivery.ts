import { readAuthoritativeEvidence, readEvidenceRef } from "../evidence/evidence_store.js";
import { canonicalJsonV2, type AssignmentSnapshotV2 } from "../domain/assignment-kernel/index.js";
import { validateResultDeliveryV2, type AssignmentResultDeliveryV2 } from "../domain/assignment-kernel/result_delivery.js";
import { payloadDigestV2 } from "@revitoperator/payload-digest-v2";

export type AssignmentResultSelectionV2 = Readonly<{
  label: string;
  observation_id: string;
  path: readonly (string | number)[];
}>;

function selectValue(root: unknown, path: readonly (string | number)[]): unknown {
  if (!Array.isArray(path) || path.length < 1 || path.length > 24) throw new Error("assignment_result_path_invalid");
  let value = root;
  for (const [index, key] of path.entries()) {
    if (!((typeof key === "string" && key.length > 0 && key.length <= 240
        && !["__proto__", "prototype", "constructor"].includes(key))
        || (typeof key === "number" && Number.isSafeInteger(key) && key >= 0))
        || value === null || typeof value !== "object" || !Object.prototype.hasOwnProperty.call(value, key)) {
      const available = value !== null && typeof value === "object"
        ? Object.keys(value).filter(k => !["__proto__", "prototype", "constructor"].includes(k)).slice(0, 24) : [];
      throw new Error(`assignment_result_path_missing_or_invalid: ${JSON.stringify({
        requested_path: path, resolved_prefix: path.slice(0, index), missing_key: key,
        available_keys: available,
        hint: "Select exact keys from the retained raw payload. Do not assume a payload wrapper. Retrieve these fields, then retry resultItems with the corrected path."
      })}`);
    }
    value = (value as Record<string | number, unknown>)[key];
  }
  return structuredClone(value);
}

/** Read-only presentation: values come from hash-checked native evidence, never model arguments. */
export function buildAssignmentResultDeliveryV2(
  snapshot: AssignmentSnapshotV2, selections: readonly AssignmentResultSelectionV2[]
): AssignmentResultDeliveryV2 {
  if (!Array.isArray(selections) || selections.length < 1 || selections.length > 32) throw new Error("assignment_result_items_required");
  const delivery = { items: selections.map(selection => {
    const observation = snapshot.observations[selection.observation_id];
    if (!observation) throw new Error("assignment_result_observation_unknown");
    const evidenceId = observation.raw_payload_ref.replace(/^evidence:/, "");
    const ref = readEvidenceRef(evidenceId);
    const bytes = readAuthoritativeEvidence(ref, {
      session_id: snapshot.current_binding.session_id,
      assignment_id: snapshot.current_binding.assignment_id,
      run_id: snapshot.current_binding.run_id,
      generation: snapshot.current_binding.generation,
      attempt_id: observation.operation_id
    });
    const payload = JSON.parse(bytes.toString("utf8"));
    if (payloadDigestV2(payload).digest !== observation.raw_payload_hash) throw new Error("assignment_result_payload_hash_mismatch");
    return {
      label: typeof selection.label === "string" ? selection.label.trim() : "",
      observation_id: selection.observation_id, path: [...selection.path],
      value: selectValue(payload, selection.path), evidence_ref: observation.raw_payload_ref,
      payload_hash: observation.raw_payload_hash,
      ...(snapshot.operations[observation.operation_id]?.result?.status === "failed_after_dispatch"
        ? { presentation_kind: "diagnostic" as const } : {})
    };
  }) };
  validateResultDeliveryV2(snapshot, delivery);
  if (snapshot.result_delivery && canonicalJsonV2(snapshot.result_delivery) !== canonicalJsonV2(delivery)) {
    throw new Error("assignment_result_delivery_conflict");
  }
  return delivery;
}
