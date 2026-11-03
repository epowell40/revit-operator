import assert from'node:assert/strict';import fs from'node:fs';import os from'node:os';import path from'node:path';import test from'node:test';import{fileURLToPath}from'node:url';
import{getAssignmentKernelSnapshotV2}from'../src/assignments/assignment_kernel_v2_store.js';
import{getGoalStoragePath,__testOnlyResetGoalListCache}from'../src/goals/service.js';
import{retainDesktopHelperReturnV1,takeDesktopHelperReturnV1,desktopHelperReturnAfterDrainV1,DESKTOP_HELPER_RETURN_REASON}from'../src/brains/desktop_helper_return.js';
import{__testOnlyFinalizeDecision}from'../src/brain.js';
const here=path.dirname(fileURLToPath(import.meta.url)),file=[path.join(here,'fixtures/completed-mixed-report-516.json'),path.join(here,'../../test/fixtures/completed-mixed-report-516.json')].find(fs.existsSync)!;
test('actual516 completed native mixed assignment retains and drains requested written follow-up without changing journal',()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'operator-completed-report-')),previous=process.env.OPERATOR_WORKSPACE_ROOT;process.env.OPERATOR_WORKSPACE_ROOT=root;__testOnlyResetGoalListCache();
 try{
  const f=JSON.parse(fs.readFileSync(file,'utf8')),id=f.goal.id,destination=getGoalStoragePath(id)!;fs.mkdirSync(path.dirname(destination),{recursive:true});fs.writeFileSync(destination,JSON.stringify(f.goal));
  const before=fs.readFileSync(destination),snapshot=getAssignmentKernelSnapshotV2(id)!;assert.equal(snapshot.outcome,'complete');assert(snapshot.terminal&&snapshot.quiescent);
  const binding=snapshot.current_binding,marker={schema:'operator.desktop-helper-scope.v1',binding},owner={},args=f.call.arguments;
  const retained=retainDesktopHelperReturnV1({owner,turn_id:'actual-written-followup',binding,marker,tool:'operator_manage_work_plan',arguments:args});assert(retained);assert.equal(retained.verified,false);
  const taken=takeDesktopHelperReturnV1(owner,'actual-written-followup');const message=desktopHelperReturnAfterDrainV1(taken,marker,getAssignmentKernelSnapshotV2(id),DESKTOP_HELPER_RETURN_REASON);
  assert(message);assert.match(message,/Reported findings \(not independently verified\)/);assert(message.includes('confirm menu/cooking equipment'));assert(message.includes('No sizing, selection or routing decisions made.'));
  const req:any={version:'operator.backend.v1',session_id:binding.session_id,message_id:'written-delivery',assignment_id:binding.assignment_id,assignment_run_id:binding.run_id,assignment_generation:binding.generation,context:{desktop_helper_scope_v1:marker}};
  const decision:any={version:'operator.backend.v1',assistant_message:message,actions:[],desktop_helper_return:taken,provider_turn_usage:{schema:'revit-operator.provider-turn-usage/v1',session_id:binding.session_id,message_id:req.message_id,thread_id:'retained-report-regression',turn_id:'actual-written-followup',disposition:'completed',raw_response_ids:['retained-fixture-only']}};
  const finalized=__testOnlyFinalizeDecision(req,decision);assert.equal(finalized.assistant_message,message);assert.equal(finalized.desktop_helper_return,taken);assert.deepEqual(finalized.actions,[]);
  assert.deepEqual(fs.readFileSync(destination),before);assert.equal(getAssignmentKernelSnapshotV2(id)!.outcome,'complete');
 }finally{__testOnlyResetGoalListCache();if(previous===undefined)delete process.env.OPERATOR_WORKSPACE_ROOT;else process.env.OPERATOR_WORKSPACE_ROOT=previous;assert.equal(path.dirname(root),os.tmpdir());assert(path.basename(root).startsWith('operator-completed-report-'));fs.rmSync(root,{recursive:true,force:true});}
});
