import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';import path from 'node:path';import os from 'node:os';
import {createGoal,__testOnlyResetGoalListCache} from '../src/goals/service.js';
import {__closeForTests} from '../src/memory/sqlite_store.js';
import {runWithRequestContext,createPrincipalBoundSessionId,type RequestPrincipal,type RequestContext} from '../src/request_context.js';
import {createOperatorBackendAuth} from '../src/operator_backend_auth.js';
import {createAssignmentKernelForGoalV2,assignmentKernelV2ForBinding} from '../src/assignments/assignment_kernel_v2_factory.js';
import {getAssignmentKernelSnapshotV2} from '../src/assignments/assignment_kernel_v2_store.js';
import {selectTaskReviewPolicy,trustedTaskExecutionHost} from '../src/assignments/task_review_policy.js';
import {selectLocalAdvisoryPolicy} from '../src/assignments/local_advisory_policy.js';
import {validLocalAdvisoryPolicyV1} from '../src/domain/assignment-kernel/execution_policy.js';
import {manageAssignmentWorkPlan} from '../src/assignments/assignment_work_plan.js';
import {desktopNativeInitialContext} from '../src/assignments/desktop_execution_guidance.js';
import {startCodexProviderTurnWhenActive} from '../src/brains/thin_reference_execution.js';
import {controlAssignmentExecutionV2} from '../src/assignments/assignment_kernel_v2_controls.js';
import {openAssignmentKernelOperationV2,failAssignmentKernelOperationV2,markAssignmentKernelOperationDispatchStartedV2} from '../src/assignments/assignment_kernel_v2_execution.js';

const principal:RequestPrincipal={sub:'test-sub',user_id:'test-user',tenant_id:'test-tenant',license_id:'test-tenant',roles:['operator'],tier:null,claims:{}};
async function fixture(enabled:boolean,fn:(value:{snapshot:NonNullable<ReturnType<typeof getAssignmentKernelSnapshotV2>>;binding:ReturnType<typeof createAssignmentKernelForGoalV2>;context:RequestContext;state:()=>NonNullable<ReturnType<typeof getAssignmentKernelSnapshotV2>>})=>unknown|Promise<unknown>){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'operator-task-review-'));
 const env={OPERATOR_WORKSPACE_ROOT:root,REVIT_OPERATOR_MODE:'hosted',OPERATOR_HOSTED_ENABLED:'1',OPERATOR_AUTH_MODE:'principal_jwt',OPERATOR_REVIT_TRANSPORT:'courier',OPERATOR_ASSIGNMENT_KERNEL_V2:'1',OPERATOR_BRAIN:'codex',OPERATOR_TOOL_EXPOSURE_PROFILE:'general',OPERATOR_OPENAI_API_KEY:'test-provider-not-used',OPERATOR_TASK_EXECUTION_PROFILE:enabled?'single_actor_review_v1':'',OPERATOR_LOCAL_EXECUTOR_PROFILE:''};
 const old=Object.fromEntries(Object.keys(env).map(k=>[k,process.env[k]]));Object.assign(process.env,env);__testOnlyResetGoalListCache();
 const context={principal,operator_backend_auth:createOperatorBackendAuth('principal_jwt','test-credential',{OPERATOR_API_BASE_URL:'https://backend.example.invalid'})};
 try{await runWithRequestContext(context,async()=>{
  const session=createPrincipalBoundSessionId(principal),goal=createGoal({title:'Reconstruct drawing',objective:'Reconstruct the visible lighting fixtures, controls and annotations from the supplied PDF; inspect and save the model.',acceptance_criteria:['The requested drawing is reconstructed and reviewed.'],status:'active',related_session_id:session,created_by:'test-user',work_budget:{requested_effect:'apply',document_fingerprint:'disposable-document',mode:'sidecar_computer',source:'operator_desktop',execution_substrate:'operator_desktop_outer_agent'}});
  const binding=createAssignmentKernelForGoalV2({goal,run_id:'test-run'});await fn({binding,snapshot:getAssignmentKernelSnapshotV2(goal.id)!,context,state:()=>getAssignmentKernelSnapshotV2(goal.id)!});
 });}finally{__testOnlyResetGoalListCache();__closeForTests();for(const[k,v]of Object.entries(old)){if(v===undefined)delete process.env[k];else process.env[k]=v;}fs.rmSync(root,{recursive:true,force:true});}
}
test('explicit runtime profile freezes authenticated product task review on the actual factory path',()=>fixture(true,({snapshot,binding})=>{
 assert.equal(snapshot?.spec.execution_policy?.mode,'single_actor_review_v1');
 assert.equal((snapshot?.spec.execution_policy as any).principal_id,binding.principal_id);
 assert.equal(snapshot?.spec.execution_policy?.max_provider_calls,32);
 assert.equal(snapshot?.spec.execution_policy?.max_total_tokens,4_000_000);
 assert.equal(snapshot?.outcome,'active');
}));
test('unselected product tasks retain strict policy and historical semantics',()=>fixture(false,({snapshot})=>assert.equal(snapshot?.spec.execution_policy,undefined)));

test('product policy survives reload and enrollment disable without granting a foreign principal custody',()=>fixture(true,({snapshot,binding,context,state})=>{
 const before=JSON.stringify(snapshot);process.env.OPERATOR_TASK_EXECUTION_PROFILE='';__testOnlyResetGoalListCache();
 assert.equal(JSON.stringify(state()),before);assert(assignmentKernelV2ForBinding(binding));assert(trustedTaskExecutionHost(snapshot.spec));
 for(const change of [{user_id:'other-user'},{tenant_id:'other-tenant'}]){
  const foreign={...context,principal:{...principal,...change}};
  assert.equal(trustedTaskExecutionHost(snapshot.spec,process.env,foreign),false);
  runWithRequestContext(foreign,()=>assert.equal(assignmentKernelV2ForBinding(binding),null));
 }
 assert.equal(selectLocalAdvisoryPolicy(binding,process.env,context,'apply'),undefined,'Product profile cannot enable the legacy local experiment');
}));

test('selection requires exact server configuration, authorized native host, binding and apply intent',()=>fixture(true,({binding,context})=>{
 assert(selectTaskReviewPolicy(binding,'apply'));
 for(const change of [{OPERATOR_TASK_EXECUTION_PROFILE:''},{OPERATOR_TASK_EXECUTION_PROFILE:'other'},{OPERATOR_REVIT_TRANSPORT:'direct'},{OPERATOR_ASSIGNMENT_KERNEL_V2:'0'},{OPERATOR_BRAIN:'other'},{OPERATOR_AUTH_MODE:'shared_token'}])
  assert.equal(selectTaskReviewPolicy(binding,'apply',{...process.env,...change},context),undefined);
 for(const effect of ['read','preview'])assert.equal(selectTaskReviewPolicy(binding,effect),undefined);
 for(const change of [{principal_id:'foreign'},{document_fingerprint:''},{session_id:'foreign-session'}])
  assert.equal(selectTaskReviewPolicy({...binding,...change},'apply'),undefined);
 assert.equal(selectTaskReviewPolicy(binding,'apply',process.env,{operator_backend_auth:context.operator_backend_auth}),undefined);
}));

test('stored policy rejects forged provenance, mismatched owner and expanded resource caps',()=>fixture(true,({snapshot})=>{
 assert(validLocalAdvisoryPolicyV1(snapshot.spec));
 for(const change of [{principal_id:'foreign'},{selected_by:'trusted_local_host'},{max_provider_calls:33},{max_total_tokens:4_000_001},{max_operations:129},{max_wall_clock_ms:30*60_000+1},{progress_allowance:{mode:'verified_native_changes_v1',max_provider_calls:64,max_operations:256,max_total_tokens:8_000_000}}])
  assert.equal(validLocalAdvisoryPolicyV1({...snapshot.spec,execution_policy:{...snapshot.spec.execution_policy,...change} as any}),false);
}));

test('model-visible product policy keeps lightweight progress and an unverified review checkpoint',()=>fixture(true,({snapshot,binding,state})=>{
 const instructions=desktopNativeInitialContext(snapshot);assert.match(instructions,/single_actor_review_v1/);assert.match(instructions,/report_work_for_review/);assert.match(instructions,/not completion/);assert.doesNotMatch(instructions,/Declare the compact requested scope once/);
 manageAssignmentWorkPlan({binding,action:'declare',declaration:{items:[{item_id:'area',description:'Draft visible area',source_basis:'User PDF'}],assumptions:[]}});
 const report={claimed_completed:['Drafted the area'],remaining_work:[],uncertainties:[],user_facing_text:'Review the reconstructed area.'};
 assert.throws(()=>manageAssignmentWorkPlan({binding,action:'propose_completion',completion_proposal:report}),/ready_work_remaining/);
 manageAssignmentWorkPlan({binding,action:'complete',item_id:'area'});
 const outcome=manageAssignmentWorkPlan({binding,action:'propose_completion',completion_proposal:report});
 assert.equal(outcome.outcome,'awaiting_user_review');assert.equal(state().completion_proposal?.verified,false);assert.equal(state().terminal,false);assert.deepEqual(state().criteria,snapshot.criteria);
}));

test('Pause remains ahead of model dispatch in the product policy',()=>fixture(true,({binding,state})=>{
 controlAssignmentExecutionV2({binding,command_id:'pause',expected_command_id:null,action:'pause'});let calls=0;
 assert.throws(()=>startCodexProviderTurnWhenActive({binding,readSnapshot:state},async()=>{calls++;}),/user_requested_pause/);assert.equal(calls,0);
}));

test('unknown native effects still forbid another mutation',()=>fixture(true,({binding,state})=>{
 const request=(id:string)=>openAssignmentKernelOperationV2({snapshot:state(),provider_turn_id:'turn',controller_request_id:id,capability_id:'revit_call_tool',classified_effect:'apply',target_tokens:['id:11'],arguments:{method:'POST',path:'/revit/connect-mep-elements',body:{sourceElementId:11,targetElementIds:[12],dryRun:false}}});
 const op=request('first');failAssignmentKernelOperationV2(op,new Error('Interrupted after dispatch'),'dispatched');assert.equal(state().unresolved_unknown_operation_ids.length,1);
 assert.throws(()=>request('second'),/unknown_effect_requires_reconciliation|after_terminal_outcome/);assert.equal(state().unresolved_unknown_operation_ids.length,1);
}));

test('late foreign authentication cannot dispatch an already opened native operation',()=>fixture(true,({context,state})=>{
 const lease=openAssignmentKernelOperationV2({snapshot:state(),provider_turn_id:'turn',controller_request_id:'read',capability_id:'revit_call_tool',classified_effect:'read',target_tokens:['id:11'],arguments:{method:'POST',path:'/revit/get-element',body:{elementId:11}}});
 const before=JSON.stringify(state());const foreign={...context,principal:{...principal,tenant_id:'other-tenant'}};
 runWithRequestContext(foreign,()=>assert.throws(()=>markAssignmentKernelOperationDispatchStartedV2(lease),{message:'Goal not found.'}));assert.equal(JSON.stringify(state()),before);
}));

test('pending usage, terminal state and changed binding still prevent a primary provider dispatch',()=>fixture(true,({binding,snapshot})=>{
 let calls=0;const dispatch=async()=>{calls++;};
 for(const [value,reason]of [[{...snapshot,provider_usage_hold:{}},/provider_usage_hold/],[{...snapshot,terminal:true},/assignment_terminal/],[{...snapshot,current_binding:{...binding,generation:2}},/assignment_binding_changed/]] as const)
  assert.throws(()=>startCodexProviderTurnWhenActive({binding,readSnapshot:()=>value as any},dispatch),reason);
 assert.equal(calls,0);
}));
