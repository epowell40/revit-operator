import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';
import {CANONICAL_NATIVE_TASK_GUIDANCE} from '../native_task_routing.mjs';

test('owner delegation distinguishes requested written questions from unrequested engineering design',()=>{
 const text=CANONICAL_NATIVE_TASK_GUIDANCE;
 assert.match(text,/request is only to list missing inputs, write questions or record a follow-up/);
 assert.match(text,/do not turn the underlying unrequested design into an unfinished model-edit checklist item/);
 assert.match(text,/actual unfinished requested design.*source-linked checklist deferral/);
 assert.match(text,/written findings.*task result/);
 assert.match(text,/Never bypass a required-input stop or unknown-effect reconciliation/);
 const server=fs.readFileSync(new URL('../server.js',import.meta.url),'utf8');
 const instructions=server.slice(server.indexOf('const SAFETY_INSTRUCTIONS ='),server.indexOf('const SAFETY_INSTRUCTIONS =')+24000);
 assert.match(instructions,/CANONICAL_NATIVE_TASK_GUIDANCE/);
 assert.match(instructions,/missing decision prevents actual requested model work/);
 assert.doesNotMatch(instructions,/For a missing decision affecting only part of a marked set/,'later owner instruction must not restore unconditional deferral');
});
