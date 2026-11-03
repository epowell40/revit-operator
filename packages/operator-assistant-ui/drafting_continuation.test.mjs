import test from 'node:test';
import assert from 'node:assert/strict';
import {missingWorkReportContinuation,retainedRetrievalStallContinuation} from './work_report.mjs';
const binding={kernel_version:2,session_id:'s',goal_id:'a',run_id:'r',generation:1};
const ready=()=>({ok:true,outcome:'active',verification_policy:'advisory',completion_proposal:null,
 execution_continuation:{schema:'operator.execution-continuation.v1',binding:{session_id:'s',assignment_id:'a',run_id:'r',generation:1},
 state:'ready',progress_key:'first',next_items:['west_branch'],reason:'ready_work_remaining'}});
test('retained tool failures warn then stop through the existing loop without inventing completion',()=>{
 const retained={status:'retained',execution_continuation:ready().execution_continuation,
 retrieval_feedback:{state:'observing',evidence_id:'ev1_'+'a'.repeat(32),failures:1}};
 assert.equal(retainedRetrievalStallContinuation(binding,retained),null);
 retained.retrieval_feedback={...retained.retrieval_feedback,state:'change_approach',failures:2};
 assert.match(retainedRetrievalStallContinuation(binding,retained).content[0].text,/Change approach now/);
 retained.retrieval_feedback={...retained.retrieval_feedback,state:'stalled',failures:4};
 assert.throws(()=>retainedRetrievalStallContinuation(binding,retained),/drafting_no_progress/);
 for(const reason of ['paused','pending_usage','unsettled_model_effect','input_or_review_pending','budget_exhausted','ordinary_task_reporting']){
  assert.equal(retainedRetrievalStallContinuation(binding,{...retained,execution_continuation:{...retained.execution_continuation,state:'hold',reason}}),null);
 }
 assert.throws(()=>retainedRetrievalStallContinuation(binding,{...retained,execution_continuation:{...retained.execution_continuation,binding:{...retained.execution_continuation.binding,run_id:'foreign'}}}),/binding_mismatch/);
 assert.throws(()=>retainedRetrievalStallContinuation(binding,{...retained,retrieval_feedback:{...retained.retrieval_feedback,failures:99}}),/feedback_invalid/);
});
test('a response ending with ready drafting work requests the next useful batch, not final reporting',async()=>{
 const r=await missingWorkReportContinuation(binding,async()=>ready(),0,{});
 assert.equal(r.kind,'continue_work');assert.match(r.input.content[0].text,/west_branch/);
 assert.match(r.input.content[0].text,/reference/);assert.doesNotMatch(r.input.content[0].text,/Finish by calling report_work_for_review/);
});
test('automatic drafting continuation retains progress and stops repeated no-progress endings',async()=>{
 const tracker={};
 for(let i=0;i<2;i++)assert.equal((await missingWorkReportContinuation(binding,async()=>ready(),0,tracker)).kind,'continue_work');
 await assert.rejects(missingWorkReportContinuation(binding,async()=>ready(),0,tracker),/drafting_no_progress/);
 const next=ready();next.execution_continuation.progress_key='second';
 assert.equal((await missingWorkReportContinuation(binding,async()=>next,0,tracker)).kind,'continue_work');
});
test('paused, unknown, failed or foreign status cannot become a drafting continuation',async()=>{
 for(const state of ['paused','unknown','pending_usage','blocked','budget_exhausted']){
  const s=ready();s.execution_continuation.state=state;
  assert.notEqual((await missingWorkReportContinuation(binding,async()=>s,0,{}))?.kind,'continue_work');
 }
 const s=ready();s.execution_continuation.binding.run_id='foreign';
 await assert.rejects(missingWorkReportContinuation(binding,async()=>s,0,{}),/continuation_binding/);
});
