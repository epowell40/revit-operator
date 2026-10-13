import assert from 'node:assert/strict';
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import test from 'node:test';
import {createHash} from 'node:crypto';
import {committedSheetMoveReadbackPlanV2} from '../src/verification/sheet_move_postcondition_v2.js';
import {panelMoveFixtureV2} from './fixtures/panel_schedule_move_fixture.js';
import {createGoal,__testOnlyResetGoalListCache} from '../src/goals/service.js';
import {createAssignmentKernelForGoalV2} from '../src/assignments/assignment_kernel_v2_factory.js';
import {getAssignmentKernelSnapshotV2} from '../src/assignments/assignment_kernel_v2_store.js';
import {beginTeammateLoopOwner,endTeammateLoopOwner} from '../src/teammate_loop_runtime.js';
import {handleCodexDynamicToolCall} from '../src/brains/codex_dynamic_tool_handler.js';
import {runWithRequestContext} from '../src/request_context.js';
import {createOperatorBackendAuth} from '../src/operator_backend_auth.js';
import {canonicalJsonV2,deriveProgressGapsV2} from '../src/domain/assignment-kernel/index.js';
import {controlAssignmentExecutionV2} from '../src/assignments/assignment_kernel_v2_controls.js';

for(const variant of ['exact','wrong_origin','wrong_owner','read_failure','read_schema_rejected','paused_after_commit','missing_owner','unsettled'] as const)
test(`ordinary dynamic panel placement edit ${variant} triggers one separate guarded read without a provider recipe`,async()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'operator-host-tag-check-')),previous=process.env.OPERATOR_WORKSPACE_ROOT;
 process.env.OPERATOR_WORKSPACE_ROOT=root;__testOnlyResetGoalListCache();
 try { await runWithRequestContext({operator_backend_auth:createOperatorBackendAuth('shared_token','test-only')},async()=>{
  const retained=panelMoveFixtureV2(),f={apply_input:retained.input,native_apply:retained.native_apply,native_read:retained.actual_sheet};
  if(variant==='missing_owner')for(const p of f.native_apply.snapshots){delete p.before.ownerViewId;delete p.after.ownerViewId;}
  const goal=createGoal({title:'Move the panel schedules',objective:'Move the panel schedules.',acceptance_criteria:['The requested edit is established.'],status:'active',
    related_session_id:'tag-host-session',created_by:'tag-host-principal',work_budget:{requested_effect:'apply',document_fingerprint:'tag-model'}});
  createAssignmentKernelForGoalV2({goal,run_id:'tag-host-run'});const binding=getAssignmentKernelSnapshotV2(goal.id)!.current_binding;
  const calls:any[]=[],validations:any[]=[];
  const runtime:any={assignmentKernelV2Binding:()=>binding,queueAssignmentKernelV2TurnStop(){},
   async validateToolArguments(_tool:string,args:any){validations.push(args);if(variant==='read_schema_rejected'&&args.path==='/revit/sheets')throw Error('read_schema_rejected');},
   async callTool(_tool:string,args:any,context:any){
    calls.push(args);const lease=context.assignmentKernelV2;context.onMcpAccepted();
    const read=args.path==='/revit/sheets';if(read&&variant==='read_failure')throw Error('native_read_failed');
    const payload:any=read?structuredClone(f.native_read):structuredClone(f.native_apply);
    if(read&&variant==='wrong_origin')payload.placedSchedules.find((p:any)=>p.instanceId===f.apply_input.body.ids[0]).point.v+=.02;
    if(read&&variant==='wrong_owner'){payload.sheetId++;payload.sheetElementId++;}
    const op=getAssignmentKernelSnapshotV2(goal.id)!.operations[lease.operation_id]!;
    if(!read&&variant==='paused_after_commit')controlAssignmentExecutionV2({binding,command_id:'user-pause',expected_command_id:null,action:'pause'});
    return {content:[{type:'text',text:JSON.stringify(payload)}],structuredContent:{schema:'revit-operator.assignment-kernel-mcp-result/v2',
     operation_result_v2:{schema:'revit-operator.operation-result/v2',result_id:'result:'+lease.operation_id,operation_id:lease.operation_id,binding,
      status:'succeeded',dispatch_state:'dispatched',persistent_effect:read?'none':'applied',native_transaction_state:read?'not_applicable':variant==='unsettled'?'pending':'committed',authority:'native-host',
      affected_target_identities:f.apply_input.body.ids.map((id:number)=>'element_id:'+id),result_schema_id:`operator-native/POST:${args.path}/v2`,observation_required:true,
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
   if(variant==='unsettled'){assert.equal(apply.persistent_effect,'unknown');assert.equal(calls.length,1);return;}
   assert.equal(apply.result?.persistent_effect,'applied');assert.equal(calls.filter(c=>c.path==='/revit/move-elements').length,1);
   assert.equal(response.success,true,'failed read must not relabel committed edit as failure');
   assert.equal(validations.filter(a=>a.path==='/revit/sheets').length,['paused_after_commit','missing_owner','unsettled','unknown_after_commit','later_write'].includes(variant)?0:1);
   assert.equal(calls.filter(c=>c.path==='/revit/sheets').length,['read_schema_rejected','paused_after_commit','missing_owner','unsettled','unknown_after_commit','later_write'].includes(variant)?0:1);
   if(variant==='exact'){
    assert.deepEqual(calls[1].body.placementIds,f.apply_input.body.ids);
    const noProof:any=structuredClone(s);noProof.operations[apply.operation_id]!.verification_operation_ids=[];
    for(const oid of Object.keys(noProof.operations))if(oid!==apply.operation_id)delete noProof.operations[oid];
    for(const mutate of [(x:any)=>x.unresolved_unknown_operation_ids=['retained-old-unknown'],(x:any)=>x.execution_control={state:'paused'},(x:any)=>x.operations['later']={...x.operations[apply.operation_id],operation_id:'later',result:{...x.operations[apply.operation_id].result,completed_at:'2999-01-01T00:00:00Z'}}]){
     const n=structuredClone(noProof);mutate(n);assert.equal(committedSheetMoveReadbackPlanV2(n,n.operations[apply.operation_id]!),null);
    }
   }
   const verified=apply.verification_operation_ids.some(id=>s.operations[id]!.observation_ids.some(oid=>s.observations[oid]!.facts.some(x=>x.fact_id==='verification.postcondition_satisfied'&&x.value===true)));
   const shouldVerify=variant==='exact';
   assert.equal(verified,shouldVerify);
   assert.equal(deriveProgressGapsV2(s).some(g=>g.gap_id==='verification:'+apply.operation_id),!shouldVerify);
   assert.equal(Object.values(s.operations).filter(o=>o.requested_effect==='apply').length,1);
  }finally{endTeammateLoopOwner(owner);}
 });}finally{__testOnlyResetGoalListCache();if(previous===undefined)delete process.env.OPERATOR_WORKSPACE_ROOT;else process.env.OPERATOR_WORKSPACE_ROOT=previous;fs.rmSync(root,{recursive:true,force:true});}
});
