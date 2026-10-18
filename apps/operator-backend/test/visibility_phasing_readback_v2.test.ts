import assert from 'node:assert/strict';import test from 'node:test';
import {postconditionSatisfiedByPayloadV2}from '../src/postcondition_verification_v2.js';

const fixture=(action='set_phase_filter',selector:Record<string,unknown>={phaseFilterId:51})=>({
 input:{method:'POST',path:'/revit/visibility',body:{action,viewId:42,...selector,dryRun:false} as Record<string,unknown>},
 read:{method:'POST',path:'/revit/visibility',body:{action:'get',viewId:42}},
 payload:{status:'Ok',action:'get',dryRun:false,view:{id:42,name:'Equipment schedule',isTemplate:false,viewType:'Schedule',
  phase:{id:21,name:'New Construction'},phaseFilter:{id:51,name:'New Only'}}} as any
});
const matches=(f:ReturnType<typeof fixture>)=>postconditionSatisfiedByPayloadV2(f.input,f.payload,{path:'/revit/visibility',verification_input:f.read,affected_target_identities:['element_id:42']});
for(const [name,action,selector]of [
 ['filter ID','set_phase_filter',{phaseFilterId:51}],['filter name','set_phase_filter',{phaseFilterName:' new only '}],
 ['phase ID','set_phase',{phaseId:21}],['phase name','set_phase',{phaseName:'NEW CONSTRUCTION'}],
 ['both selectors','set_phase_filter',{phaseFilterId:51,phaseFilterName:'New Only'}]
]as const)test(`view phasing compares separate native ${name}`,()=>assert.equal(matches(fixture(action,selector)),true));

const negatives:Record<string,(f:ReturnType<typeof fixture>)=>void>={
 'wrong view':f=>f.payload.view.id=43,
 'wrong phase filter':f=>f.payload.view.phaseFilter.id=52,
 'request selector echoed beside wrong native ID':f=>{f.payload.phaseFilterId=51;f.payload.view.phaseFilter.id=52;},
 'nested IDs are not the owning view':f=>{f.payload.view.id=43;f.payload.view.phaseFilter.id=42;},
 'missing native phase filter':f=>delete f.payload.view.phaseFilter,
 'missing native name':f=>delete f.payload.view.phaseFilter.name,
 'partial payload':f=>f.payload.truncated=true,
 'commit response is not readback':f=>{f.payload.status='Success';f.payload.action='set_phase_filter';},
 'unsuccessful envelope':f=>f.payload.error='failed',
 'preview input':f=>f.input.body.dryRun=true,
 'preview read':f=>f.payload.dryRun=true,
 'inconsistent name and ID':f=>Object.assign(f.input.body,{phaseFilterName:'Other'}),
 'invalid ID':f=>f.input.body.phaseFilterId=-1,
 'missing selector':f=>delete f.input.body.phaseFilterId,
 'compound request':f=>Object.assign(f.input.body,{phaseId:21}),
 'wrong read route':f=>f.read.path='/revit/schedules',
 'wrong read selector':f=>f.read.body.viewId=43,
 'mutation passed as read selector':f=>f.read.body.action='set_phase_filter'
};
for(const [name,mutate]of Object.entries(negatives))test(`view phasing refuses ${name}`,()=>{const f=fixture();mutate(f);assert.equal(matches(f),false);});
test('phase choice cannot be proved by a matching phase-filter ID',()=>{
 const f=fixture('set_phase',{phaseId:21});f.payload.view.phase.id=22;f.payload.view.phaseFilter.id=21;assert.equal(matches(f),false);
});
