import test from 'node:test';
import assert from 'node:assert/strict';
import * as reports from './work_report.mjs';

const assignment={kernel_version:2,session_id:'session',goal_id:'assignment',run_id:'run',generation:3};
const output={native_stop_reason:'advisory_completion_proposed',output:JSON.stringify({ok:true})};
const call={name:'native__operator_manage_work_plan'};
const status=()=>({ok:true,outcome:'awaiting_user_review',verification_policy:'advisory',completion_proposal:{
  claimed_completed:['Created twelve rectangular space boundaries. Saved the separate model.'],
  remaining_work:[],uncertainties:['Automated custom-transaction comparison unavailable.'],review_id:'review',verified:false}});

test('native stop presents the retained advisory report with one bound read, without another proposal or provider',async()=>{
  assert.equal(typeof reports.nativeStoppedWorkReportMessage,'function');
  const requests=[];const result=await reports.nativeStoppedWorkReportMessage(assignment,call,output,async(route,options)=>{
    requests.push({route,body:JSON.parse(options.body)});return status();
  });
  assert.deepEqual(requests,[{route:'/api/assignments/v2/work-plan',body:{action:'status',session_id:'session',assignment_id:'assignment',run_id:'run',generation:3}}]);
  assert.match(result,/not independently verified/);assert.match(result,/twelve rectangular/);assert.match(result,/comparison unavailable/);
});

test('retained native answer is visible in full, including numbers and trailing limitations, rather than only its claim summary',async()=>{
  const s=status();s.completion_proposal.user_facing_text='Read-only C# reported 1,063 rigid host ducts. L2 rectangular: 8, 20.33 ft. Longest: 30.78 ft, 8 in, 2000 CFM.\n\nLinked models excluded; model flows are not engineering validation.';
  const before=JSON.stringify(s);
  const message=await reports.nativeStoppedWorkReportMessage(assignment,call,output,async()=>s);
  assert(message.includes(s.completion_proposal.user_facing_text));
  assert(message.indexOf(s.completion_proposal.user_facing_text)<message.indexOf('## Details'));
  assert.match(message,/not independently verified/);assert.match(message,/comparison unavailable/);
  assert.equal(JSON.stringify(s),before);
  assert(reports.retainedWorkReportMessage({name:'report_work_for_review'},{output:JSON.stringify(s)}).includes(s.completion_proposal.user_facing_text));
});

test('optional native answer preserves legacy reports but rejects malformed or over-bound text',async()=>{
  for(const text of [null,{},9,'','   ','a'.repeat(8001)]){
    const s=status();s.completion_proposal.user_facing_text=text;
    assert.equal(await reports.nativeStoppedWorkReportMessage(assignment,call,output,async()=>s),null);
  }
  const s=status();s.completion_proposal.user_facing_text='a'.repeat(7990)+' LIMIT END';
  assert((await reports.nativeStoppedWorkReportMessage(assignment,call,output,async()=>s)).includes(s.completion_proposal.user_facing_text));
  delete s.completion_proposal.user_facing_text;
  assert((await reports.nativeStoppedWorkReportMessage(assignment,call,output,async()=>s)).includes('twelve rectangular'));
});

test('unrelated, failed and interrupted native calls do not read or present a proposal',async()=>{
  for(const [c,o] of [[{name:'native__revit_call_tool'},output],[call,{...output,native_stop_reason:'paused'}],
    [call,{...output,native_stop_reason:'unknown_effect'}],[call,{...output,native_stop_reason:null}],
    [call,{...output,output:'{}'}],[call,{...output,output:'malformed'}]]){
    assert.equal(await reports.nativeStoppedWorkReportMessage(assignment,c,o,()=>assert.fail('no read')),null);
  }
});

test('non-review, strict, malformed and verified proposals cannot be presented as advisory reports',async()=>{
  for(const mutate of [s=>s.ok=false,s=>s.outcome='active',s=>s.outcome='blocked',s=>s.outcome='failed',
    s=>s.verification_policy='strict',s=>s.completion_proposal=null,s=>s.completion_proposal.verified=true,
    s=>s.completion_proposal.review_id='',s=>s.completion_proposal.uncertainties=null]){
    const s=status();mutate(s);let calls=0;
    assert.equal(await reports.nativeStoppedWorkReportMessage(assignment,call,output,async()=>{calls++;return s;}),null);
    assert.equal(calls,1);
  }
});

test('stale/foreign binding, Pause/unknown rejection and lost read never trigger retry or proposal',async()=>{
  for(const reason of ['work_plan_binding_stale_or_terminal','assignment_kernel_v2_binding_mismatch','assignment_execution_paused','unknown_effect','lost transport']){
    let calls=0;assert.equal(await reports.nativeStoppedWorkReportMessage(assignment,call,output,async()=>{calls++;throw Error(reason);}),null);assert.equal(calls,1);
  }
  assert.equal(await reports.nativeStoppedWorkReportMessage({...assignment,generation:0},call,output,()=>assert.fail('no read')),null);
});
