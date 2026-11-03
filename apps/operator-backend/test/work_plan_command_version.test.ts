import test from 'node:test';
import assert from 'node:assert/strict';
import {assertWorkPlanCommandVersion} from '../src/assignments/assignment_work_plan.js';
import type {AssignmentSnapshotV2} from '../src/domain/assignment-kernel/snapshot.js';
const snapshot=()=>({assignment_version:235,quiescent:true,in_flight_provider_call_ids:[],
  unresolved_unknown_operation_ids:[],in_flight_operation_ids:[]} as unknown as AssignmentSnapshotV2);
test('existing unversioned commands unchanged; current quiescent complete accepted',()=>{
 assert.doesNotThrow(()=>assertWorkPlanCommandVersion(snapshot(),'status'));
 assert.doesNotThrow(()=>assertWorkPlanCommandVersion(snapshot(),'complete',235));
});
test('version drift and invalid use refuse before checklist writes',()=>{
 assert.throws(()=>assertWorkPlanCommandVersion(snapshot(),'complete',234),/version_changed/);
 for(const n of [0,-1,NaN,Infinity,1.5,'235'])assert.throws(()=>assertWorkPlanCommandVersion(snapshot(),'complete',n as number),/version_invalid/);
 assert.throws(()=>assertWorkPlanCommandVersion(snapshot(),'declare',235),/version_invalid/);
});
test('versioned command cannot cross unresolved native/provider state',()=>{
 for(const change of [{quiescent:false},{provider_usage_hold:{reason:'pending'}},{in_flight_provider_call_ids:['p']},
   {unresolved_unknown_operation_ids:['u']},{in_flight_operation_ids:['o']}])
  assert.throws(()=>assertWorkPlanCommandVersion({...snapshot(),...change} as AssignmentSnapshotV2,'complete',235),/not_quiescent/);
});
