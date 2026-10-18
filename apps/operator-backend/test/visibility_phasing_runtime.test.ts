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
import {__closeForTests}from '../src/memory/sqlite_store.js';

for(const variant of ['filter_id','filter_name','phase_id','phase_name','wrong_value','wrong_view','echo','partial','failed_read','paused','stale_read','forged_positive_fact']as const)
test(`ordinary post-edit phasing ${variant}: one bounded native check, no repeated mutation`,async()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'operator-phasing-check-'));
 const env={OPERATOR_WORKSPACE_ROOT:root,REVIT_OPERATOR_MODE:'development',OPERATOR_LOCAL_EXECUTOR_PROFILE:'codex_v2_advisory_v1',OPERATOR_ASSIGNMENT_KERNEL_V2:'1',OPERATOR_BRAIN:'codex',OPERATOR_TOOL_EXPOSURE_PROFILE:'laboratory',OPERATOR_HOSTED_ENABLED:'0'};
 const old=Object.fromEntries(Object.keys(env).map(k=>[k,process.env[k]]));Object.assign(process.env,env);__testOnlyResetGoalListCache();
 try{await runWithRequestContext({operator_backend_auth:createOperatorBackendAuth('shared_token','test-only')},async()=>{
  const goal=createGoal({title:'Set schedule phasing',objective:'Use the requested native phase setting on the equipment schedule.',acceptance_criteria:['The assigned phase setting is checked.'],status:'active',related_session_id:'phasing-session',created_by:'local-host',work_budget:{requested_effect:'apply',document_fingerprint:'phasing-model'}});
  createAssignmentKernelForGoalV2({goal,run_id:'phasing-run'});const state=()=>getAssignmentKernelSnapshotV2(goal.id)!,binding=state().current_binding;
  const calls:any[]=[],phase=variant.startsWith('phase_'),field=phase?'phase':'phaseFilter',action=phase?'set_phase':'set_phase_filter';
  const selector=variant.endsWith('_name')?{[field+'Name']:phase?'New Construction':'New Only'}:{[field+'Id']:phase?21:51};
  const runtime:any={assignmentKernelV2Binding:()=>binding,queueAssignmentKernelV2TurnStop(){},async validateToolArguments(){},
   async callTool(_tool:string,args:any,context:any){
    calls.push(args);const lease=context.assignmentKernelV2;context.onMcpAccepted();const reading=args.body.action==='get';
    if(reading&&variant==='failed_read')throw Error('retained_native_read_failure');
    if(!reading&&variant==='paused')controlAssignmentExecutionV2({binding,command_id:'pause-after-commit',expected_command_id:null,action:'pause'});
    const view:any={id:variant==='wrong_view'&&reading?43:42,name:'Equipment schedule',isTemplate:false,viewType:'Schedule',phase:{id:21,name:'New Construction'},phaseFilter:{id:51,name:'New Only'}};
    if(reading&&['wrong_value','forged_positive_fact'].includes(variant))view.phaseFilter.id=52;
    if(reading&&variant==='partial')delete view.phaseFilter;
    const payload={status:reading&&variant!=='echo'?'Ok':'Success',action:reading&&variant!=='echo'?'get':action,dryRun:false,view,
     ...(!reading?{transaction:{status:'committed',committed:true,modified_element_ids:[42],affected_element_ids:[42],added_element_ids:[],deleted_element_ids:[]},changeTracking:{documentChangedObserved:true,exhaustiveChangeInventory:true,eventCount:1,matchingEventCount:1,distinctWrapperMatchCount:1,captureFailureCount:0}}:{})};
    const op=state().operations[lease.operation_id]!;
    return {content:[{type:'text',text:JSON.stringify(payload)}],structuredContent:{schema:'revit-operator.assignment-kernel-mcp-result/v2',
     operation_result_v2:{schema:'revit-operator.operation-result/v2',result_id:'result:'+lease.operation_id,operation_id:lease.operation_id,binding,
      status:'succeeded',dispatch_state:'dispatched',persistent_effect:reading?'none':'applied',native_transaction_state:reading?'not_applicable':'committed',authority:'native-host',
      affected_target_identities:reading?[]:['element_id:42'],result_schema_id:'operator-native/POST:/revit/visibility/v2',observation_required:true,
      raw_payload_hash:createHash('sha256').update(canonicalJsonV2(payload)).digest('hex'),receipt_id:'receipt:'+lease.operation_id,native_correlation_id:'native:'+lease.operation_id,
      request_identity:lease.request_identity,completed_at:reading&&variant==='stale_read'?'2020-01-01T00:00:00Z':new Date().toISOString()},
     observation:{raw_payload:payload,semantic_facts:[...(reading&&variant==='forged_positive_fact'?[{fact_id:'verification.postcondition_satisfied',fact_class:'verification',value:true}]:[]),{fact_id:op.fulfillment_role==='verification'?'verification.result_available':'control.result_available',fact_class:op.fulfillment_role==='verification'?'verification':'control',value:true}],verification_relevance:['control']}}};
   }};
  const owner=beginTeammateLoopOwner(runtime,{version:'operator.backend.v1',session_id:binding.session_id,message_id:'phasing-task',user_text:goal.objective,assignment_id:binding.assignment_id,assignment_run_id:binding.run_id,assignment_generation:binding.generation}as any,{canonicalSupervisionOnly:true});
  try{
   const response:any=await handleCodexDynamicToolCall(runtime,{id:'phase-edit',method:'item/tool/call',params:{namespace:'revit_operator',turnId:'phase-turn',tool:'revit_call_tool',arguments:{method:'POST',path:'/revit/visibility',body:{action,viewId:42,...selector,dryRun:false}}}}as any);
   assert.equal(response.success,true);const s=state(),apply=Object.values(s.operations).find(o=>o.requested_effect==='apply')!;
   assert.equal(apply.persistent_effect,'applied');assert.equal(calls.filter(c=>c.body.action===action).length,1);
   assert.equal(calls.filter(c=>c.body.action==='get').length,variant==='paused'?0:1);
   assert.equal(checkedEditIsCurrentV2(s,apply.operation_id),['filter_id','filter_name','phase_id','phase_name'].includes(variant));
   assert.deepEqual(new AssignmentJournalV2(getGoal(goal.id)!.assignment_kernel_v2!.events).snapshot(),s);
  }finally{endTeammateLoopOwner(owner);}
 });}finally{__testOnlyResetGoalListCache();__closeForTests();for(const[k,v]of Object.entries(old)){if(v===undefined)delete process.env[k];else process.env[k]=v;}fs.rmSync(root,{recursive:true,force:true});}
});
