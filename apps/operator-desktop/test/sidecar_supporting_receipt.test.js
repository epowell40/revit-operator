import test from 'node:test';
import assert from 'node:assert/strict';
import {once} from 'node:events';
process.env.OPERATOR_DESKTOP_NO_LISTEN='1';
const {app,journalSidecarComputerToolReceipt,beginSidecarComputerAssignment,maintainForegroundWriteGrant}=await import('../server.js');

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

test('desktop task intake and canonical source retain the exact brief up to the supported boundary', async () => {
  const clause = " Do not change the exterior walls or overwrite the current project.";
  let backendCalls = 0;
  const options = {
    conversationMessageId: "long-task",
    ensureComputerBackendSession: async () => "long-task-session",
    readBackendJson: async (route, options) => {
      backendCalls++;
      const body = JSON.parse(options.body);
      if (route === "/chat/intake") {
        assert.equal(body.user_text, original);
        return { routing_status: "accepted", route: "task" };
      }
      assert.equal(route, "/api/agent-goal");
      assert.equal(body.objective, original);
      assert.equal(body.work_budget.source_user_request, original);
      return { goal: { id: "long-assignment", work_budget: { requested_effect: "apply" } },
        assignment_run: { assignment_id: "long-assignment", run_id: body.assignment_run_id, generation: 1, kernel_version: 2 } };
    }
  };
  let original;
  for (const length of [4_999, 5_000, 5_001, 16_000]) {
    original = "Update the current schedule.".padEnd(length - clause.length, " Preserve all existing circuits.") + clause;
    const assignment = await beginSidecarComputerAssignment(original, [], options);
    assert.equal(assignment.objective, original);
  }
  const priorCalls = backendCalls;
  await assert.rejects(beginSidecarComputerAssignment("X" + original, [],
    { ...options, ensureComputerBackendSession: () => assert.fail("Excess brief must not start a session") }),
    /exceeds 16,000 characters/);
  assert.equal(backendCalls, priorCalls);
});
test('the computer-run HTTP endpoint rejects an oversized brief without replacing the current task', async t => {
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = "http://127.0.0.1:" + server.address().port;
  const before = await (await fetch(base + "/api/computer/state")).json();
  const response = await fetch(base + "/api/computer/run", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ prompt: "A".repeat(16_001), new_conversation: true, message_id: "excess-brief" })
  });
  assert.equal(response.status, 400);
  assert.match((await response.json()).error, /exceeds 16,000 characters/);
  const after = await (await fetch(base + "/api/computer/state")).json();
  assert.equal(after.running, false);
  assert.deepEqual(after.assignmentBindingV2, before.assignmentBindingV2);
  assert.deepEqual(after.messages, before.messages);
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
