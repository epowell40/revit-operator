import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import {runInNewContext} from 'node:vm';
import {acknowledgedComputerPause} from '../saved_computer_assignment.mjs';
const source=fs.readFileSync(new URL('../server.js',import.meta.url),'utf8').replace(/\r\n/g,'\n');
const start=source.indexOf('function interruptPausedComputerOwner('),end=source.indexOf('\n}\n',start)+2;
const binding={assignment_id:'task',session_id:'session',run_id:'run',generation:1};
test('canonical Pause latches incremental input before abort while retaining admitted native effects',()=>{
 for(const exact of [true,false]){
  const calls=[];const state={running:true,sidecarAssignment:{...binding,goal_id:'task',kernel_version:2},activeAbortController:{abort(){calls.push('abort');}}};
  const result={ok:true,assignment_snapshot_v2:{current_binding:binding,assignment_version:2,terminal:false,outcome:'active',execution_control:{state:'paused',command_id:'pause'},quiescent:false,unresolved_unknown_operation_ids:['unknown'],in_flight_operation_ids:['native'],in_flight_provider_call_ids:['usage']}};
  const before=JSON.stringify(result);
  const fn=runInNewContext(source.slice(start,end)+';interruptPausedComputerOwner',{computerState:state,acknowledgedComputerPause,computerControlIndicator:{latchStop(){calls.push('input-stop');}},updateComputerProgress(){},addComputerEvent(){}});
  assert.equal(fn(result,{...binding,action:'pause',command_id:exact?'pause':'stale',expected_command_id:null}),exact);
  assert.deepEqual(calls,exact?['input-stop','abort']:[]);assert.equal(JSON.stringify(result),before);
  assert.equal(state.controlFailureReason,exact?'desktop_assignment_paused':undefined);
 }
});
