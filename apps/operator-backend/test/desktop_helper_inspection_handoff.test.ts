import assert from 'node:assert/strict';import test from 'node:test';
import fs from 'node:fs';import path from 'node:path';import os from 'node:os';import {runInNewContext} from 'node:vm';
import {desktopHelperInspectionHandoffV1,desktopHelperBudgetReportV1,desktopHelperLeaseDecisionV1,createDesktopHelperCallLeaseV1} from '../src/brains/desktop_helper_budget.js';
import {assignmentConsecutiveNoProgressEpochsV2,assignmentNativeReadbackResourceBlockerV2} from '../src/domain/assignment-kernel/index.js';
import {DEFAULT_ASSIGNMENT_PROGRESS_BUDGET_V2} from '../src/assignments/assignment_kernel_v2_progress.js';
import {createGoal,__testOnlyResetGoalListCache} from '../src/goals/service.js';
import {createAssignmentKernelForGoalV2} from '../src/assignments/assignment_kernel_v2_factory.js';
import {getAssignmentKernelSnapshotV2} from '../src/assignments/assignment_kernel_v2_store.js';
import {__closeForTests} from '../src/memory/sqlite_store.js';
import {routeConversation} from '../src/conversation_intake.js';

// Exact retained decision shape: all edits + native/file checks completed,
// sole final inspection pending, three unchanged progress epochs, no effects
// or usage in flight. No sample element IDs or special item-name matching.
function ready(base:any){
 const s=structuredClone(base);s.spec.requested_effect='apply';s.spec.work_plan_required=true;
 s.terminal=false;s.outcome='active';s.quiescent=true;
 for(const k of ['in_flight_provider_call_ids','in_flight_operation_ids','unresolved_unknown_operation_ids','pending_input_variable_ids','pending_review_ids','execution_failure_ids'])s[k]=[];
 s.work_plan={schema:'revit-operator.assignment-work-plan/v2',items:[
  {item_id:'edit-a',kind:'edit',description:'Requested edit',completed_at:'2026-10-26T19:31:06Z'},
  {item_id:'edit-b',kind:'edit',description:'Requested separate save',completed_at:'2026-10-26T19:31:56Z'},
  {item_id:'read-a',kind:'inspection',description:'Native readback',depends_on:['edit-a'],completed_at:'2026-10-26T19:31:53Z'},
  {item_id:'read-b',kind:'inspection',description:'File inspection',depends_on:['edit-b'],completed_at:'2026-10-26T19:31:58Z'},
  {item_id:'final-check',kind:'inspection',description:'Remaining inspection',depends_on:['edit-a','edit-b']}
 ]};
 s.progress_epochs=[{genuine_progress:true,unresolved_gap_ids:['criterion:x','work-plan:scope']},
  ...Array.from({length:3},()=>({genuine_progress:false,unresolved_gap_ids:['criterion:x','work-plan:scope']}))];
 return s;
}
const basic:any={spec:{},provider_calls:{},operations:{},progress_epochs:[]};
test('retained sole-inspection shape yields a handback, not completion, before the fourth no-progress read',()=>{
 const s=ready(basic);assert.equal(assignmentConsecutiveNoProgressEpochsV2(s),3);assert.equal(desktopHelperInspectionHandoffV1(s),true);
 assert.equal(s.work_plan.items.at(-1).completed_at,undefined);assert.equal(s.outcome,'active');
});
test('arbitrary names and descriptions do not route the handback',()=>{
 const s=ready(basic);s.work_plan.items.at(-1).item_id='arbitrary-inspection';s.work_plan.items.at(-1).description='No owner or visual keywords';
 assert.equal(desktopHelperInspectionHandoffV1(s),true);
});
test('native work, missing checks, multiple inspections, deferrals and missing dependencies stay unfinished',()=>{
 for(const change of [
  (s:any)=>{delete s.work_plan.items[0].completed_at;},
  (s:any)=>{delete s.work_plan.items[2].completed_at;},
  (s:any)=>{s.work_plan.items=s.work_plan.items.filter((i:any)=>!i.completed_at||i.kind==='edit');},
  (s:any)=>{s.work_plan.items.at(-1).kind='question';},
  (s:any)=>{s.work_plan.items.at(-1).depends_on=['missing'];},
  (s:any)=>{s.work_plan.items.at(-1).depends_on=[];},
  (s:any)=>{s.work_plan.items[0].deferrals=[{reason:'awaiting input'}];},
  (s:any)=>{s.spec.requested_effect='read';},
  (s:any)=>{s.spec.work_plan_required=false;},
  (s:any)=>{s.spec.execution_policy={mode:'local_advisory_v1'};}
 ]){const s=ready(basic);change(s);assert.equal(desktopHelperInspectionHandoffV1(s),false);}
});
test('terminal, Pause, unknown, pending usage, operations, review and input cannot gain handback eligibility',()=>{
 for(const change of [
  (s:any)=>{s.terminal=true;},(s:any)=>{s.outcome='blocked';},(s:any)=>{s.execution_control={state:'paused'};},
  (s:any)=>{s.provider_usage_hold={};},(s:any)=>{s.provider_budget_exhausted=true;},
  (s:any)=>{s.progress_blocker={code:'no_progress_budget_exhausted'};},(s:any)=>{s.completion_proposal={};},
  ...['in_flight_provider_call_ids','in_flight_operation_ids','unresolved_unknown_operation_ids','pending_input_variable_ids','pending_review_ids','execution_failure_ids'].map(k=>(s:any)=>{s[k]=['pending'];}),
  (s:any)=>{s.quiescent=false;}
 ]){const s=ready(basic);change(s);assert.equal(desktopHelperInspectionHandoffV1(s),false);}
});
test('progress count is unchanged at empty, fresh progress, changed gaps and exhausted histories',()=>{
 const s=ready(basic);s.progress_epochs=[];assert.equal(assignmentConsecutiveNoProgressEpochsV2(s),0);
 s.progress_epochs=ready(basic).progress_epochs;s.progress_epochs.push({genuine_progress:true,unresolved_gap_ids:['criterion:x','work-plan:scope']});
 assert.equal(assignmentConsecutiveNoProgressEpochsV2(s),0);assert.equal(desktopHelperInspectionHandoffV1(s),false);
 s.progress_epochs=ready(basic).progress_epochs;s.progress_epochs.push({genuine_progress:false,unresolved_gap_ids:['different']});
 assert.equal(assignmentConsecutiveNoProgressEpochsV2(s),1);
 s.progress_epochs=ready(basic).progress_epochs;s.progress_epochs.push(s.progress_epochs.at(-1));
 assert.equal(assignmentConsecutiveNoProgressEpochsV2(s),4);assert.equal(desktopHelperInspectionHandoffV1(s),false);
 assert.equal(assignmentNativeReadbackResourceBlockerV2(s,DEFAULT_ASSIGNMENT_PROGRESS_BUDGET_V2,new Date().toISOString(),0),'no_progress_budget_exhausted');
});
test('actual current desktop ownership and consumed helper work are required by the lease producer',async()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'inspection-handoff-')),env={OPERATOR_WORKSPACE_ROOT:root,REVIT_OPERATOR_MODE:'development',OPERATOR_LOCAL_EXECUTOR_PROFILE:'',OPERATOR_ASSIGNMENT_KERNEL_V2:'1',OPERATOR_BRAIN:'codex',OPERATOR_TOOL_EXPOSURE_PROFILE:'laboratory',OPERATOR_HOSTED_ENABLED:'0'};
 const old=Object.fromEntries(Object.keys(env).map(k=>[k,process.env[k]]));Object.assign(process.env,env);__testOnlyResetGoalListCache();
 try{
  const objective='Edit, save, inspect and deliver the requested model.';
  const intake=await routeConversation({version:'operator.backend.v1',session_id:'owner-session',message_id:'message',user_text:objective},
   {interpret:async()=>({value:{route:'task',answer:null,basis:'needs_tools',requested_effect:'change',entire_request_answered:false,confidence:0.99,reason:'Requested model edit and saved delivery.',question_kind:'current_model',identity_fields:[],read_evidence:'not_applicable',operation_scope:{schema:'revit-operator.interpreted-operation-scope/v1',requested_effect:'apply',model_effect:'apply',protected_clauses:[],prerequisites:[]}}})});assert.equal(intake.routing_status,'accepted');
  const goal=createGoal({title:objective,objective,status:'active',acceptance_criteria:['Requested result delivered.'],related_session_id:'owner-session',created_by:'local-host',
   work_budget:{requested_effect:'apply',document_fingerprint:'fixture-model',conversation_message_id:'message',source_user_request:objective,mode:'sidecar_computer',source:'operator_desktop',execution_substrate:'operator_desktop_outer_agent'}});
  createAssignmentKernelForGoalV2({goal,run_id:'owner-run'});const initial=getAssignmentKernelSnapshotV2(goal.id)!,s=ready(initial),marker={schema:'operator.desktop-helper-scope.v1',binding:s.current_binding};
  const lease=createDesktopHelperCallLeaseV1(initial,marker);assert(lease);const noCalls=desktopHelperLeaseDecisionV1(lease,s,marker);assert.notEqual(noCalls?.reason,'inspection_handoff');
  s.provider_calls.extra={state:'completed'};const before=JSON.stringify(s),decision=desktopHelperLeaseDecisionV1(lease,s,marker);
  assert.equal(decision?.decision,'yield');assert.equal(decision?.reason,'inspection_handoff');assert.equal(JSON.stringify(s),before);
  assert.equal(desktopHelperLeaseDecisionV1(lease,s,{...marker,binding:{...marker.binding,run_id:'foreign'}}),null);
  const report=desktopHelperBudgetReportV1(s,lease,decision!.reason);assert.deepEqual(report.claimed_completed,[]);assert.match(report.remaining_work.join('\n'),/pending|not completed/);assert.match(report.remaining_work.join('\n'),/final-check/);
 }finally{__closeForTests();for(const[k,v]of Object.entries(old)){if(v===undefined)delete process.env[k];else process.env[k]=v;}__testOnlyResetGoalListCache();}
});
test('actual dynamic-tool consumer retains the existing scoped return and does not dispatch a native action',()=>{
 const source=fs.readFileSync(path.resolve('dist/src/brains/codex_dynamic_tool_handler.js'),'utf8'),a=source.indexOf("    if (decision?.decision === 'yield' && lease) {"),z=source.indexOf('\n    // The connected runtime',a);
 assert(a>0&&z>a);let calls=0,stops=0,retained:any;
 const run=runInNewContext('(async()=>{'+source.slice(a,z).replace(/\n\s*}\s*$/,'')+'})',{
  decision:{decision:'yield',reason:'inspection_handoff'},lease:{},v2Snapshot:ready(basic),marker:{},params:{turnId:'t',tool:'revit_call_tool'},v2Binding:{assignment_id:'assignment'},
  runtime:{queueAssignmentKernelV2TurnStop(){stops++;},callTool(){calls++;}},DESKTOP_HELPER_RETURN_REASON:'return',
  retainDesktopHelperReturnV1:(x:any)=>{retained=x;return x;},desktopHelperBudgetReportV1,desktopHelperReturnMessageV1:()=> 'Scoped findings only',attachCurrentAssignmentContext:()=>{}
 });
 return run().then((out:any)=>{assert.equal(out.success,true);assert.equal(calls,0);assert.equal(stops,1);assert.deepEqual(Array.from(retained.arguments.report.claimed_completed),[]);assert.match(retained.arguments.report.remaining_work[0],/remaining declared item is an inspection/);});
});
