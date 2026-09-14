import { payloadDigestV2 } from "@revitoperator/payload-digest-v2";
import { readAuthoritativeEvidence, readEvidenceRef } from "../evidence/evidence_store.js";
import { sameAssignmentBindingV2, type AssignmentSnapshotV2 } from "../domain/assignment-kernel/index.js";

const record = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const text = (value: unknown): string => typeof value === "string" ? value.replace(/[\r\n\u0000-\u001f]/g, " ").slice(0, 1000) : "";

/** Present selected native fields without allowing model prose to certify work. */
export function nativeResultPresentationV2(snapshot: AssignmentSnapshotV2, observationIds: readonly string[]): string | null {
  const lines = new Set<string>();
  for (const id of observationIds) {
    const observation = snapshot.observations[id];
    const operation = observation && snapshot.operations[observation.operation_id];
    if (!observation || !sameAssignmentBindingV2(snapshot.current_binding, observation.binding)
        || observation.authority !== "native-host" || operation?.result?.status !== "succeeded"
        || operation.settlement_state !== "settled" || !["task_result", "verification"].includes(observation.evidence_class ?? "")) continue;
    let payload: Record<string, unknown>;
    try {
      const ref = readEvidenceRef(observation.raw_payload_ref.replace(/^evidence:/, ""));
      const bytes = readAuthoritativeEvidence(ref, { ...snapshot.current_binding, attempt_id: operation.operation_id });
      payload = record(JSON.parse(bytes.toString("utf8")));
      if (payloadDigestV2(payload).digest !== observation.raw_payload_hash) continue;
    } catch { continue; }
    if (Array.isArray(payload.items)) for (const item of payload.items.slice(0, 12)) {
      const row = record(item); const params = record(row.parameters);
      if (typeof params["Sheet Number"] === "string" && typeof params["Sheet Name"] === "string")
        lines.add(`Sheet ${text(params["Sheet Number"])}: ${text(params["Sheet Name"])}.`);
    }
    if (payload.schema === "revit-operator.exported-file-inspection.v1" && payload.ok === true && payload.itemsComplete === true && Array.isArray(payload.files)) {
      for (const file of payload.files.slice(0, 12)) {
        const row = record(file);
        if (row.exists === true && row.readable === true && typeof row.path === "string") lines.add(`Verified file: ${text(row.path)}`);
      }
    }
    const capture = record(payload.export);
    if (typeof capture.path === "string" && typeof capture.viewName === "string") {
      lines.add(`Drawing ${text(payload.sheetNumber)}: ${text(capture.viewName)}.`);
      lines.add(`Drawing image: ${text(capture.path)}`);
    }
  }
  return lines.size ? [...lines].slice(0, 24).join("\n") : null;
}
