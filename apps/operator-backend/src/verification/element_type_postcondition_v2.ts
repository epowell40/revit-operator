import type { AssignmentSnapshotV2, OperationV2 } from '../domain/assignment-kernel/index.js';
import { sameAssignmentBindingV2 } from '../domain/assignment-kernel/identity.js';
import { appliedOperationHasVerifiedPostconditionV2 } from '../domain/assignment-kernel/outcome.js';

const object = (v: unknown): Record<string, any> => v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, any> : {};
const positiveId = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v > 0;

/** Explicit native type IDs only. A name lookup, conflicting aliases or an
 * oversized/ambiguous selection cannot become an exact type assertion. */
export function elementTypeRequestV2(input: unknown) {
  const outer = object(input), body = object(outer.body ?? outer.arguments ?? input);
  if (body.dryRun === true || body.apply === false) return null;
  const typeId = body.typeId ?? body.newTypeId;
  if (!positiveId(typeId) || body.typeId !== undefined && body.newTypeId !== undefined && body.typeId !== body.newTypeId) return null;
  if (body.elementId !== undefined && body.elementIds !== undefined) return null;
  const ids: unknown = body.elementIds ?? (body.elementId !== undefined ? [body.elementId] : null);
  if (!Array.isArray(ids) || ids.length < 1 || ids.length > 100 || !ids.every(positiveId) || new Set(ids).size !== ids.length) return null;
  return { typeId, ids: [...ids].sort((a,b) => a-b) };
}

/** Complete separate native parameter read; display names and echoed requested
 * type IDs cannot substitute for the built-in ELEM_TYPE_PARAM ElementId. */
export function elementTypeSatisfiedV2(input: unknown, verificationInput: unknown, payload: unknown, affected: readonly string[]) {
  const expected = elementTypeRequestV2(input), read = object(verificationInput), body = object(read.body);
  if (!expected || read.method !== 'POST' || read.path !== '/revit/get-parameters'
    || !Array.isArray(body.elementIds) || body.elementIds.length !== expected.ids.length
    || new Set(body.elementIds).size !== expected.ids.length || !expected.ids.every(id => body.elementIds.includes(id))
    || !Array.isArray(body.names) || !body.names.includes('Type')
    || expected.ids.some(id => !affected.includes('element_id:' + id))) return false;
  const items = object(payload).items;
  if (!Array.isArray(items) || items.length !== expected.ids.length) return false;
  const seen = new Set<number>();
  for (const item of items) {
    if (!positiveId(item?.id) || !expected.ids.includes(item.id) || seen.has(item.id)
      || typeof item.uniqueId !== 'string' || !item.uniqueId.trim() || item.found === false || item.error
      || !Array.isArray(item.parameterDetails)) return false;
    seen.add(item.id);
    const type = item.parameterDetails.filter((p: any) => p?.parameterId === -1002050);
    if (type.length !== 1 || type[0].storageType !== 'ElementId' || type[0].name !== 'Type'
      || type[0].value !== String(expected.typeId) || item.parameters?.Type !== String(expected.typeId)) return false;
  }
  return seen.size === expected.ids.length;
}

/** A recipe, never mutation authority or proof. It runs through the existing
 * dynamic handler's authentication, pause, schema and admission boundaries. */
export function committedElementTypeReadbackPlanV2(snapshot: AssignmentSnapshotV2, operation: OperationV2) {
  const result = operation.result, request = elementTypeRequestV2(operation.input);
  if (snapshot.terminal || snapshot.outcome !== 'active' || snapshot.completion_proposal
    || snapshot.execution_control?.state === 'paused' || snapshot.unresolved_unknown_operation_ids.length
    || snapshot.input_invalidated_operation_ids?.includes(operation.operation_id)
    || !sameAssignmentBindingV2(snapshot.current_binding, operation.binding)
    || operation.admission_state !== 'admitted' || operation.dispatch_state !== 'dispatched'
    || operation.settlement_state !== 'settled' || operation.requested_effect !== 'apply' || operation.persistent_effect !== 'applied'
    || operation.request_identity?.path !== '/revit/change-element-type'
    || operation.input.method !== 'POST' || operation.input.path !== operation.request_identity.path
    || !result || result.status !== 'succeeded' || result.authority !== 'native-host' || result.native_transaction_state !== 'committed'
    || result.persistent_effect !== 'applied' || result.operation_id !== operation.operation_id
    || !sameAssignmentBindingV2(result.binding, operation.binding)
    || !operation.request_identity.request_signature || result.request_identity?.request_signature !== operation.request_identity.request_signature
    || !Number.isFinite(Date.parse(result.completed_at)) || !request
    || request.ids.some(id => !result.affected_target_identities?.includes('element_id:' + id))
    || operation.verification_operation_ids.length || appliedOperationHasVerifiedPostconditionV2(snapshot, operation.operation_id)) return null;
  if (Object.values(snapshot.operations).some(other => other.operation_id !== operation.operation_id
    && other.requested_effect === 'apply' && other.persistent_effect !== 'none' && other.opened_at >= operation.opened_at
    && (other.result?.affected_target_identities?.some(id => request.ids.some(n => id === 'element_id:' + n))
      || elementTypeRequestV2(other.input)?.ids.some(id => request.ids.includes(id))))) return null;
  return { method: 'POST', path: '/revit/get-parameters', body: { elementIds: request.ids, names: ['Type'], limit: 100 } };
}
