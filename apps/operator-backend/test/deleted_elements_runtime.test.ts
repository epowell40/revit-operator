import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import {createHash}from 'node:crypto';import test from 'node:test';
import {createGoal,getGoal,__testOnlyResetGoalListCache}from '../src/goals/service.js';
import {__closeForTests}from '../src/memory/sqlite_store.js';
import {runWithRequestContext}from '../src/request_context.js';import {createOperatorBackendAuth}from '../src/operator_backend_auth.js';
import {createAssignmentKernelForGoalV2}from '../src/assignments/assignment_kernel_v2_factory.js';
import {getAssignmentKernelSnapshotV2}from '../src/assignments/assignment_kernel_v2_store.js';
import {openAssignmentKernelOperationV2,markAssignmentKernelOperationDispatchStartedV2,settleAssignmentKernelOperationV2}from '../src/assignments/assignment_kernel_v2_execution.js';
import {AssignmentJournalV2,canonicalJsonV2}from '../src/domain/assignment-kernel/index.js';
import {verifiedNativeWorkTargetIdentitiesV2}from '../src/domain/assignment-kernel/verified_work_targets.js';
import {checkedEditIsCurrentV2}from '../src/verification/current_postcondition_v2.js';
import {operationTargetSelectorV2}from '../src/verification/verification_capability_admission_v2.js';
import {committedDeletedElementsReadbackPlansV2,deletedElementsPostconditionSatisfiedV2}from '../src/verification/deleted_elements_postcondition_v2.js';
import {handleCodexDynamicToolCall}from '../src/brains/codex_dynamic_tool_handler.js';
import {beginTeammateLoopOwner,endTeammateLoopOwner}from '../src/teammate_loop_runtime.js';
import {controlAssignmentExecutionV2}from '../src/assignments/assignment_kernel_v2_controls.js';
const wire=JSON.parse(fs.readFileSync('test/fixtures/native_deletion_apply_189.json','utf8').replace(/^\uFEFF/,''));
async function workspace(fn:()=>unknown){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'operator-deletion-proof-'));
  const env={OPERATOR_WORKSPACE_ROOT:root,REVIT_OPERATOR_MODE:'development',OPERATOR_LOCAL_EXECUTOR_PROFILE:'codex_v2_advisory_v1',OPERATOR_ASSIGNMENT_KERNEL_V2:'1',OPERATOR_BRAIN:'codex',OPERATOR_TOOL_EXPOSURE_PROFILE:'laboratory',OPERATOR_HOSTED_ENABLED:'0'};
  const old=Object.fromEntries(Object.keys(env).map(k=>[k,process.env[k]]));Object.assign(process.env,env);__testOnlyResetGoalListCache();
  try{await runWithRequestContext({operator_backend_auth:createOperatorBackendAuth('shared_token','test-only',{OPERATOR_API_BASE_URL:'http://127.0.0.1:7007'})},fn);}
  finally{__testOnlyResetGoalListCache();__closeForTests();for(const[k,v]of Object.entries(old)){if(v===undefined)delete process.env[k];else process.env[k]=v;}fs.rmSync(root,{recursive:true,force:true});}
}
for(const variant of ['exact','ordinary_exact','known_collateral','missing_chunk','survivor','read_before_commit','wrong_native_scope']as const)
test(`kernel deletion proof requires the complete fresh native closure: ${variant}`,()=>workspace(()=>{
  const goal=createGoal({title:'Delete redundant hidden instances',objective:'Remove the two confirmed hidden duplicates and preserve unrelated work.',acceptance_criteria:['The two duplicates are absent.'],status:'active',related_session_id:'delete-session',created_by:'local-host',work_budget:{requested_effect:'apply',document_fingerprint:'a'.repeat(64)}});
  createAssignmentKernelForGoalV2({goal,run_id:'delete-run'});const state=()=>getAssignmentKernelSnapshotV2(goal.id)!;
  const input=variant==='ordinary_exact'?{method:'POST',path:'/revit/delete',body:{ids:[1722844,1722859]}}:structuredClone(wire.input);
  if(variant==='known_collateral'){input.body.transaction.allowedExistingElementIds.push(9000001);input.body.transaction.maxAffectedElements=21;}
  const edit=openAssignmentKernelOperationV2({snapshot:state(),provider_turn_id:'turn',controller_request_id:'apply',capability_id:'revit_call_tool',classified_effect:'apply',target_tokens:[],arguments:input});
  function settle(lease:typeof edit,payload:any,editing:boolean){
    markAssignmentKernelOperationDispatchStartedV2(lease);const op=state().operations[lease.operation_id]!;
    const result={schema:'revit-operator.operation-result/v2',result_id:'result:'+lease.operation_id,operation_id:lease.operation_id,binding:lease.binding,status:'succeeded',dispatch_state:'dispatched',persistent_effect:editing?'applied':'none',native_transaction_state:editing?'committed':'not_applicable',authority:'native-host',
      result_schema_id:'operator-native/POST:'+op.request_identity!.path+'/v2',observation_required:true,affected_target_identities:editing?[...new Set<number>([...payload.transaction.deleted_element_ids,...payload.transaction.modified_element_ids,...payload.transaction.added_element_ids])].map(id=>'element_id:'+id).sort():[],receipt_id:'receipt:'+lease.operation_id,native_correlation_id:'native:'+lease.operation_id,request_identity:op.request_identity,completed_at:new Date().toISOString(),raw_payload_hash:createHash('sha256').update(canonicalJsonV2(payload)).digest('hex')};
    settleAssignmentKernelOperationV2(lease,{content:[],structuredContent:{schema:'revit-operator.assignment-kernel-mcp-result/v2',operation_result_v2:result,observation:{raw_payload:payload,semantic_facts:[{fact_id:editing?'task.result_available':'verification.result_available',fact_class:editing?'domain':'verification',value:true}],verification_relevance:['task_result']}}});
  }
  let applied=structuredClone(wire.applied);if(variant==='wrong_native_scope')applied.transaction.scope_observer_executions=0;
  if(variant==='known_collateral'){
    applied.transaction.allowed_existing_element_ids.push(9000001);applied.transaction.commit_allowed_existing_element_ids.push(9000001);
    applied.transaction.modified_element_ids=[9000001];applied.transaction.max_affected_elements=21;applied.transaction.affected_element_count=21;
  }
  if(variant==='ordinary_exact'){
    const ids:number[]=wire.applied.transaction.deleted_element_ids;
    applied={status:'Deleted',requestedCount:2,requestedIds:input.body.ids,impactedCount:ids.length,impactedIds:ids,
      dependentIds:ids.filter(id=>!input.body.ids.includes(id)),transaction:{...wire.applied.transaction,affected_element_ids:ids},
      changeTracking:{documentChangedObserved:true,exhaustiveChangeInventory:true,captureFailureCount:0,matchingEventCount:1,eventCount:1}};
  }
  settle(edit,applied,true);
  const plans=committedDeletedElementsReadbackPlansV2(state(),state().operations[edit.operation_id]!);
  if(variant==='wrong_native_scope'){assert.equal(plans,null);return;}
  assert.equal(plans!.length,2);assert.deepEqual(plans!.map(p=>p.body.operations.length),[16,4]);
  let last:any,lastPayload:any;
  for(const[index,plan]of plans!.entries()){
    if(variant==='missing_chunk'&&index===1)break;
    const targets=operationTargetSelectorV2({operation:{capability_id:'revit_call_tool',path:plan.path,arguments:plan},value:plan.body}).principal_target_tokens;
    last=openAssignmentKernelOperationV2({snapshot:state(),provider_turn_id:'turn',controller_request_id:'read'+index,capability_id:'revit_call_tool',classified_effect:'read',target_tokens:targets,arguments:plan,
      ...(variant==='read_before_commit'?{opened_at:'2020-01-01T00:00:00Z'}:{})});
    assert.equal(state().operations[last.operation_id]!.purpose,'verification');assert.equal(state().operations[last.operation_id]!.verification_of_operation_id,edit.operation_id);
    lastPayload={version:'operator.native_api_ops.v2',ok:true,read_only:true,operation_count:plan.body.operations.length,
      operations:plan.body.operations.map(s=>({id:s.id,op:s.op,member_id:s.memberId,target_type:'Autodesk.Revit.DB.Document',result_preview:null})),results:Object.fromEntries(plan.body.operations.map(s=>[s.id,null]))};
    if(variant==='survivor'&&index===0){lastPayload.operations[0].result_preview={id:plan.body.operations[0]!.args[0]};lastPayload.results.absent0=lastPayload.operations[0].result_preview;}
    settle(last,lastPayload,false);
    if(index===0)assert.equal(checkedEditIsCurrentV2(state(),edit.operation_id),false,'One completed chunk is not the full deletion closure');
  }
  const snapshot=state();assert.equal(checkedEditIsCurrentV2(snapshot,edit.operation_id),['exact','ordinary_exact','known_collateral'].includes(variant));
  if(['exact','ordinary_exact','known_collateral'].includes(variant)){
    assert.deepEqual(verifiedNativeWorkTargetIdentitiesV2(snapshot,edit.operation_id),['element_id:1722844','element_id:1722859'],'Dependent IDs earn no additional work credit');
    const proof=(s:typeof snapshot)=>deletedElementsPostconditionSatisfiedV2(s,s.operations[edit.operation_id]!,s.operations[last.operation_id]!.result!,lastPayload);
    assert.equal(proof(snapshot),true);
    for(const mutate of [
      (s:any)=>s.current_binding.document_fingerprint='other',
      (s:any)=>s.unresolved_unknown_operation_ids=['old-unknown'],
      (s:any)=>s.input_invalidated_operation_ids=[edit.operation_id],
      (s:any)=>s.operations[last.operation_id].result.authority='backend',
      (s:any)=>s.operations[last.operation_id].result.request_identity.request_signature='foreign',
      (s:any)=>s.operations[last.operation_id].result.native_transaction_state='committed',
      (s:any)=>delete s.operations[last.operation_id].result.receipt_id,
      (s:any)=>s.operations[last.operation_id].purpose='discovery',
      (s:any)=>s.operations[last.operation_id].binding.principal_id='other-owner',
      (s:any)=>s.operations[s.operations[edit.operation_id].verification_operation_ids[0]].result.raw_payload_hash='0'.repeat(64),
      (s:any)=>s.operations[edit.operation_id].result.raw_payload_hash='0'.repeat(64)
    ]){const altered=structuredClone(snapshot);mutate(altered);assert.equal(proof(altered),false);}
  }
  assert.equal(Object.values(snapshot.operations).filter(o=>o.requested_effect==='apply').length,1,'Verification never repeats the deletion');
  assert.deepEqual(new AssignmentJournalV2(getGoal(goal.id)!.assignment_kernel_v2!.events).snapshot(),snapshot);
}));

for(const variant of ['exact','schema_rejected','survivor','paused','unknown','pending']as const)
test(`ordinary dispatcher performs separate deletion checks without another write: ${variant}`,()=>workspace(async()=>{
  const goal=createGoal({title:'Clean hidden duplicates',objective:'Delete the two confirmed redundant instances.',acceptance_criteria:['The duplicates are absent.'],status:'active',related_session_id:'delete-dispatch',created_by:'local-host',work_budget:{requested_effect:'apply',document_fingerprint:'a'.repeat(64)}});
  createAssignmentKernelForGoalV2({goal,run_id:'delete-dispatch-run'});const state=()=>getAssignmentKernelSnapshotV2(goal.id)!,binding=state().current_binding,calls:any[]=[];
  const runtime:any={assignmentKernelV2Binding:()=>binding,queueAssignmentKernelV2TurnStop(){},
    async validateToolArguments(_tool:string,args:any){if(args.path==='/revit/native-api-ops'){assert(args.body.operations.length<=16);if(variant==='schema_rejected')throw Error('schema rejected');}},
    async callTool(_tool:string,args:any,context:any){
      calls.push(args);const lease=context.assignmentKernelV2;context.onMcpAccepted();const read=args.path==='/revit/native-api-ops';
      const payload=read?{version:'operator.native_api_ops.v2',ok:true,read_only:true,operation_count:args.body.operations.length,
        operations:args.body.operations.map((s:any)=>({id:s.id,op:s.op,member_id:s.memberId,target_type:'Autodesk.Revit.DB.Document',result_preview:null})),results:Object.fromEntries(args.body.operations.map((s:any)=>[s.id,null]))}:structuredClone(wire.applied);
      if(read&&variant==='survivor'){payload.operations[0].result_preview={id:args.body.operations[0].args[0]};payload.results.absent0=payload.operations[0].result_preview;}
      if(!read&&variant==='paused')controlAssignmentExecutionV2({binding,command_id:'pause',expected_command_id:null,action:'pause'});
      const op=state().operations[lease.operation_id]!;
      return {content:[{type:'text',text:JSON.stringify(payload)}],structuredContent:{schema:'revit-operator.assignment-kernel-mcp-result/v2',
        operation_result_v2:{schema:'revit-operator.operation-result/v2',result_id:'result:'+lease.operation_id,operation_id:lease.operation_id,binding,status:'succeeded',dispatch_state:'dispatched',
          persistent_effect:read?'none':variant==='unknown'?'unknown':'applied',native_transaction_state:read?'not_applicable':variant==='pending'?'pending':'committed',authority:'native-host',
          affected_target_identities:read?[]:wire.applied.transaction.deleted_element_ids.map((id:number)=>'element_id:'+id),result_schema_id:`operator-native/POST:${args.path}/v2`,observation_required:true,
          raw_payload_hash:createHash('sha256').update(canonicalJsonV2(payload)).digest('hex'),receipt_id:'receipt:'+lease.operation_id,native_correlation_id:'native:'+lease.operation_id,request_identity:lease.request_identity,completed_at:new Date().toISOString()},
        observation:{raw_payload:payload,semantic_facts:[{fact_id:op.fulfillment_role==='verification'?'verification.result_available':'task.result_available',fact_class:op.fulfillment_role==='verification'?'verification':'domain',value:true}],verification_relevance:['task_result']}}};
    }};
  const owner=beginTeammateLoopOwner(runtime,{version:'operator.backend.v1',session_id:binding.session_id,message_id:'delete',user_text:goal.objective,assignment_id:binding.assignment_id,assignment_run_id:binding.run_id,assignment_generation:binding.generation}as any,{canonicalSupervisionOnly:true});
  try{
    await handleCodexDynamicToolCall(runtime,{id:'apply-delete',method:'item/tool/call',params:{namespace:'revit_operator',turnId:'delete-turn',tool:'revit_call_tool',arguments:wire.input}}as any);
    __testOnlyResetGoalListCache();const snapshot=state(),apply=Object.values(snapshot.operations).find(o=>o.requested_effect==='apply')!;
    assert.equal(calls.filter(c=>c.path==='/revit/native-api-mutation-ops').length,1);
    assert.equal(checkedEditIsCurrentV2(snapshot,apply.operation_id),variant==='exact');
    if(variant==='exact'){assert.deepEqual(calls.slice(1).map(c=>c.body.operations.length),[16,4]);assert.deepEqual(snapshot.in_flight_operation_ids,[]);}
    if(['paused','unknown','pending','schema_rejected'].includes(variant))assert.equal(calls.length,1);
    if(variant==='unknown')assert(snapshot.unresolved_unknown_operation_ids.includes(apply.operation_id));
    else if(variant!=='pending')assert.equal(apply.persistent_effect,'applied');
  }finally{endTeammateLoopOwner(owner);}
}));
