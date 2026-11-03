import test from 'node:test';
import assert from 'node:assert/strict';
import {TASK_DISCRETION_GUIDANCE} from '../src/brains/task_discretion_guidance.js';
import {getOperatorAgentBaseInstructions} from '../src/brains/codex_brain_instructions.js';
import {getThinReferenceCodexProfile} from '../src/brains/codex_turn_profile.js';

test('worker consumers distinguish corrected rejected reads from uncertain mutations and user stops',()=>{
  for(const p of [getOperatorAgentBaseInstructions(),getThinReferenceCodexProfile('read-correction').baseInstructions,getThinReferenceCodexProfile('read-correction',true).baseInstructions]){
    assert(p.includes(TASK_DISCRETION_GUIDANCE));
    assert.match(p,/correct a rejected read-only request/);
    assert.match(p,/Do not retry the unchanged invalid request/);
    assert.match(p,/unknown effects, uncertain mutations, required-input stops or explicit user stops/);
    assert.match(p,/not a reason to ask permission again/);
    assert.match(p,/actual collateral.*preservation obligations/);
  }
});
