import assert from 'node:assert/strict';
import test from 'node:test';
import {DESKTOP_SCOPED_HELPER_GUIDANCE} from '../src/assignments/desktop_executor_owner.js';

test('multi-step helper can preserve later edits through the existing tracked result checkpoint',()=>{
 const text=DESKTOP_SCOPED_HELPER_GUIDANCE;
 assert.match(text,/POST \/revit\/save-as/);
 assert.match(text,/same authorized result path/);
 assert.match(text,/overwrite=true/);
 assert.match(text,/new committed edits/);
 assert.match(text,/not an uncertain save retry/);
 assert.match(text,/never overwrite the input or an unrelated file/);
 assert.match(text,/exact saved artifact/);
 assert.match(text,/native verification and checkpoint save\/file inspection before handoff/);
 assert.match(text,/explicit user review-before-save/);
 assert.match(text,/final inspection checklist item pending/);
 assert.match(text,/unverified.*no completion/);
});
