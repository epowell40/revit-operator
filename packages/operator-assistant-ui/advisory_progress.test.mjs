import test from 'node:test';
import assert from 'node:assert/strict';
import * as workspace from './advisory_progress.mjs';
function snapshot(){return {spec:{execution_policy:{mode:'single_actor_review_v1'}},work_plan:{items:[{item_id:'area',description:'Front area',operation_ids:[],location_history:[{drafting:{stage:'checked',pass:'coverage'}}]}]},work_plan_claims:[{item_id:'area',verified:false,claimed_at:'2026-11-14T15:00:00Z'}]};}
test('advisory progress displays the canonical task ledger without declaring verification',()=>{
 const p=workspace.advisoryWorkPlanDisplay(snapshot());
 assert.equal(p.progress.total,1);assert.equal(p.progress.reported,1);assert.equal(p.progress.checked,1);
 assert.equal(p.progress.completed,0);assert.equal(p.progress.ratio,null);
 assert.equal(p.items[0].status,'reported_complete');assert.equal(p.progress.basis,'actor_work_plan');
});
test('new correction and deferral cannot retain an old done badge',()=>{
 const s=snapshot();s.work_plan.items[0].deferrals=[{deferred_at:'2026-11-14T15:01:00Z',prior_claim_count:1}];
 let p=workspace.advisoryWorkPlanDisplay(s);assert.equal(p.progress.reported,0);assert.equal(p.items[0].status,'blocked');
 s.work_plan.items[0].deferrals[0].resumed_at='2026-11-14T15:02:00Z';
 s.work_plan.items[0].location_history.push({drafting:{stage:'drafted',pass:'geometry'}});
 p=workspace.advisoryWorkPlanDisplay(s);assert.equal(p.progress.reported,0);assert.equal(p.progress.checked,0);
});
test('strict mode and empty plans retain their existing progress path',()=>{
 const s=snapshot();delete s.spec.execution_policy;assert.equal(workspace.advisoryWorkPlanDisplay(s),null);
 s.spec.execution_policy={mode:'single_actor_review_v1'};s.work_plan.items=[];assert.equal(workspace.advisoryWorkPlanDisplay(s),null);
});
test('settled advisory handoff without an item ledger is not zero-percent progress',()=>{
 const s={spec:{execution_policy:{mode:'single_actor_review_v1'}},outcome:'awaiting_user_review',quiescent:true};
 const p=workspace.advisoryWorkPlanDisplay(s);
 assert.equal(p.progress.basis,'review_handoff');assert.equal(p.progress.ratio,null);assert.equal(p.progress.completed,0);assert.equal(p.items,undefined);
 for(const other of [{outcome:'active'},{quiescent:false},{unresolved_unknown_operation_ids:['uncertain']},{execution_control:{state:'paused'}},{spec:{}}])assert.equal(workspace.advisoryWorkPlanDisplay({...s,...other}),null);
});
