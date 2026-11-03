import {example} from './native_accessory_preservation.fixtures.js';
// Synthetic native-shaped contract, never a historical/live certificate.
export function terminalFlowExample(){
 const f=example();
 for(const [scan,value] of [[f.apply.preservationBefore,100/60],[f.apply.preservationAfter,0],[f.after,0]] as const){
  const row=scan.results.find((r:any)=>r.id===40),owner=scan.nativePlacementState.owners.find((o:any)=>o.elementId===40);
  row.category='OST_DuctTerminal';row.connectors=row.connectors.filter((c:any)=>c.connectorId===1);
  row.connectorCount=row.returnedConnectorCount=1;row.openPhysicalConnectorCount=0;
  scan.totalScannedConnectorCount--;scan.openPhysicalConnectorCount--;
  for(const r of scan.results)for(const c of r.connectors)for(const p of [...c.physicalConnectedTo,...c.connectedTo])
   if(p.ownerId===40)p.ownerCategory='OST_DuctTerminal';
  owner.state.ports=owner.state.ports.filter((c:any)=>c.id===1);owner.state.points=[row.connectors[0].origin];
  owner.parameters=[{id:-1013405,storage:'Double',readOnly:false,value:String(value)},
   {id:1380238,storage:'Double',readOnly:false,value:String(100/60)}];
  owner.state.parameters=JSON.stringify(owner.parameters.map(({readOnly,...p}:any)=>p));
  owner.assignedConnectorFlows=[{connectorId:1,observation:{status:'observed',domain:'DomainHvac',
   flow:100/60,units:'cubic_feet_per_second',configuration:'Preset',direction:'In',meaning:'assigned_connector_inputs'}}];
  owner.calculatedConnectorFlows=[{connectorId:1,observation:{status:'observed',value,units:'cubic_feet_per_second',meaning:'calculated_output_not_prescribed_input'}}];
  scan.nativePlacementState.flowDisplayBindings={schema:'operator.native_terminal_tag_display.v1',complete:true,terminalIds:[40],
   tags:[{elementId:901,uniqueId:'terminal-tag-901',typeId:902,ownerViewId:903,targetIds:[40],text:'100 CFM'}],
   scope:'host_scoped_terminal_tag_references_and_actual_text; not_visual_readability'};
 }
 return f;
}
