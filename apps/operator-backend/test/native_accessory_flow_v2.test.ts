import fs from 'node:fs';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {terminalCalculatedFlowChangeV2} from '../src/verification/native_accessory_flow_v2.js';
import {nativeAccessoryPreservationV2} from '../src/verification/native_accessory_preservation_v2.js';
import {terminalFlowExample} from './native_accessory_flow.fixtures.js';
const locations=[new URL('./fixtures/native-terminal-flow137.json',import.meta.url),new URL('../../test/fixtures/native-terminal-flow137.json',import.meta.url)];
const retained=JSON.parse(fs.readFileSync(locations.find(p=>fs.existsSync(p))!,'utf8'));
function projected(record:any){
 // Separate retained graphs are diagnostic inputs to this pure semantic test,
 // not merged authoritative evidence or retroactive actor verification.
 const f=structuredClone(record);
 for(const phase of ['before','after']){
  const {owner,row,assigned}=f[phase];
  owner.assignedConnectorFlows=[{connectorId:row.connectors[0].connectorId,observation:{status:'observed',domain:'DomainHvac',
   flow:assigned.assignedFlow,configuration:assigned.configuration,direction:assigned.assignedDirection,
   units:'cubic_feet_per_second',meaning:'assigned_connector_inputs'}}];
 }
 return f;
}
for(const record of retained.records)test(`retained137 terminal ${record.id}: actual assigned input differs from calculated output`,()=>{
 const f=projected(record),r=terminalCalculatedFlowChangeV2(f.before.owner,f.after.owner,f.after.owner,f.before.row,f.after.row,f.after.row);
 assert.ok(r);assert.equal(r.before,100/60);assert.equal(r.after,0);assert.equal(r.assigned,100/60);assert.equal(r.displayVerified,false);
 const old=structuredClone(f.before.owner);delete old.assignedConnectorFlows;
 assert.equal(terminalCalculatedFlowChangeV2(old,f.after.owner,f.after.owner,f.before.row,f.after.row,f.after.row),null,'Legacy receipt cannot gain counterpart evidence');
});
const run=(f:ReturnType<typeof terminalFlowExample>)=>nativeAccessoryPreservationV2(f.input,f.affected,f.apply,f.after);
const current=(f:any)=>f.after.nativePlacementState.owners.find((o:any)=>o.elementId===40);
const before=(f:any)=>f.apply.preservationBefore.nativePlacementState.owners.find((o:any)=>o.elementId===40);
const immediate=(f:any)=>f.apply.preservationAfter.nativePlacementState.owners.find((o:any)=>o.elementId===40);
for(const [name,mutate] of Object.entries({
 'missing assigned inputs':(f:any)=>{delete current(f).assignedConnectorFlows;},
 'missing baseline assigned inputs':(f:any)=>{delete before(f).assignedConnectorFlows;},
 'changed assigned CFM':(f:any)=>{current(f).assignedConnectorFlows[0].observation.flow=0;},
 'changed assigned direction':(f:any)=>{current(f).assignedConnectorFlows[0].observation.direction='Out';},
 'changed immediate input':(f:any)=>{immediate(f).assignedConnectorFlows[0].observation.flow=0;},
 'unknown assignment':(f:any)=>{current(f).assignedConnectorFlows[0].observation={status:'unavailable'};},
 'calculated configuration':(f:any)=>{for(const o of [before(f),current(f),immediate(f)])o.assignedConnectorFlows[0].observation.configuration='Calculated';},
 'wrong source domain':(f:any)=>{current(f).assignedConnectorFlows[0].observation.domain='DomainPiping';},
 'foreign connector':(f:any)=>{current(f).assignedConnectorFlows[0].connectorId=99;},
 'duplicate connector':(f:any)=>{current(f).assignedConnectorFlows.push(current(f).assignedConnectorFlows[0]);},
 'NaN assignment':(f:any)=>{current(f).assignedConnectorFlows[0].observation.flow=NaN;},
 'negative assignment':(f:any)=>{current(f).assignedConnectorFlows[0].observation.flow=-1;},
 'wrong flow units':(f:any)=>{current(f).calculatedConnectorFlows[0].observation.units='cfm';},
 'missing calculated counterpart':(f:any)=>{delete current(f).calculatedConnectorFlows;},
 'different calculated counterpart':(f:any)=>{current(f).calculatedConnectorFlows[0].observation.value=1;},
 'unknown calculated output':(f:any)=>{current(f).calculatedConnectorFlows[0].observation.status='unavailable';},
 'full parameter mismatch':(f:any)=>{current(f).parameters[0].value='99';},
 'prescribed same-name parameter changed':(f:any)=>{const o=current(f),ps=JSON.parse(o.state.parameters);ps[1].value='0';o.state.parameters=JSON.stringify(ps);},
 'tag/display dependent changed':(f:any)=>{current(f).dependentIds=[999];},
 'tag displayed CFM changed':(f:any)=>{f.after.nativePlacementState.flowDisplayBindings.tags[0].text='0 CFM';},
 'unobserved tag bindings':(f:any)=>{delete f.after.nativePlacementState.flowDisplayBindings;},
 'truncated tag scope':(f:any)=>{f.after.nativePlacementState.flowDisplayBindings.complete=false;},
 'missing terminal from tag scope':(f:any)=>{f.after.nativePlacementState.flowDisplayBindings.terminalIds=[];},
 'changed tag reference':(f:any)=>{f.after.nativePlacementState.flowDisplayBindings.tags[0].targetIds=[50];},
 'schedule cell changed':(f:any)=>{f.after.nativePlacementState.schedulePreservation.items[0].parameters.push({id:1,value:'0 CFM'});},
 'non-terminal category':(f:any)=>{f.after.results.find((r:any)=>r.id===40).category='OST_MechanicalEquipment';},
 'missing immediate counterpart':(f:any)=>{delete immediate(f).calculatedConnectorFlows;},
}))test(`assigned/calculated comparison refuses ${name}`,()=>{const f=terminalFlowExample();mutate(f);assert.equal(run(f),null);});

test('unchanged visible built-in value does not excuse assigned input loss',()=>{
 const f=terminalFlowExample();current(f).state.parameters=before(f).state.parameters;
 current(f).assignedConnectorFlows[0].observation.flow=0;assert.equal(run(f),null);
});
