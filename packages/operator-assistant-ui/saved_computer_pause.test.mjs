import test from 'node:test';import assert from 'node:assert/strict';
import {acknowledgedComputerPause,isSavedComputerPaused,assertComputerDispatchSnapshot,assertComputerResumeControl} from './saved_computer_assignment.mjs';
const binding={assignment_id:'task',session_id:'session',run_id:'run',generation:1};
const command={...binding,action:'pause',expected_assignment_version:12,command_id:'pause-13'};
const paused=()=>({current_binding:{...binding},assignment_version:13,terminal:false,outcome:'active',execution_control:{state:'paused',command_id:'pause-13'},quiescent:true,
 pending_review_ids:[],pending_input_variable_ids:[],unresolved_unknown_operation_ids:[],in_flight_operation_ids:[],in_flight_provider_call_ids:[]});
test('acknowledged Pause interrupts only the current owner and retains unfinished state',()=>{
 const s=paused(),before=JSON.stringify(s);assert(acknowledgedComputerPause({ok:true,assignment_snapshot_v2:s},command,binding));
 assert(isSavedComputerPaused(s,binding));assert.throws(()=>assertComputerDispatchSnapshot(s,binding),/paused/);assert.equal(JSON.stringify(s),before);
});
test('foreign, stale, terminal, malformed or unacknowledged controls cannot interrupt owner',()=>{
 for(const patch of [{terminal:true},{terminal:undefined},{assignment_version:12},{current_binding:{...binding,generation:2}},{execution_control:{state:'running',command_id:'pause-13'}},{execution_control:{state:'paused',command_id:'old'}}])
  assert(!acknowledgedComputerPause({ok:true,assignment_snapshot_v2:{...paused(),...patch}},command,binding));
 assert(!acknowledgedComputerPause({ok:false,assignment_snapshot_v2:paused()},command,binding));
 assert(!acknowledgedComputerPause({ok:true,assignment_snapshot_v2:paused()},{...command,action:'resume'},binding));
 assert(!isSavedComputerPaused({},binding));
});
test('Pause preserves unknown effects and pending usage; neither can be resumed by this observation',()=>{
 for(const patch of [{quiescent:false,in_flight_operation_ids:['native-op']},{unresolved_unknown_operation_ids:['unknown-op']},{in_flight_provider_call_ids:['provider-call']},{provider_usage_hold:{hold_id:'usage'}},{pending_review_ids:['review']}]){
  const s={...paused(),...patch};assert(isSavedComputerPaused(s,binding));
  const resumed={...s,execution_control:{state:'running',command_id:'resume-14'},assignment_version:14};
  assert.throws(()=>assertComputerResumeControl(resumed,binding,{command_id:'resume-14',assignment_version:14}));
 }
 const current={...paused(),execution_control:{state:'running',command_id:'resume-14'},assignment_version:14};
 assert.doesNotThrow(()=>assertComputerResumeControl(current,binding,{command_id:'resume-14',assignment_version:14}));
});
