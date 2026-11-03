import {payloadDigestV2} from '@revitoperator/payload-digest-v2';
type Row=Record<string,any>;
const equal=(a:unknown,b:unknown)=>payloadDigestV2(a).digest===payloadDigestV2(b).digest;
const finite=(v:any):v is number=>typeof v==='number'&&Number.isFinite(v)&&v>=0;
const close=(a:number,b:number)=>Math.abs(a-b)<=1e-9*Math.max(1,Math.abs(a),Math.abs(b));
export type NativeCalculatedFlowChange={elementId:number;uniqueId:string;connectorId:number;parameterId:number;before:number;after:number;assigned:number;units:'cubic_feet_per_second';displayVerified:false};

/** Additional input observations never replace the raw parameter records.
 * Legacy payloads retain their exact old comparison and gain no exemption. */
export function assignedConnectorInputsPreservedV2(before:Row,after:Row,immediate:Row):boolean{
 const arrays=[before?.assignedConnectorFlows,after?.assignedConnectorFlows,immediate?.assignedConnectorFlows];
 if(arrays.every(a=>a===undefined))return true;
 return arrays.every((a,i)=>Array.isArray(a)&&a.length<=512&&a.length===[before,after,immediate][i]?.state?.ports?.length
  &&new Set(a.map((p:Row)=>p.connectorId)).size===a.length&&a.every((p:Row)=>Number.isSafeInteger(p?.connectorId)&&p.connectorId>=0
   &&[before,after,immediate][i].state.ports.some((c:Row)=>c.id===p.connectorId)
   &&['observed','unavailable','not_applicable'].includes(p.observation?.status)))
  &&arrays[0].every((p:Row,index:number)=>{
   const values=arrays.map(a=>a[index]);
   if(equal(values[0],values[1])&&equal(values[0],values[2]))return true;
   // AssignedFlow is an API property name, not proof that its value is prescribed.
   // Only Calculated ports whose changed value equals the separate native Flow
   // observation in every phase qualify. Preset/System/Demand stay exact.
   if(!values.every(v=>v?.connectorId===p.connectorId))return false;
   const observations=values.map(v=>v.observation);
   if(!observations.every(o=>o?.status==='observed'&&['DomainHvac','DomainPiping'].includes(o.domain)
    &&o.configuration==='Calculated'&&['In','Out','Bidirectional'].includes(o.direction)
    &&o.units==='cubic_feet_per_second'&&o.meaning==='assigned_connector_inputs'&&finite(o.flow)))return false;
   const withoutFlow=observations.map(({flow,...rest}:Row)=>rest);
   if(!equal(withoutFlow[0],withoutFlow[1])||!equal(withoutFlow[0],withoutFlow[2])||!equal(values[1],values[2]))return false;
   return [before,after,immediate].every((owner,j)=>{
    const cs=owner.calculatedConnectorFlows;
    if(!Array.isArray(cs)||cs.length!==owner.state.ports.length||cs.length>512
     ||new Set(cs.map((c:Row)=>c.connectorId)).size!==cs.length
     ||!cs.every((c:Row)=>Number.isSafeInteger(c?.connectorId)&&c.connectorId>=0&&owner.state.ports.some((p:Row)=>p.id===c.connectorId)))return false;
    const c=cs.find((c:Row)=>c.connectorId===p.connectorId)?.observation;
    return c?.status==='observed'&&c.units==='cubic_feet_per_second'
     &&c.meaning==='calculated_output_not_prescribed_input'&&finite(c.value)&&close(c.value,observations[j].flow);
   });
  });
}

function parameter(owner:Row){
 const ps=JSON.parse(owner.state.parameters),full=owner.parameters;
 if(!Array.isArray(ps)||!Array.isArray(full)||ps.length>2048||full.length>512)return null;
 const matches=ps.filter((p:Row)=>p.id===-1013405),native=full.filter((p:Row)=>p.id===-1013405);
 if(matches.length!==1||native.length!==1)return null;
 const p=matches[0],n=native[0],value=typeof p.value==='string'&&p.value.trim()?Number(p.value):NaN;
 if(p.storage!=='Double'||n.storage!=='Double'||n.readOnly!==false||n.value!==p.value||!finite(value))return null;
 return {value,state:{...owner.state,parameters:JSON.stringify(ps.filter((p:Row)=>p.id!==-1013405))}};
}
function facts(owner:Row,row:Row){
 if(row?.id!==owner?.elementId||row.category!=='OST_DuctTerminal'||!Array.isArray(row.connectors)||row.connectors.length!==1)return null;
 const port=row.connectors[0];
 if(port.domain!=='DomainHvac'||port.connectorType!=='End'||port.connectorIdBasis!=='revit_native_connector_id')return null;
 const assigned=owner.assignedConnectorFlows,calculated=owner.calculatedConnectorFlows;
 if(!Array.isArray(assigned)||assigned.length!==1||assigned[0].connectorId!==port.connectorId
  ||!Array.isArray(calculated)||calculated.length!==1||calculated[0].connectorId!==port.connectorId)return null;
 const a=assigned[0].observation,c=calculated[0].observation;
 if(a?.status!=='observed'||a.domain!=='DomainHvac'||a.configuration!=='Preset'||!['In','Out'].includes(a.direction)
  ||a.units!=='cubic_feet_per_second'||a.meaning!=='assigned_connector_inputs'||!finite(a.flow)
  ||c?.status!=='observed'||c.units!=='cubic_feet_per_second'||c.meaning!=='calculated_output_not_prescribed_input'||!finite(c.value))return null;
 const p=parameter(owner);if(!p||!close(p.value,c.value))return null;
 return {assigned:a,calculated:c.value,connectorId:port.connectorId,withoutCalculated:p.state};
}

/** Narrow semantic comparison only, called inside native receipt/admission and
 * full physical/schedule preservation. Never derives authority from these rows.
 * A changed writable-looking built-in Flow is calculated only when matching
 * native connector output AND unchanged explicit Preset inputs prove it. */
export function terminalCalculatedFlowChangeV2(before:Row,after:Row,immediate:Row,beforeRow:Row,afterRow:Row,immediateRow:Row):NativeCalculatedFlowChange|null{
 try{
  if(before?.uniqueId!==after?.uniqueId||before.uniqueId!==immediate?.uniqueId||before.elementId!==after.elementId
   ||before.elementId!==immediate.elementId||!assignedConnectorInputsPreservedV2(before,after,immediate))return null;
  const b=facts(before,beforeRow),a=facts(after,afterRow),i=facts(immediate,immediateRow);
  if(!b||!a||!i||b.connectorId!==a.connectorId||b.connectorId!==i.connectorId
   ||!equal(b.assigned,a.assigned)||!equal(b.assigned,i.assigned)
   ||!equal(b.withoutCalculated,a.withoutCalculated)||!equal(b.withoutCalculated,i.withoutCalculated))return null;
  return {elementId:before.elementId,uniqueId:before.uniqueId,connectorId:b.connectorId,parameterId:-1013405,
   before:b.calculated,after:a.calculated,assigned:b.assigned.flow,units:'cubic_feet_per_second',displayVerified:false};
 }catch{return null;}
}
