import type {AssignmentSnapshotV2,OperationV2} from '../domain/assignment-kernel/index.js';
import {canonicalJsonV2} from '../domain/assignment-kernel/index.js';
import {sameAssignmentBindingV2} from '../domain/assignment-kernel/identity.js';
import {appliedOperationHasVerifiedPostconditionV2} from '../domain/assignment-kernel/outcome.js';
import {nativeChildProjectionReferencesV2} from '../assignments/assignment_kernel_v2_child_projection.js';
type Row=Record<string,any>;
const row=(v:unknown):Row|null=>v&&typeof v==='object'&&!Array.isArray(v)?v as Row:null;
const positive=(v:unknown):v is number=>Number.isSafeInteger(v)&&Number(v)>0;
const ids=(v:unknown):number[]|null=>Array.isArray(v)&&v.length>0&&v.every(positive)&&new Set(v).size===v.length?[...v].sort((a,b)=>a-b):null;
const uid=(v:unknown)=>typeof v==='string'&&v.length>=10&&v.length<=120;
const parse=(v:unknown):unknown=>{if(typeof v!=='string'||v.length>1_000_000)return v;try{return JSON.parse(v);}catch{return v;}};

export function circuitAssignmentRequestV2(input:unknown):Row|null {
 const root=row(input),body=row(parse(root?.body??input));
 if(!body||!ids(body.elementIds)||body.elementIds.length>100||body.dryRun!==false||body.confirm!==true
  ||body.parameterOnlyFallback===true||body.panelName!=null||body.circuitNumber!=null)return null;
 const modes=[body.sourceElementId!=null,body.electricalSystemId!=null,body.createSystemType!=null].filter(Boolean).length;
 if(modes!==1||body.panelElementId!=null&&!positive(body.panelElementId)
  ||body.expectedCircuitNumber!=null&&(typeof body.expectedCircuitNumber!=='string'||!body.expectedCircuitNumber.trim()))return null;
 if(body.sourceElementId!=null){if(!positive(body.sourceElementId)||body.targetPanelSlotNumber!=null||body.electricalConnectorId!=null)return null;}
 else if(body.electricalSystemId!=null){if(!positive(body.electricalSystemId)||!positive(body.panelElementId)||!positive(body.targetPanelSlotNumber)||body.electricalConnectorId!=null)return null;}
 else if(body.createSystemType!=='PowerCircuit'||body.electricalConnectorId!=null&&(!Number.isSafeInteger(body.electricalConnectorId)||body.electricalConnectorId<0||body.elementIds.length!==1)
  ||body.targetPanelSlotNumber!=null&&(!positive(body.targetPanelSlotNumber)||!positive(body.panelElementId))
  ||body.expectedCircuitNumber!=null&&body.targetPanelSlotNumber==null)return null;
 return body;
}

function readTargets(body:Row):number[]{return [...new Set([...body.elementIds,...(body.sourceElementId?[body.sourceElementId]:[]),...(body.electricalSystemId?[body.electricalSystemId]:[])])].sort((a,b)=>a-b);}

export function committedCircuitReadbackPlanV2(snapshot:AssignmentSnapshotV2,operation:OperationV2){
 const r=operation.result,body=circuitAssignmentRequestV2(operation.input);
 if(!body||snapshot.terminal||snapshot.outcome!=='active'||snapshot.completion_proposal||snapshot.execution_control?.state==='paused'
  ||snapshot.unresolved_unknown_operation_ids.length||snapshot.input_invalidated_operation_ids?.includes(operation.operation_id)
  ||!sameAssignmentBindingV2(snapshot.current_binding,operation.binding)||operation.admission_state!=='admitted'
  ||operation.dispatch_state!=='dispatched'||operation.settlement_state!=='settled'||operation.requested_effect!=='apply'
  ||operation.persistent_effect!=='applied'||operation.request_identity?.path!=='/revit/assign-electrical-circuit'
  ||operation.input.method!=='POST'||operation.input.path!==operation.request_identity.path
  ||!r||r.status!=='succeeded'||r.authority!=='native-host'||r.native_transaction_state!=='committed'||r.persistent_effect!=='applied'
  ||r.operation_id!==operation.operation_id||!sameAssignmentBindingV2(r.binding,operation.binding)
  ||r.request_identity?.request_signature!==operation.request_identity.request_signature||!Number.isFinite(Date.parse(r.completed_at))
  ||operation.verification_operation_ids.length||appliedOperationHasVerifiedPostconditionV2(snapshot,operation.operation_id))return null;
 const targets=readTargets(body),affected=new Set([...(r.affected_target_identities??[]),...targets.map(id=>'element_id:'+id)]);
 if(Object.values(snapshot.operations).some(other=>other.operation_id!==operation.operation_id&&other.requested_effect==='apply'
  &&other.persistent_effect!=='none'&&other.opened_at>=operation.opened_at
  &&(other.result?.affected_target_identities?.some(id=>affected.has(id))
   ||[...(Array.isArray((other.input.body as any)?.elementIds)?(other.input.body as any).elementIds:[]),
    (other.input.body as any)?.sourceElementId,(other.input.body as any)?.electricalSystemId]
    .some(id=>positive(id)&&affected.has('element_id:'+id)))))return null;
 return {method:'POST',path:'/revit/get-element-summary',body:{elementIds:targets,includeElectricalCircuitMembership:true,
  ...(body.targetPanelSlotNumber!=null?{electricalPanelSlotNumber:body.targetPanelSlotNumber}:{})}};
}

export function committedTypedCircuitReadbackPlanV2(snapshot:AssignmentSnapshotV2,parent:OperationV2,mcpResult:unknown){
 const r=parent.result;
 if(parent.capability_id!=='revit_assign_electrical_circuit'||parent.operation_role!=='root'||parent.admission_state!=='admitted'
  ||parent.settlement_state!=='settled'||parent.requested_effect!=='apply'||parent.persistent_effect!=='none'
  ||!sameAssignmentBindingV2(snapshot.current_binding,parent.binding)||snapshot.input_invalidated_operation_ids?.includes(parent.operation_id)
  ||!circuitAssignmentRequestV2(parent.input)||!r||r.operation_id!==parent.operation_id||r.status!=='completed_without_native_dispatch'
  ||r.authority!=='operator-mcp-transport'||r.observation_required!==false||r.persistent_effect!=='none'||r.native_transaction_state!=='not_applicable'
  ||!sameAssignmentBindingV2(r.binding,parent.binding)||!parent.request_identity?.request_signature
  ||r.request_identity?.request_signature!==parent.request_identity.request_signature)return null;
 const references=nativeChildProjectionReferencesV2(snapshot,parent.operation_id,mcpResult);
 if(references.length!==1)return null;
 const child=snapshot.operations[references[0]!.operation_id];
 if(!child||child.opened_at<parent.opened_at||!child.result?.completed_at||!Number.isFinite(Date.parse(r.completed_at))
  ||Date.parse(child.result.completed_at)>Date.parse(r.completed_at)
  ||canonicalJsonV2(circuitAssignmentRequestV2(parent.input))!==canonicalJsonV2(circuitAssignmentRequestV2(child.input)))return null;
 const plan=committedCircuitReadbackPlanV2(snapshot,child);
 return plan?{operation_id:child.operation_id,plan}:null;
}

/** Exact requested native relationships, from a distinct complete element read.
 * Labels, mutation self-reports, echoed requests and partial enumerations never pass. */
export function circuitMembershipSatisfiedV2(applyInput:unknown,readInput:unknown,payload:unknown,affected:readonly string[]):boolean {
 const body=circuitAssignmentRequestV2(applyInput),read=row(readInput),readBody=row(parse(read?.body));
 if(!body||read?.method!=='POST'||read.path!=='/revit/get-element-summary'||readBody?.includeElectricalCircuitMembership!==true
  ||canonicalJsonV2(ids(readBody.elementIds))!==canonicalJsonV2(readTargets(body))
  ||(readBody.electricalPanelSlotNumber??null)!==(body.targetPanelSlotNumber??null))return false;
 let data=row(parse(payload));
 if(data?.schema!=='operator.electrical_membership_read.v1'){
  if(data?.isError===true||!Array.isArray(data?.content)||data.content.length!==1)return false;
  const block=row(data.content[0]);if(block?.type!=='text')return false;data=row(parse(block.text));}
 if(!data||data.schema!=='operator.electrical_membership_read.v1'||data.complete!==true||data.isError===true||data.error
  ||canonicalJsonV2(ids(data.requestedElementIds))!==canonicalJsonV2(readTargets(body))
  ||!Array.isArray(data.items)||data.items.length!==readTargets(body).length||!Array.isArray(data.circuits)||data.circuits.length!==1)return false;
 const items=new Map<number,Row>();
 for(const raw of data.items){const item=row(raw),membership=row(item?.electricalCircuitMembership);
  if(!item||!positive(item.id)||items.has(item.id)||!readTargets(body).includes(item.id)||item.found!==true||!uid(item.uniqueId)
   ||!membership||membership.schema!=='operator.electrical_membership_summary.v1'||membership.complete!==true
   ||!ids(membership.powerSystemIds)||membership.powerSystemIds.length!==1)return false;
  if(item.fullClassName!==(item.id===body.electricalSystemId?'Autodesk.Revit.DB.Electrical.ElectricalSystem':'Autodesk.Revit.DB.FamilyInstance'))return false;
  items.set(item.id,item);
 }
 const circuit=row(data.circuits[0]);
 if(!circuit||!positive(circuit.systemElementId)||!uid(circuit.systemUniqueId)||circuit.systemType!=='PowerCircuit'||circuit.complete!==true)return false;
 const members=ids(circuit.memberElementIds);
 if(!members||!Array.isArray(circuit.memberIdentities)||circuit.memberIdentities.length!==members.length
  ||canonicalJsonV2(ids(circuit.memberIdentities.map((m:any)=>m?.elementId)))!==canonicalJsonV2(members)
  ||circuit.memberIdentities.some((m:any)=>!uid(m?.uniqueId))||new Set(circuit.memberIdentities.map((m:any)=>m.uniqueId)).size!==members.length)return false;
 if(body.electricalSystemId!=null&&circuit.systemElementId!==body.electricalSystemId)return false;
 if(body.createSystemType!=null&&!affected.includes('element_id:'+circuit.systemElementId))return false;
 if(body.sourceElementId!=null){if(!members.includes(body.sourceElementId)||body.elementIds.some((id:number)=>!members.includes(id)))return false;}
 else if(canonicalJsonV2(members)!==canonicalJsonV2(ids(body.elementIds)))return false;
 if(body.panelElementId!=null&&circuit.panelElementId!==body.panelElementId||body.createSystemType!=null&&body.panelElementId==null&&circuit.panelElementId!==null)return false;
 if(circuit.panelElementId!=null&&(!positive(circuit.panelElementId)||!uid(circuit.panelUniqueId)))return false;
 if(typeof circuit.circuitNumber!=='string'||body.expectedCircuitNumber!=null&&circuit.circuitNumber.trim().toLowerCase()!==body.expectedCircuitNumber.trim().toLowerCase())return false;
 if(!Number.isFinite(circuit.trueLoadInternal)&&!Number.isFinite(circuit.apparentLoadInternal))return false;
 for(const item of items.values()){
  const membership=item.electricalCircuitMembership;
  if(membership.powerSystemIds[0]!==circuit.systemElementId)return false;
  const member=circuit.memberIdentities.find((m:any)=>m.elementId===item.id);
  if(item.id!==body.electricalSystemId&&member?.uniqueId!==item.uniqueId)return false;
  if(item.id===body.electricalSystemId&&item.uniqueId!==circuit.systemUniqueId)return false;
 }
 if(body.targetPanelSlotNumber!=null){
  if(circuit.inspectedPanelSlotNumber!==body.targetPanelSlotNumber||!Array.isArray(circuit.panelSlots)||!circuit.panelSlots.length)return false;
  if(!circuit.panelSlots.some((s:any)=>positive(s?.scheduleElementId)&&uid(s.scheduleUniqueId)&&s.panelElementId===body.panelElementId
   &&s.slotNumber===body.targetPanelSlotNumber&&Array.isArray(s.cells)&&s.cells.some((c:any)=>Number.isInteger(c.row)&&Number.isInteger(c.column)&&c.electricalSystemId===circuit.systemElementId)))return false;
 }
 return true;
}
