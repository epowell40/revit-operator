import assert from 'node:assert/strict';
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import test from 'node:test';
import {createGoal,__testOnlyResetGoalListCache} from '../src/goals/service.js';
import {createAssignmentKernelForGoalV2} from '../src/assignments/assignment_kernel_v2_factory.js';
import {getAssignmentKernelSnapshotV2} from '../src/assignments/assignment_kernel_v2_store.js';
import {manageAssignmentWorkPlan} from '../src/assignments/assignment_work_plan.js';
import {advanceAssignmentKernelProgressV2,DEFAULT_ASSIGNMENT_PROGRESS_BUDGET_V2} from '../src/assignments/assignment_kernel_v2_progress.js';
import {decideAssignmentProgressV2} from '../src/domain/assignment-kernel/progress/controller.js';
import {finalCodexAssignmentMessageV2} from '../src/brains/codex_assignment_progress.js';
import {__testOnlyFinalizeDecision} from '../src/brain.js';
import {__closeForTests} from '../src/memory/sqlite_store.js';
import type {AssignmentSnapshotV2} from '../src/domain/assignment-kernel/index.js';
import {deriveProgressGapsV2} from '../src/domain/assignment-kernel/progress/controller.js';

const fixture=JSON.parse(fs.readFileSync(path.join(process.cwd(),'test/fixtures/deferred-work-plan-329.json'),'utf8'));
function scenario(run:(snapshot:AssignmentSnapshotV2,binding:AssignmentSnapshotV2['current_binding'])=>void){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'operator-deferred329-'));
 const env={OPERATOR_WORKSPACE_ROOT:root,OPERATOR_ASSIGNMENT_KERNEL_V2:'1',OPERATOR_LOCAL_EXECUTOR_PROFILE:'',OPERATOR_HOSTED_ENABLED:'0'};
 const old=Object.fromEntries(Object.keys(env).map(k=>[k,process.env[k]]));Object.assign(process.env,env);__testOnlyResetGoalListCache();
 try{
  const objective='Move the wall box indicated on the attached M106 redline into its back wall, inspect it and save only a useful changed result.';
  const goal=createGoal({title:'M106 wall box',objective,acceptance_criteria:['Requested model relocation is verified.'],status:'active',related_session_id:'deferred329',created_by:'local-host',work_budget:{requested_effect:'apply',document_fingerprint:'sample-model',source_user_request:objective,conversation_message_id:'source',mode:'sidecar_computer',source:'operator_desktop',execution_substrate:'operator_desktop_outer_agent'}});
  createAssignmentKernelForGoalV2({goal,run_id:'run329'});const binding=getAssignmentKernelSnapshotV2(goal.id)!.current_binding;
  manageAssignmentWorkPlan({binding,action:'declare',declaration:{items:fixture.work_plan.items.map(({item_id,description,source_basis,kind,depends_on}:any)=>({item_id,description,source_basis,kind,...(depends_on?{depends_on}:{})})),assumptions:fixture.work_plan.assumptions}});
  for(const item of fixture.work_plan.items)manageAssignmentWorkPlan({binding,action:'defer',item_id:item.item_id,reason:item.deferrals.at(-1).reason});
  const snapshot=getAssignmentKernelSnapshotV2(goal.id)!;assert.equal(snapshot.spec.work_plan_required,true);assert.equal(snapshot.spec.execution_policy,undefined);
  run(snapshot,binding);
 }finally{__closeForTests();__testOnlyResetGoalListCache();for(const[k,v]of Object.entries(old)){if(v===undefined)delete process.env[k];else process.env[k]=v;}fs.rmSync(root,{recursive:true,force:true});}
}
const decide=(snapshot:AssignmentSnapshotV2)=>decideAssignmentProgressV2({snapshot,budget:DEFAULT_ASSIGNMENT_PROGRESS_BUDGET_V2,now:new Date().toISOString()});

test('retained329 all-deferred strict checklist stops another reporting turn without declaring completion',()=>scenario((snapshot)=>{
 const before=structuredClone(snapshot),d=decide(snapshot);assert.equal(d.decision,'blocked');assert.equal(d.reason,'all_remaining_work_deferred');assert.deepEqual(snapshot,before);assert.deepEqual(snapshot.criteria,{});assert.equal(Object.keys(snapshot.operations).length,0);
}));
test('host checkpoint retains329 questions and incomplete truth through backend finalization',()=>scenario((snapshot,binding)=>{
 const original=structuredClone(snapshot),r=advanceAssignmentKernelProgressV2({binding});assert.equal(r.snapshot.outcome,'blocked');assert.equal(r.snapshot.terminal,true);assert.equal(r.snapshot.progress_blocker?.code,'all_remaining_work_deferred');assert.deepEqual(r.snapshot.work_plan,original.work_plan);assert.deepEqual(r.snapshot.operations,original.operations);assert.deepEqual(r.snapshot.criteria,original.criteria);assert.deepEqual(r.snapshot.pending_input_variable_ids,[]);
 const text=finalCodexAssignmentMessageV2(r.snapshot,'Done.');assert.match(text,/did not complete/i);assert.match(text,/Saved questions/);assert.match(text,/link1364219|Plumbing/);assert.doesNotMatch(text,/work completed from authoritative/i);
 const response=__testOnlyFinalizeDecision({version:'operator.backend.v1',session_id:binding.session_id,message_id:'final',user_text:snapshot.spec.source_user_request,assignment_id:binding.assignment_id,assignment_run_id:binding.run_id,assignment_generation:binding.generation},{version:'operator.backend.v1',assistant_message:'Done.',actions:[]});assert.match(response.assistant_message,/did not complete/i);assert.match(response.assistant_message,/Saved questions/);
}));
test('ready or merely dependency-waiting items are not a stopped all-deferred checklist',()=>scenario((snapshot,binding)=>{
 manageAssignmentWorkPlan({binding,action:'resume_item',item_id:'m106-final-review',reason:'The owner has not inspected yet.'});assert.notEqual(decide(getAssignmentKernelSnapshotV2(binding.assignment_id)!).decision,'blocked');
 manageAssignmentWorkPlan({binding,action:'resume_item',item_id:'m106-wallbox',reason:'New target evidence permits a bounded check.'});assert.notEqual(decide(getAssignmentKernelSnapshotV2(binding.assignment_id)!).reason,'all_remaining_work_deferred');
 const undeclared=structuredClone(snapshot);delete undeclared.work_plan;assert.notEqual(decide(undeclared).reason,'all_remaining_work_deferred');
}));
test('pause, provider/operation drain, unknown effects, input, review and usage holds take precedence',()=>scenario((snapshot)=>{
 for(const [key,modify,expected]of [
  ['pause',(s:any)=>s.execution_control={state:'paused'},'paused'],
  ['provider',(s:any)=>{s.in_flight_provider_call_ids=['pending'];s.quiescent=false;},'await_provider'],
  ['operation',(s:any)=>{s.in_flight_operation_ids=['pending'];s.quiescent=false;},'await_operation'],
  ['unknown',(s:any)=>s.unresolved_unknown_operation_ids=['unknown'],'reconcile_operation'],
  ['input',(s:any)=>s.pending_input_variable_ids=['target_identity'],'request_user_input'],
  ['review',(s:any)=>s.pending_review_ids=['review'],'request_user_review'],
  ['usage',(s:any)=>s.provider_usage_hold={hold_id:'hold',resume_budget:DEFAULT_ASSIGNMENT_PROGRESS_BUDGET_V2},'await_provider_resume']
 ]as const){const s=structuredClone(snapshot);modify(s);assert.equal(decide(s).decision,expected,key);}
}));
test('deferrals never dispose of an applied edit awaiting independent verification or change advisory behavior',()=>scenario((snapshot)=>{
 const s=structuredClone(snapshot);(s.operations as any).unverified={operation_id:'unverified',binding:s.current_binding,requested_effect:'apply',persistent_effect:'applied',settlement_state:'settled',opened_at:new Date().toISOString(),verification_operation_ids:[],observation_ids:[],advances_criterion_ids:[],eligible_criterion_ids:[],work_unit_id:'work-primary',input:{},result:{status:'succeeded'}};
 assert.notEqual(decide(s).reason,'all_remaining_work_deferred');
 const advisory=structuredClone(snapshot);(advisory.spec as any).execution_policy={mode:'local_advisory_v1'};assert.notEqual(decide(advisory).reason,'all_remaining_work_deferred');
}));

function withRetainedAttempt(snapshot:AssignmentSnapshotV2):AssignmentSnapshotV2 {
 const s=structuredClone(snapshot),binding=s.current_binding,operations:any=s.operations,observations:any=s.observations;
 const operation:any={schema:'revit-operator.operation/v2',binding,work_unit_id:'work-primary',capability_id:'native-test',
  purpose:'work',fulfillment_role:'delegated_task_execution',admission_state:'admitted',dispatch_state:'dispatched',settlement_state:'settled',
  advances_criterion_ids:[],eligible_criterion_ids:[],resolves_gap_ids:[],input:{},target:{document_fingerprint:binding.document_fingerprint},
  deadline_at:'2026-01-01T00:01:00Z',verification_operation_ids:[],opened_at:'2026-01-01T00:00:00Z'};
 const result:any={schema:'revit-operator.operation-result/v2',binding,status:'succeeded',dispatch_state:'dispatched',authority:'native-host',
  observation_required:true,result_schema_id:'native-test-result',raw_payload_hash:'a'.repeat(64),receipt_id:'native-receipt',completed_at:'2026-01-01T00:00:01Z'};
 operations.apply={...structuredClone(operation),operation_id:'apply',requested_effect:'apply',persistent_effect:'applied',
  verification_operation_ids:['read'],observation_ids:['apply-observation'],result:{...structuredClone(result),operation_id:'apply',result_id:'apply-result',
   persistent_effect:'applied',native_transaction_state:'committed',affected_target_identities:['element_id:41']}};
 operations.read={...structuredClone(operation),operation_id:'read',requested_effect:'read',purpose:'verification',fulfillment_role:'verification',
  persistent_effect:'none',verification_of_operation_id:'apply',observation_ids:['read-observation'],opened_at:'2026-01-01T00:00:02Z',
  target:{target_id:'id:41',document_fingerprint:binding.document_fingerprint},result:{...structuredClone(result),operation_id:'read',result_id:'read-result',
   persistent_effect:'none',native_transaction_state:'not_applicable',completed_at:'2026-01-01T00:00:03Z'}};
 for(const name of ['apply','read'])observations[name+'-observation']={schema:'revit-operator.observation/v2',observation_id:name+'-observation',
  operation_id:name,binding,authority:'native-host',capability_id:'native-test',result_schema_id:'native-test-result',raw_payload_ref:'evidence:'+name,
  raw_payload_hash:'a'.repeat(64),observed_at:s.operations[name]!.result!.completed_at,facts:[{fact_id:'control.domain_succeeded',fact_class:'control',value:true}],
  target_scope:{},verification_relevance:name==='read'?['verification']:['task_result']};
 return s;
}

test('all-deferred work with a settled independent native attempt closes incomplete while keeping unmet verification',()=>scenario(snapshot=>{
 const s=withRetainedAttempt(snapshot),before=structuredClone(s),decision=decide(s);
 assert.equal(decision.decision,'blocked');assert.equal(decision.reason,'all_remaining_work_deferred_verification_unresolved');
 assert(decision.decision==='blocked'&&decision.gap_ids.includes('verification:apply'));
 assert(deriveProgressGapsV2(s).some(g=>g.gap_id==='verification:apply'));assert.deepEqual(s,before);
}));

test('missing, stale, foreign or non-native attempt evidence never ends the verification loop',()=>scenario(snapshot=>{
 const variants:Record<string,(s:any)=>void>={
  absent:s=>s.operations.apply.verification_operation_ids=[],unlinked:s=>s.operations.read.verification_of_operation_id='other',
  unadmitted:s=>s.operations.read.admission_state='rejected',not_dispatched:s=>s.operations.read.dispatch_state='not_dispatched',
  unretained:s=>s.operations.read.observation_ids=[],missing_observation:s=>delete s.observations['read-observation'],
  wrong_operation:s=>s.observations['read-observation'].operation_id='other',wrong_result:s=>s.operations.read.result.operation_id='other',
  bad_digest:s=>s.observations['read-observation'].raw_payload_hash='b'.repeat(64),missing_digest:s=>delete s.operations.read.result.raw_payload_hash,
  missing_ref:s=>s.observations['read-observation'].raw_payload_ref='',non_native:s=>s.operations.read.result.authority='agent',
  non_native_observation:s=>s.observations['read-observation'].authority='agent',foreign:s=>s.operations.read.binding={...s.current_binding,generation:2},
  foreign_result:s=>s.operations.read.result.binding={...s.current_binding,generation:2},foreign_observation:s=>s.observations['read-observation'].binding={...s.current_binding,generation:2},
  foreign_target:s=>s.operations.read.target.target_id='id:99',foreign_document:s=>s.operations.read.target.document_fingerprint='foreign',
  before_apply:s=>s.operations.read.opened_at='2025-12-31T23:59:59Z',invalid_time:s=>s.operations.read.opened_at='invalid',
  stale_observation:s=>s.observations['read-observation'].observed_at='2025-12-31T23:59:59Z',
  invalidated:s=>s.input_invalidated_operation_ids=['read'],invalidated_apply:s=>s.input_invalidated_operation_ids=['apply'],
  domain_failure:s=>s.observations['read-observation'].facts=[],read_failure:s=>s.operations.read.result.status='failed_after_dispatch',
  schema_mismatch:s=>s.observations['read-observation'].result_schema_id='other',
  unretained_apply:s=>s.operations.apply.observation_ids=[]
 };
 for(const[name,change]of Object.entries(variants)){const s=withRetainedAttempt(snapshot);change(s);assert.notEqual(decide(s).reason,'all_remaining_work_deferred_verification_unresolved',name);}
}));

test('a genuine attempt does not supersede ready work or existing stop and reconciliation fences',()=>scenario(snapshot=>{
 const variants:Array<[string,(s:any)=>void,string]>=[
  ['ready',s=>{s.work_plan.items[0].deferrals=[];},'admit_reasoning_turn'],
  ['pause',s=>s.execution_control={state:'paused'},'paused'],
  ['unknown',s=>s.unresolved_unknown_operation_ids=['unknown'],'reconcile_operation'],
  ['operation',s=>{s.in_flight_operation_ids=['pending'];s.quiescent=false;},'await_operation'],
  ['provider',s=>{s.in_flight_provider_call_ids=['pending'];s.quiescent=false;},'await_provider'],
  ['input',s=>s.pending_input_variable_ids=['required'],'request_user_input'],
  ['review',s=>s.pending_review_ids=['review'],'request_user_review'],
  ['hold',s=>s.provider_usage_hold={hold_id:'hold',resume_budget:DEFAULT_ASSIGNMENT_PROGRESS_BUDGET_V2},'await_provider_resume'],
  ['advisory',s=>s.spec.execution_policy={mode:'local_advisory_v1'},'admit_reasoning_turn']
 ];
 for(const[name,change,expected]of variants){const s=withRetainedAttempt(snapshot);change(s);assert.equal(decide(s).decision,expected,name);}
}));
