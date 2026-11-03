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
const retained=JSON.parse(fs.readFileSync(path.resolve('test/fixtures/template-assignment162.json'),'utf8'));
for(const variant of ['exact162','detach','wrong_name','wrong_id','wrong_view','missing_id','missing_commit_identity','read_failure','paused','stale','foreign_authority','wrong_digest','extra_owner','forged_positive']as const)
test(`template host readback ${variant}: one edit and one independent admitted check`,async()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'operator-template-check-'));
 const env={OPERATOR_WORKSPACE_ROOT:root,REVIT_OPERATOR_MODE:'development',OPERATOR_LOCAL_EXECUTOR_PROFILE:'codex_v2_advisory_v1',OPERATOR_ASSIGNMENT_KERNEL_V2:'1',OPERATOR_BRAIN:'codex',OPERATOR_TOOL_EXPOSURE_PROFILE:'laboratory',OPERATOR_HOSTED_ENABLED:'0'};
 const old=Object.fromEntries(Object.keys(env).map(k=>[k,process.env[k]]));Object.assign(process.env,env);__testOnlyResetGoalListCache();
 try{await runWithRequestContext({operator_backend_auth:createOperatorBackendAuth('shared_token','test-only')},async()=>{
  const goal=createGoal({title:'Assign requested view template',objective:'Assign the requested template to the existing view and verify it.',acceptance_criteria:['The assigned template is checked.'],status:'active',related_session_id:'template-session',created_by:'local-host',work_budget:{requested_effect:'apply',document_fingerprint:'template-model'}});
  createAssignmentKernelForGoalV2({goal,run_id:'template-run'});const state=()=>getAssignmentKernelSnapshotV2(goal.id)!,binding=state().current_binding,calls:any[]=[];
  const input=structuredClone(retained.applyInput);if(variant==='detach')input.body.templateName='';
  const runtime:any={assignmentKernelV2Binding:()=>binding,queueAssignmentKernelV2TurnStop(){},async validateToolArguments(){},
   async callTool(_tool:string,args:any,context:any){
    calls.push(args);const lease=context.assignmentKernelV2;context.onMcpAccepted();const reading=args.body.action==='get';
    if(reading&&variant==='read_failure')throw Error('retained_native_read_failure');
    if(!reading&&variant==='paused')controlAssignmentExecutionV2({binding,command_id:'pause-after-commit',expected_command_id:null,action:'pause'});
    const payload:any=structuredClone(retained.payload);
    if(variant==='detach'){payload.view.viewTemplate=null;payload.view.viewTemplateId=-1;}
    if(!reading){payload.status='Success';payload.success=true;payload.action='set_template';Object.assign(payload,{transaction:{status:'committed',committed:true,modified_element_ids:variant==='extra_owner'?[1363413,1521731]:[1363413],affected_element_ids:variant==='extra_owner'?[1363413,1521731]:[1363413],added_element_ids:[],deleted_element_ids:[]},changeTracking:{documentChangedObserved:true,exhaustiveChangeInventory:true,eventCount:1,matchingEventCount:1,distinctWrapperMatchCount:1,captureFailureCount:0}});}
    if(reading&&['wrong_name','forged_positive'].includes(variant))payload.view.viewTemplate='Different Template';
    if(reading&&variant==='wrong_view')payload.view.id++;
    if(reading&&variant==='missing_id')delete payload.view.viewTemplateId;
    if(reading&&variant==='wrong_id')payload.view.viewTemplateId++;
    if(!reading&&variant==='missing_commit_identity')delete payload.view.viewTemplateId;
    return {content:[{type:'text',text:JSON.stringify(payload)}],structuredContent:{schema:'revit-operator.assignment-kernel-mcp-result/v2',
     operation_result_v2:{schema:'revit-operator.operation-result/v2',result_id:'result:'+lease.operation_id,operation_id:lease.operation_id,binding,
      status:'succeeded',dispatch_state:'dispatched',persistent_effect:reading?'none':'applied',native_transaction_state:reading?'not_applicable':'committed',authority:reading&&variant==='foreign_authority'?'model':'native-host',
      affected_target_identities:reading?[]:variant==='extra_owner'?['element_id:1363413','element_id:1521731']:['element_id:1363413'],result_schema_id:'operator-native/POST:/revit/visibility/v2',observation_required:true,
      raw_payload_hash:reading&&variant==='wrong_digest'?'0'.repeat(64):createHash('sha256').update(canonicalJsonV2(payload)).digest('hex'),receipt_id:'receipt:'+lease.operation_id,native_correlation_id:'native:'+lease.operation_id,
      request_identity:lease.request_identity,completed_at:reading&&variant==='stale'?'2020-01-01T00:00:00Z':new Date().toISOString()},
     observation:{raw_payload:payload,semantic_facts:[...(reading&&variant==='forged_positive'?[{fact_id:'verification.postcondition_satisfied',fact_class:'verification',value:true}]:[]),{fact_id:'control.result_available',fact_class:'control',value:true}],verification_relevance:['control']}}};
   }};
  const owner=beginTeammateLoopOwner(runtime,{version:'operator.backend.v1',session_id:binding.session_id,message_id:'template-task',user_text:goal.objective,assignment_id:binding.assignment_id,assignment_run_id:binding.run_id,assignment_generation:binding.generation}as any,{canonicalSupervisionOnly:true});
  try{
   const response:any=await handleCodexDynamicToolCall(runtime,{id:'template-edit',method:'item/tool/call',params:{namespace:'revit_operator',turnId:'template-turn',tool:'revit_call_tool',arguments:input}}as any);
   assert.equal(response.success,true);const s=state(),apply=Object.values(s.operations).find(o=>o.requested_effect==='apply')!;
   assert.equal(apply.persistent_effect,'applied');assert.equal(calls.filter(c=>c.body.action==='set_template').length,1);
   assert.equal(calls.filter(c=>c.body.action==='get').length,variant==='paused'?0:1);
   assert.equal(checkedEditIsCurrentV2(s,apply.operation_id),['exact162','detach'].includes(variant));
   assert.deepEqual(new AssignmentJournalV2(getGoal(goal.id)!.assignment_kernel_v2!.events).snapshot(),s);
  }finally{endTeammateLoopOwner(owner);}
 });}finally{__testOnlyResetGoalListCache();__closeForTests();for(const[k,v]of Object.entries(old)){if(v===undefined)delete process.env[k];else process.env[k]=v;}assert.equal(path.dirname(root),path.resolve(os.tmpdir()));fs.rmSync(root,{recursive:true,force:true});}
});
