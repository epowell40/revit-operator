import { payloadDigestV2 } from '@revitoperator/payload-digest-v2';
import { readAuthoritativeEvidence, readEvidenceRef } from '../evidence/evidence_store.js';
import { canonicalJsonV2, sameAssignmentBindingV2, type AssignmentSnapshotV2, type OperationV2, type OperationResultV2 } from '../domain/assignment-kernel/index.js';
import { appliedOperationHasVerifiedPostconditionV2 } from '../domain/assignment-kernel/outcome.js';

const object = (v: unknown): Record<string, any> => v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, any> : {};
const positive = (v: unknown): v is number => Number.isSafeInteger(v) && Number(v) > 0;
const coordinate = (v: unknown): v is number => Number.isSafeInteger(v) && Number(v) >= 0 && Number(v) <= 100000;
const digest = (v: unknown): v is string => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
const rgb = (v: unknown): v is number[] => Array.isArray(v) && v.length === 3 && v.every(n => Number.isInteger(n) && n >= 0 && n <= 255);
const section = (v: unknown) => typeof v === 'string' ? ['Header','Body','Summary','Footer'].find(n => n.toLowerCase() === v.trim().toLowerCase()) : undefined;
const key = (v: Record<string, any>) => `${section(v.section)}:${v.row}:${v.column}`;
const equal = (a: unknown, b: unknown) => canonicalJsonV2(a) === canonicalJsonV2(b);

export function isScheduleCellBackgroundEditV2(input: unknown): boolean {
  const wrapper=object(input); return Object.prototype.hasOwnProperty.call(object(wrapper.body??input),'cellStyles');
}

export function scheduleCellBackgroundRequestV2(input: unknown) {
  const wrapper = object(input), b = object(wrapper.body ?? input), cells = b.cellStyles;
  if (!positive(b.scheduleId) || (b.dryRun !== undefined && b.dryRun !== false) || !Array.isArray(cells) || !cells.length || cells.length > 64
      || Object.keys(b).some(k => !['scheduleId','cellStyles','dryRun'].includes(k))) return null;
  const normalized = cells.map(object);
  if (normalized.some(c => !section(c.section) || !coordinate(c.row) || !coordinate(c.column) || !rgb(c.backgroundColorRgb)
      || typeof c.expectedText !== 'string' || c.expectedText.length > 4000
      || Object.keys(c).some(k => !['section','row','column','expectedText','backgroundColorRgb'].includes(k)))
      || new Set(normalized.map(key)).size !== normalized.length) return null;
  return {scheduleId:b.scheduleId, cells:normalized};
}

function preservation(value: unknown) {
  const v = object(value);
  return v.complete === true && Number.isSafeInteger(v.totalCells) && v.totalCells > 0 && v.totalCells <= 10000
    && digest(v.textHash) && digest(v.unrequestedStyleHash) ? v : null;
}

/** Exact fresh fields plus unchanged content/unrequested-style census, never an apply success label. */
export function scheduleCellBackgroundReadbackMatchesV2(input: unknown, appliedPayload: unknown, freshPayload: unknown): boolean {
  const wanted = scheduleCellBackgroundRequestV2(input), applied = object(appliedPayload), fresh = object(freshPayload);
  if (!wanted || applied.schema !== 'operator.schedule_cell_background_edit.v1' || applied.status !== 'Success'
      || fresh.schema !== 'operator.schedule_cell_appearance.v1' || fresh.status !== 'Ok' || fresh.action !== 'cell_styles'
      || fresh.read_only !== true || fresh.complete !== true || applied.scheduleId !== wanted.scheduleId || fresh.scheduleId !== wanted.scheduleId
      || typeof applied.uniqueId !== 'string' || !applied.uniqueId || fresh.uniqueId !== applied.uniqueId
      || !['Schedule','PanelSchedule'].includes(applied.scheduleKind) || fresh.scheduleKind !== applied.scheduleKind
      || !Array.isArray(applied.cells) || applied.cells.length !== wanted.cells.length
      || !Array.isArray(fresh.cells) || fresh.cells.length !== wanted.cells.length) return false;
  const tx = object(applied.transaction), inventory = object(applied.changeTracking);
  if (tx.committed !== true || tx.rolledBack === true || tx.pending === true
      || !Array.isArray(tx.added_element_ids) || tx.added_element_ids.length
      || !Array.isArray(tx.deleted_element_ids) || tx.deleted_element_ids.length
      || !Array.isArray(tx.modified_element_ids) || !tx.modified_element_ids.includes(wanted.scheduleId)
      || tx.modified_element_ids.some((id: unknown) => id !== wanted.scheduleId)
      || inventory.exhaustiveChangeInventory !== true) return false;
  const before = preservation(applied.preservationBefore), after = preservation(applied.preservationAfter), current = preservation(fresh.preservation);
  if (!before || !after || !current || !equal(before,after) || !equal(before,current)) return false;
  const commit = new Map<string, any>(), now = new Map<string, any>();
  for (const v of applied.cells.map(object)) { if (commit.has(key(v))) return false; commit.set(key(v),v); }
  for (const v of fresh.cells.map(object)) { if (now.has(key(v))) return false; now.set(key(v),v); }
  return wanted.cells.every(c => {
    const prior = commit.get(key(c)), b = object(prior?.before), a = object(prior?.after), r = object(now.get(key(c)));
    return key(b) === key(c) && key(a) === key(c) && key(r) === key(c)
      && b.text === c.expectedText && a.text === c.expectedText && r.text === c.expectedText
      && b.allowOverride === true && a.allowOverride === true && r.allowOverride === true
      && digest(b.preservedStyleHash) && a.preservedStyleHash === b.preservedStyleHash && r.preservedStyleHash === b.preservedStyleHash
      && Array.isArray(b.mergedRange) && b.mergedRange.length === 4 && b.mergedRange.every(coordinate)
      && equal(a.mergedRange,b.mergedRange) && equal(r.mergedRange,b.mergedRange)
      && equal(a.gridBackgroundColorRgb,c.backgroundColorRgb) && equal(a.sheetBackgroundColorRgb,c.backgroundColorRgb)
      && equal(r.gridBackgroundColorRgb,c.backgroundColorRgb) && equal(r.sheetBackgroundColorRgb,c.backgroundColorRgb)
      && a.backgroundOverride === true && r.backgroundOverride === true;
  });
}

function settledApply(snapshot: AssignmentSnapshotV2, op: OperationV2) {
  const r = op.result, wanted = scheduleCellBackgroundRequestV2(op.input);
  if (!wanted || snapshot.unresolved_unknown_operation_ids.length || snapshot.input_invalidated_operation_ids?.includes(op.operation_id)
      || !sameAssignmentBindingV2(op.binding,snapshot.current_binding) || op.request_identity?.path !== '/revit/configure-schedule'
      || op.input.path !== op.request_identity.path || op.input.method !== 'POST' || op.requested_effect !== 'apply'
      || op.admission_state !== 'admitted' || op.dispatch_state !== 'dispatched' || op.settlement_state !== 'settled' || op.persistent_effect !== 'applied'
      || !r || r.authority !== 'native-host' || r.status !== 'succeeded' || r.dispatch_state !== 'dispatched' || r.native_transaction_state !== 'committed' || r.persistent_effect !== 'applied'
      || !sameAssignmentBindingV2(r.binding,op.binding) || r.operation_id !== op.operation_id
      || r.request_identity?.request_signature !== op.request_identity.request_signature || !r.native_correlation_id || !r.receipt_id
      || !Number.isFinite(Date.parse(r.completed_at)) || r.affected_target_identities?.length !== 1
      || r.affected_target_identities[0] !== 'element_id:'+wanted.scheduleId) return null;
  // A later edit anywhere may affect a dependent cell; reacquire current state after the latest mutation.
  if (Object.values(snapshot.operations).some(other => other.operation_id !== op.operation_id && other.requested_effect === 'apply'
      && ((other.dispatch_state === 'dispatched' && other.settlement_state !== 'settled')
        || (other.persistent_effect !== 'none' && other.result && Date.parse(other.result.completed_at) >= Date.parse(r.completed_at))))) return null;
  return wanted;
}

function retainedApply(snapshot: AssignmentSnapshotV2, op: OperationV2) {
  for (const id of op.observation_ids) {
    const o = snapshot.observations[id];
    if (!o || o.authority !== 'native-host' || o.operation_id !== op.operation_id || o.raw_payload_hash !== op.result?.raw_payload_hash
        || !sameAssignmentBindingV2(o.binding,op.binding)) continue;
    try {
      const ref = readEvidenceRef(o.raw_payload_ref.replace(/^evidence:/,'')); if (ref.byte_count > 2_000_000) continue;
      const payload = JSON.parse(readAuthoritativeEvidence(ref,{...op.binding,attempt_id:op.operation_id}).toString('utf8'));
      if (payloadDigestV2(payload).digest === op.result?.raw_payload_hash) return payload;
    } catch { /* Unavailable/unbound native evidence stays unverified; never retry its mutation. */ }
  }
  return null;
}

export function committedScheduleCellBackgroundReadbackPlanV2(snapshot: AssignmentSnapshotV2, op: OperationV2) {
  const wanted = settledApply(snapshot,op);
  if (!wanted || snapshot.terminal || snapshot.outcome !== 'active' || snapshot.completion_proposal || snapshot.execution_control?.state === 'paused'
      || op.verification_operation_ids.length || appliedOperationHasVerifiedPostconditionV2(snapshot,op.operation_id)) return null;
  return {method:'POST',path:'/revit/schedules',body:{action:'cell_styles',scheduleId:wanted.scheduleId,
    cells:wanted.cells.map(c => ({section:section(c.section),row:c.row,column:c.column}))}};
}

export function scheduleCellBackgroundPostconditionSatisfiedV2(snapshot: AssignmentSnapshotV2, op: OperationV2, read: OperationResultV2, payload: unknown) {
  const wanted = settledApply(snapshot,op);
  if (!wanted || read.authority !== 'native-host' || read.status !== 'succeeded' || read.dispatch_state !== 'dispatched' || read.persistent_effect !== 'none'
      || !sameAssignmentBindingV2(read.binding,snapshot.current_binding) || read.request_identity?.method !== 'POST' || read.request_identity.path !== '/revit/schedules'
      || !read.request_identity.request_signature || !read.native_correlation_id || !read.receipt_id
      || !Number.isFinite(Date.parse(read.completed_at)) || Date.parse(read.completed_at) <= Date.parse(op.result!.completed_at)
      || payloadDigestV2(payload).digest !== read.raw_payload_hash) return false;
  const readOp = snapshot.operations[read.operation_id], b = object(readOp?.input.body);
  const expected = wanted.cells.map(c => ({section:section(c.section),row:c.row,column:c.column}));
  // The observation comparator runs before its result is appended. The
  // admitted read is then dispatching; its authoritative result must already
  // say dispatched above. A never-dispatched request is not evidence.
  if (!readOp || readOp.requested_effect !== 'read' || readOp.admission_state !== 'admitted'
      || !['dispatching','dispatched'].includes(readOp.dispatch_state)
      || readOp.input.path !== read.request_identity.path || readOp.input.method !== 'POST'
      || !sameAssignmentBindingV2(readOp.binding,read.binding) || readOp.request_identity?.request_signature !== read.request_identity.request_signature
      || b.action !== 'cell_styles' || b.scheduleId !== wanted.scheduleId || Object.keys(b).some(k => !['action','scheduleId','cells'].includes(k))
      || !Array.isArray(b.cells) || b.cells.some((c:unknown) => Object.keys(object(c)).some(k => !['section','row','column'].includes(k)))
      || !equal(b.cells.map((c:unknown) => ({section:section(object(c).section),row:object(c).row,column:object(c).column})),expected)) return false;
  return scheduleCellBackgroundReadbackMatchesV2(op.input,retainedApply(snapshot,op),payload);
}
