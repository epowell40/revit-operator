import test from 'node:test';import assert from 'node:assert/strict';
import {CANONICAL_NATIVE_TASK_GUIDANCE} from './native_task_routing.mjs';

test('owner delegation distinguishes requested written questions from unrequested engineering design',()=>{
 const text=CANONICAL_NATIVE_TASK_GUIDANCE;
 assert.match(text,/request is only to list missing inputs, write questions or record a follow-up/);
 assert.match(text,/do not turn the underlying unrequested design into an unfinished model-edit checklist item/);
 assert.match(text,/actual unfinished requested design.*source-linked checklist deferral/);
 assert.match(text,/written findings.*task result/);
 assert.match(text,/Never bypass a required-input stop or unknown-effect reconciliation/);
});
