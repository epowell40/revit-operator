import assert from 'node:assert/strict';import test from 'node:test';
import {modelPointMoveReadbackMatchesV2} from '../src/verification/model_point_move_postcondition_v2.js';
import {operationTargetSelectorV2} from '../src/verification/verification_capability_admission_v2.js';
import {nativeInspectionTargetIdsV2} from '../src/assignments/native_inspection_coverage.js';
import {textMoveScheduleFixture} from './text_move_schedule_preservation.fixtures.js';

test('native54 historical collateral rejection remains; new complete before-after-current scope proves translation and preservation',()=>{
 const f=textMoveScheduleFixture();for(const r of f.actual_reads)assert.equal(modelPointMoveReadbackMatchesV2(f.input,f.native_apply,r),false);
 assert.equal(modelPointMoveReadbackMatchesV2(f.input,f.applied,f.read),true);
});
test('one typed summary selects and covers exact target plus collateral without nested field IDs',()=>{
 const f=textMoveScheduleFixture(),targets=[...f.input.body.ids,...f.ids].sort((a,b)=>a-b),body={elementIds:targets,preservationScheduleIds:f.ids};
 f.read.schedulePreservation.items[0].definition.definition.fields=[{id:999999}];
 for(const value of [body,f.read])assert.deepEqual(operationTargetSelectorV2({operation:{capability_id:'revit_call_tool',path:'/revit/get-element-summary'},value} as any).principal_target_tokens,targets.map(n=>'id:'+n));
 assert.deepEqual(nativeInspectionTargetIdsV2({method:'POST',path:'/revit/get-element-summary',body},f.read),targets);
});
for(const [name,mutate] of [
 ['missing baseline',(f:any)=>delete f.applied.schedulePreservation],
 ['incomplete baseline',(f:any)=>f.applied.schedulePreservation.before[0].complete=false],
 ['changed at commit',(f:any)=>f.applied.schedulePreservation.after[0].parameters.push({id:1,value:'changed'})],
 ['changed after commit',(f:any)=>f.read.schedulePreservation.items[0].parameters.push({id:1,value:'changed'})],
 ['wrong UID',(f:any)=>f.read.schedulePreservation.items[0].uniqueId='foreign'],
 ['non-schedule collateral',(f:any)=>f.applied.schedulePreservation.before[0].definition.identity.kind='unknown'],
 ['missing current',(f:any)=>delete f.read.schedulePreservation],
 ['missing row',(f:any)=>f.read.schedulePreservation.items.pop()],
 ['duplicate row',(f:any)=>f.read.schedulePreservation.items[1]=f.read.schedulePreservation.items[0]],
 ['wrong current cohort',(f:any)=>f.read.schedulePreservation.requestedElementIds[0]=99],
 ['missing summary',(f:any)=>f.read.result.pop()],
 ['wrong summary identity',(f:any)=>f.read.result.find((r:any)=>f.ids.includes(r.id)).uniqueId='other'],
 ['wrong summary class',(f:any)=>f.read.result.find((r:any)=>f.ids.includes(r.id)).className='FamilyInstance'],
 ['incomplete change inventory',(f:any)=>f.applied.changeTracking.exhaustiveChangeInventory=false],
 ['failed capture',(f:any)=>f.applied.changeTracking.captureFailureCount=1],
 ['multiple wrappers',(f:any)=>f.applied.changeTracking.distinctWrapperMatchCount=2],
 ['missing event count',(f:any)=>delete f.applied.changeTracking.matchingEventCount],
 ['invalid event count',(f:any)=>f.applied.changeTracking.matchingEventCount=NaN],
 ['affected inventory mismatch',(f:any)=>f.applied.transaction.affected_element_ids.pop()],
 ['duplicate modified',(f:any)=>f.applied.transaction.modified_element_ids.push(f.ids[0])],
 ['added',(f:any)=>f.applied.transaction.added_element_ids=[99]],
 ['deleted',(f:any)=>f.applied.transaction.deleted_element_ids=[99]],
 ['wrong point',(f:any)=>f.read.result.find((r:any)=>f.input.body.ids.includes(r.id)).location.x+=1],
 ['truncated',(f:any)=>f.read.truncated=true],
 ['preview',(f:any)=>f.input.body.dryRun=true],
] as const)test('text move collateral refuses '+name,()=>{const f=textMoveScheduleFixture();mutate(f);assert.equal(modelPointMoveReadbackMatchesV2(f.input,f.applied,f.read),false);});
