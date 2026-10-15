import test from 'node:test';import assert from 'node:assert/strict';
import {assignmentWorkAllowanceV2,defaultAssignmentWorkBudgetV2} from '../src/domain/assignment-kernel/effective_work_budget.js';
import {validLocalAdvisoryPolicyV1} from '../src/domain/assignment-kernel/execution_policy.js';
import {assignmentWorkBudgetStatusV2} from '../src/assignments/assignment_work_allowance_v2.js';
import {DEFAULT_ASSIGNMENT_PROGRESS_BUDGET_V2 as ordinary} from '../src/assignments/assignment_kernel_v2_progress.js';
import {assignmentProgressBudgetBlockerV2} from '../src/domain/assignment-kernel/progress/controller.js';
import {assertProviderUsageResumeV1} from '../src/domain/assignment-kernel/provider_usage_hold.js';
import {codexAssignmentTurnTimeLimits,createCodexAssignmentProgressTimeMonitor} from '../src/codex/assignment_timeout.js';

const epoch=Date.UTC(2026,9,15),at=(ms:number)=>new Date(epoch+ms).toISOString();
function fixture():any{
 const binding={assignment_id:'work',run_id:'run',generation:1,session_id:'chat',principal_id:'owner',document_fingerprint:'model'};
 return {assignment_version:1,current_binding:binding,outcome:'active',quiescent:true,terminal:false,
  spec:{binding,created_at:at(0),requested_effect:'apply',criteria:[],work_units:[],input_variables:[],execution_policy:{mode:'local_advisory_v1',selected_by:'trusted_local_host',session_id:'chat',document_fingerprint:'model',max_turns:8,
   max_provider_calls:64,max_operations:256,max_total_tokens:8_000_000,max_wall_clock_ms:20*60_000,
   progress_allowance:{mode:'verified_native_changes_v1',credit_unit:'distinct_verified_targets_v1',max_provider_calls:256,max_operations:1024,max_total_tokens:32_000_000,max_wall_clock_ms:120*60_000}}},
  operations:{},observations:{},provider_calls:{},progress_epochs:[],execution_failure_ids:[],execution_failures:{},pending_input_variable_ids:[],pending_review_ids:[],in_flight_provider_call_ids:[],in_flight_operation_ids:[],unresolved_unknown_operation_ids:[]};
}
function batch(s:any,id:string,ids:number[]){
 const binding=s.current_binding;
 s.operations[id]={operation_id:id,binding,requested_effect:'apply',persistent_effect:'applied',settlement_state:'settled',opened_at:at(100),settled_at:at(200),request_identity:{request_signature:'signature-'+id},verification_operation_ids:['read-'+id],
  input:{body:{changes:ids.map(elementId=>({elementId,parameterName:'Comments',value:'Checked'}))}},result:{binding,authority:'native-host',status:'succeeded',native_transaction_state:'committed',affected_target_identities:[...ids.map(n=>'element_id:'+n),'element_id:99999']}};
 s.operations['read-'+id]={operation_id:'read-'+id,binding,target:{target_id:'id:99999'},requested_effect:'read',purpose:'verification',persistent_effect:'none',settlement_state:'settled',opened_at:at(200),settled_at:at(300),verification_of_operation_id:id,observation_ids:['proof-'+id],result:{binding,authority:'native-host',status:'succeeded'}};
 s.observations['proof-'+id]={operation_id:'read-'+id,binding,authority:'native-host',facts:[
  {fact_id:'verification.postcondition_satisfied',fact_class:'verification',value:true},
  {fact_id:'verification.deliverable_target_identities',fact_class:'verification',value:ids.map(n=>'element_id:'+n)}]};
}
test('new frozen target credits reward independent checked elements, including only new members of a mixed batch',()=>{
 const s=fixture();batch(s,'a',[1,2,3]);batch(s,'b',[3,4,5]);batch(s,'repeat',[1,2,3]);
 const original=JSON.stringify(s),a=assignmentWorkAllowanceV2(s),b=defaultAssignmentWorkBudgetV2(s,ordinary);
 assert(validLocalAdvisoryPolicyV1(s.spec));assert.equal(a.verified_changes,2);assert.equal(a.verified_targets,5);
 assert.equal(a.provider_calls,104);assert.equal(b.max_total_tokens,13_000_000);assert.equal(b.max_operations,416);assert.equal(b.max_wall_clock_ms,45*60_000);
 assert.equal(b.max_no_progress_epochs,ordinary.max_no_progress_epochs);assert.equal(b.max_equivalent_operations,ordinary.max_equivalent_operations);
 assert.deepEqual(assignmentWorkAllowanceV2(JSON.parse(original)),a);assert.equal(JSON.stringify(s),original);
 const legacy=JSON.parse(original);delete legacy.spec.execution_policy.progress_allowance.credit_unit;
 assert.deepEqual(assignmentWorkAllowanceV2(legacy),{broad:true,verified_changes:1,provider_calls:72},'old mixed-overlap batch semantics remain unchanged');
 assert.equal(defaultAssignmentWorkBudgetV2(legacy,ordinary).max_wall_clock_ms,25*60_000);
 delete legacy.spec.execution_policy.progress_allowance.max_wall_clock_ms;
 assert.equal(defaultAssignmentWorkBudgetV2(legacy,ordinary).max_wall_clock_ms,20*60_000,'old fixed clocks remain fixed');
});
test('target credit requires host-verified principal identities, never native collateral or unverified request arrays',()=>{
 const s=fixture();batch(s,'a',[1,2,3]);
 assert.equal(assignmentWorkAllowanceV2(s).verified_targets,3,'99999 collateral is not a deliverable');
 for(const change of [
  (n:any)=>n.operations.a.persistent_effect='unknown',
  (n:any)=>n.operations.a.persistent_effect='none',
  (n:any)=>n.operations.a.result.native_transaction_state='pending',
  (n:any)=>n.operations.a.result.native_transaction_state='rolled_back',
  (n:any)=>n.operations.a.result.authority='model',
  (n:any)=>n.operations.a.result.binding={...n.current_binding,generation:2},
  (n:any)=>n.operations.a.opened_at=at(-100),
  (n:any)=>n.operations['read-a'].result.authority='model',
  (n:any)=>n.observations['proof-a'].binding={...n.current_binding,generation:2},
  (n:any)=>n.observations['proof-a'].facts[0].value=false,
  (n:any)=>n.observations['proof-a'].facts[1].value=['element_id:1','element_id:1'],
  (n:any)=>n.observations['proof-a'].facts[1].value=['not-a-principal'],
 ]){const n=structuredClone(s);change(n);assert.equal(assignmentWorkAllowanceV2(n).verified_targets,0);assert.equal(defaultAssignmentWorkBudgetV2(n,ordinary).max_provider_calls,64);}
 const duplicate=structuredClone(s);batch(duplicate,'b',[4,5]);duplicate.operations.b.request_identity.request_signature=duplicate.operations.a.request_identity.request_signature;
 assert.equal(assignmentWorkAllowanceV2(duplicate).verified_targets,3);
 const missing=structuredClone(s);delete missing.observations['proof-a'].facts[1];delete missing.operations['read-a'].target.target_id;
 assert.equal(assignmentWorkAllowanceV2(missing).verified_targets,0);
});
test('target units and telemetry retain every hard ceiling and separate targets from operation batches',()=>{
 const s=fixture();batch(s,'a',Array.from({length:100},(_,i)=>i+1));
 const b=defaultAssignmentWorkBudgetV2(s,ordinary);assert.equal(b.max_provider_calls,256);assert.equal(b.max_total_tokens,32_000_000);assert.equal(b.max_operations,1024);assert.equal(b.max_wall_clock_ms,120*60_000);
 const original=JSON.stringify(s),status=assignmentWorkBudgetStatusV2(s,ordinary,at(300));
 assert.equal(status.allocation.verified_distinct_changes,1);assert.equal(status.allocation.verified_distinct_targets,100);assert.equal(status.allocation.earned_credit_unit,'distinct_verified_targets_v1');assert.equal(JSON.stringify(s),original);
 for(const value of ['batch','',null,1,{},true]){const n=structuredClone(s);n.spec.execution_policy.progress_allowance.credit_unit=value;assert.equal(validLocalAdvisoryPolicyV1(n.spec),false);}
});
test('admission, transport and quota Resume use earned target allowance without resetting receipts or bypassing captured caps',()=>{
 const s=fixture();batch(s,'a',[1,2,3,4,5,6]);
 s.provider_calls=Object.fromEntries(Array.from({length:80},(_,i)=>['call'+i,{admitted_at:at(0),completed_at:at(21*60_000),usage:{total_tokens:1}}]));
 const b=defaultAssignmentWorkBudgetV2(s,ordinary);assert.equal(b.max_provider_calls,112);assert.equal(assignmentProgressBudgetBlockerV2(s,b,at(21*60_000)),null);
 const legacy=structuredClone(s);delete legacy.spec.execution_policy.progress_allowance.credit_unit;
 assert.equal(assignmentProgressBudgetBlockerV2(legacy,defaultAssignmentWorkBudgetV2(legacy,ordinary),at(21*60_000)),'provider_call_budget_exhausted');
 const limits=codexAssignmentTurnTimeLimits({snapshot:s,now:at(21*60_000)});assert.equal(limits.maxWallMs,29*60_000);assert.equal(limits.progressWallCeilingMs,99*60_000);
 const capped=codexAssignmentTurnTimeLimits({snapshot:s,now:at(21*60_000),configuredTimeout:'60000'});assert.equal(capped.maxWallMs,60000);assert.equal(capped.progressWallCeilingMs,60000);
 let now=at(21*60_000);const monitor=createCodexAssignmentProgressTimeMonitor({initial:s,readCurrent:()=>s,startedAt:now,now:()=>now})!;
 now=at(26*60_000);assert.equal(monitor(),24*60_000);
 const before=JSON.stringify(s);s.provider_usage_hold={hold_id:'hold',binding:s.current_binding,resume_budget:b};
 const event:any={actor:'authenticated-user',assignment_version:2,expected_assignment_version:1,expected_hold_id:'hold',occurred_at:at(21*60_000)};
 assert.doesNotThrow(()=>assertProviderUsageResumeV1(s,event));assert.equal(JSON.stringify({...s,provider_usage_hold:undefined}),before);
 const small=structuredClone(s);small.provider_usage_hold.resume_budget.max_provider_calls=72;
 assert.throws(()=>assertProviderUsageResumeV1(small,event),(e:any)=>e.code==='provider_usage_resume_budget_exhausted');
 const unknown=structuredClone(s);unknown.unresolved_unknown_operation_ids=['unsettled'];assert.throws(()=>assertProviderUsageResumeV1(unknown,event),(e:any)=>e.code==='assignment_resume_reconciliation_required');
 const paused=structuredClone(s);paused.execution_control={state:'paused'};assert.equal(codexAssignmentTurnTimeLimits({snapshot:paused,now}).maxWallMs,0);
});
