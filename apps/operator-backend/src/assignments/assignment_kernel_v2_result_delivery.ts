import { readAuthoritativeEvidence, readEvidenceRef } from "../evidence/evidence_store.js";
import { canonicalJsonV2, type AssignmentSnapshotV2 } from "../domain/assignment-kernel/index.js";
import { validateResultDeliveryV2, type AssignmentAssessmentV2, type AssignmentResultDeliveryV2 } from "../domain/assignment-kernel/result_delivery.js";
import { payloadDigestV2 } from "@revitoperator/payload-digest-v2";
import { extractDeterministicEvidenceFacts } from "../evidence/evidence_projection.js";

export type AssignmentResultSelectionV2 = Readonly<{
  label: string;
  source?: "raw_payload" | "deterministic_projection";
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
        hint: "Use raw_payload for exact native keys, without a payload wrapper. For key_counts/key_facts use source=deterministic_projection and [section, exact literal key]. Do not split dots or labels. Retrieve missing fields before retrying."
      })}`);
    }
    value = (value as Record<string | number, unknown>)[key];
  }
  return structuredClone(value);
}

/** Read-only presentation: values come from hash-checked native evidence, never model arguments. */
export function buildAssignmentResultDeliveryV2(
  snapshot: AssignmentSnapshotV2, selections: readonly AssignmentResultSelectionV2[], assessment?: AssignmentAssessmentV2
): AssignmentResultDeliveryV2 {
  if (!Array.isArray(selections) || selections.length < 1 || selections.length > 32) throw new Error("assignment_result_items_required");
  const delivery = { items: selections.map(selection => {
    if (selection.source !== undefined && !["raw_payload", "deterministic_projection"].includes(selection.source)) {
      throw new Error("assignment_result_source_invalid");
    }
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
    let selectedRoot = payload;
    if (selection.source === "deterministic_projection") {
      if (selection.path?.length !== 2 || !["key_counts", "key_facts"].includes(String(selection.path[0]))) {
        throw new Error("assignment_result_projection_path_invalid: use [key_counts or key_facts, exact literal key]");
      }
      // Recompute from these hash-checked native bytes, never a saved projection
      // or a model-provided count. Scope claims remain conservative.
      const extracted = extractDeterministicEvidenceFacts(payload);
      if (String(selection.path[1]).startsWith("inventory.")
          && (extracted.facts["inventory.complete"] !== true || extracted.facts["inventory.groups_truncated"] !== false)) {
        throw new Error("assignment_result_inventory_incomplete: retain the declared scope and inspect missing or omitted groups before presenting a complete inventory");
      }
      selectedRoot = { key_counts: extracted.counts, key_facts: extracted.facts };
    }
    return {
      label: typeof selection.label === "string" ? selection.label.trim() : "",
      observation_id: selection.observation_id, path: [...selection.path],
      value: selectValue(selectedRoot, selection.path), evidence_ref: observation.raw_payload_ref,
      ...(selection.source === "deterministic_projection" ? { value_source: "deterministic_projection" as const } : {}),
      payload_hash: observation.raw_payload_hash,
      ...(snapshot.operations[observation.operation_id]?.result?.status === "failed_after_dispatch"
        ? { presentation_kind: "diagnostic" as const } : {})
    };
  }), ...(assessment !== undefined ? { assessment: structuredClone(assessment) } : {}) };
  validateResultDeliveryV2(snapshot, delivery);
  if (snapshot.result_delivery && canonicalJsonV2(snapshot.result_delivery) !== canonicalJsonV2(delivery)) {
    throw new Error("assignment_result_delivery_conflict");
  }
  return delivery;
}
