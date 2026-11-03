import type { AssignmentSnapshotV2, OperationV2 } from '../domain/assignment-kernel/index.js';
import { appliedOperationHasVerifiedPostconditionV2,verificationOperationHasVerifiedPostconditionV2 } from '../domain/assignment-kernel/outcome.js';
import {payloadDigestV2}from '@revitoperator/payload-digest-v2';
import {readAuthoritativeEvidence,readEvidenceRef}from '../evidence/evidence_store.js';
import { checkedEditIsCurrentV2 } from './current_postcondition_v2.js';
import { sameAssignmentBindingV2 } from '../domain/assignment-kernel/identity.js';
import { visibilityExpectedValuesV2 } from './visibility_view_contract_v2.js';
import { boundedScheduleFieldFormatsV2 } from './schedule_field_formats_v2.js';
import { boundedScheduleRowHeightsV2 } from './schedule_row_heights_v2.js';
import {vectorAnnotationCheckNeedsRefreshV2} from './vector_detail_import_v2.js';
import {vectorStrokeCadCheckNeedsRefreshV2} from './vector_stroke_cad_readback_v2.js';
import {committedNativeDetailLineRefreshPlanV2}from'./native_detail_line_graph_v2.js';
import {annotationPreservedScheduleAtCommitV2} from './native_annotation_postcondition_v2.js';
import {hasCompleteNativeChangeInventoryV2} from './native_change_inventory_v2.js';

const record=(v:unknown):Record<string,unknown>=>v&&typeof v==='object'&&!Array.isArray(v)?v as Record<string,unknown>:{};

/** An exact verified scalar edit may cause native schedule regeneration. It
 * permits a new independent presentation comparison, never preservation proof
 * or acceptance of intentionally changed table values against an old baseline. */
function verifiedScalarScheduleRefreshV2(snapshot:AssignmentSnapshotV2,op:OperationV2,scheduleId:number):boolean {
 const b=record(op.input.body),r=op.result,changes=b.changes;
 if(op.input.method!=='POST'||op.input.path!=='/revit/set-parameter'||op.request_identity?.path!==op.input.path
   ||op.request_identity.method!=='POST'||!(/^[a-f0-9]{64}$/i).test(op.request_identity.request_signature)
   ||!r||r.operation_id!==op.operation_id||r.request_identity?.request_signature!==op.request_identity.request_signature
   ||!r.receipt_id||!r.native_correlation_id||b.dryRun!==undefined&&b.dryRun!==false
   ||!Array.isArray(changes)||!changes.length||changes.length>100
   ||Object.keys(b).some(k=>!['changes','excludeElementIds','dryRun','apply'].includes(k))
   ||changes.some(c=>!c||typeof c!=='object'||Array.isArray(c)||!Number.isSafeInteger(c.elementId)||c.elementId<=0
     ||c.elementId===scheduleId||typeof c.parameterName!=='string'||!c.parameterName.trim()||c.parameterName.length>256||typeof c.value!=='string')
   ||!hasCompleteNativeChangeInventoryV2(snapshot,op)||!checkedEditIsCurrentV2(snapshot,op.operation_id))return false;
 return true;
}

/** Scheduling a new read never renews proof by itself. Only explicit disjoint
 * presentation edits are understood here; revised field values must not make
 * the worker restore an obsolete intermediate request. */
function fieldFormatRefreshIsApplicable(snapshot:AssignmentSnapshotV2,op:OperationV2,body:Record<string,unknown>):boolean {
  if(op.input.method!=='POST'||op.input.path!=='/revit/configure-schedule'||op.requested_effect!=='apply'
    ||!Number.isSafeInteger(body.scheduleId)||Number(body.scheduleId)<=0||body.dryRun!==undefined&&body.dryRun!==false
    ||!boundedScheduleFieldFormatsV2(body.fieldFormats)
    ||Object.keys(body).some(k=>!['scheduleId','fieldFormats','dryRun'].includes(k))
    ||snapshot.terminal||snapshot.outcome!=='active'||snapshot.completion_proposal
    ||snapshot.execution_control?.state==='paused'||snapshot.unresolved_unknown_operation_ids.length
    ||snapshot.in_flight_operation_ids.length||snapshot.input_invalidated_operation_ids?.includes(op.operation_id)
    ||!sameAssignmentBindingV2(snapshot.current_binding,op.binding))return false;
  const at=Date.parse(op.result?.completed_at??'');if(!Number.isFinite(at))return false;
  const later=Object.values(snapshot.operations).filter(other=>other.operation_id!==op.operation_id
    &&other.requested_effect==='apply'&&other.persistent_effect!=='none'
    &&sameAssignmentBindingV2(snapshot.current_binding,other.binding)
    &&(record(other.input.body).scheduleId===body.scheduleId
      ||other.result?.affected_target_identities?.includes('element_id:'+body.scheduleId))
    &&(!Number.isFinite(Date.parse(other.result?.completed_at??''))||Date.parse(other.result!.completed_at)>=at));
  return later.length>0&&later.every(other=>{
    // This schedules a fresh ordinary read; unchanged note collateral is not
    // promoted into a new width/style/value verification fact.
    if(annotationPreservedScheduleAtCommitV2(snapshot,other,Number(body.scheduleId)))return true;
    if(verifiedScalarScheduleRefreshV2(snapshot,other,Number(body.scheduleId)))return true;
    const next=record(other.input.body),appearance=record(next.appearance),r=other.result;
    return other.input.path==='/revit/configure-schedule'&&other.input.method==='POST'
      &&other.request_identity?.path===other.input.path&&typeof other.request_identity.request_signature==='string'&&!!other.request_identity.request_signature
      &&next.scheduleId===body.scheduleId&&(next.dryRun===undefined||next.dryRun===false)
      &&Object.keys(next).every(k=>['scheduleId','fieldOrder','appearance','rowHeights','dryRun'].includes(k))
      &&(Object.hasOwn(next,'fieldOrder')||Object.keys(appearance).length>0||Object.hasOwn(next,'rowHeights'))
      &&(!Object.hasOwn(next,'rowHeights')||!!boundedScheduleRowHeightsV2(next.rowHeights)&&Object.keys(next).every(k=>['scheduleId','rowHeights','dryRun'].includes(k)))
      &&(!Object.hasOwn(next,'fieldOrder')||Array.isArray(next.fieldOrder)&&next.fieldOrder.length>0&&next.fieldOrder.length<=200
        &&next.fieldOrder.every(id=>Number.isSafeInteger(id)&&Number(id)>=0)&&new Set(next.fieldOrder).size===next.fieldOrder.length)
      &&(!Object.hasOwn(next,'appearance')||next.appearance!==null&&typeof next.appearance==='object'&&!Array.isArray(next.appearance))
      &&Object.entries(appearance).every(([k,v])=>['titleTextTypeId','headerTextTypeId','bodyTextTypeId'].includes(k)
        ?Number.isSafeInteger(v)&&Number(v)>0:['showTitle','showHeaders'].includes(k)&&typeof v==='boolean')
      &&other.admission_state==='admitted'&&other.dispatch_state==='dispatched'&&other.settlement_state==='settled'&&other.persistent_effect==='applied'
      &&!snapshot.input_invalidated_operation_ids?.includes(other.operation_id)&&r?.authority==='native-host'&&r.status==='succeeded'
      &&r.operation_id===other.operation_id&&r.dispatch_state==='dispatched'&&r.native_transaction_state==='committed'
      &&r.persistent_effect==='applied'&&sameAssignmentBindingV2(r.binding,other.binding)&&Number.isFinite(Date.parse(r.completed_at))
      &&r.request_identity?.request_signature===other.request_identity?.request_signature
      &&!!r.receipt_id&&!!r.native_correlation_id;
  });
}

function visibilityProperty(op:OperationV2):string|null {
  if(op.request_identity?.path!=='/revit/visibility' || !visibilityExpectedValuesV2(op.input).length)return null;
  const action=(op.input.body as Record<string,unknown>).action;
  // Category labels and enum selectors can resolve to the same native category.
  // Treat all category edits as overlapping rather than guessing equivalence.
  return ({set_phase:'phase',set_phase_filter:'phaseFilter',set_scale:'scale',
    set_detail_level:'detailLevel',set_discipline:'discipline',set_category_override:'category'} as Record<string,string>)[String(action)]??null;
}

/** Renew evidence after another explicit, disjoint property edit on this view.
 * A newer request for the same property supersedes the old expected value;
 * input-invalidated intent must never become a request to restore old work. */
export function visibilityCheckNeedsRefreshV2(snapshot:AssignmentSnapshotV2,op:OperationV2):boolean {
  const property=visibilityProperty(op),body=op.input.body as Record<string,unknown>|undefined;
  if(!property || !body || snapshot.terminal || snapshot.outcome!=='active' || snapshot.completion_proposal
    || snapshot.execution_control?.state==='paused' || snapshot.unresolved_unknown_operation_ids.length
    || snapshot.in_flight_operation_ids.length || snapshot.input_invalidated_operation_ids?.includes(op.operation_id)
    || !sameAssignmentBindingV2(snapshot.current_binding,op.binding)
    || !appliedOperationHasVerifiedPostconditionV2(snapshot,op.operation_id) || checkedEditIsCurrentV2(snapshot,op.operation_id))return false;
  const later=Object.values(snapshot.operations).filter(other=>other.operation_id!==op.operation_id
    && other.requested_effect==='apply' && other.persistent_effect!=='none'
    && sameAssignmentBindingV2(snapshot.current_binding,other.binding)
    && (other.opened_at>op.opened_at || other.opened_at===op.opened_at
      && (other.settled_assignment_version??Infinity)>(op.settled_assignment_version??-Infinity))
    && ((other.input.body as Record<string,unknown>|undefined)?.viewId===body.viewId
      || other.result?.affected_target_identities?.includes('element_id:'+body.viewId)
      || other.target.target_id==='id:'+body.viewId));
  return later.length>0 && later.every(other=>{
    const next=visibilityProperty(other);
    return next!==null && next!==property && other.persistent_effect==='applied'
      && other.settlement_state==='settled' && !snapshot.input_invalidated_operation_ids?.includes(other.operation_id);
  });
}

export function committedCheckNeedsRefreshV2(snapshot:AssignmentSnapshotV2,op:OperationV2):boolean {
  return regularScheduleCheckNeedsRefreshV2(snapshot,op) || visibilityCheckNeedsRefreshV2(snapshot,op)||vectorAnnotationCheckNeedsRefreshV2(snapshot,op)||vectorStrokeCadCheckNeedsRefreshV2(snapshot,op)||!!committedDraftingIdentityRefreshPlanV2(snapshot,op)||!!committedNativeDetailLineRefreshPlanV2(snapshot,op);
}

/** Re-read a previously checked exact drafting identity at final save. This
 * schedules evidence only: it neither promotes the old check nor certifies
 * creation collateral, sheet placement, contents, typography or visual work. */
export function committedDraftingIdentityRefreshPlanV2(snapshot:AssignmentSnapshotV2,op:OperationV2){
 return draftingIdentityPlanV2(snapshot,op,true);
}
/** A first separate identity read, only before any verification attempt.
 * Failed or incomplete attempts are never automatically retried. */
export function committedDraftingIdentityReadbackPlanV2(snapshot:AssignmentSnapshotV2,op:OperationV2){
 return draftingIdentityPlanV2(snapshot,op,false);
}
function draftingIdentityPlanV2(snapshot:AssignmentSnapshotV2,op:OperationV2,refresh:boolean){
 const r=op.result,b=record(op.input.body);
 if(op.input.method!=='POST'||op.input.path!=='/revit/create-drafting-view'||op.request_identity?.path!==op.input.path
  ||typeof b.name!=='string'||!b.name.trim()||!Number.isSafeInteger(b.scale)||Number(b.scale)<1||b.allowExisting===true
  ||Object.keys(b).some(k=>!['name','scale','allowExisting'].includes(k))
  ||snapshot.terminal||snapshot.outcome!=='active'||snapshot.completion_proposal||snapshot.execution_control?.state==='paused'
  ||snapshot.in_flight_operation_ids.length||snapshot.unresolved_unknown_operation_ids.length
  ||snapshot.input_invalidated_operation_ids?.includes(op.operation_id)||!sameAssignmentBindingV2(op.binding,snapshot.current_binding)
  ||op.requested_effect!=='apply'||op.admission_state!=='admitted'||op.dispatch_state!=='dispatched'||op.settlement_state!=='settled'
  ||op.persistent_effect!=='applied'||!r||r.status!=='succeeded'||r.authority!=='native-host'||r.persistent_effect!=='applied'
  ||r.dispatch_state!=='dispatched'||r.native_transaction_state!=='committed'||r.operation_id!==op.operation_id
  ||!r.receipt_id||!r.native_correlation_id||!r.raw_payload_hash||!sameAssignmentBindingV2(r.binding,op.binding)
  ||!op.request_identity.request_signature||r.request_identity?.request_signature!==op.request_identity.request_signature
  ||!Number.isFinite(Date.parse(r.completed_at))||checkedEditIsCurrentV2(snapshot,op.operation_id)
  ||op.verification_operation_ids.length>64
  ||(refresh?!appliedOperationHasVerifiedPostconditionV2(snapshot,op.operation_id):op.verification_operation_ids.length!==0))return null;
 // Never retry a failed/mismatching or unfinished latest check automatically.
 const reads=op.verification_operation_ids.map(id=>snapshot.operations[id]);
 if(reads.some(read=>!read||!Number.isSafeInteger(read.admitted_assignment_version)))return null;
 const last=reads.sort((a,b)=>b!.admitted_assignment_version!-a!.admitted_assignment_version!)[0];
 if(refresh&&(!last||!verificationOperationHasVerifiedPostconditionV2(snapshot,last.operation_id)
  ||last.verification_of_operation_id!==op.operation_id||snapshot.input_invalidated_operation_ids?.includes(last.operation_id)
  ||last.input.method!=='POST'||last.input.path!=='/revit/get-element-summary'||last.result?.authority!=='native-host'
  ||last.result.dispatch_state!=='dispatched'||last.result.persistent_effect!=='none'||last.result.native_transaction_state!=='not_applicable'
  ||!sameAssignmentBindingV2(last.binding,op.binding)||!sameAssignmentBindingV2(last.result.binding,last.binding)
  ||!last.request_identity?.request_signature||last.result.request_identity?.request_signature!==last.request_identity.request_signature
  ||!last.result.raw_payload_hash||!last.result.receipt_id||!last.result.native_correlation_id
  ||!last.observation_ids.some(id=>{const o=snapshot.observations[id];return o?.operation_id===last.operation_id&&o.authority==='native-host'
    &&o.raw_payload_hash===last.result!.raw_payload_hash&&sameAssignmentBindingV2(o.binding,last.binding)
    &&o.facts.some(f=>f.fact_id==='verification.postcondition_satisfied'&&f.fact_class==='verification'&&f.value===true);} )))return null;
 for(const oid of op.observation_ids){const observed=snapshot.observations[oid];
  if(observed?.operation_id!==op.operation_id||observed.authority!=='native-host'||observed.raw_payload_hash!==r.raw_payload_hash
   ||!sameAssignmentBindingV2(observed.binding,op.binding))continue;
  try{const ref=readEvidenceRef(observed.raw_payload_ref.replace(/^evidence:/,''));if(ref.byte_count>2_000_000)continue;
   const payload=JSON.parse(readAuthoritativeEvidence(ref,{...op.binding,attempt_id:op.operation_id}).toString('utf8'));
   const tx=record(payload.transaction),readBody=record(last?.input.body);
   if(payloadDigestV2(payload).digest!==r.raw_payload_hash||payload.created!==true||payload.success!==true||payload.applied!==true
    ||payload.viewType!=='DraftingView'||payload.name!==b.name.trim()||payload.scale!==b.scale
    ||!Number.isSafeInteger(payload.viewId)||payload.viewId<=0||tx.status!=='committed'||tx.committed!==true||tx.pending===true||tx.rolled_back===true
    ||!Array.isArray(tx.added_element_ids)||!tx.added_element_ids.includes(payload.viewId)
    ||!Array.isArray(tx.deleted_element_ids)||tx.deleted_element_ids.length||!r.affected_target_identities?.includes('element_id:'+payload.viewId)
    ||refresh&&(Object.keys(readBody).length!==1||!Array.isArray(readBody.elementIds)||readBody.elementIds.length!==1||readBody.elementIds[0]!==payload.viewId))continue;
   return{method:'POST',path:'/revit/get-element-summary',body:{elementIds:[payload.viewId]}};
  }catch{/* Missing, changed or foreign retained evidence cannot schedule a read. */}
 }
 return null;
}

/** This is read scheduling only. The native comparator must independently
 * establish the full requested postcondition again; no prior fact is promoted. */
export function regularScheduleCheckNeedsRefreshV2(snapshot:AssignmentSnapshotV2, op:OperationV2):boolean {
  const b=op.input.body as Record<string,unknown>|undefined;
  return op.request_identity?.path==='/revit/configure-schedule'
    && Boolean(b && (Object.hasOwn(b,'fieldFormats')?fieldFormatRefreshIsApplicable(snapshot,op,b)
      :['fieldOrder','columnWidths','appearance','rowHeights','combinedField','filters','sortGroup','filterBySheet','isItemized','showGrandTotals'].some(k=>Object.hasOwn(b,k))))
    && appliedOperationHasVerifiedPostconditionV2(snapshot,op.operation_id)
    && !checkedEditIsCurrentV2(snapshot,op.operation_id);
}

export function operationNeedsReadbackV2(snapshot:AssignmentSnapshotV2,op:OperationV2):boolean {
  return !appliedOperationHasVerifiedPostconditionV2(snapshot,op.operation_id)
    || committedCheckNeedsRefreshV2(snapshot,op);
}
