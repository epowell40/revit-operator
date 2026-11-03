import {example} from './native_accessory_preservation.fixtures.js';
export const states=(f:any)=>[f.apply.preservationBefore.nativePlacementState,f.apply.preservationAfter.nativePlacementState,f.after.nativePlacementState];
export function browserFixture(){
 const f=example('pipe');
 const metadata={elementId:900,uniqueId:'native-system-browser',exists:true,className:'Autodesk.Revit.DB.View',categoryId:null,
  typeId:-1,ownerViewId:-1,hasLocation:false,hasBounds:true,schemaGuids:[],dependentIds:[900,901],
  parameters:[{id:-1,storage:'String',readOnly:true,value:'System Browser'}]};
 for(const s of states(f))s.systemBrowserViews={schema:'operator.native_system_browser_state.v1',complete:true,
  scope:'system_browser_public_state_not_hidden_state',items:[{elementId:900,uniqueId:metadata.uniqueId,viewType:'SystemBrowser',
   name:'System Browser',isTemplate:false,metadata:structuredClone(metadata)}]};
 for(const xs of [f.apply.transaction.modified_element_ids,f.apply.transaction.affected_element_ids,f.apply.changeTracking.observedModifiedIds])xs.push(900);
 f.affected.push('element_id:900');for(const s of states(f).slice(1)){if(!s.requestedChangedIds.includes(900))s.requestedChangedIds.push(900);s.affected.push(structuredClone(metadata));}
 return f;
}
export function equipmentGraph(){const g=example('pipe').apply.preservationBefore;
 g.results.find((r:any)=>r.id===40)!.category='OST_PlumbingEquipment';
 for(const r of g.results)for(const c of r.connectors)for(const refs of [c.connectedTo,c.physicalConnectedTo])for(const ref of refs)if(ref.ownerId===40)ref.ownerCategory='OST_PlumbingEquipment';
 return g;
}
export function pipeCenterFixture(){
 const f=example('pipe');
 for(const [i,s] of states(f).entries()){
  const parent=s.owners.find((o:any)=>o.elementId===10)!,length=i===0?'10':'4.75';
  parent.parameters=[{id:-1114120,storage:'Double',readOnly:true,value:length},{id:-1004005,storage:'Double',readOnly:true,value:length}];parent.dependentIds=[800];
  s.dependents=[{elementId:800,uniqueId:'pipe-center',exists:true,className:'Autodesk.Revit.DB.Element',categoryId:-2008045,
   typeId:-1,ownerViewId:-1,hasLocation:false,hasBounds:true,schemaGuids:[],dependentIds:[800],parameters:structuredClone(parent.parameters)}];
 }
 for(const xs of [f.apply.transaction.modified_element_ids,f.apply.transaction.affected_element_ids,f.apply.changeTracking.observedModifiedIds])xs.push(800);
 f.affected.push('element_id:800');for(const s of states(f).slice(1)){if(!s.requestedChangedIds.includes(800))s.requestedChangedIds.push(800);s.affected.push(structuredClone(s.dependents[0]));}
 return f;
}
