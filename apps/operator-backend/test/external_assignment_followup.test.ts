import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import test from 'node:test';import assert from 'node:assert/strict';
import {createGoal,getGoal,__testOnlyResetGoalListCache} from '../src/goals/service.js';
import {retainedExternalAssignmentStart,startExternalAssignmentRun} from '../src/assignments/external_assignment_start.js';
import {getAssignmentKernelSnapshotV2} from '../src/assignments/assignment_kernel_v2_store.js';
import {runWithRequestContext} from '../src/request_context.js';import {createOperatorBackendAuth} from '../src/operator_backend_auth.js';
import {steerAssignment} from '../src/assignments/task_steering.js';import {__closeForTests,getConversationHistory} from '../src/memory/sqlite_store.js';
test('retained active task refuses a fresh follow-up run before its goal can be overwritten; exact start replay remains idempotent',async()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'external-followup-')),keys=['OPERATOR_WORKSPACE_ROOT','OPERATOR_ASSIGNMENT_KERNEL_V2'],old=Object.fromEntries(keys.map(k=>[k,process.env[k]]));
 Object.assign(process.env,{OPERATOR_WORKSPACE_ROOT:root,OPERATOR_ASSIGNMENT_KERNEL_V2:'1'});__testOnlyResetGoalListCache();
 try{await runWithRequestContext({operator_backend_auth:createOperatorBackendAuth('shared_token','fixture-only')},async()=>{
  const source='Draft a test message and ask me what it should say.',session='own',goal=createGoal({title:source,objective:source,acceptance_criteria:['Return a truthful result.'],status:'active',related_session_id:session,created_by:'local-host',
   work_budget:{mode:'sidecar_computer',source:'operator_desktop',source_user_request:source,execution_substrate:'operator_desktop_outer_agent',requested_effect:'apply',document_fingerprint:'fixture-model'}});
  const first=startExternalAssignmentRun({goal,sessionId:session,requestedRunId:'sidecar:original',actor:'operator_desktop_outer_agent'}),before=structuredClone(getGoal(goal.id)),snapshot=structuredClone(getAssignmentKernelSnapshotV2(goal.id));
  for(const body of [{session_id:session,start_assignment_run:true,assignment_run_id:'sidecar:followup',objective:'Use the text computer use test.'},
   {session_id:session,start_assignment_run:true,assignment_run_id:'sidecar:original',objective:'Changed source under the same request id.'},
   {session_id:'foreign',start_assignment_run:true,assignment_run_id:'sidecar:original',objective:source}]){
   assert.throws(()=>retainedExternalAssignmentStart(body,getGoal(goal.id)),/saved task/);assert.deepEqual(getGoal(goal.id),before);assert.deepEqual(getAssignmentKernelSnapshotV2(goal.id),snapshot);
  }
  assert.deepEqual(retainedExternalAssignmentStart({session_id:session,start_assignment_run:true,assignment_run_id:first.runId,objective:source},getGoal(goal.id)),first);
  assert.throws(()=>startExternalAssignmentRun({goal,sessionId:session,requestedRunId:'sidecar:followup',actor:'operator_desktop_outer_agent'}),/existing run/);
  const binding=getAssignmentKernelSnapshotV2(goal.id)!.current_binding,receipt=await steerAssignment({binding,command_id:'human-followup',text:'Use the text computer use test.',expected_turn_id:null});
  assert.equal(receipt.state,'saved');const after=getAssignmentKernelSnapshotV2(goal.id)!;assert.deepEqual(after.current_binding,binding);assert.equal(after.spec.source_user_request,source);
  assert.equal(getGoal(goal.id)?.objective,source);assert(getConversationHistory(session).some(r=>r.text==='Use the text computer use test.'));
  const repeat=await steerAssignment({binding,command_id:'human-followup',text:'Use the text computer use test.',expected_turn_id:null});assert.deepEqual(repeat,receipt);
  assert.deepEqual(getAssignmentKernelSnapshotV2(goal.id),after,'retry cannot reset a budget or create a new generation');
 });}finally{__closeForTests();__testOnlyResetGoalListCache();for(const[k,v]of Object.entries(old)){if(v===undefined)delete process.env[k];else process.env[k]=v;}
  assert(path.resolve(root).startsWith(path.resolve(os.tmpdir())+path.sep)&&path.basename(root).startsWith('external-followup-'));fs.rmSync(root,{recursive:true,force:true});}
});
