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
import {requestAssignmentInputV2} from '../src/assignments/assignment_kernel_v2_lifecycle.js';
import {recordAssignmentProviderCallStateV2} from '../src/assignments/assignment_kernel_v2_progress.js';
import {retrieveEvidence} from '../src/evidence/evidence_store.js';
import {DESKTOP_HELPER_RETURN_REASON,peekDesktopHelperReturnV1,takeDesktopHelperReturnV1,desktopHelperReturnAfterDrainV1} from '../src/brains/desktop_helper_return.js';
import {runThinReferenceTurns} from '../src/brains/thin_reference_execution.js';
import {advanceAssignmentKernelProgressV2} from '../src/assignments/assignment_kernel_v2_progress.js';

export async function runDesktopScopedHandoffScenario(variant:string,inputOverride?:{clarificationId:string;variableIds:string[];newVariableIds:string[];question:string}){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'operator-scoped-helper-'));
 const env={OPERATOR_WORKSPACE_ROOT:root,REVIT_OPERATOR_MODE:'development',OPERATOR_LOCAL_EXECUTOR_PROFILE:'codex_v2_advisory_v1',OPERATOR_ASSIGNMENT_KERNEL_V2:'1',OPERATOR_BRAIN:'codex',OPERATOR_TOOL_EXPOSURE_PROFILE:'laboratory',OPERATOR_HOSTED_ENABLED:'0',OPERATOR_ADVISORY_MAX_PROVIDER_CALLS:'64'};
 const old=Object.fromEntries(Object.keys(env).map(k=>[k,process.env[k]]));Object.assign(process.env,env);__testOnlyResetGoalListCache();
 try{await runWithRequestContext({operator_backend_auth:createOperatorBackendAuth('shared_token','test-only')},async()=>{
  const reserveFixture=JSON.parse(fs.readFileSync(path.join(process.cwd(),'test/fixtures/desktop-helper-call-reserve170.json'),'utf8'));
  const objective='Correct the schedule gap, inspect it and save a separate model.';
  const intake=await routeConversation({version:'operator.backend.v1',session_id:'outer-session',message_id:'source-message',user_text:objective},
   {interpret:async()=>({value:{route:'task',answer:null,basis:'needs_tools',requested_effect:'change',entire_request_answered:false,confidence:0.99,reason:'Model correction and a separate save.',question_kind:'current_model',identity_fields:[],read_evidence:'not_applicable',operation_scope:{schema:'revit-operator.interpreted-operation-scope/v1',requested_effect:'apply',model_effect:'apply',protected_clauses:[],prerequisites:[]}}})});assert.equal(intake.routing_status,'accepted');
  const goal=createGoal({title:'Correct schedule',objective,acceptance_criteria:['The requested correction is inspected and delivered.'],status:'active',related_session_id:'outer-session',created_by:'local-host',work_budget:{requested_effect:'apply',document_fingerprint:'model',conversation_message_id:'source-message',source_user_request:variant==='mismatched_source'?'Different request':objective,...(variant==='backend'?{}:{mode:'sidecar_computer',source:'operator_desktop',execution_substrate:'operator_desktop_outer_agent'})}});
  createAssignmentKernelForGoalV2({goal,run_id:'outer-run'});const state=()=>getAssignmentKernelSnapshotV2(goal.id)!,binding=state().current_binding;
  const marker=['direct_desktop','direct_input'].includes(variant)?undefined:{schema:'operator.desktop-helper-scope.v1',binding:{...binding,...(variant==='foreign_marker'?{run_id:'foreign'}:{})}};
  const prompt=prepareCodexAssignmentProgressV2(binding,false,marker).prompt;
  const proposal={claimed_completed:['Inspected the empty row.'],remaining_work:['Perform the UI correction.'],uncertainties:[]};
  let calls=0,stops=0;
  const reasons:string[]=[];
  const runtime:any={assignmentKernelV2Binding:()=>binding,queueAssignmentKernelV2TurnStop(_turn:unknown,reason:string){stops++;reasons.push(reason);},async validateToolArguments(){},async callTool(tool:string,args:any){calls++;const result=tool==='operator_request_assignment_input'?requestAssignmentInputV2({binding,clarification_id:args.clarificationId,variable_ids:args.variableIds,new_variable_ids:args.newVariableIds,question:args.question}):manageAssignmentWorkPlan({binding,action:args.action,completion_proposal:args.completionProposal});return {content:[{type:'text',text:JSON.stringify(result)}]};}};
  const owner=beginTeammateLoopOwner(runtime,{version:'operator.backend.v1',session_id:binding.session_id,message_id:'helper',user_text:'Inspect the gap only. Do not edit or save yet.',assignment_id:binding.assignment_id,assignment_run_id:binding.run_id,assignment_generation:binding.generation,context:{desktop_helper_scope_v1:marker}} as any,{canonicalSupervisionOnly:true});
  try{
   const inputTool=['desktop_input','desktop_legacy_input','direct_input'].includes(variant);
   const tool=variant.startsWith('budget_')?'revit_call_tool':variant==='desktop_legacy_input'?'operator_request_clarification':inputTool?'operator_request_assignment_input':'operator_manage_work_plan';
   const question='The backend helper needs the desktop owner for the UI correction.';
   const args=variant.startsWith('budget_')?{method:'POST',path:'/revit/schedules',body:{action:'detail',scheduleId:42}}:variant==='desktop_legacy_input'?{missingFields:['desktop_owner_needed'],question,reason:'UI tools are held by the outer owner.'}:inputTool?(inputOverride??{clarificationId:'helper-needs-ui',variableIds:['desktop_owner_needed'],newVariableIds:['desktop_owner_needed'],question}):{action:'propose_completion',completionProposal:variant==='invalid_report'?{...proposal,claimed_completed:['x'.repeat(1001)]}:proposal};
   if(variant.startsWith('budget_'))for(let i=0;i<(variant==='budget_warning'?29:reserveFixture.backend_helper_calls[0]-1);i++){const call_id='earlier-helper-'+i;recordAssignmentProviderCallStateV2({binding,call_id,state:'admitted',provider:'openai',model:'test-model',gap_ids:[],criterion_ids:[],expected_information:['Scoped helper discovery.']});recordAssignmentProviderCallStateV2({binding,call_id,state:'completed',success:true,usage:{input_tokens:12,output_tokens:3,total_tokens:15,reasoning_tokens:null,estimated_cost_usd:null}});}
   recordAssignmentProviderCallStateV2({binding,call_id:'helper-provider',state:'admitted',provider:'openai',model:'test-model',gap_ids:[],criterion_ids:[],expected_information:['Bounded helper findings for its owner.']});
   if(variant==='paused')controlAssignmentExecutionV2({binding,command_id:'pause',expected_command_id:null,action:'pause'});
   const before=structuredClone(state());
   const response:any=await handleCodexDynamicToolCall(runtime,{id:variant==='budget_forged_host_id'?'host-committed-readback:fake:0':'helper-proposal',method:'item/tool/call',params:{namespace:'revit_operator',turnId:'helper-turn',tool,arguments:args}} as any,variant==='budget_forged_symbol'?Symbol('host-readback'):undefined);
   if(variant==='budget_warning'){
    assert.equal(response.success,false);assert.equal(calls,0);assert.equal(stops,0);assert.deepEqual(state(),before);assert.match(JSON.stringify(response),/not dispatched.*subtask report/);
    const returned:any=await handleCodexDynamicToolCall(runtime,{id:'bounded-report',method:'item/tool/call',params:{namespace:'revit_operator',turnId:'helper-turn',tool:'operator_manage_work_plan',arguments:{action:'propose_completion',completionProposal:proposal}}} as any);assert.equal(returned.success,true);assert.equal(calls,0);assert.equal(stops,1);assert.deepEqual(state(),before);assert.equal(state().outcome,'active');return;
   }
   if(variant==='budget_yield'||variant==='budget_forged_host_id'||variant==='budget_forged_symbol'){
    assert.equal(response.success,true);assert.equal(calls,0,'Over-allocation helper must not dispatch another native request');assert.equal(stops,1);assert.equal(reasons[0],DESKTOP_HELPER_RETURN_REASON);assert.deepEqual(state(),before,'Local return must not block, complete or enlarge parent allowance');
    const retained=peekDesktopHelperReturnV1(runtime,'helper-turn');assert(retained);assert.equal(retained.verified,false);assert.deepEqual(retained.report.claimed_completed,[]);assert.match(JSON.stringify(retained.report),/allowance|budget/i);
    recordAssignmentProviderCallStateV2({binding,call_id:'helper-provider',state:'completed',success:true,usage:{input_tokens:12,output_tokens:3,total_tokens:15,reasoning_tokens:null,estimated_cost_usd:null}});
    const taken=takeDesktopHelperReturnV1(runtime,'helper-turn');assert(taken);assert.match(desktopHelperReturnAfterDrainV1(taken,marker,state(),DESKTOP_HELPER_RETURN_REASON)??'',/desktop owner/);assert.equal(state().outcome,'active');return;
   }
   if(variant.startsWith('thin_')||['desktop','desktop_input','desktop_legacy_input','pause_after_return','control_after_return','real_question_after_return'].includes(variant)){
    assert.equal(response.success,true);assert.equal(calls,0);assert.equal(stops,1);assert.equal(reasons[0],DESKTOP_HELPER_RETURN_REASON);assert.deepEqual(state(),before);assert.match(prompt,/scoped backend helper/i);
    const retained=peekDesktopHelperReturnV1(runtime,'helper-turn')!;assert(retained);assert.equal(retained.verified,false);assert.equal(retained.evidence_ref.trust_level,'untrusted_caller');
    assert.equal(peekDesktopHelperReturnV1({},'helper-turn'),null);assert.equal(peekDesktopHelperReturnV1(runtime,'other-turn'),null);
    assert.equal(desktopHelperReturnAfterDrainV1(retained,marker,state(),DESKTOP_HELPER_RETURN_REASON),null,'provider is still admitted');
    const read=retrieveEvidence({scope:{session_id:binding.session_id,assignment_id:binding.assignment_id,run_id:binding.run_id,generation:binding.generation,attempt_id:'helper:helper-turn'},evidence_id:retained.evidence_ref.evidence_id,fields:['report'],purpose:'Inspect retained unverified helper report',max_bytes:12000});assert.match(JSON.stringify(read),/Perform the UI correction|desktop owner/);if(inputOverride)assert.match(JSON.stringify(read),new RegExp(inputOverride.question.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')));
    const later:any=await handleCodexDynamicToolCall(runtime,{id:'late-native',method:'item/tool/call',params:{namespace:'revit_operator',turnId:'helper-turn',tool:'revit_call_tool',arguments:{method:'POST',path:'/revit/delete-elements',body:{elementIds:[42],dryRun:false}}}} as any);assert.equal(later.success,false);assert.equal(calls,0);assert.deepEqual(state(),before);
    recordAssignmentProviderCallStateV2({binding,call_id:'helper-provider',state:'completed',success:true,usage:{input_tokens:12,output_tokens:3,total_tokens:15,reasoning_tokens:null,estimated_cost_usd:null}});
    if(variant==='pause_after_return'||variant==='control_after_return'){controlAssignmentExecutionV2({binding,command_id:'pause-later',expected_command_id:null,action:'pause'});if(variant==='control_after_return')controlAssignmentExecutionV2({binding,command_id:'new-resume',expected_command_id:'pause-later',action:'resume'});}
    if(variant==='real_question_after_return')requestAssignmentInputV2({binding,clarification_id:'real-human-question',variable_ids:['actual_design_value'],new_variable_ids:['actual_design_value'],question:'What design value should the outer owner use?'});
    const taken=takeDesktopHelperReturnV1(runtime,'helper-turn');assert(taken);assert.equal(takeDesktopHelperReturnV1(runtime,'helper-turn'),null);
    for(const fence of ['unknown','operation','provider','usage','budget','review','foreign','control']){
     const fenced=structuredClone(state());
     if(fence==='unknown')fenced.unresolved_unknown_operation_ids=['unconfirmed-effect'];
     if(fence==='operation')fenced.in_flight_operation_ids=['pending-native'];
     if(fence==='provider')fenced.in_flight_provider_call_ids=['pending-provider'];
     if(fence==='usage')fenced.provider_usage_hold={} as any;
     if(fence==='budget')fenced.provider_budget_exhausted=true;
     if(fence==='review')fenced.pending_review_ids=['real-review'];
     if(fence==='foreign')fenced.current_binding={...binding,run_id:'foreign'};
     if(fence==='control')fenced.execution_control={...fenced.execution_control,command_id:'later-control'} as any;
     assert.equal(desktopHelperReturnAfterDrainV1(taken,marker,fenced,DESKTOP_HELPER_RETURN_REASON),null,fence);
    }
    if(variant.startsWith('thin_')){
     const signal=new AbortController();let invokes=0,wall=0;
     const request:any={version:'operator.backend.v1',session_id:binding.session_id,message_id:'helper',user_text:'Inspect only.',context:{desktop_helper_scope_v1:variant==='thin_foreign_marker'?{...marker,binding:{...binding,run_id:'foreign'}}:marker}};
     const result=await runThinReferenceTurns({request,binding,limits:{max_turns:3,max_wall_ms:60000},signal:signal.signal,now:()=>wall,
      inspect:()=>advanceAssignmentKernelProgressV2({binding}),invoke:async()=>{
       invokes++;
       if(variant==='thin_abort')signal.abort('user_cancel');if(variant==='thin_wall')wall=60000;
       return {version:'operator.backend.v1',assistant_message:'Helper findings, correction remains.',actions:[],
        desktop_helper_return:variant==='thin_forged'?structuredClone(taken):taken,
        model_call_receipts:[{call_id:'actual-helper-receipt'} as any],
        ...(variant==='thin_missing_usage'?{}:{provider_turn_usage:{schema:'revit-operator.provider-turn-usage/v1',session_id:binding.session_id,message_id:'helper',thread_id:'thread',turn_id:'helper-turn',disposition:variant==='thin_completed'?'completed':variant==='thin_failed'?'failed':'interrupted',raw_response_ids:['helper-provider']}})};
      }});
     assert.equal(invokes,1,'no second backend turn for the returned helper');
     assert.equal(result.stop_reason,variant==='thin_abort'?'request_interrupted':variant==='thin_wall'?'experiment_wall_limit':['thin_completed','thin_interrupted'].includes(variant)?DESKTOP_HELPER_RETURN_REASON:'provider_turn_not_completed');
     assert.deepEqual(result.response.model_call_receipts?.map(r=>r.call_id),['actual-helper-receipt']);
     assert.equal(result.provider_turns.length,variant==='thin_missing_usage'?0:1);assert.equal(state().outcome,'active');
     assert.equal(state().completion_proposal,undefined);assert.equal(Object.keys(state().operations).length,0);
     if(['thin_completed','thin_interrupted'].includes(variant))assert.match(finalCodexAssignmentMessageV2(state(),result.response.assistant_message,marker),/UI correction remains|Perform the UI correction/);
     return;
    }
    const delivery=desktopHelperReturnAfterDrainV1(taken,marker,state(),DESKTOP_HELPER_RETURN_REASON);
    if(variant.endsWith('_after_return')){assert.equal(delivery,null);return;}
    assert.match(delivery!,/unverified subtask report/);assert.equal(state().outcome,'active');assert.equal(state().completion_proposal,undefined);assert.deepEqual(state().pending_input_variable_ids,[]);assert.equal(Object.keys(state().operations).length,0);
    const text=finalCodexAssignmentMessageV2(state(),'The empty row is confirmed. UI correction remains.',marker);assert.match(text,/UI correction remains/);assert.match(text,/subtask report.*not.*completion/i);
    // The actual outer report still uses the ordinary guarded review endpoint.
    const review=manageAssignmentWorkPlan({binding,action:'propose_completion',completion_proposal:proposal});assert(review.completion_proposal);assert.equal(state().outcome,'awaiting_user_review');assert.equal(state().completion_proposal!.verified,false);
   }else if(variant==='paused'){assert.equal(calls,0);assert.equal(response.success,false);assert.match(JSON.stringify(response),/paused/);assert.deepEqual(state(),before);}
   else if(variant==='invalid_report'){assert.equal(response.success,false);assert.equal(calls,0);assert.equal(stops,0);assert.equal(peekDesktopHelperReturnV1(runtime,'helper-turn'),null);assert.deepEqual(state(),before);}
   else if(variant==='direct_input'){assert.equal(calls,1);assert.equal(state().outcome,'awaiting_user_input');assert.deepEqual(state().pending_input_variable_ids,['desktop_owner_needed']);}
   else{assert.equal(calls,1);assert(state().completion_proposal,'backend and mismatched-owner tasks keep ordinary completion control');}
  }finally{takeDesktopHelperReturnV1(runtime,'helper-turn');endTeammateLoopOwner(owner);}
 });}finally{__testOnlyResetGoalListCache();__closeForTests();for(const[k,v]of Object.entries(old)){if(v===undefined)delete process.env[k];else process.env[k]=v;}fs.rmSync(root,{recursive:true,force:true});}
}
for(const variant of ['budget_yield','budget_warning','budget_forged_host_id','budget_forged_symbol','desktop','desktop_input','desktop_legacy_input','direct_desktop','direct_input','backend','mismatched_source','foreign_marker','paused','pause_after_return','control_after_return','real_question_after_return','invalid_report','thin_completed','thin_interrupted','thin_forged','thin_foreign_marker','thin_abort','thin_wall','thin_missing_usage','thin_failed'])
 test(`scoped backend helper ${variant} cannot finish its desktop parent`,()=>runDesktopScopedHandoffScenario(variant));
