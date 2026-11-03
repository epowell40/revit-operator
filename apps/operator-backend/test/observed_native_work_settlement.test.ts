import test from'node:test';import assert from'node:assert/strict';import fs from'node:fs';import os from'node:os';import path from'node:path';import{createHash}from'node:crypto';
import{observedFixture,observedFact}from'./observed_work_fixture.js';
import{createGoal,__testOnlyResetGoalListCache}from'../src/goals/service.js';import{__closeForTests}from'../src/memory/sqlite_store.js';
import{createAssignmentKernelForGoalV2}from'../src/assignments/assignment_kernel_v2_factory.js';
import{getAssignmentKernelSnapshotV2}from'../src/assignments/assignment_kernel_v2_store.js';
import{openAssignmentKernelOperationV2,markAssignmentKernelOperationDispatchStartedV2,settleAssignmentKernelOperationV2}from'../src/assignments/assignment_kernel_v2_execution.js';
import{runWithRequestContext}from'../src/request_context.js';import{createOperatorBackendAuth}from'../src/operator_backend_auth.js';
import{canonicalJsonV2,appliedOperationHasVerifiedPostconditionV2}from'../src/domain/assignment-kernel/index.js';
import{assignmentWorkAllowanceV2}from'../src/assignments/assignment_work_allowance_v2.js';
import{selectLocalAdvisoryPolicy}from'../src/assignments/local_advisory_policy.js';
test('real settlement derives observed fuel from native data and strips injected caller claims without passing a C# postcondition',async()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'observed-settlement-'));
 const env={OPERATOR_WORKSPACE_ROOT:root,REVIT_OPERATOR_MODE:'development',OPERATOR_MODE:'development',OPERATOR_HOSTED_ENABLED:'0',OPERATOR_ASSIGNMENT_KERNEL_V2:'1',OPERATOR_BRAIN:'codex',OPERATOR_TOOL_EXPOSURE_PROFILE:'laboratory',OPERATOR_LOCAL_EXECUTOR_PROFILE:'codex_v2_advisory_v1',OPERATOR_LOCAL_PROGRESS_ALLOWANCE:'observed_native_work_v1',OPERATOR_LOCAL_READY_WORK_HANDOFF:'continue_ready_work_v1'};
 const before=Object.fromEntries(Object.keys(env).map(k=>[k,process.env[k]]));Object.assign(process.env,env);__testOnlyResetGoalListCache();
 try{await runWithRequestContext({operator_backend_auth:createOperatorBackendAuth('shared_token','test-only',{OPERATOR_API_BASE_URL:'http://127.0.0.1:7007'})},async()=>{
  const goal=createGoal({title:'Draft from a reference',objective:'Reconstruct the requested duct branches from the reference drawing.',acceptance_criteria:['The drawing is checked.'],status:'active',created_by:'local-host',related_session_id:'observed-session',work_budget:{requested_effect:'apply',document_fingerprint:'disposable-document'}});
  const binding=createAssignmentKernelForGoalV2({goal,run_id:'observed-test'}),state=()=>getAssignmentKernelSnapshotV2(goal.id)!;
  assert.equal(state().spec.execution_policy?.progress_allowance?.mode,'observed_native_work_v1');
  assert.equal(selectLocalAdvisoryPolicy(state().current_binding,{...process.env,OPERATOR_HOSTED_ENABLED:'1'},undefined,'apply'),undefined);
  assert.equal(selectLocalAdvisoryPolicy(state().current_binding,process.env,undefined,'read')?.progress_allowance,undefined);
  assert.equal(selectLocalAdvisoryPolicy(state().current_binding,{...process.env,OPERATOR_LOCAL_READY_WORK_HANDOFF:''},undefined,'apply')?.progress_allowance,undefined);
  assert.equal(selectLocalAdvisoryPolicy(state().current_binding,{...process.env,OPERATOR_LOCAL_PROGRESS_ALLOWANCE:''},undefined,'apply')?.progress_allowance,undefined);
  const settle=(lease:any,payload:any,effect:'applied'|'none',affected:string[]=[])=>{
   markAssignmentKernelOperationDispatchStartedV2(lease);const op=state().operations[lease.operation_id]!;
   const result={schema:'revit-operator.operation-result/v2',result_id:'r:'+lease.operation_id,operation_id:lease.operation_id,binding:lease.binding,status:'succeeded',dispatch_state:'dispatched',persistent_effect:effect,native_transaction_state:effect==='applied'?'committed':'not_applicable',authority:'native-host',result_schema_id:`operator-native/${op.request_identity?.method}:${op.request_identity?.path}/v2`,observation_required:true,raw_payload_hash:createHash('sha256').update(canonicalJsonV2(payload)).digest('hex'),receipt_id:'receipt:'+lease.operation_id,native_correlation_id:'native:'+lease.operation_id,request_identity:op.request_identity,completed_at:new Date().toISOString(),affected_target_identities:affected};
   settleAssignmentKernelOperationV2(lease,{content:[],structuredContent:{schema:'revit-operator.assignment-kernel-mcp-result/v2',operation_result_v2:result,observation:{raw_payload:payload,semantic_facts:[{fact_id:'control.domain_succeeded',fact_class:'control',value:true},{fact_id:observedFact,fact_class:'control',value:['element_id:99'],cardinality:'many'}]}}});
   return state().operations[lease.operation_id]!;
  };
  const mutation=openAssignmentKernelOperationV2({snapshot:state(),provider_turn_id:'test',controller_request_id:'mutation',capability_id:'operator_run_dynamic_revit_program',classified_effect:'apply',target_tokens:['id:11','id:12'],arguments:{mode:'apply',source:'native program unit fixture',native_program:{entry_type:'Program',allowed_existing_unique_ids:['uid-11']}}});
  settle(mutation,{status:'Applied',nativeReceipt:'synthetic native execution fixture'},'applied',['element_id:11','element_id:12','element_id:200']);
  const{payload}=observedFixture();
  for(let i=0;i<2;i++){
   const lease=openAssignmentKernelOperationV2({snapshot:state(),provider_turn_id:'test',controller_request_id:'read-'+i,capability_id:'revit_call_tool',classified_effect:'read',target_tokens:['id:11','id:12','id:99'],arguments:{method:'POST',path:'/revit/get-connectors',body:{elementIds:[11,12,99]}}});
   const read=settle(lease,payload,'none');
   const facts=read.observation_ids.flatMap(id=>state().observations[id]!.facts.filter(f=>f.fact_id===observedFact));
   assert.equal(facts.length,1);assert.deepEqual(facts[0]!.value,['element_id:11','element_id:12'],'caller99 is not a changed native target');
   assert.equal(read.verification_of_operation_id,undefined);assert.equal((assignmentWorkAllowanceV2(state())as any).observed_targets,2);
  }
  assert.equal(appliedOperationHasVerifiedPostconditionV2(state(),mutation.operation_id),false);
  assert.equal(state().outcome,'active');assert.equal(state().terminal,false);
 });}finally{__testOnlyResetGoalListCache();__closeForTests();for(const[k,v]of Object.entries(before)){if(v===undefined)delete process.env[k];else process.env[k]=v;}assert(path.resolve(root).startsWith(path.resolve(os.tmpdir())+path.sep));fs.rmSync(root,{recursive:true});}
});
