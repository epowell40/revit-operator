import assert from 'node:assert/strict';
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import test from 'node:test';
import {createHash} from 'node:crypto';
import {committedTagReadbackPlanV2} from '../src/verification/committed_tag_readback_plan_v2.js';
import {retainedTagReadFixtureV2} from './fixtures/tag_property_read_fixture.js';
import {createGoal,__testOnlyResetGoalListCache} from '../src/goals/service.js';
import {createAssignmentKernelForGoalV2} from '../src/assignments/assignment_kernel_v2_factory.js';
import {getAssignmentKernelSnapshotV2} from '../src/assignments/assignment_kernel_v2_store.js';
import {beginTeammateLoopOwner,endTeammateLoopOwner} from '../src/teammate_loop_runtime.js';
import {handleCodexDynamicToolCall} from '../src/brains/codex_dynamic_tool_handler.js';
import {runWithRequestContext} from '../src/request_context.js';
import {createOperatorBackendAuth} from '../src/operator_backend_auth.js';
import {canonicalJsonV2,deriveProgressGapsV2} from '../src/domain/assignment-kernel/index.js';
import {controlAssignmentExecutionV2} from '../src/assignments/assignment_kernel_v2_controls.js';

test('host tag read planner rejects preview, unknown, stale binding and unsupported geometry',()=>{
 const f=retainedTagReadFixtureV2(),binding={assignment_id:'test',run_id:'run',generation:1,session_id:'session',principal_id:'local',document_fingerprint:'model'};
 const op:any={operation_id:'opv2_'+'a'.repeat(64),binding,input:f.apply_input,request_identity:{path:'/revit/tag-elements',request_signature:'b'.repeat(64)},
  admission_state:'admitted',dispatch_state:'dispatched',settlement_state:'settled',requested_effect:'apply',persistent_effect:'applied',
  verification_operation_ids:[],opened_at:'2026-10-12T13:00:00Z',result:{operation_id:'opv2_'+'a'.repeat(64),binding,status:'succeeded',
   authority:'native-host',native_transaction_state:'committed',persistent_effect:'applied',completed_at:'2026-10-12T13:00:01Z',
   request_identity:{request_signature:'b'.repeat(64)},affected_target_identities:['element_id:'+f.apply_input.body.repairExistingTagId]}};
 const snapshot:any={terminal:false,outcome:'active',current_binding:binding,unresolved_unknown_operation_ids:[],operations:{[op.operation_id]:op},observations:{}};
 const plan=committedTagReadbackPlanV2(snapshot,op)!;assert(plan);assert.deepEqual(plan.body.operations[1],{id:'read_OwnerViewId',op:'get_property',target:'$tag',property:'OwnerViewId'});
 assert.deepEqual(plan.body.operations.filter(x=>'property' in x).map(x=>'property' in x?x.property:null),['OwnerViewId','HasLeader']);
 const live44=JSON.parse(fs.readFileSync('test/fixtures/tag-leader-condition-readback-44.json','utf8'));
 for(const condition of ['Attached',' ATTACHED ','FrEe']) {
  const exact=structuredClone(op);exact.input=structuredClone(live44.input);exact.input.body.leaderEndCondition=condition;
  exact.result.affected_target_identities=['element_id:'+exact.input.body.repairExistingTagId];
  assert(committedTagReadbackPlanV2({...snapshot,operations:{[exact.operation_id]:exact}},exact)?.body.operations.some(x=>'property' in x&&x.property==='LeaderEndCondition'));
 }
 for(const condition of ['', 'unknown', 1, true, {}, null]) {
  const bad=structuredClone(op);bad.input.body.leaderEndCondition=condition;
  assert.equal(committedTagReadbackPlanV2({...snapshot,operations:{[bad.operation_id]:bad}},bad),null);
 }
 for(const mutate of [(s:any,o:any)=>o.requested_effect='preview',(s:any)=>s.unresolved_unknown_operation_ids=['old'],
  (s:any,o:any)=>o.binding={...o.binding,generation:2},(s:any,o:any)=>o.result.binding={...o.binding,run_id:'foreign'},
  (s:any,o:any)=>o.result.native_transaction_state='pending',(s:any,o:any)=>o.result.authority='model',
  (s:any,o:any)=>o.result.request_identity.request_signature='foreign',(s:any,o:any)=>o.result.affected_target_identities=[],
  (s:any,o:any)=>o.input.body.leaderEndXyz=[1,2,3],(s:any,o:any)=>o.verification_operation_ids=['already'],
  (s:any)=>s.execution_control={state:'paused'},(s:any)=>s.completion_proposal={},(s:any)=>s.terminal=true]){
  const s=structuredClone(snapshot),o=s.operations[op.operation_id];mutate(s,o);assert.equal(committedTagReadbackPlanV2(s,o),null);
 }
});

for(const variant of ['exact','Attached','padded_free','wrong_condition','invalid_condition','wrong_owner','read_failure','read_schema_rejected','paused_after_commit'] as const)
test(`ordinary dynamic tag edit ${variant} triggers one separate guarded read without a provider recipe`,async()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'operator-host-tag-check-')),previous=process.env.OPERATOR_WORKSPACE_ROOT;
 process.env.OPERATOR_WORKSPACE_ROOT=root;__testOnlyResetGoalListCache();
 try { await runWithRequestContext({operator_backend_auth:createOperatorBackendAuth('shared_token','test-only')},async()=>{
  const f=retainedTagReadFixtureV2();
  if(['Attached','padded_free','wrong_condition','invalid_condition'].includes(variant)) {
   f.apply_input.body.leaderEndCondition=variant==='padded_free'?' FrEe ':variant==='invalid_condition'?'invalid':'Attached';
   f.native_read.operations.find((o:any)=>o.property==='LeaderEndCondition').result_preview=variant==='Attached'?'Attached':'Free';
  }
  const goal=createGoal({title:'Turn off the selected tag leader',objective:'Turn off the selected tag leader.',acceptance_criteria:['The requested edit is established.'],status:'active',
    related_session_id:'tag-host-session',created_by:'tag-host-principal',work_budget:{requested_effect:'apply',document_fingerprint:'tag-model'}});
  createAssignmentKernelForGoalV2({goal,run_id:'tag-host-run'});const binding=getAssignmentKernelSnapshotV2(goal.id)!.current_binding;
  const calls:any[]=[],validations:any[]=[];
  const runtime:any={assignmentKernelV2Binding:()=>binding,queueAssignmentKernelV2TurnStop(){},
   async validateToolArguments(_tool:string,args:any){validations.push(args);if(variant==='read_schema_rejected'&&args.path==='/revit/native-api-ops')throw Error('read_schema_rejected');},
   async callTool(_tool:string,args:any,context:any){
    calls.push(args);const lease=context.assignmentKernelV2;context.onMcpAccepted();
    const read=args.path==='/revit/native-api-ops';if(read&&variant==='read_failure')throw Error('native_read_failed');
    const payload:any=read?structuredClone(f.native_read):{status:'Applied',tagIds:[f.apply_input.body.repairExistingTagId]};
    if(read){payload.operations=args.body.operations.map((request:any)=>{
      const old=f.native_read.operations.find((o:any)=>o.op===request.op&&(o.property===request.property||request.op==='call'));
      return {...old,id:request.id};});payload.operation_count=payload.operations.length;
      if(variant==='wrong_owner')payload.operations.find((o:any)=>o.property==='OwnerViewId').result_preview.id++;}
    const op=getAssignmentKernelSnapshotV2(goal.id)!.operations[lease.operation_id]!;
    if(!read&&variant==='paused_after_commit')controlAssignmentExecutionV2({binding,command_id:'user-pause',expected_command_id:null,action:'pause'});
    return {content:[{type:'text',text:JSON.stringify(payload)}],structuredContent:{schema:'revit-operator.assignment-kernel-mcp-result/v2',
     operation_result_v2:{schema:'revit-operator.operation-result/v2',result_id:'result:'+lease.operation_id,operation_id:lease.operation_id,binding,
      status:'succeeded',dispatch_state:'dispatched',persistent_effect:read?'none':'applied',native_transaction_state:read?'not_applicable':'committed',authority:'native-host',
      affected_target_identities:['element_id:'+f.apply_input.body.repairExistingTagId],result_schema_id:`operator-native/POST:${args.path}/v2`,observation_required:true,
      raw_payload_hash:createHash('sha256').update(canonicalJsonV2(payload)).digest('hex'),receipt_id:'receipt:'+lease.operation_id,native_correlation_id:'native:'+lease.operation_id,
      request_identity:lease.request_identity,completed_at:new Date().toISOString()},observation:{raw_payload:payload,
       semantic_facts:[{fact_id:op.fulfillment_role==='verification'?'verification.result_available':'control.result_available',fact_class:op.fulfillment_role==='verification'?'verification':'control',value:true}],verification_relevance:['control']}}};
   }};
  // Ordinary retained owner state, not a privileged verifier principal.
  const owner=beginTeammateLoopOwner(runtime,{version:'operator.backend.v1',session_id:binding.session_id,message_id:'tag-task',user_text:goal.objective,
   assignment_id:binding.assignment_id,assignment_run_id:binding.run_id,assignment_generation:binding.generation} as any,{canonicalSupervisionOnly:true});
  try{
   const response:any=await handleCodexDynamicToolCall(runtime,{id:'user-tag-edit',method:'item/tool/call',params:{namespace:'revit_operator',turnId:'tag-turn',tool:'revit_call_tool',arguments:f.apply_input}} as any);
   __testOnlyResetGoalListCache();const s=getAssignmentKernelSnapshotV2(goal.id)!;
   const apply=Object.values(s.operations).find(o=>o.requested_effect==='apply')!;
   assert.equal(apply.result?.persistent_effect,'applied');assert.equal(calls.filter(c=>c.path==='/revit/tag-elements').length,1);
   assert.equal(response.success,true,'failed read must not relabel committed edit as failure');
   assert.equal(validations.filter(a=>a.path==='/revit/native-api-ops').length,['paused_after_commit','invalid_condition'].includes(variant)?0:1);
   assert.equal(calls.filter(c=>c.path==='/revit/native-api-ops').length,['read_schema_rejected','paused_after_commit','invalid_condition'].includes(variant)?0:1);
   const verified=apply.verification_operation_ids.some(id=>s.operations[id]!.observation_ids.some(oid=>s.observations[oid]!.facts.some(x=>x.fact_id==='verification.postcondition_satisfied'&&x.value===true)));
   const shouldVerify=['exact','Attached','padded_free'].includes(variant);
   assert.equal(verified,shouldVerify);
   assert.equal(deriveProgressGapsV2(s).some(g=>g.gap_id==='verification:'+apply.operation_id),!shouldVerify);
   assert.equal(Object.values(s.operations).filter(o=>o.requested_effect==='apply').length,1);
  }finally{endTeammateLoopOwner(owner);}
 });}finally{__testOnlyResetGoalListCache();if(previous===undefined)delete process.env.OPERATOR_WORKSPACE_ROOT;else process.env.OPERATOR_WORKSPACE_ROOT=previous;fs.rmSync(root,{recursive:true,force:true});}
});
