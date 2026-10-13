import {committedCircuitReadbackPlanV2} from '../src/verification/circuit_membership_postcondition_v2.js';
export function circuitFixture(mode:'source'|'create'|'move'){
 const body:any={elementIds:[22,23],dryRun:false,confirm:true,panelElementId:40,expectedCircuitNumber:'2'};
 if(mode==='source')body.sourceElementId=21;
 else if(mode==='create'){body.createSystemType='PowerCircuit';body.targetPanelSlotNumber=2;}
 else {body.electricalSystemId=30;body.targetPanelSlotNumber=2;}
 const binding:any={assignment_id:'circuit-test',run_id:'run',generation:1,session_id:'session',principal_id:'local',document_fingerprint:'model'};
 const identity:any={path:'/revit/assign-electrical-circuit',method:'POST',request_signature:'signature'};
 const operation:any={operation_id:'apply',binding,input:{method:'POST',path:identity.path,body},request_identity:identity,
  admission_state:'admitted',dispatch_state:'dispatched',settlement_state:'settled',requested_effect:'apply',persistent_effect:'applied',
  verification_operation_ids:[],opened_at:'2026-10-13T00:00:00Z',result:{operation_id:'apply',binding,status:'succeeded',authority:'native-host',
   native_transaction_state:'committed',persistent_effect:'applied',request_identity:identity,completed_at:'2026-10-13T00:00:01Z',
   affected_target_identities:['element_id:30','element_id:22','element_id:23']}};
 const snapshot:any={terminal:false,outcome:'active',current_binding:binding,unresolved_unknown_operation_ids:[],operations:{apply:operation},observations:{}};
 const plan=committedCircuitReadbackPlanV2(snapshot,operation)!;
 const members=mode==='source'?[21,22,23]:[22,23];
 const unique=(id:number)=>`native-element-unique-${id}`;
 const circuit:any={systemElementId:30,systemUniqueId:unique(30),systemType:'PowerCircuit',complete:true,
  memberElementIds:members,memberIdentities:members.map(elementId=>({elementId,uniqueId:unique(elementId)})),
  panelElementId:40,panelUniqueId:unique(40),circuitNumber:'2',trueLoadInternal:100,apparentLoadInternal:100,
  inspectedPanelSlotNumber:mode==='source'?null:2,panelSlots:mode==='source'?[]:[{scheduleElementId:50,scheduleUniqueId:unique(50),panelElementId:40,slotNumber:2,cells:[{row:1,column:1,electricalSystemId:30}]}]};
 const payload:any={schema:'operator.electrical_membership_read.v1',complete:true,requestedElementIds:plan.body.elementIds,
  items:plan.body.elementIds.map((id:number)=>({id,found:true,uniqueId:unique(id),fullClassName:id===30?'Autodesk.Revit.DB.Electrical.ElectricalSystem':'Autodesk.Revit.DB.FamilyInstance',
   electricalCircuitMembership:{schema:'operator.electrical_membership_summary.v1',complete:true,kind:id===30?'electrical_system':'family_instance',powerSystemIds:[30]}})),circuits:[circuit]};
 return {body,operation,snapshot,plan,payload};
}
