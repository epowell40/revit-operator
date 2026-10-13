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

const retainedLabel=JSON.parse(fs.readFileSync(path.resolve('test/fixtures/category-display-label-readback-47.json'),'utf8'));
for(const variant of ['true','false','wrong_category','wrong_value','missing_value','read_failure','schema_rejected','paused',
 'label_true','label_false','label_wrong_category','label_wrong_identity','label_missing_snapshot','label_wrong_value','label_paused'] as const)
test(`ordinary category graphics ${variant}: committed edit retained and one separately admitted native check`,async()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'operator-view-check-')),previous=process.env.OPERATOR_WORKSPACE_ROOT;
 process.env.OPERATOR_WORKSPACE_ROOT=root;__testOnlyResetGoalListCache();
 try {await runWithRequestContext({operator_backend_auth:createOperatorBackendAuth('shared_token','test-only')},async()=>{
  const label=variant.startsWith('label_'),desired=!['false','label_false'].includes(variant);
  const viewId=label?retainedLabel.apply_input.body.viewId:42;
  const pauses=['paused','label_paused'].includes(variant);
  const passing=['true','false','label_true','label_false'].includes(variant);
  const goal=createGoal({title:'Halftone plumbing',objective:'Halftone plumbing in the selected view.',acceptance_criteria:['The requested stored property is checked.'],status:'active',
    related_session_id:'view-host-session',created_by:'view-host-principal',work_budget:{requested_effect:'apply',document_fingerprint:'view-model'}});
  createAssignmentKernelForGoalV2({goal,run_id:'view-host-run'});const binding=getAssignmentKernelSnapshotV2(goal.id)!.current_binding;
  const calls:any[]=[],validations:any[]=[];
  const runtime:any={assignmentKernelV2Binding:()=>binding,queueAssignmentKernelV2TurnStop(){},
   async validateToolArguments(_tool:string,args:any){validations.push(args);if(variant==='schema_rejected'&&args.body.action==='get')throw Error('read_schema_rejected');},
   async callTool(_tool:string,args:any,context:any){
    calls.push(args);const lease=context.assignmentKernelV2;context.onMcpAccepted();
    const read=args.body.action==='get';if(read&&variant==='read_failure')throw Error('native_read_failed');
    const payload:any=read?{status:'Ok',action:'get',dryRun:false,view:{id:42,categoryOverride:{categoryId:-2001160,
      builtInCategory:variant==='wrong_category'?'OST_PipeCurves':'OST_PlumbingFixtures',halftone:variant==='wrong_value'?!desired:desired}}}:{status:'Success',action:'set_category_override',dryRun:false};
    if(read&&label){
      Object.assign(payload,structuredClone(retainedLabel.verification_payload));
      payload.view.categoryOverride.halftone=variant==='label_wrong_value'?!desired:desired;
      if(variant==='label_wrong_category')payload.view.categoryOverride.categoryName='Pipes';
      if(variant==='label_wrong_identity')payload.view.categoryOverride.categoryId=-2001320;
      if(variant==='label_missing_snapshot')delete payload.view.categorySnapshot;
    }
    if(read&&variant==='missing_value')delete payload.view.categoryOverride.halftone;
    const op=getAssignmentKernelSnapshotV2(goal.id)!.operations[lease.operation_id]!;
    if(!read&&pauses)controlAssignmentExecutionV2({binding,command_id:'user-pause',expected_command_id:null,action:'pause'});
    return {content:[{type:'text',text:JSON.stringify(payload)}],structuredContent:{schema:'revit-operator.assignment-kernel-mcp-result/v2',
     operation_result_v2:{schema:'revit-operator.operation-result/v2',result_id:'result:'+lease.operation_id,operation_id:lease.operation_id,binding,
      status:'succeeded',dispatch_state:'dispatched',persistent_effect:read?'none':'applied',native_transaction_state:read?'not_applicable':'committed',authority:'native-host',
      affected_target_identities:['element_id:'+viewId],result_schema_id:'operator-native/POST:/revit/visibility/v2',observation_required:true,
      raw_payload_hash:createHash('sha256').update(canonicalJsonV2(payload)).digest('hex'),receipt_id:'receipt:'+lease.operation_id,native_correlation_id:'native:'+lease.operation_id,
      request_identity:lease.request_identity,completed_at:new Date().toISOString()},observation:{raw_payload:payload,
       semantic_facts:[{fact_id:op.fulfillment_role==='verification'?'verification.result_available':'control.result_available',fact_class:op.fulfillment_role==='verification'?'verification':'control',value:true}],verification_relevance:['control']}}};
   }};
  const owner=beginTeammateLoopOwner(runtime,{version:'operator.backend.v1',session_id:binding.session_id,message_id:'view-task',user_text:goal.objective,
    assignment_id:binding.assignment_id,assignment_run_id:binding.run_id,assignment_generation:binding.generation} as any,{canonicalSupervisionOnly:true});
  try{
   const response:any=await handleCodexDynamicToolCall(runtime,{id:'view-edit',method:'item/tool/call',params:{namespace:'revit_operator',turnId:'view-turn',tool:'revit_call_tool',
    arguments:{method:'POST',path:'/revit/visibility',body:{action:'set_category_override',viewId,categoryName:label?'Plumbing Fixtures':'OST_PlumbingFixtures',halftone:desired}}}} as any);
   __testOnlyResetGoalListCache();const s=getAssignmentKernelSnapshotV2(goal.id)!,apply=Object.values(s.operations).find(o=>o.requested_effect==='apply')!;
   assert.equal(response.success,true);assert.equal(apply.result?.persistent_effect,'applied');
   assert.equal(calls.filter(c=>c.body.action==='set_category_override').length,1,JSON.stringify({input:apply.input,result:apply.result,calls}));
   assert.equal(validations.filter(c=>c.body.action==='get').length,pauses?0:1,JSON.stringify({input:apply.input,result:apply.result,calls}));
   assert.equal(calls.filter(c=>c.body.action==='get').length,variant==='schema_rejected'||pauses?0:1,JSON.stringify(response));
   const verified=apply.verification_operation_ids.some(id=>s.operations[id]!.observation_ids.some(oid=>s.observations[oid]!.facts.some(x=>x.fact_id==='verification.postcondition_satisfied'&&x.value===true)));
   assert.equal(verified,passing);
   assert.equal(deriveProgressGapsV2(s).some(g=>g.gap_id==='verification:'+apply.operation_id),!passing);
  }finally{endTeammateLoopOwner(owner);}
 });}finally{__testOnlyResetGoalListCache();if(previous===undefined)delete process.env.OPERATOR_WORKSPACE_ROOT;else process.env.OPERATOR_WORKSPACE_ROOT=previous;fs.rmSync(root,{recursive:true,force:true});}
});
