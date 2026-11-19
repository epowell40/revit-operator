import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import test from 'node:test';import assert from 'node:assert/strict';
import {createGoal,getGoal,__testOnlyResetGoalListCache} from '../src/goals/service.js';
import {externalAssignmentInputHandoff,retainedExternalAssignmentStart,startExternalAssignmentRun} from '../src/assignments/external_assignment_start.js';
import {createAssignmentKernelForGoalV2} from '../src/assignments/assignment_kernel_v2_factory.js';
import {routeConversation} from '../src/conversation_intake.js';
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

test('fresh E002 startup or an interrupted exact-start replay asks before native execution',async t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'external-followup-'));
 const keys=['OPERATOR_WORKSPACE_ROOT','OPERATOR_ASSIGNMENT_KERNEL_V2'];
 const previous=Object.fromEntries(keys.map(key=>[key,process.env[key]]));
 Object.assign(process.env,{OPERATOR_WORKSPACE_ROOT:root,OPERATOR_ASSIGNMENT_KERNEL_V2:'1'});
 __testOnlyResetGoalListCache();
 t.after(()=>{
  __closeForTests();__testOnlyResetGoalListCache();
  for(const [key,value] of Object.entries(previous))if(value===undefined)delete process.env[key];else process.env[key]=value;
  assert.equal(path.dirname(path.resolve(root)),path.resolve(os.tmpdir()));
  fs.rmSync(root,{recursive:true,force:true});
 });
 const protectedClause='If more than one parking garage view is placed there, ask me which one before making any change.';
 const source='On E002, can you move the parking garage view half an inch to the right? I only want one view moved. '+protectedClause;
 const question='If E002 contains more than one parking garage view, which one should be moved half an inch to the right?';
 const variable='parking_garage_view_choice_if_multiple';
 await runWithRequestContext({operator_backend_auth:createOperatorBackendAuth('shared_token','fixture-only')},async()=>{
  for(const mode of ['fresh','interrupted'] as const){
   const sessionId='e002-'+mode,messageId='request-'+mode,requestedRunId='sidecar:e002-'+mode;
   const intake=await routeConversation({version:'operator.backend.v1',session_id:sessionId,message_id:messageId,user_text:source},{
    interpret:async()=>({value:{route:'task',answer:null,basis:'needs_tools',requested_effect:'change',entire_request_answered:false,
     confidence:0.99,reason:'The request conditions the move on which view is meant.',question_kind:'action',identity_fields:[],read_evidence:'not_applicable',
     operation_scope:{schema:'revit-operator.interpreted-operation-scope/v1',requested_effect:'apply',model_effect:'apply',
      protected_clauses:['I only want one view moved.',protectedClause],prerequisites:[{variable_id:variable,kind:'information',question,source_quote:protectedClause}]}}})
   });
   assert.equal(intake.routing_status,'accepted');
   const goal=createGoal({title:'Move one garage viewport',objective:source,acceptance_criteria:['Return a truthful result.'],
    status:'active',related_session_id:sessionId,work_budget:{mode:'sidecar_computer',source:'operator_desktop',
     source_user_request:source,conversation_message_id:messageId,execution_substrate:'operator_desktop_outer_agent',
     requested_effect:'apply',document_fingerprint:'fixture-model'}});
   const retry={start_assignment_run:true,assignment_run_id:requestedRunId,objective:source,session_id:sessionId};
   if(mode==='interrupted'){
    createAssignmentKernelForGoalV2({goal,run_id:requestedRunId});
    assert.deepEqual(getAssignmentKernelSnapshotV2(goal.id)?.clarifications,{});
    assert.throws(()=>retainedExternalAssignmentStart({...retry,session_id:'foreign'},getGoal(goal.id)),/saved task/);
    assert.deepEqual(getAssignmentKernelSnapshotV2(goal.id)?.clarifications,{});
   }
   const started=mode==='fresh'?startExternalAssignmentRun({goal,sessionId,requestedRunId,actor:'operator_desktop_outer_agent'})
    :retainedExternalAssignmentStart(retry,getGoal(goal.id));
   assert.ok(started);
   const outcome=externalAssignmentInputHandoff(started,sessionId).canonical_assignment_outcome;
   assert.equal(outcome?.pending_clarification?.question,question,mode);
   assert.deepEqual(outcome.pending_clarification?.missing_fields,[variable]);
   assert.equal(outcome.outcome_state,'awaiting_user_input');
   const retained=getGoal(goal.id)!;
   assert.deepEqual(retained.assignment_kernel_v2?.events.map(e=>e.event_type),['assignment_created','input_requested']);
   assert.deepEqual(retainedExternalAssignmentStart(retry,retained),started);
   assert.deepEqual(getGoal(goal.id),retained);
  }
 });
});
