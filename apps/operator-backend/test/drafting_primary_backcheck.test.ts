import assert from'node:assert/strict';import test from'node:test';
import{DESKTOP_EXECUTION_EFFICIENCY_GUIDANCE as guidance}from'../src/assignments/desktop_execution_guidance.js';
test('routine source/model comparison stays with primary actor and checked frontier uses existing area/pass records',()=>{
 assert.match(guidance,/Routine drafting backchecks stay with you/);
 assert.match(guidance,/review_mode:observe/);
 assert.match(guidance,/one item per discovered coherent branch or area/);
 assert.match(guidance,/exclude only checked passes/);
 assert.match(guidance,/relevant change or coverage sweep/);
 assert.match(guidance,/independent review for coherent milestones/);
 assert.match(guidance,/compaction alone does not require recapture/);
 assert.doesNotMatch(guidance,/Refresh precise images after recovery or compaction/);
});
