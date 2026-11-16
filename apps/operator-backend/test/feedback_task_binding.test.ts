import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createGoal} from '../src/goals/service.js';
import {createAssignmentKernelV2} from '../src/assignments/assignment_kernel_v2_store.js';
import {ASSIGNMENT_SPEC_V2_SCHEMA} from '../src/domain/assignment-kernel/index.js';
import {appendFeedbackAndMaybePromote} from '../src/feedback/feedback_store.js';

test('task feedback persists exact binding and rejects stale/foreign bindings before writing',()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'feedback-bound-'));process.env.OPERATOR_WORKSPACE_ROOT=root;
 const goal=createGoal({title:'Read',objective:'Read walls',acceptance_criteria:['read'],related_session_id:'s'});
 const binding={assignment_id:goal.id,session_id:'s',run_id:'r',generation:1,principal_id:'p',document_fingerprint:'d'};
 createAssignmentKernelV2(goal.id,{schema:ASSIGNMENT_SPEC_V2_SCHEMA,binding,source_user_request:'Read walls',requested_effect:'read',criteria:[],input_variables:[],work_units:[],authorization_policy_id:'read',created_at:new Date().toISOString()},'test');
 appendFeedbackAndMaybePromote({session_id:'s',rating:'partial',task_binding:binding,note:'Missing one count.'});
 const file=path.join(root,'feedback/events.jsonl'),before=fs.readFileSync(file,'utf8'),row=JSON.parse(before.trim());
 assert.equal(row.assignment_id,goal.id);assert.equal(row.run_id,'r');assert.equal(row.generation,1);
 for(const b of [{...binding,session_id:'other'},{...binding,generation:2},{...binding,run_id:'foreign'},{...binding,assignment_id:'../foreign'}]){
  assert.throws(()=>appendFeedbackAndMaybePromote({session_id:'s',rating:'failed',task_binding:b}),/task changed/);
  assert.equal(fs.readFileSync(file,'utf8'),before);
 }
 appendFeedbackAndMaybePromote({session_id:'s',rating:'worked'});
 const legacy=JSON.parse(fs.readFileSync(file,'utf8').trim().split('\n').at(-1)!);assert.equal(legacy.assignment_id,undefined);
});
