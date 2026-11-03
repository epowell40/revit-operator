import {fixture} from './native_accessory_topology.fixtures.js';
import {inlineAccessoryFixture} from './inline_accessory_readback.fixtures.js';
export function example(kind:'duct'|'pipe'='duct',count=1,keep:'start'|'end'='end'){
 const f=fixture(kind,count,keep),affected=[...f.added,10,40,50,60,99];
 const uid=(n:number)=>n===60?'native-schedule-unique-60':`native-unique-${n}`;
 const state=(scan:any,after:boolean)=>({schema:'operator.native_accessory_placement_state.v1',complete:true,
   requestedElementIds:scan.results.map((r:any)=>r.id),requestedTypeIds:[130],requestedSystemIds:[99],requestedChangedIds:after?affected:[],
   affected:after?affected.map(elementId=>({elementId,uniqueId:uid(elementId),exists:true})):[],
   owners:scan.results.map((r:any)=>({elementId:r.id,uniqueId:uid(r.id),typeId:r.typeId,parameters:[],dependentIds:[],
     state:{UniqueId:uid(r.id),metadata:{type:r.typeId,phase:1,demolished:-1,workset:1,systemType:r.typeId===130?null:199,level:2,diameter:r.typeId===130?null:.5},
       parameters:'[]',geometryKind:r.category.endsWith('Curves')?'Line':'Point',points:r.connectors.map((c:any)=>c.origin),
       ports:r.connectors.map((c:any)=>({id:c.connectorId,origin:c.origin,direction:c.coordinateSystem.basisZ,shape:c.shape}))}})),
   types:[110,130,140,150].map(elementId=>({elementId,uniqueId:uid(elementId),parameters:'[]'})),
   systems:[{elementId:99,uniqueId:uid(99),className:kind==='duct'?'Autodesk.Revit.DB.Mechanical.MechanicalSystem':'Autodesk.Revit.DB.Plumbing.PipingSystem',
     typeId:199,typeUniqueId:uid(199),parameters:'[]',typeParameters:'[]',members:[{elementId:40,uniqueId:uid(40)}],
     network:scan.results.map((r:any)=>({elementId:r.id,uniqueId:uid(r.id)})),baseEquipmentId:40}],dependents:[],
   schedulePreservation:structuredClone(inlineAccessoryFixture().apply.preservationBefore.schedulePreservation)});
 const before:any={...f.before,nativePlacementState:state(f.before,false)},after:any={...f.after,nativePlacementState:state(f.after,true)};
 const input={method:'POST',path:'/revit/place-mep-accessory-interactively',body:{expectedModelPath:'C:\\fixture.rvt',viewId:90,expectedViewUniqueId:uid(90),
   accessoryTypeId:130,expectedAccessoryTypeUniqueId:uid(130),maximumPlacements:count,targetHosts:[{elementId:10,uniqueId:uid(10)}]}};
 const apply:any={applied:true,success:true,sourceTypeId:130,sourceTypeUniqueId:uid(130),nativeInvocationReturned:true,readbackError:null,error:null,
   placementCountCaptureFailed:false,maximumPlacements:count,placementCount:count,placedInstances:f.placed.map(elementId=>({elementId,uniqueId:uid(elementId)})),
   preservationBefore:before,preservationAfter:structuredClone(after),transaction:{status:'committed',committed:true,added_element_ids:f.added,
     modified_element_ids:[10,40,50,60,99],deleted_element_ids:[],affected_element_ids:affected},
   changeTracking:{scope:'synchronous_native_placement_invocation',closed:true,problems:[],eventCount:count,committedEventCount:count,
     observedAddedIds:f.added,observedModifiedIds:[10,40,50,60,99],observedDeletedIds:[]}};
 return {input,apply,after,affected:affected.map(n=>`element_id:${n}`).sort()};
}
