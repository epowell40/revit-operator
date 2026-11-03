import assert from 'node:assert/strict';
import test from 'node:test';
import {submitWorkReportForReview, retainedWorkReportMessage} from './work_report.mjs';

const assignment={kernel_version:2,session_id:'session',goal_id:'assignment',run_id:'run',generation:3};
const proposal={claimed_completed:['Saved connected supply and exterior runs.'],
  remaining_work:['Return branches and air devices remain.'],uncertainties:['Source fidelity is not verified.'],
  written_findings:'Partial reconstruction saved. The requested systems are not complete.'};

test('advisory owner body reaches the existing proposal and visible unverified report',async()=>{
  const calls=[];let preconditions=0;
  const result=await submitWorkReportForReview(assignment,proposal,async(route,options)=>{
    const body=JSON.parse(options.body);calls.push(body);
    if(body.action==='status')return {ok:true,outcome:'active',verification_policy:'advisory'};
    assert.equal(preconditions,1);
    return {ok:true,outcome:'awaiting_user_review',verification_policy:'advisory',
      completion_proposal:{...body.completion_proposal,review_id:'retained',verified:false}};
  },{beforePropose:async()=>{preconditions++;},retainWrittenFindings:()=>assert.fail('strict-only callback')});
  assert.deepEqual(calls.map(c=>c.action),['status','propose_completion']);
  assert.deepEqual(calls[1].completion_proposal,{claimed_completed:proposal.claimed_completed,
    remaining_work:proposal.remaining_work,uncertainties:proposal.uncertainties,user_facing_text:proposal.written_findings});
  assert.equal(calls[1].assignment_id,assignment.goal_id);
  assert.equal(result.completion_proposal.verified,false);
  const message=retainedWorkReportMessage({name:'report_work_for_review'},{output:JSON.stringify(result)});
  assert.ok(message.includes(proposal.written_findings));assert.ok(message.includes(proposal.remaining_work[0]));
  assert.match(message,/not independently verified/);
});

test('body-only advisory report is retained without fabricated completion claims',async()=>{
  let sent;
  await submitWorkReportForReview(assignment,{...proposal,claimed_completed:[],remaining_work:[],uncertainties:[]},
    async(_route,options)=>{const body=JSON.parse(options.body);if(body.action==='status')return {ok:true,outcome:'active',verification_policy:'advisory'};sent=body;return {ok:true};});
  assert.deepEqual(sent.completion_proposal.claimed_completed,[]);
  assert.equal(sent.completion_proposal.user_facing_text,proposal.written_findings);
});

test('strict writing remains nonterminal and strict claims are rejected',async()=>{
  let retained=0;let calls=0;
  const request=async()=>{calls++;return {ok:true,outcome:'active',verification_policy:'strict'};};
  const options={retainWrittenFindings:async(binding,text)=>{retained++;assert.equal(binding.assignment_id,assignment.goal_id);assert.equal(text,proposal.written_findings);return {retained:true};}};
  await assert.rejects(submitWorkReportForReview(assignment,proposal,request,options),/owner_retention/);
  assert.deepEqual(await submitWorkReportForReview(assignment,{...proposal,claimed_completed:[],remaining_work:[],uncertainties:[]},request,options),{retained:true});
  assert.equal(calls,2);assert.equal(retained,1);
});

test('advisory writing cannot bypass status, an existing proposal, control or binding rejection',async()=>{
  for(const status of [{ok:false,outcome:'active',verification_policy:'advisory'},
    {ok:true,outcome:'active',verification_policy:'unknown'},
    ...['failed','blocked','awaiting_user_input','awaiting_user_review'].map(outcome=>({ok:true,outcome,verification_policy:'advisory'})),
    {ok:true,outcome:'active',verification_policy:'advisory',completion_proposal:{verified:false}}]){
    let calls=0;await assert.rejects(submitWorkReportForReview(assignment,proposal,async()=>{calls++;return status;}));assert.equal(calls,1);
  }
  for(const reason of ['unknown_effect','assignment_execution_paused','binding_mismatch','pending_provider_usage']){
    let calls=0;await assert.rejects(submitWorkReportForReview(assignment,proposal,async()=>{calls++;return {ok:true,outcome:'active',verification_policy:'advisory'};},
      {beforePropose:async()=>{throw Error(reason);}}),new RegExp(reason));assert.equal(calls,1);
  }
});

test('advisory body submission does not retry a lost response or backend refusal',async()=>{
  for(const reason of ['fetch failed','ready_work_remaining','unknown_effect','assignment_execution_paused']){
    let writes=0;
    await assert.rejects(submitWorkReportForReview(assignment,proposal,async(_route,options)=>{
      if(JSON.parse(options.body).action==='status')return {ok:true,outcome:'active',verification_policy:'advisory'};
      writes++;throw Error(reason);
    }),new RegExp(reason));assert.equal(writes,1);
  }
});
