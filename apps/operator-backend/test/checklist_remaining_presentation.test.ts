import test from 'node:test';import assert from 'node:assert/strict';
import {remainingWorkPresentationV2}from'../src/assignments/verified_change_presentation_v2.js';
for(const advisory of[false,true])test(`unfinished checklist uses ${advisory?'unconfirmed interpretation':'strict unfinished'} label without changing work`,()=>{
 const snapshot:any={spec:{requested_effect:'apply',...(advisory?{execution_policy:{mode:'local_advisory_v1'}}:{})},work_plan:{items:[{item_id:'inspect',description:'Inspect the schedule before editing',kind:'inspection'},{item_id:'other',description:'Other item',completed_at:'2026-10-17T00:00:00Z'}]}};
 const before=structuredClone(snapshot),text=remainingWorkPresentationV2(snapshot);assert.equal(text,(advisory?'Saved checklist status still needs review: ':'Still unfinished: ')+'Inspect the schedule before editing.');assert.deepEqual(snapshot,before);
});
test('no pending checklist produces no invented remaining work',()=>{assert.equal(remainingWorkPresentationV2({spec:{},work_plan:{items:[]}} as any),null);});
