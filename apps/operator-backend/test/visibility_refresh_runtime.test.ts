import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import test from 'node:test';import {createHash}from 'node:crypto';
import {createGoal,getGoal,__testOnlyResetGoalListCache}from '../src/goals/service.js';
import {createAssignmentKernelForGoalV2}from '../src/assignments/assignment_kernel_v2_factory.js';
import {getAssignmentKernelSnapshotV2}from '../src/assignments/assignment_kernel_v2_store.js';
import {beginTeammateLoopOwner,endTeammateLoopOwner}from '../src/teammate_loop_runtime.js';
import {handleCodexDynamicToolCall}from '../src/brains/codex_dynamic_tool_handler.js';
import {runWithRequestContext}from '../src/request_context.js';import {createOperatorBackendAuth}from '../src/operator_backend_auth.js';
import {canonicalJsonV2,AssignmentJournalV2}from '../src/domain/assignment-kernel/index.js';
import {controlAssignmentExecutionV2}from '../src/assignments/assignment_kernel_v2_controls.js';
import {checkedEditIsCurrentV2}from '../src/verification/current_postcondition_v2.js';
import {visibilityCheckNeedsRefreshV2}from '../src/verification/regular_schedule_recheck_v2.js';
import {committedVisibilityReadbackPlanV2}from '../src/verification/committed_visibility_readback_plan_v2.js';
import {codexAssignmentEvidenceContextV2}from '../src/brains/codex_assignment_evidence.js';
import {__closeForTests}from '../src/memory/sqlite_store.js';

for(const variant of ['two_properties','mismatch_on_refresh','failed_refresh','superseded_property','pause_after_second']as const)
test(`two committed view edits ${variant}: refresh current proof without replaying mutations`,async()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'operator-phasing-check-'));
 const env={OPERATOR_WORKSPACE_ROOT:root,REVIT_OPERATOR_MODE:'development',OPERATOR_LOCAL_EXECUTOR_PROFILE:'codex_v2_advisory_v1',OPERATOR_ASSIGNMENT_KERNEL_V2:'1',OPERATOR_BRAIN:'codex',OPERATOR_TOOL_EXPOSURE_PROFILE:'laboratory',OPERATOR_HOSTED_ENABLED:'0'};
 const old=Object.fromEntries(Object.keys(env).map(k=>[k,process.env[k]]));Object.assign(process.env,env);__testOnlyResetGoalListCache();
 try{await runWithRequestContext({operator_backend_auth:createOperatorBackendAuth('shared_token','test-only')},async()=>{
  const goal=createGoal({title:'Set schedule phasing',objective:'Use the requested native phase setting on the equipment schedule.',acceptance_criteria:['The assigned phase setting is checked.'],status:'active',related_session_id:'phasing-session',created_by:'local-host',work_budget:{requested_effect:'apply',document_fingerprint:'phasing-model'}});
  createAssignmentKernelForGoalV2({goal,run_id:'phasing-run'});const state=()=>getAssignmentKernelSnapshotV2(goal.id)!,binding=state().current_binding;
  const calls:any[]=[],action='set_phase';let currentPhase=21,currentFilter=50,reads=0,edits=0;
  const selector={phaseId:21};
  const runtime:any={assignmentKernelV2Binding:()=>binding,queueAssignmentKernelV2TurnStop(){},async validateToolArguments(){},
   async callTool(_tool:string,args:any,context:any){
    calls.push(args);const lease=context.assignmentKernelV2;context.onMcpAccepted();const reading=args.body.action==='get';
    if(reading){reads++;if(reads===3&&variant==='failed_refresh')throw Error('retained_refresh_failure');}
    else{edits++;if(args.body.action==='set_phase')currentPhase=args.body.phaseId;else currentFilter=args.body.phaseFilterId;}
    if(edits===2&&!reading&&variant==='pause_after_second')controlAssignmentExecutionV2({binding,command_id:'pause-after-second',expected_command_id:null,action:'pause'});
    const view:any={id:42,name:'Equipment schedule',isTemplate:false,viewType:'Schedule',phase:{id:reads===3&&variant==='mismatch_on_refresh'?99:currentPhase,name:'New Construction'},phaseFilter:{id:currentFilter,name:'New Only'}};
    const payload={status:reading?'Ok':'Success',action:reading?'get':args.body.action,dryRun:false,view,
     ...(!reading?{transaction:{status:'committed',committed:true,modified_element_ids:[42],affected_element_ids:[42],added_element_ids:[],deleted_element_ids:[]},changeTracking:{documentChangedObserved:true,exhaustiveChangeInventory:true,eventCount:1,matchingEventCount:1,distinctWrapperMatchCount:1,captureFailureCount:0}}:{})};
    const op=state().operations[lease.operation_id]!;
    return {content:[{type:'text',text:JSON.stringify(payload)}],structuredContent:{schema:'revit-operator.assignment-kernel-mcp-result/v2',
     operation_result_v2:{schema:'revit-operator.operation-result/v2',result_id:'result:'+lease.operation_id,operation_id:lease.operation_id,binding,
      status:'succeeded',dispatch_state:'dispatched',persistent_effect:reading?'none':'applied',native_transaction_state:reading?'not_applicable':'committed',authority:'native-host',
      affected_target_identities:reading?[]:['element_id:42'],result_schema_id:'operator-native/POST:/revit/visibility/v2',observation_required:true,
      raw_payload_hash:createHash('sha256').update(canonicalJsonV2(payload)).digest('hex'),receipt_id:'receipt:'+lease.operation_id,native_correlation_id:'native:'+lease.operation_id,
      request_identity:lease.request_identity,completed_at:new Date().toISOString()},
     observation:{raw_payload:payload,semantic_facts:[{fact_id:op.fulfillment_role==='verification'?'verification.result_available':'control.result_available',fact_class:op.fulfillment_role==='verification'?'verification':'control',value:true}],verification_relevance:['control']}}};
   }};
  const owner=beginTeammateLoopOwner(runtime,{version:'operator.backend.v1',session_id:binding.session_id,message_id:'phasing-task',user_text:goal.objective,assignment_id:binding.assignment_id,assignment_run_id:binding.run_id,assignment_generation:binding.generation}as any,{canonicalSupervisionOnly:true});
  try{
   const response:any=await handleCodexDynamicToolCall(runtime,{id:'phase-edit',method:'item/tool/call',params:{namespace:'revit_operator',turnId:'phase-turn',tool:'revit_call_tool',arguments:{method:'POST',path:'/revit/visibility',body:{action,viewId:42,...selector,dryRun:false}}}}as any);
   assert.equal(response.success,true);
   const first=Object.values(state().operations).find(o=>o.requested_effect==='apply')!;
   assert(checkedEditIsCurrentV2(state(),first.operation_id),'first separate native read established the phase');
   const second:any=await handleCodexDynamicToolCall(runtime,{id:'second-edit',method:'item/tool/call',params:{namespace:'revit_operator',turnId:'phase-turn',tool:'revit_call_tool',arguments:{method:'POST',path:'/revit/visibility',body:variant==='superseded_property'?{action:'set_phase',viewId:42,phaseId:22,dryRun:false}:{action:'set_phase_filter',viewId:42,phaseFilterId:51,dryRun:false}}}}as any);
   assert.equal(second.success,true);const s=state(),applies=Object.values(s.operations).filter(o=>o.requested_effect==='apply');
   assert.equal(applies.length,2,'no repeated edit to obtain proof');assert.equal(edits,2);
   assert.equal(calls.filter(c=>c.body.action==='get').length,variant==='pause_after_second'?1:variant==='superseded_property'?2:3,'each edit checks once; only applicable stale check refreshes');
   assert.equal(checkedEditIsCurrentV2(s,first.operation_id),variant==='two_properties');
   assert.equal(checkedEditIsCurrentV2(s,applies[1]!.operation_id),variant!=='pause_after_second');
   if(variant==='mismatch_on_refresh')assert.equal(first.verification_operation_ids.length+1,s.operations[first.operation_id]!.verification_operation_ids.length,'one mismatching fresh check retained without a read loop');
   if(variant==='failed_refresh')assert.equal(Object.values(s.operations).filter(o=>o.requested_effect==='read'&&(o.input.body as any)?.action==='get').length,3,'failed read attempt retained without a read loop');
   const index=JSON.parse(codexAssignmentEvidenceContextV2(s));
   assert.equal(index.pending_verification.some((p:any)=>p.operation_id===first.operation_id),variant!=='two_properties');
   if(variant==='mismatch_on_refresh'){
    assert.equal(index.pending_verification.find((p:any)=>p.operation_id===first.operation_id).check_state,'previous_check_stale');
    assert(visibilityCheckNeedsRefreshV2(s,s.operations[first.operation_id]!));
    assert.deepEqual(committedVisibilityReadbackPlanV2(s,s.operations[first.operation_id]!),{method:'POST',path:'/revit/visibility',body:{action:'get',viewId:42}});
    for(const [name,mutate]of Object.entries({
     changed_input:(x:any):void=>{x.input_invalidated_operation_ids=[first.operation_id];},
     paused:(x:any)=>x.execution_control={...x.execution_control,state:'paused'},
     unknown_effect:(x:any)=>x.unresolved_unknown_operation_ids=['unknown'],
     in_flight:(x:any)=>x.in_flight_operation_ids=['running'],
     foreign_binding:(x:any)=>x.current_binding={...x.current_binding,run_id:'other'},
     terminal:(x:any):void=>{x.terminal=true;},
     awaiting_review:(x:any)=>x.completion_proposal={proposal_id:'review'},
     superseded_property:(x:any)=>x.operations[applies[1]!.operation_id].input.body={action:'set_phase',viewId:42,phaseId:22},
     unsupported_later_edit:(x:any)=>x.operations[applies[1]!.operation_id].input.body={action:'unknown_action',viewId:42}
    })){
     const altered:any=structuredClone(s);mutate(altered);
     assert.equal(visibilityCheckNeedsRefreshV2(altered,altered.operations[first.operation_id]),false,name);
     assert.equal(committedVisibilityReadbackPlanV2(altered,altered.operations[first.operation_id]),null,name);
     if(name==='changed_input')assert(!JSON.parse(codexAssignmentEvidenceContextV2(altered)).pending_verification.some((p:any)=>p.operation_id===first.operation_id),'obsolete intent not advertised as corrective work');
    }
   }
   assert.deepEqual(new AssignmentJournalV2(getGoal(goal.id)!.assignment_kernel_v2!.events).snapshot(),s);
  }finally{endTeammateLoopOwner(owner);}
 });}finally{__testOnlyResetGoalListCache();__closeForTests();for(const[k,v]of Object.entries(old)){if(v===undefined)delete process.env[k];else process.env[k]=v;}fs.rmSync(root,{recursive:true,force:true});}
});
