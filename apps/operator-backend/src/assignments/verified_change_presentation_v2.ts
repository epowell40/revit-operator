import {payloadDigestV2} from '@revitoperator/payload-digest-v2';
import {readAuthoritativeEvidence,readEvidenceRef} from '../evidence/evidence_store.js';
import {sameAssignmentBindingV2,type AssignmentSnapshotV2} from '../domain/assignment-kernel/index.js';
import {appliedOperationHasVerifiedPostconditionV2} from '../domain/assignment-kernel/outcome.js';
import {verifiedNativeWorkTargetIdentitiesV2} from '../domain/assignment-kernel/verified_work_targets.js';
import {advisoryVerificationV2} from '../domain/assignment-kernel/execution_policy.js';
import {retainedWorkFollowupLinesV2} from './work_review_handoff.js';
import {nativeInspectionTargetIdsV2} from './native_inspection_coverage.js';
import {regularScheduleFieldDefinitionV2} from '../verification/regular_schedule_field_definition_v2.js';

const row=(v:unknown):Record<string,any>=>v&&typeof v==='object'&&!Array.isArray(v)?v as Record<string,any>:{};
const label=(v:unknown)=>typeof v==='string'?v.replace(/[\r\n\u0000-\u001f]/g,' ').trim().slice(0,120):'';

/** Presentation of actual typed native values only. Caller still needs the
 * admitted paired verification; request values alone never become results. */
export function scheduleWidthPresentationV2(input:unknown,payload:unknown):string[] {
 const body=row(row(input).body),p=row(payload),schedule=row(p.schedule);
 if(!Array.isArray(body.fieldFormats)||body.fieldFormats.length>8||body.scheduleId!==schedule.id)return [];
 const definition=regularScheduleFieldDefinitionV2(p.definition,schedule.id,schedule.uniqueId);
 if(!definition)return [];
 const lines:string[]=[];
 for(const f of body.fieldFormats){if(typeof f?.field!=='string'||typeof f.widthFeet!=='number'||!Number.isFinite(f.widthFeet)||f.widthFeet<=0)continue;
  const matches=[...definition.fields.values()].filter(v=>v.attributes.name.trim().toLowerCase()===f.field.trim().toLowerCase());
  if(matches.length!==1)continue;const a=matches[0]!.attributes;
  if(Math.abs(a.sheetWidthFeet-f.widthFeet)>1e-8||Math.abs(a.gridWidthFeet-f.widthFeet)>1e-8)continue;
  lines.push(`${label(a.name)} column width: ${Number((a.sheetWidthFeet*12).toFixed(6))} inches`);
 }
 return lines;
}

/** A concise account of verified native edits, not a drawing-fidelity claim.
 * Never infer deliverables from requested names or incidental transaction IDs. */
export function verifiedChangePresentationV2(snapshot:AssignmentSnapshotV2):string|null {
 const labels=new Map<number,string>();
 const widths=new Map<number,string[]>();
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
    ||!['/revit/get-element-summary','/revit/find-text-notes','/revit/get-parameters','/revit/get-connectors','/revit/schedules'].includes(read.request_identity?.path??''))continue;
   for(const oid of read.observation_ids){
    const o=snapshot.observations[oid];
    if(!o||o.operation_id!==readId||o.authority!=='native-host'||o.evidence_class!=='verification'
     ||!sameAssignmentBindingV2(o.binding,snapshot.current_binding)||o.raw_payload_hash!==rr.raw_payload_hash)continue;
    let payload:Record<string,any>;
    try{const ref=readEvidenceRef(o.raw_payload_ref.replace(/^evidence:/,''));
     payload=row(JSON.parse(readAuthoritativeEvidence(ref,{...snapshot.current_binding,attempt_id:readId}).toString('utf8')));
     if(payloadDigestV2(payload).digest!==o.raw_payload_hash)continue;
    }catch{continue;}
    const typedNotes=read.request_identity?.path==='/revit/find-text-notes';
    if(typedNotes&&!nativeInspectionTargetIdsV2(read.input,payload))continue;
    const typedSchedule=read.request_identity?.path==='/revit/schedules'
     &&applied.request_identity?.path==='/revit/configure-schedule'
     &&payload.status==='Ok'&&payload.read_only===true&&payload.schedule?.kind==='schedule'
     &&payload.presentation?.schema==='operator.regular_schedule_presentation.v1'&&payload.presentation.complete===true;
    if(typedSchedule&&snapshot.terminal&&snapshot.outcome==='complete') {
      const values=scheduleWidthPresentationV2(applied.input,payload);
      if(values.length)widths.set(payload.schedule.id,values);
    }
    const rows=typedSchedule?[payload.schedule]:payload.result??payload.items??payload.results;
    if(!Array.isArray(rows))continue;
    for(const value of rows){const r=row(value),id=typedNotes?r.elementId:r.id;
     if(!Number.isSafeInteger(id)||id<=0||!targets.has(`element_id:${id}`)||r.found===false||r.error)continue;
     if(Object.values(snapshot.operations).some(other=>other.operation_id!==applied.operation_id&&other.requested_effect==='apply'
      &&['applied','unknown'].includes(other.persistent_effect)&&Date.parse(other.result?.completed_at??other.opened_at)>Date.parse(rr.completed_at)
      &&(other.result?.affected_target_identities?.includes(`element_id:${id}`)||other.persistent_effect==='unknown')))continue;
     // A category is shared by definitions, types and instances. Parameter-only
     // rows do not establish class identity and must not imply a placed tag.
     // The existing connector projection omits className. Actual complete,
     // nonempty native connectors still establish an MEP instance, unlike a
     // parameter/category row or a loaded type with no project connectors.
     const connectorInstance=read.request_identity?.path==='/revit/get-connectors'&&r.ok===true
      &&r.connectorScanTruncated===false&&Array.isArray(r.connectors)&&r.connectors.length>0
      &&r.connectorCount===r.connectors.length&&r.returnedConnectorCount===r.connectors.length;
     const parameterUpdate=read.request_identity?.path==='/revit/get-parameters'
      &&applied.request_identity?.path==='/revit/set-parameter'&&typeof r.uniqueId==='string'&&!!r.uniqueId
      &&Array.isArray(r.parameterDetails)&&r.parameterDetails.length>0&&r.parameterDetails.every((p:unknown)=>typeof row(p).name==='string'&&!row(p).error);
     const category=label(r.category),className=typedNotes?'TextNote':label(r.className).split('.').at(-1),unclassifiedMepInstance=!className&&connectorInstance,
      kind=typedSchedule?'schedule':parameterUpdate?'element with updated parameters':className==='TextNote'?'text note'
      :className==='Family'?'family definition'
      :className==='FamilySymbol'?'family type'
      :className==='ElementType'||className?.endsWith('Type')?'element type'
      :['IndependentTag','RoomTag','SpaceTag','AreaTag'].includes(className??'')?'annotation tag'
      :(className==='Duct'||unclassifiedMepInstance)&&['Ducts','OST_DuctCurves'].includes(category)?'duct segment'
      :(className==='FamilyInstance'||unclassifiedMepInstance)&&['Duct Fittings','OST_DuctFitting'].includes(category)?'duct fitting'
      :(className==='FamilyInstance'||unclassifiedMepInstance)&&['Mechanical Equipment','Air Terminals','OST_MechanicalEquipment','OST_DuctTerminal'].includes(category)
        ?label(r.typeName)||label(r.familyName)||category.toLowerCase():'';
     if(kind)labels.set(id,kind);
    }
   }
  }
 }
 if(!labels.size)return null;
 const counts=new Map<string,number>();for(const name of labels.values())counts.set(name,(counts.get(name)??0)+1);
 return 'Verified in Revit: '+[...counts].slice(0,8).map(([name,n])=>`${n} ${name==='element with updated parameters'&&n!==1?'elements with updated parameters':name}${n!==1&&['text note','duct segment','duct fitting','annotation tag','family definition','family type','element type','schedule'].includes(name)?'s':''}`).join('; ')+'.'
   +([...widths.values()].flat().length?'\n'+[...widths.values()].flat().slice(0,8).join('; ')+'.':'');
}

export function remainingWorkPresentationV2(snapshot:AssignmentSnapshotV2):string|null {
 const pending=snapshot.work_plan?.items.filter(item=>!item.completed_at)??[];
 if(!pending.length)return null;
 const followups=retainedWorkFollowupLinesV2(snapshot);
 return (advisoryVerificationV2(snapshot)?'Saved checklist status still needs review: ':'Still unfinished: ')+pending.slice(0,3).map(item=>label(item.description)).join('; ')
  +(pending.length>3?`; plus ${pending.length-3} other planned items`:'')+'.'
  +(followups.length?'\n\nSaved questions and open items (not completed work):\n'+followups.slice(0,3).map(line=>'- '+line).join('\n')
    +(followups.length>3?`\n${followups.length-3} more saved follow-ups remain in Tasks.`:''):'');
}
