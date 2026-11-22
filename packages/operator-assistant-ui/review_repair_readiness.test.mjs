import test from 'node:test';
import assert from 'node:assert/strict';
import {parseVisualWorkReview} from './visual_work_review.mjs';
import {reviewRepairFocus} from './review_repair_focus.mjs';

const request={checks:[{id:'symbols',expected:'Compare inline symbols.'},{id:'label',expected:'Compare the legible leadered size.'}]};
const checks=[
 {id:'symbols',status:'mismatch',observed:'Two ovals are absent at the tee; their device meaning is unknown.',correction:'Identify their meaning before inserting devices.',repair:{readiness:'needs_information',blocking_fact:'What device do the two oval marks represent?'}},
 {id:'label',status:'mismatch',observed:'The reference has a readable diameter callout beside the lower branch.',correction:'Restore the displayed callout at that branch.',repair:{readiness:'clear_visual_fix',blocking_fact:''}}
];
const response=checks=>({id:'review',status:'completed',output:[],output_text:JSON.stringify({checks})});
test('review parser preserves visible mismatch separately from repair readiness',()=>{
 const r=parseVisualWorkReview(response(checks),request);assert.equal(r.state,'mismatch');assert.deepEqual(r.checks.map(c=>c.repair),checks.map(c=>c.repair));
 const focus=reviewRepairFocus({ok:true,...r});assert.deepEqual(focus.ready_check_ids,['label']);assert.deepEqual(focus.needs_information_check_ids,['symbols']);assert.deepEqual(focus.unclassified_check_ids,[]);assert.match(focus.next_action,/ready_check_ids/);assert.match(focus.next_action,/one/);
});
test('legacy mismatch is unclassified rather than silently ready or completed',()=>{
 const old=checks.map(({repair,...c})=>c),r=parseVisualWorkReview(response(old),request),f=reviewRepairFocus({ok:true,...r});
 assert.deepEqual(f.ready_check_ids,[]);assert.deepEqual(f.unclassified_check_ids,['symbols','label']);assert.deepEqual(f.repair_check_ids,['symbols','label']);assert.equal(r.state,'mismatch');
});
test('invalid repair claims cannot produce actionable navigation',()=>{
 for(const repair of [{readiness:'clear_visual_fix',blocking_fact:'unknown device'}, {readiness:'needs_information',blocking_fact:''},{readiness:'native_verified',blocking_fact:''},{readiness:'clear_visual_fix',blocking_fact:'',authorized:true}]){
  assert.throws(()=>parseVisualWorkReview(response([{...checks[0],repair},checks[1]]),request));
 }
 assert.throws(()=>parseVisualWorkReview(response([{...checks[0],status:'matched'},checks[1]]),request));
 assert.equal(reviewRepairFocus({ok:false,state:'mismatch',checks}),null);
});
