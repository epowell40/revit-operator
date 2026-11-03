import test from 'node:test';
import assert from 'node:assert/strict';
import {computerStateMatchesTask} from './task_navigation.mjs';
const binding={assignment_id:'task',session_id:'session',run_id:'run',generation:1};
test('only the exact explicitly selected task can adopt running or stopped computer state',()=>{
 for(const running of [true,false])assert.equal(computerStateMatchesTask({running,backendSessionId:'session',assignmentBindingV2:binding},binding,'session'),true);
 for(const key of Object.keys(binding))assert.equal(computerStateMatchesTask({backendSessionId:'session',assignmentBindingV2:{...binding,[key]:key==='generation'?2:'other'}},binding,'session'),false,key);
 for(const b of [null,{}, {...binding,generation:0},{...binding,assignment_id:''}])assert.equal(computerStateMatchesTask({backendSessionId:'session',assignmentBindingV2:b},b,'session'),false);
 for(const session of ['',null,'foreign'])assert.equal(computerStateMatchesTask({backendSessionId:'session',assignmentBindingV2:binding},binding,session),false);
 assert.equal(computerStateMatchesTask({backendSessionId:'session'},binding,'session'),false);
});
