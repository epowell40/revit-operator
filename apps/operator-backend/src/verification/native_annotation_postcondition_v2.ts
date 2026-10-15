import { payloadDigestV2 } from '@revitoperator/payload-digest-v2';
import { textNoteRoundTripMatchesV1 } from '@revitoperator/text-note-round-trip-v1';
import { readAuthoritativeEvidence, readEvidenceRef } from '../evidence/evidence_store.js';
import { sameAssignmentBindingV2, type AssignmentSnapshotV2, type OperationV2, type OperationResultV2 } from '../domain/assignment-kernel/index.js';
import { appliedOperationHasVerifiedPostconditionV2 } from '../domain/assignment-kernel/outcome.js';

const object = (v: unknown): Record<string, any> => v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, any> : {};
const positive = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v > 0;
const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const near = (a: unknown, b: unknown) => finite(a) && finite(b) && Math.abs(a - b) <= 1e-7;
const ids = (v: unknown): v is number[] => Array.isArray(v) && v.length <= 64 && v.every(positive) && new Set(v).size === v.length;
const equalIds = (a: number[], b: number[]) => a.length === b.length && a.every(id => b.includes(id));
const uid = (v: unknown) => typeof v === 'string' && v.length >= 10 && v.length <= 256 && !/[\x00-\x1f\x7f]/.test(v);

/** Deliberately bounded contracts. Name/query resolution, text repair/type
 * creation, viewport type/pinning changes and cross-sheet deletion are not
 * certified by a position/text check. Unsupported requests remain unchecked. */
export function nativeAnnotationRequestV2(input: unknown) {
  const q = object(input), b = object(q.body);
  if (q.method !== 'POST' || b.dryRun != null && b.dryRun !== false) return null;
  if (q.path === '/revit/place-view' && positive(b.sheetId) && positive(b.viewId)
      && b.lockViewport == null && b.viewportTypeId == null && b.viewportTypeName == null
      && (b.x == null || finite(b.x)) && (b.y == null || finite(b.y))
      && (b.avoidOverlap == null || typeof b.avoidOverlap === 'boolean')
      && (b.moveIfAlreadyPlaced == null || typeof b.moveIfAlreadyPlaced === 'boolean'))
    return {kind: 'placement' as const, body: b};
  if (q.path === '/revit/create-text' && (b.action == null || b.action === 'create')
      && positive(b.viewId) && finite(b.x) && finite(b.y) && typeof b.text === 'string'
      && b.text.trim().length > 0 && Buffer.byteLength(b.text, 'utf8') <= 4096
      && (b.typeId == null || positive(b.typeId)) && (b.typeName == null || typeof b.typeName === 'string')
      && (b.widthFt == null || finite(b.widthFt) && b.widthFt > 0))
    return {kind: 'text' as const, body: b};
  return null;
}

/** The receipt supplies a resolved native identity and full change inventory,
 * never a verification. Only the separate read below can prove the result. */
export function nativeAnnotationCommitTargetV2(input: unknown, payload: unknown) {
  const q = nativeAnnotationRequestV2(input), p = object(payload), tx = object(p.transaction), tracking = object(p.changeTracking);
  if (!q || p.success !== true || tx.status !== 'committed' || tx.committed !== true
      || tx.pending === true || tx.rolled_back === true || p.previewExecuted === true
      || !ids(tx.added_element_ids) || !ids(tx.modified_element_ids) || !ids(tx.deleted_element_ids)
      || tx.deleted_element_ids.length || !ids(tx.affected_element_ids)
      || !equalIds([...new Set([...tx.added_element_ids, ...tx.modified_element_ids])], tx.affected_element_ids)
      || tracking.documentChangedObserved !== true || tracking.exhaustiveChangeInventory !== true
      || tracking.captureFailureCount !== 0 || !positive(tracking.matchingEventCount)
      || tracking.distinctWrapperMatchCount !== 1) return null;
  if (q.kind === 'placement') {
    const b = q.body, creating = p.action === 'Create', moving = p.action === 'MoveExisting';
    if (!positive(p.id) || p.sheetId !== b.sheetId || p.viewId !== b.viewId || !finite(p.x) || !finite(p.y)
        || !['Viewport', 'ScheduleSheetInstance', 'PanelScheduleSheetInstance'].includes(p.placementType)
        || !(creating && p.status === 'Placed' || moving && b.moveIfAlreadyPlaced === true && p.status === 'Moved')
        || !equalIds(tx.added_element_ids, creating ? [p.id] : [])
        || !tx.affected_element_ids.includes(p.id)
        || tx.modified_element_ids.some(id => ![p.id, p.sheetId, p.viewId].includes(id))) return null;
    const automatic = p.placementType !== 'Viewport' && (b.avoidOverlap ?? (b.x == null && b.y == null));
    if (!automatic && (!near(p.x, b.x ?? 0) || !near(p.y, b.y ?? 0))) return null;
    return {kind: q.kind, id: p.id as number, read: {method: 'POST', path: '/revit/sheets',
      body: {action: 'detail', sheetId: p.sheetId, placementIds: [p.id], includeViewportGeometry: true}}};
  }
  const n = object(p.textNote), t = object(p.textType), b = q.body;
  if (p.action !== 'create' || p.status !== 'Success' || p.applied !== true || !positive(p.textNoteId)
      || p.viewId !== b.viewId || n.textNoteId !== p.textNoteId || n.viewId !== b.viewId
      || !positive(t.id) || object(n.textType).id !== t.id
      || b.typeId != null && t.id !== b.typeId
      || b.typeId == null && b.typeName != null && t.name !== b.typeName
      || !equalIds(tx.added_element_ids, [p.textNoteId])
      || tx.modified_element_ids.some(id => id !== b.viewId && id !== p.textNoteId)) return null;
  return {kind: q.kind, id: p.textNoteId as number, read: {method: 'POST', path: '/revit/find-text-notes',
    body: {elementIds: [p.textNoteId], max: 1}}};
}

export function nativeAnnotationReadbackMatchesV2(input: unknown, applied: unknown, readInput: unknown, payload: unknown): boolean {
  const c = nativeAnnotationCommitTargetV2(input, applied), p = object(payload), a = object(applied), b = nativeAnnotationRequestV2(input)?.body;
  const read = object(readInput);
  if (!c || !b || read.method !== c.read.method || read.path !== c.read.path
      || JSON.stringify(read.body) !== JSON.stringify(c.read.body)) return false;
  if (c.kind === 'placement') {
    if (p.status !== 'Ok' || p.action !== 'detail' || p.sheetId !== b.sheetId || p.sheetElementId !== b.sheetId
        || p.truncated === true || p.hasMore === true || !Array.isArray(p.placedSchedules) || !Array.isArray(p.viewportGeometry)
        || p.placedScheduleCount !== p.placedSchedules.length || p.viewportCount !== p.viewportGeometry.length) return false;
    const all = [...p.placedSchedules.map((v: any) => ({id: v.instanceId, ...v})),
      ...p.viewportGeometry.map((v: any) => ({id: v.viewportId, ...v}))];
    if (all.some(v => !positive(v.id)) || new Set(all.map(v => v.id)).size !== all.length) return false;
    const matches = all.filter(v => v.id === c.id);
    if (matches.length !== 1) return false;
    const v = matches[0], viewport = a.placementType === 'Viewport', point = object(viewport ? v.center : v.point);
    return (viewport ? v.viewportId === c.id && v.viewId === b.viewId
      : v.instanceId === c.id && v.scheduleId === b.viewId && v.placementType === a.placementType)
      && near(point.u, a.x) && near(point.v, a.y) && near(point.z, 0);
  }
  if (p.ok !== true || p.scope !== 'active_project' || p.exactElementFilterApplied !== true || p.itemsComplete !== true
      || p.truncated === true || !ids(p.requestedElementIds) || !equalIds(p.requestedElementIds, [c.id])
      || !ids(p.elementIds) || !equalIds(p.elementIds, [c.id]) || !Array.isArray(p.items) || p.items.length !== 1) return false;
  const n = p.items[0], point = object(n.location), type = object(a.textType);
  // Same native uppercase drafting policy; the shared round-trip adapter alone
  // handles native CR and the single trailing paragraph, never arbitrary trim.
  const requested = b.text.replace(/[a-z]/g, (ch: string) => ch.toUpperCase());
  return n.textNoteId === c.id && n.elementId === c.id && uid(n.uniqueId) && n.ownerViewId === b.viewId
    && uid(n.ownerViewUniqueId) && n.textTypeId === type.id && uid(n.textTypeUniqueId)
    && typeof n.text === 'string' && textNoteRoundTripMatchesV1(requested, n.text)
    && near(point.x, b.x) && near(point.y, b.y) && near(point.z, 0)
    && (b.widthFt == null || near(n.widthFeet, b.widthFt));
}

function commit(snapshot: AssignmentSnapshotV2, op: OperationV2) {
  const r = op.result;
  if (snapshot.execution_control?.state === 'paused' || snapshot.unresolved_unknown_operation_ids.length
      || snapshot.input_invalidated_operation_ids?.includes(op.operation_id) || op.requested_effect !== 'apply'
      || op.admission_state !== 'admitted' || op.dispatch_state !== 'dispatched' || op.settlement_state !== 'settled'
      || op.persistent_effect !== 'applied' || !r || r.status !== 'succeeded' || r.authority !== 'native-host'
      || r.native_transaction_state !== 'committed' || r.persistent_effect !== 'applied' || r.dispatch_state !== 'dispatched'
      || r.operation_id !== op.operation_id || !r.receipt_id || !r.native_correlation_id || !Number.isFinite(Date.parse(r.completed_at))
      || !sameAssignmentBindingV2(op.binding, snapshot.current_binding) || !sameAssignmentBindingV2(r.binding, op.binding)
      || op.input.method !== 'POST' || !op.request_identity || op.input.path !== op.request_identity.path || !op.request_identity.request_signature
      || r.request_identity?.request_signature !== op.request_identity.request_signature
      || Object.values(snapshot.operations).some(other => other.operation_id !== op.operation_id && other.requested_effect === 'apply'
        && (other.dispatch_state === 'dispatched' && other.settlement_state !== 'settled'
          || other.persistent_effect !== 'none' && other.result && Date.parse(other.result.completed_at) >= Date.parse(r.completed_at)))) return null;
  for (const id of op.observation_ids) {
    const o = snapshot.observations[id];
    if (!o || o.operation_id !== op.operation_id || o.authority !== 'native-host' || o.raw_payload_hash !== r.raw_payload_hash
        || !sameAssignmentBindingV2(o.binding, op.binding)) continue;
    try {
      const ref = readEvidenceRef(o.raw_payload_ref.replace(/^evidence:/, '')); if (ref.byte_count > 2_000_000) continue;
      const payload = JSON.parse(readAuthoritativeEvidence(ref, {...op.binding, attempt_id: op.operation_id}).toString('utf8'));
      const c = nativeAnnotationCommitTargetV2(op.input, payload);
      const affected = object(payload).transaction?.affected_element_ids;
      if (c && payloadDigestV2(payload).digest === r.raw_payload_hash && Array.isArray(affected) && Array.isArray(r.affected_target_identities)
          && equalIds(affected.map((id: number) => id), r.affected_target_identities.map(id => Number(id.replace(/^element_id:/, ''))))) return {c, payload};
    } catch { /* Missing, altered or foreign evidence stays unchecked. */ }
  }
  return null;
}

export function committedNativeAnnotationReadbackPlanV2(snapshot: AssignmentSnapshotV2, op: OperationV2) {
  if (snapshot.terminal || snapshot.outcome !== 'active' || snapshot.completion_proposal
      || op.verification_operation_ids.length || appliedOperationHasVerifiedPostconditionV2(snapshot, op.operation_id)) return null;
  return commit(snapshot, op)?.c.read ?? null;
}

export function nativeAnnotationPostconditionSatisfiedV2(snapshot: AssignmentSnapshotV2, op: OperationV2, result: OperationResultV2, payload: unknown) {
  const c = commit(snapshot, op), read = snapshot.operations[result.operation_id];
  if (!c || !read || read.requested_effect !== 'read' || read.purpose !== 'verification' || read.admission_state !== 'admitted'
      || read.verification_of_operation_id !== op.operation_id || snapshot.input_invalidated_operation_ids?.includes(read.operation_id)
      || !['dispatching', 'dispatched'].includes(read.dispatch_state) || result.authority !== 'native-host' || result.status !== 'succeeded'
      || result.dispatch_state !== 'dispatched' || result.persistent_effect !== 'none' || result.native_transaction_state !== 'not_applicable'
      || !sameAssignmentBindingV2(result.binding, snapshot.current_binding) || !sameAssignmentBindingV2(read.binding, result.binding)
      || !read.request_identity?.request_signature || result.request_identity?.request_signature !== read.request_identity.request_signature
      || read.input.method !== result.request_identity.method || read.input.path !== result.request_identity.path
      || !result.receipt_id || !result.native_correlation_id
      || ![read.opened_at, result.completed_at].every(t => Number.isFinite(Date.parse(t)))
      || Date.parse(read.opened_at) < Date.parse(op.result!.completed_at) || Date.parse(result.completed_at) < Date.parse(read.opened_at)
      || payloadDigestV2(payload).digest !== result.raw_payload_hash) return false;
  return nativeAnnotationReadbackMatchesV2(op.input, c.payload, read.input, payload);
}
