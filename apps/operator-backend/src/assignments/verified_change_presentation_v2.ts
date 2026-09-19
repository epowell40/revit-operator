import {payloadDigestV2} from '@revitoperator/payload-digest-v2';
import {readAuthoritativeEvidence,readEvidenceRef} from '../evidence/evidence_store.js';
import {sameAssignmentBindingV2,type AssignmentSnapshotV2} from '../domain/assignment-kernel/index.js';
import {appliedOperationHasVerifiedPostconditionV2} from '../domain/assignment-kernel/outcome.js';
import {verifiedNativeWorkTargetIdentitiesV2} from '../domain/assignment-kernel/verified_work_targets.js';

const row=(v:unknown):Record<string,any>=>v&&typeof v==='object'&&!Array.isArray(v)?v as Record<string,any>:{};
const label=(v:unknown)=>typeof v==='string'?v.replace(/[\r\n\u0000-\u001f]/g,' ').trim().slice(0,120):'';

/** A concise account of verified native edits, not a drawing-fidelity claim.
 * Never infer deliverables from requested names or incidental transaction IDs. */
export function verifiedChangePresentationV2(snapshot:AssignmentSnapshotV2):string|null {
 const labels=new Map<number,string>();
 for(const applied of Object.values(snapshot.operations)){
  const result=applied.result;
  if(!result||result.status!=='succeeded'||result.authority!=='native-host'||result.native_transaction_state!=='committed'
   ||!sameAssignmentBindingV2(applied.binding,snapshot.current_binding)||!sameAssignmentBindingV2(result.binding,snapshot.current_binding)
   ||!Number.isFinite(Date.parse(result.completed_at))
   ||snapshot.input_invalidated_operation_ids?.includes(applied.operation_id)||!appliedOperationHasVerifiedPostconditionV2(snapshot,applied.operation_id))continue;
  const targets=new Set(verifiedNativeWorkTargetIdentitiesV2(snapshot,applied.operation_id));
  for(const readId of applied.verification_operation_ids){
   const read=snapshot.operations[readId],rr=read?.result;
   if(!read||!rr||read.verification_of_operation_id!==applied.operation_id||read.purpose!=='verification'||read.requested_effect!=='read'
    ||read.settlement_state!=='settled'||read.persistent_effect!=='none'||rr.status!=='succeeded'||rr.authority!=='native-host'
    ||!sameAssignmentBindingV2(read.binding,snapshot.current_binding)||!sameAssignmentBindingV2(rr.binding,snapshot.current_binding)
    ||!Number.isFinite(Date.parse(rr.completed_at))||Date.parse(rr.completed_at)<Date.parse(result.completed_at)
    ||!['/revit/get-element-summary','/revit/get-parameters','/revit/get-connectors'].includes(read.request_identity?.path??''))continue;
   for(const oid of read.observation_ids){
    const o=snapshot.observations[oid];
    if(!o||o.operation_id!==readId||o.authority!=='native-host'||o.evidence_class!=='verification'
     ||!sameAssignmentBindingV2(o.binding,snapshot.current_binding)||o.raw_payload_hash!==rr.raw_payload_hash)continue;
    let payload:Record<string,any>;
    try{const ref=readEvidenceRef(o.raw_payload_ref.replace(/^evidence:/,''));
     payload=row(JSON.parse(readAuthoritativeEvidence(ref,{...snapshot.current_binding,attempt_id:readId}).toString('utf8')));
     if(payloadDigestV2(payload).digest!==o.raw_payload_hash)continue;
    }catch{continue;}
    const rows=payload.result??payload.items??payload.results;
    if(!Array.isArray(rows))continue;
    for(const value of rows){const r=row(value),id=r.id;
     if(!Number.isSafeInteger(id)||id<=0||!targets.has(`element_id:${id}`)||r.found===false||r.error)continue;
     if(Object.values(snapshot.operations).some(other=>other.operation_id!==applied.operation_id&&other.requested_effect==='apply'
      &&['applied','unknown'].includes(other.persistent_effect)&&Date.parse(other.result?.completed_at??other.opened_at)>Date.parse(rr.completed_at)
      &&(other.result?.affected_target_identities?.includes(`element_id:${id}`)||other.persistent_effect==='unknown')))continue;
     const category=label(r.category),kind=category==='Ducts'?'duct segment':category==='Duct Fittings'?'duct fitting'
      :category==='Mechanical Equipment'||category==='Air Terminals'?label(r.typeName)||label(r.familyName)||category.toLowerCase():'';
     if(kind)labels.set(id,kind);
    }
   }
  }
 }
 if(!labels.size)return null;
 const counts=new Map<string,number>();for(const name of labels.values())counts.set(name,(counts.get(name)??0)+1);
 return 'Verified in Revit: '+[...counts].slice(0,8).map(([name,n])=>`${n} ${name}${n!==1&&['duct segment','duct fitting'].includes(name)?'s':''}`).join('; ')+'.';
}

export function remainingWorkPresentationV2(snapshot:AssignmentSnapshotV2):string|null {
 const pending=snapshot.work_plan?.items.filter(item=>!item.completed_at)??[];
 if(!pending.length)return null;
 return 'Still unfinished: '+pending.slice(0,3).map(item=>label(item.description)).join('; ')
  +(pending.length>3?`; plus ${pending.length-3} other planned items`:'')+'.';
}
