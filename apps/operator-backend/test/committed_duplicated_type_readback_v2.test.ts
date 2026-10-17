import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { createGoal, __testOnlyResetGoalListCache } from '../src/goals/service.js';
import { createAssignmentKernelForGoalV2 } from '../src/assignments/assignment_kernel_v2_factory.js';
import { getAssignmentKernelSnapshotV2 } from '../src/assignments/assignment_kernel_v2_store.js';
import { beginTeammateLoopOwner, endTeammateLoopOwner } from '../src/teammate_loop_runtime.js';
import { handleCodexDynamicToolCall } from '../src/brains/codex_dynamic_tool_handler.js';
import { runWithRequestContext } from '../src/request_context.js';
import { createOperatorBackendAuth } from '../src/operator_backend_auth.js';
import { canonicalJsonV2, deriveProgressGapsV2 } from '../src/domain/assignment-kernel/index.js';
import { controlAssignmentExecutionV2 } from '../src/assignments/assignment_kernel_v2_controls.js';

for (const variant of ['exact','wrong_type','wrong_label','missing_type','missing_field','duplicate_field','read_failure','schema_rejected','paused','stale','foreign_authority','partial_apply','replaced_instance'] as const)
test(`committed duplicate type ${variant}: automatic separate native read retains commit and proves all requested fields only`,async()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'operator-duplicate-check-'));const previous=process.env.OPERATOR_WORKSPACE_ROOT;
 process.env.OPERATOR_WORKSPACE_ROOT=root;__testOnlyResetGoalListCache();
 try {await runWithRequestContext({operator_backend_auth:createOperatorBackendAuth('shared_token','test-only')},async()=>{
  const f=JSON.parse(fs.readFileSync('test/fixtures/duplicated-type-readback-40.json','utf8'));
  if(variant==='replaced_instance'){f.applied.resultingInstanceId=1735587;f.applied.transaction.added_element_ids.push(1735587);f.applied.transaction.deleted_element_ids.push(f.input.body.instanceId);f.read.items[0].id=1735587;f.read.items[0].uniqueId='new-native-instance';}
  if(variant==='partial_apply')f.applied.typeParameterChangesComplete=false;
  const goal=createGoal({title:'Make the marked outdoor receptacle GFCI',objective:'Make the marked outdoor receptacle GFCI.',acceptance_criteria:['Requested device and label established.'],status:'active',related_session_id:'duplicate-session',created_by:'duplicate-principal',work_budget:{requested_effect:'apply',document_fingerprint:'duplicate-model'}});
  createAssignmentKernelForGoalV2({goal,run_id:'duplicate-run'});const binding=getAssignmentKernelSnapshotV2(goal.id)!.current_binding;
  const calls:any[]=[],validations:any[]=[];
  const runtime:any={assignmentKernelV2Binding:()=>binding,queueAssignmentKernelV2TurnStop(){},async validateToolArguments(_tool:string,args:any){validations.push(args);if(variant==='schema_rejected'&&args.path==='/revit/get-parameters')throw Error('read_schema_rejected');},async callTool(_tool:string,args:any,context:any){
   calls.push(args);const lease=context.assignmentKernelV2;context.onMcpAccepted();const read=args.path==='/revit/get-parameters';
   if(read&&variant==='read_failure')throw Error('native_read_failed');const payload=structuredClone(read?f.read:f.applied);
   if(read&&variant==='wrong_type'){payload.items[0].parameters.Type='1379884';payload.items[0].parameterDetails[0].value='1379884';}
   if(read&&variant==='wrong_label'){payload.items[1].parameters.Label='WP';payload.items[1].parameterDetails.find((p:any)=>p.name==='Label').value='WP';}
   if(read&&variant==='missing_type')payload.items.pop();
   if(read&&variant==='missing_field')payload.items[1].parameterDetails=payload.items[1].parameterDetails.filter((p:any)=>p.name!=='Description');
   if(read&&variant==='duplicate_field')payload.items[1].parameterDetails.push(structuredClone(payload.items[1].parameterDetails.find((p:any)=>p.name==='Label')));
   const op=getAssignmentKernelSnapshotV2(goal.id)!.operations[lease.operation_id]!;
   if(!read&&variant==='paused')controlAssignmentExecutionV2({binding,command_id:'user-pause',expected_command_id:null,action:'pause'});
   return {content:[{type:'text',text:JSON.stringify(payload)}],structuredContent:{schema:'revit-operator.assignment-kernel-mcp-result/v2',operation_result_v2:{schema:'revit-operator.operation-result/v2',result_id:'result:'+lease.operation_id,operation_id:lease.operation_id,binding,status:'succeeded',dispatch_state:'dispatched',persistent_effect:read?'none':'applied',native_transaction_state:read?'not_applicable':'committed',authority:read&&variant==='foreign_authority'?'model':'native-host',affected_target_identities:[f.input.body.instanceId,f.applied.newTypeId,f.applied.resultingInstanceId].map(id=>'element_id:'+id).filter((x,i,a)=>a.indexOf(x)===i),result_schema_id:`operator-native/POST:${args.path}/v2`,observation_required:true,raw_payload_hash:createHash('sha256').update(canonicalJsonV2(payload)).digest('hex'),receipt_id:'receipt:'+lease.operation_id,native_correlation_id:'native:'+lease.operation_id,request_identity:lease.request_identity,completed_at:read&&variant==='stale'?'2026-01-01T00:00:00Z':new Date().toISOString()},observation:{raw_payload:payload,semantic_facts:[{fact_id:op.fulfillment_role==='verification'?'verification.result_available':'control.result_available',fact_class:op.fulfillment_role==='verification'?'verification':'control',value:true}],verification_relevance:['control']}}};
  }};
  const owner=beginTeammateLoopOwner(runtime,{version:'operator.backend.v1',session_id:binding.session_id,message_id:'duplicate-task',user_text:goal.objective,assignment_id:binding.assignment_id,assignment_run_id:binding.run_id,assignment_generation:binding.generation} as any,{canonicalSupervisionOnly:true});
  try {
   const response:any=await handleCodexDynamicToolCall(runtime,{id:'user-duplicate-edit',method:'item/tool/call',params:{namespace:'revit_operator',turnId:'duplicate-turn',tool:'revit_call_tool',arguments:f.input}} as any);
   __testOnlyResetGoalListCache();const s=getAssignmentKernelSnapshotV2(goal.id)!;const apply=Object.values(s.operations).find(o=>o.persistent_effect==='applied')!;
   assert.equal(response.success,true);assert.equal(apply.result?.persistent_effect,'applied');assert.equal(calls.filter(c=>c.path==='/revit/duplicate-type-and-swap-instance').length,1);
   const planned=!['paused','partial_apply'].includes(variant);assert.equal(validations.filter(c=>c.path==='/revit/get-parameters').length,planned?(variant==='schema_rejected'?1:2):0);
   assert.equal(calls.filter(c=>c.path==='/revit/get-parameters').length,planned&&variant!=='schema_rejected'?1:0);
   const verified=apply.verification_operation_ids.some(id=>s.operations[id]!.observation_ids.some(oid=>s.observations[oid]!.facts.some(fact=>fact.fact_id==='verification.postcondition_satisfied'&&fact.value===true)));
   const expectedPass=variant==='exact'||variant==='replaced_instance';assert.equal(verified,expectedPass);assert.equal(deriveProgressGapsV2(s).some(g=>g.gap_id==='verification:'+apply.operation_id),!expectedPass);
   assert.equal(Object.values(s.operations).filter(o=>o.persistent_effect==='applied').length,1);
  }finally{endTeammateLoopOwner(owner);}
 });}finally{__testOnlyResetGoalListCache();if(previous===undefined)delete process.env.OPERATOR_WORKSPACE_ROOT;else process.env.OPERATOR_WORKSPACE_ROOT=previous;assert.equal(path.dirname(root),path.resolve(os.tmpdir()));fs.rmSync(root,{recursive:true,force:true});}
});
