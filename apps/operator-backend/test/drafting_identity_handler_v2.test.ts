import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import{createHash}from'node:crypto';
import test from'node:test';import assert from'node:assert/strict';
import{createGoal,__testOnlyResetGoalListCache}from'../src/goals/service.js';
import{createAssignmentKernelForGoalV2}from'../src/assignments/assignment_kernel_v2_factory.js';
import{getAssignmentKernelSnapshotV2}from'../src/assignments/assignment_kernel_v2_store.js';
import{beginTeammateLoopOwner,endTeammateLoopOwner}from'../src/teammate_loop_runtime.js';
import{handleCodexDynamicToolCall}from'../src/brains/codex_dynamic_tool_handler.js';
import{runWithRequestContext}from'../src/request_context.js';import{createOperatorBackendAuth}from'../src/operator_backend_auth.js';
import{canonicalJsonV2}from'../src/domain/assignment-kernel/index.js';import{checkedEditIsCurrentV2}from'../src/verification/current_postcondition_v2.js';
import{controlAssignmentExecutionV2}from'../src/assignments/assignment_kernel_v2_controls.js';

for(const variant of ['exact','wrong_scale','wrong_name','read_failure','schema_refused','pause','foreign_receipt','allow_existing']as const)
test(`ordinary new drafting view ${variant} obtains its first separate identity check`,async()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'operator-draft-identity-')),old=process.env.OPERATOR_WORKSPACE_ROOT;process.env.OPERATOR_WORKSPACE_ROOT=root;__testOnlyResetGoalListCache();
 try{await runWithRequestContext({operator_backend_auth:createOperatorBackendAuth('shared_token','test-only')},async()=>{
  const input={method:'POST',path:'/revit/create-drafting-view',body:{name:'Vector working detail',scale:100,allowExisting:variant==='allow_existing'}};
  const applied={created:true,success:true,applied:true,ok:true,status:'Success',viewId:20,name:input.body.name,scale:100,viewType:'DraftingView',
   transaction:{status:'committed',committed:true,added_element_ids:[20],modified_element_ids:[],deleted_element_ids:[],affected_element_ids:[20]},
   changeTracking:{documentChangedObserved:true,exhaustiveChangeInventory:true,eventCount:1,matchingEventCount:1,distinctWrapperMatchCount:1,captureFailureCount:0}};
  const goal=createGoal({title:'Copy vector detail',objective:'Create the working drafting view for this diagram.',acceptance_criteria:['Working view identity is verified.'],status:'active',related_session_id:'draft-session',created_by:'test-principal',work_budget:{requested_effect:'apply',document_fingerprint:'a'.repeat(64)}});
  createAssignmentKernelForGoalV2({goal,run_id:'draft-run'});const binding=getAssignmentKernelSnapshotV2(goal.id)!.current_binding,calls:any[]=[];
  const runtime:any={assignmentKernelV2Binding:()=>binding,queueAssignmentKernelV2TurnStop(){},async validateToolArguments(_t:string,args:any){if(args.path==='/revit/get-element-summary'&&variant==='schema_refused')throw Error('identity_schema_refused');},async callTool(_t:string,args:any,ctx:any){
   calls.push(args);ctx.onMcpAccepted();const reading=args.path==='/revit/get-element-summary',lease=ctx.assignmentKernelV2;
   if(reading&&variant==='read_failure')throw Error('identity_native_read_failed');
   const payload=reading?[{id:20,found:true,uniqueId:'native-view-20',className:'ViewDrafting',fullClassName:'Autodesk.Revit.DB.ViewDrafting',name:variant==='wrong_name'?'Another detail':input.body.name,viewType:'DraftingView',viewScale:variant==='wrong_scale'?200:100}]:applied;
   if(!reading&&variant==='pause')controlAssignmentExecutionV2({binding,command_id:'pause-after-create',expected_command_id:null,action:'pause'});
   return{content:[{type:'text',text:JSON.stringify(payload)}],structuredContent:{schema:'revit-operator.assignment-kernel-mcp-result/v2',operation_result_v2:{schema:'revit-operator.operation-result/v2',result_id:'result:'+lease.operation_id,operation_id:lease.operation_id,binding,status:'succeeded',dispatch_state:'dispatched',persistent_effect:reading?'none':'applied',native_transaction_state:reading?'not_applicable':'committed',authority:!reading&&variant==='foreign_receipt'?'model':'native-host',affected_target_identities:['element_id:20'],result_schema_id:'operator-native/POST:'+args.path+'/v2',observation_required:true,raw_payload_hash:createHash('sha256').update(canonicalJsonV2(payload)).digest('hex'),receipt_id:'receipt:'+lease.operation_id,native_correlation_id:'native:'+lease.operation_id,request_identity:lease.request_identity,completed_at:new Date().toISOString()},observation:{raw_payload:payload,semantic_facts:[{fact_id:'control.domain_succeeded',fact_class:'control',value:true}],verification_relevance:['control']}}};
  }};
  const owner=beginTeammateLoopOwner(runtime,{version:'operator.backend.v1',session_id:binding.session_id,message_id:'draft-task',user_text:goal.objective,assignment_id:binding.assignment_id,assignment_run_id:binding.run_id,assignment_generation:binding.generation}as any,{canonicalSupervisionOnly:true});
  try{await handleCodexDynamicToolCall(runtime,{id:'create',method:'item/tool/call',params:{namespace:'revit_operator',tool:'revit_call_tool',turnId:'draft-turn',arguments:input}}as any);
   const snapshot=getAssignmentKernelSnapshotV2(goal.id)!,op=Object.values(snapshot.operations).find(o=>o.requested_effect==='apply')!;
   assert.equal(calls.filter(c=>c.path===input.path).length,1,'Never repeat creation');
   assert.equal(calls.filter(c=>c.path==='/revit/get-element-summary').length,['schema_refused','pause','foreign_receipt','allow_existing'].includes(variant)?0:1,'One ordinary separate initial identity read');
   assert.equal(checkedEditIsCurrentV2(snapshot,op.operation_id),variant==='exact','Only matching native read verifies the identity');
  }finally{endTeammateLoopOwner(owner);}
 });}finally{if(old===undefined)delete process.env.OPERATOR_WORKSPACE_ROOT;else process.env.OPERATOR_WORKSPACE_ROOT=old;__testOnlyResetGoalListCache();fs.rmSync(root,{recursive:true,force:true});}
});
