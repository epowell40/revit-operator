import test from 'node:test';
import assert from 'node:assert/strict';
import {reviewExecutedCode} from './native_code_review.mjs';
import {singleExecutionInstructions} from './desktop_native_tools.mjs';
import {VISUAL_WORK_REVIEW_TOOL} from './visual_work_review.mjs';

test('selected construction code review declares its boundary before the original multi-stage request',async()=>{
 const owner={assignment_id:'assignment',session_id:'session',run_id:'run',generation:1};let sent;
 const result=await reviewExecutedCode({review_mode:'code_execution',code_evidence_ids:['ev1_'+'A'.repeat(32)]},{
  owner:()=>owner,assertControl:async()=>{},userRequest:()=> 'Recreate the attached detail, compare it, keep it visible and save a separate result.',
  codeReviewPacket:async()=>({owner,executions:[{call_id:'create',evidence_id:'ev1_'+'A'.repeat(32),source:'public static class Draw {}',source_sha256:'sha256:'+'b'.repeat(64),content_hash:'sha256:'+'c'.repeat(64)}],coverage:{all_assignment_calls:false}}),
  settings:()=>({model:'test-model',reasoning_effort:'medium'}),requestResponse:async body=>{sent=body;return {id:'response',status:'completed',output:[],output_text:JSON.stringify({code_review:{status:'uncertain',observed:'Target identity is ambiguous in this selected call.',correction:'Read the actual target identity.'}})};}
 });
 const input=JSON.parse(sent.input[0].content[0].text);
 assert.equal(input.code_review_scope.kind,'selected_executed_code');
 assert.equal(input.code_review_scope.whole_task_completion,false);
 assert.deepEqual(input.code_review_scope.separate_checks,['visual_fidelity','current_display','saved_persistence','whole_task_completion']);
 assert.match(sent.instructions,/Missing later-stage evidence alone/);
 assert.match(sent.instructions,/ambiguous targeting/);
 assert.equal(result.state,'uncertain');assert.equal(result.native_postcondition_verified,false);assert.equal(result.whole_task_verified,false);
 assert.equal(result.code_review.correction,'Read the actual target identity.');
});

test('primary drafting actor preserves component correspondence and uses combined milestone review',()=>{
 const instructions=singleExecutionInstructions('base','native');
 assert.match(instructions,/component-to-element/);
 assert.match(instructions,/actual IDs\/UniqueIds/);
 assert.match(instructions,/construction coordinate frame/);
 assert.match(instructions,/not an independent readback/);
 assert.match(instructions,/one whole-detail omission sweep/);
 assert.match(VISUAL_WORK_REVIEW_TOOL.description,/For a drawing that also needs appearance review, combine/);
 assert.match(VISUAL_WORK_REVIEW_TOOL.description,/do not request a separate code review after every construction or correction batch/);
});
