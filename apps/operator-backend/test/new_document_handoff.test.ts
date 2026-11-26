import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {routeConversation} from '../src/conversation_intake.js';
import {createGoal,__testOnlyResetGoalListCache} from '../src/goals/service.js';
import {assignmentSpecFromGoalV2,assignmentKernelV2ForBinding} from '../src/assignments/assignment_kernel_v2_factory.js';
import {createAssignmentKernelV2,getAssignmentKernelSnapshotV2,appendCurrentAssignmentKernelEventV2} from '../src/assignments/assignment_kernel_v2_store.js';
import {runWithRequestContext} from '../src/request_context.js';
import {createOperatorBackendAuth} from '../src/operator_backend_auth.js';
import {__closeForTests} from '../src/memory/sqlite_store.js';
import {newDocumentPhaseSpec,requestsNewProject,validateNewDocumentHandoff,type NewProjectContextV1} from '../src/domain/assignment-kernel/new_document_handoff.js';
import {validLocalAdvisoryPolicyV1} from '../src/domain/assignment-kernel/execution_policy.js';
import {operationScopeRequestHash} from '../src/domain/assignment-kernel/operation_scope.js';
import {continueInNewDocument} from '../src/assignments/new_document_handoff.js';
import {retainDesktopResponse} from '../src/desktop_response_store.js';
import {executeExternalProviderCallV2} from '../src/assignments/external_provider_lifecycle.js';
import {createOpenAiModelCallReceipt} from '../src/model_call_telemetry.js';

const request='make a new revit model and draft the attached house floor plan, thanks.';
const oldFingerprint='a'.repeat(64),newFingerprint='b'.repeat(64);
async function fixture(run:(s:any,goal:any)=>Promise<void>|void) {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'operator-document-handoff-'));
  const env={OPERATOR_WORKSPACE_ROOT:root,OPERATOR_ASSIGNMENT_KERNEL_V2:'1',REVIT_OPERATOR_MODE:'development',OPERATOR_LOCAL_EXECUTOR_PROFILE:'',OPERATOR_HOSTED_ENABLED:'0',
    OPERATOR_BRAIN:'codex',OPERATOR_TOOL_EXPOSURE_PROFILE:'laboratory',OPERATOR_REVIT_TRANSPORT:'direct',OPERATOR_OPENAI_API_KEY:'test-only-fake'};
  const previous=Object.fromEntries(Object.keys(env).map(k=>[k,process.env[k]]));Object.assign(process.env,env);
  __closeForTests();__testOnlyResetGoalListCache();
  try {await runWithRequestContext({operator_backend_auth:createOperatorBackendAuth('shared_token','document-test')},async()=>{
    await routeConversation({version:'operator.backend.v1',session_id:'session',message_id:'source',user_text:request},
      {interpret:async()=>({value:{route:'task',answer:null,basis:'needs_tools',requested_effect:'change',entire_request_answered:false,
        confidence:0.99,reason:'Create the requested project.',question_kind:'action',identity_fields:[],read_evidence:'not_applicable',
        operation_scope:{schema:'revit-operator.interpreted-operation-scope/v1',requested_effect:'apply',model_effect:'apply',protected_clauses:[],prerequisites:[]}}})});
    const goal=createGoal({title:'New house',objective:request,acceptance_criteria:['Draft and inspect the reference'],status:'active',related_session_id:'session',created_by:'local-host',
      work_budget:{requested_effect:'apply',document_fingerprint:oldFingerprint,revit_process_id:42,document_session_id:'a'.repeat(32),conversation_message_id:'source',source_user_request:request,
        mode:'sidecar_computer',source:'operator_desktop',execution_substrate:'operator_desktop_outer_agent'}});
    const spec=assignmentSpecFromGoalV2({goal,run_id:'run'});
    spec.execution_policy={mode:'single_actor_review_v1',selected_by:'trusted_runtime_host',principal_id:spec.binding.principal_id!,session_id:'session',document_fingerprint:oldFingerprint,
      ready_work_handoff:'continue_ready_work_v1',max_turns:8,max_provider_calls:32,max_operations:128,max_total_tokens:1_000_000,max_wall_clock_ms:600_000};
    const s=createAssignmentKernelV2(goal.id,spec,'test').snapshot;
    await run(s,goal);
  });} finally {
    __closeForTests();__testOnlyResetGoalListCache();for(const [k,v] of Object.entries(previous))if(v===undefined)delete process.env[k];else process.env[k]=v;
    assert.equal(path.dirname(root),os.tmpdir());fs.rmSync(root,{recursive:true,force:true});
  }
}
const context=(s:any):NewProjectContextV1=>({process_id:42,title:'Project1',path:'',session_id:'c'.repeat(32),fingerprint:newFingerprint,created_at:s.spec.created_at,is_family:false});

test('new project handoff preserves human scope, subtracts consumed resources and cannot recursively renew them',()=>fixture(s=>{
  const t=context(s),now=new Date(Date.parse(s.spec.created_at)+1000).toISOString();
  s.provider_calls={call:{admitted_at:s.spec.created_at,completed_at:now,usage:{total_tokens:321}}};
  const before=structuredClone(s),child=newDocumentPhaseSpec(s,t,'call',now);
  assert.deepEqual(s,before);assert.equal(child.binding.session_id,s.current_binding.session_id);
  assert.equal(child.source_user_request,request);assert.deepEqual(child.interpreted_scope,s.spec.interpreted_scope);
  assert.deepEqual(child.criteria,s.spec.criteria);assert.deepEqual(child.document_parent_binding,s.current_binding);
  assert.equal(child.execution_policy!.max_provider_calls,31);assert.equal(child.execution_policy!.max_total_tokens,999679);
  assert.equal(child.execution_policy!.max_wall_clock_ms,599000);assert(validLocalAdvisoryPolicyV1(child));
  assert.equal(requestsNewProject(child),false);assert.deepEqual(newDocumentPhaseSpec(s,t,'call',now),child);
  assert.notEqual(child.binding.assignment_id,s.current_binding.assignment_id);
}));

test('new document provenance, authority and all existing stop conditions remain required',()=>fixture(s=>{
  const now=new Date().toISOString(),t=context(s);
  for(const patch of [{path:'C:/other.rvt'},{is_family:true},{fingerprint:oldFingerprint},{session_id:''},{created_at:'2000-01-01T00:00:00Z'},{created_at:'2999-01-01T00:00:00Z'},{process_id:0}])
    assert.throws(()=>newDocumentPhaseSpec(s,{...t,...patch} as any,'call',now),{code:'new_document_identity_invalid'});
  for(const patch of [{execution_control:{state:'paused'}},{terminal:true},{quiescent:false},{provider_usage_hold:{}},{provider_budget_exhausted:true},
    {pending_review_ids:['review']},{pending_input_variable_ids:['answer']},{in_flight_operation_ids:['op']},{in_flight_provider_call_ids:['call']},
    {unresolved_unknown_operation_ids:['unknown']},{execution_failure_ids:['failure']},{progress_blocker:{}},{document_handoff:{}},{completion_proposal:{}}])
    assert.throws(()=>newDocumentPhaseSpec({...s,...patch},t,'call',now));
  for(const text of ['Open the existing house model.','Explain how to make a new Revit model.','Do not create a new model.','Create a new model after I approve.']) {
    const spec=structuredClone(s.spec);spec.source_user_request=text;spec.interpreted_scope.source_request_sha256=operationScopeRequestHash(text);
    assert.equal(requestsNewProject(spec),false,text);
  }
  const handoff={command_id:'call',observed_at:now,target:t,child_spec:newDocumentPhaseSpec(s,t,'call',now)};
  assert.throws(()=>validateNewDocumentHandoff(s,handoff,'agent',now));
  handoff.child_spec.execution_policy!.max_total_tokens++;
  assert.throws(()=>validateNewDocumentHandoff(s,handoff,'desktop-document-controller',now));
}));

test('retained provider call creates one same-chat child, replays idempotently and keeps the original phase paused',()=>fixture(async(s,goal)=>{
  const binding=s.current_binding,model='test-model';
  const response:any={id:'response',status:'completed',provider_response_usage:{disposition:'completed',message_id:'message',session_id:'session',raw_response_ids:['response']},
    output:[{type:'function_call',name:'native__continue_in_new_revit_model',call_id:'handoff',arguments:'{}'}]};
  response.model_call_receipt=createOpenAiModelCallReceipt({route:'desktop_computer',requested_model:model,reasoning_effort:'medium',started_at_utc:new Date().toISOString(),duration_ms:1,
    response:{...response,model,usage:{input_tokens:10,output_tokens:10,total_tokens:20}}});
  await retainDesktopResponse({...binding,kernelVersion:2},'message',{model},()=>executeExternalProviderCallV2({binding,model,provider:'openai',reasoning_effort:'medium',
    invoke:async()=>response,receipt:r=>r.model_call_receipt,errorReceipt:()=>null}),()=>null);
  const target=context(s),input={message_id:'message',response_id:'response',call_id:'handoff',native_context:{process_id:42,readiness:{document_loaded:true,active_view_ready:true},
    document:{title:target.title,path:'',sessionId:target.session_id,createdAtUtc:target.created_at,isFamilyDocument:false,projectIdentity:{fingerprint:newFingerprint}}}};
  assert.throws(()=>continueInNewDocument(binding,{...input,native_context:{...input.native_context,process_id:43}}),/process_or_readiness/);
  assert.throws(()=>continueInNewDocument(binding,{...input,call_id:'foreign'}));
  const result=continueInNewDocument(binding,input),again=continueInNewDocument(binding,input);
  assert.equal(result.goal.id,again.goal.id);assert.equal(result.goal.related_session_id,goal.related_session_id);
  assert.equal(result.publication.snapshot.spec.execution_policy!.max_total_tokens,s.spec.execution_policy.max_total_tokens-20);
  const parent=getAssignmentKernelSnapshotV2(goal.id)!;
  assert.equal(parent.execution_control?.state,'paused');assert.equal(parent.terminal,false);assert.equal(parent.provider_call_ids.length,1);
  assert.equal(parent.spec.binding.document_fingerprint,oldFingerprint);
  const childBinding=result.publication.snapshot.current_binding;
  assert(assignmentKernelV2ForBinding(childBinding));
  assert.throws(()=>appendCurrentAssignmentKernelEventV2({goal_id:goal.id,binding,event_id:'resume',actor:'authenticated-user',occurred_at:new Date().toISOString(),
    body:{event_type:'execution_control_requested',action:'resume',command_id:'resume'}} as any),/document_phase_handed_off/);
}));
