import test from 'node:test';
import assert from 'node:assert/strict';
import {createCombinedReviewDispatcher} from './combined_review_dispatch.mjs';
const eid=n=>'ev1_'+String(n).repeat(32);
const call=(id,args)=>({type:'function_call',name:'review_current_work',call_id:id,arguments:JSON.stringify(args)});
const pair=()=>[call('visual',{review_mode:'independent',view_id:10,checks:[{id:'grilles',expected:'The grilles match the reference location.'}],
  reference_attachment_read:{call_id:'call_reference',page:1},code_evidence_ids:[eid(1),eid(2)]}),
  call('code',{review_mode:'code_execution',code_evidence_ids:[eid(3),eid(4)]})];
function harness(outputs=pair(),{status='matched',unavailable=false}={}){
 let binding={assignment_id:'a',run_id:'r',generation:1,session_id:'s'},paused=false;const executed=[];
 const dispatch=createCombinedReviewDispatcher(outputs,{owner:()=>binding,assertControl:async()=>{if(paused)throw Error('paused');},execute:async c=>{
  executed.push(c);const request=JSON.parse(c.arguments);
  const r={schema:'operator.visual_work_review.v1',ok:!unavailable,request,owner:binding,
   state:status,code_review:{status,observed:'Selected work and target context reviewed.',correction:status==='mismatch'?'Correct the selected target.':''},reviewer_response_id:'one-review',
   raw_review_evidence:{executed_code:{executions:request.code_evidence_ids?.map(evidence_id=>({evidence_id,call_id:evidence_id,source_sha256:'hash'})),coverage:{all_assignment_calls:false}},reviewer_response:{id:'one-review'}}};
  if(unavailable){r.reason='foreign_evidence';delete r.code_review;}
  const output={type:'function_call_output',call_id:c.call_id,output:JSON.stringify(r)};
  Object.defineProperties(output,{host_visual_work_review:{value:r},raw_evidence:{value:{...r}}});return output;
 }});
 return {dispatch,executed,outputs,pause:()=>paused=true,foreign:()=>binding={...binding,run_id:'foreign'}};
}
test('adjacent visual and code requests share all selected source/readbacks and retain both original call identities',async()=>{
 const h=harness(),before=structuredClone(h.outputs);
 const a=await h.dispatch(h.outputs[0]),b=await h.dispatch(h.outputs[1]);
 assert.equal(h.executed.length,1);assert.deepEqual(JSON.parse(h.executed[0].arguments).code_evidence_ids,[1,2,3,4].map(eid));
 assert.deepEqual(JSON.parse(h.executed[0].arguments).reference_attachment_read,{call_id:'call_reference',page:1});
 assert.equal(a.call_id,'visual');assert.equal(b.call_id,'code');assert.deepEqual(h.outputs,before);
 assert.equal(a.host_visual_work_review.request_composition.original_calls[1].arguments.review_mode,'code_execution');
 const code=b.host_code_work_review;assert.equal(code.reviewed_calls.length,4);assert.equal(code.reviewer_response_id,'one-review');
 assert.equal(code.native_postcondition_verified,false);assert.equal(code.whole_task_verified,false);
 assert.equal(b.host_visual_work_review,undefined);assert.match(code.guidance,/not this subset separately/);
 assert.equal(a.raw_evidence.request_composition,a.host_visual_work_review.request_composition);
});
for(const status of ['mismatch','uncertain'])test(`${status} is preserved without a paid retry`,async()=>{
 const h=harness(pair(),{status});await h.dispatch(h.outputs[0]);const r=await h.dispatch(h.outputs[1]);
 assert.equal(r.host_code_work_review.state,status);assert.equal(h.executed.length,1);
});
test('untrusted/unavailable combined evidence never gains a code verdict',async()=>{
 const h=harness(pair(),{unavailable:true});await h.dispatch(h.outputs[0]);const r=await h.dispatch(h.outputs[1]);
 assert.equal(r.host_code_work_review.state,'unavailable');assert.equal(r.host_code_work_review.code_review,undefined);
 assert.equal(h.executed.length,1);
});
for(const change of ['pause','foreign'])test(`${change} prevents shared-result delivery`,async()=>{
 const h=harness();await h.dispatch(h.outputs[0]);h[change]();await assert.rejects(h.dispatch(h.outputs[1]),/paused|owner_changed/);
});
test('separate responses, intervening actions, inspection closeout, duplicate IDs and oversized unions remain independent',async()=>{
 const variants=[p=>[p[0],{type:'function_call',name:'native__write',call_id:'write',arguments:'{}'},p[1]],
  p=>[call('visual',{...JSON.parse(p[0].arguments),complete_inspection_item_id:'inspect'}),p[1]],
  p=>[call('visual',{...JSON.parse(p[0].arguments),review_mode:'observe'}),p[1]],
  p=>[call('visual',{view_id:10,checks:[{id:'look',expected:'Observe the current drawing.'}]}),p[1]],
  p=>[p[0],{...p[1],call_id:p[0].call_id}],
  p=>[p[0],call('code',{review_mode:'code_execution',code_evidence_ids:[3,4,5,6,7,8,9].map(eid)})],
  p=>[p[0]]];
 for(const mutate of variants){const p=mutate(pair()),h=harness(p);for(const c of p)await h.dispatch(c);assert.equal(h.executed.length,p.length);assert.deepEqual(h.executed,p);}
});
