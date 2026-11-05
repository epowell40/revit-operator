import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import test from 'node:test';import {createHash} from 'node:crypto';
import {beginRevitCourierTurnContext,endRevitCourierTurnContext,refreshRevitCourierDocumentTarget} from '../src/courier/revit_courier_context.js';
import {createGoal,__testOnlyResetGoalListCache} from '../src/goals/service.js';
import {createAssignmentKernelForGoalV2} from '../src/assignments/assignment_kernel_v2_factory.js';
import {getAssignmentKernelSnapshotV2} from '../src/assignments/assignment_kernel_v2_store.js';
import {openAssignmentKernelOperationV2,markAssignmentKernelOperationDispatchStartedV2,settleAssignmentKernelOperationV2} from '../src/assignments/assignment_kernel_v2_execution.js';
import {canonicalJsonV2} from '../src/domain/assignment-kernel/index.js';
import {runWithRequestContext} from '../src/request_context.js';import {createOperatorBackendAuth} from '../src/operator_backend_auth.js';

for(const variant of ['exact','relative_filename','stale_next_call','paused','unknown','terminal','pending_write','foreign_binding','foreign_session','foreign_document',
 'invalidated','failed_save','missing_observation','wrong_digest','altered_receipt','wrong_requested_path','missing_raw',
 'wrong_executor','wrong_job_path','foreign_job_session','failed_job','expired','tampered_context','unrelated_source','direct'] as const)
test(`saved document courier target preserves ${variant}`,async()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'operator-courier-save-target-'));
 const oldRoot=process.env.OPERATOR_WORKSPACE_ROOT,oldTransport=process.env.OPERATOR_REVIT_TRANSPORT;
 process.env.OPERATOR_WORKSPACE_ROOT=root;process.env.OPERATOR_REVIT_TRANSPORT='courier';__testOnlyResetGoalListCache();
 let active:ReturnType<typeof beginRevitCourierTurnContext>=null;
 try{await runWithRequestContext({operator_backend_auth:createOperatorBackendAuth('shared_token','test-only')},async()=>{
  const goal=createGoal({title:'Save a model copy',objective:'Save a new model copy.',acceptance_criteria:['The saved copy exists.'],status:'active',related_session_id:'target-session',created_by:'target-principal',work_budget:{requested_effect:'apply',document_fingerprint:'a'.repeat(64)}});
  createAssignmentKernelForGoalV2({goal,run_id:'target-run'});const snapshot=()=>getAssignmentKernelSnapshotV2(goal.id)!,binding=snapshot().current_binding;
  const before='C:/fixture/source.rvt',output='C:/fixture/result.rvt',identity={session_id:'native-after',project_fingerprint:binding.document_fingerprint,path:output};
  const artifact={schema:'revit-operator.native-artifact-receipt.v1',method:'POST',path:'/revit/save-as',phase:'apply',status:'complete',expected_output_paths:[output],expected_export_calls:1,export_calls:[true],outputs:[{path:output,size_bytes:4096,sha256:'b'.repeat(64),stable_read:true,fresh_output:true}],save_document:{native_save_returned:true,same_document:true,document_session_changed:true,project_binding_changed:false,document_path_changed:true,before:{...identity,session_id:'native-before',path:before},after:identity}};
  const input={method:'POST',path:'/revit/save-as',body:{filePath:variant==='relative_filename'?'result.rvt':output,overwrite:false,dryRun:false}},payload={ok:true,status:'Success',artifact_receipt:artifact};
  const op=openAssignmentKernelOperationV2({snapshot:snapshot(),controller_request_id:'save',provider_turn_id:'turn',capability_id:'revit_call_tool',classified_effect:'apply',arguments:input,target_tokens:['artifact_path:'+output.toLowerCase()]});markAssignmentKernelOperationDispatchStartedV2(op);
  const correlation=op.operation_id.slice('opv2_'.length),folder=path.join(root,'artifacts/revit-courier/jobs',correlation);fs.mkdirSync(folder,{recursive:true});
  const job:any={version:'revit-operator.revit-tool-job.v1',id:correlation,assignment_operation_id:op.operation_id,correlation_id:correlation,session_id:binding.session_id,method:'POST',path:'/revit/save-as',body:{dryRun:false,overwrite:false,filePath:input.body.filePath},status:'succeeded',target_executor_id:'fixture-executor',target_document_title:'source',target_document_path:before,claim:{executor_id:'fixture-executor'}};
  if(variant==='wrong_executor')job.claim.executor_id='foreign';if(variant==='wrong_job_path')job.target_document_path='C:/other/source.rvt';if(variant==='foreign_job_session')job.session_id='foreign';if(variant==='failed_job')job.status='failed';
  fs.writeFileSync(path.join(folder,'job.json'),JSON.stringify(job));fs.writeFileSync(path.join(folder,'result.json'),JSON.stringify({version:'revit-operator.revit-tool-result.v1',id:correlation,correlation_id:correlation,status:'succeeded',result:payload}));
  settleAssignmentKernelOperationV2(op,{content:[{type:'text',text:JSON.stringify(payload)}],structuredContent:{schema:'revit-operator.assignment-kernel-mcp-result/v2',operation_result_v2:{schema:'revit-operator.operation-result/v2',result_id:'save-result',operation_id:op.operation_id,binding,status:'succeeded',dispatch_state:'dispatched',persistent_effect:'applied',native_transaction_state:'not_applicable',authority:'native-host',affected_target_identities:['artifact_path:'+output.toLowerCase()],result_schema_id:'operator-native/POST:/revit/save-as/v2',observation_required:true,native_artifact_receipt:artifact,raw_payload_hash:createHash('sha256').update(canonicalJsonV2(payload)).digest('hex'),receipt_id:'receipt',native_correlation_id:correlation,request_identity:op.request_identity,completed_at:new Date().toISOString()},observation:{raw_payload:payload,semantic_facts:[{fact_id:'control.result_available',fact_class:'control',value:true}],verification_relevance:['control']}}});
  const saved=snapshot(),s:any=structuredClone(saved),operation=s.operations[op.operation_id],observation=s.observations[operation.observation_ids[0]];
  if(variant==='paused')s.execution_control={state:'paused'};if(variant==='unknown')s.unresolved_unknown_operation_ids=['unknown'];if(variant==='terminal')s.terminal=true;
  if(variant==='pending_write'){s.operations.pending={requested_effect:'apply'};s.in_flight_operation_ids=['pending'];}
  if(variant==='foreign_binding')operation.binding.run_id='foreign';if(variant==='foreign_session')s.current_binding.session_id='foreign';if(variant==='foreign_document')operation.target.document_fingerprint='c'.repeat(64);
  if(variant==='invalidated')s.input_invalidated_operation_ids=[op.operation_id];if(variant==='failed_save')operation.result.status='failed_after_dispatch';if(variant==='missing_observation')operation.observation_ids=[];
  if(variant==='wrong_digest')observation.raw_payload_hash='c'.repeat(64);if(variant==='altered_receipt')operation.result.native_artifact_receipt.outputs[0].sha256='c'.repeat(64);
  if(variant==='wrong_requested_path')operation.input.body.filePath='C:/foreign/result.rvt';if(variant==='missing_raw')observation.raw_payload_ref='evidence:missing';
  const start=()=>beginRevitCourierTurnContext({session_id:binding.session_id,message_id:'message',ttl_ms:600000,target_executor_id:'fixture-executor',target_document_title:'source',target_document_path:variant==='unrelated_source'?'C:/unrelated/source.rvt':before});
  active=start();assert(active);const file=path.join(root,'config/revit-courier-context.json');
  if(variant==='expired'||variant==='tampered_context'){const c=JSON.parse(fs.readFileSync(file,'utf8'));if(variant==='expired')c.expires_at='2000-01-01T00:00:00Z';else c.token='foreign';fs.writeFileSync(file,JSON.stringify(c));}
  if(variant==='direct')process.env.OPERATOR_REVIT_TRANSPORT='direct';
  const original=JSON.parse(fs.readFileSync(file,'utf8')),shouldChange=['exact','relative_filename','stale_next_call'].includes(variant);
  assert.equal(refreshRevitCourierDocumentTarget(s),shouldChange);
  const current=JSON.parse(fs.readFileSync(file,'utf8'));
  if(shouldChange){assert.deepEqual(current,{...original,target_document_title:'result',target_document_path:output});assert.equal(active.target_executor_id,'fixture-executor');assert.equal(refreshRevitCourierDocumentTarget(s),false,'No repeated transition or expiry extension');}
  else assert.deepEqual(current,original,'Failed/foreign/stale/paused/unknown inputs leave target unchanged');
  if(variant==='stale_next_call'){endRevitCourierTurnContext(active);active=start();assert(active);assert(refreshRevitCourierDocumentTarget(s));assert.equal(JSON.parse(fs.readFileSync(file,'utf8')).target_document_path,output,'A new native call can reconcile the original preserved actor context without another SaveAs or context read');}
  assert.deepEqual(snapshot(),saved,'Transport maintenance cannot settle, verify, invalidate or rewrite native task history');
 });}finally{endRevitCourierTurnContext(active);__testOnlyResetGoalListCache();if(oldRoot===undefined)delete process.env.OPERATOR_WORKSPACE_ROOT;else process.env.OPERATOR_WORKSPACE_ROOT=oldRoot;if(oldTransport===undefined)delete process.env.OPERATOR_REVIT_TRANSPORT;else process.env.OPERATOR_REVIT_TRANSPORT=oldTransport;assert.equal(path.dirname(root),os.tmpdir());fs.rmSync(root,{recursive:true,force:true});}
});
