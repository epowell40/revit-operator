import { payloadDigestV2 } from '@revitoperator/payload-digest-v2';
import { readAuthoritativeEvidence, readEvidenceRef } from '../evidence/evidence_store.js';
import { sameAssignmentBindingV2, type AssignmentSnapshotV2, type OperationV2, type OperationResultV2 } from '../domain/assignment-kernel/index.js';
import { appliedOperationHasVerifiedPostconditionV2 } from '../domain/assignment-kernel/outcome.js';

const row = (v: unknown): Record<string, any> => v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, any> : {};
const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const id = (v: unknown): v is number => Number.isSafeInteger(v) && Number(v) > 0;
const near = (a: unknown, b: number) => finite(a) && Math.abs(a - b) <= 1e-7;
const xyz = (v: unknown): v is number[] => Array.isArray(v) && v.length === 3 && v.every(finite);
const sameRotation = (a: unknown, b: unknown) => finite(a) && finite(b)
  && Math.abs(Math.atan2(Math.sin(a-b), Math.cos(a-b))) <= 1e-7;

function pointMove(input: unknown, nativeApply: unknown) {
  const request = row(input), body = row(request.body), applied = row(nativeApply), tx = row(applied.transaction);
  const ids = body.ids, delta = [body.vectorX ?? 0, body.vectorY ?? 0, body.vectorZ ?? 0];
  if (request.method !== 'POST' || request.path !== '/revit/move-elements' || body.mode !== 'vector' || body.dryRun !== false
      || !Array.isArray(ids) || !ids.length || ids.length > 256 || !ids.every(id) || new Set(ids).size !== ids.length
      || !delta.every(finite) || !delta.some(v=>v!==0) || applied.success !== true || applied.applied !== true
      || applied.status !== 'Moved' || applied.rolledBack !== false || tx.status !== 'committed' || tx.committed !== true
      || !Array.isArray(tx.modified_element_ids) || ids.some(n=>!tx.modified_element_ids.includes(n))
      || !Array.isArray(tx.added_element_ids) || tx.added_element_ids.length || !Array.isArray(tx.deleted_element_ids) || tx.deleted_element_ids.length
      || !Array.isArray(applied.movedIds) || applied.movedIds.length !== ids.length || new Set(applied.movedIds).size !== ids.length
      || applied.movedIds.some((n: unknown)=>!id(n)||!ids.includes(n)) || !Array.isArray(applied.snapshots) || applied.snapshots.length !== ids.length) return null;
  const seen = new Set<number>();
  for (const value of applied.snapshots) {
    const s = row(value), before = row(s.before), after = row(s.after);
    if (!ids.includes(s.id) || seen.has(s.id) || before.kind !== 'LocationPoint' || after.kind !== 'LocationPoint'
        || !xyz(before.pointXyz) || !xyz(after.pointXyz) || !sameRotation(before.rotationRadians,after.rotationRadians)
        || !after.pointXyz.every((v: number,i: number)=>near(v,before.pointXyz[i]+delta[i]))) return null;
    seen.add(s.id);
  }
  return {ids: ids as number[], delta, snapshots: applied.snapshots as any[]};
}

/** Compare native before + admitted vector with a separate complete point read.
 * This proves the requested translation/rotation only: no PDF interpretation,
 * host-face, connectivity, collision or whole-comment claim is inferred. */
export function modelPointMoveReadbackMatchesV2(input: unknown, nativeApply: unknown, payload: unknown): boolean {
  const move = pointMove(input,nativeApply); if (!move) return false;
  const p = row(payload);
  const items: unknown = Array.isArray(payload) ? payload : Array.isArray(p.result) ? p.result
    : p.schema === 'operator.electrical_membership_read.v1' && p.complete === true
      && Array.isArray(p.requestedElementIds) && p.requestedElementIds.every(id)
      && new Set(p.requestedElementIds).size === p.requestedElementIds.length
      && move.ids.every(n=>p.requestedElementIds.includes(n)) ? p.items : null;
  if (!Array.isArray(items) || items.length < move.ids.length || items.length > 1024 || p.truncated === true
      || (p.schema === 'operator.electrical_membership_read.v1' && items.length !== p.requestedElementIds.length)) return false;
  const actual = new Map<number, any>();
  for (const value of items) {
    const item = row(value);
    if (!id(item.id) || actual.has(item.id) || item.found !== true
        || typeof item.uniqueId !== 'string' || !item.uniqueId.trim() || row(item.location).type !== 'point') return false;
    if(p.schema === 'operator.electrical_membership_read.v1' && !p.requestedElementIds.includes(item.id))return false;
    actual.set(item.id,item);
  }
  return move.snapshots.every(s=> {
    if(!actual.has(s.id))return false;
    const location = row(actual.get(s.id).location);
    return [location.x,location.y,location.z].every((v,i)=>near(v,s.before.pointXyz[i]+move.delta[i]))
      && sameRotation(location.rotationRadians,s.before.rotationRadians);
  });
}

function committedSubject(snapshot: AssignmentSnapshotV2, op: OperationV2): boolean {
  const r=op.result;
  return Boolean(!snapshot.unresolved_unknown_operation_ids.length && !snapshot.input_invalidated_operation_ids?.includes(op.operation_id)
    && op.admission_state==='admitted' && op.dispatch_state==='dispatched' && op.settlement_state==='settled'
    && op.requested_effect==='apply' && op.persistent_effect==='applied' && op.request_identity?.method==='POST'
    && op.request_identity.path==='/revit/move-elements' && op.request_identity.request_signature
    && r?.operation_id===op.operation_id && r.status==='succeeded' && r.authority==='native-host' && r.dispatch_state==='dispatched'
    && r.native_transaction_state==='committed' && r.persistent_effect==='applied' && r.receipt_id && r.native_correlation_id
    && sameAssignmentBindingV2(op.binding,snapshot.current_binding) && sameAssignmentBindingV2(r.binding,op.binding)
    && r.request_identity?.request_signature===op.request_identity.request_signature && Number.isFinite(Date.parse(r.completed_at))
    && !Object.values(snapshot.operations).some(o=>o.operation_id!==op.operation_id && o.persistent_effect==='applied'
      && o.result && Date.parse(o.result.completed_at)>=Date.parse(r.completed_at)));
}

function retainedApply(snapshot: AssignmentSnapshotV2, op: OperationV2): unknown | null {
  if (!committedSubject(snapshot,op)) return null;
  for (const oid of op.observation_ids) {
    const o=snapshot.observations[oid];
    if (!o || o.operation_id!==op.operation_id || o.authority!=='native-host' || o.raw_payload_hash!==op.result!.raw_payload_hash
        || !sameAssignmentBindingV2(o.binding,op.binding) || !o.raw_payload_ref.startsWith('evidence:')) continue;
    try {
      const ref=readEvidenceRef(o.raw_payload_ref.slice('evidence:'.length));if(ref.byte_count>2_000_000)continue;
      const p=JSON.parse(readAuthoritativeEvidence(ref,{...op.binding,attempt_id:op.operation_id}).toString('utf8'));
      if(payloadDigestV2(p).digest===op.result!.raw_payload_hash)return p;
    } catch { /* Missing or altered retained evidence stays unverified. */ }
  }
  return null;
}

/** Planning uses the commit only to choose exact targets. It never emits proof. */
export function committedModelPointMoveReadbackPlanV2(snapshot: AssignmentSnapshotV2, op: OperationV2) {
  if (snapshot.terminal || snapshot.outcome!=='active' || snapshot.completion_proposal || snapshot.execution_control?.state==='paused'
      || op.verification_operation_ids.length || appliedOperationHasVerifiedPostconditionV2(snapshot,op.operation_id)) return null;
  const p=retainedApply(snapshot,op), move=pointMove(op.input,p);
  if (!move || move.ids.some(n=>!op.result!.affected_target_identities?.includes('element_id:'+n))) return null;
  return {method:'POST',path:'/revit/get-element-summary',body:{elementIds:[...move.ids]}};
}

export function modelPointMovePostconditionSatisfiedV2(snapshot: AssignmentSnapshotV2, subject: OperationV2, result: OperationResultV2, payload: unknown): boolean {
  const read=snapshot.operations[result.operation_id], commit=subject.result;
  if (!read || read.verification_of_operation_id!==subject.operation_id || read.requested_effect!=='read'
      || read.request_identity?.method!=='POST' || read.request_identity.path!=='/revit/get-element-summary'
      || result.request_identity?.method!=='POST' || result.request_identity.path!=='/revit/get-element-summary'
      || result.request_identity.request_signature!==read.request_identity.request_signature
      || result.authority!=='native-host' || result.status!=='succeeded' || result.dispatch_state!=='dispatched'
      || result.persistent_effect!=='none' || result.native_transaction_state!=='not_applicable'
      || !sameAssignmentBindingV2(read.binding,snapshot.current_binding) || !sameAssignmentBindingV2(result.binding,snapshot.current_binding)
      || !commit || !Number.isFinite(Date.parse(read.opened_at)) || !Number.isFinite(Date.parse(result.completed_at))
      || Date.parse(read.opened_at)<Date.parse(commit.completed_at) || Date.parse(result.completed_at)<Date.parse(read.opened_at)
      || payloadDigestV2(payload).digest!==result.raw_payload_hash) return false;
  const p=retainedApply(snapshot,subject);
  return p!==null && modelPointMoveReadbackMatchesV2(subject.input,p,payload);
}
