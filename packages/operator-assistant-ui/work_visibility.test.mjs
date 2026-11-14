import test from 'node:test';
import assert from 'node:assert/strict';
import {workVisibilityInstructions} from './work_visibility.mjs';
test('visible-work preference is opt-in and asks for real committed phases without artificial waits',()=>{
 for(const s of [undefined,{}, {show_work_as_it_runs:false},{show_work_as_it_runs:'true'}])assert.equal(workVisibilityInstructions(s),'');
 const text=workVisibilityInstructions({show_work_as_it_runs:true});
 assert.match(text,/after each committed apply/);assert.match(text,/Do not add sleeps, screenshots/);assert.match(text,/Read-only tasks remain read-only/);
});
