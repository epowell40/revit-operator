import { payloadDigestV2 } from "@revitoperator/payload-digest-v2";
import { readAuthoritativeEvidence, readEvidenceRef } from "../evidence/evidence_store.js";
import { sameAssignmentBindingV2, type AssignmentSnapshotV2, type OperationV2, type OperationResultV2 } from "../domain/assignment-kernel/index.js";

const row = (value: unknown): Record<string, any> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, any> : {};
const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
const id = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) > 0;
const near = (a: unknown, b: number) => finite(a) && Math.abs(a - b) <= 1e-6;

/** Model-space family placement, including every requested batch member. The
 * apply payload supplies identities only; its echoed coordinates prove nothing. */
export function familyPlacementReadbackMatchesV2(input: unknown, appliedPayload: unknown, summary: unknown): boolean {
  const request = row(input), body = row(request.body), applied = row(appliedPayload);
  summary = Array.isArray(summary) ? summary : row(summary).result;
  const allowed = new Set(["familyName", "symbolName", "typeName", "levelName", "x", "y", "z", "count", "spacingX", "spacingY", "spacingZ", "rotationDegrees", "dryRun"]);
  const count = body.count ?? 1;
  if (request.path !== "/revit/create-family-instance" || body.dryRun === true || Object.keys(body).some(k => !allowed.has(k))
      || !Number.isSafeInteger(count) || count < 1 || count > 200 || ![body.x, body.y, body.z].every(finite)
      || ![body.spacingX ?? 0, body.spacingY ?? 0, body.spacingZ ?? 0, body.rotationDegrees ?? 0].every(finite)
      || typeof (body.symbolName ?? body.typeName) !== "string" || !(body.symbolName ?? body.typeName).trim()
      || (body.familyName !== undefined && typeof body.familyName !== "string")
      || (body.levelName !== undefined && typeof body.levelName !== "string")
      || applied.status !== "Placed" || applied.success !== true || applied.dryRun !== false || applied.count !== count
      || !Array.isArray(applied.instances) || applied.instances.length !== count || !Array.isArray(summary) || summary.length !== count) return false;
  const ids = applied.instances.map((v: unknown) => row(v).id);
  const indices = applied.instances.map((v: unknown) => row(v).index);
  if (!ids.every(id) || new Set(ids).size !== count || new Set(indices).size !== count
      || indices.some((index: unknown) => !Number.isSafeInteger(index) || Number(index) < 0 || Number(index) >= count)) return false;
  const transaction = row(applied.transaction);
  if (transaction.status !== "committed" || transaction.committed !== true || !Array.isArray(transaction.added_element_ids)
      || ids.some((value: number) => !transaction.added_element_ids.includes(value))) return false;
  const summaries = new Map(summary.map(value => [row(value).id, row(value)]));
  if (summaries.size !== count || [...summaries.keys()].some(value => !ids.includes(value))) return false;
  return applied.instances.every((value: unknown) => {
    const created = row(value), actual = summaries.get(created.id)!, location = row(actual.location), index = created.index;
    const expectedRotation = (body.rotationDegrees ?? 0) * Math.PI / 180;
    const rotationDelta = finite(location.rotationRadians) ? Math.atan2(Math.sin(location.rotationRadians - expectedRotation), Math.cos(location.rotationRadians - expectedRotation)) : NaN;
    return actual.found === true && actual.className === "FamilyInstance" && location.type === "point"
      && actual.typeName === (body.symbolName ?? body.typeName).trim()
      && (!body.familyName?.trim() || actual.familyName === body.familyName.trim())
      && (!body.levelName?.trim() || actual.levelName === body.levelName.trim())
      && near(location.x, body.x + index * (body.spacingX ?? 0))
      && near(location.y, body.y + index * (body.spacingY ?? 0))
      && near(location.z, body.z + index * (body.spacingZ ?? 0))
      && Number.isFinite(rotationDelta) && Math.abs(rotationDelta) <= 1e-6;
  });
}

export function familyPlacementPostconditionSatisfiedV2(snapshot: AssignmentSnapshotV2, subject: OperationV2, current: OperationResultV2, payload: unknown): boolean {
  const applied = subject.result;
  if (subject.request_identity?.path !== "/revit/create-family-instance" || subject.requested_effect !== "apply"
      || subject.persistent_effect !== "applied" || subject.settlement_state !== "settled"
      || applied?.authority !== "native-host" || applied.status !== "succeeded" || applied.native_transaction_state !== "committed"
      || !sameAssignmentBindingV2(subject.binding, snapshot.current_binding) || !sameAssignmentBindingV2(applied.binding, snapshot.current_binding)
      || current.authority !== "native-host" || current.status !== "succeeded" || current.dispatch_state !== "dispatched" || current.persistent_effect !== "none"
      || current.request_identity?.method !== "POST" || current.request_identity.path !== "/revit/get-element-summary"
      || !sameAssignmentBindingV2(current.binding, snapshot.current_binding)
      || !Number.isFinite(Date.parse(current.completed_at)) || !Number.isFinite(Date.parse(applied.completed_at))
      || Date.parse(current.completed_at) < Date.parse(applied.completed_at) || payloadDigestV2(payload).digest !== current.raw_payload_hash) return false;
  if (Object.values(snapshot.operations).some(op => op.operation_id !== subject.operation_id && op.persistent_effect === "applied"
      && op.result && Date.parse(op.result.completed_at) >= Date.parse(applied.completed_at))) return false;
  for (const observationId of subject.observation_ids) {
    const observation = snapshot.observations[observationId];
    if (!observation || observation.operation_id !== subject.operation_id || observation.authority !== "native-host"
        || observation.raw_payload_hash !== applied.raw_payload_hash || !sameAssignmentBindingV2(observation.binding, snapshot.current_binding)) continue;
    try {
      const ref = readEvidenceRef(observation.raw_payload_ref.replace(/^evidence:/, ""));
      if (ref.byte_count > 2_000_000) continue;
      const bytes = readAuthoritativeEvidence(ref, { ...snapshot.current_binding, attempt_id: subject.operation_id });
      const nativeApply = JSON.parse(bytes.toString("utf8"));
      if (payloadDigestV2(nativeApply).digest !== observation.raw_payload_hash) continue;
      return familyPlacementReadbackMatchesV2(subject.input, nativeApply, payload);
    } catch { /* Missing or corrupt native identity evidence does not verify placement. */ }
  }
  return false;
}
