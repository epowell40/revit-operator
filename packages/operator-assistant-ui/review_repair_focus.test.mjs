import test from 'node:test';import assert from 'node:assert/strict';
import {reviewRepairFocus} from './review_repair_focus.mjs';
test('observations, failed reviews, malformed and duplicate findings cannot become a repair list',()=>{
 const valid={ok:true,state:'mismatch',checks:[{id:'line',status:'mismatch'}]};
 for(const value of [null,{}, {...valid,ok:false},{...valid,state:'observed'},{...valid,state:'unavailable'},
  {...valid,checks:[...valid.checks,...valid.checks]},{...valid,checks:[{id:'line',status:'complete'}]},
  {...valid,checks:[{id:' ',status:'mismatch'}]},{...valid,checks:Array(25).fill(valid.checks[0])}])assert.equal(reviewRepairFocus(value),null);
 assert.equal(reviewRepairFocus(valid).repair_check_ids[0],'line');
});
test('visually matching work does not bypass a selected code mismatch or uncertainty',()=>{
 for(const status of ['mismatch','uncertain']){
  const r=reviewRepairFocus({ok:true,state:status,checks:[{id:'drawing',status:'matched'}],code_review:{status}});
  assert.equal(r.selected_code_status,status);assert.match(r.next_action,/Resolve the selected code review finding/);
  assert.doesNotMatch(r.next_action,/return the result/);
 }
});
