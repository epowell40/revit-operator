import assert from 'node:assert/strict';
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import test from 'node:test';
import {createHash} from 'node:crypto';
import {committedScheduleReadbackPlanV2} from '../src/verification/committed_schedule_readback_plan_v2.js';
import {scheduleCellTp105ReadbackV2} from './fixtures/schedule_cell_tp105_readback_v2.js';
import {createGoal,__testOnlyResetGoalListCache} from '../src/goals/service.js';
import {createAssignmentKernelForGoalV2} from '../src/assignments/assignment_kernel_v2_factory.js';
import {getAssignmentKernelSnapshotV2} from '../src/assignments/assignment_kernel_v2_store.js';
import {beginTeammateLoopOwner,endTeammateLoopOwner} from '../src/teammate_loop_runtime.js';
import {handleCodexDynamicToolCall} from '../src/brains/codex_dynamic_tool_handler.js';
import {runWithRequestContext} from '../src/request_context.js';
import {createOperatorBackendAuth} from '../src/operator_backend_auth.js';
import {canonicalJsonV2,deriveProgressGapsV2} from '../src/domain/assignment-kernel/index.js';
import {controlAssignmentExecutionV2} from '../src/assignments/assignment_kernel_v2_controls.js';

test('schedule read plan requires exact committed source and active current authorization',()=>{
 const binding={assignment_id:'test',run_id:'run',generation:1,session_id:'session',principal_id:'local',document_fingerprint:'model'};
 const op:any={operation_id:'opv2_'+'a'.repeat(64),binding,input:{method:'POST',path:'/revit/update-schedule-cell',body:{scheduleId:1661304,rowField:'Name',rowKey:'TP105',targetField:'Current Rating',value:'200 A',dryRun:false,apply:true}},request_identity:{path:'/revit/update-schedule-cell',request_signature:'b'.repeat(64)},
  admission_state:'admitted',dispatch_state:'dispatched',settlement_state:'settled',requested_effect:'apply',persistent_effect:'applied',verification_operation_ids:[],opened_at:'2026-10-12T20:00:00Z',
  result:{operation_id:'opv2_'+'a'.repeat(64),binding,status:'succeeded',authority:'native-host',native_transaction_state:'committed',persistent_effect:'applied',completed_at:'2026-10-12T20:00:01Z',request_identity:{request_signature:'b'.repeat(64)},affected_target_identities:['element_id:1654884']}};
 const snapshot:any={terminal:false,outcome:'active',current_binding:binding,unresolved_unknown_operation_ids:[],operations:{[op.operation_id]:op},observations:{}};
 assert.deepEqual(committedScheduleReadbackPlanV2(snapshot,op),{method:'POST',path:'/revit/get-parameters',body:{elementId:1654884,names:['Name','Current Rating']}});
 for(const mutate of [(s:any,o:any)=>o.requested_effect='preview',(s:any,o:any)=>o.input.body.dryRun=true,
  (s:any,o:any)=>o.input.body.apply=false,(s:any,o:any)=>o.input.body.value='',(s:any)=>s.unresolved_unknown_operation_ids=['old'],
  (s:any,o:any)=>o.binding={...o.binding,generation:2},(s:any,o:any)=>o.result.binding={...o.binding,run_id:'foreign'},
  (s:any,o:any)=>o.result.native_transaction_state='pending',(s:any,o:any)=>o.result.authority='model',
  (s:any,o:any)=>o.result.request_identity.request_signature='foreign',(s:any,o:any)=>o.result.affected_target_identities=[],
  (s:any,o:any)=>o.result.affected_target_identities.push('element_id:1662159'),(s:any,o:any)=>o.verification_operation_ids=['already'],
  (s:any)=>s.execution_control={state:'paused'},(s:any)=>s.completion_proposal={},(s:any)=>s.terminal=true,
  (s:any,o:any)=>s.input_invalidated_operation_ids=[o.operation_id],
  (s:any,o:any)=>s.operations.later={...o,operation_id:'later',result:{...o.result},opened_at:'2026-10-12T20:00:02Z'}]) {
  const s=structuredClone(snapshot),o=s.operations[op.operation_id];mutate(s,o);assert.equal(committedScheduleReadbackPlanV2(s,o),null);
 }
});

for(const variant of ['exact','wrong_field','wrong_unit','wrong_target','read_failure','read_schema_rejected','paused_after_commit'] as const)
test(`ordinary schedule cell edit ${variant} triggers one separate guarded read without a provider recipe`,async()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'operator-host-schedule-check-')),previous=process.env.OPERATOR_WORKSPACE_ROOT;
 process.env.OPERATOR_WORKSPACE_ROOT=root;__testOnlyResetGoalListCache();
 try { await runWithRequestContext({operator_backend_auth:createOperatorBackendAuth('shared_token','test-only')},async()=>{
  const f={apply_input:{method:'POST',path:'/revit/update-schedule-cell',body:{scheduleId:1661304,rowField:'Name',rowKey:'TP105',targetField:'Current Rating',expectedValue:'100 A',value:'200 A',apply:true,dryRun:false}},native_read:scheduleCellTp105ReadbackV2};
  const goal=createGoal({title:'Pick up the current-rating redline',objective:'Pick up the current-rating redline.',acceptance_criteria:['The requested edit is established.'],status:'active',
    related_session_id:'tag-host-session',created_by:'tag-host-principal',work_budget:{requested_effect:'apply',document_fingerprint:'tag-model'}});
  createAssignmentKernelForGoalV2({goal,run_id:'tag-host-run'});const binding=getAssignmentKernelSnapshotV2(goal.id)!.current_binding;
  const calls:any[]=[],validations:any[]=[];
  const runtime:any={assignmentKernelV2Binding:()=>binding,queueAssignmentKernelV2TurnStop(){},
   async validateToolArguments(_tool:string,args:any){validations.push(args);if(args.path==='/revit/get-parameters'){
    assert.deepEqual(Object.keys(args.body).sort(),['elementId','names'],'Actual native introspection forbids id/ids aliases');
    assert.equal(args.body.elementId,1654884);if(variant==='read_schema_rejected')throw Error('read_schema_rejected');
   }},
   async callTool(_tool:string,args:any,context:any){
    calls.push(args);const lease=context.assignmentKernelV2;context.onMcpAccepted();
    const read=args.path==='/revit/get-parameters';if(read&&variant==='read_failure')throw Error('native_read_failed');
    const payload:any=read?structuredClone(f.native_read):{status:'Updated',sourceElementId:1654884};
    if(read){
      if(variant==='wrong_field')payload.parameterDetails.find((p:any)=>p.name==='Current Rating').name='Unrelated';
      if(variant==='wrong_unit')payload.parameterDetails.find((p:any)=>p.name==='Current Rating').valueString='200 CFM';
      if(variant==='wrong_target')payload.id++;
    }
    const op=getAssignmentKernelSnapshotV2(goal.id)!.operations[lease.operation_id]!;
    if(!read&&variant==='paused_after_commit')controlAssignmentExecutionV2({binding,command_id:'user-pause',expected_command_id:null,action:'pause'});
    return {content:[{type:'text',text:JSON.stringify(payload)}],structuredContent:{schema:'revit-operator.assignment-kernel-mcp-result/v2',
     operation_result_v2:{schema:'revit-operator.operation-result/v2',result_id:'result:'+lease.operation_id,operation_id:lease.operation_id,binding,
      status:'succeeded',dispatch_state:'dispatched',persistent_effect:read?'none':'applied',native_transaction_state:read?'not_applicable':'committed',authority:'native-host',
      affected_target_identities:['element_id:1654884'],result_schema_id:`operator-native/POST:${args.path}/v2`,observation_required:true,
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
   assert.equal(apply.result?.persistent_effect,'applied');assert.equal(calls.filter(c=>c.path==='/revit/update-schedule-cell').length,1);
   assert.equal(response.success,true,'failed read must not relabel committed edit as failure');
   assert.equal(validations.filter(a=>a.path==='/revit/get-parameters').length,variant==='paused_after_commit'?0:1);
   assert.equal(calls.filter(c=>c.path==='/revit/get-parameters').length,['read_schema_rejected','paused_after_commit'].includes(variant)?0:1);
   const verified=apply.verification_operation_ids.some(id=>s.operations[id]!.observation_ids.some(oid=>s.observations[oid]!.facts.some(x=>x.fact_id==='verification.postcondition_satisfied'&&x.value===true)));
   assert.equal(verified,variant==='exact');
   assert.equal(deriveProgressGapsV2(s).some(g=>g.gap_id==='verification:'+apply.operation_id),variant!=='exact');
   assert.equal(Object.values(s.operations).filter(o=>o.requested_effect==='apply').length,1);
  }finally{endTeammateLoopOwner(owner);}
 });}finally{__testOnlyResetGoalListCache();if(previous===undefined)delete process.env.OPERATOR_WORKSPACE_ROOT;else process.env.OPERATOR_WORKSPACE_ROOT=previous;fs.rmSync(root,{recursive:true,force:true});}
});
