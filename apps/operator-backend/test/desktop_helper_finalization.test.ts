import assert from 'node:assert/strict';
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import test from 'node:test';
import {createGoal,__testOnlyResetGoalListCache} from '../src/goals/service.js';
import {createAssignmentKernelForGoalV2} from '../src/assignments/assignment_kernel_v2_factory.js';
import {getAssignmentKernelSnapshotV2} from '../src/assignments/assignment_kernel_v2_store.js';
import {handleCodexDynamicToolCall} from '../src/brains/codex_dynamic_tool_handler.js';
import {prepareCodexAssignmentProgressV2} from '../src/brains/codex_assignment_progress.js';
import {beginTeammateLoopOwner,endTeammateLoopOwner,guardGenericTeammateDecision} from '../src/teammate_loop_runtime.js';
import {controlAssignmentExecutionV2} from '../src/assignments/assignment_kernel_v2_controls.js';
import {runWithRequestContext} from '../src/request_context.js';import {createOperatorBackendAuth} from '../src/operator_backend_auth.js';
import {__closeForTests} from '../src/memory/sqlite_store.js';
import {routeConversation} from '../src/conversation_intake.js';
import {requestAssignmentInputV2} from '../src/assignments/assignment_kernel_v2_lifecycle.js';
import {recordAssignmentProviderCallStateV2,advanceAssignmentKernelProgressV2} from '../src/assignments/assignment_kernel_v2_progress.js';
import {DESKTOP_HELPER_RETURN_REASON,takeDesktopHelperReturnV1,desktopHelperReturnAfterDrainV1} from '../src/brains/desktop_helper_return.js';
import {__testOnlyFinalizeDecision} from '../src/brain.js';

// Normalized neighbor of a retained discovery-only report whose mention of
// completed inspection was mistaken for completion of the physical redline.
export async function runDesktopHelperFinalizationScenario(variant:string,report?:{claimed_completed:string[];remaining_work:string[];uncertainties:string[]}){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'operator-helper-finalize-'));
 const env={OPERATOR_WORKSPACE_ROOT:root,REVIT_OPERATOR_MODE:'development',OPERATOR_LOCAL_EXECUTOR_PROFILE:'codex_v2_advisory_v1',OPERATOR_ASSIGNMENT_KERNEL_V2:'1',OPERATOR_BRAIN:'codex',OPERATOR_TOOL_EXPOSURE_PROFILE:'laboratory',OPERATOR_HOSTED_ENABLED:'0'};
 const old=Object.fromEntries(Object.keys(env).map(k=>[k,process.env[k]]));Object.assign(process.env,env);__testOnlyResetGoalListCache();
 try{await runWithRequestContext({operator_backend_auth:createOperatorBackendAuth('shared_token','test-only')},async()=>{
  const objective='Apply the marked ductwork changes from the attached PDF and verify the actual sheets.';
  const intake=await routeConversation({version:'operator.backend.v1',session_id:'outer-session',message_id:'source',user_text:objective},
   {interpret:async()=>({value:{route:'task',answer:null,basis:'needs_tools',requested_effect:'change',entire_request_answered:false,confidence:0.99,reason:'Physical redline work.',question_kind:'current_model',identity_fields:[],read_evidence:'not_applicable',operation_scope:{schema:'revit-operator.interpreted-operation-scope/v1',requested_effect:'apply',model_effect:'apply',protected_clauses:[],prerequisites:[]}}})});assert.equal(intake.routing_status,'accepted');
  const goal=createGoal({title:'Physical redlines',objective,acceptance_criteria:['Actual changes and sheet inspection.'],status:'active',related_session_id:'outer-session',created_by:'local-host',work_budget:{requested_effect:'apply',document_fingerprint:'model',conversation_message_id:'source',source_user_request:objective,mode:'sidecar_computer',source:'operator_desktop',execution_substrate:'operator_desktop_outer_agent'}});
  createAssignmentKernelForGoalV2({goal,run_id:'outer-run'});const state=()=>getAssignmentKernelSnapshotV2(goal.id)!,binding=state().current_binding;
  const marker={schema:'operator.desktop-helper-scope.v1',binding};prepareCodexAssignmentProgressV2(binding,false,marker);
  const req:any={version:'operator.backend.v1',session_id:binding.session_id,message_id:'helper',user_text:objective,assignment_id:binding.assignment_id,assignment_run_id:binding.run_id,assignment_generation:binding.generation,context:{desktop_helper_scope_v1:marker}};
  let calls=0;const runtime:any={assignmentKernelV2Binding:()=>binding,queueAssignmentKernelV2TurnStop(){},async validateToolArguments(){},async callTool(){calls++;throw Error('A scoped return must not dispatch work');}};
  const owner=beginTeammateLoopOwner(runtime,req,{canonicalSupervisionOnly:true});
  try{
   recordAssignmentProviderCallStateV2({binding,call_id:'provider',state:'admitted',provider:'openai',model:'test-model',gap_ids:[],criterion_ids:[],expected_information:['Scoped discovery.']});
   const returned:any=await handleCodexDynamicToolCall(runtime,{id:'report',method:'item/tool/call',params:{namespace:'revit_operator',turnId:'helper-turn',tool:'operator_manage_work_plan',arguments:{action:'propose_completion',completionProposal:report??{claimed_completed:['Read-only source inspection completed. No physical edits, no final native inspection, no save.'],remaining_work:['Create the actual duct accessories, inspect connections and review affected sheets.'],uncertainties:[]}}}} as any);
   assert(returned.success);assert.equal(calls,0);recordAssignmentProviderCallStateV2({binding,call_id:'provider',state:'completed',success:true,usage:{input_tokens:12,output_tokens:3,total_tokens:15,reasoning_tokens:null,estimated_cost_usd:null}});
   const taken=takeDesktopHelperReturnV1(runtime,'helper-turn');assert(taken);
   if(variant.startsWith('terminal_')){
    // Presentation-only neighbor of actual516 mixed-original: native completion
    // preceded its requested written scope report. Never mutate the journal.
    const final=structuredClone(state());final.terminal=true;final.outcome='complete';
    if(variant==='terminal_question')taken.report.kind='proposed_question';
    if(variant==='terminal_failed')final.outcome='failed';
    if(variant==='terminal_blocked')final.outcome='blocked';
    if(variant==='terminal_paused')final.execution_control={...final.execution_control!,state:'paused'};
    if(variant==='terminal_unknown')final.unresolved_unknown_operation_ids=['unknown'];
    if(variant==='terminal_provider')final.in_flight_provider_call_ids=['pending'];
    const before=JSON.stringify(final),message=desktopHelperReturnAfterDrainV1(taken,marker,final,DESKTOP_HELPER_RETURN_REASON);
    if(variant==='terminal_complete'){assert(message);assert.match(message,/Reported findings \(not independently verified\)/);assert(message.includes(taken.report.claimed_completed[0]));}
    else assert.equal(message,null);
    assert.equal(JSON.stringify(final),before);assert.equal(state().outcome,'active');return;
   }
   const message=desktopHelperReturnAfterDrainV1(taken,marker,state(),DESKTOP_HELPER_RETURN_REASON);assert(message);
   const decision:any={version:'operator.backend.v1',assistant_message:message,actions:[],desktop_helper_return:taken,provider_turn_usage:{schema:'revit-operator.provider-turn-usage/v1',session_id:req.session_id,message_id:req.message_id,thread_id:'thread',turn_id:'helper-turn',disposition:variant==='interrupted'?'interrupted':'completed',raw_response_ids:['provider']}};
   if(variant==='forged')decision.desktop_helper_return=structuredClone(taken);
   if(variant==='changed_message')decision.assistant_message+=' The entire ductwork redline is complete.';
   if(variant==='action')decision.actions=[{action_id:'unsafe',method:'POST',path:'/revit/create-text',body:{text:'Done'}}];
   if(variant==='missing_usage')delete decision.provider_turn_usage;
   if(variant==='wrong_usage_schema')decision.provider_turn_usage.schema='caller-lookalike';
   if(variant==='foreign_usage')decision.provider_turn_usage.turn_id='foreign';
   if(variant==='failed_usage')decision.provider_turn_usage.disposition='failed';
   if(variant==='foreign_marker')req.context.desktop_helper_scope_v1={...marker,binding:{...binding,run_id:'foreign'}};
   if(variant==='foreign_request')req.assignment_run_id='foreign';
   if(variant==='paused')controlAssignmentExecutionV2({binding,command_id:'pause',expected_command_id:null,action:'pause'});
   if(variant==='pending_provider')recordAssignmentProviderCallStateV2({binding,call_id:'pending',state:'admitted',provider:'openai',model:'test-model',gap_ids:[],criterion_ids:[],expected_information:['Pending.']});
   if(variant==='input')requestAssignmentInputV2({binding,clarification_id:'real-design-input',variable_ids:['design'],new_variable_ids:['design'],question:'What design value is authorized?'});
   if(variant==='budget'){
    recordAssignmentProviderCallStateV2({binding,call_id:'large-accounted-call',state:'admitted',provider:'openai',model:'test-model',gap_ids:[],criterion_ids:[],expected_information:['Previously dispatched usage.']});
    recordAssignmentProviderCallStateV2({binding,call_id:'large-accounted-call',state:'completed',success:true,usage:{input_tokens:9000000,output_tokens:3,total_tokens:9000003,reasoning_tokens:null,estimated_cost_usd:null}});
    advanceAssignmentKernelProgressV2({binding});
    assert(state().terminal||state().provider_budget_exhausted||state().progress_blocker||state().provider_usage_hold,'Budget fixture must actually record the ordinary controller stop');
   }
   const before=structuredClone(state()),actual=__testOnlyFinalizeDecision(req,decision);
   if(['current','interrupted'].includes(variant)){
    assert.equal(actual.assistant_message,message,'Keep genuine drained partial findings, not a generic modeled-work stop');
    assert.equal(actual.desktop_helper_return,taken);assert.deepEqual(actual.actions,[]);assert.equal(state().outcome,'active');assert.equal(state().completion_proposal,undefined);
    const generic=__testOnlyFinalizeDecision(req,guardGenericTeammateDecision(req,decision));
    assert.equal(generic.assistant_message,message,'Generic provider finalization also retains scoped findings');
    assert.deepEqual(generic.actions,[]);assert.equal(generic.desktop_helper_return,taken);
   }else assert.notEqual(actual.assistant_message,decision.assistant_message,variant+' must not inherit a trusted return exception');
   assert.deepEqual(state(),before,'Finalization is presentation only, never completion or authority');assert.equal(calls,0);
  }finally{takeDesktopHelperReturnV1(runtime,'helper-turn');endTeammateLoopOwner(owner);}
 });}finally{__testOnlyResetGoalListCache();__closeForTests();for(const[k,v]of Object.entries(old)){if(v===undefined)delete process.env[k];else process.env[k]=v;}fs.rmSync(root,{recursive:true,force:true});}
}
for(const variant of ['current','interrupted','forged','changed_message','action','missing_usage','wrong_usage_schema','foreign_usage','failed_usage','foreign_marker','foreign_request','paused','pending_provider','input','budget'])
 test(`physical-redline helper finalization ${variant}`,()=>runDesktopHelperFinalizationScenario(variant));
for(const variant of ['terminal_complete','terminal_question','terminal_failed','terminal_blocked','terminal_paused','terminal_unknown','terminal_provider'])
 test(`native completion does not lose written findings: ${variant}`,()=>runDesktopHelperFinalizationScenario(variant,{claimed_completed:['Written follow-up only: confirm the menu, cooking equipment, occupancy, loads, outdoor air and HRU service extent. No sizing, selection or routing decisions made.'],remaining_work:[],uncertainties:['No official code conclusion claimed.']}));
