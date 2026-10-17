import assert from 'node:assert/strict';
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import test from 'node:test';
import {createGoal,__testOnlyResetGoalListCache} from '../src/goals/service.js';
import {createAssignmentKernelForGoalV2} from '../src/assignments/assignment_kernel_v2_factory.js';
import {getAssignmentKernelSnapshotV2} from '../src/assignments/assignment_kernel_v2_store.js';
import {manageAssignmentWorkPlan} from '../src/assignments/assignment_work_plan.js';
import {handleCodexDynamicToolCall} from '../src/brains/codex_dynamic_tool_handler.js';
import {prepareCodexAssignmentProgressV2,finalCodexAssignmentMessageV2} from '../src/brains/codex_assignment_progress.js';
import {beginTeammateLoopOwner,endTeammateLoopOwner} from '../src/teammate_loop_runtime.js';
import {controlAssignmentExecutionV2} from '../src/assignments/assignment_kernel_v2_controls.js';
import {runWithRequestContext} from '../src/request_context.js';import {createOperatorBackendAuth} from '../src/operator_backend_auth.js';
import {__closeForTests} from '../src/memory/sqlite_store.js';
import {routeConversation} from '../src/conversation_intake.js';

for(const variant of ['desktop','direct_desktop','backend','mismatched_source','foreign_marker','paused'] as const)test(`scoped backend helper ${variant} cannot finish its desktop parent`,async()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'operator-scoped-helper-'));
 const env={OPERATOR_WORKSPACE_ROOT:root,REVIT_OPERATOR_MODE:'development',OPERATOR_LOCAL_EXECUTOR_PROFILE:'codex_v2_advisory_v1',OPERATOR_ASSIGNMENT_KERNEL_V2:'1',OPERATOR_BRAIN:'codex',OPERATOR_TOOL_EXPOSURE_PROFILE:'laboratory',OPERATOR_HOSTED_ENABLED:'0'};
 const old=Object.fromEntries(Object.keys(env).map(k=>[k,process.env[k]]));Object.assign(process.env,env);__testOnlyResetGoalListCache();
 try{await runWithRequestContext({operator_backend_auth:createOperatorBackendAuth('shared_token','test-only')},async()=>{
  const objective='Correct the schedule gap, inspect it and save a separate model.';
  const intake=await routeConversation({version:'operator.backend.v1',session_id:'outer-session',message_id:'source-message',user_text:objective},
   {interpret:async()=>({value:{route:'task',answer:null,basis:'needs_tools',requested_effect:'change',entire_request_answered:false,confidence:0.99,reason:'Model correction and a separate save.',question_kind:'current_model',identity_fields:[],read_evidence:'not_applicable',operation_scope:{schema:'revit-operator.interpreted-operation-scope/v1',requested_effect:'apply',model_effect:'apply',protected_clauses:[],prerequisites:[]}}})});assert.equal(intake.routing_status,'accepted');
  const goal=createGoal({title:'Correct schedule',objective,acceptance_criteria:['The requested correction is inspected and delivered.'],status:'active',related_session_id:'outer-session',created_by:'local-host',work_budget:{requested_effect:'apply',document_fingerprint:'model',conversation_message_id:'source-message',source_user_request:variant==='mismatched_source'?'Different request':objective,...(variant==='backend'?{}:{mode:'sidecar_computer',source:'operator_desktop',execution_substrate:'operator_desktop_outer_agent'})}});
  createAssignmentKernelForGoalV2({goal,run_id:'outer-run'});const state=()=>getAssignmentKernelSnapshotV2(goal.id)!,binding=state().current_binding;
  const marker=variant==='direct_desktop'?undefined:{schema:'operator.desktop-helper-scope.v1',binding:{...binding,...(variant==='foreign_marker'?{run_id:'foreign'}:{})}};
  const prompt=prepareCodexAssignmentProgressV2(binding,false,marker).prompt;
  const proposal={claimed_completed:['Inspected the empty row.'],remaining_work:['Perform the UI correction.'],uncertainties:[]};
  let calls=0,stops=0;
  const runtime:any={assignmentKernelV2Binding:()=>binding,queueAssignmentKernelV2TurnStop(){stops++;},async validateToolArguments(){},async callTool(_tool:string,args:any){calls++;return {content:[{type:'text',text:JSON.stringify(manageAssignmentWorkPlan({binding,action:args.action,completion_proposal:args.completionProposal}))}]};}};
  const owner=beginTeammateLoopOwner(runtime,{version:'operator.backend.v1',session_id:binding.session_id,message_id:'helper',user_text:'Inspect the gap only. Do not edit or save yet.',assignment_id:binding.assignment_id,assignment_run_id:binding.run_id,assignment_generation:binding.generation,context:{desktop_helper_scope_v1:marker}} as any,{canonicalSupervisionOnly:true});
  try{
   if(variant==='paused')controlAssignmentExecutionV2({binding,command_id:'pause',expected_command_id:null,action:'pause'});
   const before=structuredClone(state());
   const response:any=await handleCodexDynamicToolCall(runtime,{id:'helper-proposal',method:'item/tool/call',params:{namespace:'revit_operator',turnId:'helper-turn',tool:'operator_manage_work_plan',arguments:{action:'propose_completion',completionProposal:proposal}}} as any);
   if(variant==='desktop'){
    assert.equal(response.success,false);assert.match(JSON.stringify(response),/scoped_backend_handoff_required/);assert.equal(calls,0);assert.equal(stops,0);assert.deepEqual(state(),before);assert.match(prompt,/scoped backend helper/i);
    const text=finalCodexAssignmentMessageV2(state(),'The empty row is confirmed. UI correction remains.',marker);assert.match(text,/UI correction remains/);assert.match(text,/subtask report.*not.*completion/i);
    // The actual outer report still uses the ordinary guarded review endpoint.
    const retained=manageAssignmentWorkPlan({binding,action:'propose_completion',completion_proposal:proposal});assert(retained.completion_proposal);assert.equal(state().outcome,'awaiting_user_review');assert.equal(state().completion_proposal!.verified,false);
   }else if(variant==='paused'){assert.equal(calls,0);assert.equal(response.success,false);assert.match(JSON.stringify(response),/paused/);assert.deepEqual(state(),before);}
   else{assert.equal(calls,1);assert(state().completion_proposal,'backend and mismatched-owner tasks keep ordinary completion control');}
  }finally{endTeammateLoopOwner(owner);}
 });}finally{__testOnlyResetGoalListCache();__closeForTests();for(const[k,v]of Object.entries(old)){if(v===undefined)delete process.env[k];else process.env[k]=v;}fs.rmSync(root,{recursive:true,force:true});}
});
