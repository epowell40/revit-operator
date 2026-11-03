import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {committedArtifactReadbackPlanV2} from '../src/verification/committed_artifact_readback_plan_v2.js';
import {createGoal,__testOnlyResetGoalListCache} from '../src/goals/service.js';
import {createAssignmentKernelForGoalV2} from '../src/assignments/assignment_kernel_v2_factory.js';
import {getAssignmentKernelSnapshotV2} from '../src/assignments/assignment_kernel_v2_store.js';
import {beginTeammateLoopOwner,endTeammateLoopOwner} from '../src/teammate_loop_runtime.js';
import {handleCodexDynamicToolCall} from '../src/brains/codex_dynamic_tool_handler.js';
import {runWithRequestContext} from '../src/request_context.js';
import {createOperatorBackendAuth} from '../src/operator_backend_auth.js';
import {canonicalJsonV2,deriveProgressGapsV2} from '../src/domain/assignment-kernel/index.js';
import {controlAssignmentExecutionV2} from '../src/assignments/assignment_kernel_v2_controls.js';
import {recordCompletedAssignmentProviderReceiptV2,DEFAULT_ASSIGNMENT_PROGRESS_BUDGET_V2} from '../src/assignments/assignment_kernel_v2_progress.js';
import {defaultAssignmentWorkBudgetV2} from '../src/assignments/assignment_work_allowance_v2.js';

for(const route of ['/revit/export-pdf','/revit/print','/revit/export-elements-xlsx'])
for(const variant of ['exact','wrong_hash','missing_file','partial_inventory','read_failure','read_schema_rejected','pause_after_export','last_provider_call'])
test(`${route} ${variant}: one native export followed by a separate guarded complete file check`,async()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'operator-export-check-')),prior=process.env.OPERATOR_WORKSPACE_ROOT;
 process.env.OPERATOR_WORKSPACE_ROOT=root;__testOnlyResetGoalListCache();
 try{await runWithRequestContext({operator_backend_auth:createOperatorBackendAuth('shared_token','synthetic-export-fixture')},async()=>{
  const outputs=[1,2].map(n=>({path:`C:/fixture/export-${n}.${route.endsWith('xlsx')?'xlsx':'pdf'}`,size_bytes:4096+n,sha256:String(n).repeat(64),fresh_output:true}));
  const artifact={schema:'revit-operator.native-artifact-receipt.v1',method:'POST',path:route,phase:'apply',status:'complete',
   expected_output_paths:outputs.map(o=>o.path),expected_export_calls:2,export_calls:[true,true],outputs,
   ...(route==='/revit/print'?{print_settings_restored:true,print_settings_restoration_readback:Object.entries({PrinterName:'Fixture PDF',PrintToFile:true,CombinedFile:false,
    PrintToFileName:'C:/fixture/export.pdf',PrintRange:'Select',CopyNumber:1,PrintOrderReverse:false}).map(([field,before])=>({field,before,after:before,read_succeeded:true,matches:true,error:null}))}:{})};
  const objective=route.endsWith('xlsx')?'Export the requested model elements to Excel and inspect the XLSX files.':'Export the requested sheets to PDF and inspect the files.';
  const goal=createGoal({title:'Export the requested files',objective,acceptance_criteria:['Requested files are delivered.'],
   status:'active',related_session_id:'artifact-fixture',created_by:'fixture-only',work_budget:{requested_effect:'apply',document_fingerprint:'a'.repeat(64)}});
  createAssignmentKernelForGoalV2({goal,run_id:'artifact-run'});const binding=getAssignmentKernelSnapshotV2(goal.id)!.current_binding;
  const initial=getAssignmentKernelSnapshotV2(goal.id)!,limit=defaultAssignmentWorkBudgetV2(initial,DEFAULT_ASSIGNMENT_PROGRESS_BUDGET_V2).max_provider_calls;
  const providerReceipt=(index:number)=>{const snapshot=getAssignmentKernelSnapshotV2(goal.id)!;
   recordCompletedAssignmentProviderReceiptV2({binding,call_id:'synthetic:'+index,controller_turn_id:'artifact-turn',provider:'fixture-only',model:'no-provider',reasoning_effort:'medium',
    gap_ids:deriveProgressGapsV2(snapshot).map(g=>g.gap_id),criterion_ids:snapshot.spec.criteria.map(c=>c.criterion_id),expected_information:['Check exported files.'],
    admitted_at:snapshot.spec.created_at,completed_at:new Date().toISOString(),provider_duration_ms:0,usage:{input_tokens:1,output_tokens:0,reasoning_tokens:0,total_tokens:1,estimated_cost_usd:null},success:true});};
  if(variant==='last_provider_call')for(let i=0;i<limit-1;i++)providerReceipt(i);
  const calls:any[]=[],input={method:'POST',path:route,body:{all:true,combine:false,dryRun:false}};
  const runtime:any={assignmentKernelV2Binding:()=>binding,queueAssignmentKernelV2TurnStop(){},
   async validateToolArguments(_tool:string,args:any){if(args.path==='/revit/inspect-exported-files'){
    assert.deepEqual(args.body,{paths:outputs.map(o=>o.path)});if(variant==='read_schema_rejected')throw Error('synthetic_schema_refusal');
   }},async callTool(_tool:string,args:any,context:any){
    calls.push(args);context.onMcpAccepted();const lease=context.assignmentKernelV2,read=args.path==='/revit/inspect-exported-files';
    if(!read&&variant==='last_provider_call')providerReceipt(limit-1);
    if(read&&variant==='read_failure')throw Error('synthetic_read_failure');
    const payload:any=read?{schema:'revit-operator.exported-file-inspection.v1',ok:true,itemsComplete:true,
     requestedPaths:outputs.map(o=>o.path),files:outputs.map(o=>({...o,exists:true,readable:true}))}:{ok:true,status:'Success',artifact_receipt:artifact};
    if(read&&variant==='wrong_hash')payload.files[1].sha256='f'.repeat(64);
    if(read&&variant==='missing_file')payload.files[1].exists=false;
    if(read&&variant==='partial_inventory'){payload.files.pop();payload.itemsComplete=false;}
    if(!read&&variant==='pause_after_export')controlAssignmentExecutionV2({binding,command_id:'pause-after-export',expected_command_id:null,action:'pause'});
    const operation=getAssignmentKernelSnapshotV2(goal.id)!.operations[lease.operation_id]!;
    return {content:[{type:'text',text:JSON.stringify(payload)}],structuredContent:{schema:'revit-operator.assignment-kernel-mcp-result/v2',
     operation_result_v2:{schema:'revit-operator.operation-result/v2',result_id:'result:'+lease.operation_id,operation_id:lease.operation_id,binding,
      status:'succeeded',dispatch_state:'dispatched',persistent_effect:read?'none':'applied',native_transaction_state:'not_applicable',authority:'native-host',
      affected_target_identities:outputs.map(o=>'artifact_path:'+o.path.toLowerCase()),result_schema_id:`operator-native/POST:${args.path}/v2`,
      observation_required:true,...(!read?{native_artifact_receipt:artifact}:{}),raw_payload_hash:createHash('sha256').update(canonicalJsonV2(payload)).digest('hex'),
      receipt_id:'receipt:'+lease.operation_id,native_correlation_id:'native:'+lease.operation_id,request_identity:lease.request_identity,completed_at:new Date().toISOString()},
     observation:{raw_payload:payload,semantic_facts:[{fact_id:operation.fulfillment_role==='verification'?'verification.result_available':'control.result_available',
      fact_class:operation.fulfillment_role==='verification'?'verification':'control',value:true}],verification_relevance:['control']}}};
   }};
  const owner=beginTeammateLoopOwner(runtime,{version:'operator.backend.v1',session_id:binding.session_id,message_id:'artifact-human',user_text:goal.objective,
   assignment_id:binding.assignment_id,assignment_run_id:binding.run_id,assignment_generation:binding.generation} as any,{canonicalSupervisionOnly:true});
  try{
   const response:any=await handleCodexDynamicToolCall(runtime,{id:'export-once',method:'item/tool/call',params:{namespace:'revit_operator',turnId:'artifact-turn',tool:'revit_call_tool',arguments:input}} as any);
   const snapshot=getAssignmentKernelSnapshotV2(goal.id)!,apply=Object.values(snapshot.operations).find(o=>o.requested_effect==='apply')!;
   assert.equal(response.success,true,JSON.stringify(response));assert.equal(apply.result?.persistent_effect,'applied');
   assert.equal(calls.filter(c=>c.path===route).length,1,'never re-export to obtain cleaner verification');
   assert.equal(calls.filter(c=>c.path==='/revit/inspect-exported-files').length,['pause_after_export','read_schema_rejected'].includes(variant)?0:1);
   const verified=apply.verification_operation_ids.some(id=>snapshot.operations[id]!.observation_ids.some(oid=>snapshot.observations[oid]!.facts.some(f=>f.fact_id==='verification.postcondition_satisfied'&&f.value===true)));
   const expectedVerified=variant==='exact'||variant==='last_provider_call';
   assert.equal(verified,expectedVerified);
   assert.equal(deriveProgressGapsV2(snapshot).some(g=>g.gap_id==='verification:'+apply.operation_id),!expectedVerified);
   assert.deepEqual(snapshot.unresolved_unknown_operation_ids,[]);assert.deepEqual(snapshot.in_flight_operation_ids,[]);
   assert(!['complete','complete_with_issues','verified_noop'].includes(snapshot.outcome),'file integrity alone must not invent whole-task fulfillment');
   if(variant==='last_provider_call'){
    assert.equal(Object.keys(snapshot.provider_calls).length,limit);assert.equal(defaultAssignmentWorkBudgetV2(snapshot,DEFAULT_ASSIGNMENT_PROGRESS_BUDGET_V2).max_provider_calls,limit);
    assert.equal(snapshot.terminal,true);assert.equal(snapshot.outcome,'blocked');assert.equal(snapshot.terminal_reason,'provider_call_budget_exhausted');
   }else assert.equal(snapshot.terminal,false);
   if(variant==='exact'){
    assert.equal(committedArtifactReadbackPlanV2(snapshot,apply),null,'a settled check is not dispatched again');
    const original:any=structuredClone(snapshot);original.operations[apply.operation_id].verification_operation_ids=[];
    assert.deepEqual(committedArtifactReadbackPlanV2(original,original.operations[apply.operation_id]),{method:'POST',path:'/revit/inspect-exported-files',body:{paths:outputs.map(o=>o.path)}},'guard cases start from an eligible unsettled check');
    for(const alter of [(s:any)=>s.terminal=true,(s:any)=>s.execution_control={state:'paused'},(s:any)=>s.unresolved_unknown_operation_ids=['old-unknown'],
     (s:any)=>s.current_binding={...s.current_binding,generation:2},(s:any)=>s.input_invalidated_operation_ids=[apply.operation_id],
     (s:any)=>s.operations[apply.operation_id].result.authority='model',
     (s:any)=>s.operations[apply.operation_id].result.native_artifact_receipt.export_calls=[true,false],
     (s:any)=>s.operations[apply.operation_id].result.native_artifact_receipt.outputs[0].fresh_output=false]){
      const changed=structuredClone(original);alter(changed);assert.equal(committedArtifactReadbackPlanV2(changed,changed.operations[apply.operation_id]),null);
    }
   }
  }finally{endTeammateLoopOwner(owner);}
 });}finally{__testOnlyResetGoalListCache();if(prior===undefined)delete process.env.OPERATOR_WORKSPACE_ROOT;else process.env.OPERATOR_WORKSPACE_ROOT=prior;
  assert(path.resolve(root).startsWith(path.resolve(os.tmpdir())+path.sep)&&path.basename(root).startsWith('operator-export-check-'));fs.rmSync(root,{recursive:true,force:true});}
});
