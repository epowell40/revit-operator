import assert from 'node:assert/strict';import test from 'node:test';
import {operationTargetSelectorV2,verificationCapabilityAdmissionV2}from '../src/verification/verification_capability_admission_v2.js';
import {nativePhaseFilterCreationV2,decodeNativePhaseFilterReadV2,nativePhaseFilterReadbackMatchesV2}from '../src/verification/native_phase_filter_v2.js';
import {phaseFilterFixtureV2 as fixture}from './helpers/native_phase_filter_fixture.js';
test('native phase status getters target the exact phase filter rather than becoming anonymous discovery',()=>{
 const f=fixture();assert.deepEqual(operationTargetSelectorV2({operation:{capability_id:'revit_call_tool',path:f.read.path,arguments:f.read},value:f.read.body}).principal_target_tokens,['id:51']);
});

test('complete new phase-filter definition matches the separate native typed getter read',()=>{
 const f=fixture();assert(nativePhaseFilterCreationV2(f.input));assert(decodeNativePhaseFilterReadV2(f.read,f.readback));
 assert.equal(nativePhaseFilterReadbackMatchesV2(f.input,f.applied,f.read,f.readback,f.affected),true);
 assert.deepEqual(operationTargetSelectorV2({operation:{capability_id:'revit_call_tool',path:f.read.path,arguments:f.read},value:f.readback}).principal_target_tokens,['id:51']);
 const fresh=fixture();fresh.input.body.transaction.allowedExistingElementIds=[];fresh.applied.transaction.allowed_existing_element_ids=[];fresh.applied.transaction.commit_allowed_existing_element_ids=[];
 fresh.applied.transaction.modified_element_ids=[];fresh.applied.transaction.affected_element_count=1;fresh.affected=['element_id:51'];
 assert.equal(nativePhaseFilterReadbackMatchesV2(fresh.input,fresh.applied,fresh.read,fresh.readback,fresh.affected),true);
});

const invalid:Record<string,(f:ReturnType<typeof fixture>)=>void>={
 'wrong lookup ID':f=>f.read.body.operations[0].args[0]=52,
 'wrong native lookup ID':f=>f.readback.operations[0].result_preview.id=52,
 'different UID':f=>f.readback.operations[1].target_identity.unique_id='other',
 'foreign class':f=>f.readback.operations[1].target_identity.type_name='Autodesk.Revit.DB.ViewSchedule',
 'foreign document':f=>f.readback.operations[1].target_identity.active_document=false,
 'wrong name':f=>{f.readback.results.filter.name='Other';f.readback.operations[0].result_preview.name='Other';},
 'wrong status':f=>{f.readback.results.new='DontShow';f.readback.operations[1].result_preview='DontShow';},
 'missing native getter':f=>f.readback.operations.pop(),
 'partial read':f=>f.read.body.operations.pop(),
 'duplicate status':f=>f.read.body.operations[2].args[0]='New',
 'unreturned status':f=>f.read.body.returns.pop(),
 'result echo differs':f=>f.readback.results.temporary='ShowByCategory',
 'getter error':f=>f.readback.operations[4].error='failed',
 'error envelope':f=>f.readback.error='failed',
 'truncated':f=>f.readback.truncated=true,
 'not readonly':f=>f.readback.read_only=false,
 'wrong read route':f=>f.read.path='/revit/schedules',
 'rollback':f=>f.applied.transaction.status='rolled_back',
 'pending':f=>f.applied.transaction.pending=true,
 'unexpected old element':f=>f.applied.transaction.unexpected_existing_element_ids=[12],
 'undeclared modification':f=>f.applied.transaction.modified_element_ids=[12],
 'deleted old element':f=>f.applied.transaction.deleted_element_ids=[11],
 'extra created element':f=>f.applied.transaction.added_element_ids.push(52),
 'unsettled creation':f=>f.applied.transaction.transient_created_ids=[52],
 'wrong affected inventory':f=>f.affected.pop(),
 'missing native scope':f=>f.applied.transaction.scope_observer_executions=0,
 'wrong native setter receiver':f=>f.applied.operations[2].target_identity.element_id=52,
 'unsupported compound graph':f=>f.input.body.operations.push({id:'other',op:'call',target:'$f',memberId:'method:Other.Set()',args:[]} as any),
 'all statuses hidden':f=>f.input.body.operations.slice(2).forEach((x:any)=>x.args[1]='DontShow'),
 'unsupported enum value':f=>f.input.body.operations[2].args[1]='Invented',
 'creator returns old object':f=>f.applied.operations[1].result_preview.id=11,
 'duplicate affected identity':f=>f.affected.push('element_id:51')
};
for(const [name,mutate]of Object.entries(invalid))test(`native phase filter refuses ${name}`,()=>{
 const f=fixture();mutate(f);assert.equal(nativePhaseFilterReadbackMatchesV2(f.input,f.applied,f.read,f.readback,f.affected),false);
});
test('phase-filter creation requires phase presentation output rather than an unrelated schedule or success flag',()=>{
 const f=fixture(),apply={capability_id:'revit_call_tool',path:f.input.path,arguments:f.input},verification={capability_id:'revit_call_tool',path:f.read.path,arguments:f.read};
 const check=verificationCapabilityAdmissionV2({apply,verification});assert.equal(check.admissible,true);assert.deepEqual(check.required_semantic_outputs,['phase_filter.presentation']);
 assert.equal(verificationCapabilityAdmissionV2({apply,verification:{capability_id:'revit_call_tool',path:'/revit/schedules',arguments:{body:{action:'detail',scheduleId:11}}}}).admissible,false);
});
