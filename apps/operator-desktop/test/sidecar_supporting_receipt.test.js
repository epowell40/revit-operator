import test from 'node:test';
import assert from 'node:assert/strict';
process.env.OPERATOR_DESKTOP_NO_LISTEN='1';
const {journalSidecarComputerToolReceipt,beginSidecarComputerAssignment,maintainForegroundWriteGrant}=await import('../server.js');

test('shared runtime foreground lease maintenance uses a fresh profile and never revives Off',async()=>{
 const now=Date.parse('2026-10-12T10:00:00Z');let override='session',renewals=0;
 const hooks={isWorkActive:()=>true,now:()=>now,readStatus:()=>({active:true,mode:'session',uses_remaining:null,expires_at_utc:new Date(now+30000).toISOString()}),
  readOverrideMode:()=>override,renew:()=>renewals++,readRuntimeProfile:async()=>({general_agent:true})};
 assert.equal(await maintainForegroundWriteGrant(hooks),true);assert.equal(renewals,1);
 assert.equal(await maintainForegroundWriteGrant({...hooks,readRuntimeProfile:async()=>{override='off';return {general_agent:true};}}),false);
 assert.equal(renewals,1);
 await assert.rejects(maintainForegroundWriteGrant({...hooks,readRuntimeProfile:async()=>{throw new Error('profile unavailable');}}),/unavailable/);
 assert.equal(renewals,1);
});

test('shared graphical computer admission classifies the exact text before creating its canonical assignment',async()=>{
 const prompt='Pick up these redlines; let me know if you have questions.';
 const calls=[];
 const run=await beginSidecarComputerAssignment(prompt,[{filename:'marked.pdf'}],{conversationMessageId:'message',ensureComputerBackendSession:async()=> 'session',
  getLatestComputerUserBackendAttachments:async()=>[{id:'uploaded-marked-pdf'}],
  readBackendJson:async(route,options)=>{const body=JSON.parse(options.body);calls.push({route,body});
   if(route==='/chat/intake')return {routing_status:'accepted',route:'task'};
   return {goal:{id:'assignment',work_budget:{requested_effect:'apply'}},assignment_run:{assignment_id:'assignment',run_id:body.assignment_run_id,generation:1,kernel_version:2}};
  }});
 assert.deepEqual(calls.map(c=>c.route),['/chat/intake','/api/agent-goal']);
 assert.equal(calls[0].body.user_text,prompt);assert.equal(calls[0].body.intake_attachment_count,1);
 assert.equal(calls[1].body.objective,prompt);assert.equal(calls[1].body.work_budget.conversation_message_id,'message');
 assert.deepEqual(calls[1].body.work_budget.attachment_ids,['uploaded-marked-pdf']);
 assert.equal(run.work_budget.requested_effect,'apply');
 for(const response of [{routing_status:'unavailable',route:'task'},{routing_status:'accepted',route:'answer'},{}]){
  const rejected=[];
  await assert.rejects(beginSidecarComputerAssignment(prompt,[],{conversationMessageId:'other',ensureComputerBackendSession:async()=> 'session',
   readBackendJson:async(route)=>{rejected.push(route);return response;}}),/scope/);
  assert.deepEqual(rejected,['/chat/intake'],'failed interpretation never creates or replaces an assignment');
 }
});

test('shared computer loop sends V2 receipts to exact-bound evidence, retaining legacy progress route',async()=>{
 const receipt={tool_name:'delegate_revit_task',call_id:'call_test',status:'failed',request_effect:'apply',request_dispatched:true,step:3,result:{outcome_unknown:true,reconciliation_required:true}};
 for(const kernel_version of [1,2]){
  let captured;
  const result=await journalSidecarComputerToolReceipt(receipt,{assignment:{session_id:'session',goal_id:'assignment',run_id:'sidecar:run',generation:7,kernel_version},readBackendJson:async(route,options)=>{captured={route,body:JSON.parse(options.body)};return {ok:true};}});
  assert.equal(result.ok,true);
  assert.equal(captured.route,kernel_version===2?'/api/agent-goal/sidecar-receipt':'/api/agent-goal/progress');
  assert.equal(captured.body.assignment_id,kernel_version===2?'assignment':undefined);
  assert.equal(captured.body.assignment_run_id,'sidecar:run');
  assert.equal(captured.body.assignment_generation,7);
  assert.equal(captured.body.receipt.call_id,'call_test');
  assert.equal(captured.body.receipt.status,'failed');
  assert.equal(captured.body.receipt.request_effect,'apply');
 }
});
