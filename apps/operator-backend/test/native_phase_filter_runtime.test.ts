import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import {createHash}from 'node:crypto';import test from 'node:test';
import {phaseFilterFixtureV2 as fixture}from './helpers/native_phase_filter_fixture.js';
import {createGoal,getGoal,__testOnlyResetGoalListCache}from '../src/goals/service.js';
import {__closeForTests}from '../src/memory/sqlite_store.js';
import {runWithRequestContext}from '../src/request_context.js';import {createOperatorBackendAuth}from '../src/operator_backend_auth.js';
import {createAssignmentKernelForGoalV2}from '../src/assignments/assignment_kernel_v2_factory.js';
import {getAssignmentKernelSnapshotV2}from '../src/assignments/assignment_kernel_v2_store.js';
import {openAssignmentKernelOperationV2,markAssignmentKernelOperationDispatchStartedV2,settleAssignmentKernelOperationV2}from '../src/assignments/assignment_kernel_v2_execution.js';
import {AssignmentJournalV2,canonicalJsonV2}from '../src/domain/assignment-kernel/index.js';
import {checkedEditIsCurrentV2}from '../src/verification/current_postcondition_v2.js';
import {operationTargetSelectorV2}from '../src/verification/verification_capability_admission_v2.js';
import {nativePhaseFilterPostconditionSatisfiedV2}from '../src/verification/native_phase_filter_v2.js';

async function workspace(fn:()=>unknown){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'operator-phase-proof-'));
 const env={OPERATOR_WORKSPACE_ROOT:root,REVIT_OPERATOR_MODE:'development',OPERATOR_LOCAL_EXECUTOR_PROFILE:'codex_v2_advisory_v1',OPERATOR_ASSIGNMENT_KERNEL_V2:'1',OPERATOR_BRAIN:'codex',OPERATOR_TOOL_EXPOSURE_PROFILE:'laboratory',OPERATOR_HOSTED_ENABLED:'0'};
 const old=Object.fromEntries(Object.keys(env).map(k=>[k,process.env[k]]));Object.assign(process.env,env);__testOnlyResetGoalListCache();
 try{await runWithRequestContext({operator_backend_auth:createOperatorBackendAuth('shared_token','test-only',{OPERATOR_API_BASE_URL:'http://127.0.0.1:7007'})},fn);}
 finally{__testOnlyResetGoalListCache();__closeForTests();for(const [k,v]of Object.entries(old)){if(v===undefined)delete process.env[k];else process.env[k]=v;}fs.rmSync(root,{recursive:true,force:true});}
}
for(const variant of ['exact','wrong_receiver','wrong_values','read_before_commit','incorrect_scope']as const){
 test(`kernel derives native phase-filter proof only for ${variant} exact fresh evidence`,()=>workspace(()=>{
  const f=fixture(),goal=createGoal({title:'Make a new-only phase filter',objective:'Create a new phase filter showing only new elements.',acceptance_criteria:['The new filter has the requested status settings.'],status:'active',related_session_id:'phase-session',created_by:'local-host',work_budget:{requested_effect:'apply',document_fingerprint:'a'.repeat(64)}});
  createAssignmentKernelForGoalV2({goal,run_id:'phase-run'});const state=()=>getAssignmentKernelSnapshotV2(goal.id)!;
  const edit=openAssignmentKernelOperationV2({snapshot:state(),provider_turn_id:'turn',controller_request_id:'apply',capability_id:'revit_call_tool',classified_effect:'apply',target_tokens:[],arguments:f.input});
  function settle(lease:typeof edit,payload:any,editing:boolean){
   markAssignmentKernelOperationDispatchStartedV2(lease);const op=state().operations[lease.operation_id]!;
   const result={schema:'revit-operator.operation-result/v2',result_id:'result:'+lease.operation_id,operation_id:lease.operation_id,binding:lease.binding,status:'succeeded',dispatch_state:'dispatched',persistent_effect:editing?'applied':'none',native_transaction_state:editing?'committed':'not_applicable',authority:'native-host',
    result_schema_id:'operator-native/POST:'+op.request_identity!.path+'/v2',observation_required:true,affected_target_identities:editing?f.affected:[],receipt_id:'receipt:'+lease.operation_id,native_correlation_id:'native:'+lease.operation_id,request_identity:op.request_identity,completed_at:new Date().toISOString(),raw_payload_hash:createHash('sha256').update(canonicalJsonV2(payload)).digest('hex')};
   settleAssignmentKernelOperationV2(lease,{content:[],structuredContent:{schema:'revit-operator.assignment-kernel-mcp-result/v2',operation_result_v2:result,observation:{raw_payload:payload,semantic_facts:[{fact_id:editing?'task.result_available':'verification.result_available',fact_class:editing?'domain':'verification',value:true}],verification_relevance:['task_result']}}});
  }
  if(variant==='incorrect_scope')f.applied.transaction.scope_observer_executions=0;
  settle(edit,f.applied,true);
  const targets=operationTargetSelectorV2({operation:{capability_id:'revit_call_tool',path:f.read.path,arguments:f.read},value:f.read.body}).principal_target_tokens;
  const read=openAssignmentKernelOperationV2({snapshot:state(),provider_turn_id:'turn',controller_request_id:'read',capability_id:'revit_call_tool',classified_effect:'read',target_tokens:targets,arguments:f.read,
   ...(variant==='read_before_commit'?{opened_at:'2020-01-01T00:00:00Z'}:{})});
  assert.equal(state().operations[read.operation_id]!.purpose,'verification');assert.equal(state().operations[read.operation_id]!.verification_of_operation_id,edit.operation_id);
  if(variant==='wrong_receiver')f.readback.operations[1].target_identity.unique_id='foreign';
  if(variant==='wrong_values'){f.readback.operations[1].result_preview='DontShow';f.readback.results.new='DontShow';}
  settle(read,f.readback,false);const snapshot=state(),verified=snapshot.operations[read.operation_id]!.observation_ids.some(id=>snapshot.observations[id]!.facts.some(f=>f.fact_id==='verification.postcondition_satisfied'&&f.value===true));
  assert.equal(verified,variant==='exact');assert.equal(checkedEditIsCurrentV2(snapshot,edit.operation_id),variant==='exact');
  if(variant==='exact'){
   const proof=(s:typeof snapshot,payload:any=f.readback)=>nativePhaseFilterPostconditionSatisfiedV2(s,s.operations[edit.operation_id]!,s.operations[read.operation_id]!.result!,payload);
   assert.equal(proof(snapshot),true);
   const guards:Record<string,(s:typeof snapshot)=>void>={
    'foreign current document':s=>s.current_binding.document_fingerprint='b'.repeat(64),
    'backend authority':s=>s.operations[read.operation_id]!.result!.authority='backend',
    'changed request signature':s=>s.operations[read.operation_id]!.result!.request_identity!.request_signature='other',
    'invalidated input':s=>s.input_invalidated_operation_ids=[edit.operation_id],
    'unresolved prior effect':s=>s.unresolved_unknown_operation_ids=['other'],
    'read is discovery':s=>s.operations[read.operation_id]!.purpose='discovery',
    'missing immutable apply hash':s=>s.operations[edit.operation_id]!.result!.raw_payload_hash='0'.repeat(64),
    'another open apply':s=>{const o=structuredClone(s.operations[edit.operation_id]!);o.operation_id='other';s.operations={...s.operations,other:o};s.in_flight_operation_ids=[...s.in_flight_operation_ids,'other'];}
   };
   for(const [name,mutate]of Object.entries(guards)){const s=structuredClone(snapshot);mutate(s);assert.equal(proof(s),false,name);}
   assert.equal(proof(snapshot,{...f.readback,extra:'changed payload'}),false,'payload hash is bound to the actual read');
  }
  assert.equal(Object.values(snapshot.operations).filter(o=>o.requested_effect==='apply').length,1,'checking never repeats the mutation');
  assert.deepEqual(new AssignmentJournalV2(getGoal(goal.id)!.assignment_kernel_v2!.events).snapshot(),snapshot);
 }));
}
