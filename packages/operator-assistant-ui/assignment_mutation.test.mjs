import assert from 'node:assert/strict';
import test from 'node:test';
import {acknowledgeAssignmentMutationV2 as mutate,acceptAssignmentMutationViewV2 as accept,retainNewerAssignmentViewsV2 as merge,savedAssignmentNavigationTargetV2 as navigation,readSavedAssignmentHistoryV2 as history} from './assignment_mutation.mjs';
const binding={assignment_id:'task',session_id:'session',run_id:'run',generation:1};
const view=(version=8)=>({id:'goal:task',_sourceKind:'assignment_kernel_v2',_bindingV2:binding,_assignmentVersion:version,_canResume:true,_pendingInputs:[]});

test('saved task navigation keeps siblings and an exact target outside the bounded history page without execution',async()=>{
 const target={...view(4),_sourceRecordId:'task'},sibling={...view(17),id:'goal:other',_sourceRecordId:'other',_bindingV2:{...binding,assignment_id:'other'}};
 const calls=[],read=async path=>{calls.push(path);return path.includes('/task?')?{assignment:target}:{session_id:'session',assignments:[sibling]};};
 const result=await history(read,'session','task');assert.deepEqual(result.assignments,[target,sibling]);assert.equal(calls.length,2);
 assert.ok(calls.every(path=>path.startsWith('/api/assignment-workspace/v2')));
 const newer={...target,_assignmentVersion:5};
 const merged=await history(async path=>path.includes('/task?')?{assignment:target}:{session_id:'session',assignments:[newer,sibling]},'session','task');
 assert.deepEqual(merged.assignments,[newer,sibling]);assert.equal(target._assignmentVersion,4);
});

test('saved task history rejects foreign sessions, invalid views, generation races and missing exact targets',async()=>{
 const target={...view(4),_sourceRecordId:'task'};
 for(const [exact,rows,session] of [[target,[target],'foreign'],[target,[{...target,_sourceKind:'goal'}],'session'],[target,[{...target,_bindingV2:{...binding,generation:2}}],'session'],[null,[],'session'],[target,Array(31).fill(target),'session']])
  await assert.rejects(history(async path=>path.includes('/task?')?{assignment:exact}:{session_id:session,assignments:rows},'session','task'));
 let called=false;await assert.rejects(history(async()=>{called=true;},'','task'));assert.equal(called,false);
 await assert.rejects(history(async()=>{throw Error('History unavailable');},'session','task'));
});

test('an explicitly selected saved assignment opens its exact canonical target without authority or execution',()=>{
 const older={...view(3),_sourceRecordId:'task',_canResume:false,_pendingInputs:[{question:'An unanswered question'}]};
 const before=structuredClone(older);
 assert.deepEqual(navigation(older,'session'),{session_id:'session',assignment_id:'task'});
 assert.deepEqual(older,before);
 for(const invalid of [{...older,_sourceKind:'goal'},{...older,_sourceRecordId:'other'},
  {...older,id:'goal:other'},{...older,_assignmentVersion:0},
  {...older,_bindingV2:{...binding,generation:-1}},{...older,_bindingV2:{...binding,run_id:''}}])assert.equal(navigation(invalid,'session'),null);
 assert.equal(navigation(older,'foreign'),null);
 assert.equal(navigation(older,''),null);
});
test('mutation reads only exact post-save publication and returns small acknowledged view',async()=>{const calls=[];const result=await mutate(async(path,options)=>{calls.push({path,options});return options.method==='POST'?{ok:true,assignment_snapshot_v2:{current_binding:binding,assignment_version:8}}:{assignment_kernel_v2:view()};},v=>v,'/answer',binding);assert.equal(result.assignment._assignmentVersion,8);assert.equal(calls[1].path,'/api/assignments/v2/task');assert.equal(calls.length,2);});
test('committed save with failed or regressed refresh reports saved without authorizing continuation',async()=>{for(const publication of [null,view(7),{...view(),_bindingV2:{...binding,generation:2}}]){const result=await mutate(async(_,options)=>options.method==='POST'?{ok:true,assignment_snapshot_v2:{current_binding:binding,assignment_version:8}}:{assignment_kernel_v2:publication},v=>v,'/answer',binding);assert.equal(result.ok,true);assert.ok(result.refresh_error);assert.equal(result.assignment,undefined);}});
test('missing or foreign acknowledgment cannot start a read or continuation',async()=>{for(const acknowledgment of [{ok:true},{ok:true,assignment_snapshot_v2:{current_binding:{...binding,session_id:'foreign'},assignment_version:8}}]){let calls=0;await assert.rejects(mutate(async()=>{calls++;return acknowledgment;},v=>v,'/answer',binding));assert.equal(calls,1);}});
test('exact answer acknowledgment fences an older poll and later regressed display',()=>{const old={...view(7),_canResume:false,_pendingInputs:[{}]},saved=view();const state={sessionId:'session',goals:[old],goalsSyncRequestId:3};assert.equal(accept(state,{ok:true,assignment:saved},binding),saved);assert.equal(state.goalsSyncRequestId,4);assert.equal(state.goals[0],saved);assert.equal(merge([old],state.goals)[0],saved);assert.equal(merge([view(9)],state.goals)[0]._assignmentVersion,9);});
test('navigation, generation change and newer display cannot be overwritten by answer acknowledgment',()=>{for(const old of [{...view(),_bindingV2:{...binding,generation:2}},view(9)]){const state={sessionId:'session',goals:[old],goalsSyncRequestId:3};assert.equal(accept(state,{ok:true,assignment:view()},binding),null);assert.equal(state.goalsSyncRequestId,3);}const state={sessionId:'foreign',goals:[view(7)]};assert.equal(accept(state,{ok:true,assignment:view()},binding),null);});
