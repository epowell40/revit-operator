import test from 'node:test';import assert from 'node:assert/strict';
import {draftingConstructionProgressV2,nativeCommitProgressIdentityV2,retainedNativeSuccess} from '../src/domain/assignment-kernel/progress/native_work_progress.js';
import {assignmentProgressBudgetBlockerV2,decideAssignmentProgressV2} from '../src/domain/assignment-kernel/progress/controller.js';
import {assignmentWorkAllowanceV2,defaultAssignmentWorkBudgetV2,allocateAuthenticatedFollowupV1} from '../src/domain/assignment-kernel/effective_work_budget.js';
import {DEFAULT_ASSIGNMENT_PROGRESS_BUDGET_V2 as ordinary} from '../src/assignments/assignment_kernel_v2_progress.js';
import {desktopAssignmentFeedbackInputV2} from '../src/desktop_assignment_feedback.js';
const epoch=Date.UTC(2026,9,31),at=(n:number)=>new Date(epoch+n*1000).toISOString();
function fixture(count=0):any{
 const binding={assignment_id:'drawing',run_id:'run',generation:1,session_id:'session',principal_id:'owner',document_fingerprint:'model'};
 const s:any={assignment_version:1,current_binding:binding,outcome:'active',terminal:false,quiescent:true,spec:{binding,created_at:at(0),requested_effect:'apply',criteria:[],work_units:[],input_variables:[],execution_policy:{mode:'local_advisory_v1',selected_by:'trusted_local_host',session_id:'session',document_fingerprint:'model',max_turns:8,max_provider_calls:64,max_operations:256,max_total_tokens:8000000,max_wall_clock_ms:1200000,ready_work_handoff:'continue_ready_work_v1',progress_allowance:{mode:'verified_native_changes_v1',credit_unit:'distinct_verified_targets_v1',max_provider_calls:256,max_operations:1024,max_total_tokens:32000000,max_wall_clock_ms:7200000}}},
  work_plan:{schema:'revit-operator.assignment-work-plan/v2',items:[{item_id:'branch',kind:'edit',description:'Draft the reference branch',source_basis:'PDF region',declared_at:at(0),operation_ids:[]}]},
  provider_calls:{},operations:{},observations:{},progress_epochs:[],criteria:{},criterion_evaluation_versions:{},work_unit_states:{},pending_input_variable_ids:[],pending_review_ids:[],in_flight_provider_call_ids:[],in_flight_operation_ids:[],unresolved_unknown_operation_ids:[],execution_failures:{},execution_failure_ids:[]};
 for(let n=1;n<=count;n++)s.provider_calls['call'+n]={binding,state:'completed',admitted_at:at(n*5),completed_at:at(n*5+1),usage:{total_tokens:100}};
 return s;
}
function commit(s:any,id='write',when=62){
 const binding=s.current_binding,raw='a'.repeat(64);
 s.operations[id]={operation_id:id,binding,purpose:'work',fulfillment_role:'delegated_task_execution',requested_effect:'apply',persistent_effect:'applied',admission_state:'admitted',dispatch_state:'dispatched',settlement_state:'settled',opened_at:at(when-1),settled_at:at(when),request_identity:{request_signature:'signature-'+id},verification_operation_ids:[],observation_ids:['obs-'+id],target:{target_id:'id:1',document_fingerprint:'model'},input:{},result:{operation_id:id,binding,authority:'native-host',status:'succeeded',dispatch_state:'dispatched',persistent_effect:'applied',native_transaction_state:'committed',receipt_id:'receipt-'+id,affected_target_identities:['element_id:1'],raw_payload_hash:raw,completed_at:at(when)}};
 s.observations['obs-'+id]={operation_id:id,binding,authority:'native-host',capability_id:undefined,raw_payload_hash:raw,facts:[{fact_id:'control.domain_succeeded',value:true}]};return s.operations[id];
}
function verify(s:any){
 const w=s.operations.write,r=commit(s,'read',70);Object.assign(r,{purpose:'verification',fulfillment_role:'verification',requested_effect:'read',persistent_effect:'none',verification_of_operation_id:'write'});Object.assign(r.result,{persistent_effect:'none',native_transaction_state:'not_applicable'});w.verification_operation_ids=['read'];
 s.observations['obs-read'].facts.push({fact_id:'verification.postcondition_satisfied',fact_class:'verification',value:true},{fact_id:'verification.deliverable_target_identities',fact_class:'verification',value:['element_id:1']});return r;
}
test('successful knowledge-only work warns then stops through the existing provider controller, without extra allowance',()=>{
 for(const [calls,state] of [[7,'working'],[8,'change_approach'],[11,'change_approach'],[12,'stalled']] as const){
  const s=fixture(calls),original=JSON.stringify(s),p=draftingConstructionProgressV2(s,4)!;
  assert.equal(p.state,state);assert.equal(p.calls_since_construction,calls);
  assert.equal(assignmentWorkAllowanceV2(s).provider_calls,64);assert.equal(assignmentWorkAllowanceV2(s).verified_targets,0);
  assert.equal(assignmentProgressBudgetBlockerV2(s,defaultAssignmentWorkBudgetV2(s,ordinary),at(90)),null);
  assert.deepEqual(draftingConstructionProgressV2(JSON.parse(original),4),p);assert.equal(JSON.stringify(s),original);
 }
});
test('optional planning discovery cannot disable pacing before the first constructive action',()=>{
 for(const plan of [undefined,{items:[]},{items:[{kind:'inspection',item_id:'review'}]}]){
  const s=fixture(12);s.work_plan=plan;
  assert.equal(draftingConstructionProgressV2(s,4)?.state,'stalled');
  assert.equal(assignmentProgressBudgetBlockerV2(s,defaultAssignmentWorkBudgetV2(s,ordinary),at(90)),null);
  const feedback=desktopAssignmentFeedbackInputV2('Continue',s);
  assert.match(JSON.stringify(feedback),/calls_since_construction/);
  commit(s);assert.equal(draftingConstructionProgressV2(s,4)?.state,'working');
  assert.equal(assignmentWorkAllowanceV2(s).provider_calls,64,'no unverified or planning credit');
 }
});
test('SaveAs, fresh read receipts, observations and checklist prose cannot reset the construction clock',()=>{
 const s=fixture(12);const save=commit(s,'save');save.result.native_transaction_state='not_applicable';save.input={method:'POST',path:'/revit/save-as'};
 const read=commit(s,'discovery');read.requested_effect='read';read.persistent_effect='none';read.result.persistent_effect='none';read.result.native_transaction_state='not_applicable';
 s.work_plan_claims=[{item_id:'branch'}];s.work_plan.items[0].location_history=[{recorded_at:at(65),drafting:{stage:'attempted',next_action:'Same branch'}}];
 assert.equal(draftingConstructionProgressV2(s,4)?.state,'stalled');assert.equal(assignmentWorkAllowanceV2(s).verified_targets,0);
});
test('a real native commit permits checking but only a distinct verified target earns existing allowance',()=>{
 const s=fixture(12);commit(s);assert.equal(draftingConstructionProgressV2(s,4)?.state,'working');assert.equal(draftingConstructionProgressV2(s,4)?.calls_since_construction,0);
 assert.equal(assignmentWorkAllowanceV2(s).provider_calls,64,'unverified commit grants no extra calls');
 verify(s);assert.equal(draftingConstructionProgressV2(s,4)?.independently_checked_targets,1);assert.equal(assignmentWorkAllowanceV2(s).verified_targets,1);assert.equal(assignmentWorkAllowanceV2(s).provider_calls,72);
 const duplicate=structuredClone(s.operations.read);duplicate.operation_id='read-again';duplicate.result.operation_id='read-again';duplicate.result.completed_at=at(75);duplicate.observation_ids=['obs-again'];
 s.operations['read-again']=duplicate;s.operations.write.verification_operation_ids.push('read-again');s.observations['obs-again']={...structuredClone(s.observations['obs-read']),operation_id:'read-again'};
 assert.equal(assignmentWorkAllowanceV2(s).provider_calls,72,'another receipt for the same checked target grants no extra allowance');
 assert.equal(draftingConstructionProgressV2(s,4)?.since,at(70),'duplicate verification cannot reset the construction clock');
});
test('failed, foreign, unbound or replayed commits cannot evade the no-progress decision',()=>{
 for(const mutate of [(o:any)=>o.result.authority='model',(o:any)=>o.result.status='failed',(o:any)=>o.result.binding={...o.binding,generation:2},(o:any)=>o.result.native_transaction_state='rolled_back',(o:any)=>o.observation_ids=[],(o:any)=>o.result.affected_target_identities=[]]){
  const s=fixture(12);mutate(commit(s));assert.equal(draftingConstructionProgressV2(s,4)?.state,'stalled');
 }
 const s=fixture(12),first=commit(s);first.result.completed_at=at(3);first.opened_at=at(2);const repeat=commit(s,'repeated',65);repeat.request_identity.request_signature=first.request_identity.request_signature;
 assert.equal(draftingConstructionProgressV2(s,4)?.state,'stalled');
});
test('Pause, pending native work, unknown effects and unsettled provider accounting retain priority',()=>{
 const s=fixture(12),budget=defaultAssignmentWorkBudgetV2(s,ordinary);
 for(const [patch,decision] of [[{execution_control:{state:'paused'}},'paused'],[{quiescent:false,in_flight_operation_ids:['write']},'await_operation'],[{in_flight_provider_call_ids:['call']},'await_provider'],[{unresolved_unknown_operation_ids:['write']},'reconcile_operation']] as const)
  assert.equal(decideAssignmentProgressV2({snapshot:{...s,...patch},budget,now:at(90)}).decision,decision);
 for(const patch of [{spec:{...s.spec,requested_effect:'read'}},{spec:{...s.spec,execution_policy:undefined}},{spec:{...s.spec,execution_policy:{...s.spec.execution_policy,ready_work_handoff:undefined}}}])
  assert.equal(draftingConstructionProgressV2({...s,...patch},4),null);
});
test('the actual provider feedback asks for a changed constructive approach before another paid turn',()=>{
 const s=fixture(8);const input=desktopAssignmentFeedbackInputV2('Continue',s);const text=(input.at(-1) as any).content[0].text;
 assert.match(text,/Change approach now/);assert.match(text,/Saving the unchanged model earns no construction credit/);assert.match(text,/calls_since_construction/);
 assert.equal(assignmentWorkAllowanceV2(s).provider_calls,64);
});

test('authenticated checkpoint follow-up starts one fresh construction window without resetting usage or awarding verified credit',()=>{
 const s=fixture(12),prior=JSON.stringify(s),atFollowup=at(90);
 const allocated:any=allocateAuthenticatedFollowupV1(s,'continue-existing-drawing',atFollowup);
 const p=draftingConstructionProgressV2(allocated,4)!;
 assert.equal(p.state,'working');assert.equal(p.calls_since_construction,0);assert.equal(p.since,atFollowup);
 assert.equal(Object.keys(allocated.provider_calls).length,12);assert.equal(assignmentWorkAllowanceV2(allocated).verified_targets,0);
 assert.equal(JSON.stringify(s),prior);assert.equal(assignmentWorkAllowanceV2(allocated).provider_calls,76);
 for(let n=13;n<=24;n++)allocated.provider_calls['call'+n]={binding:allocated.current_binding,state:'completed',admitted_at:at(100+(n-13)*5),completed_at:at(101+(n-13)*5),usage:{total_tokens:100}};
 assert.equal(draftingConstructionProgressV2(allocated,4)?.state,'stalled','The authorized new window is bounded too');
 assert.equal(Object.keys(allocated.provider_calls).length,24);assert.equal(assignmentWorkAllowanceV2(allocated).verified_targets,0);
 assert.deepEqual(draftingConstructionProgressV2(JSON.parse(JSON.stringify(allocated)),4),draftingConstructionProgressV2(allocated,4),'Ordinary recovery or compaction cannot start another window');
});



test('changed direction does not erase actual historical commits from pacing or renew verification',()=>{
 const s=fixture(14);commit(s);s.input_invalidated_operation_ids=['write'];const before=JSON.stringify(s),p=draftingConstructionProgressV2(s,4)!;
 assert.equal(p.state,'working');assert.equal(p.distinct_model_commits,1);assert.equal(p.calls_since_construction,2);assert.equal(p.since,at(62));
 assert.equal(retainedNativeSuccess(s,s.operations.write),false,'Invalidated results remain unavailable as current native success');assert.equal(nativeCommitProgressIdentityV2(s,s.operations.write),null,'Ordinary progress/verification paths remain strict');assert.equal(assignmentWorkAllowanceV2(s).verified_targets,0);assert.equal(assignmentWorkAllowanceV2(s).provider_calls,64);assert.equal(JSON.stringify(s),before);
});
test('controller sees existing historical construction after input invalidation and still stops a genuinely idle window',()=>{
 const s=fixture(14);commit(s);s.input_invalidated_operation_ids=['write'];assert.equal(assignmentProgressBudgetBlockerV2(s,defaultAssignmentWorkBudgetV2(s,ordinary),at(90)),null);
 for(let n=15;n<=24;n++)s.provider_calls['call'+n]={binding:s.current_binding,state:'completed',admitted_at:at(100+(n-15)*5),completed_at:at(101+(n-15)*5),usage:{total_tokens:100}};
 assert.equal(draftingConstructionProgressV2(s,4)?.calls_since_construction,12);assert.equal(assignmentProgressBudgetBlockerV2(s,defaultAssignmentWorkBudgetV2(s,ordinary),at(180)),null);
});
test('historical pacing still rejects failed foreign missing-receipt or untrusted invalidated operations',()=>{
 for(const mutate of [(o:any)=>o.result.authority='model',(o:any)=>o.result.status='failed',(o:any)=>o.result.native_transaction_state='unknown',(o:any)=>o.result.receipt_id=null,(o:any)=>o.result.affected_target_identities=[],(o:any)=>o.result.binding={...o.binding,run_id:'foreign'}]){
 const s=fixture(14);const o=commit(s);s.input_invalidated_operation_ids=['write'];mutate(o);assert.equal(draftingConstructionProgressV2(s,4)?.state,'stalled');assert.equal(assignmentWorkAllowanceV2(s).verified_targets,0);
 }
 const s=fixture(14);commit(s);s.input_invalidated_operation_ids=['write'];s.observations['obs-write'].facts=[];assert.equal(draftingConstructionProgressV2(s,4)?.state,'stalled');
});

test('construction-call pacing is advice, while real resource ceilings remain authoritative',()=>{
 const s=fixture(12),budget=defaultAssignmentWorkBudgetV2(s,ordinary);
 assert.equal(draftingConstructionProgressV2(s,4)?.state,'stalled');
 assert.equal(assignmentProgressBudgetBlockerV2(s,budget,at(90)),null,'Distinct calibration/source/model reads do not prove an inspection loop.');
 assert.equal(assignmentProgressBudgetBlockerV2(s,{...budget,max_provider_calls:12},at(90)),'provider_call_budget_exhausted');
 assert.equal(assignmentProgressBudgetBlockerV2(s,{...budget,max_total_tokens:1200},at(90)),'token_budget_exhausted');
 assert.equal(assignmentWorkAllowanceV2(s).verified_targets,0);
 const text=(desktopAssignmentFeedbackInputV2('Continue calibration then construction',s).at(-1) as any).content[0].text;
 assert.match(text,/Change approach now/);assert.match(text,/specific fact/);
});