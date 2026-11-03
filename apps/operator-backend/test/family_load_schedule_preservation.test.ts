import assert from 'node:assert/strict';import test from 'node:test';
import {familySessionReadbackMatchesV2 as matches} from '../src/verification/family_session_verification_v2.js';
import {familyScheduleFixture,retainedFamilyLoad509} from './family_load_schedule_preservation.fixtures.js';
test('historical509 remains refused; prospective complete before-after-current schedules allow loaded identity',()=>{
 const r=retainedFamilyLoad509();for(const read of r.reads)assert.equal(matches(r.input,r.apply,read.input,read.payload),false);
 const f=familyScheduleFixture();assert.equal(matches(f.input,f.apply,f.read,f.payload),true);
});
for(const [name,mutate] of [
 ['no baseline',(f:any)=>delete f.apply.schedulePreservation],
 ['incomplete before',(f:any)=>f.apply.schedulePreservation.before[0].complete=false],
 ['changed at commit',(f:any)=>f.apply.schedulePreservation.after[0].parameters.push({id:1,value:'changed'})],
 ['changed after commit',(f:any)=>f.payload.schedulePreservation.items[0].parameters.push({id:1,value:'changed'})],
 ['unsupported schedule',(f:any)=>f.apply.schedulePreservation.before[0].definition.identity.kind='unknown'],
 ['missing current',(f:any)=>delete f.payload.schedulePreservation],
 ['missing schedule request',(f:any)=>delete f.read.body.preservationScheduleIds],
 ['wrong schedule request',(f:any)=>f.read.body.preservationScheduleIds=[1420970]],
 ['missing summary',(f:any)=>f.payload.result.pop()],
 ['wrong summary UID',(f:any)=>f.payload.result.at(-1).uniqueId='foreign-unique-id'],
 ['wrong summary class',(f:any)=>f.payload.result.at(-1).className='FamilyInstance'],
 ['wrong full class',(f:any)=>f.payload.result.at(-1).fullClassName='Other.ViewSchedule'],
 ['extra modified',(f:any)=>f.apply.transaction.modified_element_ids.push(999)],
 ['duplicate modified',(f:any)=>f.apply.transaction.modified_element_ids.push(1420970)],
 ['added-modified overlap',(f:any)=>f.apply.transaction.modified_element_ids.push(f.apply.familyId)],
 ['deleted',(f:any)=>f.apply.transaction.deleted_element_ids=[999]],
 ['incomplete inventory',(f:any)=>f.apply.changeTracking.exhaustiveChangeInventory=false],
 ['failed capture',(f:any)=>f.apply.changeTracking.captureFailureCount=1],
 ['multiple wrappers',(f:any)=>f.apply.changeTracking.distinctWrapperMatchCount=2],
 ['missing event',(f:any)=>delete f.apply.changeTracking.matchingEventCount],
 ['pending',(f:any)=>f.apply.transaction.pending=true],
 ['rolled back',(f:any)=>f.apply.transaction.rolled_back=true],
 ['overwrite',(f:any)=>f.input.body.overwriteParameterValues=true],
 ['existing family',(f:any)=>f.apply.transaction.added_element_ids=f.apply.transaction.added_element_ids.filter((n:number)=>n!==f.apply.familyId)],
 ['affected mismatch',(f:any)=>f.apply.transaction.affected_element_ids.pop()],
 ['wrong family',(f:any)=>f.payload.result.find((r:any)=>r.id===f.apply.familyId).name='Other'],
 ['wrong symbol',(f:any)=>f.payload.result.find((r:any)=>r.id===f.apply.symbols[0].id).className='Element'],
 ['truncated',(f:any)=>f.payload.truncated=true],
 ['duplicate current',(f:any)=>f.payload.schedulePreservation.items[1]=f.payload.schedulePreservation.items[0]],
] as const)test('family load preservation refuses '+name,()=>{const f=familyScheduleFixture();mutate(f);assert.equal(matches(f.input,f.apply,f.read,f.payload),false);});
test('each collateral owner must independently retain its full current snapshot',()=>{
 for(let i=0;i<6;i++){const f=familyScheduleFixture();f.payload.schedulePreservation.items[i].parameters.push({id:7,value:'changed'});assert.equal(matches(f.input,f.apply,f.read,f.payload),false);}
});
test('schedule and combined read bounds cannot expand through this path',()=>{
 const f=familyScheduleFixture();f.apply.transaction.modified_element_ids=Array.from({length:33},(_,i)=>2000000+i);
 assert.equal(matches(f.input,f.apply,f.read,f.payload),false);
 const g=familyScheduleFixture();g.apply.transaction.added_element_ids=Array.from({length:1999},(_,i)=>3000000+i).concat(g.apply.familyId);
 g.apply.transaction.affected_element_ids=[...g.apply.transaction.added_element_ids,...g.apply.transaction.modified_element_ids];
 assert.equal(matches(g.input,g.apply,g.read,g.payload),false);
});
