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

import {identity,signature} from './fixtures/created_schedule_native_shape.js';

for(const variant of ['regular','clone','missing_field','wrong_name','wrong_unique_id','wrong_category','changed_clone_filter','incomplete_clone','echo','failed_read','paused','old_receipt','placement','stale_read','forged_positive_fact','duplicate_view','duplicate_view_old_receipt','duplicate_view_changed_style','duplicate_view_non_schedule','duplicate_view_wrong_source']as const)
test(`created schedule ${variant}: exact native readback without a duplicate creation`,async()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'operator-created-schedule-'));
 const env={OPERATOR_WORKSPACE_ROOT:root,REVIT_OPERATOR_MODE:'development',OPERATOR_LOCAL_EXECUTOR_PROFILE:'codex_v2_advisory_v1',OPERATOR_ASSIGNMENT_KERNEL_V2:'1',OPERATOR_BRAIN:'codex',OPERATOR_TOOL_EXPOSURE_PROFILE:'laboratory',OPERATOR_HOSTED_ENABLED:'0'};
 const old=Object.fromEntries(Object.keys(env).map(k=>[k,process.env[k]]));Object.assign(process.env,env);__testOnlyResetGoalListCache();
 try{await runWithRequestContext({operator_backend_auth:createOperatorBackendAuth('shared_token','test-only')},async()=>{
  const goal=createGoal({title:'Create an equipment schedule',objective:'Create Equipment Review and check its actual definition.',acceptance_criteria:['The created schedule definition matches the request.'],status:'active',related_session_id:'creation-session',created_by:'local-host',work_budget:{requested_effect:'apply',document_fingerprint:'creation-model'}});
  createAssignmentKernelForGoalV2({goal,run_id:'creation-run'});const state=()=>getAssignmentKernelSnapshotV2(goal.id)!,binding=state().current_binding;
  const calls:any[]=[],duplicate=variant.startsWith('duplicate_view'),clone=duplicate||['clone','changed_clone_filter','incomplete_clone'].includes(variant);
  const runtime:any={assignmentKernelV2Binding:()=>binding,queueAssignmentKernelV2TurnStop(){},async validateToolArguments(){},async callTool(_tool:string,args:any,context:any){
   calls.push(args);const lease=context.assignmentKernelV2;context.onMcpAccepted();const reading=args.path==='/revit/schedules';
   if(reading&&variant==='failed_read')throw Error('retained_native_read_failure');
   if(!reading&&variant==='paused')controlAssignmentExecutionV2({binding,command_id:'pause-after-creation',expected_command_id:null,action:'pause'});
   const meta=identity();if(reading&&variant==='wrong_name')meta.name='Different schedule';if(reading&&variant==='wrong_unique_id')meta.uniqueId='replaced-schedule';if(reading&&variant==='wrong_category')meta.categoryId=-456;
   const snap=signature();if(variant==='changed_clone_filter')snap.definition.filters.push({fieldIndex:0,op:'BeginsWith',value:'P'}as never);if(variant==='incomplete_clone')snap.complete=false;
   const payload:any=reading?{status:'Ok',action:'detail',schedule:{id:42,uniqueId:meta.uniqueId,name:meta.name,viewType:'Schedule',isTemplate:false,fieldCount:['missing_field','forged_positive_fact'].includes(variant)?0:1},definitionIdentity:meta,definitionSnapshot:snap,fields:['missing_field','forged_positive_fact'].includes(variant)?[]:[{index:0,fieldId:0,name:'Mark',isHidden:false}],filterDefinitionsComplete:true,filterDefinitions:[],sortGroupDefinitionsComplete:true,sortGroupDefinitions:[],settings:{filterBySheet:false}}
    :{status:'Success',success:true,applied:true,created:true,viewId:42,schedule:{id:42,name:'Equipment Review'},definitionIdentity:meta,categoryResolution:{categoryId:-123,error:null},sourceDefinitionBefore:clone?signature(41,'Source Equipment'):null,transaction:{status:'committed',committed:true,modified_element_ids:[],affected_element_ids:[42],added_element_ids:[42],deleted_element_ids:[]},changeTracking:{documentChangedObserved:true,exhaustiveChangeInventory:true,eventCount:1,matchingEventCount:1,distinctWrapperMatchCount:1,captureFailureCount:0}};
   if(reading&&variant==='echo'){payload.status='Success';payload.action='create';}
   if(duplicate&&!reading){payload.sourceViewId=41;payload.sourceViewType=variant==='duplicate_view_non_schedule'?'FloorPlan':'Schedule';}
   if(!reading&&['old_receipt','duplicate_view_old_receipt','duplicate_view_non_schedule'].includes(variant)){delete payload.definitionIdentity;delete payload.sourceDefinitionBefore;}
   if(!reading&&variant==='duplicate_view_wrong_source')payload.sourceDefinitionBefore.identity.id=9;
   if(reading&&variant==='duplicate_view_changed_style')payload.definitionSnapshot.definition.tableStyles[0].values.FontName='Other';
   const op=state().operations[lease.operation_id]!;
   return {content:[{type:'text',text:JSON.stringify(payload)}],structuredContent:{schema:'revit-operator.assignment-kernel-mcp-result/v2',operation_result_v2:{schema:'revit-operator.operation-result/v2',result_id:'result:'+lease.operation_id,operation_id:lease.operation_id,binding,status:'succeeded',dispatch_state:'dispatched',persistent_effect:reading?'none':'applied',native_transaction_state:reading?'not_applicable':'committed',authority:'native-host',affected_target_identities:reading?[]:['element_id:42'],result_schema_id:'operator-native/POST:'+args.path+'/v2',observation_required:true,raw_payload_hash:createHash('sha256').update(canonicalJsonV2(payload)).digest('hex'),receipt_id:'receipt:'+lease.operation_id,native_correlation_id:'native:'+lease.operation_id,request_identity:lease.request_identity,completed_at:reading&&variant==='stale_read'?'2020-01-01T00:00:00Z':new Date().toISOString()},observation:{raw_payload:payload,semantic_facts:[...(reading&&variant==='forged_positive_fact'?[{fact_id:'verification.postcondition_satisfied',fact_class:'verification',value:true}]:[]),{fact_id:op.fulfillment_role==='verification'?'verification.result_available':'control.result_available',fact_class:op.fulfillment_role==='verification'?'verification':'control',value:true}],verification_relevance:['control']}}};
  }};
  const owner=beginTeammateLoopOwner(runtime,{version:'operator.backend.v1',session_id:binding.session_id,message_id:'creation-task',user_text:goal.objective,assignment_id:binding.assignment_id,assignment_run_id:binding.run_id,assignment_generation:binding.generation}as any,{canonicalSupervisionOnly:true});
  try{
   const request=duplicate?{method:'POST',path:'/revit/duplicate-view',body:{viewId:41,newName:'Equipment Review',withDetailing:false}}:{method:'POST',path:'/revit/create-schedule',body:{name:'Equipment Review',...(clone?{kind:'clone',sourceScheduleId:41}:{category:'Test Category',fields:['Mark']}),reuseIfExists:false,dryRun:false,...(variant==='placement'?{placeOnSheet:{sheetId:11,x:1,y:1}}:{})}};
   const response:any=await handleCodexDynamicToolCall(runtime,{id:'create-schedule',method:'item/tool/call',params:{namespace:'revit_operator',turnId:'creation-turn',tool:'revit_call_tool',arguments:request}}as any);
   assert.equal(response.success,true);const s=state(),apply=Object.values(s.operations).find(o=>o.requested_effect==='apply')!;
   assert.equal(apply.persistent_effect,'applied');assert.equal(calls.filter(c=>c.path===request.path).length,1);
   assert.equal(calls.filter(c=>c.path==='/revit/schedules').length,['paused','old_receipt','duplicate_view_old_receipt','duplicate_view_non_schedule'].includes(variant)?0:1);
   assert.equal(checkedEditIsCurrentV2(s,apply.operation_id),['regular','clone','duplicate_view'].includes(variant));
   assert.deepEqual(new AssignmentJournalV2(getGoal(goal.id)!.assignment_kernel_v2!.events).snapshot(),s);
  }finally{endTeammateLoopOwner(owner);}
 });}finally{__testOnlyResetGoalListCache();__closeForTests();for(const[k,v]of Object.entries(old)){if(v===undefined)delete process.env[k];else process.env[k]=v;}fs.rmSync(root,{recursive:true,force:true});}
});
