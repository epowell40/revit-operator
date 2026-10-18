import test from 'node:test';import assert from 'node:assert/strict';
import {createExecutionDeadlineV2} from '../src/brains/execution_deadline_v2.js';
import {createCodexAssignmentProgressTimeMonitor,codexAssignmentTurnTimeLimits} from '../src/codex/assignment_timeout.js';
const minute=60_000,epoch=Date.UTC(2026,9,15),iso=(t:number)=>new Date(t).toISOString();
function snapshot():any{
 const binding={assignment_id:'work',run_id:'run',generation:1,session_id:'chat',principal_id:'owner',document_fingerprint:'model'};
 return {current_binding:binding,outcome:'active',terminal:false,quiescent:true,unresolved_unknown_operation_ids:[],provider_calls:{},operations:{},observations:{},
  spec:{binding,created_at:iso(epoch),requested_effect:'apply',execution_policy:{mode:'local_advisory_v1',selected_by:'trusted_local_host',session_id:'chat',document_fingerprint:'model',max_turns:8,max_provider_calls:64,max_operations:256,max_total_tokens:8_000_000,max_wall_clock_ms:20*minute,
   progress_allowance:{mode:'verified_native_changes_v1',credit_unit:'distinct_verified_targets_v1',max_provider_calls:256,max_operations:1024,max_total_tokens:32_000_000,max_wall_clock_ms:120*minute}}}};
}
function checked(s:any){const binding=s.current_binding,at=Date.now();
 s.operations.edit={operation_id:'edit',binding,requested_effect:'apply',persistent_effect:'applied',settlement_state:'settled',opened_at:iso(at-50),settled_at:iso(at-30),request_identity:{request_signature:'distinct'},input:{body:{changes:[{elementId:1,parameterName:'Comments',value:'Checked'}]}},verification_operation_ids:['read'],result:{binding,authority:'native-host',status:'succeeded',native_transaction_state:'committed',affected_target_identities:['element_id:1']}};
 s.operations.read={operation_id:'read',binding,target:{target_id:'id:1'},requested_effect:'read',purpose:'verification',persistent_effect:'none',settlement_state:'settled',opened_at:iso(at-30),settled_at:iso(at-10),verification_of_operation_id:'edit',observation_ids:['proof'],result:{binding,authority:'native-host',status:'succeeded'}};
 s.observations.proof={operation_id:'read',binding,authority:'native-host',facts:[{fact_id:'verification.postcondition_satisfied',fact_class:'verification',value:true},{fact_id:'verification.deliverable_target_identities',fact_class:'verification',value:['element_id:1']}]};
}
test('actual outer abort timer crosses original20minutes on checked work while the legacy fixed clock expires',t=>{
 t.mock.timers.enable({apis:['setTimeout','Date'],now:epoch});let current=snapshot();
 const monitor=createCodexAssignmentProgressTimeMonitor({initial:structuredClone(current),readCurrent:()=>current,startedAt:iso(epoch)})!;
 const deadline=createExecutionDeadlineV2({maxWallMs:20*minute,maxWallCeilingMs:120*minute,remainingWorkMs:monitor}),controller=new AbortController(),fixed=new AbortController();
 const stop=deadline.arm(controller),stopFixed=createExecutionDeadlineV2({maxWallMs:20*minute,maxWallCeilingMs:120*minute}).arm(fixed);
 t.mock.timers.tick(19*minute);checked(current);const before=JSON.stringify(current);t.mock.timers.tick(2*minute);
 assert.equal(controller.signal.aborted,false);assert.equal(fixed.signal.aborted,true);assert.equal(fixed.signal.reason,'experiment_wall_limit');assert.equal(deadline.remainingMs(),4*minute);assert.equal(JSON.stringify(current),before);
 t.mock.timers.tick(4*minute);assert.equal(controller.signal.aborted,true);assert.equal(controller.signal.reason,'experiment_wall_limit');stop();stopFixed();
});
test('an explicit frozen ceiling does not earn time without checked work',t=>{
 t.mock.timers.enable({apis:['setTimeout','Date'],now:epoch});const s=snapshot(),monitor=createCodexAssignmentProgressTimeMonitor({initial:s,readCurrent:()=>s,startedAt:iso(epoch)})!;
 const c=new AbortController(),stop=createExecutionDeadlineV2({maxWallMs:20*minute,maxWallCeilingMs:120*minute,remainingWorkMs:monitor}).arm(c);
 t.mock.timers.tick(20*minute);assert.equal(c.signal.aborted,true);assert.equal(c.signal.reason,'experiment_wall_limit');stop();
});
test('explicit transport cap stays absolute even after new verified work',t=>{
 t.mock.timers.enable({apis:['setTimeout','Date'],now:epoch});const s=snapshot(),limits=codexAssignmentTurnTimeLimits({snapshot:s,now:iso(epoch),configuredTimeout:'60000'});
 const monitor=createCodexAssignmentProgressTimeMonitor({initial:structuredClone(s),readCurrent:()=>s,startedAt:iso(epoch)})!;
 const c=new AbortController(),stop=createExecutionDeadlineV2({maxWallMs:20*minute,maxWallCeilingMs:limits.progressWallCeilingMs,remainingWorkMs:monitor}).arm(c);
 t.mock.timers.tick(30_000);checked(s);t.mock.timers.tick(30_000);assert.equal(c.signal.aborted,true);stop();
});
test('the hard ceiling and parent cancellation cannot be extended or relabeled',t=>{
 t.mock.timers.enable({apis:['setTimeout','Date'],now:0});const hard=new AbortController(),user=new AbortController();
 const a=createExecutionDeadlineV2({maxWallMs:1000,maxWallCeilingMs:5000,remainingWorkMs:()=>60_000}).arm(hard);
 const b=createExecutionDeadlineV2({maxWallMs:1000,maxWallCeilingMs:5000,remainingWorkMs:()=>60_000}).arm(user);
 t.mock.timers.tick(500);user.abort('user_cancel');t.mock.timers.tick(4500);
 assert.equal(hard.signal.reason,'experiment_wall_limit');assert.equal(user.signal.reason,'user_cancel');a();b();
});
test('deadline disposal prevents a later cancel and malformed projections fail closed',t=>{
 t.mock.timers.enable({apis:['setTimeout','Date'],now:0});const c=new AbortController(),stop=createExecutionDeadlineV2({maxWallMs:1000}).arm(c);stop();t.mock.timers.tick(2000);assert.equal(c.signal.aborted,false);
 for(const remainingWorkMs of [()=>NaN,()=>Infinity,()=>-1,()=>{throw Error('unavailable');}])assert.equal(createExecutionDeadlineV2({maxWallMs:1000,maxWallCeilingMs:5000,remainingWorkMs}).remainingMs(),0);
 for(const maxWallMs of [0,-1,Infinity,NaN])assert.equal(createExecutionDeadlineV2({maxWallMs,maxWallCeilingMs:5000,remainingWorkMs:()=>1000}).remainingMs(),0);
 let clock=100;const d=createExecutionDeadlineV2({maxWallMs:1000,now:()=>clock});clock=200;assert.equal(d.remainingMs(),900);clock=150;assert.equal(d.remainingMs(),0,'wall-clock rollback cannot refund the request');
});
test('restart projection retains charged execution and frozen policy or binding changes cannot earn time',t=>{
 t.mock.timers.enable({apis:['setTimeout','Date'],now:epoch+15*minute});let s=snapshot();checked(s);s.provider_calls.prior={admitted_at:iso(epoch),completed_at:iso(epoch+10*minute)};
 const before=JSON.stringify(s),initial=structuredClone(s),startedAt=iso(Date.now()),limits=codexAssignmentTurnTimeLimits({snapshot:s,now:startedAt});
 const monitor=createCodexAssignmentProgressTimeMonitor({initial,readCurrent:()=>s,startedAt})!;
 const d=createExecutionDeadlineV2({maxWallMs:20*minute,maxWallCeilingMs:limits.progressWallCeilingMs,remainingWorkMs:monitor});
 t.mock.timers.tick(5*minute);assert.equal(d.remainingMs(),10*minute-40,'Prior provider time and40ms of settled native work remain charged');assert.equal(JSON.stringify(s),before);
 s=structuredClone(initial);s.current_binding={...s.current_binding,generation:2};assert.equal(d.remainingMs(),0);
 s=structuredClone(initial);s.spec.execution_policy.progress_allowance.max_wall_clock_ms+=1;assert.equal(d.remainingMs(),0);
});
