import { explicitCreateDuctIntentV2 } from "./open_duct_intent_v2.js";
import { connectedDuctReadbackMatchesV2 } from "./connected_duct_readback_v2.js";
import { payloadDigestV2 } from "@revitoperator/payload-digest-v2";
import { readAuthoritativeEvidence, readEvidenceRef } from "../evidence/evidence_store.js";
import { sameAssignmentBindingV2, type AssignmentSnapshotV2, type OperationV2, type OperationResultV2 } from "../domain/assignment-kernel/index.js";

const record = (v: unknown): Record<string, any> => v && typeof v === "object" && !Array.isArray(v) ? v as Record<string, any> : {};
const positiveId = (v: unknown): v is number => Number.isSafeInteger(v) && Number(v) > 0;
const number = (v: unknown): number | null => (typeof v === "number" || (typeof v === "string" && v.trim().length > 0)) && Number.isFinite(Number(v)) ? Number(v) : null;
const near = (a: unknown, b: number): boolean => number(a) !== null && Math.abs(number(a)! - b) <= 1e-6;
const point = (v: unknown): v is number[] => Array.isArray(v) && v.length === 3 && v.every(n => typeof n === "number" && Number.isFinite(n));
const samePoint = (a: unknown, b: number[]): boolean => point(a) && a.every((n, i) => near(n, b[i]!));

/** Deliberately bounded contract: one straight rectangular duct with two open
 * ends, explicit world coordinates, type, level, size and system. This is a
 * native desired-state check, not visual/redline interpretation certification. */
export function openDuctReadbackMatchesV2(input: unknown, affected: readonly string[], parameters: unknown, connectors: unknown): boolean {
  if (connectedDuctReadbackMatchesV2(input, affected, parameters, connectors)) return true;
  const request = record(input), compatibility = request.path === "/revit/create-duct";
  const body = compatibility ? explicitCreateDuctIntentV2(input) : record(request.body);
  if (!body) return false;
  const allowed = new Set(["kind", "viewId", "roomNumber", "levelId", "systemType", "ductTypeId", "ductShape", "ductSize", "sizePolicy", "elevationPolicy", "routingMode", "points", "connectSegments", "connectToExisting", "requireExistingEndpointConnections", "verify", "apply", "visualVerify", "visualViewId", "imageSize", "focusPaddingFt"]);
  if ((!compatibility && request.path !== "/revit/mep-route-workflow") || body.kind !== "duct" || body.apply !== true
      || body.routingMode !== "polyline" || body.ductShape !== "rectangular"
      || body.sizePolicy !== "explicit_required" || body.elevationPolicy !== "explicit_required"
      || body.connectSegments !== false || body.connectToExisting !== false || body.requireExistingEndpointConnections !== false
      || (!compatibility && !positiveId(body.ductTypeId)) || !positiveId(body.levelId) || Object.keys(body).some(key => !allowed.has(key))
      || !Array.isArray(body.points) || body.points.length !== 2 || body.points.some((p: unknown) => Object.keys(record(p)).some(k => k !== "xyz") || !point(record(p).xyz))) return false;
  const points = body.points.map((p: unknown) => record(p).xyz as number[]);
  if (samePoint(points[0], points[1])) return false;
  const size = typeof body.ductSize === "string" ? body.ductSize.match(/^(\d+(?:\.\d+)?)\s*[xX]\s*(\d+(?:\.\d+)?)$/) : null;
  const system = ({ "Supply Air": "SupplyAir", "Return Air": "ReturnAir", "Exhaust Air": "ExhaustAir" } as Record<string,string>)[body.systemType];
  if (!size || Number(size[1]) <= 0 || Number(size[2]) <= 0 || !system || affected.length !== 1 || !/^element_id:[1-9][0-9]*$/.test(affected[0]!)) return false;
  const id = Number(affected[0]!.slice("element_id:".length));
  const paramRows = record(parameters).items, read = record(connectors);
  if (!Array.isArray(paramRows) || paramRows.length !== 1 || record(paramRows[0]).id !== id
      || read.status !== "Ok" || read.requestedCount !== 1 || read.scannedElementCount !== 1 || read.failedElementCount !== 0
      || read.matchedElementCount !== 1 || read.totalScannedConnectorCount !== 2 || read.physicallyConnectedConnectorCount !== 0
      || read.openPhysicalConnectorCount !== 2 || read.connectorScanTruncatedElementCount !== 0
      || !Array.isArray(read.results) || read.results.length !== 1) return false;
  const p = record(record(paramRows[0]).parameters), row = record(read.results[0]);
  if (p["System Classification"] !== body.systemType || !near(p["Reference Level"], body.levelId)
      || !near(p.Width, Number(size[1])/12) || !near(p.Height, Number(size[2])/12)
      || row.id !== id || row.ok !== true || row.category !== "OST_DuctCurves" || (!positiveId(row.typeId) || body.ductTypeId !== undefined && row.typeId !== body.ductTypeId)
      || row.connectorCount !== 2 || row.returnedConnectorCount !== 2 || row.openPhysicalConnectorCount !== 2
      || row.connectorScanTruncated !== false || !Array.isArray(row.connectors) || row.connectors.length !== 2) return false;
  const ends = row.connectors.map(record);
  if (ends.some((end: Record<string,any>) => end.domain !== "DomainHvac" || end.shape !== "Rectangular" || end.connectorType !== "End"
      || end.isConnected !== false || end.systemClassification !== system || !Array.isArray(end.connectedTo)
      || end.connectedTo.some((value: unknown) => { const ref=record(value); return ref.isMepSystem !== true || ref.isPhysicalElement !== false || ref.ownerCategory !== "OST_DuctSystem" || !positiveId(ref.ownerId); })
      || record(end.size).kind !== "rect" || !near(record(end.size).widthFt, Number(size[1])/12) || !near(record(end.size).heightFt, Number(size[2])/12))) return false;
  return (samePoint(ends[0]!.origin, points[0]!) && samePoint(ends[1]!.origin, points[1]!))
    || (samePoint(ends[0]!.origin, points[1]!) && samePoint(ends[1]!.origin, points[0]!));
}

/** Consume a fresh connector read after a retained native parameter read. No
 * model-written report, preview, foreign binding or pre-edit read can qualify. */
export function openDuctPostconditionSatisfiedV2(snapshot: AssignmentSnapshotV2, subject: OperationV2, current: OperationResultV2, payload: unknown): boolean {
  const applied = subject.result;
  if (!["/revit/mep-route-workflow", "/revit/create-duct"].includes(subject.request_identity?.path ?? "") || subject.requested_effect !== "apply"
      || subject.persistent_effect !== "applied" || subject.settlement_state !== "settled"
      || applied?.authority !== "native-host" || applied.status !== "succeeded" || applied.native_transaction_state !== "committed"
      || !sameAssignmentBindingV2(subject.binding, snapshot.current_binding) || !sameAssignmentBindingV2(applied.binding, snapshot.current_binding)
      || current.authority !== "native-host" || current.status !== "succeeded" || current.dispatch_state !== "dispatched" || current.persistent_effect !== "none"
      || current.request_identity?.method !== "POST" || current.request_identity.path !== "/revit/get-connectors"
      || !sameAssignmentBindingV2(current.binding, snapshot.current_binding)
      || !Number.isFinite(Date.parse(current.completed_at)) || !Number.isFinite(Date.parse(applied.completed_at))
      || Date.parse(current.completed_at) < Date.parse(applied.completed_at)
      || payloadDigestV2(payload).digest !== current.raw_payload_hash) return false;
  // Another committed edit invalidates the combined readback; ask for a fresh
  // verification contract rather than combining observations across changes.
  if (Object.values(snapshot.operations).some(op => op.operation_id !== subject.operation_id && op.persistent_effect === "applied"
      && op.result && Date.parse(op.result.completed_at) >= Date.parse(applied.completed_at))) return false;
  const prior = Object.values(snapshot.operations).filter(op => op.verification_of_operation_id === subject.operation_id
    && op.request_identity?.path === "/revit/get-parameters")
    .sort((a,b) => Date.parse(b.opened_at) - Date.parse(a.opened_at))[0];
  if (!prior || prior.purpose !== "verification" || prior.fulfillment_role !== "verification" || prior.requested_effect !== "read"
      || prior.settlement_state !== "settled" || prior.result?.authority !== "native-host" || prior.result.status !== "succeeded"
      || prior.result.dispatch_state !== "dispatched" || prior.persistent_effect !== "none"
      || !sameAssignmentBindingV2(prior.binding, snapshot.current_binding)
      || !sameAssignmentBindingV2(prior.result.binding, snapshot.current_binding)
      || !Number.isFinite(Date.parse(prior.opened_at)) || !Number.isFinite(Date.parse(prior.result.completed_at))
      || Date.parse(prior.opened_at) < Date.parse(applied.completed_at) || Date.parse(prior.result.completed_at) > Date.parse(current.completed_at)) return false;
  for (const id of prior.observation_ids) {
    const observation = snapshot.observations[id];
    if (!observation || observation.operation_id !== prior.operation_id || observation.authority !== "native-host"
        || observation.raw_payload_hash !== prior.result.raw_payload_hash || !sameAssignmentBindingV2(observation.binding, snapshot.current_binding)) continue;
    try {
      const ref = readEvidenceRef(observation.raw_payload_ref.replace(/^evidence:/, ""));
      if (ref.byte_count > 2_000_000) continue;
      const bytes = readAuthoritativeEvidence(ref, { ...snapshot.current_binding, attempt_id: prior.operation_id });
      const parameters = JSON.parse(bytes.toString("utf8"));
      if (payloadDigestV2(parameters).digest !== observation.raw_payload_hash) continue;
      return openDuctReadbackMatchesV2(subject.input, applied.affected_target_identities ?? [], parameters, payload);
    } catch { /* Missing or corrupt retained evidence cannot verify a route. */ }
  }
  return false;
}
