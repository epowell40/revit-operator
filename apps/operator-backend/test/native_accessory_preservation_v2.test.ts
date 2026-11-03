import {test} from 'node:test';
import assert from 'node:assert/strict';
import {nativeAccessoryPreservationV2} from '../src/verification/native_accessory_preservation_v2.js';
import {fixture} from './native_accessory_topology.fixtures.js';
import {inlineAccessoryFixture} from './inline_accessory_readback.fixtures.js';

import {example} from './native_accessory_preservation.fixtures.js';
import {terminalFlowExample} from './native_accessory_flow.fixtures.js';
const run=(f:ReturnType<typeof example>)=>nativeAccessoryPreservationV2(f.input,f.affected,f.apply,f.after);
test('plan midpoint framing is navigation metadata, never proof of requested-host fit',()=>{
 const f=example('pipe');
 (f.apply as any).planFocus={applied:true,hostElementId:10,hostUniqueId:'native-unique-10',center:[0,0,0],units:'internal_feet'};
 assert.ok(run(f));
 f.input.body.targetHosts[0].elementId=999;
 f.input.body.targetHosts[0].uniqueId='neighboring-host';
 assert.equal(run(f),null,'A focus claim cannot admit placement on the wrong host');
});
test('plan focus does not replace complete independent preservation observation',()=>{
 const f=example('pipe');
 (f.apply as any).planFocus={applied:true,hostElementId:10,hostUniqueId:'native-unique-10'};
 f.after.nativePlacementState.complete=false;
 assert.equal(run(f),null);
});
test('native terminal calculated output is distinct from unchanged assigned Preset CFM',()=>{
 const f=terminalFlowExample(),result=run(f);
 assert.ok(result,'Exact assigned counterpart coverage must distinguish calculated output from input loss');
 assert.deepEqual((result as any).calculatedFlowChanges,[{elementId:40,uniqueId:'native-unique-40',connectorId:1,
  parameterId:-1013405,before:100/60,after:0,assigned:100/60,units:'cubic_feet_per_second',displayVerified:false}]);
});
for(const kind of ['duct','pipe'] as const)for(const keep of ['start','end'] as const)test(`${kind} ${keep} retained ID: two accessories plus independent current read`,()=>{
 const f=example(kind,2,keep);assert.equal(run(f)?.runs[0]?.accessoryIds.length,2);
});
for(const [name,damage] of Object.entries({
 'wrong native request route':(f:any)=>{f.input.path='/revit/connect-existing-mep-branch';},
 'host identity changed':(f:any)=>{f.input.body.targetHosts[0].uniqueId='foreign';},
 'source type changed':(f:any)=>{f.apply.sourceTypeUniqueId='foreign';},
 'unknown native effect':(f:any)=>{f.apply.transaction.status='unknown';},
 'capture event failure':(f:any)=>{f.apply.changeTracking.problems.push('event_capture_failed');},
 'added IDs missing':(f:any)=>{f.apply.transaction.added_element_ids=[];},
 'unreported changed owner':(f:any)=>{f.affected.push('element_id:800');},
 'uncovered changed owner':(f:any)=>{for(const ids of [f.apply.transaction.modified_element_ids,f.apply.transaction.affected_element_ids,
   f.after.nativePlacementState.requestedChangedIds,f.apply.preservationAfter.nativePlacementState.requestedChangedIds])if(!ids.includes(800))ids.push(800);
   f.affected.push('element_id:800');},
 'schedule content changed':(f:any)=>{f.after.nativePlacementState.schedulePreservation.items[0].parameters.push({id:1,value:'changed'});},
 'prescribed remote parameter changed':(f:any)=>{f.after.nativePlacementState.owners[0].state.parameters='[{"id":1,"storage":"String","value":"changed"}]';},
 'prescribed split parameter changed':(f:any)=>{f.after.nativePlacementState.owners.find((o:any)=>o.elementId===10).state.parameters='[{"id":1,"storage":"String","value":"changed"}]';},
 'type parameters changed':(f:any)=>{f.after.nativePlacementState.types[0].parameters='[{"id":1,"storage":"String","value":"changed"}]';},
 'system membership changed':(f:any)=>{f.after.nativePlacementState.systems[0].members=[];},
 'system configuration changed':(f:any)=>{f.after.nativePlacementState.systems[0].parameters='[{"id":1,"storage":"String","value":"changed"}]';},
 'unexpected system network owner':(f:any)=>{f.after.nativePlacementState.systems[0].network.push({elementId:800,uniqueId:'extra'});},
 'post-insertion accessory values changed':(f:any)=>{f.after.nativePlacementState.owners.find((o:any)=>o.elementId===200).state.parameters='[{"id":1,"storage":"String","value":"changed"}]';},
 'placement UID changed':(f:any)=>{f.apply.placedInstances[0].uniqueId='foreign';},
 'malformed parameter string':(f:any)=>{f.after.nativePlacementState.types[0].parameters='{';},
 'missing complete observation':(f:any)=>{f.after.nativePlacementState.complete=false;},
 'missing scoped source type':(f:any)=>{f.after.nativePlacementState.requestedTypeIds=[];},
 'computed success alone':(f:any)=>{delete f.apply.preservationBefore;},
}))test(`refuses ${name}`,()=>{const f=example();damage(f);assert.equal(run(f),null);});

function centers(){
 const f=example();const ps=[{id:1,storage:'String',readOnly:false,value:'retained'}];
 const descriptor=(id:number)=>({elementId:id,uniqueId:`center-${id}`,exists:true,className:'Autodesk.Revit.DB.Element',categoryId:-2008001,
   typeId:-1,ownerViewId:-1,hasLocation:false,hasBounds:true,parameters:structuredClone(ps),schemaGuids:[],dependentIds:[]});
 const before=f.apply.preservationBefore.nativePlacementState,after=f.after.nativePlacementState;
 for(const s of [before,after])for(const o of s.owners.filter((o:any)=>o.typeId===110)){
   o.parameters=structuredClone(ps);o.state.parameters=JSON.stringify(ps.map(({readOnly,...p})=>p));
 }
 before.owners.find((o:any)=>o.elementId===10).dependentIds=[70];before.dependents=[descriptor(70)];
 after.owners.find((o:any)=>o.elementId===10).dependentIds=[70];after.owners.find((o:any)=>o.elementId===100).dependentIds=[71];
 after.dependents=[descriptor(70),descriptor(71)];f.apply.transaction.added_element_ids.push(71);f.apply.transaction.modified_element_ids.push(70);
 f.apply.changeTracking.observedModifiedIds.push(70);
 f.apply.transaction.affected_element_ids.push(70,71);f.affected.push('element_id:70','element_id:71');
 after.requestedChangedIds=f.apply.transaction.affected_element_ids;
 after.affected=after.requestedChangedIds.map((elementId:number)=>({elementId,uniqueId:elementId===60?'native-schedule-unique-60':[70,71].includes(elementId)?`center-${elementId}`:`native-unique-${elementId}`,exists:true}));
 f.apply.preservationAfter=structuredClone(f.after);return f;
}
test('native parent-bound centerline copies retain existing strict semantic projection',()=>assert.ok(run(centers())));
for(const [name,damage]of Object.entries({
 'foreign centerline parent':(f:any)=>{f.after.nativePlacementState.owners.find((o:any)=>o.elementId===100).dependentIds=[];},
 'unqualified generic class':(f:any)=>{f.after.nativePlacementState.dependents[1].className='Other';},
 'new centerline schema':(f:any)=>{f.after.nativePlacementState.dependents[1].schemaGuids=['custom'];},
 'new centerline writable value':(f:any)=>{f.after.nativePlacementState.dependents[1].parameters[0].value='changed';},
 'empty centerline values':(f:any)=>{f.after.nativePlacementState.dependents[1].parameters=[];},
 'unexpected dependent':(f:any)=>{f.after.nativePlacementState.dependents[1].dependentIds=[999];},
}))test(`centerline coverage refuses ${name}`,()=>{const f=centers();damage(f);assert.equal(run(f),null);});
