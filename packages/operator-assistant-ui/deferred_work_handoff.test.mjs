import assert from 'node:assert/strict';import fs from 'node:fs';import test from 'node:test';
import {missingWorkReportContinuation} from './work_report.mjs';
const fixture=JSON.parse(fs.readFileSync(new URL('./fixtures/deferred-work-plan-329.json',import.meta.url),'utf8'));
test('329 canonical incomplete checkpoint cannot request another reporting turn or claim completion',async()=>{
 const binding={kernel_version:2,session_id:'session329',goal_id:'assignment329',run_id:'run329',generation:1};let reads=0;
 const status={ok:true,verification_policy:'strict',outcome:'blocked',work_plan:fixture.work_plan,
  progress_blocker:{code:'all_remaining_work_deferred'}};
 assert.equal(await missingWorkReportContinuation(binding,async()=>{reads++;return status;}),null);
 assert.equal(reads,1);assert.equal(status.outcome,'blocked');assert.equal(status.work_plan.items.length,3);
 for(const item of status.work_plan.items)assert(item.deferrals.at(-1).reason);
});
test('attempted verification remains unverified when a strict incomplete checkpoint ends reporting',async()=>{
 const binding={kernel_version:2,session_id:'session350',goal_id:'assignment350',run_id:'run350',generation:1};
 const status={ok:true,verification_policy:'strict',outcome:'blocked',work_plan:fixture.work_plan,
  progress_blocker:{code:'all_remaining_work_deferred_verification_unresolved',gap_ids:['verification:edit']},
  operations:[{operation_id:'edit',persistent_effect:'applied',verification_operation_ids:['read']},
   {operation_id:'read',verification_of_operation_id:'edit',persistent_effect:'none',settlement_state:'settled'}]};
 const original=structuredClone(status);let requests=0;
 for(const reminder of [0,1,2])assert.equal(await missingWorkReportContinuation(binding,async(route,options)=>{
  requests++;assert.equal(route,'/api/assignments/v2/work-plan');assert.equal(JSON.parse(options.body).action,'status');return status;
 },reminder),null);
 assert.equal(requests,3);assert.deepEqual(status,original);
 const active={...status,outcome:'active'};
 await assert.rejects(()=>missingWorkReportContinuation(binding,async()=>active,2),/task_outcome_required/,'a missing canonical stop is still an error, not manufactured completion');
});
