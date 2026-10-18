import assert from 'node:assert/strict';
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import test from 'node:test';
import {createHash} from 'node:crypto';
import {createGoal,__testOnlyResetGoalListCache} from '../src/goals/service.js';
import {createAssignmentKernelForGoalV2} from '../src/assignments/assignment_kernel_v2_factory.js';
import {getAssignmentKernelSnapshotV2} from '../src/assignments/assignment_kernel_v2_store.js';
import {beginTeammateLoopOwner,endTeammateLoopOwner} from '../src/teammate_loop_runtime.js';
import {handleCodexDynamicToolCall} from '../src/brains/codex_dynamic_tool_handler.js';
import {runWithRequestContext} from '../src/request_context.js';
import {createOperatorBackendAuth} from '../src/operator_backend_auth.js';
import {canonicalJsonV2,deriveProgressGapsV2} from '../src/domain/assignment-kernel/index.js';
import {controlAssignmentExecutionV2} from '../src/assignments/assignment_kernel_v2_controls.js';
import {openAssignmentKernelChildOperationV2,markAssignmentKernelOperationDispatchStartedV2,settleAssignmentKernelOperationV2} from '../src/assignments/assignment_kernel_v2_execution.js';
import {circuitFixture} from './circuit_membership.fixtures.js';
for(const mode of ['source','create','move'] as const)
for(const typed of [false,true])
for(const variant of ['exact','missing_target','wrong_value','read_failure','read_schema_rejected','paused_after_commit','stale_read'] as const)
test(`${typed?'typed native-child':'ordinary'} circuit ${mode} ${variant} receives one complete guarded host read`,async()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'operator-host-circuit-check-')),previous=process.env.OPERATOR_WORKSPACE_ROOT;
 process.env.OPERATOR_WORKSPACE_ROOT=root;__testOnlyResetGoalListCache();
 try {await runWithRequestContext({operator_backend_auth:createOperatorBackendAuth('shared_token','test-only')},async()=>{
  const source=circuitFixture(mode),f={input:source.operation.input,read:source.payload},ids=f.input.body.elementIds;
  const goal=createGoal({title:'Connect the selected devices to the requested circuit',objective:'Connect the selected devices to the requested circuit.',acceptance_criteria:['Requested edits established.'],status:'active',
   related_session_id:'circuit-host-session',created_by:'circuit-host-principal',work_budget:{requested_effect:'apply',document_fingerprint:'circuit-model'}});
  createAssignmentKernelForGoalV2({goal,run_id:'circuit-host-run'});const binding=getAssignmentKernelSnapshotV2(goal.id)!.current_binding;
  const calls:any[]=[],validations:any[]=[];
  const runtime:any={assignmentKernelV2Binding:()=>binding,queueAssignmentKernelV2TurnStop(){},
   async validateToolArguments(_tool:string,args:any){validations.push(args);if(variant==='read_schema_rejected'&&args.path==='/revit/get-element-summary')throw Error('read_schema_rejected');},
   async callTool(_tool:string,args:any,context:any){
    const nativeArgs=typed&&_tool==='revit_assign_electrical_circuit'?{method:'POST',path:'/revit/assign-electrical-circuit',body:args}:args;
    calls.push(nativeArgs);let lease=context.assignmentKernelV2;context.onMcpAccepted();const read=nativeArgs.path==='/revit/get-element-summary';
    const parent=lease;
    if(typed&&!read){
     lease=openAssignmentKernelChildOperationV2({binding,parent_operation_id:parent.operation_id,child_ordinal:0,operation_role:'child',
      capability_id:'native:POST:/revit/assign-electrical-circuit',classified_effect:'apply',method:'POST',path:'/revit/assign-electrical-circuit',arguments:nativeArgs,
      fulfillment_role:'delegated_task_execution',delegation_authority_id:parent.delegation_authority_id,eligible_criterion_ids:parent.eligible_criterion_ids});
     markAssignmentKernelOperationDispatchStartedV2(lease);
    }
    if(read&&variant==='read_failure')throw Error('native_read_failed');
    const payload:any=read?structuredClone(f.read):{status:'Applied and Verified',changedElementIds:ids};
    if(read&&variant==='missing_target')payload.items=payload.items.filter((i:any)=>i.id!==ids.at(-1));
    if(read&&variant==='wrong_value')payload.circuits[0].panelElementId=41;
    const op=getAssignmentKernelSnapshotV2(goal.id)!.operations[lease.operation_id]!;
    const envelope:any={content:[{type:'text',text:JSON.stringify(payload)}],structuredContent:{schema:'revit-operator.assignment-kernel-mcp-result/v2',
     operation_result_v2:{schema:'revit-operator.operation-result/v2',result_id:'result:'+lease.operation_id,operation_id:lease.operation_id,binding,
      status:'succeeded',dispatch_state:'dispatched',persistent_effect:read?'none':'applied',native_transaction_state:read?'not_applicable':'committed',authority:'native-host',
      affected_target_identities:[...new Set([...ids,30])].map((id:number)=>'element_id:'+id),result_schema_id:`operator-native/POST:${nativeArgs.path}/v2`,observation_required:true,
      raw_payload_hash:createHash('sha256').update(canonicalJsonV2(payload)).digest('hex'),receipt_id:'receipt:'+lease.operation_id,native_correlation_id:'native:'+lease.operation_id,
      request_identity:lease.request_identity,completed_at:read&&variant==='stale_read'?'2026-01-01T00:00:00Z':new Date().toISOString()},observation:{raw_payload:payload,
       semantic_facts:[{fact_id:op.fulfillment_role==='verification'?'verification.result_available':'control.result_available',fact_class:op.fulfillment_role==='verification'?'verification':'control',value:true}],verification_relevance:['control']}}};
    if(typed&&!read){
     const retained=settleAssignmentKernelOperationV2(lease,envelope);
     if(variant==='paused_after_commit')controlAssignmentExecutionV2({binding,command_id:'user-pause',expected_command_id:null,action:'pause'});
     return {content:[],structuredContent:{schema:'revit-operator.assignment-kernel-mcp-result/v2',operation_result_v2:{
      schema:'revit-operator.operation-result/v2',result_id:'result:'+parent.operation_id,operation_id:parent.operation_id,binding,
      status:'completed_without_native_dispatch',dispatch_state:'not_dispatched',persistent_effect:'none',native_transaction_state:'not_applicable',
      authority:'operator-mcp-transport',result_schema_id:'operator-capability/revit_assign_electrical_circuit/v2',observation_required:false,
      request_identity:parent.request_identity,completed_at:new Date().toISOString()},child_operation_results_v2:[{
       operation_id:lease.operation_id,parent_operation_id:parent.operation_id,request_identity:lease.request_identity,evidence_projections:retained.evidence_projections}]}};
    }
    if(!read&&variant==='paused_after_commit')controlAssignmentExecutionV2({binding,command_id:'user-pause',expected_command_id:null,action:'pause'});
    return envelope;
   }};
  const owner=beginTeammateLoopOwner(runtime,{version:'operator.backend.v1',session_id:binding.session_id,message_id:'circuit-task',user_text:goal.objective,
   assignment_id:binding.assignment_id,assignment_run_id:binding.run_id,assignment_generation:binding.generation} as any,{canonicalSupervisionOnly:true});
  try{
   const response:any=await handleCodexDynamicToolCall(runtime,{id:'user-circuit-edit',method:'item/tool/call',params:{namespace:'revit_operator',turnId:'circuit-turn',tool:typed?'revit_assign_electrical_circuit':'revit_call_tool',arguments:typed?f.input.body:f.input}} as any);
   __testOnlyResetGoalListCache();const s=getAssignmentKernelSnapshotV2(goal.id)!;
   const apply=Object.values(s.operations).find(o=>o.persistent_effect==='applied')!;
   assert.equal(apply.result?.persistent_effect,'applied');assert.equal(response.success,true);
   assert.equal(calls.filter(c=>c.path==='/revit/assign-electrical-circuit').length,1);
   assert.equal(validations.filter(a=>a.path==='/revit/get-element-summary').length,variant==='paused_after_commit'?0:variant==='read_schema_rejected'?1:2);
   assert.equal(calls.filter(c=>c.path==='/revit/get-element-summary').length,['read_schema_rejected','paused_after_commit'].includes(variant)?0:1, JSON.stringify(response));
   const verified=apply.verification_operation_ids.some(id=>s.operations[id]!.observation_ids.some(oid=>s.observations[oid]!.facts.some(x=>x.fact_id==='verification.postcondition_satisfied'&&x.value===true)));
   assert.equal(verified,variant==='exact', JSON.stringify({apply, observations:s.observations, operations:s.operations}));
   assert.equal(deriveProgressGapsV2(s).some(g=>g.gap_id==='verification:'+apply.operation_id),variant!=='exact');
   assert.equal(Object.values(s.operations).filter(o=>o.persistent_effect==='applied').length,1);
  }finally{endTeammateLoopOwner(owner);}
 });}finally{__testOnlyResetGoalListCache();if(previous===undefined)delete process.env.OPERATOR_WORKSPACE_ROOT;else process.env.OPERATOR_WORKSPACE_ROOT=previous;fs.rmSync(root,{recursive:true,force:true});}
});
