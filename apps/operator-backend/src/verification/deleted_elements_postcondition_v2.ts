import {payloadDigestV2}from '@revitoperator/payload-digest-v2';
import {readAuthoritativeEvidence,readEvidenceRef}from '../evidence/evidence_store.js';
import {sameAssignmentBindingV2,canonicalJsonV2,type AssignmentSnapshotV2,type OperationV2,type OperationResultV2}from '../domain/assignment-kernel/index.js';
import {appliedOperationHasVerifiedPostconditionV2}from '../domain/assignment-kernel/outcome.js';
import {nativePropertyReadIsFreshNativeV2}from '../assignments/native_observation_inputs_v2.js';
import {nativeChangeInventoryCompleteV2}from './native_change_inventory_v2.js';
import {deletionClosureV2,nativeAbsentElementIdsV2,NATIVE_ELEMENT_LOOKUP_V2}from './deletion_contract_v2.js';

function retained(snapshot:AssignmentSnapshotV2,op:OperationV2){for(const id of op.observation_ids){const o=snapshot.observations[id];
  if(!o||o.authority!=='native-host'||o.operation_id!==op.operation_id||o.raw_payload_hash!==op.result?.raw_payload_hash||!sameAssignmentBindingV2(o.binding,op.binding))continue;
  try{const ref=readEvidenceRef(o.raw_payload_ref.replace(/^evidence:/,''));if(ref.byte_count>1_000_000)continue;
    const payload=JSON.parse(readAuthoritativeEvidence(ref,{...op.binding,attempt_id:op.operation_id}).toString('utf8'));
    if(payloadDigestV2(payload).digest===op.result?.raw_payload_hash)return payload;
  }catch{/* No missing receipt can justify replaying a committed deletion. */}
}return null;}

function subject(snapshot:AssignmentSnapshotV2,op:OperationV2){const r=op.result;
  if(snapshot.unresolved_unknown_operation_ids.length||snapshot.input_invalidated_operation_ids?.includes(op.operation_id)
    ||!sameAssignmentBindingV2(snapshot.current_binding,op.binding)||op.input.method!=='POST'||op.input.path!==op.request_identity?.path
    ||op.requested_effect!=='apply'||op.admission_state!=='admitted'||op.dispatch_state!=='dispatched'||op.settlement_state!=='settled'||op.persistent_effect!=='applied'
    ||!r||r.status!=='succeeded'||r.authority!=='native-host'||r.native_transaction_state!=='committed'||r.persistent_effect!=='applied'||r.dispatch_state!=='dispatched'
    ||r.operation_id!==op.operation_id||!sameAssignmentBindingV2(r.binding,op.binding)||!r.receipt_id||!r.native_correlation_id
    ||!op.request_identity?.request_signature||r.request_identity?.request_signature!==op.request_identity.request_signature
    ||!Number.isFinite(Date.parse(r.completed_at))
    ||Object.values(snapshot.operations).some(o=>o.requested_effect==='apply'&&(o.persistent_effect==='unknown'||snapshot.in_flight_operation_ids.includes(o.operation_id))))return null;
  const payload=retained(snapshot,op);if(payload===null)return null;
  return deletionClosureV2(op.input,payload,r.affected_target_identities??[],nativeChangeInventoryCompleteV2(op,r,payload));
}

export function deletionReadbackPlansForIdsV2(ids:readonly number[]){
  const plans=[];
  // The native API has a real sixteen-operation limit; do not generate an
  // oversized read or confuse one successful chunk with the complete closure.
  for(let i=0;i<ids.length;i+=16){const operations=ids.slice(i,i+16).map((id,index)=>({id:'absent'+index,op:'call',target:'doc',memberId:NATIVE_ELEMENT_LOOKUP_V2,args:[id]}));
    plans.push({method:'POST',path:'/revit/native-api-ops',body:{operations,returns:operations.map(o=>'$'+o.id)}});
  }return plans;
}

export function committedDeletedElementsReadbackPlansV2(snapshot:AssignmentSnapshotV2,op:OperationV2){
  if(snapshot.terminal||snapshot.outcome!=='active'||snapshot.completion_proposal||snapshot.execution_control?.state==='paused'
    ||snapshot.provider_usage_hold||snapshot.provider_budget_exhausted||op.verification_operation_ids.length
    ||appliedOperationHasVerifiedPostconditionV2(snapshot,op.operation_id))return null;
  const ids=subject(snapshot,op);return ids?deletionReadbackPlansForIdsV2(ids):null;
}

function fresh(snapshot:AssignmentSnapshotV2,op:OperationV2,r:OperationResultV2,payload:unknown){const read=snapshot.operations[r.operation_id];
  return Boolean(read&&read.purpose==='verification'&&read.fulfillment_role==='verification'&&read.verification_of_operation_id===op.operation_id
    &&read.admission_state==='admitted'&&['dispatching','dispatched'].includes(read.dispatch_state)&&read.input.method==='POST'
    &&read.input.path==='/revit/native-api-ops'&&r.request_identity?.path===read.input.path
    &&sameAssignmentBindingV2(read.binding,snapshot.current_binding)&&sameAssignmentBindingV2(r.binding,read.binding)
    &&!snapshot.input_invalidated_operation_ids?.includes(read.operation_id)&&r.dispatch_state==='dispatched'&&r.native_transaction_state==='not_applicable'
    &&!r.result_semantic_gap&&!r.error_code&&r.request_identity.method==='POST'
    &&r.receipt_id&&r.native_correlation_id&&nativePropertyReadIsFreshNativeV2(op,read,r)
    &&payloadDigestV2(payload).digest===r.raw_payload_hash);
}

/** Complete native absence only. This does not certify the user's choice of
 * elements, surviving layout or source interpretation; those have other checks. */
export function deletedElementsPostconditionSatisfiedV2(snapshot:AssignmentSnapshotV2,op:OperationV2,r:OperationResultV2,payload:unknown):boolean{
  const ids=subject(snapshot,op),current=snapshot.operations[r.operation_id];if(!ids||!current||!fresh(snapshot,op,r,payload))return false;
  const plans=deletionReadbackPlansForIdsV2(ids),key=(input:any)=>canonicalJsonV2(input.body??null),expected=new Map(plans.map(p=>[key(p),p]));
  const candidates=[{read:current,result:r,payload}];
  for(const id of op.verification_operation_ids){const read=snapshot.operations[id];
    if(!read||id===r.operation_id||read.settlement_state!=='settled'||!read.result||Date.parse(read.result.completed_at)>Date.parse(r.completed_at))continue;
    const p=retained(snapshot,read);if(p!==null&&fresh(snapshot,op,read.result,p))candidates.push({read,result:read.result,payload:p});
  }
  const chosen=new Map<string,typeof candidates[number]>();
  for(const item of candidates.sort((a,b)=>Date.parse(b.result.completed_at)-Date.parse(a.result.completed_at))){const k=key(item.read.input);
    if(expected.has(k)&&!chosen.has(k))chosen.set(k,item);
  }
  if(chosen.size!==plans.length||!chosen.has(key(current.input)))return false;
  const earliest=Math.min(...[...chosen.values()].map(c=>Date.parse(c.read.opened_at)));
  if(!Number.isFinite(earliest)||Object.values(snapshot.operations).some(o=>o.operation_id!==op.operation_id&&o.requested_effect==='apply'&&o.persistent_effect==='applied'
    &&Date.parse(o.result?.completed_at??'')>=earliest&&Date.parse(o.result?.completed_at??'')<=Date.parse(r.completed_at)))return false;
  const absent=new Set<number>();
  for(const item of chosen.values()){
    const values=nativeAbsentElementIdsV2(item.read.input,item.payload),planned=expected.get(key(item.read.input))!.body.operations.map(s=>s.args[0]);
    if(values.length!==planned.length||!planned.every(id=>values.includes(id)))return false;values.forEach(id=>absent.add(id));
  }
  return absent.size===ids.length&&ids.every(id=>absent.has(id));
}
