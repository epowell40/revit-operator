import assert from 'node:assert/strict';
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import test from 'node:test';
import {createHash} from 'node:crypto';
import {committedParameterReadbackPlanV2,committedTypedParameterReadbackPlanV2} from '../src/verification/committed_parameter_readback_plan_v2.js';
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
const fixture=()=>JSON.parse(fs.readFileSync('test/fixtures/parameter-batch-readback-29.json','utf8').replace(/^\uFEFF/,'')).seven;

test('exact retained typed batches require one same-parent native commit and complete provenance',()=>{
 const retained=JSON.parse(fs.readFileSync('test/fixtures/parameter-typed-batch-30.json','utf8'));
 for(const f of retained.batches){
  const binding={assignment_id:'typed',run_id:'run',generation:1,session_id:'session',principal_id:'local',document_fingerprint:'model'};
  const parent:any={operation_id:'parent',binding,capability_id:'revit_set_parameters',operation_role:'root',input:f.parent_input,
   admission_state:'admitted',settlement_state:'settled',requested_effect:'apply',persistent_effect:'none',opened_at:'2026-10-12T23:00:00Z',
   request_identity:{request_signature:'parent-signature'},result:{operation_id:'parent',binding,status:'completed_without_native_dispatch',
    authority:'operator-mcp-transport',observation_required:false,persistent_effect:'none',native_transaction_state:'not_applicable',
    request_identity:{request_signature:'parent-signature'},completed_at:'2026-10-12T23:00:02Z'}};
  const identity={capability_id:'native:POST:/revit/set-parameter',method:'POST',path:'/revit/set-parameter',request_signature:'child-signature'};
  const child:any={operation_id:'child',binding,capability_id:identity.capability_id,operation_role:'child',parent_operation_id:'parent',root_operation_id:'parent',
   input:f.input,request_identity:identity,admission_state:'admitted',dispatch_state:'dispatched',settlement_state:'settled',requested_effect:'apply',persistent_effect:'applied',
   observation_ids:['obs'],verification_operation_ids:[],opened_at:'2026-10-12T23:00:01Z',result:{operation_id:'child',binding,status:'succeeded',authority:'native-host',
    observation_required:true,native_transaction_state:'committed',persistent_effect:'applied',completed_at:'2026-10-12T23:00:01.500Z',request_identity:identity,
    affected_target_identities:f.input.body.changes.map((c:any)=>'element_id:'+c.elementId)}};
  const snapshot:any={terminal:false,outcome:'active',current_binding:binding,unresolved_unknown_operation_ids:[],operations:{parent,child},
   observations:{obs:{operation_id:'child',raw_payload_ref:'evidence:ev1_child'}}};
  const response:any={structuredContent:{operation_result_v2:parent.result,child_operation_results_v2:[{operation_id:'child',parent_operation_id:'parent',request_identity:identity,
   evidence_projections:[{evidence_id:'ev1_child',source:'assignment_kernel_v2:'+child.capability_id,attempt_id:'child',assignment_id:'typed',run_id:'run',generation:1}]}]}};
  const plan=committedTypedParameterReadbackPlanV2(snapshot,parent,response)!;
  assert.equal(plan.operation_id,'child');
  assert.deepEqual(plan.plan.body.elementIds,f.input.body.changes.map((c:any)=>c.elementId).sort((a:number,b:number)=>a-b));
  for(const mutate of [(s:any,r:any)=>s.operations.child.parent_operation_id='other',
   (s:any,r:any)=>s.operations.child.root_operation_id='other',(s:any,r:any)=>s.operations.child.binding={...s.operations.child.binding,document_fingerprint:'foreign'},
   (s:any,r:any)=>s.operations.child.binding={...s.operations.child.binding,principal_id:'foreign'},(s:any,r:any)=>s.operations.parent.result.status='failed_before_dispatch',
   (s:any,r:any)=>s.operations.parent.settlement_state='awaiting_result',(s:any,r:any)=>s.operations.parent.result.request_identity.request_signature='foreign',
   (s:any,r:any)=>s.operations.parent.result.completed_at='invalid',(s:any,r:any)=>s.operations.child.result.completed_at='2026-10-12T23:00:03Z',
   (s:any,r:any)=>s.operations.parent.input.apply=false,(s:any,r:any)=>s.operations.parent.input.changes[0].value='wrong',
   (s:any,r:any)=>s.input_invalidated_operation_ids=['parent'],(s:any,r:any)=>s.unresolved_unknown_operation_ids=['prior'],
   (s:any,r:any)=>s.execution_control={state:'paused'},(s:any,r:any)=>s.operations.child.result.native_transaction_state='pending',
   (s:any,r:any)=>s.operations.child.verification_operation_ids=['already'],(s:any,r:any)=>r.structuredContent.child_operation_results_v2=[],
   (s:any,r:any)=>r.structuredContent.child_operation_results_v2.push(structuredClone(r.structuredContent.child_operation_results_v2[0])),
   (s:any,r:any)=>r.structuredContent.child_operation_results_v2[0].evidence_projections[0].evidence_id='foreign']){
   const s=structuredClone(snapshot),r=structuredClone(response);mutate(s,r);assert.equal(committedTypedParameterReadbackPlanV2(s,s.operations.parent,r),null,mutate.toString());
  }
 }
});

test('complete parameter read plan is bounded and rejects stale, unknown or unauthorized commits',()=>{
 const f=fixture(),binding={assignment_id:'test',run_id:'run',generation:1,session_id:'session',principal_id:'local',document_fingerprint:'model'};
 const ids=f.input.body.changes.map((c:any)=>c.elementId);
 const op:any={operation_id:'opv2_'+'a'.repeat(64),binding,input:f.input,request_identity:{path:'/revit/set-parameter',request_signature:'b'.repeat(64)},
  admission_state:'admitted',dispatch_state:'dispatched',settlement_state:'settled',requested_effect:'apply',persistent_effect:'applied',
  verification_operation_ids:[],opened_at:'2026-10-12T23:00:00Z',result:{operation_id:'opv2_'+'a'.repeat(64),binding,status:'succeeded',
   authority:'native-host',native_transaction_state:'committed',persistent_effect:'applied',completed_at:'2026-10-12T23:00:01Z',
   request_identity:{request_signature:'b'.repeat(64)},affected_target_identities:ids.map((id:number)=>'element_id:'+id)}};
 const snapshot:any={terminal:false,outcome:'active',current_binding:binding,unresolved_unknown_operation_ids:[],operations:{[op.operation_id]:op},observations:{}};
 assert.deepEqual(committedParameterReadbackPlanV2(snapshot,op),{method:'POST',path:'/revit/get-parameters',body:{elementIds:ids,names:['Leader Line'],limit:500}});
 for(const mutate of [(s:any,o:any)=>o.requested_effect='preview',(s:any,o:any)=>o.input.body.dryRun=true,
  (s:any,o:any)=>o.input.body.apply=false,(s:any)=>s.unresolved_unknown_operation_ids=['old'],
  (s:any,o:any)=>o.binding={...o.binding,generation:2},(s:any,o:any)=>o.result.binding={...o.binding,run_id:'foreign'},
  (s:any,o:any)=>o.result.native_transaction_state='pending',(s:any,o:any)=>o.result.authority='model',
  (s:any,o:any)=>o.result.request_identity.request_signature='foreign',(s:any,o:any)=>o.result.affected_target_identities.pop(),
  (s:any,o:any)=>o.verification_operation_ids=['already'],(s:any)=>s.execution_control={state:'paused'},
  (s:any)=>s.completion_proposal={},(s:any)=>s.terminal=true,(s:any,o:any)=>s.input_invalidated_operation_ids=[o.operation_id],
  (s:any,o:any)=>o.input.body.changes[0].parameterName='',
  (s:any,o:any)=>o.input.body.changes=Array(101).fill(o.input.body.changes[0]),
  (s:any,o:any)=>s.operations.later={...o,operation_id:'later',opened_at:'2026-10-12T23:00:02Z'}]){
  const s=structuredClone(snapshot),o=s.operations[op.operation_id];mutate(s,o);assert.equal(committedParameterReadbackPlanV2(s,o),null);
 }
 const excluded=structuredClone(snapshot),eo=excluded.operations[op.operation_id];eo.input.body.excludeElementIds=[ids[0]];
 assert.deepEqual(committedParameterReadbackPlanV2(excluded,eo)!.body.elementIds,ids.slice(1));
});

for(const typed of [false,true])
for(const variant of ['exact','missing_target','wrong_value','read_failure','read_schema_rejected','paused_after_commit','stale_read'] as const)
test(`${typed?'typed native-child':'ordinary'} parameter batch ${variant} receives one complete guarded host read`,async()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'operator-host-parameter-check-')),previous=process.env.OPERATOR_WORKSPACE_ROOT;
 process.env.OPERATOR_WORKSPACE_ROOT=root;__testOnlyResetGoalListCache();
 try {await runWithRequestContext({operator_backend_auth:createOperatorBackendAuth('shared_token','test-only')},async()=>{
  const f=fixture(),ids=f.input.body.changes.map((c:any)=>c.elementId);
  const goal=createGoal({title:'Remove the selected leaders',objective:'Remove the selected leaders.',acceptance_criteria:['Requested edits established.'],status:'active',
   related_session_id:'parameter-host-session',created_by:'parameter-host-principal',work_budget:{requested_effect:'apply',document_fingerprint:'parameter-model'}});
  createAssignmentKernelForGoalV2({goal,run_id:'parameter-host-run'});const binding=getAssignmentKernelSnapshotV2(goal.id)!.current_binding;
  const calls:any[]=[],validations:any[]=[];
  const runtime:any={assignmentKernelV2Binding:()=>binding,queueAssignmentKernelV2TurnStop(){},
   async validateToolArguments(_tool:string,args:any){validations.push(args);if(variant==='read_schema_rejected'&&args.path==='/revit/get-parameters')throw Error('read_schema_rejected');},
   async callTool(_tool:string,args:any,context:any){
    const nativeArgs=typed&&_tool==='revit_set_parameters'?{method:'POST',path:'/revit/set-parameter',body:args}:args;
    calls.push(nativeArgs);let lease=context.assignmentKernelV2;context.onMcpAccepted();const read=nativeArgs.path==='/revit/get-parameters';
    const parent=lease;
    if(typed&&!read){
     lease=openAssignmentKernelChildOperationV2({binding,parent_operation_id:parent.operation_id,child_ordinal:0,operation_role:'child',
      capability_id:'native:POST:/revit/set-parameter',classified_effect:'apply',method:'POST',path:'/revit/set-parameter',arguments:nativeArgs,
      fulfillment_role:'delegated_task_execution',delegation_authority_id:parent.delegation_authority_id,eligible_criterion_ids:parent.eligible_criterion_ids});
     markAssignmentKernelOperationDispatchStartedV2(lease);
    }
    if(read&&variant==='read_failure')throw Error('native_read_failed');
    const payload:any=read?structuredClone(f.read):{status:'Applied and Verified',changedElementIds:ids};
    if(read&&variant==='missing_target')payload.items=payload.items.filter((i:any)=>i.id!==ids.at(-1));
    if(read&&variant==='wrong_value'){payload.items.forEach((i:any)=>delete i.parameterDetails);payload.items.find((i:any)=>i.id===ids[0]).parameters['Leader Line']='1';}
    const op=getAssignmentKernelSnapshotV2(goal.id)!.operations[lease.operation_id]!;
    const envelope:any={content:[{type:'text',text:JSON.stringify(payload)}],structuredContent:{schema:'revit-operator.assignment-kernel-mcp-result/v2',
     operation_result_v2:{schema:'revit-operator.operation-result/v2',result_id:'result:'+lease.operation_id,operation_id:lease.operation_id,binding,
      status:'succeeded',dispatch_state:'dispatched',persistent_effect:read?'none':'applied',native_transaction_state:read?'not_applicable':'committed',authority:'native-host',
      affected_target_identities:ids.map((id:number)=>'element_id:'+id),result_schema_id:`operator-native/POST:${nativeArgs.path}/v2`,observation_required:true,
      raw_payload_hash:createHash('sha256').update(canonicalJsonV2(payload)).digest('hex'),receipt_id:'receipt:'+lease.operation_id,native_correlation_id:'native:'+lease.operation_id,
      request_identity:lease.request_identity,completed_at:read&&variant==='stale_read'?'2026-01-01T00:00:00Z':new Date().toISOString()},observation:{raw_payload:payload,
       semantic_facts:[{fact_id:op.fulfillment_role==='verification'?'verification.result_available':'control.result_available',fact_class:op.fulfillment_role==='verification'?'verification':'control',value:true}],verification_relevance:['control']}}};
    if(typed&&!read){
     const retained=settleAssignmentKernelOperationV2(lease,envelope);
     if(variant==='paused_after_commit')controlAssignmentExecutionV2({binding,command_id:'user-pause',expected_command_id:null,action:'pause'});
     return {content:[],structuredContent:{schema:'revit-operator.assignment-kernel-mcp-result/v2',operation_result_v2:{
      schema:'revit-operator.operation-result/v2',result_id:'result:'+parent.operation_id,operation_id:parent.operation_id,binding,
      status:'completed_without_native_dispatch',dispatch_state:'not_dispatched',persistent_effect:'none',native_transaction_state:'not_applicable',
      authority:'operator-mcp-transport',result_schema_id:'operator-capability/revit_set_parameters/v2',observation_required:false,
      request_identity:parent.request_identity,completed_at:new Date().toISOString()},child_operation_results_v2:[{
       operation_id:lease.operation_id,parent_operation_id:parent.operation_id,request_identity:lease.request_identity,evidence_projections:retained.evidence_projections}]}};
    }
    if(!read&&variant==='paused_after_commit')controlAssignmentExecutionV2({binding,command_id:'user-pause',expected_command_id:null,action:'pause'});
    return envelope;
   }};
  const owner=beginTeammateLoopOwner(runtime,{version:'operator.backend.v1',session_id:binding.session_id,message_id:'parameter-task',user_text:goal.objective,
   assignment_id:binding.assignment_id,assignment_run_id:binding.run_id,assignment_generation:binding.generation} as any,{canonicalSupervisionOnly:true});
  try{
   const response:any=await handleCodexDynamicToolCall(runtime,{id:'user-parameter-edit',method:'item/tool/call',params:{namespace:'revit_operator',turnId:'parameter-turn',tool:typed?'revit_set_parameters':'revit_call_tool',arguments:typed?f.input.body:f.input}} as any);
   __testOnlyResetGoalListCache();const s=getAssignmentKernelSnapshotV2(goal.id)!;
   const apply=Object.values(s.operations).find(o=>o.persistent_effect==='applied')!;
   assert.equal(apply.result?.persistent_effect,'applied');assert.equal(response.success,true);
   assert.equal(calls.filter(c=>c.path==='/revit/set-parameter').length,1);
   assert.equal(validations.filter(a=>a.path==='/revit/get-parameters').length,variant==='paused_after_commit'?0:1);
   assert.equal(calls.filter(c=>c.path==='/revit/get-parameters').length,['read_schema_rejected','paused_after_commit'].includes(variant)?0:1);
   const verified=apply.verification_operation_ids.some(id=>s.operations[id]!.observation_ids.some(oid=>s.observations[oid]!.facts.some(x=>x.fact_id==='verification.postcondition_satisfied'&&x.value===true)));
   assert.equal(verified,variant==='exact');
   assert.equal(deriveProgressGapsV2(s).some(g=>g.gap_id==='verification:'+apply.operation_id),variant!=='exact');
   assert.equal(Object.values(s.operations).filter(o=>o.persistent_effect==='applied').length,1);
  }finally{endTeammateLoopOwner(owner);}
 });}finally{__testOnlyResetGoalListCache();if(previous===undefined)delete process.env.OPERATOR_WORKSPACE_ROOT;else process.env.OPERATOR_WORKSPACE_ROOT=previous;fs.rmSync(root,{recursive:true,force:true});}
});
