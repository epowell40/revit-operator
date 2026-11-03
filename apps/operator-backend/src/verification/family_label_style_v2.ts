import type { AssignmentSnapshotV2, OperationV2 } from '../domain/assignment-kernel/index.js';
import { sameAssignmentBindingV2 } from '../domain/assignment-kernel/identity.js';
import { appliedOperationHasVerifiedPostconditionV2 } from '../domain/assignment-kernel/outcome.js';

const object = (v: unknown): Record<string, any> => v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, any> : {};
const body = (v: unknown) => { const r = object(v); return object(r.body ?? r.arguments ?? v); };
const positive = (v: unknown): v is number => Number.isSafeInteger(v) && Number(v) > 0;
const session = (v: unknown): v is string => typeof v === 'string' && /^[0-9a-f]{32}$/.test(v);
const fields = ['font', 'textSizeFeet', 'bold', 'italic', 'underline', 'widthFactor'];
function style(v: unknown): Record<string, string | number | boolean> | null {
  const r = object(v);
  if (!Object.keys(r).length || Object.keys(r).some(k => !fields.includes(k))) return null;
  for (const [key, value] of Object.entries(r)) {
    if (key === 'font') {
      if (typeof value !== 'string' || !value || value !== value.trim() || value.length > 128 || /[\x00-\x1f\x7f]/.test(value)) return null;
    } else if (key === 'textSizeFeet' || key === 'widthFactor') {
      if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0 || value > (key === 'textSizeFeet' ? 1 : 100)) return null;
    } else if (typeof value !== 'boolean') return null;
  }
  return r;
}
const same = (a: unknown, b: unknown) => typeof a === 'number' && typeof b === 'number'
  ? Math.abs(a - b) <= 1e-10 * Math.max(1, Math.abs(a)) : a === b;

export function familyLabelStyleRequestV2(input: unknown) {
  const b = body(input), desired = style(b.style), expected = style(b.expectedStyle);
  if (!session(b.familyDocumentId) || !positive(b.labelTypeId) || typeof b.expectedTypeUniqueId !== 'string'
    || !b.expectedTypeUniqueId.trim() || b.expectedTypeUniqueId.length > 256 || b.dryRun === true
    || !desired || !expected || Object.keys(desired).some(k => !(k in expected))
    || Object.keys(b).some(k => !['familyDocumentId', 'labelTypeId', 'expectedTypeUniqueId', 'style', 'expectedStyle', 'dryRun'].includes(k))) return null;
  return { familyDocumentId: b.familyDocumentId, labelTypeId: b.labelTypeId as number,
    uniqueId: b.expectedTypeUniqueId as string, desired, expected };
}

export function familyLabelStyleReadTargetV2(input: unknown) {
  const b = body(input);
  if (!session(b.familyDocumentId) || !positive(b.labelTypeId)
    || Object.keys(b).some(k => !['familyDocumentId', 'labelTypeId', 'maxStyles'].includes(k))
    || b.maxStyles !== undefined && (!positive(b.maxStyles) || b.maxStyles > 500)) return null;
  return { familyDocumentId: b.familyDocumentId, labelTypeId: b.labelTypeId as number };
}

/** Child-document IDs are not project element IDs. The session is part of the
 * principal identity, so the same numeric ID in another family cannot bind. */
export function familyLabelStyleTargetTokensV2(input: unknown): string[] {
  const b = body(input), p = object(input);
  const id = b.labelTypeId ?? (p.scope === 'family_session' && p.items?.length === 1 ? p.items[0]?.labelTypeId : undefined);
  const handle = b.familyDocumentId;
  return session(handle) && positive(id) ? [`family_label_type:${handle}:${id}`] : [];
}

/** Predicate credit is limited to this unsaved family session. Loading a
 * family and checking the effective project tags are separate obligations. */
export function familyLabelStyleSatisfiedV2(input: unknown, readInput: unknown, payload: unknown, affected: readonly string[]) {
  const request = familyLabelStyleRequestV2(input), r = object(readInput), target = familyLabelStyleReadTargetV2(readInput), p = object(payload);
  if (!request || !target || r.method !== 'POST' || r.path !== '/revit/inspect-family-label-styles'
    || target.familyDocumentId !== request.familyDocumentId || target.labelTypeId !== request.labelTypeId
    || !affected.includes('element_id:' + request.labelTypeId)
    || p.ok !== true || p.observational !== true || p.mutated !== false || p.scope !== 'family_session'
    || p.familyDocumentId !== request.familyDocumentId || p.loadedProjectStyleVerified !== false
    || p.error || p.isError === true || p.truncated !== false || p.count !== 1 || p.totalStyles !== 1
    || !Array.isArray(p.items) || p.items.length !== 1) return false;
  const item = object(p.items[0]), actual = style(item.style);
  if (item.labelTypeId !== request.labelTypeId || item.uniqueId !== request.uniqueId || !actual
    || item.labelsComplete !== true || !positive(item.labelCount) || item.labelCount > 500
    || !Array.isArray(item.labelIds) || item.labelIds.length !== item.labelCount || !item.labelIds.every(positive)
    || new Set(item.labelIds).size !== item.labelIds.length) return false;
  // Preserve every additional baseline value supplied by the caller as well
  // as checking the requested patch. Omitted values receive no proof credit.
  return Object.entries({ ...request.expected, ...request.desired }).every(([key, value]) => same(actual[key], value));
}

/** Read recipe only; it re-enters normal authentication/admission and cannot
 * repeat a mutation, cross a pause or reconcile an unknown effect. */
export function committedFamilyLabelStyleReadbackPlanV2(snapshot: AssignmentSnapshotV2, op: OperationV2) {
  const request = familyLabelStyleRequestV2(op.input), result = op.result;
  if (!request || snapshot.terminal || snapshot.outcome !== 'active' || snapshot.completion_proposal
    || snapshot.execution_control?.state === 'paused' || snapshot.unresolved_unknown_operation_ids.length
    || snapshot.input_invalidated_operation_ids?.includes(op.operation_id)
    || !sameAssignmentBindingV2(snapshot.current_binding, op.binding)
    || op.admission_state !== 'admitted' || op.dispatch_state !== 'dispatched' || op.settlement_state !== 'settled'
    || op.requested_effect !== 'apply' || op.persistent_effect !== 'applied'
    || op.request_identity?.path !== '/revit/set-family-label-style'
    || op.input.method !== 'POST' || op.input.path !== op.request_identity.path
    || !result || result.status !== 'succeeded' || result.authority !== 'native-host'
    || result.native_transaction_state !== 'committed' || result.persistent_effect !== 'applied'
    || result.operation_id !== op.operation_id || !sameAssignmentBindingV2(result.binding, op.binding)
    || !op.request_identity.request_signature || result.request_identity?.request_signature !== op.request_identity.request_signature
    || !Number.isFinite(Date.parse(result.completed_at)) || !result.affected_target_identities?.includes('element_id:' + request.labelTypeId)
    || op.verification_operation_ids.length || appliedOperationHasVerifiedPostconditionV2(snapshot, op.operation_id)) return null;
  // Any subsequent mutation can close/reload/change the family session. Do
  // not infer child-document stability from project IDs or path names alone.
  if (Object.values(snapshot.operations).some(other => other.operation_id !== op.operation_id && other.requested_effect === 'apply'
    && (other.persistent_effect === 'unknown' || snapshot.in_flight_operation_ids?.includes(other.operation_id)
      || other.persistent_effect !== 'none' && other.opened_at >= op.opened_at))) return null;
  return { method: 'POST', path: '/revit/inspect-family-label-styles',
    body: { familyDocumentId: request.familyDocumentId, labelTypeId: request.labelTypeId, maxStyles: 1 } };
}
