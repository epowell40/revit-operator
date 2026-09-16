import type { AssignmentSnapshotV2 } from "../domain/assignment-kernel/snapshot.js";
import { sameAssignmentBindingV2 } from "../domain/assignment-kernel/identity.js";
import { payloadDigestV2 } from "@revitoperator/payload-digest-v2";
import { readEvidenceRef, readAuthoritativeEvidence } from "../evidence/evidence_store.js";
import type { WorkPlanInspectionV2 } from "../domain/assignment-kernel/work_plan.js";

/** Retain evidence that an inspection actually read its targets. This certifies
 * coverage of the read, never the assistant's engineering interpretation. */
export function retainWorkPlanInspectionV2(snapshot: AssignmentSnapshotV2, operationIds: readonly string[]): WorkPlanInspectionV2 {
  const targets = new Set<string>(), observations: string[] = [];
  if (!Array.isArray(operationIds) || operationIds.length < 1 || operationIds.length > 128) throw Error("work_plan_inspection_reads_required");
  for (const id of operationIds) {
    const op = snapshot.operations[id], result = op?.result;
    if (!op || op.requested_effect !== "read" || op.persistent_effect !== "none" || op.settlement_state !== "settled"
        || result?.authority !== "native-host" || result.status !== "succeeded" || result.dispatch_state !== "dispatched"
        || !sameAssignmentBindingV2(op.binding, snapshot.current_binding) || !sameAssignmentBindingV2(result.binding, snapshot.current_binding)
        || op.request_identity?.path !== "/revit/get-connectors") throw Error("work_plan_inspection_native_connectors_required");
    let accepted = false;
    for (const oid of op.observation_ids) {
      const observation = snapshot.observations[oid];
      if (!observation || observation.operation_id !== id || observation.authority !== "native-host"
          || observation.raw_payload_hash !== result.raw_payload_hash || !sameAssignmentBindingV2(observation.binding, snapshot.current_binding)) continue;
      const ref = readEvidenceRef(observation.raw_payload_ref.replace(/^evidence:/, ""));
      if (ref.byte_count > 8_000_000) continue;
      const data = JSON.parse(readAuthoritativeEvidence(ref, { ...snapshot.current_binding, attempt_id: id }).toString("utf8"));
      if (payloadDigestV2(data).digest !== observation.raw_payload_hash || data.status !== "Ok" || !Array.isArray(data.results)
          || data.requestedCount !== data.results.length || data.scannedElementCount !== data.results.length
          || data.matchedElementCount !== data.results.length || data.failedElementCount !== 0 || data.connectorScanTruncatedElementCount !== 0
          || !data.results.length || new Set(data.results.map((r:any)=>r?.id)).size !== data.results.length
          || data.results.some((r:any)=>!Number.isSafeInteger(r?.id)||r.id<=0||r.ok!==true||r.connectorScanTruncated!==false
            || !Array.isArray(r.connectors)||r.connectorCount!==r.connectors.length||r.returnedConnectorCount!==r.connectors.length)) continue;
      data.results.forEach((r:any)=>targets.add(`element_id:${r.id}`)); observations.push(oid); accepted=true; break;
    }
    if (!accepted) throw Error("work_plan_inspection_incomplete_native_read");
  }
  return { observation_ids: observations.sort(), target_ids: [...targets].sort() };
}
