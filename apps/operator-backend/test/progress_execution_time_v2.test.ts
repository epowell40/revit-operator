import test from 'node:test';import assert from 'node:assert/strict';
import {defaultAssignmentWorkBudgetV2,assignmentWorkAllowanceV2} from '../src/domain/assignment-kernel/effective_work_budget.js';
import {validLocalAdvisoryPolicyV1} from '../src/domain/assignment-kernel/execution_policy.js';
import {assertProviderUsageResumeV1} from '../src/domain/assignment-kernel/provider_usage_hold.js';
import {assignmentProgressBudgetBlockerV2} from '../src/domain/assignment-kernel/progress/controller.js';
import {DEFAULT_ASSIGNMENT_PROGRESS_BUDGET_V2 as ordinary} from '../src/assignments/assignment_kernel_v2_progress.js';
import {codexAssignmentTurnTimeLimits,createCodexAssignmentProgressTimeMonitor} from '../src/codex/assignment_timeout.js';
import {CodexTurnCompletions,CodexWorkTimeExpiredError} from '../src/codex/turn_completions.js';
import {classifyAssignmentKernelExecutionFailureV2} from '../src/assignments/assignment_kernel_v2_execution_failure.js';

const start=Date.UTC(2026,9,15,0,0,0),at=(ms:number)=>new Date(start+ms).toISOString();
function fixture(count=0):any {
 const binding={assignment_id:'work',run_id:'run',generation:1,session_id:'chat',principal_id:'owner',document_fingerprint:'model'};
 const s:any={assignment_version:1,current_binding:binding,outcome:'active',quiescent:true,terminal:false,
  spec:{binding,created_at:at(0),requested_effect:'apply',criteria:[],work_units:[],input_variables:[],execution_policy:{
   mode:'local_advisory_v1',selected_by:'trusted_local_host',session_id:'chat',document_fingerprint:'model',max_turns:8,
   max_provider_calls:64,max_operations:256,max_total_tokens:8_000_000,max_wall_clock_ms:20*60_000,
   progress_allowance:{mode:'verified_native_changes_v1',max_provider_calls:256,max_operations:1024,max_total_tokens:32_000_000,max_wall_clock_ms:120*60_000}}},
  operations:{},observations:{},provider_calls:{},progress_epochs:[],execution_failure_ids:[],execution_failures:{},
  pending_input_variable_ids:[],pending_review_ids:[],in_flight_provider_call_ids:[],in_flight_operation_ids:[],unresolved_unknown_operation_ids:[]};
 for(let i=0;i<count;i++){
  s.operations['edit'+i]={operation_id:'edit'+i,binding,requested_effect:'apply',persistent_effect:'applied',settlement_state:'settled',opened_at:at(100),settled_at:at(200),
   request_identity:{request_signature:'signature'+i},verification_operation_ids:['read'+i],result:{binding,authority:'native-host',status:'succeeded',native_transaction_state:'committed',affected_target_identities:['element_id:'+(i+1)]}};
  s.operations['read'+i]={operation_id:'read'+i,binding,target:{target_id:'id:'+(i+1)},requested_effect:'read',purpose:'verification',persistent_effect:'none',settlement_state:'settled',opened_at:at(200),settled_at:at(300),
   verification_of_operation_id:'edit'+i,observation_ids:['proof'+i],result:{binding,authority:'native-host',status:'succeeded'}};
  s.observations['proof'+i]={operation_id:'read'+i,binding,authority:'native-host',facts:[{fact_id:'verification.postcondition_satisfied',fact_class:'verification',value:true}]};
 }
 return s;
}

test('only explicit frozen ceilings earn time; native credit is replayable, bounded and does not reset history',()=>{
 const s=fixture(2);assert(validLocalAdvisoryPolicyV1(s.spec));const before=JSON.stringify(s);
 assert.equal(assignmentWorkAllowanceV2(s).verified_changes,2);
 assert.equal(defaultAssignmentWorkBudgetV2(s,ordinary).max_wall_clock_ms,30*60_000);
 assert.equal(defaultAssignmentWorkBudgetV2(JSON.parse(before),ordinary).max_wall_clock_ms,30*60_000);
 assert.equal(JSON.stringify(s),before);
 const old=structuredClone(s);delete old.spec.execution_policy.progress_allowance.max_wall_clock_ms;
 assert.equal(defaultAssignmentWorkBudgetV2(old,ordinary).max_wall_clock_ms,20*60_000,'old saved clock is unchanged');
 const cap=fixture(30);assert.equal(defaultAssignmentWorkBudgetV2(cap,ordinary).max_wall_clock_ms,120*60_000);
 for(const ceiling of [0,-1,NaN,Infinity,20*60_000-1,120*60_000+1,1.5,null]){
  const bad=structuredClone(s);bad.spec.execution_policy.progress_allowance.max_wall_clock_ms=ceiling;assert.equal(validLocalAdvisoryPolicyV1(bad.spec),false);
 }
 for(const mutate of [
  (n:any)=>n.observations.proof1.authority='model',
  (n:any)=>n.operations.edit1.persistent_effect='unknown',
  (n:any)=>n.operations.edit1.result.native_transaction_state='pending',
  (n:any)=>n.operations.edit1.result.binding={...n.current_binding,generation:2},
  (n:any)=>n.operations.edit1.request_identity.request_signature='signature0',
  (n:any)=>n.operations.read1.target.target_id='id:1',
  (n:any)=>n.observations.proof1.facts[0].value=false]){
   const n=structuredClone(s);mutate(n);assert.equal(defaultAssignmentWorkBudgetV2(n,ordinary).max_wall_clock_ms,25*60_000);
 }
 const unproved=fixture();assert.equal(defaultAssignmentWorkBudgetV2(unproved,ordinary).max_wall_clock_ms,20*60_000);
 const read=fixture(2);read.spec.requested_effect='read';assert(!validLocalAdvisoryPolicyV1(read.spec));
});

test('controller uses earned cumulative time while neighboring resource fences remain intact',()=>{
 const s=fixture(2);s.provider_calls.used={admitted_at:at(0),completed_at:at(25*60_000),usage:{total_tokens:10}};
 const b=defaultAssignmentWorkBudgetV2(s,ordinary);
 assert.equal(assignmentProgressBudgetBlockerV2(s,b,at(25*60_000)),null);
 const old=structuredClone(s);delete old.spec.execution_policy.progress_allowance.max_wall_clock_ms;
 assert.equal(assignmentProgressBudgetBlockerV2(old,defaultAssignmentWorkBudgetV2(old,ordinary),at(25*60_000)),'execution_lease_exhausted');
 assert.equal(assignmentProgressBudgetBlockerV2(s,{...b,max_total_tokens:10},at(25*60_000)),'token_budget_exhausted');
});

test('provider wait reserves only frozen ceiling, explicit operator caps remain absolute',()=>{
 const s=fixture(2),limits=codexAssignmentTurnTimeLimits({snapshot:s,now:at(0)});
 assert.equal(limits.maxWallMs,30*60_000);assert.equal(limits.progressWallCeilingMs,120*60_000);
 const capped=codexAssignmentTurnTimeLimits({snapshot:s,now:at(0),configuredTimeout:'60000'});
 assert.equal(capped.maxWallMs,60_000);assert.equal(capped.progressWallCeilingMs,60_000);
 const old=structuredClone(s);delete old.spec.execution_policy.progress_allowance.max_wall_clock_ms;
 assert.equal(codexAssignmentTurnTimeLimits({snapshot:old,now:at(0)}).progressWallCeilingMs,undefined);
});

test('live time monitor counts current turn without receipts, honors fresh proof and cannot reset on reconnect',()=>{
 let s=fixture(),now=at(19*60_000);const initial=structuredClone(s);
 const monitor=createCodexAssignmentProgressTimeMonitor({initial,readCurrent:()=>s,startedAt:at(0),now:()=>now})!;
 assert.equal(monitor(),60_000,'current in-flight response needs no usage receipt to charge time');
 s=fixture(1);assert.equal(monitor(),6*60_000,'a real distinct checked edit earns five minutes');
 now=at(25*60_000);assert.equal(monitor(),0);
 now=at(21*60_000);s.current_binding={...s.current_binding,run_id:'foreign'};assert.equal(monitor(),0);
 s=fixture(1);s.spec.execution_policy.progress_allowance.max_wall_clock_ms-=1;assert.equal(monitor(),0,'policy changes cannot extend a live wait');
 s=fixture(1);s.provider_calls.prior={admitted_at:at(0),completed_at:at(10*60_000)};
 const resumed=createCodexAssignmentProgressTimeMonitor({initial:s,readCurrent:()=>s,startedAt:at(15*60_000),now:()=>at(20*60_000)})!;
 assert.equal(resumed(),10*60_000,'old ten minutes plus this turn five, not a new twenty-five');
 delete s.spec.execution_policy.progress_allowance.max_wall_clock_ms;
 assert.equal(createCodexAssignmentProgressTimeMonitor({initial:s,readCurrent:()=>s,startedAt:at(0)}),undefined);
});

test('real completion waiter crosses initial allowance only on fresh credit; expiry is not quota authority',async t=>{
 t.mock.timers.enable({apis:['setTimeout','Date'],now:0});
 let earned=1000;const turns=new CodexTurnCompletions();
 const wait=turns.wait({threadId:'a',turnId:'b',timeoutMs:20_000,maxWallMs:5000,remainingWorkMs:()=>Math.max(0,earned-Date.now())});
 t.mock.timers.tick(500);earned=3000;t.mock.timers.tick(1500);turns.observe('a','b','completed');
 assert.deepEqual(await wait,{status:'completed',interrupted:false});
 const expired=turns.wait({threadId:'a',turnId:'c',timeoutMs:20_000,maxWallMs:5000,remainingWorkMs:()=>0});
 await assert.rejects(expired,e=>{assert(e instanceof CodexWorkTimeExpiredError);assert.equal(turns.isCurrentFailure(e),false);assert.equal(classifyAssignmentKernelExecutionFailureV2(e),'resource_exhausted');return true;});
 const abort=new AbortController();const paused=turns.wait({threadId:'a',turnId:'d',timeoutMs:20_000,maxWallMs:5000,remainingWorkMs:()=>5000,abortSignal:abort.signal});
 const rejected=assert.rejects(paused,/aborted/);abort.abort();await rejected;
 const cap=turns.wait({threadId:'a',turnId:'e',timeoutMs:20_000,maxWallMs:1000,remainingWorkMs:()=>50_000});
 const capped=assert.rejects(cap,CodexWorkTimeExpiredError);t.mock.timers.tick(1000);await capped;
 const malformed=turns.wait({threadId:'a',turnId:'f',timeoutMs:20_000,maxWallMs:1000,remainingWorkMs:()=>Infinity});
 await assert.rejects(malformed,/Invalid task time/);
});

test('Resume retains both captured and earned limits; legacy policy and unknown/pause prerequisites are not widened',()=>{
 const s=fixture(1);s.provider_calls.used={admitted_at:at(0),completed_at:at(21*60_000),usage:{total_tokens:1}};
 const b=defaultAssignmentWorkBudgetV2(s,ordinary);
 s.provider_usage_hold={hold_id:'hold',binding:s.current_binding,resume_budget:b};
 const event:any={actor:'authenticated-user',assignment_version:2,expected_assignment_version:1,expected_hold_id:'hold',occurred_at:at(21*60_000)};
 const original=JSON.stringify(s);assert.doesNotThrow(()=>assertProviderUsageResumeV1(s,event));assert.equal(JSON.stringify(s),original);
 const cap=structuredClone(s);cap.provider_usage_hold.resume_budget.max_wall_clock_ms=20*60_000;
 assert.throws(()=>assertProviderUsageResumeV1(cap,event),(e:any)=>e.code==='provider_usage_resume_budget_exhausted');
 const legacy=structuredClone(s);delete legacy.spec.execution_policy.progress_allowance.max_wall_clock_ms;
 assert.throws(()=>assertProviderUsageResumeV1(legacy,event),(e:any)=>e.code==='provider_usage_resume_budget_exhausted');
 const unknown=structuredClone(s);unknown.unresolved_unknown_operation_ids=['uncertain'];
 assert.throws(()=>assertProviderUsageResumeV1(unknown,event),(e:any)=>e.code==='assignment_resume_reconciliation_required');
});
