import { regularScheduleFieldDefinitionV2 as definition } from './regular_schedule_field_definition_v2.js';
import { regularSchedulePresentationScopeMatchesV2, regularSchedulePresentationInventoryMatchesV2 } from './regular_schedule_presentation_scope_v2.js';
import { payloadDigestV2 } from '@revitoperator/payload-digest-v2';
import { readAuthoritativeEvidence, readEvidenceRef } from '../evidence/evidence_store.js';
import { canonicalJsonV2, sameAssignmentBindingV2, type AssignmentSnapshotV2, type OperationV2, type OperationResultV2 } from '../domain/assignment-kernel/index.js';
import { appliedOperationHasVerifiedPostconditionV2 } from '../domain/assignment-kernel/outcome.js';
import { scheduleCombinedFieldRequestV2, scheduleCombinedFieldReadbackMatchesV2 } from './schedule_combined_field_v2.js';

const object = (v: unknown): Record<string, any> => v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, any> : {};
const positive = (v: unknown): v is number => Number.isSafeInteger(v) && Number(v) > 0;
const equal = (a: unknown, b: unknown) => canonicalJsonV2(a) === canonicalJsonV2(b);
const styleKeys = ['titleTextTypeId','headerTextTypeId','bodyTextTypeId'];
export function isRegularSchedulePresentationEditV2(input: unknown): boolean {
  const w=object(input), b=object(w.body??input), a=object(b.appearance);
  return Object.hasOwn(b,'columnWidths') || Object.hasOwn(b,'combinedField') || Object.hasOwn(b,'fieldOrder') || styleKeys.some(k=>Object.hasOwn(a,k));
}
/** Existing-field order/styles or width-preserving edits. Structural and unsupported mixed changes stay unverified. */
export function regularSchedulePresentationRequestV2(input: unknown) {
  const w=object(input), b=object(w.body??input), a=object(b.appearance);
  if (!isRegularSchedulePresentationEditV2(input) || !positive(b.scheduleId) || (b.dryRun!==undefined&&b.dryRun!==false)
      || Object.keys(b).some(k=>!['scheduleId','fieldOrder','appearance','columnWidths','dryRun'].includes(k))
      || (b.appearance!==undefined && (b.appearance===null||typeof b.appearance!=='object'||Array.isArray(b.appearance)))
      || Object.keys(a).some(k=>![...styleKeys,'showTitle','showHeaders'].includes(k))
      || styleKeys.some(k=>a[k]!==undefined&&!positive(a[k]))
      || ['showTitle','showHeaders'].some(k=>a[k]!==undefined&&typeof a[k]!=='boolean')) return null;
  const widths=b.columnWidths;
  if(widths!==undefined && (!Array.isArray(widths)||!widths.length||widths.length>200||Object.keys(a).length
      ||widths.some((v:unknown)=>{const x=object(v);return Object.keys(x).some(k=>!['field','widthFeet'].includes(k))
        ||typeof x.field!=='string'||!x.field.trim()||x.field.length>256||typeof x.widthFeet!=='number'||!Number.isFinite(x.widthFeet)||x.widthFeet<=0||x.widthFeet>100;})
      ||new Set(widths.map((v:any)=>v.field.trim().toLowerCase())).size!==widths.length))return null;
  const order=b.fieldOrder;
  if (order!==undefined && (!Array.isArray(order)||!order.length||order.length>200
      || order.some(n=>!Number.isSafeInteger(n)||n<0)||new Set(order).size!==order.length)) return null;
  return {scheduleId:b.scheduleId,fieldOrder:order as number[]|undefined,appearance:a,columnWidths:widths as Array<{field:string;widthFeet:number}>|undefined};
}
function matches(wanted:NonNullable<ReturnType<typeof regularSchedulePresentationRequestV2>>, value:unknown) {
  const p=object(value);
  if(p.schema!=='operator.regular_schedule_presentation.v1'||p.complete!==true) return false;
  if(wanted.fieldOrder&&!equal(wanted.fieldOrder,p.fieldOrder))return false;
  for(const [key,part] of [['titleTextTypeId','title'],['headerTextTypeId','header'],['bodyTextTypeId','body']])
    if(wanted.appearance[key!]!==undefined && (object(p[part!]).id!==wanted.appearance[key!]
      || typeof object(p[part!]).uniqueId!=='string'||!object(p[part!]).uniqueId))return false;
  return ['showTitle','showHeaders'].every(k=>wanted.appearance[k]===undefined||p[k]===wanted.appearance[k]);
}
function widthsMatch(w:NonNullable<ReturnType<typeof regularSchedulePresentationRequestV2>>, applied:Record<string,any>, fresh:Record<string,any>, uid:string) {
  if(!w.columnWidths)return true;
  const b=definition(applied.definitionBefore,w.scheduleId,uid),p=definition(applied.definitionAfter,w.scheduleId,uid),n=definition(fresh.definition,w.scheduleId,uid);
  if(!b||!p||!n||!equal(p.value,n.value)||p.value.configurationHash!==b.value.configurationHash||p.value.categoryId!==b.value.categoryId
      ||b.fields.size!==p.fields.size||!equal(p.value.fieldOrder,w.fieldOrder??b.value.fieldOrder))return false;
  const targets=new Map<number,number>();
  for(const width of w.columnWidths){
    const matches=[...b.fields.values()].filter(f=>f.attributes.name.trim().toLowerCase()===width.field.trim().toLowerCase());
    if(matches.length!==1||targets.has(matches[0]!.fieldId))return false;
    targets.set(matches[0]!.fieldId,width.widthFeet);
  }
  for(const [id,old] of b.fields){
    const post=p.fields.get(id);if(!post||post.isHidden!==old.isHidden)return false;
    if(!targets.has(id)){if(!equal(post,old))return false;continue;}
    const {gridWidthFeet:oldGrid,sheetWidthFeet:oldSheet,...oldAttributes}=old.attributes;
    const {gridWidthFeet:grid,sheetWidthFeet:sheet,...attributes}=post.attributes;
    const width=targets.get(id)!;
    if(!equal(oldAttributes,attributes)||Math.abs(grid-width)>1e-8||Math.abs(sheet-width)>1e-8)return false;
  }
  return true;
}

export function regularSchedulePresentationReadbackMatchesV2(input:unknown,appliedPayload:unknown,freshPayload:unknown):boolean {
  if(Object.hasOwn(object(object(input).body??input),'combinedField'))return scheduleCombinedFieldReadbackMatchesV2(input,appliedPayload,freshPayload);
  const w=regularSchedulePresentationRequestV2(input),a=object(appliedPayload),r=object(freshPayload),s=object(a.schedule),rs=object(r.schedule),tx=object(a.transaction);
  if(!w||a.status!=='Success'||a.dryRun!==false||r.status!=='Ok'||r.action!=='presentation'||r.read_only!==true||s.id!==w.scheduleId||rs.id!==w.scheduleId
    ||typeof s.uniqueId!=='string'||!s.uniqueId||rs.uniqueId!==s.uniqueId||rs.kind!=='schedule'
    ||tx.committed!==true||tx.rolledBack===true||tx.pending===true||object(a.changeTracking).exhaustiveChangeInventory!==true
    || !regularSchedulePresentationScopeMatchesV2(w.scheduleId,s.uniqueId,a,r)
    ||!matches(w,a.presentationReadback)||!matches(w,r.presentation)||!widthsMatch(w,a,r,s.uniqueId))return false;
  return styleKeys.every(k=>w.appearance[k]===undefined || (()=>{const part=k.replace('TextTypeId','');
    return object(object(a.presentationReadback)[part]).uniqueId===object(object(r.presentation)[part]).uniqueId;})());
}

function settledApply(snapshot: AssignmentSnapshotV2, op: OperationV2) {
  const r = op.result, wanted = regularSchedulePresentationRequestV2(op.input) ?? scheduleCombinedFieldRequestV2(op.input);
  if (!wanted || snapshot.unresolved_unknown_operation_ids.length || snapshot.input_invalidated_operation_ids?.includes(op.operation_id)
      || !sameAssignmentBindingV2(op.binding,snapshot.current_binding) || op.request_identity?.path !== '/revit/configure-schedule'
      || op.input.path !== op.request_identity.path || op.input.method !== 'POST' || op.requested_effect !== 'apply'
      || op.admission_state !== 'admitted' || op.dispatch_state !== 'dispatched' || op.settlement_state !== 'settled' || op.persistent_effect !== 'applied'
      || !r || r.authority !== 'native-host' || r.status !== 'succeeded' || r.dispatch_state !== 'dispatched' || r.native_transaction_state !== 'committed' || r.persistent_effect !== 'applied'
      || !sameAssignmentBindingV2(r.binding,op.binding) || r.operation_id !== op.operation_id
      || r.request_identity?.request_signature !== op.request_identity.request_signature || !r.native_correlation_id || !r.receipt_id
      || !Number.isFinite(Date.parse(r.completed_at)) || !Array.isArray(r.affected_target_identities)
      || !r.affected_target_identities.includes('element_id:'+wanted.scheduleId)) return null;
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

export function committedRegularSchedulePresentationReadbackPlanV2(snapshot: AssignmentSnapshotV2, op: OperationV2) {
  const wanted = settledApply(snapshot,op);
  if (!wanted || snapshot.terminal || snapshot.outcome !== 'active' || snapshot.completion_proposal || snapshot.execution_control?.state === 'paused'
      || op.verification_operation_ids.length || appliedOperationHasVerifiedPostconditionV2(snapshot,op.operation_id)) return null;
  return {method:'POST',path:'/revit/schedules',body:{action:'presentation',scheduleId:wanted.scheduleId}};
}

export function regularSchedulePresentationPostconditionSatisfiedV2(snapshot: AssignmentSnapshotV2, op: OperationV2, read: OperationResultV2, payload: unknown) {
  const wanted = settledApply(snapshot,op);
  if (!wanted || read.authority !== 'native-host' || read.status !== 'succeeded' || read.dispatch_state !== 'dispatched' || read.persistent_effect !== 'none'
      || read.native_transaction_state !== 'not_applicable' || !sameAssignmentBindingV2(read.binding,snapshot.current_binding) || read.request_identity?.method !== 'POST' || read.request_identity.path !== '/revit/schedules'
      || !read.request_identity.request_signature || !read.native_correlation_id || !read.receipt_id
      || !Number.isFinite(Date.parse(read.completed_at)) || Date.parse(read.completed_at) <= Date.parse(op.result!.completed_at)
      || payloadDigestV2(payload).digest !== read.raw_payload_hash) return false;
  const readOp = snapshot.operations[read.operation_id], b = object(readOp?.input.body);

  // The observation comparator runs before its result is appended. The
  // admitted read is then dispatching; its authoritative result must already
  // say dispatched above. A never-dispatched request is not evidence.
  if (!readOp || readOp.requested_effect !== 'read' || readOp.admission_state !== 'admitted'
      || !['dispatching','dispatched'].includes(readOp.dispatch_state)
      || readOp.input.path !== read.request_identity.path || readOp.input.method !== 'POST'
      || readOp.purpose !== 'verification' || readOp.verification_of_operation_id !== op.operation_id
      || snapshot.input_invalidated_operation_ids?.includes(readOp.operation_id)
      || !Number.isFinite(Date.parse(readOp.opened_at)) || Date.parse(readOp.opened_at) < Date.parse(op.result!.completed_at)
      || Date.parse(read.completed_at) < Date.parse(readOp.opened_at)
      || !sameAssignmentBindingV2(readOp.binding,read.binding) || readOp.request_identity?.request_signature !== read.request_identity.request_signature
      || !equal(b,{action:'presentation',scheduleId:wanted.scheduleId})) return false;
  const applied=retainedApply(snapshot,op);
  return regularSchedulePresentationInventoryMatchesV2(applied,op.result!.affected_target_identities)
    && regularSchedulePresentationReadbackMatchesV2(op.input,applied,payload);
}
