import assert from 'node:assert/strict';import test from 'node:test';
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import {createHash} from 'node:crypto';
import {reserveCommittedReadbacksV2,consumeCommittedReadbackV2,retireCommittedReadbacksV2,isCommittedReadbackReservationV2} from '../src/brains/committed_readback_reservations_v2.js';
import {createGoal,__testOnlyResetGoalListCache} from '../src/goals/service.js';
import {createAssignmentKernelForGoalV2} from '../src/assignments/assignment_kernel_v2_factory.js';
import {getAssignmentKernelSnapshotV2} from '../src/assignments/assignment_kernel_v2_store.js';
import {openAssignmentKernelOperationV2,markAssignmentKernelOperationDispatchStartedV2,settleAssignmentKernelOperationV2} from '../src/assignments/assignment_kernel_v2_execution.js';
import {evaluatePendingAssignmentCriteriaV2,DEFAULT_ASSIGNMENT_PROGRESS_BUDGET_V2} from '../src/assignments/assignment_kernel_v2_progress.js';
import {controlAssignmentExecutionV2} from '../src/assignments/assignment_kernel_v2_controls.js';
import {runWithRequestContext} from '../src/request_context.js';import {createOperatorBackendAuth} from '../src/operator_backend_auth.js';
import {canonicalJsonV2,assignmentProgressBudgetBlockerV2,assignmentNativeReadbackResourceBlockerV2} from '../src/domain/assignment-kernel/index.js';

for(const variant of ['exact','forged','wrong_owner','wrong_id','wrong_turn','changed_args','reused','pause','schema_refused','mutating_plan','wrong_target'] as const)
test(`a reserved native read cannot gain authority through ${variant}`,async()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'read-reservation-')),old=process.env.OPERATOR_WORKSPACE_ROOT;
 process.env.OPERATOR_WORKSPACE_ROOT=root;__testOnlyResetGoalListCache();
 try{await runWithRequestContext({operator_backend_auth:createOperatorBackendAuth('shared_token','test')},async()=>{
  const goal=createGoal({title:'Save a model copy',objective:'Save a new model copy.',acceptance_criteria:['The saved copy is established.'],status:'active',related_session_id:'reservation-session',created_by:'reservation-principal',work_budget:{requested_effect:'apply',document_fingerprint:'a'.repeat(64)}});
  createAssignmentKernelForGoalV2({goal,run_id:'reservation-run'});const snapshot=()=>getAssignmentKernelSnapshotV2(goal.id)!,binding=snapshot().current_binding;
  const output='C:/fixture/result.rvt',identity={session_id:'native-1',project_fingerprint:binding.document_fingerprint,path:output};
  const artifact={schema:'revit-operator.native-artifact-receipt.v1',method:'POST',path:'/revit/save-as',phase:'apply',status:'complete',expected_output_paths:[output],expected_export_calls:1,export_calls:[true],outputs:[{path:output,size_bytes:4096,sha256:'b'.repeat(64),stable_read:true,fresh_output:true}],save_document:{native_save_returned:true,same_document:true,document_session_changed:false,project_binding_changed:false,document_path_changed:true,before:{...identity,path:'C:/fixture/source.rvt'},after:identity}};
  const input={method:'POST',path:'/revit/save-as',body:{filePath:output,overwrite:false,dryRun:false}},payload={ok:true,status:'Success',artifact_receipt:artifact};
  const lease=openAssignmentKernelOperationV2({snapshot:snapshot(),controller_request_id:'save',provider_turn_id:'turn',capability_id:'revit_call_tool',classified_effect:'apply',arguments:input,target_tokens:['artifact_path:'+output.toLowerCase()]});
  markAssignmentKernelOperationDispatchStartedV2(lease);
  settleAssignmentKernelOperationV2(lease,{content:[{type:'text',text:JSON.stringify(payload)}],structuredContent:{schema:'revit-operator.assignment-kernel-mcp-result/v2',operation_result_v2:{schema:'revit-operator.operation-result/v2',result_id:'save-result',operation_id:lease.operation_id,binding,status:'succeeded',dispatch_state:'dispatched',persistent_effect:'applied',native_transaction_state:'not_applicable',authority:'native-host',affected_target_identities:['artifact_path:'+output.toLowerCase()],result_schema_id:'operator-native/POST:/revit/save-as/v2',observation_required:true,native_artifact_receipt:artifact,raw_payload_hash:createHash('sha256').update(canonicalJsonV2(payload)).digest('hex'),receipt_id:'receipt',native_correlation_id:'native-save',request_identity:lease.request_identity,completed_at:new Date().toISOString()},observation:{raw_payload:payload,semantic_facts:[{fact_id:'control.result_available',fact_class:'control',value:true}],verification_relevance:['control']}}});
  evaluatePendingAssignmentCriteriaV2({binding});
  const runtime:any={async validateToolArguments(){if(variant==='schema_refused')throw Error('schema_refused');}},parent:any={id:'owner',method:'item/tool/call',params:{turnId:'turn'}};
  const plan=variant==='mutating_plan'?input:{method:'POST',path:'/revit/inspect-exported-files',body:{paths:[variant==='wrong_target'?'C:/foreign/result.rvt':output]}};
  const batch=await reserveCommittedReadbacksV2({runtime,parent,snapshot:snapshot(),subjectId:lease.operation_id,plans:[plan]});
  if(['schema_refused','mutating_plan','wrong_target'].includes(variant)){assert.equal(batch.entries.length,0);assert(batch.reason);assert.deepEqual(snapshot().in_flight_operation_ids,[]);return;}
  assert.equal(batch.entries.length,1);const entry=batch.entries[0]!,args=entry.request.params!.arguments;
  try{
   assert(isCommittedReadbackReservationV2(entry.token));assert.equal(snapshot().operations[entry.operation_id]!.dispatch_state,'not_dispatched');
   if(variant==='forged'){assert.equal(isCommittedReadbackReservationV2({...entry.token}),false);assert.equal(consumeCommittedReadbackV2({...entry.token},runtime,entry.request,args),null);}
   else if(variant==='exact'||variant==='reused'){assert.equal(consumeCommittedReadbackV2(entry.token,runtime,entry.request,args)!.operation_id,entry.operation_id);if(variant==='reused')assert.throws(()=>consumeCommittedReadbackV2(entry.token,runtime,entry.request,args),/reservation_invalid/);}
   else{
    if(variant==='wrong_id')entry.request.id='different';
    if(variant==='wrong_turn')entry.request.params!.turnId='foreign';
    if(variant==='pause')controlAssignmentExecutionV2({binding,command_id:'pause',expected_command_id:null,action:'pause'});
    assert.throws(()=>consumeCommittedReadbackV2(entry.token,variant==='wrong_owner'?{}:runtime,entry.request,variant==='changed_args'?{...(args as any),body:{paths:['C:/foreign.rvt']}}:args),/reservation_invalid/);
   }
  }finally{retireCommittedReadbacksV2(batch.entries);}
  const s=snapshot();assert.deepEqual(s.in_flight_operation_ids,[]);assert.deepEqual(s.unresolved_unknown_operation_ids,[]);
  const read=s.operations[entry.operation_id]!;assert.equal(read.result?.status,'failed_before_dispatch');assert.equal(read.persistent_effect,'none');assert.equal(read.observation_ids.length,0);assert.equal(s.operations[lease.operation_id]!.persistent_effect,'applied');
 });}finally{__testOnlyResetGoalListCache();if(old===undefined)delete process.env.OPERATOR_WORKSPACE_ROOT;else process.env.OPERATOR_WORKSPACE_ROOT=old;assert.equal(path.dirname(root),os.tmpdir());fs.rmSync(root,{recursive:true,force:true});}
});

for(const kind of ['paid_calls','operation_room','operation_full','tokens','wall','no_progress','invalid_count'] as const)
test(`native read reservation preserves ${kind} resource limits`,()=>{
 const now='2026-10-17T00:00:10Z',s:any={spec:{created_at:'2026-10-17T00:00:00Z'},provider_calls:{p:{state:'completed',admitted_at:'2026-10-17T00:00:00Z',completed_at:now,usage:{total_tokens:1}}},operations:{},progress_epochs:[]};
 const budget={...DEFAULT_ASSIGNMENT_PROGRESS_BUDGET_V2,max_provider_calls:1,max_reasoning_turns:1,max_operations:2};let extra=1,expected:string|null=null;
 if(kind==='operation_room')s.operations.a={opened_at:now,settled_at:now};
 if(kind==='operation_full'){s.operations={a:{opened_at:now,settled_at:now},b:{opened_at:now,settled_at:now}};expected='operation_budget_exhausted';}
 if(kind==='tokens'){s.provider_calls.p.usage.total_tokens=budget.max_total_tokens;expected='token_budget_exhausted';}
 if(kind==='wall'){budget.max_wall_clock_ms=1;expected='execution_lease_exhausted';}
 if(kind==='no_progress'){s.progress_epochs=Array.from({length:budget.max_no_progress_epochs},()=>({genuine_progress:false,unresolved_gap_ids:['g']}));expected='no_progress_budget_exhausted';}
 if(kind==='invalid_count'){extra=-1;expected='invalid_readback_operation_count';}
 assert.equal(assignmentProgressBudgetBlockerV2(s,budget,now),'provider_call_budget_exhausted');
 assert.equal(assignmentNativeReadbackResourceBlockerV2(s,budget,now,extra),expected);
});
