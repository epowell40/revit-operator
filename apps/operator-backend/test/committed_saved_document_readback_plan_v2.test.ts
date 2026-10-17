import {savedCopyHandoffV2} from '../src/assignments/saved_copy_handoff_v2.js';
import {deriveTerminalResultV2} from '../src/assignments/assignment_kernel_v2_terminal_result.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import test from 'node:test';
import {createHash} from 'node:crypto';
import {committedSavedDocumentReadbackPlanV2} from '../src/verification/committed_saved_document_readback_plan_v2.js';
import {createGoal,__testOnlyResetGoalListCache} from '../src/goals/service.js';
import {createAssignmentKernelForGoalV2} from '../src/assignments/assignment_kernel_v2_factory.js';
import {getAssignmentKernelSnapshotV2} from '../src/assignments/assignment_kernel_v2_store.js';
import {beginTeammateLoopOwner,endTeammateLoopOwner} from '../src/teammate_loop_runtime.js';
import {handleCodexDynamicToolCall} from '../src/brains/codex_dynamic_tool_handler.js';
import {runWithRequestContext} from '../src/request_context.js';
import {createOperatorBackendAuth} from '../src/operator_backend_auth.js';
import {canonicalJsonV2,deriveProgressGapsV2} from '../src/domain/assignment-kernel/index.js';
import {controlAssignmentExecutionV2} from '../src/assignments/assignment_kernel_v2_controls.js';

function fixture(){
 const output='C:/fixture/result.rvt',identity={session_id:'native-document-1',project_fingerprint:'a'.repeat(64),path:output};
 const file={path:output,size_bytes:4096,sha256:'b'.repeat(64),exists:true,readable:true,stable_read:true,fresh_output:true};
 const receipt={schema:'revit-operator.native-artifact-receipt.v1',method:'POST',path:'/revit/save-as',phase:'apply',status:'complete',
  expected_output_paths:[output],expected_export_calls:1,export_calls:[true],outputs:[file],
  save_document:{native_save_returned:true,same_document:true,document_session_changed:false,project_binding_changed:false,document_path_changed:true,
   before:{...identity,path:'C:/fixture/source.rvt'},after:identity}};
 return {output,receipt,input:{method:'POST',path:'/revit/save-as',body:{filePath:output,overwrite:false,dryRun:false}},
  read:{schema:'revit-operator.exported-file-inspection.v1',ok:true,itemsComplete:true,requestedPaths:[output],files:[{...file,fresh_output:false}],
    saved_document:{...identity,is_modified:false,is_modifiable:false,is_family_document:false}}};
}

for(const variant of ['exact','native_session_transition','dirty_document','wrong_hash','wrong_native_session','read_failure','read_schema_rejected','paused_after_save'] as const)
test(`ordinary native save ${variant} receives one guarded fresh file/document read without another save`,async()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'operator-host-save-check-')),previous=process.env.OPERATOR_WORKSPACE_ROOT;
 process.env.OPERATOR_WORKSPACE_ROOT=root;__testOnlyResetGoalListCache();
 try { await runWithRequestContext({operator_backend_auth:createOperatorBackendAuth('shared_token','test-only')},async()=>{
  const f=fixture();
  if(variant==='native_session_transition'){
   f.receipt.save_document.document_session_changed=true;
   f.receipt.save_document.after.session_id='native-after-save';
   f.read.saved_document.session_id='native-after-save';
  }
  const goal=createGoal({title:'Save the updated model',objective:'Save the updated model as a new result.',acceptance_criteria:['The requested output is saved.'],status:'active',
   related_session_id:'save-host-session',created_by:'save-host-principal',work_budget:{requested_effect:'apply',document_fingerprint:'a'.repeat(64)}});
  createAssignmentKernelForGoalV2({goal,run_id:'save-host-run'});const binding=getAssignmentKernelSnapshotV2(goal.id)!.current_binding;
  const calls:any[]=[],validations:any[]=[];
  const runtime:any={assignmentKernelV2Binding:()=>binding,queueAssignmentKernelV2TurnStop(){},
   async validateToolArguments(_tool:string,args:any){validations.push(args);if(args.path==='/revit/inspect-exported-files'){
    assert.deepEqual(args.body,{paths:[f.output]});if(variant==='read_schema_rejected')throw Error('read_schema_rejected');
   }},async callTool(_tool:string,args:any,context:any){
    calls.push(args);const lease=context.assignmentKernelV2;context.onMcpAccepted();
    const read=args.path==='/revit/inspect-exported-files';if(read&&variant==='read_failure')throw Error('native_read_failed');
    const payload:any=read?structuredClone(f.read):{status:'Success',ok:true,artifact_receipt:f.receipt};
    if(read){if(variant==='dirty_document')payload.saved_document.is_modified=true;if(variant==='wrong_hash')payload.files[0].sha256='c'.repeat(64);
     if(variant==='wrong_native_session')payload.saved_document.session_id='different';}
    const op=getAssignmentKernelSnapshotV2(goal.id)!.operations[lease.operation_id]!;
    if(!read&&variant==='paused_after_save')controlAssignmentExecutionV2({binding,command_id:'user-pause',expected_command_id:null,action:'pause'});
    return {content:[{type:'text',text:JSON.stringify(payload)}],structuredContent:{schema:'revit-operator.assignment-kernel-mcp-result/v2',
     operation_result_v2:{schema:'revit-operator.operation-result/v2',result_id:'result:'+lease.operation_id,operation_id:lease.operation_id,binding,
      status:'succeeded',dispatch_state:'dispatched',persistent_effect:read?'none':'applied',native_transaction_state:'not_applicable',authority:'native-host',
      affected_target_identities:['artifact_path:'+f.output.toLowerCase()],result_schema_id:`operator-native/POST:${args.path}/v2`,observation_required:true,
      ...(!read?{native_artifact_receipt:f.receipt}:{}),raw_payload_hash:createHash('sha256').update(canonicalJsonV2(payload)).digest('hex'),
      receipt_id:'receipt:'+lease.operation_id,native_correlation_id:'native:'+lease.operation_id,request_identity:lease.request_identity,completed_at:new Date().toISOString()},
     observation:{raw_payload:payload,semantic_facts:[{fact_id:op.fulfillment_role==='verification'?'verification.result_available':'control.result_available',
      fact_class:op.fulfillment_role==='verification'?'verification':'control',value:true}],verification_relevance:['control']}}};
   }};
  const owner=beginTeammateLoopOwner(runtime,{version:'operator.backend.v1',session_id:binding.session_id,message_id:'save-task',user_text:goal.objective,
   assignment_id:binding.assignment_id,assignment_run_id:binding.run_id,assignment_generation:binding.generation} as any,{canonicalSupervisionOnly:true});
  try {
   const response:any=await handleCodexDynamicToolCall(runtime,{id:'user-save',method:'item/tool/call',params:{namespace:'revit_operator',turnId:'save-turn',tool:'revit_call_tool',arguments:f.input}} as any);
   __testOnlyResetGoalListCache();const s=getAssignmentKernelSnapshotV2(goal.id)!,apply=Object.values(s.operations).find(o=>o.requested_effect==='apply')!;
   assert.equal(apply.result?.persistent_effect,'applied');assert.equal(calls.filter(c=>c.path==='/revit/save-as').length,1);assert.equal(response.success,true);
   assert.equal(validations.filter(c=>c.path==='/revit/inspect-exported-files').length,variant==='paused_after_save'?0:1);
   assert.equal(calls.filter(c=>c.path==='/revit/inspect-exported-files').length,['paused_after_save','read_schema_rejected'].includes(variant)?0:1);
   const verified=apply.verification_operation_ids.some(id=>s.operations[id]!.observation_ids.some(oid=>s.observations[oid]!.facts.some(x=>x.fact_id==='verification.postcondition_satisfied'&&x.value===true)));
   const expectedVerified=['exact','native_session_transition'].includes(variant);
   assert.equal(verified,expectedVerified);assert.equal(deriveProgressGapsV2(s).some(g=>g.gap_id==='verification:'+apply.operation_id),!expectedVerified);
   if(variant==='read_schema_rejected'){
    const before=structuredClone(s),stopped=structuredClone(s);Object.assign(stopped,{terminal:true,outcome:'blocked',terminal_reason:'provider_call_budget_exhausted'});
    const handoff=deriveTerminalResultV2(stopped);
    assert.match(handoff.result_summary,/Saved copy: result\.rvt/,'A native save receipt must survive a later verification/budget stop');
    assert.match(handoff.result_summary,/content verification.*pending/i);assert.equal(handoff.outcome,'blocked');assert(handoff.evidence_refs.includes(s.observations[apply.observation_ids[0]!]!.raw_payload_ref));
    assert.deepEqual(s,before,'Rendering a partial saved result must not certify it or change lifecycle state');
    assert(savedCopyHandoffV2(stopped));
    for(const mutate of [(v:any)=>v.unresolved_unknown_operation_ids=['old-unknown'],(v:any)=>v.in_flight_operation_ids=['pending-native'],
     (v:any)=>v.current_binding={...v.current_binding,run_id:'foreign'},(v:any)=>v.input_invalidated_operation_ids=[apply.operation_id],
     (v:any)=>v.operations[apply.operation_id].result.authority='model',(v:any)=>v.operations[apply.operation_id].result.persistent_effect='unknown',
     (v:any)=>v.operations[apply.operation_id].input.body.filePath='C:/foreign/other.rvt',
     (v:any)=>v.operations[apply.operation_id].result.native_artifact_receipt.save_document.native_save_returned=false,
     (v:any)=>v.operations[apply.operation_id].result.native_artifact_receipt.outputs[0].stable_read=false,
     (v:any)=>v.operations[apply.operation_id].result.native_artifact_receipt.outputs[0].sha256='c'.repeat(64),
     (v:any)=>v.operations[apply.operation_id].observation_ids=[],
     (v:any)=>v.observations[apply.observation_ids[0]!].raw_payload_hash='d'.repeat(64),
     (v:any)=>v.observations[apply.observation_ids[0]!].authority='model',
     (v:any)=>v.operations['later-edit']={...v.operations[apply.operation_id],operation_id:'later-edit',result:{...v.operations[apply.operation_id].result,completed_at:'2099-01-01T00:00:00Z'}}]){
      const altered=structuredClone(stopped);mutate(altered);assert.equal(savedCopyHandoffV2(altered),null,'Stale, foreign, invented or unbacked saved-file claims cannot become a partial deliverable');
    }

   }
   if(expectedVerified){
    assert.equal(committedSavedDocumentReadbackPlanV2(s,apply),null,'Never repeat completed automatic read');
    const plain:any=structuredClone(s);plain.operations[apply.operation_id].verification_operation_ids=[];plain.observations={};plain.operations[apply.operation_id].observation_ids=[];
    for(const mutate of [(v:any)=>v.execution_control={state:'paused'},(v:any)=>v.unresolved_unknown_operation_ids=['old-unknown'],
     (v:any)=>v.terminal=true,(v:any)=>v.completion_proposal={},(v:any)=>v.input_invalidated_operation_ids=[apply.operation_id],
     (v:any)=>v.current_binding={...v.current_binding,generation:2},
     (v:any)=>v.operations[apply.operation_id].result.authority='model',
     (v:any)=>v.operations[apply.operation_id].result.native_artifact_receipt.outputs[0].stable_read=false]){
      const altered=structuredClone(plain);mutate(altered);assert.equal(committedSavedDocumentReadbackPlanV2(altered,altered.operations[apply.operation_id]),null);
    }
   }
  }finally{endTeammateLoopOwner(owner);}
 });}finally{__testOnlyResetGoalListCache();if(previous===undefined)delete process.env.OPERATOR_WORKSPACE_ROOT;else process.env.OPERATOR_WORKSPACE_ROOT=previous;fs.rmSync(root,{recursive:true,force:true});}
});
